import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {apply,SrcStore} from '../lib/src.js';
import {createEgressManager} from '../lib/src/egress/manager.js';
import {withEgressExecution} from '../lib/src/egress/runtime.js';
import {targetDeadline} from '../lib/src/bounded-transport.js';
import {flushDefaultTelemetry} from '../lib/src/telemetry/events.js';

async function fixture(t,{assess=async()=>({mode:'on',fallback:false,effect:'unknown',risk:'unknown',action:'pending',confidence:1}),send=async()=>new Response('invalid password',{status:401})}={}){
 const home=await mkdtemp(path.join(tmpdir(),'src-tool-approval-')),old=process.env.DSH_HOME;process.env.DSH_HOME=home;
 const tables=new Map(),registry=new Map(),effects=[];
 const domain={table(name){if(!tables.has(name))tables.set(name,new Map());const rows=tables.get(name);return {get:k=>rows.get(k),entries:()=>rows.entries(),put:async(k,v)=>rows.set(k,v),delete:async k=>rows.delete(k)};},close:async()=>{}};
 const session={id:'tool-fixture',header:{cwd:home},events:[],append(type,data){this.events.push({type,data});}};
 const ctx={storageDomain:{open:async()=>domain},tools:{register:t=>registry.set(t.name,t)},sessions:{get:()=>session},subagents:{},effect:fn=>effects.push(fn),inject(){}};
 apply(ctx);const store=new SrcStore(ctx);await store.initGoal(session.id,{target:'127.0.0.1',objective:'owned fixture'});
 const intent=await store.addIntent(session.id,{goalId:'goal-1',title:'fixture',detail:'fixture'});let sends=0;
 const manager=await createEgressManager({home,allowLoopbackFixtures:true,storeFor:async()=>store,assess,directFetch:async(...args)=>{sends++;return send(...args);}});
 await manager.user.setScope(session.id,['http://127.0.0.1:49123']);
 t.after(async()=>{await manager.close();await store.dispose();for(const fn of effects){const cleanup=fn();if(typeof cleanup==='function')await cleanup();}await flushDefaultTelemetry();if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;await rm(home,{recursive:true,force:true});});
 return {home,store,render:(name,value)=>registry.get(name).output.render({},value),intentId:intent.nodeId,session,sends:()=>sends,manager,run:async(name,args)=>{const exec={agent:{session},name,signal:new AbortController().signal};return withEgressExecution({manager,sessionId:session.id,exec},()=>registry.get(name).execute(args,exec));}};
}
test('凭据验证待审立即返回原审批号，不继续猜测、不计已尝试、不虚报完成',async t=>{
 const f=await fixture(t);const result=await f.run('src_test_credential',{intentId:f.intentId,loginUrl:'http://127.0.0.1:49123/login',username:'fixture',candidates:['one','two'],dictionarySource:'fixture'});
 assert.equal(f.sends(),0);assert.equal(result.triedCount,0);assert.equal(result.requiresDecision,true);assert.ok(result.pendingApprovalId);
 const data=await f.store.sessionData(f.session.id);assert.equal(data.pendingApprovals.filter(r=>r.status==='pending').length,1);assert.equal(data.coverage[0].status,'blocked');
});
test('差分测试遇待审不继续派生变体，forceAfterProtection不能覆盖审批',async t=>{
 const f=await fixture(t);const research=await f.store.upsertResearch(f.session.id,{intentId:f.intentId,category:'authorization-bypass',hypothesis:'fixture',preconditions:[],status:'hypothesis',stopReason:'',evidence:[]});
 const result=await f.run('src_test_bypass',{intentId:f.intentId,researchId:research.id,category:'authorization-bypass',baseUrl:'http://127.0.0.1:49123',baseline:{path:'/catalog'},variants:[{path:'/catalog',headers:{'x-test':'1'}}],forceAfterProtection:true});
 assert.equal(f.sends(),0);assert.equal(result.requiresDecision,true);assert.ok(result.pendingApprovalId);assert.equal(result.triedCount,0);
 assert.equal((await f.store.sessionData(f.session.id)).coverage[0].status,'blocked');
});
test('目标超时只从onSend开始，审核等待不计时，发送后仍有界',async t=>{
 const f=await fixture(t,{assess:async()=>{await new Promise(r=>setTimeout(r,80));return {mode:'on',fallback:false,effect:'read',risk:'low',action:'allow',confidence:1};}});
 const deadline=targetDeadline(30);try{await f.manager.fetch(f.session.id,'http://127.0.0.1:49123/read',{signal:deadline.signal,onSend:deadline.onSend});assert.equal(f.sends(),1);assert.equal(deadline.signal.aborted,false);}finally{deadline.close();}
 const second=targetDeadline(20);second.onSend();await new Promise(r=>setTimeout(r,40));assert.equal(second.signal.aborted,true);second.close();
});
test('单项网络结果未知不得连续尝试下一凭据',async t=>{
 const f=await fixture(t,{assess:async()=>({mode:'on',fallback:false,effect:'auth',risk:'low',action:'allow',confidence:1}),send:async()=>{throw new Error('synthetic dropped connection');}});
 const result=await f.run('src_test_credential',{intentId:f.intentId,loginUrl:'http://127.0.0.1:49123/login',username:'fixture',candidates:['one','two'],dictionarySource:'fixture'});
 assert.equal(f.sends(),1);assert.equal(result.requiresDecision,true);assert.equal(result.stopped,'outcome-unknown');assert.equal(result.sent,'unknown');assert.equal(result.triedCount,0);
});

