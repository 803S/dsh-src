// Actual owned-worker idle/crash lifecycle. No external target or global config.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import net from 'node:net';
import {startSessionProxy} from '../../lib/src/egress/proxy-process.js';
const root=await mkdtemp('/private/tmp/src-proxy-life-');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<80;i++){if(check())return;await sleep(50);}throw new Error('Lifecycle deadline');}
let proxy,parks=0;
try{
 proxy=await startSessionProxy({directory:root+'/mitm',publicCA:root+'/ca.pem',controlSocket:root+'/unused.sock',token:'a'.repeat(64),idleMs:200,onPark:()=>parks++});
 const pid=proxy.pid,port=proxy.port;
 await until(()=>!proxy.alive());await proxy.waitForParking();
 assert.ok(parks>=1);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 const competing=net.createServer();
 await assert.rejects(new Promise((resolve,reject)=>{competing.once('error',reject);competing.listen(port,'127.0.0.1',resolve);}),{code:'EADDRINUSE'});
 const closed=await new Promise((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port});s.setTimeout(1000,()=>{s.destroy();reject(new Error('Parked port must reject'));});s.on('data',()=>reject(new Error('Parked port forwarded data')));s.on('error',()=>{});s.on('close',()=>resolve(true));});
 assert.equal(closed,true);
 await proxy.activate();assert.equal(proxy.port,port);assert.notEqual(proxy.pid,pid);assert.equal(proxy.alive(),true);
 const resumedPid=proxy.pid;
 process.kill(resumedPid,'SIGKILL');await until(()=>!proxy.alive());
 await assert.rejects(proxy.activate(),{code:'SRC_GATE_PROXY_UNAVAILABLE'});
 await proxy.close();
 await assert.rejects(startSessionProxy({directory:root+'/bad',publicCA:root+'/bad.pem',controlSocket:root+'/unused.sock',token:'b'.repeat(64),executable:root+'/missing'}),{code:'SRC_GATE_PROXY_START_FAILED'});
 console.log(JSON.stringify({passed:true,idleWorkerReaped:true,portReservedWhileIdle:true,restartSameSessionSamePort:true,unexpectedCrashTerminal:true,missingExecutableFailsClosed:true,parks}));
}finally{await proxy?.close();await rm(root,{recursive:true,force:true});}
