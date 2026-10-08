import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SrcStore} from '../lib/src.js';
import {createEgressManager} from '../lib/src/egress/manager.js';

// Real store mutation/ID allocation and SQLite egress ledger; the SRC domain
// table adapter is in-memory. This is not a native DSH/session restart test.
async function setup(t,{action='allow',send}={}){
 const home=await mkdtemp(path.join(tmpdir(),'src-goal-lifecycle-'));
 const tables=new Map();
 const domain={table(name){if(!tables.has(name))tables.set(name,new Map());const rows=tables.get(name);return {get:k=>rows.get(k),entries:()=>rows.entries(),put:async(k,v)=>rows.set(k,v),delete:async k=>rows.delete(k)};},close:async()=>{}};
 const store=new SrcStore({storageDomain:{open:async()=>domain}});
 const sent=[],managers=[];
 const start=async()=>{const manager=await createEgressManager({lifecycle:browserLifecycle(await store.domain()),home,storeFor:async()=>store,allowLoopbackFixtures:true,assess:async()=>({fallback:false,mode:'on',action,effect:'read',risk:'low',confidence:.99}),directFetch:async(url,init)=>{sent.push({url,method:init.method});return send?send(url,init):new Response('fixture');}});managers.push(manager);return manager;};
 t.after(async()=>{for(const manager of managers)await manager.close();await store.dispose();await rm(home,{recursive:true,force:true});});
 return {store,sent,start};
}
async function pending(manager,session,url,init){
 let result;try{await manager.fetch(session,url,init);}catch(error){result=error;}
 assert.equal(result?.code,'SRC_GATE_PENDING_OR_REJECTED');assert.ok(result.approvalId);return result;
}
const original='http://127.0.0.1:23456',other='http://127.0.0.1:34567';
test('goal reset preserves scope rejections and approval IDs across manager restart',async t=>{
 const {store,start,sent}=await setup(t),session='goal-reset-rejection';let manager=await start();
 await store.initGoal(session,{target:'127.0.0.1',objective:'original work'});
 const first=await pending(manager,session,original+'/read');
 await manager.user.decide(session,first.approvalId,'reject');
 await store.initGoal(session,{target:'different.invalid',objective:'new work cannot erase rejection'});
 assert.equal((await pending(manager,session,original+'/read')).approvalId,first.approvalId);
 const second=await pending(manager,session,other+'/read');assert.notEqual(second.approvalId,first.approvalId);
 await manager.close();manager=await start();
 assert.equal((await manager.user.inspect(session,first.approvalId)).state,'rejected');
 assert.equal((await manager.user.inspect(session,second.approvalId)).state,'pending');
 await assert.rejects(manager.user.decide(session,first.approvalId,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});
 assert.equal(manager.user.getScope(session),undefined);assert.deepEqual(sent,[]);
});
test('goal reset during scope confirmation cannot rebind the confirmed origins or revive rejected tasks',async t=>{
 const {store,start,sent}=await setup(t),manager=await start(),session='goal-reset-confirming';
 await store.initGoal(session,{target:'127.0.0.1',objective:'original work'});
 const scope=await pending(manager,session,original+'/read');
 const update=store.updateApprovalExecution.bind(store);let reset=false;
 store.updateApprovalExecution=async(s,id,patch)=>{
  const row=await update(s,id,patch);
  if(patch.executionState==='scope-confirming'&&!reset){reset=true;await store.initGoal(session,{target:'different.invalid',objective:'changed while confirming'});}
  return row;
 };
 await manager.user.decide(session,scope.approvalId,'allow');
 assert.equal(reset,true);assert.deepEqual(manager.user.getScope(session).origins,[original]);
 await assert.rejects(manager.fetch(session,other+'/read'),{code:'SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED'});assert.deepEqual(sent,[]);
 assert.equal(await (await manager.fetch(session,original+'/read')).text(),'fixture');
 const dangerous=await pending(manager,session,original+'/delete',{method:'DELETE'});
 await manager.user.decide(session,dangerous.approvalId,'reject');
 await store.initGoal(session,{target:'127.0.0.1',objective:'reset cannot revive delete'});
 await assert.rejects(manager.fetch(session,original+'/delete',{method:'DELETE'}),{code:'SRC_GATE_PENDING_OR_REJECTED',taskId:dangerous.taskId,state:'denied'});
 assert.equal((await store.getPendingApproval(session,dangerous.approvalId)).status,'rejected');
 assert.deepEqual(sent,[{url:original+'/read',method:'GET'}]);
});

