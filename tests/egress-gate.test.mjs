import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalRequest, normalizePlan, requiresHuman } from '../lib/src/egress/plan.js';
import { createEgressBroker } from '../lib/src/egress/broker.js';
import { createAssessmentQueue } from '../lib/src/egress/assessment-queue.js';
import { constrainSpawnSpec } from '../lib/src/egress/executor.js';
import {execFileSync} from 'node:child_process';
test('proxy strips only benign single-hop persistence headers before both claim and send',()=>{
  execFileSync('python3',[new URL('./egress-hop-headers.py',import.meta.url).pathname],{timeout:10000});
});
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

test('低风险只读资源名不被upload、mail、pay关键词一票否决',async t=>{
 const f=fixture(t);
 for(const pathname of ['/uploads/logo.png','/mail/list','/api/payments/history']){
  const req=request({url:'https://fixture.invalid'+pathname});
  const task=await f.broker.propose('paths',input({entries:[{request:req,maxRequests:1}],maxRequests:1}));
  assert.equal(task.state,'active');const sent=f.broker.dataPlane.claim('paths',task.id,req);f.broker.dataPlane.finish('paths',sent.dispatchId,'response_received');f.tick();
 }
});

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

for (const patch of [{}, { mode: 'off' }, { mode: 'shadow' }, { fallback: true }, { risk: 'unknown' }, { risk: 'high' }, { effect: 'write' }, { action: 'pending' }, { confidence: -1 }, { confidence: 1.1 }, { confidence: NaN }]) {
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

for (const patch of [{ url: 'https://fixture.invalid/%64elete?id=1' }, { url: 'https://fixture.invalid/run?operation=reset' }, { method: 'DELETE' }, { method: 'PUT', bodyBase64: Buffer.from('<x/>').toString('base64') }, { method: 'POST', url:'https://fixture.invalid/delete' }]) {
  test(`危险请求真实语义交Jev，高危不自动放行: ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t,{assess:()=>({...low,effect:'destructive',risk:'high',action:'pending'})});
    const planInput = input({ entries: [{ request: request(patch), maxRequests: 3 }] });
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

test('后来挂审的精确请求立即阻断既有扫描授权，不连带阻断独立读取', async t => {
  let advice = low;
  const f = fixture(t, { assess: () => advice });
  const older = await f.broker.propose('s1', input());
  advice = { ...low, action: 'pending', risk: 'unknown' };
  const pending = await f.broker.propose('s1', input());
  assert.equal(pending.state, 'pending');
  assert.throws(() => f.broker.dataPlane.claim('s1', older.id, request()), code('REQUEST_PENDING'));
  assert.equal(f.broker.commandPlane.history('s1', older.id).used, 0);
  advice = low;
  const independentRequest = request({ url: 'https://fixture.invalid/independent' });
  const independent = await f.broker.propose('s1', input({ entries: [{ request: independentRequest, maxRequests: 3 }] }));
  const claim = f.broker.dataPlane.claim('s1', independent.id, independentRequest);
  f.broker.dataPlane.finish('s1', claim.dispatchId, 'response_received');
  f.tick();
  f.broker.commandPlane.decide('s1', pending.id, pending.digest, 'allow');
  assert.ok(f.broker.dataPlane.claim('s1', pending.id, request()).dispatchId);
});

test('撤回拒绝只解除旧锁，不能复活此前人工批准的同请求扫描额度', async t => {
  let advice = { ...low, action: 'pending' };
  const f = fixture(t, { assess: () => advice });
  const old = await f.broker.propose('s1', input());
  f.broker.commandPlane.decide('s1', old.id, old.digest, 'allow');
  const newer = await f.broker.propose('s1', input());
  f.broker.commandPlane.decide('s1', newer.id, newer.digest, 'reject');
  f.broker.commandPlane.reconcile('s1', newer.id, 'withdraw-rejection', '已由测试用户核对：原请求未发送；只撤回拒绝，不恢复任何旧额度。');
  assert.throws(() => f.broker.dataPlane.claim('s1', old.id, request()), code('RESOURCE_REQUIRES_REVIEW'));
  advice = low;
  const fresh = await f.broker.propose('s1', input());
  assert.equal(fresh.state, 'pending');
  f.broker.commandPlane.decide('s1', fresh.id, fresh.digest, 'allow');
  assert.ok(f.broker.dataPlane.claim('s1', fresh.id, request()).dispatchId);
});

for (const effect of ['read', 'compute']) test(`同路径写入待审不误拦Jev已确认的独立POST ${effect}`, async t => {
  let advice = low;
  const f = fixture(t, { assess: () => advice });
  const deletion = request({ method: 'DELETE' });
  assert.equal((await f.broker.propose('s1', input({ entries: [{ request: deletion, maxRequests: 3 }] }))).state, 'pending');
  advice = { ...low, effect };
  const computation = request({ method: 'POST', bodyBase64: Buffer.from('{"template":"{{7*7}}"}').toString('base64') });
  const task = await f.broker.propose('s1', input({ entries: [{ request: computation, maxRequests: 3 }] }));
  assert.equal(task.state, 'active');
  assert.ok(f.broker.dataPlane.claim('s1', task.id, computation).dispatchId);
});

for (const mutation of ['expires', 'scope', 'credentials', 'origins', 'revoke']) {
  test(`authorization invalidation: ${mutation}`, async t => {
    const f = fixture(t); const a = await f.broker.propose('s1', input());
    if (mutation === 'expires') { f.broker.startToolTask('s1',a.id,input()); f.tick(10000); }
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

test('crash/restart preserves uncertain request denial; encrypted DB has no secrets', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'src-ledger-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.sqlite'); const key = randomBytes(32);
  const f = fixture(t, { file, key });
  const secretRequest = request({ headers: [['authorization', 'Bearer synthetic-private-secret']] });
  const plan = input({ entries: [{ request: secretRequest, maxRequests: 3 }] });
  const a = await f.broker.propose('s1', plan); assert.equal(a.state,'active');
  f.broker.dataPlane.claim('s1', a.id, secretRequest); f.broker.close();
  assert.equal(readFileSync(file).includes(Buffer.from('synthetic-private-secret')), false);
  const g = fixture(t, { file, key });
  assert.throws(() => g.broker.dataPlane.claim('s1', a.id, secretRequest), code('TASK_NOT_ACTIVE'));
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

test('native basename sandbox runner merges policies without nesting or PATH lookup', () => {
  const native='(version 1) (allow default) (deny file-write* (subpath "/tmp/fixture-read-only"))';
  const out=constrainSpawnSpec({argv:['sandbox-exec','-p',native,'/bin/bash','-c','true']}, {proxyPort:18080,protectedPaths:['/private/tmp/fixture-control']});
  assert.equal(out.argv[0],'/usr/bin/sandbox-exec');
  assert.ok(out.argv[2].startsWith(native));
  assert.match(out.argv[2],/deny network/);
  assert.deepEqual(out.argv.slice(3),['/bin/bash','-c','true']);
  assert.throws(()=>constrainSpawnSpec({argv:['sandbox-exec','-f','profile','true']},{proxyPort:18080,protectedPaths:['/private/tmp/fixture-control']}),{code:'SRC_GATE_UNKNOWN_SANDBOX_PROFILE'});
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
    async addPendingApproval(session,row){const value={...row,status:'pending',id:`approval-${rows.size+1}`,session};rows.set(value.id,value);return value;},
    async getPendingApproval(session,id){const row=rows.get(id);return row?.session===session?row:undefined;},
    async updateApprovalExecution(session,id,patch){const row=await this.getPendingApproval(session,id);assert.ok(row);Object.assign(row,patch);},
  };
  const manager=await createEgressManager({home:directory,allowLoopbackFixtures:true,storeFor:async()=>store,
    assess:async(plan)=>{calls++;return typeof advice==='function'?advice(plan):advice;},directFetch:async(...args)=>{sends++;return send?send(...args):new Response('synthetic',{status:200});}});
  t.after(async()=>{await manager.close();if(!home)rmSync(directory,{recursive:true,force:true});});
  await manager.user.setScope('s',['http://127.0.0.1:49123']);
  return {manager,store,rows,home:directory,calls:()=>calls,sends:()=>sends};
}

test('Jev识别写入/删除/外发后，自报读取或计算不能批准，也不能先记成已授权',async t=>{
 for(const effect of ['write','destructive','external'])for(const claimed of ['read','compute']){
  const f=await managerFixture(t,{advice:{...low,effect,risk:'high',action:'pending'}});
  await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/operation',{method:'POST',body:'{"all":true}'},{egressSafetyPlan:{effect:claimed,object:'不能由目的说明证明安全'}}),code('PENDING_OR_REJECTED'));
  const [row]=f.rows.values(),before=structuredClone(row);
  await assert.rejects(f.manager.user.decide('s',row.id,'allow'),code('SAFETY_EFFECT_CONTRADICTION'));
  assert.deepEqual(row,before);assert.equal(row.status,'pending');assert.equal(row.userDecision,undefined);assert.equal(f.sends(),0);
  await assert.rejects(f.manager.preparePending('s',row.id,{effect:claimed,object:'补料不能降级影响'}),code('SAFETY_EFFECT_CONTRADICTION'));
  assert.equal(f.rows.size,1);
  await f.manager.user.decide('s',row.id,'reject');assert.equal(row.status,'rejected');
 }
});

test('重启后未发出的高危授权单仍检查安全说明，pending/active均不能绕过',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 for(const state of ['pending','active']){
  const f=await managerFixture(t,{advice:{...low,effect:'destructive',risk:'high',action:'pending'}});
  await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/operation',{method:'POST',body:'{"all":true}'},{egressSafetyPlan:{effect:'compute'}}));
  const [row]=f.rows.values();await f.manager.close();
  const db=new DatabaseSync(path.join(f.home,'control/src-egress/ledger.sqlite'));
  db.prepare('UPDATE gate_tasks SET state=? WHERE id=?').run(state,row.url.slice('src-egress://'.length));db.close();
  Object.assign(row,{status:'approved',userDecision:'allow',executionState:'authorized'});
  let sends=0;const next=await createEgressManager({home:f.home,allowLoopbackFixtures:true,storeFor:async()=>f.store,directFetch:async()=>{sends++;return new Response('must not send');}});
  try {await assert.rejects(next.user.decide('s',row.id,'allow'),code('SAFETY_EFFECT_CONTRADICTION'));assert.equal(sends,0);}
  finally {await next.close();}
 }
});

test('未知影响单提示人类核对原包，不要求读取/计算虚构安全材料',async t=>{
 const f=await managerFixture(t,{advice:{...low,effect:'unknown',risk:'unknown',action:'pending'}});
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/render',{method:'POST',body:'{}'}),error=>{
  assert.equal(error.reason,'human-impact-confirmation-required');assert.doesNotMatch(error.nextAction,/src_egress_prepare/);return true;
 });
 assert.equal(f.sends(),0);const [row]=f.rows.values();
 assert.equal((await f.manager.user.decide('s',row.id,'allow-read')).executionState,'executed');assert.equal(f.sends(),1);
});

test('主操作发出后证据失败：异常和审批都报告结果未知，禁止重放',async t=>{
 const {gateError}=await import('../lib/src/egress/plan.js');
 const f=await managerFixture(t,{advice:{...low,effect:'compute',risk:'unknown',action:'pending'},send:async()=>{throw gateError('RESPONSE_TOO_LARGE');}});
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/render',{method:'POST',body:'{}'}));
 const [row]=f.rows.values();
 await assert.rejects(f.manager.user.decide('s',row.id,'allow'),error=>error.code==='SRC_GATE_RESPONSE_TOO_LARGE'&&error.safeNotSent===false);
 assert.equal(row.executionState,'unknown');assert.equal(f.sends(),1);
 await assert.rejects(f.manager.user.decide('s',row.id,'allow'));assert.equal(f.sends(),1);
});

test('manager new implicit read gets a fresh assessment after success, never automatic replay',async t=>{
  const f=await managerFixture(t);
  assert.equal((await f.manager.fetch('s','http://127.0.0.1:49123/catalog')).status,200);
  assert.equal(f.calls(),1);assert.equal(f.sends(),1);
  assert.equal((await f.manager.fetch('s','http://127.0.0.1:49123/catalog')).status,200);
  assert.equal(f.calls(),2);assert.equal(f.sends(),2);
});

test('单笔POST纯计算由Jev自动放行，安全说明不强制转人工且实际正文不丢失',async t=>{
 const sent=[],advice={...low,effect:'compute'};
 const f=await managerFixture(t,{advice,send:async(url,init)=>{sent.push({url,body:init.body});return new Response('49');}});
 const body=JSON.stringify({template:'{{7*7}}'}),url='http://127.0.0.1:49123/render';
 for(const exec of [{},{egressSafetyPlan:{effect:'compute',object:'有界算术渲染',recovery:'无业务持久化副作用'}}]){
  const response=await f.manager.fetch('s',url,{method:'POST',headers:{'content-type':'application/json'},body},exec);
  assert.equal(await response.text(),'49');
 }
 assert.equal(f.rows.size,0);assert.equal(f.calls(),2);assert.deepEqual(sent,[{url,body},{url,body}]);
});

test('低风险计算判定不能覆盖真实删除方法、危险路径或语义不明',async t=>{
 for(const [patch,advice] of [[{method:'DELETE'},{...low,effect:'compute'}],[{method:'POST',path:'/delete'},{...low,effect:'destructive',risk:'high'}],[{method:'POST'},{...low,effect:'unknown',risk:'unknown',action:'pending'}]]){
  const f=await managerFixture(t,{advice});
  await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123'+(patch.path??'/render'),{method:patch.method,body:'{"template":"{{7*7}}"}'}),code('PENDING_OR_REJECTED'));
  assert.equal(f.sends(),0);assert.equal(f.rows.size,1);
 }
});
test('explicit single-request plan stays exhausted and does not become an implicit renewed grant',async t=>{
 const f=await managerFixture(t),url='http://127.0.0.1:49123/catalog';
 await f.manager.propose('s',{entries:[{request:{url,method:'GET'},maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:300000,purpose:'explicit finite scan'});
 await f.manager.fetch('s',url);
 await assert.rejects(f.manager.fetch('s',url),code('BUDGET_EXHAUSTED'));
 assert.equal(f.calls(),1);assert.equal(f.sends(),1);
});
test('implicit read with uncertain transport outcome cannot be reassessed and silently replayed',async t=>{
 const f=await managerFixture(t,{send:async()=>{throw new Error('synthetic connection lost after dispatch');}});
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'),/synthetic connection lost/);
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'));
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
test('manager unknown single cannot be clicked through without safety; supersession never reassesses',async t=>{
  const f=await managerFixture(t,{advice:{...low,effect:'unknown',action:'pending'}});
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
  const f=fixture(t,{assess:()=>({...low,effect:'destructive',risk:'high',action:'pending'})});
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
  f.tick(30*86400000);assert.equal(f.broker.hasActiveTasks('s1'),true);
  f.broker.startToolTask('s1',next.id,input());f.tick(10000);assert.equal(f.broker.hasActiveTasks('s1'),false);
});

test('人工待审跨三十天与重启保留原编号及冻结请求，人工批准只执行一次',async t=>{
 let clock=Date.now();
 const f=await managerFixture(t,{advice:{...low,action:'pending'}});
 const url='http://127.0.0.1:49123/catalog';
 await assert.rejects(f.manager.fetch('s',url));
 const [old]=f.rows.values();await f.manager.close();clock+=30*86400000;
 let sends=0;
 const manager=await createEgressManager({home:f.home,now:()=>clock,allowLoopbackFixtures:true,storeFor:async()=>f.store,assess:async()=>low,directFetch:async sent=>{assert.equal(sent,url);sends++;return new Response('ok');}});
 try{
  const view=await manager.user.inspect('s',old.id);
  assert.equal(view.state,'pending');assert.equal(view.expires,null);
  await assert.rejects(manager.fetch('s',url),e=>e.approvalId===old.id);
  assert.equal(f.rows.size,1);assert.equal(sends,0);
  await manager.user.decide('s',old.id,'allow');assert.equal(sends,1);
  await assert.rejects(manager.user.decide('s',old.id,'allow'));assert.equal(sends,1);
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

test('已开始但未发包的工具执行窗口到期可核对撤销，不续期授权',async t=>{
 const f=fixture(t);const task=await f.broker.propose('s1',input());
 f.broker.startToolTask('s1',task.id,input());f.tick(10000);
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

test('native tool resume uses approved frozen plan once without new review or expiry renewal',async t=>{
 const f=fixture(t,{assess:()=>({...low,action:'pending'})}),body=input(),plan=await f.broker.propose('tool-resume',body);
 assert.throws(()=>f.broker.startToolTask('tool-resume',plan.id,body),code('TASK_NOT_AUTHORIZED'));
 f.broker.commandPlane.decide('tool-resume',plan.id,plan.digest,'allow');
 assert.throws(()=>f.broker.startToolTask('other-session',plan.id,body),code('UNKNOWN_TASK'));
 for(const patch of [{minIntervalMs:500},{maxRequests:2},{entries:[{request:request({url:'https://fixture.invalid/other'}),maxRequests:3}]}])assert.throws(()=>f.broker.startToolTask('tool-resume',plan.id,{...body,...patch}),code('PLAN_CHANGED'));
 f.tick(1000);
 const resumed=f.broker.startToolTask('tool-resume',plan.id,body);
 assert.equal(plan.expiresAt,null);assert.equal(resumed.expiresAt,12000);assert.equal(f.calls(),1);
 assert.throws(()=>f.broker.startToolTask('tool-resume',plan.id,body),code('TOOL_TASK_ALREADY_STARTED'));
 const grant=f.broker.dataPlane.claim('tool-resume',plan.id,request());
 f.broker.dataPlane.finish('tool-resume',grant.dispatchId,'response_received');
 assert.equal(f.calls(),1);
});
test('native tool cannot resume rejected, expired, scope-changed or already-used plans',async t=>{
 for(const state of ['rejected','expired','scope-changed','used']){
  const f=fixture(t),body=input(),plan=await f.broker.propose('tool-'+state,body);
  if(state==='rejected')f.broker.commandPlane.revoke('tool-'+state,plan.id);
  if(state==='expired'){f.broker.startToolTask('tool-'+state,plan.id,body);f.tick(10001);}
  if(state==='scope-changed')f.scope({revision:'new-scope'});
  if(state==='used'){const grant=f.broker.dataPlane.claim('tool-'+state,plan.id,request());f.broker.dataPlane.finish('tool-'+state,grant.dispatchId,'response_received');}
  assert.throws(()=>f.broker.startToolTask('tool-'+state,plan.id,body),code({'rejected':'TASK_NOT_AUTHORIZED','expired':'TOOL_TASK_ALREADY_STARTED','scope-changed':'SCOPE_CHANGED','used':'TOOL_TASK_ALREADY_STARTED'}[state]));
 }
});

test('completed native scan retires unused branches without renewing grants or blocking a fresh read',async t=>{
 const f=fixture(t),body=input(),plan=await f.broker.propose('tool-close',body);
 f.broker.startToolTask('tool-close',plan.id,body);
 const grant=f.broker.dataPlane.claim('tool-close',plan.id,request());
 assert.throws(()=>f.broker.completeToolTask('tool-close',plan.id),code('DISPATCH_STILL_ACTIVE'));
 f.broker.dataPlane.finish('tool-close',grant.dispatchId,'response_received');
 assert.equal(f.broker.completeToolTask('tool-close',plan.id).state,'completed_tool');
 assert.equal(f.broker.hasActiveTasks('tool-close'),false);assert.equal(f.broker.find('tool-close',request()),undefined);
 assert.throws(()=>f.broker.startToolTask('tool-close',plan.id,body),code('UNKNOWN_TASK'));
 assert.throws(()=>f.broker.dataPlane.claim('tool-close',plan.id,request()),code('UNKNOWN_TASK'));
 const fresh=await f.broker.propose('tool-close',input({maxRequests:1,entries:[{request:request(),maxRequests:1}]}));
 assert.notEqual(fresh.id,plan.id);assert.equal(f.calls(),2);
});
test('native scan cleanup never clears an unknown outcome or another session task',async t=>{
 const f=fixture(t),body=input(),plan=await f.broker.propose('tool-unknown',body);
 f.broker.startToolTask('tool-unknown',plan.id,body);
 assert.throws(()=>f.broker.completeToolTask('other-session',plan.id),code('UNKNOWN_TASK'));
 const grant=f.broker.dataPlane.claim('tool-unknown',plan.id,request());
 f.broker.dataPlane.finish('tool-unknown',grant.dispatchId,'outcome_unknown');
 assert.equal(f.broker.completeToolTask('tool-unknown',plan.id).state,'revoked');
 assert.equal(f.broker.find('tool-unknown',request()).state,'revoked');
 await assert.rejects(f.broker.propose('tool-unknown',body),code('PREVIOUSLY_DENIED_OR_UNKNOWN'));
});

test('ordinary parallel requests queue behind four Jev evaluations instead of failing the fifth',async t=>{
 let active=0,peak=0,release;const held=new Promise(resolve=>release=resolve);
 const f=fixture(t,{assess:async()=>{active++;peak=Math.max(peak,active);await held;active--;return low;}});
 const work=Promise.allSettled(Array.from({length:8},(_,i)=>f.broker.propose('burst',input({entries:[{request:request({url:`https://fixture.invalid/read/${i}`}),maxRequests:1}],maxRequests:1}))));
 await new Promise(resolve=>setImmediate(resolve));release();const results=await work;
 assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.state==='active').length,8,JSON.stringify(results));
 assert.equal(peak,4);
});

