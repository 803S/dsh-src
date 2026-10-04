// Feasibility only. Uses installed mitmproxy; independent loopback target logs.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {run} from './network-probe.mjs';
const ai=process.env.DSH_EVAL_AI_ROOT??'/Users/lihua-dis/.dsh/profiles/node_modules/@deepseek-ai';
const {Context}=await import(pathToFileURL(ai+'/cordis/lib/index.js'));
const {LocalSandboxProvider}=await import(pathToFileURL(ai+'/dsh-sandbox-local/lib/index.js'));
export function wrapEgressArgv(original,port,protectedPaths=[]) {
 const argv=[...original];
 const forms=` (deny network*) (allow network-outbound (remote ip "localhost:${port}"))`+protectedPaths.map(p=>` (deny file-read-data (subpath ${JSON.stringify(p)})) (deny file-write* (subpath ${JSON.stringify(p)}))`).join('');
 if(argv[0]?.endsWith('sandbox-exec')) {const at=argv.indexOf('-p');if(at<0)throw new Error('unknown sandbox profile');argv[at+1]+=forms;return argv;}
 return ['/usr/bin/sandbox-exec','-p','(version 1) (allow default)'+forms,...argv];
}
async function listen(s,host='127.0.0.1'){return new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,host,resolve)});}
async function freePort(){const s=net.createServer();await listen(s);const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export async function createTLSFixture(home, configureProxy) {
 const control=home+'/control';await mkdir(control,{recursive:true,mode:0o700});
 execFileSync('/opt/homebrew/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',control+'/server.key','-out',control+'/server.crt','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const targetLog=[],controlLog=[],unixLog=[];let closed=false;
 const target=https.createServer({key:await readFile(control+'/server.key'),cert:await readFile(control+'/server.crt')},async(req,res)=>{let body='';for await(const c of req)body+=c;targetLog.push({method:req.method,path:req.url,body});if(req.url==='/redirect'){res.writeHead(307,{location:'/delete'});res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({fixture:true,path:req.url,body}));});await listen(target);
 const admin=http.createServer((req,res)=>{controlLog.push(req.url);res.end('SYNTHETIC_ADMIN');});await listen(admin);
 const unix=http.createServer((req,res)=>{unixLog.push(req.url);res.end('SYNTHETIC_UNIX');});const socketDir=await mkdtemp(path.join(tmpdir(),'src-fixture-socket-'));const socket=socketDir+'/relay.sock';await new Promise((r,j)=>{unix.once('error',j);unix.listen(socket,r)});
 const port=await freePort(),origin=`https://127.0.0.1:${target.address().port}`,proxy=`http://127.0.0.1:${port}`,conf=control+'/mitm',publicCA=home+'/public-ca.pem';
 const keyMarker=control+'/approval-secret';await writeFile(keyMarker,'SYNTHETIC_ONLY_NOT_A_REAL_SECRET');
 const extension=configureProxy?await configureProxy({home,control,origin,port}):{};
 const addon=extension.addon??path.join(path.dirname(fileURLToPath(import.meta.url)),'mitm-fixture.py');
 const args=['--listen-host','127.0.0.1','--listen-port',String(port),'--set',`confdir=${conf}`,'--set','connection_strategy=lazy','--set','upstream_cert=false','--set',`ssl_verify_upstream_trusted_ca=${control}/server.crt`,'--set','http2=false',...(extension.options??[]),'-s',addon];
 await writeFile(home+'/mitm.jsonl','');
 const p=spawn('/opt/homebrew/bin/mitmdump',args,{env:{...process.env,SRC_FIXTURE_TLS_PORT:String(target.address().port),SRC_FIXTURE_MITM_LOG:home+'/mitm.jsonl',...extension.env},stdio:['ignore','pipe','pipe']});let log='';p.stdout.on('data',d=>log+=d);p.stderr.on('data',d=>log+=d);
 try{for(let i=0;i<80;i++){if(p.exitCode!==null)throw new Error('mitmdump exited: '+log.slice(-2000));try{const ca=await readFile(conf+'/mitmproxy-ca-cert.pem');await writeFile(publicCA,ca);await new Promise((r,j)=>{const s=net.connect(port,'127.0.0.1',()=>{s.end();r()});s.once('error',j)});break;}catch{await new Promise(r=>setTimeout(r,100));if(i===79)throw new Error('mitm startup timeout '+log.slice(-2000));}}}catch(e){p.kill();target.close();admin.close();unix.close();await extension.close?.();await rm(socketDir,{recursive:true,force:true});throw e;}
 const protectedPaths=[await realpath(control),control,...(extension.protectedPaths??[])];
 return {extension,home,origin,proxy,port,publicCA,controlOrigin:`http://127.0.0.1:${admin.address().port}`,socket,keyMarker,protectedPaths,targetLog,controlLog,unixLog,
 async save(){await writeFile(home+'/target.json',JSON.stringify(targetLog,null,2));await writeFile(home+'/admin.json',JSON.stringify(controlLog));await writeFile(home+'/unix.json',JSON.stringify(unixLog));await writeFile(home+'/mitm.log',log);},
 async close(){if(closed)return;closed=true;p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);if(p.exitCode===null)p.kill('SIGKILL');for(const s of [target,admin,unix])s.closeAllConnections();await Promise.all([target,admin,unix].map(s=>new Promise(r=>s.close(r))));await extension.close?.();await rm(socketDir,{recursive:true,force:true});}
 };
}
if(pathToFileURL(path.resolve(process.argv[1]??'')).href===import.meta.url){
 const home=await mkdtemp(path.join(tmpdir(),'dsh-egress-extended-'));await mkdir(home+'/work');const ctx=new Context(),sandbox=new LocalSandboxProvider(ctx,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000});const f=await createTLSFixture(home);const rows=[];
 async function probe(name,mode,command,{guard=true,protect=true}={}){const native=mode==='danger-full-access'?['bash','-c',command]:sandbox.confine(['bash','-c',command],{mode,workspaceRoot:home+'/work'}).argv;const before=f.targetLog.length,a=f.controlLog.length,u=f.unixLog.length;const argv=guard?wrapEgressArgv(native,f.port,protect?f.protectedPaths:[]):native;const result=await run(argv,home+'/work');rows.push({name,mode,...result,targetArrivals:f.targetLog.length-before,adminArrivals:f.controlLog.length-a,unixArrivals:f.unixLog.length-u});}
 const curl=`curl --max-time 5 -sS --noproxy '' -x '${f.proxy}' --cacert '${f.publicCA}'`;
 try{
 await probe('baseline-tls-direct','workspace-write',`curl --max-time 5 -sS --noproxy '*' --cacert '${home}/control/server.crt' '${f.origin}/baseline'`,{guard:false});
 await probe('baseline-admin','workspace-write',`curl --max-time 5 -sS --noproxy '*' '${f.controlOrigin}/baseline'`,{guard:false});
 await probe('baseline-unix','workspace-write',`curl --max-time 5 -sS --noproxy '*' --unix-socket '${f.socket}' http://localhost/baseline`,{guard:false});
 await probe('tls-proxy-get','workspace-write',`${curl} '${f.origin}/read'`);
 await probe('tls-proxy-body','workspace-write',`${curl} -X POST -H 'Content-Type: application/json' -d '{"x":1}' '${f.origin}/compute'`);
 await probe('tls-xml-blocked','workspace-write',`${curl} -X PUT -H 'Content-Type: application/xml' -d '<settings><enabled>true</enabled></settings>' '${f.origin}/settings'`);
 await probe('tls-redirect-recheck','workspace-write',`${curl} -L '${f.origin}/redirect'`);
 await probe('tls-untrusted-ca','workspace-write',`curl --max-time 5 -sS --noproxy '' -x '${f.proxy}' '${f.origin}/read'`);
 await probe('tls-direct-blocked','workspace-write',`curl --max-time 5 -sS -k --noproxy '*' '${f.origin}/direct'`);
 await probe('admin-blocked','workspace-write',`curl --max-time 5 -sS --noproxy '*' '${f.controlOrigin}/direct'`);
 await probe('unix-blocked','workspace-write',`curl --max-time 5 -sS --noproxy '*' --unix-socket '${f.socket}' http://localhost/direct`);
 await probe('network-only-secret-readable','workspace-write',`cat '${f.keyMarker}'`,{protect:false});
 await probe('protected-secret-blocked','workspace-write',`cat '${f.keyMarker}'`);
 await probe('full-access-native-direct','danger-full-access',`curl --max-time 5 -sS -k --noproxy '*' '${f.origin}/full-baseline'`,{guard:false});
 await probe('full-access-guard-direct','danger-full-access',`curl --max-time 5 -sS -k --noproxy '*' '${f.origin}/full-blocked'`);
 await probe('full-access-guard-proxy','danger-full-access',`${curl} '${f.origin}/read'`);
 await probe('full-access-local-outside-workspace','danger-full-access',`printf outside-ok > '${home}/outside.txt'; cat '${home}/outside.txt'; rm '${home}/outside.txt'`);
 await probe('read-only-local-denied','read-only',`printf should-not-write > '${home}/work/read-only.txt'`);
 await probe('read-only-network-proxy','read-only',`${curl} '${f.origin}/read'`);
 await f.save();await writeFile(home+'/result.json',JSON.stringify({home,rows,target:f.targetLog,admin:f.controlLog,unix:f.unixLog},null,2));console.log(JSON.stringify({home,rows:rows.map(r=>({...r,stderr:r.stderr.slice(-400)}))},null,2));
 }finally{await f.close();}
}
