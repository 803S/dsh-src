import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalRequest, normalizePlan, requiresHuman } from '../lib/src/egress/plan.js';
import { createEgressBroker } from '../lib/src/egress/broker.js';
import { constrainSpawnSpec } from '../lib/src/egress/executor.js';
const scope = { origins: ['https://fixture.invalid'], revision: 'user-scope-1', credentialRevision: 'account-1' };
const low = { fallback: false, mode: 'on', action: 'allow', effect: 'read', risk: 'low', confidence: .98 };
const request = (patch = {}) => ({ url: 'https://fixture.invalid/catalog', method: 'GET', headers: [], bodyBase64: '', ...patch });
const input = (patch = {}) => ({ entries: [{ request: request(), maxRequests: 3 }], maxRequests: 3, minIntervalMs: 250, lifetimeMs: 10000, purpose: 'Read fixture catalog', ...patch });
function fixture(t, { assess, file = ':memory:', key = randomBytes(32) } = {}) {
  let clock = 1000, currentScope = structuredClone(scope), calls = 0;
  const broker = createEgressBroker({ filename: file, key, scopeFor: () => currentScope, now: () => clock,
    assess: async (...args) => { calls++; return assess ? assess(...args) : structuredClone(low); } });
  t.after(() => broker.close());
  return { broker, key, calls: () => calls, tick: (ms = 250) => { clock += ms; }, scope: patch => { currentScope = { ...currentScope, ...patch }; } };
}
const code = name => ({ code: `SRC_GATE_${name}` });

test('canonical requests preserve query, body bytes and every semantic header', () => {
  assert.deepEqual(canonicalRequest(request({ headers: [['Host', 'fixture.invalid'], ['Content-Length', '0'], ['X-Test', 'value']] })).headers, [['x-test', 'value']]);
  for (const url of ['https://fixture.invalid', 'https://u:p@fixture.invalid/', 'https://fixture.invalid/a#x', 'https://fixture.invalid/a/../b', 'ftp://fixture.invalid/a']) {
    assert.throws(() => canonicalRequest(request({ url })));
  }
  for (const headers of [[['X-A', '1'], ['x-a', '2']], [['Host', 'other.invalid']], [['Content-Length', '1']], [['Connection', 'close']], [['Transfer-Encoding', 'chunked']], [['Upgrade', 'websocket']], [['X-A', 'a\r\nb']]]) {
    assert.throws(() => canonicalRequest(request({ headers })));
  }
  assert.throws(() => canonicalRequest(request({ bodyBase64: 'YQ==' })), code('READ_BODY'));
  assert.throws(() => canonicalRequest(request({ method: 'CONNECT' })), code('UNSUPPORTED_METHOD'));
  assert.throws(() => canonicalRequest(request({ method: 'POST', bodyBase64: 'YQ' })), code('INVALID_BODY'));
});

test('scope and budgets cannot be widened or default to unlimited', () => {
  for (const patch of [{ maxRequests: 0 }, { maxRequests: 1001 }, { maxRequests: NaN }, { minIntervalMs: 0 }, { lifetimeMs: 900001 }, { purpose: '' }, { wildcard: true }, { entries: [] }]) {
    assert.throws(() => normalizePlan(input(patch), scope, 1000));
  }
  assert.throws(() => normalizePlan(input({ entries: [{ request: request({ url: 'https://fixture.invalid:8443/catalog' }), maxRequests: 1 }] }), scope), code('OUT_OF_SCOPE'));
  assert.throws(() => normalizePlan(input({ entries: [...input().entries, ...input().entries] }), scope), code('DUPLICATE_ENTRY'));
  assert.throws(() => normalizePlan(input(), { ...scope, revision: '' }), code('UNTRUSTED_SCOPE'));
});