test('assessment queue is bounded, cancellable, FIFO and closes without stranding waiters',async()=>{
 const queue=createAssessmentQueue({parallel:1,maxQueued:2}),first=await queue.acquire();
 const abort=new AbortController(),cancelled=queue.acquire(abort.signal);const rejected=assert.rejects(cancelled,/fixture abort/);
 const second=queue.acquire();await assert.rejects(queue.acquire(),code('ASSESSMENT_CAPACITY'));
 abort.abort(new Error('fixture abort'));await rejected;
 assert.deepEqual(queue.status(),{active:1,queued:1,closed:false});
 first();first();const release=await second;assert.equal(queue.status().active,1);
 const waiting=queue.acquire();const closing=assert.rejects(waiting,code('CLOSED'));queue.close();await closing;
 release();assert.deepEqual(queue.status(),{active:0,queued:0,closed:true});await assert.rejects(queue.acquire(),code('CLOSED'));
});

test('排队审核仍检查实际范围变更，但等待不消耗执行窗口',async t=>{
 for(const mode of ['scope','expiry']){
  let release;const held=new Promise(resolve=>release=resolve);const f=fixture(t,{assess:async()=>{await held;return low;}});
  const work=Promise.allSettled(Array.from({length:5},(_,i)=>f.broker.propose('s'+i,input())));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls(),4);
  if(mode==='scope')f.scope({revision:'changed'});else f.tick(20000);
  release();const result=await work;assert.ok(result.every(r=>r.status===(mode==='scope'?'rejected':'fulfilled')));assert.equal(f.calls(),mode==='scope'?4:5);
 }
});

