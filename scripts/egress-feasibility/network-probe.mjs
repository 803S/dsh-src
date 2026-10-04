// Isolated feasibility experiment, NOT a production proxy or security policy.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const ai=process.env.DSH_EVAL_AI_ROOT??'/Users/lihua-dis/.dsh/profiles/node_modules/@deepseek-ai';
const {Context}=await import(pathToFileURL(path.join(ai,'cordis/lib/index.js')));
const {LocalSandboxProvider}=await import(pathToFileURL(path.join(ai,'dsh-sandbox-local/lib/index.js')));
export function networkConstrained(original,port) {
 const argv=[...original.argv], at=argv.indexOf('-p');
 if(at<0||!argv[at-1]?.endsWith('sandbox-exec'))throw new Error('Expected actual DSH Seatbelt argv; no fallback');
 argv[at+1]+=` (deny network*) (allow network-outbound (remote ip "localhost:${port}"))`;
 return {...original,argv};
}
export async function createFixture(home) {
 const targetLog=[], gatewayLog=[];
 const target=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;targetLog.push({method:req.method,path:req.url,body});res.setHeader('content-type','application/json');res.end(JSON.stringify({fixture:true,method:req.method,path:req.url}));});
 await listen(target);const origin=`http://127.0.0.1:${target.address().port}`;
 // Deliberately tiny fixed-target adapter: only GET /read is forwarded.
 // No real authorization, no Jev, no TLS interception. Used solely to measure network confinement.
 const gateway=createServer(async(req,res)=>{gatewayLog.push({method:req.method,url:req.url});let u;try{u=new URL(req.url,origin)}catch{res.writeHead(400);res.end();return;}
  if(u.origin!==origin||req.method!=='GET'||u.pathname!=='/read'){res.writeHead(403,{'x-fixture-gateway':'not-sent'});res.end('FIXTURE_BLOCKED_NOT_SENT');return;}
  try {const r=await fetch(origin+u.pathname,{redirect:'error'});res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());}catch{res.writeHead(502);res.end('not-forwarded');}
 });
 gateway.on('connect',(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
 await listen(gateway);const proxy=`http://127.0.0.1:${gateway.address().port}`;
 return {origin,proxy,port:gateway.address().port,targetLog,gatewayLog,async save(){await writeFile(path.join(home,'target.json'),JSON.stringify(targetLog,null,2));await writeFile(path.join(home,'gateway.json'),JSON.stringify(gatewayLog,null,2));},async close(){target.closeAllConnections();gateway.closeAllConnections();await Promise.all([new Promise(r=>target.close(r)),new Promise(r=>gateway.close(r))]);}};
}
function listen(server){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
export function run(argv,cwd,extra={}) {return new Promise(resolve=>{let stdout='',stderr='';const p=spawn(argv[0],argv.slice(1),{cwd,env:{...process.env,...extra},stdio:['ignore','pipe','pipe']});const t=setTimeout(()=>p.kill('SIGKILL'),15000);p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.once('error',e=>{clearTimeout(t);resolve({exit:null,error:e.message,stdout,stderr});});p.once('exit',(exit,signal)=>{clearTimeout(t);resolve({exit,signal,stdout,stderr});});});}
if(pathToFileURL(path.resolve(process.argv[1]??'')).href===import.meta.url){
 const home=await mkdtemp(path.join(tmpdir(),'dsh-egress-probe-'));await mkdir(home+'/work');
 const ctx=new Context();const sandbox=new LocalSandboxProvider(ctx,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000});
 const f=await createFixture(home);const policy={mode:'workspace-write',workspaceRoot:home+'/work'};const rows=[];
 const cases=[
 ['baseline-direct',false,`curl --noproxy '*' --max-time 3 -sS '${f.origin}/baseline'`],
 ['direct-blocked',true,`curl --noproxy '*' --max-time 3 -sS '${f.origin}/direct'`],
 ['proxy-read',true,`curl --noproxy '' -x '${f.proxy}' --max-time 3 -sS '${f.origin}/read'`],
 ['proxy-write-blocked',true,`curl --noproxy '' -x '${f.proxy}' -X DELETE --max-time 3 -sS '${f.origin}/delete'`],
 ['child-direct',true,`bash -c "curl --noproxy '*' --max-time 3 -sS '${f.origin}/child'"`],
 ['python-direct',true,`/usr/bin/python3 -c 'import urllib.request; urllib.request.urlopen("${f.origin}/python",timeout=3)'`],
 ['background-direct',true,`curl --noproxy '*' --max-time 3 -sS '${f.origin}/background' & wait`],
 ['local-files',true,`printf local-ok > probe.txt; cat probe.txt; printf replaced > probe.txt; rm probe.txt; test ! -e probe.txt`],
 ];
 try{for(const [name,constrain,command] of cases){const base=sandbox.confine(['bash','-c',command],policy);const argv=(constrain?networkConstrained(base,f.port):base).argv;const before=f.targetLog.length;const result=await run(argv,home+'/work');rows.push({name,...result,targetArrivals:f.targetLog.length-before});}
 await writeFile(home+'/result.json',JSON.stringify({home,origin:f.origin,proxy:f.proxy,rows},null,2));await f.save();console.log(JSON.stringify({home,rows},null,2));}finally{await f.close();await ctx.dispose?.();}
}
