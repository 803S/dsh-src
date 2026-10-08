import test from 'node:test';
import assert from 'node:assert/strict';
import {isBurpPassiveTool,passiveBurpArguments} from '../lib/src/egress/burp-passive.js';
test('Burp passive tools use an exact catalog and bounded history parameters',()=>{
 const history='mcp__burp__get_proxy_http_history';
 assert.deepEqual(passiveBurpArguments(history,{}),{count:10,offset:0});
 assert.deepEqual(passiveBurpArguments(history+'_regex',{count:2,offset:3,regex:'fixture.invalid'}),{count:2,offset:3,regex:'fixture.invalid'});
 for(const name of ['mcp__burp__send_http1_request','mcp__burp__send_http2_request','mcp__burp__create_repeater_tab','mcp__burp__get_proxy_http_history_and_send']){
  assert.equal(isBurpPassiveTool(name),false);assert.throws(()=>passiveBurpArguments(name,{}),{code:'SRC_GATE_UNADAPTED_TOOL'});
 }
 for(const args of [{count:0},{count:101},{offset:-1},{offset:1.5},{offset:1000001}])assert.throws(()=>passiveBurpArguments(history,args),{code:'SRC_GATE_INVALID_BURP_HISTORY_PAGE'});
 assert.throws(()=>passiveBurpArguments(history,{url:'https://target.invalid/delete'}),{code:'SRC_GATE_INVALID_BURP_HISTORY_ARGUMENTS'});
 for(const regex of ['', '\0', 'x'.repeat(513)])assert.throws(()=>passiveBurpArguments(history+'_regex',{regex}),{code:'SRC_GATE_INVALID_BURP_HISTORY_REGEX'});
 assert.deepEqual(passiveBurpArguments('mcp__burp__burp_status',{}),{});
});