for (const patch of [{}, { mode: 'off' }, { mode: 'shadow' }, { fallback: true }, { risk: 'unknown' }, { risk: 'high' }, { effect: 'write' }, { action: 'pending' }, { confidence: .89 }, { confidence: NaN }]) {
  test(`Jev plan decision is conservative: ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t, { assess: () => ({ ...low, ...patch }) });
    const plan = await f.broker.propose('s1', input());
    assert.equal(plan.state, Object.keys(patch).length ? 'pending' : 'active');
  });
}

test('Jev errors become pending; mutation of advisor/input/returned views cannot change a grant', async t => {
  const failed = fixture(t, { assess: () => { throw new Error('timeout'); } });
  assert.equal((await failed.broker.propose('s1', input())).state, 'pending');
  const f = fixture(t, { assess: plan => { plan.entries[0].request.url = 'https://evil.invalid/'; return low; } });
  const original = input();
  const plan = await f.broker.propose('s1', original);
  original.entries[0].request.url = 'https://evil.invalid/';
  const view = f.broker.commandPlane.inspect('s1', plan.id); view.plan.entries.length = 0;
  assert.ok(f.broker.dataPlane.claim('s1', plan.id, request()).dispatchId);
});

for (const patch of [{ url: 'https://fixture.invalid/%64elete?id=1' }, { url: 'https://fixture.invalid/run?operation=reset' }, { method: 'DELETE' }, { method: 'PUT', bodyBase64: Buffer.from('<x/>').toString('base64') }, { method: 'POST' }, { headers: [['Authorization', 'Bearer secret']] }]) {
  test(`hard boundary overrides Jev: ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t);
    const planInput = input({ entries: [{ request: request(patch), maxRequests: 3 }] });
    assert.equal(requiresHuman(normalizePlan(planInput, scope)), true);
    assert.equal((await f.broker.propose('s1', planInput)).state, 'pending');
  });
}

test('one plan assessment, exact checks on every send; no redirected path/body/header inheritance', async t => {
  const f = fixture(t); const task = await f.broker.propose('s1', input());
  for (const patch of [{ url: 'https://fixture.invalid/delete' }, { url: 'https://fixture.invalid/catalog?x=1' }, { method: 'DELETE' }, { headers: [['x-operation', 'delete']] }]) {
    assert.throws(() => f.broker.dataPlane.claim('s1', task.id, request(patch)), code('REQUEST_NOT_APPROVED'));
  }
  assert.throws(() => f.broker.dataPlane.claim('s2', task.id, request()), code('UNKNOWN_TASK'));
  for (let i = 0; i < 3; i++) {
    const claim = f.broker.dataPlane.claim('s1', task.id, request());
    assert.throws(() => f.broker.dataPlane.claim('s1', task.id, request()));
    f.broker.dataPlane.finish('s1', claim.dispatchId, 'response_received'); f.tick();
  }
  assert.throws(() => f.broker.dataPlane.claim('s1', task.id, request()), code('BUDGET_EXHAUSTED'));
  assert.equal(f.calls(), 1);
});

test('rate/concurrency shared across tasks and sessions; failure does not refund budget', async t => {
  const f = fixture(t); const a = await f.broker.propose('s1', input()); const b = await f.broker.propose('s2', input());
  const claim = f.broker.dataPlane.claim('s1', a.id, request());
  assert.throws(() => f.broker.dataPlane.claim('s2', b.id, request()), code('ORIGIN_BUSY'));
  assert.throws(() => f.broker.dataPlane.finish('s2', claim.dispatchId, 'response_received'), code('DISPATCH_NOT_ACTIVE'));
  f.broker.dataPlane.finish('s1', claim.dispatchId, 'response_received');
  assert.throws(() => f.broker.dataPlane.finish('s1', claim.dispatchId, 'response_received'), code('DISPATCH_NOT_ACTIVE'));
  assert.throws(() => f.broker.dataPlane.claim('s2', b.id, request()), code('RATE_LIMIT'));
  f.tick(); assert.ok(f.broker.dataPlane.claim('s2', b.id, request()).dispatchId);
});

test('human decision bound to session + task + immutable digest, one use, no self approval API', async t => {
  const f = fixture(t, { assess: () => ({ ...low, action: 'pending' }) }); const a = await f.broker.propose('s1', input());
  assert.deepEqual(Object.keys(f.broker.dataPlane).sort(), ['claim', 'finish']);
  assert.throws(() => f.broker.dataPlane.claim('s1', a.id, request()), code('TASK_NOT_ACTIVE'));
  assert.throws(() => f.broker.commandPlane.decide('s2', a.id, a.digest, 'allow'), code('UNKNOWN_TASK'));
  assert.throws(() => f.broker.commandPlane.decide('s1', a.id, 'changed', 'allow'), code('STALE_APPROVAL'));
  f.broker.commandPlane.decide('s1', a.id, a.digest, 'allow');
  assert.throws(() => f.broker.commandPlane.decide('s1', a.id, a.digest, 'allow'), code('STALE_APPROVAL'));
  assert.ok(f.broker.dataPlane.claim('s1', a.id, request()).dispatchId);
});