import {browserLifecycle} from '../lib/src/egress/browser-lifecycle.js';
import {createBrowserSessions} from '../lib/src/egress/browser-sessions.js';
test('central store reset retires parent and related child browser state, not unrelated sessions',async t=>{
 const {store}=await setup(t),domain=await store.domain(),lifecycle=browserLifecycle(domain);
 let starts=0,closes=0;
 const pool=createBrowserSessions({start:async()=>({initialize:async()=>{starts++;},close:async()=>{closes++;}})});
 const off=lifecycle.subscribe(ids=>pool.invalidateRelated(ids));t.after(async()=>{off();await pool.close();});
 const run=id=>pool.run({sessionId:id,authorizationSessionId:id==='other'?'other':'parent',policyKey:id,options:{}},async()=>{});
 await Promise.all(['parent','child','other'].slice(0,2).map(run));
 const old=lifecycle.ticket('parent');
 await store.initGoal('parent',{target:'fixture.invalid',objective:'reset'});
 assert.throws(old,{code:'SRC_GATE_BROWSER_SESSION_RESET'});assert.equal(closes,2);assert.equal(pool.status().workers,0);
 await run('child');await run('other');
 await store.clearSession('parent');assert.equal(closes,3);assert.equal(pool.status().workers,1);
 await store.initGoal('parent',{target:'fixture.invalid',objective:'new work'});await run('child');
 const plan=await store.planTargetDeletion('fixture.invalid');await store.deleteTargetData('fixture.invalid',plan);
 assert.equal(closes,4);assert.equal(pool.status().workers,1);assert.equal(starts,5);
});
test('reset blocks admission through cleanup and mutation; stale tickets never revive on errors',async()=>{
 const lifecycle=browserLifecycle({});let release,mutate=false;
 const off=lifecycle.subscribe(()=>new Promise(resolve=>{release=resolve;}));
 const old=lifecycle.ticket('s');const reset=lifecycle.reset(['s'],async()=>{mutate=true;assert.throws(()=>lifecycle.ticket('s'));throw new Error('fixture write failed');});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(mutate,false);assert.throws(old);assert.throws(()=>lifecycle.ticket('s'));release();
 await assert.rejects(reset,/fixture write failed/);assert.throws(old);lifecycle.ticket('s')();off();
});