import {inspectBurpRequest,createBurpSender,createBurpRestorer} from '../lib/src/egress/burp-request.js';
import {createEgressManager} from '../lib/src/egress/manager.js';
import {withEgressExecution} from '../lib/src/egress/runtime.js';
import {browserLifecycle} from '../lib/src/egress/browser-lifecycle.js';
import {saveResponseSnapshot} from '../lib/src/write-safety.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const h1='mcp__burp__send_http1_request',h2='mcp__burp__send_http2_request';
const origin='http://127.0.0.1:49123';
const low={mode:'on',fallback:false,risk:'low',effect:'read',action:'allow',confidence:.95};
const sha=text=>createHash('sha256').update(text).digest('hex');
function args(method='GET',url='/read',body=''){
 return {targetHostname:'127.0.0.1',targetPort:49123,usesHttps:false,content:`${method} ${url} HTTP/1.1\r\nHost: 127.0.0.1:49123\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`};
}
function args2(){return {targetHostname:'127.0.0.1',targetPort:49123,usesHttps:false,pseudoHeaders:{':method':'GET',':scheme':'http',':authority':'127.0.0.1:49123',':path':'/read'},headers:{accept:'*/*'},requestBody:''};}
test('Burp HTTP1/HTTP2 inputs are inspected without rewriting the frozen native invocation',()=>{
 const raw=args('POST','/query?a=1&a=2','{"text":"中文"}'),copy=structuredClone(raw),value=inspectBurpRequest(h1,raw);
 assert.deepEqual(value.args,copy);assert.equal(Buffer.from(value.request.bodyBase64,'base64').toString(),'{"text":"中文"}');
 assert.equal(value.request.url,origin+'/query?a=1&a=2');assert.ok(Object.isFrozen(value.args));assert.equal(value.digest.length,64);
 raw.content='DELETE /changed HTTP/1.1\r\n\r\n';assert.deepEqual(value.args,copy);
 const two=args2(),parsed=inspectBurpRequest(h2,two);assert.equal(parsed.request.url,origin+'/read');assert.deepEqual(parsed.request.headers,[['accept','*/*']]);assert.deepEqual(parsed.args,two);
});
test('Burp cannot hide targets, request bodies, framing or extra invocations in raw arguments',()=>{
 const bad=[
  {...args(),extra:'unreviewed'}, {...args(),usesHttps:'false'}, {...args(),targetPort:0}, {...args(),targetHostname:'127.0.0.1@else.invalid'},
  {...args(),content:args().content.replace('Host: 127.0.0.1:49123','Host: other.invalid')},
  {...args(),content:args().content.replace('Connection: close','Connection: x-delete\r\nX-Delete: yes')},
  {...args(),content:args().content.replace('Content-Length: 0','Content-Length: 0\r\nContent-Length: 0')},
  {...args(),content:args().content.replace('Content-Length: 0','Transfer-Encoding: chunked')},
  {...args(),content:args().content+'GET /second HTTP/1.1\r\n\r\n'},args('GET','/read','hidden'),args('GET','/a/../delete'),args('CONNECT','/read'),
  {...args('POST','/write','hidden'),content:args('POST','/write','hidden').content.replace('Content-Length: 6\r\n','')},
  args('GET','//other.invalid/'),args('GET','https://other.invalid/'),args('POST','/write','x'.repeat(65537)),
 ];
 for(const raw of bad)assert.throws(()=>inspectBurpRequest(h1,raw));
 for(const patch of [{':authority':'other.invalid'},{':scheme':'https'},{':protocol':'websocket'},{':method':'CONNECT'}]){
  const raw=args2();Object.assign(raw.pseudoHeaders,patch);assert.throws(()=>inspectBurpRequest(h2,raw));
 }
 const raw=args2();raw.headers={connection:'close'};assert.throws(()=>inspectBurpRequest(h2,raw));
 assert.throws(()=>inspectBurpRequest('mcp__burp__set_project_options',{}));
});
async function setup(t,{assess=()=>low,send,read,home,prior,now}={}){
 const directory=home??mkdtempSync(path.join(tmpdir(),'burp-gate-')),domain=prior?.domain??{},rows=prior?.rows??new Map(),observations=[],sent=[],reads=[],events=new Map(),effects=[];
 const store={domain:async()=>domain,async addPendingApproval(sessionId,row){const value={...row,sessionId,status:'pending',createdAt:Date.now(),id:'approval-'+(rows.size+1)};rows.set(value.id,value);return value;},
  async getPendingApproval(session,id){const row=rows.get(id);return row?.sessionId===session?row:undefined;},
  async listScopeApprovals(session){return [...rows.values()].filter(row=>row.sessionId===session&&row.method==='SCOPE');},
  async updateApprovalExecution(session,id,patch){const row=await this.getPendingApproval(session,id);assert.ok(row);Object.assign(row,patch);},
  async upsertObservation(session,row){observations.push(row);return {id:'observation-'+observations.length};}};
 let adviceCalls=0,restore;
 const manager=await createEgressManager({home:directory,now,restoreBurp:(...args)=>restore(...args),allowLoopbackFixtures:true,lifecycle:browserLifecycle(domain),storeFor:async()=>store,assess:async(...input)=>{adviceCalls++;return assess(...input);},directFetch:async(url,init)=>{reads.push({url,init});return read?read(url,init):new Response('before');}});
 let native={execute:async(raw,exec)=>{sent.push({args:structuredClone(raw),signal:exec.signal});return send?send(raw,exec):{content:[{type:'text',text:'native fixture response'}]};}};
 const source={name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'burp',transport:'streamable-http',url:'http://127.0.0.1:49999/mcp'}};
 const ctx={get:name=>name==='loader'?{entries:function*(){yield {options:source};}}:undefined,tools:{get:()=>native},on:(name,fn)=>events.set(name,fn),effect:fn=>effects.push(fn())};
 restore=createBurpRestorer(ctx,store);
 const execute=createBurpSender(ctx,store),agent={session:{id:'s'}};
 const run=(raw=args(),{name=h1,owner=agent,signal=new AbortController().signal}={})=>{const exec={name,arguments:raw,agent:owner,signal,callId:randomUUID()};return withEgressExecution({exec,sessionId:'s',manager},()=>execute(exec));};
 if(!prior)await manager.user.setScope('s',[origin]);
 t.after(async()=>{for(const effect of effects)effect();await manager.close();if(!home)rmSync(directory,{recursive:true,force:true});});
 return {run,manager,domain,rows,observations,sent,reads,store,agent,events,home:directory,calls:()=>adviceCalls,changeSource:()=>{source.config.url='http://127.0.0.1:49998/mcp';},replaceTool:()=>{native={...native};},dispose:()=>effects.forEach(effect=>effect())};
}
const pending=result=>JSON.parse(result.value.content[0].text);
test('Burp normal HTTP1/HTTP2 reads invoke the real tool body, not directFetch, with zero proxy workers',async t=>{
 const f=await setup(t);const one=await f.run();assert.equal(one.value.content[0].text,'native fixture response');await f.run(args2(),{name:h2});
 assert.equal(f.sent.length,2);assert.equal(f.reads.length,0);assert.equal(f.calls(),2);assert.equal(f.manager.user.status().activeWorkerSlots,0);assert.equal(f.observations.length,2);assert.equal(f.observations[0].httpStatus,0);
});
test('Burp concurrent identical ordinary reads each execute once without sharing one-use grants',async t=>{
 const f=await setup(t);await Promise.all([f.run(),f.run(),f.run()]);assert.equal(f.sent.length,3);assert.equal(f.calls(),3);
});
test('Jev unknown holds Burp before dispatch; user approval sends captured bytes once without re-review',async t=>{
 const f=await setup(t,{assess:()=>({...low,risk:'unknown',action:'pending'})}),raw=args(),copy=structuredClone(raw);
 const held=pending(await f.run(raw));assert.equal(held.sent,false);assert.equal(f.sent.length,0);
 raw.content='DELETE /changed HTTP/1.1\r\n\r\n';
 const row=f.rows.get(held.approvalId);assert.equal(JSON.parse(row.body).transport.kind,'burp');
 assert.equal((await f.manager.user.decide('s',row.id,'allow')).executionState,'executed');
 assert.deepEqual(f.sent[0].args,copy);assert.equal(f.reads.length,0);assert.equal(f.calls(),1);
 await assert.rejects(f.manager.user.decide('s',row.id,'allow'));assert.equal(f.sent.length,1);
});
test('Burp unknown operations retain safety requirements and use native send only after fresh approval',async t=>{
 const f=await setup(t,{assess:()=>({...low,effect:'unknown',action:'pending'})});const raw=args('POST','/compute','{"x":1}');
 const held=pending(await f.run(raw));assert.equal(f.sent.length,0);
 await assert.rejects(f.manager.user.decide('s',held.approvalId,'allow'),{code:'SRC_GATE_SAFETY_PLAN_REQUIRED'});
 const next=await f.manager.preparePending('s',held.approvalId,{effect:'compute',object:'synthetic computation',recovery:'No persistent mutation in the owned fixture'});
 assert.match(f.rows.get(next.approvalId).reason,/"fallback":false/);assert.doesNotMatch(f.rows.get(next.approvalId).reason,/判定null/);
 assert.equal(f.sent.length,0);await assert.rejects(f.manager.user.decide('s',held.approvalId,'allow'));
 await f.manager.user.decide('s',next.approvalId,'allow');assert.deepEqual(f.sent[0].args,raw);assert.equal(f.calls(),1);assert.equal(f.reads.length,0);
 assert.equal(f.rows.get(next.approvalId).responseStatus,0);assert.match(f.rows.get(next.approvalId).responseBody,/Burp MCP/);
});
test('Burp delete preserves backup/precondition/verification: only the frozen primary call uses Burp',async t=>{
 let deleted=false;const f=await setup(t,{assess:plan=>plan.entries[0].request.method==='DELETE'?{...low,effect:'destructive',risk:'high',action:'pending'}:low,send:async()=>{deleted=true;return {content:[{type:'text',text:'native delete response'}]};},read:()=>new Response(deleted?'after':'before')});
 const backupRef=await saveResponseSnapshot(f.home,'s',origin+'/state','before','text/plain');
 const held=pending(await f.run(args('DELETE','/item')));
 const next=await f.manager.preparePending('s',held.approvalId,{effect:'delete',object:'owned fixture item',recovery:'restore synthetic fixture',backupRef,precondition:{request:{url:origin+'/state',method:'GET'},status:200,bodySha256:sha('before')},verification:{request:{url:origin+'/state',method:'GET'},status:200,bodySha256:sha('after')}});
 const result=await f.manager.user.decide('s',next.approvalId,'allow');assert.equal(result.writeOutcome.verification,'matched');assert.equal(f.sent.length,1);assert.equal(f.reads.length,2);assert.ok(f.reads.every(r=>r.url===origin+'/state'));
});

