import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createEgressManager} from '../lib/src/egress/manager.js';
import {capabilityPolicyRoots} from '../lib/src/egress/host-integration.js';
import {startGuardedTransport} from '../lib/src/egress/duplex.js';
import {withEgressExecution} from '../lib/src/egress/runtime.js';

test('duplex worker seam requires live context and keeps native policy and final-spawn guard',()=>{
 const start=startGuardedTransport;
 assert.throws(()=>start.call({},{}),{code:'SRC_GATE_MISSING_EXECUTION_CONTEXT'});
 const context={exec:{agent:{session:{id:'fixture-session'}}}};
 assert.throws(()=>withEgressExecution({...context,shellTaskId:'scan'},()=>start.call({},{})),{code:'SRC_GATE_TRANSPORT_SCAN_PLAN_FORBIDDEN'});
 for(const mode of ['workspace-write','danger-full-access']){
  const calls=[],policy={mode,sessionId:'fixture-session'},signal=new AbortController().signal;
  const fake={ctx:{sandboxPolicy:{resolve:({session})=>{assert.equal(session,context.exec.agent.session);return policy;}},subprocess:{spawn:spec=>{calls.push(spec);return spec;}}},resolve:r=>r,confine:(command,p)=>{assert.equal(p,policy);return {argv:['sandbox-exec','-p','native-policy','bash','-c',command]};},spawnSpec:(spec,argv,maxBytes,sig)=>{assert.equal(spec.sandboxPolicy,policy);assert.equal(sig,signal);assert.equal(argv[0],mode==='workspace-write'?'sandbox-exec':'bash');return {argv:['final-guard',...argv],signal:sig,env:{native:'preserved'},stdio:{stdin:'ignore',stdout:{maxBytes:20},stderr:{maxBytes:20}}};}};
  const result=withEgressExecution(context,()=>start.call(fake,{command:'fixture',signal,sandboxPolicy:{mode:'untrusted'}}));
  assert.equal(calls.length,1);assert.equal(result.argv[0],'final-guard');assert.equal(result.signal,signal);assert.deepEqual(result.env,{native:'preserved'});assert.deepEqual(result.stdio,{stdin:'pipe',stdout:'pipe',stderr:{maxBytes:20}});
 }
});