test('failed approval persistence never exposes an active scan grant',async t=>{
 const {store,start,sent}=await setup(t,{action:'pending'}),manager=await start(),session='failed-decision';
 await store.initGoal(session,{target:'127.0.0.1',objective:'Approval persistence failure'});
 await manager.user.setScope(session,[original]);
 // The advisor defers this exact bounded read to human approval.
 const request={url:original+'/catalog',method:'GET',headers:[['authorization','Bearer fixture']]};
 const task=await manager.propose(session,{entries:[{request,maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:30000,purpose:'Read fixture with explicit credential approval'});
 assert.equal(task.state,'pending');
 const update=store.updateApprovalExecution.bind(store);
 store.updateApprovalExecution=async()=>{throw new Error('fixture persistence unavailable');};
 await assert.rejects(manager.user.decide(session,task.approvalId,'allow'),/fixture persistence unavailable/);
 store.updateApprovalExecution=update;
 await assert.rejects(manager.fetch(session,request.url,{headers:{authorization:'Bearer fixture'}}));
 assert.deepEqual(sent,[]);
});

test('pending audit write cannot be raced into an active grant or a second decision',async t=>{
 const {store,start,sent}=await setup(t,{action:'pending'}),manager=await start(),session='waiting-decision';
 await store.initGoal(session,{target:'127.0.0.1',objective:'Approval write barrier'});await manager.user.setScope(session,[original]);
 const url=original+'/read',task=await manager.propose(session,{entries:[{request:{url,method:'GET'},maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:30000,purpose:'Read fixture'});
 const update=store.updateApprovalExecution.bind(store);let release,entered;
 const waiting=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
 store.updateApprovalExecution=async(...args)=>{entered();await barrier;return update(...args);};
 const decision=manager.user.decide(session,task.approvalId,'allow');
 try{
  await waiting;
  await assert.rejects(manager.fetch(session,url));assert.deepEqual(sent,[]);
  await assert.rejects(manager.user.decide(session,task.approvalId,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});
 }finally{release();}
 await decision;store.updateApprovalExecution=update;
 assert.equal((await manager.fetch(session,url)).status,200);assert.equal(sent.length,1);
});
test('removed approval row cannot activate cached task',async t=>{
 const {store,start,sent}=await setup(t,{action:'pending'}),manager=await start(),session='deleted-decision';
 await store.initGoal(session,{target:'fixture.invalid',objective:'Deleted audit'});await manager.user.setScope(session,[original]);
 const task=await manager.propose(session,{entries:[{request:{url:original+'/read',method:'GET'},maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:30000,purpose:'Read fixture'});
 await store.deleteTargetData('fixture.invalid',await store.planTargetDeletion('fixture.invalid'));
 await assert.rejects(manager.user.decide(session,task.approvalId,'allow'),{code:'SRC_GATE_STALE_APPROVAL'});assert.deepEqual(sent,[]);
});

test('domain deletion removes durable scope and active grants without affecting other sessions',async t=>{
 const {store,start,sent}=await setup(t);let manager=await start();
 for(const session of ['removed','unrelated']){await store.initGoal(session,{target:session+'.invalid',objective:'Read fixture'});await manager.user.setScope(session,[original]);}
 const url=original+'/read';
 const task=await manager.propose('removed',{entries:[{request:{url,method:'GET'},maxRequests:2}],maxRequests:2,minIntervalMs:250,lifetimeMs:30000,purpose:'Read fixture twice'});
 assert.equal(task.state,'active');
 await store.deleteTargetData('removed.invalid',await store.planTargetDeletion('removed.invalid'));
 assert.equal(manager.user.getScope('removed'),undefined);
 assert.ok(manager.user.getScope('unrelated'));
 await assert.rejects(manager.fetch('removed',url));assert.equal(sent.length,0);
 assert.equal((await manager.fetch('unrelated',url)).status,200);
 await manager.close();manager=await start();assert.equal(manager.user.getScope('removed'),undefined);
 await store.initGoal('removed',{target:'removed.invalid',objective:'New explicit engagement'});
 const approval=await pending(manager,'removed',url);await manager.user.decide('removed',approval.approvalId,'allow');
 assert.equal((await manager.fetch('removed',original+'/fresh')).status,200);
});

test('domain deletion cancels late scope and task approvals after their audit write',async t=>{
 for(const kind of ['scope','task']){
  const {store,start,sent}=await setup(t,{action:'pending'}),manager=await start(),session='late-'+kind;
  await store.initGoal(session,{target:session+'.invalid',objective:'Late approval must not revive authority'});
  if(kind==='task')await manager.user.setScope(session,[original]);
  const task=kind==='scope'?await pending(manager,session,original+'/read'):await manager.propose(session,{entries:[{request:{url:original+'/read',method:'GET'},maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:30000,purpose:'Read fixture'});
  const update=store.updateApprovalExecution.bind(store);let release,entered;
  const barrier=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>entered=resolve);
  store.updateApprovalExecution=async(...args)=>{const result=await update(...args);entered();await barrier;return result;};
  const decision=manager.user.decide(session,task.approvalId,'allow');decision.catch(()=>{});
  try{await waiting;await store.deleteTargetData(session+'.invalid',await store.planTargetDeletion(session+'.invalid'));}finally{release();}
  await assert.rejects(decision,{code:'SRC_GATE_BROWSER_SESSION_RESET'});
  assert.equal(manager.user.getScope(session),undefined);assert.deepEqual(sent,[]);
 }
});

test('deletion aborts in-flight target transport and does not report it as never sent',async t=>{
 let started,aborted=false;
 const waiting=new Promise(resolve=>started=resolve);
 const {store,start}=await setup(t,{send:async(_url,{signal})=>new Promise((resolve,reject)=>{
  signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});started();
 })});
 const manager=await start(),session='inflight-delete';
 await store.initGoal(session,{target:'inflight.invalid',objective:'Transport cancellation'});await manager.user.setScope(session,[original]);
 const request=manager.fetch(session,original+'/read');request.catch(()=>{});await waiting;
 await store.deleteTargetData('inflight.invalid',await store.planTargetDeletion('inflight.invalid'));
 await assert.rejects(request,error=>error.code==='SRC_GATE_SESSION_REVOKED'&&error.safeNotSent===false);
 assert.equal(aborted,true);assert.equal(manager.user.getScope(session),undefined);
});