test('前置GET隐藏副作用、语义未知或Jev失败时，不能当只读检查发送',async t=>{
 for(const phase of ['precondition','verification'])for(const advice of [{...low,effect:'destructive',risk:'high',action:'pending'},{...low,effect:'unknown',risk:'unknown',action:'pending'},{fallback:true}]){
  const f=await setup(t,{assess:plan=>plan.entries[0].request.url.endsWith('/unsafe-check')?advice:low});
  const before=origin+(phase==='precondition'?'/unsafe-check':'/state'),after=origin+(phase==='verification'?'/unsafe-check':'/state');
  const backupRef=await saveResponseSnapshot(f.home,'s',before,'before','text/plain');
  const held=pending(await f.run(args('DELETE','/item')));
  const next=await f.manager.preparePending('s',held.approvalId,{effect:'delete',object:'owned item',recovery:'restore fixture',backupRef,precondition:{request:{url:before,method:'GET'},status:200,bodySha256:sha('before')},verification:{request:{url:after,method:'GET'},status:200,bodySha256:sha('after')}});
  await assert.rejects(f.manager.user.decide('s',next.approvalId,'allow'),{code:'SRC_GATE_UNSAFE_SAFETY_READ'});
  assert.equal(f.sent.length,0);assert.equal(f.reads.length,0);assert.equal(f.rows.get(next.approvalId).status,'pending');
 }
});
test('Burp HTTP2 approval preserves exact pseudoheaders and body and executes once',async t=>{
 const f=await setup(t,{assess:()=>({...low,effect:'unknown',action:'pending'})}),raw=args2();raw.pseudoHeaders[':method']='POST';raw.pseudoHeaders[':path']='/compute';raw.requestBody='{"x":1}';
 const copy=structuredClone(raw),held=pending(await f.run(raw,{name:h2}));raw.requestBody='changed';
 const next=await f.manager.preparePending('s',held.approvalId,{effect:'compute',object:'synthetic calculation',recovery:'no persistent change'});
 await f.manager.user.decide('s',next.approvalId,'allow');assert.deepEqual(f.sent.map(s=>s.args),[copy]);
 await assert.rejects(f.manager.user.decide('s',next.approvalId,'allow'));assert.equal(f.sent.length,1);assert.equal(f.reads.length,0);
});
test('Burp failed precondition prevents primary send; failed verification quarantines it',async t=>{
 for(const preconditionMatches of [false,true]){
  const f=await setup(t,{read:()=>new Response(preconditionMatches?'before':'changed')});
  const backupRef=await saveResponseSnapshot(f.home,'s',origin+'/state','before','text/plain');
  const held=pending(await f.run(args('DELETE','/item')));
  const next=await f.manager.preparePending('s',held.approvalId,{effect:'delete',object:'owned item',recovery:'restore fixture',backupRef,precondition:{request:{url:origin+'/state',method:'GET'},status:200,bodySha256:sha('before')},verification:{request:{url:origin+'/state',method:'GET'},status:200,bodySha256:sha('after')}});
  if(preconditionMatches){const result=await f.manager.user.decide('s',next.approvalId,'allow');assert.equal(result.executionState,'unknown');assert.equal(f.sent.length,1);}
  else{await assert.rejects(f.manager.user.decide('s',next.approvalId,'allow'));assert.equal(f.rows.get(next.approvalId).executionState,'failed-before-send');assert.equal(f.sent.length,0);}
  await assert.rejects(f.manager.user.decide('s',next.approvalId,'allow'));
 }
});
for(const failure of ['transport','evidence','invalid-result'])test('Approved Burp uncertain outcome is recorded and never replayed: '+failure,async t=>{
 const f=await setup(t,{assess:()=>({...low,effect:'unknown',action:'pending'}),send:()=>{if(failure==='transport')throw new Error('connection lost');return failure==='invalid-result'?{isError:true,content:[]}:{content:[{type:'text',text:'sent'}]};}});
 const held=pending(await f.run(args('POST','/compute','x')));
 const next=await f.manager.preparePending('s',held.approvalId,{effect:'compute',object:'synthetic calculation',recovery:'no persistent change'});
 if(failure==='evidence')f.store.upsertObservation=async()=>{throw new Error('fixture evidence write failed');};
 await assert.rejects(f.manager.user.decide('s',next.approvalId,'allow'));assert.equal(f.rows.get(next.approvalId).executionState,'unknown');
 await assert.rejects(f.manager.user.decide('s',next.approvalId,'allow'));assert.equal(pending(await f.run(args('POST','/compute','x'))).sent,false);
 assert.equal(f.sent.length,1);
});
for(const invalidate of ['reject','scope','reset','dispose','tool','cancel','audit-failure'])test('Burp pending invalidation cannot dispatch: '+invalidate,async t=>{
 const f=await setup(t,{assess:()=>({...low,action:'pending'})});const held=pending(await f.run());
 if(invalidate==='reject'){await f.manager.user.decide('s',held.approvalId,'reject');const retry=pending(await f.run());assert.equal(retry.sent,false);}
 if(invalidate==='scope')await f.manager.user.setScope('s',[origin]);
 if(invalidate==='reset')await browserLifecycle(f.domain).reset(['s'],async()=>{});
 if(invalidate==='dispose')f.dispose();if(invalidate==='tool')f.replaceTool();
 if(invalidate==='audit-failure')f.store.updateApprovalExecution=async()=>{throw new Error('fixture audit write failed');};
 await assert.rejects(f.manager.user.decide('s',held.approvalId,'allow','',invalidate==='cancel'?AbortSignal.abort():undefined));assert.equal(f.sent.length,0);
 if(['dispose','tool'].includes(invalidate))assert.equal(f.rows.get(held.approvalId).status,'pending'); // unavailable sender does not consume the human decision
});
test('Burp transport failure is unknown, never replayed, and blocks HTTP/curl aliases',async t=>{
 const f=await setup(t,{send:()=>{throw new Error('connection lost after dispatch');}});
 await assert.rejects(f.run(),error=>error.safeNotSent===false);assert.equal(f.sent.length,1);
 const again=pending(await f.run());assert.equal(again.sent,false);await assert.rejects(f.manager.fetch('s',origin+'/read'));assert.equal(f.sent.length,1);assert.equal(f.reads.length,0);
});
test('Burp cannot expand scope or launder a pending destructive HTTP operation',async t=>{
 const f=await setup(t);await assert.rejects(f.run({...args(),targetPort:49124,content:args().content.replaceAll('49123','49124')}),{code:'SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED'});assert.equal(f.sent.length,0);
 await assert.rejects(f.manager.fetch('s',origin+'/delete',{method:'DELETE'}));
 const held=pending(await f.run(args('DELETE','/delete')));assert.equal(held.approvalId,[...f.rows.keys()][0]);assert.equal(f.rows.size,1);assert.equal(f.sent.length,0);
});
test('Burp cancellation while Jev is pending never sends a late result',async t=>{
 let release,ready;const entered=new Promise(r=>ready=r);const f=await setup(t,{assess:()=>{ready();return new Promise(r=>release=r);}}),controller=new AbortController();
 const work=f.run(args(),{signal:controller.signal});await entered;controller.abort();release(low);await assert.rejects(work);assert.equal(f.sent.length,0);
});
test('Burp待审跨三十天及重启，原生用户上下文恢复原参数且只发一次',async t=>{
 const home=mkdtempSync(path.join(tmpdir(),'burp-restart-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const f=await setup(t,{home,assess:()=>({...low,action:'pending'})}),raw=args(),held=pending(await f.run(raw));await f.manager.close();
 const next=await setup(t,{home,prior:f,now:()=>Date.now()+30*86400000});
 assert.equal((await next.manager.user.inspect('s',held.approvalId)).state,'pending');
 await assert.rejects(next.manager.user.decide('s',held.approvalId,'allow'),{code:'SRC_GATE_BURP_USER_CONTEXT_REQUIRED'});
 const result=await next.manager.user.decide('s',held.approvalId,'allow','',undefined,{agent:next.agent,callId:'human-resume'});
 assert.equal(result.executionState,'executed');assert.deepEqual(next.sent.map(s=>s.args),[raw]);assert.equal(next.reads.length,0);
 await assert.rejects(next.manager.user.decide('s',held.approvalId,'allow','',undefined,{agent:next.agent}));assert.equal(next.sent.length,1);
});

test('Burp重启后配置或工具来源改变不能用旧审批发送，也不能换成HTTP',async t=>{
 const home=mkdtempSync(path.join(tmpdir(),'burp-source-change-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const f=await setup(t,{home,assess:()=>({...low,action:'pending'})}),held=pending(await f.run());await f.manager.close();
 const next=await setup(t,{home,prior:f});next.changeSource();
 await assert.rejects(next.manager.user.decide('s',held.approvalId,'allow','',undefined,{agent:next.agent}),{code:'SRC_GATE_BURP_TOOL_CHANGED'});
 assert.equal(next.sent.length,0);assert.equal(next.reads.length,0);assert.equal(next.rows.get(held.approvalId).status,'pending');
});

import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
async function bridgeFixture(t,{dropFirst=false,timeoutMs=80}={}){
 const streams=new Set(),calls=[],home=mkdtempSync(path.join(tmpdir(),'burp-bridge-test-'));
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'){res.writeHead(200,{'content-type':'text/event-stream'});streams.add(res);res.on('close',()=>streams.delete(res));res.write('event: endpoint\ndata: /messages\n\n');return;}
  let body='';for await(const part of req)body+=part;const message=JSON.parse(body);
  if(message.method==='tools/call')calls.push(message.params);
  if(message.id!==undefined&&!(dropFirst&&message.method==='tools/call'&&calls.length===1)){
   const result=message.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'owned-fixture',version:'1'}}:message.method==='tools/list'?{tools:[]}:{content:[{type:'text',text:'fixture-response'}]};
   for(const stream of streams)stream.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n\n');
  }
  res.writeHead(202).end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const child=spawn(process.execPath,[new URL('../tools/burp-mcp-bridge.mjs',import.meta.url).pathname],{env:{PATH:process.env.PATH,DSH_HOME:home,BURP_SSE_URL:`http://127.0.0.1:${server.address().port}/`,BURP_BRIDGE_TIMEOUT_MS:String(timeoutMs)},stdio:['pipe','pipe','ignore']});
 const closed=new Promise(resolve=>child.once('exit',resolve)),waiters=new Map();let sequence=0;
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const response=JSON.parse(line),pending=waiters.get(response.id);if(pending){waiters.delete(response.id);clearTimeout(pending.timer);pending.resolve(response);}});
 const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{waiters.delete(id);reject(new Error('bridge fixture response timeout'));},5000);waiters.set(id,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 t.after(async()=>{for(const pending of waiters.values())clearTimeout(pending.timer);child.kill();await closed;lines.close();for(const stream of streams)stream.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true});});
 await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
 return {request,calls};
}
for(const name of ['send_http1_request','send_http2_request','set_task_execution_engine_state'])test('actual bridge never retries an uncertain active call: '+name,async t=>{
 const f=await bridgeFixture(t,{dropFirst:true});
 const result=await f.request('tools/call',{name,arguments:name==='send_http1_request'?args():name==='send_http2_request'?args2():{running:true}});
 assert.ok(result.error,JSON.stringify(result));assert.equal(f.calls.length,1);
});
test('actual bridge still heals read-only history and sends valid HTTP2-shaped arguments',async t=>{
 const f=await bridgeFixture(t,{dropFirst:true});const result=await f.request('tools/call',{name:'get_proxy_http_history',arguments:{count:1,offset:0}});
 assert.ok(result.result);assert.equal(f.calls.length,2);
 const two=await f.request('tools/call',{name:'send_http2_request',arguments:args2()});assert.ok(two.result);assert.equal(f.calls.length,3);assert.deepEqual(f.calls[2].arguments,args2());
});

