// [local.148] 判定归账与观测发射：代理/脚本车道的判定必须能被计量与遥测认领。
//
// 现场（2026-10-19 审计 session-a927392f）：bash 循环里 4 笔同形 POST，3 笔自动放行、
// 1 笔挂人工卡，事后历史里一条判定记录都没有，连“哪几笔被自动放行”都查不出来。
// 两个原因都在观测侧（不影响任何授权判定）：
//   ① 代理车道的 exec 是合成对象（没有 agent.session），`sessionIdOf(exec)` 直接抛错，
//      被 lib/src.js 的 try/catch 吞成一行 warn → 该车道判定零记录；
//   ② 观测发射以 DSH_SRC_LAYA_DECISION 为准，默认 off，而桌面 App 不注入任何 DSH_* 环境
//      （用户设置里 enabled:true / riskMode:'on'）→ 真实运行时 risk-grade 观测行一行不落。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {sessionIdForDecision} from '../lib/src/decision/record-sink.js';
import http from 'node:http';
import {createEgressManager} from '../lib/src/egress/manager.js';
import {dispatchHttp} from '../lib/src/egress/http-dispatch.js';
import {riskObservationEnabled, assessEgressPlan} from '../lib/src/egress/advisor.js';
import {flushDefaultTelemetry} from '../lib/src/telemetry/events.js';

async function telemetryRows(dir) {
  await flushDefaultTelemetry();
  const rows = [];
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.jsonl'))) {
    for (const line of (await readFile(path.join(dir, file), 'utf8')).split('\n')) if (line.trim() !== '') rows.push(JSON.parse(line));
  }
  return rows;
}

test('[local.148] 观测发射判据：桌面 App（不注入 DSH_*、设置里 riskMode=on）必须落行，单测进程不写', () => {
  const app = {flag: 'off', testProcess: false};
  assert.equal(riskObservationEnabled({mode: 'on'}, app), true, 'App 里真实发生的判定必须留下观测行');
  assert.equal(riskObservationEnabled({mode: 'on'}, {flag: 'off', testProcess: true}), false, '单测 fixture 的 mode:on 是假值，不得写进真实遥测库');
  assert.equal(riskObservationEnabled({mode: 'off'}, app), false, '没有真问过判定服务就不落行');
  assert.equal(riskObservationEnabled({mode: 'shadow'}, app), false, 'shadow 且 flag=off 维持历史静默');
  assert.equal(riskObservationEnabled({mode: 'off'}, {flag: 'on', testProcess: true}), true, 'flag 显式打开时不受单测判据影响');
  assert.equal(riskObservationEnabled({mode: 'on'}, {flag: 'shadow', testProcess: true}), true, 'flag=shadow 属显式打开');
  assert.equal(riskObservationEnabled(void 0, app), false);
  assert.equal(riskObservationEnabled(null, {flag: 'off', testProcess: false}), false);
});

test('[local.148] 归账会话解析：工具 exec 用 agent.session，代理车道合成 exec 用 srcSessionId，都没有就空串且不抛错', () => {
  assert.equal(sessionIdForDecision({agent: {session: {id: 'session-a'}}}), 'session-a');
  assert.equal(sessionIdForDecision({agent: {session: {id: ''}}, srcSessionId: 'session-b'}), 'session-b');
  assert.equal(sessionIdForDecision({egressTaskId: 'task', deferAssessment: true, srcSessionId: 'session-c'}), 'session-c');
  assert.equal(sessionIdForDecision({agent: {session: {id: 'session-a'}}, srcSessionId: 'session-b'}), 'session-a', 'agent 是身份真值');
  assert.equal(sessionIdForDecision({egressTaskId: 'task', deferAssessment: true}), '');
  assert.equal(sessionIdForDecision({agent: {}}), '');
  assert.equal(sessionIdForDecision({srcSessionId: 42}), '');
  assert.equal(sessionIdForDecision(void 0), '');
});

