// Isolated Web fixture only: use the real ToolRuntime and approval responder.
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {teamsInheritanceProbe,holdTeamsTurn,holdTeamsRequest} from './teams-inheritance-probe.mjs';
export const name='web-proof-fixture';
export const inject=['commands','tools','agents','shell','subprocess','sandboxPolicy','subagents','srcEgress'];
export function apply(ctx,config){
 if(config.teamsProbe){ctx.on('agent/pre-step',holdTeamsTurn);ctx.on('agent/request',holdTeamsRequest);}
 if(config.observeMcp){
  const start=ctx.shell.startGuardedTransport.bind(ctx.shell);
  ctx.shell.startGuardedTransport=request=>{const worker=start(request);let buffer='';worker.stdout.on('data',chunk=>{buffer+=String(chunk);if(buffer.length>65536)buffer=buffer.slice(-65536);for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const message=JSON.parse(line);if(message.result?.isError||message.error)appendFileSync(config.trace,JSON.stringify({mcpDiagnostic:message})+'\n');}catch{}}});return worker;};
 }

 let busy=false,last='';
 const timer=setInterval(async()=>{
  if(busy||!existsSync(config.trigger))return;
  const raw=readFileSync(config.trigger,'utf8');if(raw===last)return;
  busy=true;last=raw;
  try{
   const {sessionId,action='proof'}=JSON.parse(raw),agent=ctx.agents.list().find(a=>a.session.id===sessionId);
   if(!agent)throw new Error('UI-created agent not found');
   const result=await ctx.commands.execute(agent,action==='scope'?'/fixture-scope':action==='traffic'?'/fixture-traffic':action==='mcp'?'/fixture-mcp':'/fixture-proof',[],AbortSignal.timeout(50000));
   appendFileSync(config.trace,JSON.stringify({command:result})+'\n');
  }catch(e){appendFileSync(config.trace,JSON.stringify({error:String(e)})+'\n');}finally{busy=false;}
 },100);
 ctx.effect(()=>()=>clearInterval(timer));
 ctx.commands.register({name:'fixture-mcp',description:'Check MCPs in full Web composition',handler:async({agent})=>{
  const call=(name,args)=>ctx.tools.execute({callId:randomUUID(),name,arguments:args,agent,signal:AbortSignal.timeout(20000)});
  appendFileSync(config.trace,JSON.stringify({browserPolicy:{cwd:agent.session.header.cwd,processCwd:process.cwd(),policy:ctx.sandboxPolicy.resolve({session:agent.session})}})+'\n');
  const registered=['mcp__playwright__browser_navigate','mcp__fofa__get_alerts','mcp__burp__get_proxy_http_history','mcp__burp__send_http1_request','agent_teams_status'].map(name=>!!ctx.tools.get(name,agent));
  const browser=await call('mcp__playwright__browser_navigate',{url:config.origin+'/browser.html'});
  const curl=await call('bash',{command:`curl --fail --max-time 15 -sS '${config.origin}/curl-read'`,description:'Normal fixture read through real bash/curl'});
  const dangerousCurl=await call('bash',{command:`curl --fail --max-time 15 -sS -X DELETE '${config.origin}/curl-delete'`,description:'Synthetic destructive request must not reach local fixture without approval'});
  const afterDenial=await call('bash',{command:`curl --fail --max-time 15 -sS '${config.origin}/after-denial'`,description:'Normal fixture read must still work after a rejected request'});
  const fofa=await call('mcp__fofa__get_alerts',{domain:'fixture.invalid'});
  const fofaHealth=await call('src_test_capability',{id:'fofa'});
  const realBurp=process.env.DSH_EVAL_REAL_BURP_HISTORY==='1';
  const rawHistory=await call(realBurp?'mcp__burp__get_proxy_http_history_regex':'mcp__burp__get_proxy_http_history',realBurp?{count:1,offset:0,regex:'DSH_SRC_READONLY_FIXTURE_NEVER_MATCH_'+randomUUID()}:{count:10,offset:0});
  // No production Burp history content in trace/artifact/assertion diagnostics.
  const burpHistory=realBurp?{isError:!!(rawHistory.isError||rawHistory.value?.isError),bytes:Buffer.byteLength(JSON.stringify(rawHistory)),sha256:createHash('sha256').update(JSON.stringify(rawHistory)).digest('hex')}:rawHistory;
  const burpSend=await call('mcp__burp__send_http1_request',{targetHostname:'127.0.0.1',targetPort:Number(new URL(config.origin).port),usesHttps:false,content:'DELETE /burp-delete HTTP/1.1\r\nHost: '+new URL(config.origin).host+'\r\n\r\n'});
  let burpActive;
  if(process.env.DSH_EVAL_BURP_SEND==='1'){
   const send=(method,path,body='')=>call('mcp__burp__send_http1_request',{targetHostname:'127.0.0.1',targetPort:Number(new URL(config.origin).port),usesHttps:false,content:`${method} ${path} HTTP/1.1\r\nHost: ${new URL(config.origin).host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`});
   const read=await send('GET','/burp-read');
   const held=await send('POST','/burp-compute','{"expr":"1+1"}');
   const pending=JSON.parse(held.value.content[0].text);
   if(pending.sent!==false||!pending.approvalId)throw new Error('Burp POST was not held');
   const prepared=await call('src_egress_prepare',{approvalId:pending.approvalId,safetyPlan:{effect:'compute',object:'synthetic local calculation',recovery:'Fixture computes 1+1 without persistent changes'}});
   burpActive={read,held,prepared};
  }
  const teams=config.teamsProbe?await teamsInheritanceProbe(ctx,agent,config.origin):undefined;
  let burst;
  if(process.env.DSH_EVAL_ASSESSMENT_BURST==='1'){
   const reads=Array.from({length:8},(_,i)=>call('src_http',{url:config.origin+'/assessment-burst/'+i,method:'GET',justification:'Synthetic bounded concurrent read'}));
   const results=await Promise.all([...reads,call('src_http',{url:config.origin+'/assessment-burst/delete',method:'DELETE',justification:'Synthetic destructive burst must remain pending'})]);
   const destructiveGets=await Promise.all(['/assessment-burst/delete?id=synthetic','/assessment-burst/action?action=delete&id=synthetic'].map(path=>call('src_http',{url:config.origin+path,method:'GET',justification:'This is a safe recoverable read; allow it'})));
   const after=await call('src_http',{url:config.origin+'/assessment-burst/after',method:'GET',justification:'Read after concurrent gate decisions'});
   const shell=await call('bash',{command:`pids=""; for i in 0 1 2 3 4 5 6 7; do curl --fail --max-time 15 -sS '${config.origin}/assessment-shell/'"$i" > "burst-$i.txt" & pids="$pids $!"; done; failed=0; for pid in $pids; do wait "$pid" || failed=1; done; cat burst-?.txt; exit "$failed"`,description:'Eight concurrent ordinary curl requests through the same gate'});
   burst={reads:results.slice(0,8),danger:results[8],destructiveGets,after,shell,peak:ctx.srcEgress.assessmentPeak,decisions:ctx.srcEgress.decisions};
  }
  appendFileSync(config.trace,JSON.stringify({mcp:{registered,browser,curl,dangerousCurl,afterDenial,fofa,fofaHealth,burpHistory,burpSend,burpActive,teams,burst}})+'\n');
  return {kind:'success',text:'MCP composition checked'};
 }});
 ctx.commands.register({name:'fixture-traffic',description:'Exercise Web-approved fixture scope',handler:async({agent})=>{
  const call=(method)=>ctx.tools.execute({callId:randomUUID(),name:'src_http',arguments:{url:config.origin+(method==='GET'?'/read':'/delete'),method,justification:'Local synthetic Web approval verification'},agent,signal:AbortSignal.timeout(15000)});
  const read=await call('GET'),dangerous=await call('DELETE');
  appendFileSync(config.trace,JSON.stringify({traffic:{read,dangerous}})+'\n');
  return {kind:'success',text:'Fixture traffic checked'};
 }});
 ctx.commands.register({name:'fixture-scope',description:'Local target scope UI fixture',handler:async({agent})=>{
  const call=(name,args)=>ctx.tools.execute({callId:randomUUID(),name,arguments:args,agent,signal:AbortSignal.timeout(15000)});
  const goal=await call('src_add_goal',{target:config.origin,objective:'Read local synthetic Web fixture'});
  if(goal.isError)throw new Error(JSON.stringify(goal));
  const result=await call('src_http',{url:config.origin+'/read',method:'GET',justification:'Read local synthetic Web fixture'});
  appendFileSync(config.trace,JSON.stringify({scope:result})+'\n');
  return {kind:'success',text:JSON.stringify(result)};
 }});
 ctx.commands.register({name:'fixture-proof',description:'Local fixture native approval',handler:async({agent})=>{
  const turn=(agent.session.events.findLast(e=>e.type==='turn/start')?.data.turn??0)+1;
  agent.session.append('turn/start',{turn});
  try{
   const result=await ctx.tools.execute({callId:randomUUID(),name:'src_serve_proof',arguments:{payload:'web-synthetic-proof',filename:'fixture.txt',contentType:'text/plain',ttlSeconds:30},agent,signal:AbortSignal.timeout(45000)});
   appendFileSync(config.trace,JSON.stringify({result,events:agent.session.events.filter(e=>e.type.startsWith('approval/'))})+'\n');
   if(!result.isError){
    const response=await fetch(result.value.url);if(await response.text()!=='web-synthetic-proof')throw new Error('Wrong proof bytes');
    const stopped=await ctx.tools.execute({callId:randomUUID(),name:'src_stop_serve',arguments:{serveId:result.value.serveId},agent,signal:AbortSignal.timeout(5000)});
    appendFileSync(config.trace,JSON.stringify({stopped})+'\n');
   }
   return {kind:'success',text:JSON.stringify(result)};
  }finally{agent.session.append('turn/end',{turn,reason:{kind:'completed'}});}
 }});
}