test('human reject cannot be laundered through an existing or new automatic task', async t => {
  let advice = { ...low, action: 'pending' }; const f = fixture(t, { assess: () => advice });
  const a = await f.broker.propose('s1', input());
  advice = low; const b = await f.broker.propose('s1', input());
  assert.equal(b.state,'pending'); // pending resource freezes even otherwise-low-risk plans
  f.broker.commandPlane.decide('s1', a.id, a.digest, 'reject');
  assert.throws(() => f.broker.dataPlane.claim('s1', b.id, request()), code('TASK_NOT_ACTIVE'));
  assert.throws(() => f.broker.commandPlane.decide('s1', b.id, b.digest, 'allow'), code('PREVIOUSLY_DENIED_OR_UNKNOWN'));
  await assert.rejects(f.broker.propose('s1', input()), code('PREVIOUSLY_DENIED_OR_UNKNOWN'));
});

for (const mutation of ['expires', 'scope', 'credentials', 'origins', 'revoke']) {
  test(`authorization invalidation: ${mutation}`, async t => {
    const f = fixture(t); const a = await f.broker.propose('s1', input());
    if (mutation === 'expires') f.tick(10000);
    if (mutation === 'scope') f.scope({ revision: 'next' });
    if (mutation === 'credentials') f.scope({ credentialRevision: 'next' });
    if (mutation === 'origins') f.scope({ origins: [] });
    if (mutation === 'revoke') f.broker.commandPlane.revoke('s1', a.id);
    assert.throws(() => f.broker.dataPlane.claim('s1', a.id, request()));
  });
}

test('scope changes during Jev do not authorize stale plan; cancellation never grants', async t => {
  const f = fixture(t, { assess: () => { f.scope({ revision: 'changed' }); return low; } });
  await assert.rejects(f.broker.propose('s1', input()), code('SCOPE_CHANGED'));
  const g = fixture(t); await assert.rejects(g.broker.propose('s1', input(), { signal: AbortSignal.abort() }));
  assert.equal(g.calls(), 0);
});

test('crash/restart invalidates tasks, preserves uncertain request denial; DB has no secrets', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'src-ledger-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.sqlite'); const key = randomBytes(32);
  const f = fixture(t, { file, key });
  const secretRequest = request({ headers: [['authorization', 'Bearer synthetic-private-secret']] });
  const plan = input({ entries: [{ request: secretRequest, maxRequests: 3 }] });
  const a = await f.broker.propose('s1', plan); f.broker.commandPlane.decide('s1', a.id, a.digest, 'allow');
  f.broker.dataPlane.claim('s1', a.id, secretRequest); f.broker.close();
  assert.equal(readFileSync(file).includes(Buffer.from('synthetic-private-secret')), false);
  const g = fixture(t, { file, key });
  assert.throws(() => g.broker.dataPlane.claim('s1', a.id, secretRequest), code('UNKNOWN_TASK'));
  await assert.rejects(g.broker.propose('s1', plan), code('PREVIOUSLY_DENIED_OR_UNKNOWN'));
});

test('unknown outcome freezes task and blocks same request in later task', async t => {
  const f = fixture(t); const a = await f.broker.propose('s1', input());
  const send = f.broker.dataPlane.claim('s1', a.id, request());
  f.broker.dataPlane.finish('s1', send.dispatchId, 'outcome_unknown');
  assert.throws(() => f.broker.dataPlane.claim('s1', a.id, request()), code('TASK_NOT_ACTIVE'));
  await assert.rejects(f.broker.propose('s1', input()), code('PREVIOUSLY_DENIED_OR_UNKNOWN'));
});

test('full-access final spawn still network-confined; native file profile preserved; unsupported platform fails closed', () => {
  const config = { proxyPort: 18080, protectedPaths: ['/private/tmp/control'], platform: 'darwin' };
  const full = { argv: ['/bin/bash', '-c', 'curl https://fixture.invalid/'], cwd: '/work' };
  const out = constrainSpawnSpec(full, config);
  assert.equal(out.argv[0], '/usr/bin/sandbox-exec'); assert.match(out.argv[2], /deny network/); assert.equal(out.cwd, '/work'); assert.equal(full.argv[0], '/bin/bash');
  const native = constrainSpawnSpec({ argv: ['/usr/bin/sandbox-exec', '-p', '(version 1) (deny file-write*)', '/bin/bash', '-c', 'x'] }, config);
  assert.match(native.argv[2], /deny file-write/); assert.match(native.argv[2], /localhost:18080/);
  assert.throws(() => constrainSpawnSpec(full, { ...config, platform: 'linux' }), code('UNSUPPORTED_PLATFORM'));
  assert.throws(() => constrainSpawnSpec(full, { ...config, protectedPaths: [] }), code('INVALID_PROTECTED_PATHS'));
});