test('[local.148] 代理车道的判定落观测行：合成 exec 也能归账到会话', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'src-telemetry-attribution-'));
  const before = {dir: process.env.DSH_SRC_TELEMETRY_DIR, flag: process.env.DSH_SRC_LAYA_DECISION};
  process.env.DSH_SRC_TELEMETRY_DIR = dir;
  process.env.DSH_SRC_LAYA_DECISION = 'on';
  t.after(async () => {
    if (before.dir === void 0) delete process.env.DSH_SRC_TELEMETRY_DIR; else process.env.DSH_SRC_TELEMETRY_DIR = before.dir;
    if (before.flag === void 0) delete process.env.DSH_SRC_LAYA_DECISION; else process.env.DSH_SRC_LAYA_DECISION = before.flag;
    await rm(dir, {recursive: true, force: true});
  });
  // 与现场同形的单笔捕获：POST /session/forgetpassword login=jdoe（只喂桩判定，不发包）。
  const request = {url: 'https://fixture.invalid/session/forgetpassword', method: 'POST', headers: [['content-type', 'application/x-www-form-urlencoded']], bodyBase64: Buffer.from('login=jdoe').toString('base64')};
  const plan = {maxRequests: 1, entries: [{request, maxRequests: 1}], purpose: '单笔捕获'};
  const pending = {fallback: false, mode: 'on', action: 'pending', effect: 'external', risk: 'high', confidence: 0.4, probabilities: {external: 0.45}};
  // 代理车道形状：只有 egressTaskId/deferAssessment/盖章过的 srcSessionId，没有 agent。
  const proxyExec = {egressTaskId: 'task-fixture', deferAssessment: true, srcSessionId: 'session-proxy'};
  const result = await assessEgressPlan(plan, proxyExec, async () => pending);
  assert.equal(result, pending, '观测旁路不得改变判定结果');
  const rows = (await telemetryRows(dir)).filter(row => row.event === 'laya.decision' && row.payload?.taskType === 'risk-grade');
  assert.equal(rows.length, 1, '每笔真实判定恰好一行观测');
  assert.equal(rows[0].sessionId, 'session-proxy');
  assert.equal(rows[0].payload.mode, 'on');
  assert.equal(rows[0].payload.effect, 'external');
  assert.equal(rows[0].payload.risk, 'high');
  assert.equal(JSON.stringify(rows[0]).includes('login=jdoe'), false, '观测行不得带请求正文');
});

test('[local.148] 出口闸盖章：交给判定的 exec 一定带 srcSessionId（代理/脚本车道本来就拿不到 agent）', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'src-attribution-gate-'));
  const local = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${local.address().port}`;
  const rows = new Map();
  const store = {
    listScopeApprovals: async () => [],
    addPendingApproval: async (sessionId, data) => { const row = {...data, id: `approval-${rows.size + 1}`, sessionId, status: 'pending', createdAt: Date.now()}; rows.set(row.id, row); return row; },
    getPendingApproval: async (_session, id) => rows.get(id),
    updateApprovalExecution: async (_session, id, patch) => Object.assign(rows.get(id), patch)
  };
  const seen = [];
  const manager = await createEgressManager({home, allowLoopbackFixtures: true, storeFor: async () => store, directFetch: dispatchHttp, assess: async (plan, exec) => { seen.push({plan, exec}); return {action: 'pending', effect: 'write', risk: 'high', confidence: 0.9, fallback: false, mode: 'on'}; }});
  t.after(async () => { await manager.close(); local.closeAllConnections(); await new Promise((resolve) => local.close(resolve)); await rm(home, {recursive: true, force: true}); });
  await manager.user.setScope('session-stamp', [origin]);
  await assert.rejects(manager.fetch('session-stamp', `${origin}/users/create`, {method: 'POST', body: 'a=1'}), {code: 'SRC_GATE_PENDING_OR_REJECTED'});
  assert.equal(seen.length, 1, '写类请求必须先过判定');
  assert.equal(seen[0].exec.srcSessionId, 'session-stamp');
  assert.equal(seen[0].exec.agent, void 0, '这类 exec 本来就没有 agent —— 正是旧路径丢记录的形状');
  assert.equal(sessionIdForDecision(seen[0].exec), 'session-stamp');
  assert.equal(rows.size, 1, '判定为待审后开人工卡，未发送');
});
