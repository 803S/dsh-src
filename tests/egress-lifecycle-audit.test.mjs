import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createEgressManager } from '../lib/src/egress/manager.js';
import { dispatchHttp } from '../lib/src/egress/http-dispatch.js';
import { DatabaseSync } from 'node:sqlite';
import { createEgressBroker } from '../lib/src/egress/broker.js';
import { canonicalRequest } from '../lib/src/egress/plan.js';

const low = { fallback:false, mode:'on', action:'allow', effect:'read', risk:'low', confidence:1 };
const digest = text => createHash('sha256').update(text).digest('hex');
const code = name => ({code:`SRC_GATE_${name}`});

async function fixture(t, {assess=()=>low, respond=(_req,res)=>res.end('ok')}={}) {
  const home=await mkdtemp(tmpdir()+'/egress-lifecycle-audit-'),rows=new Map(),arrivals=[],assessments=[];
  const server=createServer((req,res)=>{arrivals.push([req.method,req.url]);respond(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const store={
    async addPendingApproval(sessionId,input){const row={...input,sessionId,id:`approval-${rows.size+1}`,status:'pending'};rows.set(row.id,row);return row;},
    async getPendingApproval(sessionId,id){const row=rows.get(id);return row?.sessionId===sessionId?row:undefined;},
    async updateApprovalExecution(sessionId,id,patch){const row=await this.getPendingApproval(sessionId,id);assert.ok(row);Object.assign(row,patch);},
    async listScopeApprovals(){return [];},
  };
  const open=()=>createEgressManager({home,allowLoopbackFixtures:true,storeFor:async()=>store,
    assess:async plan=>{assessments.push(plan);return assess(plan);},directFetch:dispatchHttp});
  let manager=await open();await manager.user.setScope('s',[origin]);
  t.after(async()=>{await manager.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(home,{recursive:true,force:true});});
  return {get manager(){return manager;},origin,rows,store,arrivals,assessments,home,
    async restart(){await manager.close();manager=await open();},
    check(path='/check'){return {request:{url:origin+path,method:'GET'},status:200,bodySha256:digest('ok')};},
  };
}

test('自动低风险主请求也单独审核附带检查，拒绝危险检查时靶场零到达',async t=>{
  const f=await fixture(t,{assess:plan=>plan.entries.length===1&&plan.entries[0].request.url.endsWith('/check')
    ? {...low,effect:'destructive',risk:'high',action:'pending'} : low});
  await assert.rejects(f.manager.fetch('s',f.origin+'/main',{method:'POST',body:'{}'},
    {egressSafetyPlan:{effect:'compute',precondition:f.check()}}),code('UNSAFE_SAFETY_READ'));
  assert.deepEqual(f.arrivals,[]);
  assert.ok(f.assessments.some(p=>p.entries.length===1&&p.entries[0].request.url.endsWith('/check')));
});

test('主操作断连不封锁已验证的独立检查，原主操作仍禁止重放',async t=>{
  const f=await fixture(t,{assess:plan=>plan.entries.length>1?{...low,risk:'unknown',action:'pending'}:low,
    respond:(req,res)=>req.url==='/main'?req.socket.destroy():res.end('ok')});
  await assert.rejects(f.manager.fetch('s',f.origin+'/main',{method:'POST',body:'{}'},
    {egressSafetyPlan:{effect:'compute',precondition:f.check(),verification:f.check()}}),code('PENDING_OR_REJECTED'));
  const [row]=f.rows.values();
  await assert.rejects(f.manager.user.decide('s',row.id,'allow'));
  assert.equal(row.executionState,'unknown');
  assert.equal(await(await f.manager.fetch('s',f.origin+'/check')).text(),'ok');
  await assert.rejects(f.manager.fetch('s',f.origin+'/main',{method:'POST',body:'{}'}));
  assert.equal(f.arrivals.filter(([,p])=>p==='/main').length,1);
});

test('拒绝持久化后回合取消仍完成拒绝，不留下无法再次处理的待审锁',async t=>{
  const f=await fixture(t,{assess:()=>({...low,action:'pending'})});
  await assert.rejects(f.manager.fetch('s',f.origin+'/main'));
  const [row]=f.rows.values(),controller=new AbortController(),update=f.store.updateApprovalExecution;
  f.store.updateApprovalExecution=async(...args)=>{await update.apply(f.store,args);if(args[2].userDecision==='reject')controller.abort(new Error('fixture cancellation'));};
  await f.manager.user.decide('s',row.id,'reject','',controller.signal);
  await f.restart();
  assert.equal((await f.manager.user.inspect('s',row.id)).state,'denied');
  await assert.rejects(f.manager.fetch('s',f.origin+'/main'),e=>e.state==='denied');
  assert.deepEqual(f.arrivals,[]);
});

test('授权记录已写入但未发送的中断单可以放弃，冷启动后不被迫执行',async t=>{
  const f=await fixture(t,{assess:()=>({...low,action:'pending'})});
  await assert.rejects(f.manager.fetch('s',f.origin+'/main'));
  const [row]=f.rows.values(),controller=new AbortController(),update=f.store.updateApprovalExecution;
  f.store.updateApprovalExecution=async(...args)=>{await update.apply(f.store,args);if(args[2].executionState==='authorized')controller.abort(new Error('fixture cancellation'));};
  await assert.rejects(f.manager.user.decide('s',row.id,'allow','',controller.signal));
  assert.equal(row.executionState,'authorized');
  await f.restart();f.store.updateApprovalExecution=update;
  await f.manager.user.decide('s',row.id,'reject');
  assert.equal(row.status,'rejected');assert.equal((await f.manager.user.inspect('s',row.id)).state,'denied');
  assert.deepEqual(f.arrivals,[]);
});

test('旧版已激活但零发送的人审计划可以拒绝，已有发送记录时不可伪装成未执行',async t=>{
  for(const sent of [false,true]){
    const f=await fixture(t,{assess:()=>({...low,action:'pending'})});
    await assert.rejects(f.manager.fetch('s',f.origin+'/main'));
    const [row]=f.rows.values();await f.manager.close();
    const db=new DatabaseSync(f.home+'/control/src-egress/ledger.sqlite'),id=row.url.slice('src-egress://'.length);
    const task=db.prepare('SELECT manifest FROM gate_tasks WHERE id=?').get(id),manifest=JSON.parse(task.manifest);
    manifest.humanApproved=true;
    db.prepare("UPDATE gate_tasks SET state='active',used=?,manifest=? WHERE id=?").run(sent?1:0,JSON.stringify(manifest),id);db.close();
    Object.assign(row,{status:'approved',userDecision:'allow',executionState:'authorized'});
    await f.restart();
    if(sent)await assert.rejects(f.manager.user.decide('s',row.id,'reject'),code('STALE_APPROVAL'));
    else {await f.manager.user.decide('s',row.id,'reject');assert.equal((await f.manager.user.inspect('s',row.id)).state,'denied');}
    assert.deepEqual(f.arrivals,[]);
  }
});

test('回读自身断连后核对整单能清理该单辅助锁，冷启后重新读取仍可达',async t=>{
  let readbacks=0;
  const f=await fixture(t,{assess:p=>p.entries.length>1?{...low,action:'pending'}:low,
    respond:(req,res)=>req.url==='/check'&&++readbacks===2?req.socket.destroy():res.end('ok')});
  await assert.rejects(f.manager.fetch('s',f.origin+'/main',{method:'POST',body:'{}'},
    {egressSafetyPlan:{effect:'compute',precondition:f.check(),verification:f.check()}}));
  const [row]=f.rows.values();const result=await f.manager.user.decide('s',row.id,'allow');
  assert.equal(result.executionState,'unknown');
  await f.manager.user.reconcile('s',row.id,'confirmed-applied','本机测试记录已核对：主操作到达一次，仅回读连接中断，原操作不重放。');
  await f.restart();
  assert.equal(await(await f.manager.fetch('s',f.origin+'/check')).text(),'ok');
  await assert.rejects(f.manager.fetch('s',f.origin+'/main',{method:'POST',body:'{}'}),code('PENDING_OR_REJECTED'));
  assert.equal(f.arrivals.filter(([,p])=>p==='/main').length,1);
});

test('正常自动计算只审核一次相同检查；检查取消或范围改变均不发包',async t=>{
  for(const mode of ['normal','cancel','scope-change']){
    const controller=new AbortController();let f;
    f=await fixture(t,{assess:async p=>{
      if(p.entries.length===1){
        if(mode==='cancel')controller.abort(new Error('cancel during check'));
        if(mode==='scope-change')await f.manager.user.setScope('s',[f.origin]);
      }
      return low;
    }});
    const run=f.manager.fetch('s',f.origin+'/main',{method:'POST',body:'{}'},
      {signal:controller.signal,egressSafetyPlan:{effect:'compute',precondition:f.check(),verification:f.check()}});
    if(mode==='normal'){
      assert.equal(await(await run).text(),'ok');
      assert.deepEqual(f.arrivals,[['GET','/check'],['POST','/main'],['GET','/check']]);
    }else {await assert.rejects(run);assert.deepEqual(f.arrivals,[]);}
    assert.equal(f.assessments.length,2);
  }
});

test('同一审批的授权写入过程中拒绝不抢跑；取消后仍可明确拒绝',async t=>{
  const f=await fixture(t,{assess:()=>({...low,action:'pending'})});
  await assert.rejects(f.manager.fetch('s',f.origin+'/main'));
  const [row]=f.rows.values(),controller=new AbortController(),update=f.store.updateApprovalExecution;
  let release,entered;const barrier=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  f.store.updateApprovalExecution=async(...args)=>{await update.apply(f.store,args);if(args[2].executionState==='authorized'){entered();await barrier;}};
  const approval=f.manager.user.decide('s',row.id,'allow','',controller.signal);
  await ready;await assert.rejects(f.manager.user.decide('s',row.id,'reject'),code('STALE_APPROVAL'));
  controller.abort();release();await assert.rejects(approval);
  f.store.updateApprovalExecution=update;
  await f.manager.user.decide('s',row.id,'reject');assert.equal(row.status,'rejected');assert.deepEqual(f.arrivals,[]);
});

test('旧自动计划冷启补核验辅助请求，拒绝后不留下无审批编号的死锁',async t=>{
  const f=await fixture(t,{assess:p=>p.entries.length===1&&p.entries[0].request.url.endsWith('/check')?{...low,effect:'destructive',risk:'high',action:'pending'}:low});
  const scope=f.manager.user.getScope('s');await f.manager.close();
  const key=await readFile(f.home+'/control/src-egress/binding-key'),filename=f.home+'/control/src-egress/ledger.sqlite';
  const broker=createEgressBroker({filename,key,scopeFor:()=>scope,assess:async()=>low});
  const request={url:f.origin+'/main',method:'POST',headers:[],bodyBase64:Buffer.from('{}').toString('base64')},check=f.check();
  check.request=canonicalRequest(check.request);
  const task=await broker.propose('s',{entries:[{request:check.request,maxRequests:1},{request,maxRequests:1}],maxRequests:2,minIntervalMs:250,lifetimeMs:30000,purpose:'Legacy unstarted auto plan',hostExecution:{request,safety:{effect:'compute',precondition:check}}});
  broker.close();
  const db=new DatabaseSync(filename),manifest=JSON.parse(db.prepare('SELECT manifest FROM gate_tasks WHERE id=?').get(task.id).manifest);
  delete manifest.automaticSafetyReviewed;
  db.prepare('UPDATE gate_tasks SET manifest=? WHERE id=?').run(JSON.stringify(manifest),task.id);db.close();
  await f.restart();
  await assert.rejects(f.manager.fetch('s',f.origin+'/main',{method:'POST',body:'{}'}),code('UNSAFE_SAFETY_READ'));
  assert.deepEqual(f.arrivals,[]);
  assert.equal(await(await f.manager.fetch('s',f.origin+'/main',{method:'POST',body:'{}'})).text(),'ok');
  assert.deepEqual(f.arrivals,[['POST','/main']]);
});

test('旧版中断的拒绝可重复完成，不能改为批准或重新发送',async t=>{
  const f=await fixture(t,{assess:()=>({...low,action:'pending'})});
  await assert.rejects(f.manager.fetch('s',f.origin+'/main'));
  const [row]=f.rows.values();
  Object.assign(row,{status:'rejected',userDecision:'reject',executionState:'rejected'});
  await f.restart();
  await assert.rejects(f.manager.user.decide('s',row.id,'allow'),code('STALE_APPROVAL'));
  await f.manager.user.decide('s',row.id,'reject');
  assert.equal((await f.manager.user.inspect('s',row.id)).state,'denied');assert.deepEqual(f.arrivals,[]);
});

test('审批审核期间核对旧锁不能抢跑写出相互矛盾的审批结果',async t=>{
  let enter,release,hold=false;const ready=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);
  const f=await fixture(t,{assess:async p=>{
    if(hold&&p.entries.length===1){enter();await barrier;return low;}
    return {...low,action:'pending'};
  }});
  await assert.rejects(f.manager.fetch('s',f.origin+'/main',{method:'POST',body:'{}'},
    {egressSafetyPlan:{effect:'compute',precondition:f.check()}}));
  const [row]=f.rows.values();hold=true;
  const decision=f.manager.user.decide('s',row.id,'allow');await ready;
  try{
    await assert.rejects(f.manager.user.reconcile('s',row.id,'cancel-never-sent','本机测试：此时仍在审批前置检查中，不能同时撤销同一任务。'),code('STALE_APPROVAL'));
  }finally{release();}
  assert.equal((await decision).executionState,'executed');
  assert.equal(row.executionState,'executed');assert.equal(row.status,'approved');
  assert.deepEqual(f.arrivals,[['GET','/check'],['POST','/main']]);
});