test('human click cannot bypass missing write backup/recovery executor integration', async t => {
  const f = fixture(t); const a = await f.broker.propose('s1', input({ entries: [{ request: request({ method: 'DELETE' }), maxRequests: 3 }] }));
  assert.throws(() => f.broker.commandPlane.decide('s1', a.id, a.digest, 'allow'), code('WRITE_EXECUTOR_REQUIRED'));
  f.broker.commandPlane.decide('s1', a.id, a.digest, 'reject');
});

test('proxy control API binds session/task on server, cannot approve or finish another proxy dispatch', async t => {
  const { createProxyControlServer } = await import('../lib/src/egress/control-server.js');
  const token = randomBytes(32).toString('hex'); let claimed = 0, finished = 0;
  const server = createProxyControlServer({ token, sessionId: 'fixed-session', taskId: 'fixed-task', dataPlane: {
    claim(session, task, value) { assert.equal(session, 'fixed-session'); assert.equal(task, 'fixed-task'); canonicalRequest(value); claimed++; return { dispatchId: 'dispatch-one' }; },
    finish(session, id, outcome) { assert.equal(session, 'fixed-session'); assert.equal(id, 'dispatch-one'); assert.equal(outcome, 'response_received'); finished++; },
  } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, auth = token) => fetch(origin + route, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
  assert.equal((await post('/approve', {})).status, 404);
  assert.equal((await post('/claim', request(), 'bad')).status, 403);
  assert.equal((await post('/claim', { ...request(), sessionId: 'forged' })).status, 403);
  assert.equal((await post('/claim', request())).status, 200);
  assert.equal((await post('/finish', { dispatchId: 'other', outcome: 'response_received' })).status, 403);
  assert.equal((await post('/finish', { dispatchId: 'dispatch-one', outcome: 'response_received' })).status, 200);
  assert.equal((await post('/finish', { dispatchId: 'dispatch-one', outcome: 'response_received' })).status, 403);
  assert.equal(claimed, 1); assert.equal(finished, 1);
});

// Manager seams use only loopback synthetic targets and an in-memory UI store.
import { createEgressManager } from '../lib/src/egress/manager.js';
async function managerFixture(t, {advice=low,home,send}={}) {
  const directory=home??mkdtempSync(path.join(tmpdir(),'egress-manager-'));
  const rows=new Map(); let calls=0, sends=0;
  const store={
    async addPendingApproval(session,row){const value={...row,id:`approval-${rows.size+1}`,session};rows.set(value.id,value);return value;},
    async getPendingApproval(session,id){const row=rows.get(id);return row?.session===session?row:undefined;},
    async updateApprovalExecution(session,id,patch){const row=await this.getPendingApproval(session,id);assert.ok(row);Object.assign(row,patch);},
  };
  const manager=await createEgressManager({home:directory,allowLoopbackFixtures:true,storeFor:async()=>store,
    assess:async()=>{calls++;return advice;},directFetch:async(...args)=>{sends++;return send?send(...args):new Response('synthetic',{status:200});}});
  t.after(async()=>{await manager.close();if(!home)rmSync(directory,{recursive:true,force:true});});
  await manager.user.setScope('s',['http://127.0.0.1:49123']);
  return {manager,store,rows,home:directory,calls:()=>calls,sends:()=>sends};
}

test('manager low read sends once; spent grant never triggers reassessment/replay',async t=>{
  const f=await managerFixture(t);
  assert.equal((await f.manager.fetch('s','http://127.0.0.1:49123/catalog')).status,200);
  await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'),code('BUDGET_EXHAUSTED'));
  assert.equal(f.calls(),1);assert.equal(f.sends(),1);
});
test('manager human single read executes frozen bytes once; rejects model replay',async t=>{
  const f=await managerFixture(t,{advice:{...low,action:'pending'}});
  await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'),code('PENDING_OR_REJECTED'));
  const [row]=f.rows.values();
  assert.equal((await f.manager.user.inspect('s',row.id)).state,'pending');
  assert.equal((await f.manager.user.decide('s',row.id,'allow')).executionState,'executed');
  assert.equal(f.calls(),1);assert.equal(f.sends(),1);
  await assert.rejects(f.manager.user.decide('s',row.id,'allow'),code('STALE_APPROVAL'));
  await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'));
  assert.equal(f.sends(),1);
});
test('manager dangerous single cannot be clicked through without safety; supersession never reassesses',async t=>{
  const f=await managerFixture(t);
  await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/compute',{method:'POST',body:'x'}),code('PENDING_OR_REJECTED'));
  const [row]=f.rows.values();
  await assert.rejects(f.manager.user.decide('s',row.id,'allow'),code('SAFETY_PLAN_REQUIRED'));
  assert.equal(f.sends(),0);
  const task=await f.manager.preparePending('s',row.id,{effect:'compute',object:'synthetic non-persistent compute',recovery:'no external state change'});
  assert.notEqual(task.approvalId,row.id);assert.equal(f.calls(),1);
  await assert.rejects(f.manager.user.decide('s',row.id,'allow'),code('STALE_APPROVAL'));
  assert.equal((await f.manager.user.decide('s',task.approvalId,'allow')).executionState,'executed');
  assert.equal(f.sends(),1);
});
test('manager scope changes invalidate pending execution but review remains actionable',async t=>{
  const f=await managerFixture(t,{advice:{...low,action:'pending'}});
  await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'));
  const [row]=f.rows.values();
  await f.manager.user.setScope('s',['http://127.0.0.1:49124']);
  assert.equal((await f.manager.user.inspect('s',row.id)).state,'stale');
  await assert.rejects(f.manager.user.decide('s',row.id,'allow'),code('SCOPE_CHANGED'));
  assert.equal(f.sends(),0);
});
test('manager shutdown during assessment publishes no approval and sends nothing',async t=>{
  let resolveAdvice;
  const waiting=new Promise(resolve=>{resolveAdvice=resolve;});
  const f=await managerFixture(t,{advice:waiting});
  const request=f.manager.fetch('s','http://127.0.0.1:49123/catalog');
  const rejected=assert.rejects(request,code('CLOSED'));
  await new Promise(resolve=>setImmediate(resolve));
  const closing=f.manager.close();resolveAdvice(low);
  await closing;await rejected;assert.equal(f.rows.size,0);assert.equal(f.sends(),0);
});

import { createSrcStore } from '../lib/src/store.js';
test('host/child shared store closes only after last owner; later owner reopens',async()=>{
  const sharedDomainOpens=new Map();let opens=0,closes=0;
  const Store=createSrcStore({srcDomainSpec:{name:'src'},sharedDomainOpens,LEGACY_KEY_MIGRATION_TABLES:[]});
  const ctx={storageDomain:{open:async()=>{opens++;return {close:async()=>{closes++;}};}}};
  const host=new Store(ctx),child=new Store(ctx);
  assert.equal(await host.domain(),await child.domain());
  await child.dispose();assert.equal(closes,0);assert.equal(opens,1);
  assert.ok(await host.domain());await host.dispose();assert.equal(closes,1);
  const next=new Store(ctx);await next.domain();assert.equal(opens,2);await next.dispose();assert.equal(closes,2);
});
test('hazardous GET cannot become a scan grant through human batch approval',async t=>{
  const f=fixture(t);
  const task=await f.broker.propose('s1',input({maxRequests:1,entries:[{request:request({url:'https://fixture.invalid/delete?id=1'}),maxRequests:1}]}));
  assert.equal(task.state,'pending');
  assert.throws(()=>f.broker.commandPlane.decide('s1',task.id,task.digest,'allow'),code('WRITE_EXECUTOR_REQUIRED'));
});

test('local file adapter confinement opens no network port and needs no TLS proxy',()=>{
  const result=constrainSpawnSpec({argv:['/usr/bin/python3','-c','print(1)']},{denyNetwork:true,protectedPaths:['/private/tmp/synthetic-control']});
  assert.match(result.argv[2],/\(deny network\*\)/);
  assert.doesNotMatch(result.argv[2],/allow network-outbound/);
});

test('proxy idle eligibility preserves unspent live tasks but not exhausted or expired leases',async t=>{
  const f=fixture(t);assert.equal(f.broker.hasActiveTasks('s1'),false);
  const task=await f.broker.propose('s1',input({maxRequests:1,entries:[{request:request(),maxRequests:1}]}));
  assert.equal(f.broker.hasActiveTasks('s1'),true);
  const grant=f.broker.dataPlane.claim('s1',task.id,request());
  assert.equal(f.broker.hasActiveTasks('s1'),false);
  f.broker.dataPlane.finish('s1',grant.dispatchId,'response_received');
  const next=await f.broker.propose('s1',input());assert.equal(next.state,'active');
  f.tick(10000);assert.equal(f.broker.hasActiveTasks('s1'),false);
});

test('cold restart invalidates approval; reconciliation cannot restore automatic authority',async t=>{
 const f=await managerFixture(t,{advice:{...low,action:'pending'}});
 const url='http://127.0.0.1:49123/catalog';
 await assert.rejects(f.manager.fetch('s',url));
 const [old]=f.rows.values();await f.manager.close();
 let sends=0;
 const manager=await createEgressManager({home:f.home,allowLoopbackFixtures:true,storeFor:async()=>f.store,assess:async()=>low,directFetch:async()=>{sends++;return new Response('ok');}});
 try{
  assert.equal((await manager.user.inspect('s',old.id)).state,'stale');
  await assert.rejects(manager.user.decide('s',old.id,'allow'),code('STALE_APPROVAL'));
  const reconciled=await manager.user.reconcile('s',old.id,'cancel-never-sent','Fixture operator checked target logs: this request was never sent.');
  assert.equal(reconciled.requiresFreshHumanApproval,true);
  await assert.rejects(manager.fetch('s',url),code('PENDING_OR_REJECTED'));
  const fresh=[...f.rows.values()].at(-1);assert.notEqual(fresh.id,old.id);assert.equal(sends,0);
  await manager.user.decide('s',fresh.id,'allow');assert.equal(sends,1);
 }finally{await manager.close();}
});
test('uncertain host execution is one-shot; user reconciliation requires evidence and fresh approval',async t=>{
 let fail=true;
 const f=await managerFixture(t,{advice:{...low,action:'pending'},send:async()=>{if(fail)throw new Error('synthetic connection reset after dispatch');return new Response('ok');}});
 const url='http://127.0.0.1:49123/catalog';
 await assert.rejects(f.manager.fetch('s',url));const [old]=f.rows.values();
 await assert.rejects(f.manager.user.decide('s',old.id,'allow'));
 assert.equal(old.executionState,'unknown');assert.equal(f.sends(),1);
 await assert.rejects(f.manager.fetch('s',url));assert.equal(f.sends(),1);
 await assert.rejects(f.manager.user.reconcile('s',old.id,'cancel-never-sent','Fixture operator cannot establish that dispatch did not reach target.'),code('REQUEST_MAY_HAVE_BEEN_SENT'));
 await assert.rejects(f.manager.user.reconcile('s',old.id,'confirmed-not-applied','guess'),code('RECONCILIATION_EVIDENCE_REQUIRED'));
 await f.manager.user.reconcile('s',old.id,'confirmed-not-applied','Fixture operator verified the target log and state; no change was applied.');
 fail=false;await assert.rejects(f.manager.fetch('s',url),code('PENDING_OR_REJECTED'));
 const fresh=[...f.rows.values()].at(-1);assert.equal(f.sends(),1);
 await f.manager.user.decide('s',fresh.id,'allow');assert.equal(f.sends(),2);
});

test('expired unused active task can be reconciled without reviving its grant',async t=>{
 const f=fixture(t);const task=await f.broker.propose('s1',input());
 f.tick(10000);
 assert.throws(()=>f.broker.dataPlane.claim('s1',task.id,request()),code('EXPIRED'));
 const result=f.broker.commandPlane.reconcile('s1',task.id,'cancel-never-sent','Operator verified this expired fixture task did not send any request.');
 assert.equal(result.requiresFreshHumanApproval,true);
 assert.equal((await f.broker.propose('s1',input())).state,'pending');
});

import {isPublicAddress} from '../lib/src/egress/scope.js';
test('IPv6 scope rejects special/tunnel/documentation ranges including expanded notation',()=>{
 for(const ip of ['::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:0000:1::1','2001:20::1','2001:db8::1','2002:7f00:1::1','3ffe::1','3fff::1'])assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(isPublicAddress(ip),true,ip);
});