test('queued plans stay frozen, destructive requests remain pending and cancellation grants nothing',async t=>{
 let release;const held=new Promise(resolve=>release=resolve);const f=fixture(t,{assess:async()=>{await held;return low;}});
 const starts=Array.from({length:4},(_,i)=>f.broker.propose('s'+i,input()));
 const frozen=input({entries:[{request:request({url:'https://fixture.invalid/queued'}),maxRequests:1}],maxRequests:1});
 const queued=f.broker.propose('queued',frozen);frozen.entries[0].request.url='https://fixture.invalid/delete';
 const danger=f.broker.propose('danger',input({entries:[{request:request({method:'DELETE'}),maxRequests:1}],maxRequests:1}));
 const abort=new AbortController();const cancelled=assert.rejects(f.broker.propose('cancelled',input(),{signal:abort.signal}),/stop queued/);abort.abort(new Error('stop queued'));
 release();await Promise.all(starts);await cancelled;
 const result=await queued;assert.equal(f.broker.commandPlane.inspect('queued',result.id).plan.entries[0].request.url,'https://fixture.invalid/queued');
 assert.equal((await danger).state,'pending');assert.equal(f.calls(),6);
});

test('manager admits an ordinary burst into the bounded review queue without dropping later requests',async t=>{
 let release;const advice=new Promise(resolve=>release=resolve);const f=await managerFixture(t,{advice});
 const origin='http://127.0.0.1:49123';
 const work=Promise.allSettled([...Array.from({length:8},(_,i)=>f.manager.fetch('s',origin+'/read/'+i)),f.manager.fetch('s',origin+'/delete',{method:'DELETE'})]);
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.calls(),4);release(low);
 const results=await work;
 assert.ok(results.slice(0,8).every(r=>r.status==='fulfilled'&&r.value.status===200),JSON.stringify(results));
 assert.equal(results[8].status,'rejected');assert.equal(results[8].reason.code,'SRC_GATE_PENDING_OR_REJECTED');
 assert.equal(f.sends(),8);assert.equal(f.calls(),9);
});