test('stale capabilities do not block unrelated tools or grant readable exceptions; future paths stay protected',async t=>{
 const temp=await mkdtemp(path.join(tmpdir(),'src-cap-roots-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const home=await realpath(temp),control=path.join(home,'control'),live=path.join(home,'live'),missing=path.join(home,'missing');
 await mkdir(control);await mkdir(live);await symlink(live,path.join(home,'alias'));await symlink(missing,path.join(home,'dangling'));
 const item=dir=>({status:'installed',dir});
 const result=await capabilityPolicyRoots([item(live),item(missing),item(path.join(home,'dangling')),item(path.join(home,'alias'))],[control]);
 assert.deepEqual(result.readablePaths,[live]);
 for(const dir of [live,missing,path.join(home,'alias'),path.join(home,'dangling')])assert.ok(result.readOnlyPaths.includes(dir));
 assert.ok(!result.readablePaths.includes(missing));
 await mkdir(missing);
 assert.deepEqual((await capabilityPolicyRoots([item(missing)],[control])).readablePaths,[missing]);
 for(const dir of [home,control,path.join(control,'missing'),'relative-root'])await assert.rejects(capabilityPolicyRoots([item(dir)],[control]),{code:'SRC_GATE_INVALID_CAPABILITY_ROOT'});
 await symlink(control,path.join(home,'control-alias'));
 await assert.rejects(capabilityPolicyRoots([item(path.join(home,'control-alias'))],[control]),{code:'SRC_GATE_INVALID_CAPABILITY_ROOT'});
 // Only absence is tolerated. Symlink loops and other filesystem faults fail closed.
 await symlink('loop',path.join(home,'loop'));
 await assert.rejects(capabilityPolicyRoots([item(path.join(home,'loop'))],[control]),{code:'ELOOP'});
});
const low={fallback:false,mode:'on',action:'allow',effect:'read',risk:'low',confidence:.99};
async function fixture(t,{advice=low}={}){
 const home=await mkdtemp(path.join(tmpdir(),'src-onboarding-'));const rows=new Map();let assessments=0;const sent=[];
 const store={addPendingApproval:async(session,data)=>{const row={...data,id:`approval-${rows.size+1}`,status:'pending',sessionId:session,createdAt:Date.now()};rows.set(row.id,row);return row;},getPendingApproval:async(s,id)=>rows.get(id)?.sessionId===s?rows.get(id):undefined,listScopeApprovals:async s=>[...rows.values()].filter(row=>row.sessionId===s&&row.category==='egress/scope'),updateApprovalExecution:async(s,id,patch)=>Object.assign(rows.get(id),patch)};
 const manager=await createEgressManager({home,allowLoopbackFixtures:true,storeFor:async()=>store,assess:async()=>{assessments++;return advice;},directFetch:async(url,init)=>{sent.push({url,method:init.method,headers:init.headers});return new Response('normal-response');}});
 t.after(async()=>{await manager.close();await rm(home,{recursive:true,force:true});});return {manager,store,home,rows,sent,assessments:()=>assessments};
}
test('fresh session: first normal request creates scope confirmation, no preconfigured authorization',async t=>{
 const f=await fixture(t),session=randomUUID(),url='http://127.0.0.1:23456/';
 const options={headers:{'User-Agent':'curl/8.7.1',Accept:'*/*'}};
 let blocked;try{await f.manager.fetch(session,url,options);}catch(e){blocked=e;}
 assert.equal(blocked.code,'SRC_GATE_PENDING_OR_REJECTED');assert.equal(blocked.reason,'scope-confirmation-required');assert.ok(blocked.approvalId);assert.equal(f.sent.length,0);assert.equal(f.assessments(),0);
 const pending=[...f.rows.values()][0];assert.equal(pending.method,'SCOPE');assert.equal(pending.category,'egress/scope');
 // The response to the actual request—not fixture setup—triggers the user action.
 const decision=await f.manager.user.decide(session,blocked.approvalId,'allow','Confirm the requested loopback fixture only');
 assert.equal(decision.sent,false);assert.equal(f.sent.length,0);
 const response=await f.manager.fetch(session,url,options);assert.equal(await response.text(),'normal-response');assert.equal(f.sent.length,1);assert.equal(f.assessments(),1);assert.equal(f.sent[0].headers['user-agent'],'curl/8.7.1');assert.equal(f.sent[0].headers.accept,'*/*');
 // Scope confirmation does not authorize a DELETE, even if advisor says low.
 await assert.rejects(f.manager.fetch(session,url,{method:'DELETE'}),{code:'SRC_GATE_PENDING_OR_REJECTED'});assert.equal(f.sent.length,1);
});
test('scope pending requests deduplicate and rejection never grants or silently reprompts',async t=>{
 const f=await fixture(t),session=randomUUID(),url='http://127.0.0.1:23456/';
 const results=await Promise.allSettled(Array.from({length:5},()=>f.manager.fetch(session,url)));
 assert.equal(f.rows.size,1);const id=results[0].reason.approvalId;assert.ok(results.every(r=>r.status==='rejected'&&r.reason.approvalId===id));
 await f.manager.user.decide(session,id,'reject');await assert.rejects(f.manager.fetch(session,url),{code:'SRC_GATE_PENDING_OR_REJECTED',state:'rejected'});
 assert.equal(f.rows.size,1);assert.equal(f.manager.user.getScope(session),undefined);assert.equal(f.sent.length,0);
 await assert.rejects(f.manager.user.decide(session,id,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});
});
test('scope approval cannot cross sessions or overwrite a scope confirmed in the meantime',async t=>{
 const f=await fixture(t),url='http://127.0.0.1:23456/';let id;
 try{await f.manager.fetch('one',url);}catch(e){id=e.approvalId;}
 await assert.rejects(f.manager.user.decide('two',id,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});
 await f.manager.user.setScope('one',['http://127.0.0.1:34567']);
 await assert.rejects(f.manager.user.decide('one',id,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});assert.deepEqual(f.manager.user.getScope('one').origins,['http://127.0.0.1:34567']);
});
test('scope decision persistence failure cannot grant scope',async t=>{
 const f=await fixture(t);let id;
 try{await f.manager.fetch('persist-failure','http://127.0.0.1:23456/');}catch(e){id=e.approvalId;}
 f.store.updateApprovalExecution=async()=>{throw new Error('synthetic storage failure');};
 await assert.rejects(f.manager.user.decide('persist-failure',id,'allow'),/storage failure/);
 assert.equal(f.manager.user.getScope('persist-failure'),undefined);assert.equal(f.sent.length,0);
});
test('scope final UI persistence failure reports the committed user decision honestly',async t=>{
 const f=await fixture(t);let id;
 try{await f.manager.fetch('ui-failure','http://127.0.0.1:23456/');}catch(e){id=e.approvalId;}
 const update=f.store.updateApprovalExecution;let writes=0;
 f.store.updateApprovalExecution=async(...args)=>{if(++writes===2)throw new Error('synthetic UI write failure');return update(...args);};
 const decision=await f.manager.user.decide('ui-failure',id,'allow');
 assert.equal(decision.state,'approved');assert.equal(decision.sent,false);assert.match(decision.notification,/刷新失败/);
 assert.deepEqual(f.manager.user.getScope('ui-failure').origins,['http://127.0.0.1:23456']);
 assert.equal(f.rows.get(id).userDecision,'allow');assert.equal(f.sent.length,0);
 await assert.rejects(f.manager.user.decide('ui-failure',id,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});
});
test('cleared scope approval row cannot be confirmed by a cached stale binding',async t=>{
 const f=await fixture(t);let id;
 try{await f.manager.fetch('cleared-goal','http://127.0.0.1:23456/');}catch(e){id=e.approvalId;}
 f.rows.delete(id);
 await assert.rejects(f.manager.user.decide('cleared-goal',id,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});
 assert.equal(f.manager.user.getScope('cleared-goal'),undefined);
});

import {assessEgressPlan} from '../lib/src/egress/advisor.js';
test('single-request advisor receives actual method URL and headers, not an opaque plan',async()=>{
 const request={url:'https://fixture.invalid/',method:'GET',headers:[['accept','*/*'],['user-agent','curl/8.7.1']],bodyBase64:''};
 const plan={maxRequests:1,entries:[{request,maxRequests:1}],purpose:'Read homepage'};
 let seen;const decide=async args=>{seen=args;return low;};
 await assessEgressPlan(plan,{},decide);assert.equal(seen.taskType,'risk-grade');assert.equal(seen.url,request.url);assert.equal(seen.method,'GET');assert.equal(seen.headers.accept,'*/*');
 const batch={...plan,maxRequests:2,entries:[{request,maxRequests:2}]};
 await assessEgressPlan(batch,{},decide);assert.equal(seen.taskType,'scan-plan');assert.deepEqual(seen.plan,batch);
});

import {allowsLowImpactRead} from '../lib/src/egress/decision-policy.js';
import {requiresHuman} from '../lib/src/egress/plan.js';
test('validated read/low/allow is not overridden by an uncalibrated aggregate-confidence threshold',()=>{
 assert.equal(allowsLowImpactRead({...low,confidence:.42}),true);
 for(const patch of [{effect:'unknown'},{risk:'unknown'},{risk:'high'},{action:'pending'},{effect:'write'},{fallback:true},{mode:'shadow'},{confidence:NaN},{confidence:-1},{confidence:1.1}])assert.equal(allowsLowImpactRead({...low,...patch}),false);
});
test('credentials alone are not a destructive action; method overrides and indirect requests still veto',()=>{
 const request={url:'https://fixture.invalid/account',method:'GET',headers:[['authorization','Bearer fixture'],['cookie','session=fixture']],bodyBase64:''};
 assert.equal(requiresHuman({entries:[{request}]}),false);
 for(const patch of [{method:'DELETE'},{url:'https://fixture.invalid/delete?id=7'},{url:'https://fixture.invalid/fetch?url=http://169.254.169.254/'},{headers:[...request.headers,['x-http-method-override','DELETE']]}])assert.equal(requiresHuman({entries:[{request:{...request,...patch}}]}),true);
});

test('normal read with schema-filled safety hints is assessed, not forced into a mutation lane', async t => {
 const f=await fixture(t),session=randomUUID(),origin='http://127.0.0.1:23456';
 await f.manager.user.setScope(session,[origin]);
 const safety={effect:'read',object:'GET /read response',recovery:'',semantics:'replace',backupRef:'',precondition:{},verification:{},irreversibleAcknowledgement:''};
 const result=await f.manager.fetch(session,origin+'/read',{}, {egressSafetyPlan:safety});
 assert.equal(result.status,200);assert.equal(f.assessments(),1);assert.equal(f.sent.length,1);
 let pending;
 try {await f.manager.fetch(session,origin+'/delete',{method:'DELETE'}, {egressSafetyPlan:safety});}catch(error){pending=error;}
 assert.equal(pending.code,'SRC_GATE_PENDING_OR_REJECTED');assert.equal(pending.reason,'safety-material-required');assert.ok(pending.approvalId);
 await assert.rejects(f.manager.user.decide(session,pending.approvalId,'allow'),{code:'SRC_GATE_SAFETY_PLAN_REQUIRED'});
 await assert.rejects(f.manager.fetch(session,origin+'/delete',{method:'DELETE'}),{code:'SRC_GATE_PENDING_OR_REJECTED',approvalId:pending.approvalId});
 assert.equal(f.sent.length,1);
});

import {renderHttp} from '../lib/src/evidence-output.js';
test('managed HTTP render reports actual received response, not a false not-sent status',()=>{
 const value={approval:'allowed-egress',status:200,method:'GET',path:'/read',responseBody:'synthetic',evidenceId:'fixture-evidence'};
 const text=renderHttp({},value)[0].text;
 assert.match(text,/200 GET \/read（已执行）/);assert.match(text,/synthetic/);assert.doesNotMatch(text,/未发出|未执行/);
 for(const pending of [{...value,approval:'pending',status:0},{...value,status:0}])assert.doesNotMatch(renderHttp({},pending)[0].text,/（已执行）|响应体/);
 assert.match(renderHttp({}, {...value,approval:'pending',status:0,nextAction:'结束当前回合，禁止 sleep'})[0].text,/结束当前回合，禁止 sleep/);
});

import {createScopeRequests} from '../lib/src/egress/scope-requests.js';
function durableScopeFixture(){
 let time=1000000,serial=0,scope;const rows=new Map();
 const store={
  async listScopeApprovals(session){return [...rows.values()].filter(r=>r.sessionId===session);},
  async getPendingApproval(session,id){const row=rows.get(id);return row?.sessionId===session?row:undefined;},
  async addPendingApproval(session,data){const row={...data,id:`approval-${++serial}`,sessionId:session,status:'pending',createdAt:time};rows.set(row.id,row);return row;},
  async updateApprovalExecution(session,id,patch){const row=await this.getPendingApproval(session,id);if(!row)throw new Error('missing');Object.assign(row,patch);return row;}
 };
 const create=()=>createScopeRequests({storeFor:async()=>store,getScope:()=>scope,now:()=>time,setScope:async(session,origins,{ifAbsent}={})=>{if(ifAbsent&&scope)throw Object.assign(new Error('stale'),{code:'SRC_GATE_STALE_APPROVAL'});scope={origins};}});
 return {rows,store,create,advance:()=>{time+=900001;},scope:()=>scope};
}
async function missingScope(gate,session='scope-durable',origin='https://fixture.invalid'){
 let result;try{await gate.require(session,[origin]);}catch(error){result=error;}
 assert.equal(result?.code,'SRC_GATE_PENDING_OR_REJECTED');return result;
}
test('scope pending survives manager recreation; native confirmation still required',async()=>{
 const f=durableScopeFixture(),first=f.create();const p=await missingScope(first);first.clear();
 const restored=f.create();assert.equal((await missingScope(restored)).approvalId,p.approvalId);
 assert.equal((await restored.inspect('scope-durable',p.approvalId)).state,'pending');assert.equal(f.scope(),undefined);
 assert.equal((await restored.decide('scope-durable',p.approvalId,'allow')).sent,false);assert.ok(f.scope());
});
test('scope rejection remains terminal across restart and expiry without reprompt',async()=>{
 const f=durableScopeFixture(),first=f.create(),p=await missingScope(first);
 await first.decide('scope-durable',p.approvalId,'reject');first.clear();f.advance();
 const restored=f.create(),again=await missingScope(restored);
 assert.equal(again.state,'rejected');assert.equal(again.approvalId,p.approvalId);assert.equal(f.rows.size,1);
 assert.match(again.nextAction,/用户已拒绝/);assert.equal(f.scope(),undefined);
});
test('expired pending scope gets a fresh ID, old approval cannot grant, cache cannot fill permanently',async()=>{
 const f=durableScopeFixture(),gate=f.create();let first;
 for(let i=0;i<140;i++){
  const p=await missingScope(gate);first??=p.approvalId;
  assert.equal(p.state,'pending');if(i>0)assert.notEqual(p.approvalId,first);
  f.advance();
 }
 await assert.rejects(gate.decide('scope-durable',first,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});
 assert.equal(f.scope(),undefined);assert.equal([...f.rows.values()].filter(r=>r.status==='pending').length,1);
});
test('concurrent native scope decisions cannot both grant; interrupted durable decision is stale on restart',async()=>{
 const f=durableScopeFixture(),gate=f.create(),p=await missingScope(gate);
 const results=await Promise.allSettled([gate.decide('scope-durable',p.approvalId,'allow'),gate.decide('scope-durable',p.approvalId,'allow')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const interrupted=durableScopeFixture(),g=interrupted.create(),q=await missingScope(g);
 interrupted.rows.get(q.approvalId).userDecision='allow';g.clear();
 const restored=interrupted.create();assert.equal((await missingScope(restored)).state,'stale');
 await assert.rejects(restored.decide('scope-durable',q.approvalId,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});assert.equal(interrupted.scope(),undefined);
});
test('closed scope service rejects outstanding proposal without authorizing',async()=>{
 const f=durableScopeFixture(),gate=f.create();const work=gate.require('scope-durable',['https://fixture.invalid']);gate.clear();
 await assert.rejects(work,{code:'SRC_GATE_CLOSED'});assert.equal(f.scope(),undefined);
});
test('real manager ledger restart restores pending scope ID and preserves rejected scope',async t=>{
 const f=await fixture(t);let pendingId,rejectedId;
 for(const session of ['restart-pending','restart-rejected']){
  try{await f.manager.fetch(session,'http://127.0.0.1:23456/');}catch(error){if(session==='restart-pending')pendingId=error.approvalId;else rejectedId=error.approvalId;}
 }
 await f.manager.user.decide('restart-rejected',rejectedId,'reject');await f.manager.close();
 let sent=0;
 const restored=await createEgressManager({home:f.home,allowLoopbackFixtures:true,storeFor:async()=>f.store,assess:async()=>low,directFetch:async()=>{sent++;return new Response('restored');}});
 try{
  assert.equal((await restored.user.inspect('restart-pending',pendingId)).state,'pending');
  await assert.rejects(restored.fetch('restart-rejected','http://127.0.0.1:23456/'),{code:'SRC_GATE_PENDING_OR_REJECTED',state:'rejected',approvalId:rejectedId});
  assert.equal(f.rows.size,2);assert.equal(sent,0);
  assert.equal((await restored.user.decide('restart-pending',pendingId,'allow')).sent,false);
  assert.equal(await (await restored.fetch('restart-pending','http://127.0.0.1:23456/')).text(),'restored');assert.equal(sent,1);
 }finally{await restored.close();}
});

import {proxyResponse,createEgressEvidenceRecorder} from '../lib/src/egress/evidence.js';
import {createHash} from 'node:crypto';
test('large proxy response keeps bounded evidence without fabricating a full rollback snapshot',async t=>{
 const home=await mkdtemp(path.join(tmpdir(),'src-large-capture-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const full=Buffer.alloc(1024*1024,120),bodySha256=createHash('sha256').update(full).digest('hex');
 const input={status:200,headers:[['content-type','application/javascript']],bodyBase64:full.subarray(0,65536).toString('base64'),totalBytes:full.length,bodySha256};
 const response=proxyResponse(input);assert.equal((await response.clone().arrayBuffer()).byteLength,65536);
 let captured;const record=createEgressEvidenceRecorder({home,store:{upsertObservation:async(_session,row)=>{captured=row;return {...row,id:'observation-1'};}}});
 const out=await record('fixture-large',{request:{url:'https://fixture.invalid/assets/app.js',method:'GET',headers:[],bodyBase64:''},response,grant:{taskId:'fixture-task',dispatchId:'fixture-dispatch'}});
 assert.equal(out.snapshotRef,undefined);assert.equal(captured.snapshotRef,undefined);assert.equal(captured.respBodySnippet,'x'.repeat(32000)+'\n…[截断 65536 字符]');
 assert.match(captured.decision,/1048576字节/);assert.match(captured.decision,/不可作为完整回滚备份/);assert.ok(captured.decision.includes(bodySha256));
 for(const patch of [{totalBytes:8*1024*1024+1},{totalBytes:1},{bodySha256:'bad'},{bodyBase64:'eA=='},{totalBytes:65536,bodySha256:'0'.repeat(64)}])assert.throws(()=>proxyResponse({...input,...patch}),{code:'SRC_GATE_INVALID_PROXY_RESPONSE'});
});

import {egressDecisionMessage} from '../lib/src/egress/notifications.js';
test('task confirmation wakes the model without claiming a scan was already sent or replaying host writes',()=>{
 const task=egressDecisionMessage('egress/task','approval-1','allow',{state:'active'});
 assert.match(task,/尚未发送请求/);assert.match(task,/下一次实际启动/);
 const executed=egressDecisionMessage('egress/task','approval-2','allow',{executionState:'executed',responseStatus:200});
 assert.match(executed,/主机已执行/);assert.match(executed,/禁止模型重放/);assert.doesNotMatch(executed,/下一次实际启动/);
 assert.match(egressDecisionMessage('egress/task','approval-3','allow',{executionState:'unknown'}),/先人工核对/);
 assert.match(egressDecisionMessage('egress/task','approval-4','reject',{}),/不得重放/);
});
test('one scheduled shell plan can be consumed once at actual process launch',async t=>{
 const f=await fixture(t),session='shell-one-shot',url='http://127.0.0.1:23456/read';await f.manager.user.setScope(session,['http://127.0.0.1:23456']);
 const plan=await f.manager.proposeShellTask(session,{entries:[{request:{url,method:'GET'},maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:300000,purpose:'one shell command'});
 assert.equal(plan.state,'active');f.manager.claimShellTask(session,plan.id);
 assert.throws(()=>f.manager.claimShellTask(session,plan.id),{code:'SRC_GATE_STALE_SHELL_TASK'});
 assert.equal(f.sent.length,0);
});

import {renderScan} from '../lib/src/evidence-output.js';
test('pending native scan renders its exact resume task and does not claim a completed scan',()=>{
 const text=renderScan({}, {stopped:'approval-pending',pendingApprovalId:'approval-7',taskId:'frozen-task',nextAction:'批准后用原参数和 taskId=frozen-task 恢复 src_scan_surface。'})[0].text;
 assert.match(text,/扫描未发送/);assert.match(text,/approval-7/);assert.match(text,/taskId=frozen-task/);assert.match(text,/src_scan_surface/);assert.doesNotMatch(text,/Scanned/);
 const notification=egressDecisionMessage('egress/task','approval-7','allow',{state:'active'});
 assert.match(notification,/src_scan_surface 携带原 taskId 和原参数/);assert.match(notification,/只有 bash 扫描计划/);
});

test('review distinguishes active, completed, denied and stale-restart plans without sending',async t=>{
 const f=await fixture(t,{advice:{...low,effect:'unknown',risk:'unknown',action:'pending'}}),session='review-lifecycle',origin='http://127.0.0.1:23456';
 await f.manager.user.setScope(session,[origin]);
 const body={entries:[{request:{url:origin+'/catalog',method:'GET'},maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:300000,purpose:'native review lifecycle'};
 const pending=await f.manager.prepareToolTask(session,body,{});
 await f.manager.user.decide(session,pending.approvalId,'allow');
 assert.equal((await f.manager.user.inspect(session,pending.approvalId)).state,'active');assert.equal(f.sent.length,0);
 await f.manager.prepareToolTask(session,body,{},pending.id);
 await f.manager.fetch(session,origin+'/catalog',{}, {egressTaskId:pending.id});
 f.manager.completeToolTask(session,pending.id);
 let view=await f.manager.user.inspect(session,pending.approvalId);
 assert.equal(view.state,'completed_tool');assert.equal(view.used,1);assert.equal(view.executable,false);assert.equal(view.sendsRequest,false);
 const second={...body,entries:[{request:{url:origin+'/unstarted',method:'GET'},maxRequests:1}]};
 const unused=await f.manager.prepareToolTask(session,second,{});
 await f.manager.user.decide(session,unused.approvalId,'allow');
 const rejected=await f.manager.prepareToolTask(session,{...body,entries:[{request:{url:origin+'/rejected',method:'GET'},maxRequests:1}]},{});
 await f.manager.user.decide(session,rejected.approvalId,'reject');
 assert.equal((await f.manager.user.inspect(session,rejected.approvalId)).state,'denied');
 await f.manager.close();
 const restored=await createEgressManager({home:f.home,storeFor:async()=>f.store,allowLoopbackFixtures:true});
 try{
  assert.equal((await restored.user.inspect(session,pending.approvalId)).state,'completed_tool');
  assert.equal((await restored.user.inspect(session,unused.approvalId)).state,'revoked');
  assert.equal((await restored.user.inspect(session,rejected.approvalId)).state,'denied');
  assert.equal(f.sent.length,1);
 }finally{await restored.close();}
});

test('an approval surviving a missing ledger task is inspectable but never executable',async t=>{
 const f=await fixture(t),session='orphaned-approval';
 const row=await f.store.addPendingApproval(session,{method:'TASK',category:'egress/task',url:`src-egress://${randomUUID()}`,body:'[]'});
 const view=await f.manager.user.inspect(session,row.id);
 assert.equal(view.state,'stale');assert.equal(view.executable,false);assert.equal(f.sent.length,0);
 await assert.rejects(f.manager.user.decide(session,row.id,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});
});

test('egress root declares live sessions so store approval commits reach the Web projection',async()=>{
 const {inject}=await import('../lib/src-egress.js');
 assert.ok(inject.includes('storageDomain'));
 assert.ok(inject.includes('sessions'),'Cordis-scoped store must be able to publish session commit events');
});