const fileAdvice=(plan,exec)=>{
 const method=plan.entries[0].request.method;
 return {mode:'on',fallback:false,risk:'low',action:'allow',confidence:1,
  effect:method==='DELETE'?'destructive':['POST','PUT'].includes(method)?'write':'read',
  objectClass:method==='POST'?'new-test-file':['DELETE','PUT'].includes(method)?'owned-test-file':'not-applicable'};
};
const origin='http://127.0.0.1:49123',file=origin+'/uploads/fixture-only.txt';
const fileSender=async(_url,init)=>init.method==='POST'?new Response('created',{status:201,headers:{Location:file,ETag:'"v1"'}}):init.method==='PUT'?new Response('updated',{headers:{ETag:'"v2"'}}):new Response(null,{status:204});
test('无害上传、强版本绑定的自建文件覆盖/删除自动执行，重复删除不重发',async t=>{
 const reviewed=[];const f=await fixture(t,{assess:(plan,exec)=>{reviewed.push(exec.verifiedTestObjects);return fileAdvice(plan,exec);},send:fileSender});
 await f.manager.fetch(f.session.id,origin+'/upload',{method:'POST',body:'fixture'});
 await f.manager.fetch(f.session.id,file,{method:'PUT',headers:{'If-Match':'"v1"'},body:'fixture-update'});
 await f.manager.fetch(f.session.id,file,{method:'DELETE',headers:{'If-Match':'"v2"'}});
 assert.equal(f.sends(),3);assert.equal(reviewed[0].length,0);assert.equal(reviewed[1][0].url,file);assert.equal(reviewed[2][0].etag,'"v2"');
 await assert.rejects(f.manager.fetch(f.session.id,file,{method:'DELETE',headers:{'If-Match':'"v2"'}}));assert.equal(f.sends(),3);
});
for(const variant of ['no-proof','other-object','missing-version','changed-account','changed-tenant','stale-version'])test(`自称自己的文件不足以自动删改：${variant}`,async t=>{
 const f=await fixture(t,{assess:fileAdvice,send:fileSender});
 if(variant!=='no-proof')await f.manager.fetch(f.session.id,origin+'/upload',{method:'POST',body:'fixture'});
 const headers={'If-Match':'"v1"'};
 if(variant==='missing-version')delete headers['If-Match'];if(variant==='stale-version')headers['If-Match']='"v0"';if(variant==='changed-account')headers.Authorization='Bearer other-fixture';
 if(variant==='changed-tenant')headers['X-Tenant-Id']='other-tenant';
 const before=f.sends();await assert.rejects(f.manager.fetch(f.session.id,variant==='other-object'?origin+'/business-record':file,{method:'DELETE',headers},{verifiedTestObjects:[{url:file,etag:'"v1"'}]}),{code:'SRC_GATE_PENDING_OR_REJECTED'});assert.equal(f.sends(),before);
});
test('测试对象归属跨重启保留，但结果未知的写入不产生新版本权限',async t=>{
 const f=await fixture(t,{assess:fileAdvice,send:fileSender});await f.manager.fetch(f.session.id,origin+'/upload',{method:'POST',body:'fixture'});await f.manager.close();
 let sent=0;const second=await createEgressManager({home:f.home,allowLoopbackFixtures:true,storeFor:async()=>f.store,assess:fileAdvice,directFetch:async()=>{sent++;throw new Error('synthetic disconnect');}});t.after(()=>second.close());
 await assert.rejects(second.fetch(f.session.id,file,{method:'PUT',headers:{'If-Match':'"v1"'},body:'changed'}),/disconnect/);
 await assert.rejects(second.fetch(f.session.id,file,{method:'DELETE',headers:{'If-Match':'"v1"'}}));assert.equal(sent,1);
});
test('追踪头变化不能洗掉人工拒绝，但不同只读操作不连带锁死',async t=>{
 let low=false;const f=await fixture(t,{assess:async()=>({mode:'on',fallback:false,effect:low?'compute':'unknown',risk:low?'low':'unknown',action:low?'allow':'pending',confidence:1})});
 let pending;try{await f.manager.fetch(f.session.id,origin+'/render',{method:'POST',body:'fixture'});}catch(e){pending=e;}
 await f.manager.user.decide(f.session.id,pending.approvalId,'reject');low=true;
 await assert.rejects(f.manager.fetch(f.session.id,origin+'/render',{method:'POST',headers:{'X-Trace-Id':'new'},body:'fixture'}));assert.equal(f.sends(),0);
 await f.manager.fetch(f.session.id,origin+'/render',{method:'GET'});assert.equal(f.sends(),1);
});