test('Burp会话冷却后重新载入不要求重启整个服务，用户新上下文恢复同源原参数',async t=>{
 const f=await setup(t,{assess:()=>({...low,action:'pending'})}),raw=args(),held=pending(await f.run(raw));
 f.events.get('session/disposed')(f.agent.session);
 const resumedAgent={session:{id:'s'}};
 await assert.rejects(f.manager.user.decide('s',held.approvalId,'allow'),{code:'SRC_GATE_BURP_SESSION_CLOSED'});
 const result=await f.manager.user.decide('s',held.approvalId,'allow','',undefined,{agent:resumedAgent,callId:'human-after-idle'});
 assert.equal(result.executionState,'executed');assert.deepEqual(f.sent.map(s=>s.args),[raw]);assert.equal(f.reads.length,0);
});

test('旧unknown Burp单可由人类确认低影响后原样发送一次，不调用directFetch',async t=>{
 const f=await setup(t,{assess:()=>({...low,effect:'unknown',risk:'unknown',action:'pending'})});
 const raw=args('POST','/render','{"template":12345}'),copy=structuredClone(raw),held=pending(await f.run(raw));
 assert.equal(f.sent.length,0);await assert.rejects(f.manager.user.decide('s',held.approvalId,'allow'),{code:'SRC_GATE_SAFETY_PLAN_REQUIRED'});
 await f.manager.user.decide('s',held.approvalId,'allow-read');assert.deepEqual(f.sent[0].args,copy);assert.equal(f.reads.length,0);assert.equal(f.calls(),1);
 await assert.rejects(f.manager.user.decide('s',held.approvalId,'allow-read'));assert.equal(f.sent.length,1);
});
