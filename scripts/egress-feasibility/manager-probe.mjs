// Isolated loopback-only test of the actual manager/owned proxy/final-spawn rules.
// Does not replace the separate real DSH provider integration test.
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createEgressManager} from '../../lib/src/egress/manager.js';
import {dispatchHttp} from '../../lib/src/egress/http-dispatch.js';
import {constrainSpawnSpec} from '../../lib/src/egress/executor.js';
const root=await mkdtemp(path.join(tmpdir(),'src-manager-probe-'));
const tls=process.argv.includes('--https');
let tlsOptions,proxyExecutable;
if(tls){
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',root+'/target.key','-out',root+'/target.pem','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 tlsOptions={key:await readFile(root+'/target.key'),cert:await readFile(root+'/target.pem')};
 proxyExecutable=root+'/fixture-mitmdump';
 await writeFile(proxyExecutable,`#!/bin/sh\nexec /opt/homebrew/bin/mitmdump --set ssl_verify_upstream_trusted_ca=${root}/target.pem "$@"\n`);await chmod(proxyExecutable,0o700);
}
const arrivals=[],evidence=[],rows=new Map();let assessments=0;
const handler=async(req,res)=>{let body='';for await(const c of req)body+=c;arrivals.push({method:req.method,url:req.url,body});if(req.url==='/jump'){res.writeHead(302,{location:'/unapproved'});res.end();}else res.end('synthetic');};
const server=tls?httpsServer(tlsOptions,handler):httpServer(handler);
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`${tls?'https':'http'}://127.0.0.1:${server.address().port}`;
const manager=await createEgressManager({home:root,allowLoopbackFixtures:true,proxyExecutable,directFetch:dispatchHttp,
 assess:async()=>{assessments++;return {fallback:false,mode:'on',risk:'low',effect:'read',action:'allow',confidence:.99};},
 recordEvidence:async(session,row)=>{evidence.push({session,url:row.request.url,status:row.response.status});},
 storeFor:async()=>({async addPendingApproval(session,row){const id=`approval-${rows.size+1}`;rows.set(id,{...row,id,session});return {id};},async updateApprovalExecution(session,id,patch){Object.assign(rows.get(id),patch);},async getPendingApproval(session,id){return rows.get(id);}})});
const results=[];
try{
 await manager.user.setScope('probe',[origin]);
 const task=await manager.proposeShellTask('probe',{entries:['/read','/jump'].map(route=>({request:{url:origin+route,method:'GET',headers:[],bodyBase64:''},maxRequests:1})),maxRequests:2,minIntervalMs:250,lifetimeMs:60000,purpose:'one exact synthetic loopback read'},{});
 assert.equal(task.state,'active');
 const started=performance.now();
 const proxy=await manager.sessionProxy('probe');
 const metrics={startupMs:Math.round(performance.now()-started),rssKiB:Number(execFileSync('/bin/ps',['-o','rss=','-p',String(proxy.pid)],{encoding:'utf8'}).trim())};
 const run=async(command)=>{
  const spec=constrainSpawnSpec({argv:['/bin/sh','-c',command]},{proxyPort:proxy.port,protectedPaths:proxy.protectedPaths,readOnlyPaths:proxy.readOnlyPaths});
  const child=spawn(spec.argv[0],spec.argv.slice(1),{cwd:root,env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const status=await new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve(code??signal));child.once('error',reject);});clearTimeout(timer);results.push({command,status,output});return {status,output};
 };
 const curl=`/usr/bin/curl --max-time 3 -sS -D - --noproxy '' -x '${proxy.url}' --cacert '${proxy.publicCA}' -H 'User-Agent:' -H 'Accept:'`;
 assert.match((await run(`${curl} '${origin}/read'`)).output,/synthetic/);
 assert.match((await run(`${curl} '${origin}/read'`)).output,/BLOCKED_NOT_SENT/);
 assert.match((await run(`${curl} -X DELETE '${origin}/read'`)).output,/BLOCKED_NOT_SENT/);
 assert.match((await run(`${curl} -L '${origin}/jump'`)).output,/BLOCKED_NOT_SENT/);
 assert.notEqual((await run(`/usr/bin/curl --max-time 3 -sS -D - --noproxy '*' '${origin}/direct'`)).status,0);
 assert.notEqual((await run(`/usr/bin/python3 -c 'import socket;s=socket.socket();s.connect(("127.0.0.1",${server.address().port}))'`)).status,0);
 assert.notEqual((await run(`/usr/bin/osascript -e 'tell application "System Events" to count processes'`)).status,0);
 assert.notEqual((await run(`cat '${root}/control/src-egress/binding-key'`)).status,0);
 assert.equal((await run('printf first > local.txt; printf second > local.txt; rm local.txt; test ! -e local.txt')).status,0);
 await proxy.close();
 assert.notEqual((await run(`${curl} '${origin}/read'`)).status,0);
 assert.deepEqual(arrivals,[{method:'GET',url:'/read',body:''},{method:'GET',url:'/jump',body:''}]);assert.equal(assessments,1);assert.equal(evidence.length,2);
 console.log(JSON.stringify({passed:true,tls,metrics,assessments,arrivals,evidence,results},null,2));
}catch(error){console.error(JSON.stringify({results,arrivals,evidence}));throw error;}finally{await manager.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