test('pending history retains actual contradictory Jev classification through host-lane conversion',async t=>{
 const f=await managerFixture(t,{advice:{...low,risk:'unknown',raw:'private-provider-prose'}});
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'),code('PENDING_OR_REJECTED'));
 const row=[...f.rows.values()][0];
 assert.match(row.reason,/"risk":"unknown"/);assert.match(row.reason,/"action":"allow"/);
 assert.match(row.reason,/"hardVeto":false/);assert.ok(!JSON.stringify(row).includes('private-provider-prose'));
 assert.equal(f.sends(),0);
 const {reviewSummary}=await import('../lib/src/egress/decision-policy.js');
 const projected=reviewSummary({effect:'private-secret',risk:'secret',action:'secret',mode:'secret',fallback:false});
 assert.ok(!JSON.stringify(projected).includes('secret'));assert.equal(projected.risk,'unknown');
});

test('relay idle allowance covers queued review and the private control deadline without removing bounds',async()=>{
 const {RESPONSE_SLOT_WAIT_MS,CONTROL_TIMEOUT_MS,RELAY_IDLE_TIMEOUT_MS}=await import('../lib/src/egress/timing.js');
 const {readFileSync}=await import('node:fs');
 const addon=readFileSync(new URL('../lib/src/egress/mitm-addon.py',import.meta.url),'utf8');
 assert.equal(Number(addon.match(/RESPONSE_SLOT_WAIT_SECONDS = (\d+)/)[1])*1000,RESPONSE_SLOT_WAIT_MS);
 assert.equal(Number(addon.match(/CONTROL_TIMEOUT_SECONDS = (\d+)/)[1])*1000,CONTROL_TIMEOUT_MS);
 assert.ok(RELAY_IDLE_TIMEOUT_MS>RESPONSE_SLOT_WAIT_MS+CONTROL_TIMEOUT_MS);assert.ok(RELAY_IDLE_TIMEOUT_MS<=300000);
 const proxy=readFileSync(new URL('../lib/src/egress/proxy-process.js',import.meta.url),'utf8');
 for(const endpoint of ['client','backend'])assert.ok(proxy.includes(endpoint+'.setTimeout(RELAY_IDLE_TIMEOUT_MS,'));
});

