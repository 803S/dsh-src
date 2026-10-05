import {RELAY_IDLE_TIMEOUT_MS} from './timing.js';
// Owned per-session proxy, never a user/global mitmproxy configuration.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gateError } from './plan.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function startProxyWorker({ directory, publicCA, controlSocket, token, executable = '/opt/homebrew/bin/mitmdump', startupMs = 10000 }) {
  if (!path.isAbsolute(executable) || !path.isAbsolute(directory)) throw gateError('INVALID_PROXY_CONFIG');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const port = await reservePort();
  const addon = fileURLToPath(new URL('./mitm-addon.py', import.meta.url));
  const args = ['--listen-host','127.0.0.1','--listen-port',String(port),'--set',`confdir=${directory}`,
    '--set','connection_strategy=lazy','--set','upstream_cert=false','--set','http2=false',
    '--set','rawtcp=false','--set','body_size_limit=8m','--set','ssl_insecure=false','-s',addon];
  // Do not inherit model-supplied proxy, Python paths or logging/config flags.
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: directory, LANG: 'en_US.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1', SRC_GATE_CONTROL_SOCKET: controlSocket, SRC_GATE_CONTROL_TOKEN: token };
  const process = spawn(executable, args, { env, stdio: ['ignore','pipe','pipe'] });
  let failure, output = '', stopped = false;
  process.once('error', error => { failure = error; });
  for (const stream of [process.stdout, process.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4096); });
  const exited = new Promise(resolve => process.once('close', resolve));
  async function close() {
    if (stopped) return; stopped = true;
    if (!process.pid) return;
    if (process.exitCode === null && process.signalCode === null) {
      process.kill('SIGTERM');
      await Promise.race([exited, delay(2000)]);
      if (process.exitCode === null && process.signalCode === null) { process.kill('SIGKILL'); await exited; }
    }
  }
  const alive = () => !stopped && !failure && process.exitCode === null && process.signalCode === null;
  try {
    const deadline = Date.now() + startupMs;
    for (;;) {
      if (!alive()) throw gateError('PROXY_START_FAILED');
      try {
        const certificate = await readFile(path.join(directory,'mitmproxy-ca-cert.pem'));
        await new Promise((resolve, reject) => {
          const socket = net.connect({ host:'127.0.0.1', port });
          socket.setTimeout(250, () => socket.destroy(new Error('timeout')));
          socket.once('error', reject); socket.once('connect', () => { socket.destroy(); resolve(); });
        });
        await mkdir(path.dirname(publicCA), { recursive:true, mode:0o755 });
        let published;
        try{published=await readFile(publicCA);}catch(error){if(error.code!=='ENOENT')throw error;}
        if(published){if(!published.equals(certificate))throw gateError('PROXY_CA_CHANGED');}
        else await writeFile(publicCA, certificate, { mode:0o444,flag:'wx' });
        break;
      } catch {
        if (Date.now() >= deadline) throw gateError('PROXY_START_TIMEOUT');
        await delay(50);
      }
    }
    return { pid:process.pid, port, url:`http://127.0.0.1:${port}`, publicCA, alive, close, directory:await realpath(directory),
      // Diagnostic text stays on trusted host; never return possibly sensitive logs to tools.
      diagnostics: () => output };
  } catch (error) { await close(); throw error; }
}

// A cheap host-owned listener keeps the kernel-approved port reserved across
// worker idle shutdown/crash. Stale child processes can never reach a different
// engagement merely because the OS recycled a former mitmproxy port.
export async function startSessionProxy(options) {
  const idleMs=options.idleMs??120000;
  if(!Number.isSafeInteger(idleMs)||idleMs<50)throw gateError('INVALID_PROXY_CONFIG');
  let worker,starting,closing=false,retired=false,parked=false,lastUsed=Date.now();
  const clients=new Set();
  const front=net.createServer(client=>{
    if(closing||retired||parked||!worker?.alive()||clients.size>=64){client.destroy();return;}
    const backend=net.connect({host:'127.0.0.1',port:worker.port});
    clients.add(client);lastUsed=Date.now();
    const touch=()=>{lastUsed=Date.now();};
    client.on('data',touch);backend.on('data',touch);
    client.setTimeout(RELAY_IDLE_TIMEOUT_MS,()=>client.destroy());
    backend.setTimeout(RELAY_IDLE_TIMEOUT_MS,()=>backend.destroy());
    const finish=()=>{
      client.destroy();backend.destroy();clients.delete(client);lastUsed=Date.now();
      // Completed fixed-plan workers can retire after their last response is
      // delivered, including when the last sender was a background descendant.
      if(!closing&&!clients.size&&options.canRetire?.())park().catch(()=>{});
    };
    client.on('error',finish);backend.on('error',finish);
    client.once('close',finish);backend.once('close',finish);
    client.pipe(backend).pipe(client);
  });
  await new Promise((resolve,reject)=>{front.once('error',reject);front.listen(0,'127.0.0.1',resolve);});
  const port=front.address().port;
  async function activate(){
    if(closing||retired)throw gateError('PROXY_UNAVAILABLE');
    if(worker?.alive()){lastUsed=Date.now();return;}
    // Unexpected worker death is terminal, unlike a deliberate idle stop.
    if(worker&&!parked)throw gateError('PROXY_UNAVAILABLE');
    if(starting)return starting;
    starting=(async()=>{worker=await startProxyWorker(options);parked=false;lastUsed=Date.now();})().finally(()=>{starting=undefined;});
    return starting;
  }
  let parking;
  async function park(){
    if(closing||parked||starting||clients.size||!worker?.alive()||options.canPark?.()===false)return;
    parked=true;
    parking=worker.close();
    await parking;parking=undefined;
    options.onPark?.();
  }
  const timer=setInterval(()=>{if(!closing&&!parked&&!starting&&worker&&!worker.alive())options.onPark?.();else if(!closing&&Date.now()-lastUsed>=idleMs)park().catch(()=>{});},Math.min(idleMs,10000));
  timer.unref();
  async function retire(){
    // Keep the sandbox-approved front port bound until the manager ends. Old
    // descendants must never reach a fresh session through OS port reuse.
    retired=true;clearInterval(timer);
    for(const client of clients)client.destroy();
    await Promise.allSettled([starting,parking]);
    await worker?.close();
  }
  async function close(){
    if(closing)return;closing=true;clearInterval(timer);
    for(const client of clients)client.destroy();
    await Promise.allSettled([starting,parking]);
    await worker?.close();
    await new Promise(resolve=>front.close(resolve));
  }
  try {await activate();}
  catch(error){await close();throw error;}
  return {port,url:`http://127.0.0.1:${port}`,publicCA:options.publicCA,
    get pid(){return worker?.pid;},directory:worker.directory,
    alive:()=>!closing&&!retired&&!parked&&worker?.alive(),
    activate:async()=>{await parking;return activate();},waitForParking:async()=>{await parking;},parkIfIdle:park,retire,close,
    diagnostics:()=>worker?.diagnostics()??'',
  };
}