test('存活探测待审不能记dead，也不能渲染成已完成',async t=>{
 const {resetFlagsForTests}=await import('../lib/src/flags.js');const old=process.env.DSH_SRC_SURVEY;resetFlagsForTests();process.env.DSH_SRC_SURVEY='on';
 t.after(()=>{resetFlagsForTests();if(old!==undefined)process.env.DSH_SRC_SURVEY=old;});
 const f=await fixture(t),seed=await f.store.addSurveySeed(f.session.id,{kind:'subdomain',value:'127.0.0.1',source:'user-list',note:'fixture'});
 await f.manager.user.setScope(f.session.id,['http://127.0.0.1:49123','https://127.0.0.1']);
 const result=await f.run('src_survey_seed',{action:'probe',seedId:seed.seed.id});
 assert.equal(f.sends(),0);assert.equal(result.requiresDecision,true);assert.ok(result.pendingApprovalId);assert.equal((await f.store.sessionData(f.session.id)).facts.length,0);
 const text=f.render('src_survey_seed',result)[0].text;assert.match(text,/未完成/);assert.ok(text.includes(result.pendingApprovalId));
});

test('同接口不同待审只读验证，批准一个只发送该冻结请求，不互锁',async t=>{
 const sent=[];const f=await fixture(t,{assess:async()=>({mode:'on',fallback:false,effect:'read',risk:'high',action:'pending',confidence:1}),send:async(u,i)=>{sent.push(String(i.body));return new Response('ok');}});
 const ids=[];
 for(const body of ['probe-one','probe-two']){try{await f.manager.fetch(f.session.id,origin+'/render',{method:'POST',body});}catch(e){ids.push(e.approvalId);}}
 assert.equal(new Set(ids).size,2);assert.equal(sent.length,0);
 const result=await f.manager.user.decide(f.session.id,ids[0],'allow');assert.equal(result.executionState,'executed');assert.deepEqual(sent,['probe-one']);
 assert.equal((await f.store.getPendingApproval(f.session.id,ids[1])).status,'pending');
});
test('浏览器装饰头不重复挂同一操作，但人工授权仍精确绑定原报文',async t=>{
 const sent=[];const f=await fixture(t,{assess:async()=>({mode:'on',fallback:false,effect:'read',risk:'high',action:'pending',confidence:1}),send:async(u,i)=>{sent.push(i);return new Response('ok');}});let first,second;
 try{await f.manager.fetch(f.session.id,origin+'/render',{method:'POST',body:'same'});}catch(e){first=e;}
 try{await f.manager.fetch(f.session.id,origin+'/render',{method:'POST',body:'same',headers:{'User-Agent':'browser','Accept':'*/*','Origin':origin,'Referer':origin+'/page'}});}catch(e){second=e;}
 assert.equal(second.code,'SRC_GATE_PENDING_OR_REJECTED');assert.equal((await f.store.sessionData(f.session.id)).pendingApprovals.length,1);
 await f.manager.user.decide(f.session.id,first.approvalId,'allow');assert.equal(sent.length,1);assert.equal(sent[0].headers['user-agent'],undefined);
});
test('真正结果未知仍锁资源，发送前被锁拒绝不得记录成已发送未知',async t=>{
 let pending=true;const f=await fixture(t,{assess:async()=>({mode:'on',fallback:false,effect:'read',risk:pending?'high':'low',action:pending?'pending':'allow',confidence:1}),send:async()=>{throw new Error('synthetic lost response');}});let id;
 try{await f.manager.fetch(f.session.id,origin+'/render',{method:'POST',body:'needs-human'});}catch(e){id=e.approvalId;}
 pending=false;await assert.rejects(f.manager.fetch(f.session.id,origin+'/render',{method:'POST',body:'independent'}),/lost response/);assert.equal(f.sends(),1);
 await assert.rejects(f.manager.user.decide(f.session.id,id,'allow'));
 const row=await f.store.getPendingApproval(f.session.id,id);assert.equal(row.executionState,'failed-before-send');assert.equal(f.sends(),1);
});