test('待审积压不占满内存配额，跨重启恢复密文且绑定原会话与摘要',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'egress-pending-durable-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'ledger.sqlite'),key=randomBytes(32),f=fixture(t,{file,key,assess:()=>({...low,action:'pending'})});
 const tasks=[];
 for(let i=0;i<140;i++)tasks.push(await f.broker.propose('s1',input({entries:[{request:request({url:`https://fixture.invalid/item/${i}`,headers:[['authorization','Bearer frozen-secret']]}),maxRequests:1}],maxRequests:1})));
 f.broker.close();assert.equal(readFileSync(file).includes(Buffer.from('frozen-secret')),false);
 const g=fixture(t,{file,key});g.tick(90*86400000);
 const first=g.broker.commandPlane.inspect('s1',tasks[0].id);assert.equal(first.state,'pending');assert.equal(first.expires,null);
 assert.equal(first.plan.entries[0].request.headers[0][1],'Bearer frozen-secret');
 assert.throws(()=>g.broker.commandPlane.inspect('other',tasks[0].id),code('UNKNOWN_TASK'));
 g.broker.commandPlane.decide('s1',tasks[0].id,tasks[0].digest,'allow');
 const claim=g.broker.dataPlane.claim('s1',tasks[0].id,first.plan.entries[0].request);g.broker.dataPlane.finish('s1',claim.dispatchId,'response_received');
 assert.throws(()=>g.broker.dataPlane.claim('s1',tasks[0].id,first.plan.entries[0].request),code('BUDGET_EXHAUSTED'));
});

test('审批密文篡改、移植与旧版缺少原文不能恢复发送',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 for(const mode of ['tamper','transplant','legacy']){
  const dir=mkdtempSync(path.join(tmpdir(),'egress-cipher-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'ledger.sqlite'),key=randomBytes(32),f=fixture(t,{file,key,assess:()=>({...low,action:'pending'})});
  const a=await f.broker.propose('s1',input()),b=await f.broker.propose('s2',input());f.broker.close();
  const db=new DatabaseSync(file),manifest=JSON.parse(db.prepare('SELECT manifest FROM gate_tasks WHERE id=?').get(a.id).manifest);
  if(mode==='tamper'){const bytes=Buffer.from(manifest.frozen.data,'base64');bytes[0]^=1;manifest.frozen.data=bytes.toString('base64');}
  if(mode==='transplant')manifest.frozen=JSON.parse(db.prepare('SELECT manifest FROM gate_tasks WHERE id=?').get(b.id).manifest).frozen;
  if(mode==='legacy')delete manifest.frozen;
  db.prepare('UPDATE gate_tasks SET manifest=? WHERE id=?').run(JSON.stringify(manifest),a.id);db.close();
  const g=fixture(t,{file,key});assert.throws(()=>g.broker.commandPlane.decide('s1',a.id,a.digest,'allow'),code('FROZEN_PLAN_UNAVAILABLE'));
 }
});

test('批准后等待不消耗有限扫描预算，启动时间和已用次数不能经重启重置',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'egress-scan-resume-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'ledger.sqlite'),key=randomBytes(32),f=fixture(t,{file,key,assess:()=>({...low,action:'pending'})});
 const task=await f.broker.propose('s1',input());f.tick(7*86400000);f.broker.commandPlane.decide('s1',task.id,task.digest,'allow');f.broker.close();
 const g=fixture(t,{file,key});g.tick(60*86400000);
 const started=g.broker.startToolTask('s1',task.id,input());assert.ok(started.expiresAt>60*86400000);
 const grant=g.broker.dataPlane.claim('s1',task.id,request());g.broker.dataPlane.finish('s1',grant.dispatchId,'response_received');g.broker.close();
 const h=fixture(t,{file,key});assert.equal(h.broker.commandPlane.history('s1',task.id).used,1);
 assert.throws(()=>h.broker.startToolTask('s1',task.id,input()),code('TASK_NOT_AUTHORIZED'));
 assert.throws(()=>h.broker.dataPlane.claim('s1',task.id,request()),code('TASK_NOT_ACTIVE'));
});

test('同资源待审删除不阻塞Jev明确允许的独立读取，未知POST不能借用读取权限',async t=>{
 const advice=plan=>({...low,...(plan.entries.some(e=>e.request.method==='POST')?{effect:'unknown',action:'pending'}:{})});
 const f=fixture(t,{assess:advice}),url='https://fixture.invalid/item';
 await f.broker.propose('s1',input({entries:[{request:request({url,method:'DELETE'}),maxRequests:1}],maxRequests:1}));
 const read=await f.broker.propose('s1',input({entries:[{request:request({url}),maxRequests:1}],maxRequests:1}));
 assert.equal(read.state,'active');const grant=f.broker.dataPlane.claim('s1',read.id,request({url}));f.broker.dataPlane.finish('s1',grant.dispatchId,'response_received');
 const post=await f.broker.propose('s1',input({entries:[{request:request({url,method:'POST'}),maxRequests:1}],maxRequests:1}));assert.equal(post.state,'pending');
});

test('明确低风险计算的前置与后置检查真实执行，前提变更不发送正文',async t=>{
 const {createHash}=await import('node:crypto');const digest=text=>createHash('sha256').update(text).digest('hex');
 for(const changed of [false,true]){
  const sends=[],url='http://127.0.0.1:49123/render',state='http://127.0.0.1:49123/state';
  const f=await managerFixture(t,{advice:{...low,effect:'compute'},send:async(url,init)=>{sends.push([url,init.method]);return new Response(url===state?changed?'changed':'before':'49');}});
  const check={request:{url:state,method:'GET'},status:200,bodySha256:digest('before')};
  const work=f.manager.fetch('s',url,{method:'POST',body:'{"template":"{{7*7}}"}'},{egressSafetyPlan:{effect:'compute',precondition:check,verification:check}});
  if(changed){await assert.rejects(work,code('PRECONDITION_CHANGED'));assert.deepEqual(sends,[[state,'GET']]);}
  else{assert.equal(await(await work).text(),'49');assert.deepEqual(sends,[[state,'GET'],[url,'POST'],[state,'GET']]);}
  assert.equal(f.rows.size,0);
 }
});

test('显式无效计算检查不能被忽略或发送',async t=>{
 const f=await managerFixture(t,{advice:{...low,effect:'compute'}});
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/render',{method:'POST',body:'{}'},{egressSafetyPlan:{effect:'compute',precondition:'随便读取即可'}}));assert.equal(f.sends(),0);
});

test('审计写入失败不消耗原待审单，并发批准也只能发送一次',async t=>{
 const f=await managerFixture(t,{advice:{...low,action:'pending'}});await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'));
 const [row]=f.rows.values(),update=f.store.updateApprovalExecution;f.store.updateApprovalExecution=async()=>{throw new Error('audit unavailable');};
 await assert.rejects(f.manager.user.decide('s',row.id,'allow'));assert.equal(f.sends(),0);
 f.store.updateApprovalExecution=update;const results=await Promise.allSettled([f.manager.user.decide('s',row.id,'allow'),f.manager.user.decide('s',row.id,'allow')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.sends(),1);
});

test('待办写入中断后重新读取同请求补齐原任务卡片，不产生无编号永久锁',async t=>{
 const f=await managerFixture(t,{advice:{...low,action:'pending'}}),add=f.store.addPendingApproval;
 f.store.addPendingApproval=async()=>{throw new Error('store unavailable');};
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'));
 f.store.addPendingApproval=add;
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'),e=>e.approvalId==='approval-1');
 assert.equal(f.calls(),1);await f.manager.user.decide('s','approval-1','allow');assert.equal(f.sends(),1);
});

test('域名中的危险词不能把普通读取误判为高危动作',()=>{
 for(const host of ['mail','payment','upload','command','dropbox'])assert.equal(requiresHuman({entries:[{request:request({url:`https://${host}.fixture.invalid/read`})}]}),false);
 assert.equal(requiresHuman({entries:[{request:request({url:'https://mail.fixture.invalid/delete'})}]}),false,'路径交给语义审核，不单凭名字定性');
});

test('补材料后发布中断可从旧编号恢复同一新单，正文和安全材料均不重建',async t=>{
 const f=await managerFixture(t,{advice:{...low,effect:'unknown',action:'pending'}}),url='http://127.0.0.1:49123/render';
 await assert.rejects(f.manager.fetch('s',url,{method:'POST',body:'{"template":"{{7*7}}"}'}));
 const [old]=f.rows.values(),add=f.store.addPendingApproval,safety={effect:'compute',object:'原冻结计算',recovery:'不自动重试'};
 f.store.addPendingApproval=async()=>{throw new Error('storage interrupted');};
 await assert.rejects(f.manager.preparePending('s',old.id,safety));f.store.addPendingApproval=add;
 const resumed=await f.manager.preparePending('s',old.id,safety);assert.ok(resumed.approvalId);assert.equal(f.rows.size,2);assert.equal(old.executionState,'superseded');
 const view=await f.manager.user.inspect('s',resumed.approvalId);assert.equal(view.plan.hostExecution.request.body,'{"template":"{{7*7}}"}');
 await f.manager.user.decide('s',resumed.approvalId,'allow');assert.equal(f.sends(),1);
});

test('bash计划待审及人工批准都不抢占独立bash，显式恢复后只绑定一次实际启动',async t=>{
 const f=await managerFixture(t,{advice:{...low,action:'pending'}}),body={entries:[{request:{url:'http://127.0.0.1:49123/catalog',method:'GET'},maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:10000,purpose:'有界扫描'};
 const task=await f.manager.proposeShellTask('s',body,{});assert.equal(task.state,'pending');
 assert.throws(()=>f.manager.claimShellTask('s',task.id),code('STALE_SHELL_TASK'));
 const decision=await f.manager.user.decide('s',task.approvalId,'allow');assert.equal(decision.resumeTool,'src_egress_plan');
 assert.throws(()=>f.manager.claimShellTask('s',task.id),code('STALE_SHELL_TASK'));
 assert.equal((await f.manager.proposeShellTask('s',body,{},task.id)).id,task.id);assert.equal(f.calls(),1);
 f.manager.claimShellTask('s',task.id);
 assert.throws(()=>f.manager.claimShellTask('s',task.id),code('STALE_SHELL_TASK'));
 await assert.rejects(f.manager.proposeShellTask('s',body,{},task.id),code('TASK_NOT_AUTHORIZED'));
});

test('范围变更后旧单不能批准，但用户仍能明确拒绝清理待办',async t=>{
 const f=await managerFixture(t,{advice:{...low,action:'pending'}});
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/catalog'));const [row]=f.rows.values();
 await f.manager.user.setScope('s',['http://127.0.0.1:49123']);
 await assert.rejects(f.manager.user.decide('s',row.id,'allow'),code('SCOPE_CHANGED'));
 assert.equal((await f.manager.user.decide('s',row.id,'reject')).state,'denied');assert.equal(row.status,'rejected');assert.equal(f.sends(),0);
});

for(const patch of [{method:'PUT'},{headers:[['x-http-method-override','DELETE']]},{url:'https://fixture.invalid/%2525252541'}])test('旧单补材料不能绕过写入/改写/编码闸 '+JSON.stringify(patch),async t=>{
 const f=fixture(t),req=request(patch);
 const task=await f.broker.propose('legacy-negative',input({entries:[{request:req,maxRequests:1}],maxRequests:1,hostExecution:{request:req,safety:null}}));
 assert.equal(task.state,'pending');
 assert.throws(()=>f.broker.commandPlane.repairReadSafety('legacy-negative',task.id),code('SAFETY_PLAN_REQUIRED'));
 assert.equal(f.broker.commandPlane.inspect('legacy-negative',task.id).plan.hostExecution.safety,null);
});

for(const body of ['', '{"values":{}}', '{"template":12345}'])test('未知参数探测只能由人类明确确认单笔低影响后执行 '+body,async t=>{
 const f=await managerFixture(t,{advice:{...low,effect:'unknown',risk:'unknown',action:'pending'}});
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/render',{method:'POST',body}),code('PENDING_OR_REJECTED'));
 const [row]=f.rows.values();assert.equal(JSON.parse(row.body).safety,null);
 await f.manager.user.inspect('s',row.id);assert.equal(f.sends(),0);
 await assert.rejects(f.manager.user.decide('s',row.id,'allow'),code('SAFETY_PLAN_REQUIRED'));
 const decisions=await Promise.allSettled([f.manager.user.decide('s',row.id,'allow-read'),f.manager.user.decide('s',row.id,'allow-read')]);
 assert.equal(decisions.filter(d=>d.status==='fulfilled').length,1);assert.equal(f.sends(),1);assert.equal(f.rows.size,1);
 assert.equal(row.approvalSource,'human-command');assert.match(row.note,/人类确认冻结单笔/);
 await assert.rejects(f.manager.user.decide('s',row.id,'allow-read'),code('STALE_APPROVAL'));assert.equal(f.sends(),1);
});

for(const effect of ['write','destructive','external','auth'])test('人工低影响确认不能覆盖Jev已识别副作用 '+effect,async t=>{
 const f=await managerFixture(t,{advice:{...low,effect,risk:'high',action:'pending'}});
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/action',{method:'POST',body:'{}'}));
 const [row]=f.rows.values();await assert.rejects(f.manager.user.decide('s',row.id,'allow-read'),code('SAFETY_PLAN_REQUIRED'));
 assert.equal(f.sends(),0);assert.equal(row.status,'pending');
});

for(const init of [{method:'PUT'},{method:'PATCH'},{method:'DELETE'},{method:'POST',headers:{'x-http-method-override':'DELETE'}}])test('人工低影响确认不能绕过方法和改写硬闸 '+JSON.stringify(init),async t=>{
 const f=await managerFixture(t,{advice:{...low,effect:'unknown',risk:'unknown',action:'pending'}});
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/action',init));
 const [row]=f.rows.values();await assert.rejects(f.manager.user.decide('s',row.id,'allow-read'),code('SAFETY_PLAN_REQUIRED'));
 assert.equal(f.sends(),0);
});

test('未知单笔拒绝及范围变更不会被只读确认覆盖',async t=>{
 for(const reject of [true,false]){
  const f=await managerFixture(t,{advice:{...low,effect:'unknown',risk:'unknown',action:'pending'}});
  await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/render',{method:'POST',body:'{}'}));const [row]=f.rows.values();
  if(reject)await f.manager.user.decide('s',row.id,'reject');else await f.manager.user.setScope('s',['http://127.0.0.1:49123']);
  await assert.rejects(f.manager.user.decide('s',row.id,'allow-read'));assert.equal(f.sends(),0);
 }
});

test('旧未知审批等待数日且重启后仍可明确接管，原请求逐字节执行一次',async t=>{
 const f=await managerFixture(t,{advice:{...low,effect:'unknown',risk:'unknown',action:'pending'}}),body='{"values":{}}';
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/render',{method:'POST',headers:{'Content-Type':'application/json'},body}));
 const [row]=f.rows.values();await f.manager.close();const sent=[];
 const next=await createEgressManager({home:f.home,storeFor:async()=>f.store,allowLoopbackFixtures:true,
  now:()=>Date.now()+7*86400000,assess:async()=>{throw new Error('旧单不能再判定替换冻结原文');},
  directFetch:async(url,init)=>{sent.push({url,body:Buffer.from(init.body).toString()});return new Response('validated');}});
 t.after(()=>next.close());
 await next.user.inspect('s',row.id);assert.deepEqual(sent,[]);
 assert.equal((await next.user.decide('s',row.id,'allow-read')).executionState,'executed');
 assert.deepEqual(sent,[{url:'http://127.0.0.1:49123/render',body}]);
 await assert.rejects(next.user.decide('s',row.id,'allow-read'));assert.equal(sent.length,1);
});

test('同接口旧请求结果未知：人类确认三种独立参数探测后实际发送，旧请求仍不可重放',async t=>{
 const advice={...low,effect:'compute'},sent=[];
 const f=await managerFixture(t,{advice,send:async(u,i)=>{const body=String(i.body??'');sent.push(body);if(body==='old-unknown')throw new Error('lost response');return new Response('ok');}});
 const url='http://127.0.0.1:49123/render';
 await assert.rejects(f.manager.fetch('s',url,{method:'POST',body:'old-unknown'}));
 Object.assign(advice,{effect:'unknown',risk:'unknown',action:'pending'});
 for(const body of ['', '{"values":{}}','{"template":12345}']){
  let id;try{await f.manager.fetch('s',url,{method:'POST',body});}catch(e){id=e.approvalId;}
  assert.ok(id);assert.equal((await f.manager.user.decide('s',id,'allow-read')).executionState,'executed');
 }
 assert.deepEqual(sent,['old-unknown','', '{"values":{}}','{"template":12345}']);
 await assert.rejects(f.manager.fetch('s',url,{method:'POST',body:'old-unknown'}));assert.equal(sent.length,4);
});

test('local121已批准未发送旧单：冷启核验零dispatch后原编号恢复，结果未知锁保留',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const advice={...low,effect:'compute'},url='http://127.0.0.1:49123/render';
 const f=await managerFixture(t,{advice,send:async()=>{throw new Error('prior result unknown');}});
 await assert.rejects(f.manager.fetch('s',url,{method:'POST',body:'prior'}));
 Object.assign(advice,{effect:'unknown',risk:'unknown',action:'pending'});
 for(const body of ['', '{"values":{}}','{"template":12345}'])await assert.rejects(f.manager.fetch('s',url,{method:'POST',body}));
 const rows=[...f.rows.values()];assert.equal(rows.length,3);await f.manager.close();
 const db=new DatabaseSync(path.join(f.home,'control/src-egress/ledger.sqlite'));
 for(const row of rows){
  const id=row.url.slice('src-egress://'.length),task=db.prepare('select * from gate_tasks where id=?').get(id),manifest=JSON.parse(task.manifest);
  manifest.humanApproved=true;db.prepare("update gate_tasks set state='revoked',manifest=? where id=?").run(JSON.stringify(manifest),id);
  Object.assign(row,{status:'approved',userDecision:'allow',executionState:'failed-before-send',executionError:'SRC_GATE_RESOURCE_REQUIRES_REVIEW'});
 }
 db.close();const sent=[];
 const next=await createEgressManager({home:f.home,storeFor:async()=>f.store,allowLoopbackFixtures:true,assess:async()=>{throw new Error('do not re-review old bytes');},directFetch:async(u,i)=>{sent.push(i.body?String(i.body):'');return new Response('ok');}});t.after(()=>next.close());
 for(const row of rows){
  await assert.rejects(next.user.decide('s',row.id,'allow'));
  assert.equal((await next.user.decide('s',row.id,'allow-read')).executionState,'executed');
  await assert.rejects(next.user.decide('s',row.id,'allow-read'));
 }
 assert.deepEqual(sent,['','{"values":{}}','{"template":12345}']);
 await assert.rejects(next.fetch('s',url,{method:'POST',body:'prior'}));assert.equal(sent.length,3);
});

for(const evidence of ['used','dispatch'])test('未发送恢复不信任面板状态：账本有执行证据即拒绝 '+evidence,async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const f=await managerFixture(t,{advice:{...low,effect:'unknown',risk:'unknown',action:'pending'}});
 await assert.rejects(f.manager.fetch('s','http://127.0.0.1:49123/render',{method:'POST',body:'{}'}));const [row]=f.rows.values();await f.manager.close();
 const db=new DatabaseSync(path.join(f.home,'control/src-egress/ledger.sqlite')),id=row.url.slice('src-egress://'.length),task=db.prepare('select * from gate_tasks where id=?').get(id),manifest=JSON.parse(task.manifest);
 manifest.humanApproved=true;db.prepare("update gate_tasks set state='revoked',manifest=?,used=? where id=?").run(JSON.stringify(manifest),evidence==='used'?1:0,id);
 if(evidence==='dispatch')db.prepare('insert into gate_dispatches values (?,?,?,?,?,?,?,?)').run('fixture-dispatch',id,'s',manifest.entries[0].digest,'http://127.0.0.1:49123','response_received',1,2);
 db.close();Object.assign(row,{status:'approved',userDecision:'allow',executionState:'failed-before-send',executionError:'SRC_GATE_RESOURCE_REQUIRES_REVIEW'});
 let sends=0;const next=await createEgressManager({home:f.home,storeFor:async()=>f.store,allowLoopbackFixtures:true,directFetch:async()=>{sends++;return new Response('must not send');}});t.after(()=>next.close());
 await assert.rejects(next.user.decide('s',row.id,'allow-read'));assert.equal(sends,0);
});
