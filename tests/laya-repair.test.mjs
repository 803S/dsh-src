import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { apply as applySrc, __resetSharedDomainOpensForTests, applySrcEvent, srcInitialState } from '../lib/src.js';
import { apply as applySubagent } from '../lib/src-subagent.js';
import { saveDecisionSettings } from '../lib/src/decision/service-settings.js';
import { layaDecide, resetLayaCacheForTests } from '../lib/src/decision/laya-client.js';
import { recallKnowledgeCandidates, documentIdentity } from '../lib/src/decision/knowledge-recall.js';
import { skillReminderRegistry } from '../lib/src/decision/skill-recall.js';
import { routeForChild, resetChildRoutesForTests } from '../lib/src/child-routing.js';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'src-laya-repair-'));
  const env = { ...process.env };
  process.env.DSH_HOME = home; process.env.DSH_SRC_TELEMETRY = 'off';
  process.env.DSH_SRC_LAYA_DECISION = 'off'; process.env.DSH_SRC_LAYA_SKILL = 'off'; process.env.DSH_SRC_LAYA_DELEGATE = 'off';
  __resetSharedDomainOpensForTests(); resetLayaCacheForTests(); resetChildRoutesForTests();
  await saveDecisionSettings({enabled:true,endpoint:'https://jev.fixture/decide'});
  const tables = new Map();
  const domain = { table(name) { if (!tables.has(name)) tables.set(name, new Map()); const rows = tables.get(name); return { get: key => rows.get(key), entries: () => rows.entries(), put: async (key, value) => rows.set(key, value), delete: async key => rows.delete(key) }; }, async close() {} };
  const ctx = new Context();
  const disposers = [ctx.plugin(SystemPrompt), ctx.plugin(ToolRuntime)];
  await new Promise(resolve => setTimeout(resolve, 10));
  const agents = new Map(), sessions = new Map(), notices = [];
  ctx.provide('web', { registerSearchProvider() {} });
  ctx.provide('storageDomain', { open: async () => domain });
  ctx.provide('sessions', { get: id => sessions.get(id) });
  ctx.provide('agents', { get: id => agents.get(id) });
  let spawnSpec;
  let followupFails = false;
  ctx.provide('subagents', {
    async startContinuable(spec) { spawnSpec = spec; return { childId: 'fixture-child', messageId: 'queued-1' }; },
    async followup(parent, id) { if (followupFails) throw new Error('fixture queue failure'); notices.push({ parent, id }); return 'recovery-queued'; },
    async start(_provider, request) { spawnSpec = { request }; return { id: 'foreground-child', result: Promise.resolve({ stopReason: 'error', output: [] }), dispose: async () => {} }; }
  });
  ctx.logger.exporter({ export: message => console.error('FIXTURE_LOG', message) });
  const scope = ctx.plugin({ name: 'src-fixture', inject: ['tools', 'storageDomain', 'sessions', 'subagents', 'agents', 'systemPrompt', 'web'], apply: applySrc }); disposers.push(scope);
  await new Promise(resolve => setTimeout(resolve, 20));
  applySubagent(ctx, { provider: 'spawn', toolName: 'src_recon', persona: 'fixture', toolFilter: { deny: ['src_recon'] }, maxDepth: 1 });
  const events = [];
  const parent = { id: 'fixture-parent', options: { provider: 'old-provider', model: 'old-model' }, status: 'running', session: { id: 'fixture-parent', header: {}, events, append(type, data) { events.push({ type, data }); }, requestHeader: () => ({ config: { provider: 'current-provider', model: 'current-model', maxTokens: 1234 } }) } };
  agents.set(parent.id, parent); sessions.set(parent.id, parent.session);
  const run = async (name, args, agent = parent) => {
    const callId = `call-${Math.random()}`;
    agent.session.append('tool/call', { name, arguments: JSON.stringify(args), callId });
    const result = await ctx.tools.execute({ name, arguments: args, agent, callId, signal: new AbortController().signal });
    agent.session.append('tool/result', { callId, isError: result.isError });
    return result;
  };
  t.after(async () => { for (const scope of disposers.reverse()) await scope.dispose(); for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env); await fs.rm(home, { force: true, recursive: true }); });
  const goal = await run('src_add_goal', { target: 'fixture.test', objective: 'local fixture', authorization: 'local test only' });
  assert.equal(goal.isError, false, JSON.stringify(goal));
  return { ctx, home, parent, run, events, tables, agents, spawn: () => spawnSpec, failFollowup: value => followupFails = value };
}

test('host dispatch: advisory shadow/on never becomes execution; spawn uses effective route; explicit recovery preserves lineage', async t => {
  const h = await fixture(t), oldFetch = globalThis.fetch;
  t.after(() => globalThis.fetch = oldFetch);
  assert.equal(routeForChild(h.parent), undefined, 'ordinary parent assembly must not dereference an absent override');
  const assembled = await h.ctx.systemPrompt.assemble({ agent: h.parent, scope: h.parent });
  assert.ok(assembled);
  globalThis.fetch = async () => new Response(JSON.stringify({ model:'jev-fixture', answers: { decision: { choice: 'self', confidence: .99, probabilities:{delegate:0,self:1,pending:0} } } }));
  process.env.DSH_SRC_LAYA_DELEGATE = 'shadow';
  const shadow = await h.run('src_add_intent', { title: 'shadow scope' });
  assert.equal(shadow.isError, false, JSON.stringify(shadow));
  assert.equal(shadow.value.delegationAdvice, undefined);
  process.env.DSH_SRC_LAYA_DELEGATE = 'on';
  const intent = await h.run('src_add_intent', { title: 'bounded fixture', detail: 'read a local fixture' });
  assert.equal(intent.value.delegationAdvice.action, 'self');
  let state = (await h.run('src_state', {})).value;
  assert.equal(state.intents.find(r => r.id === intent.value.id).delegationMode, 'self');
  const failedUpdate = await h.run('src_update_intent', { intentId: intent.value.id, status: 'completed', delegationMode: 'delegate' });
  assert.equal(failedUpdate.isError, true);
  assert.equal(h.events.reduce(applySrcEvent, srcInitialState).nodes.find(r => r.id === intent.value.id).status, 'planned');
  const legacyState = {...h.events.reduce(applySrcEvent, srcInitialState),lastAppliedEventSeq:0};
  const legacy = applySrcEvent(legacyState, { type: 'tool/call', data: { callId: 'legacy-call', name: 'src_update_intent', arguments: JSON.stringify({ intentId: intent.value.id, status: 'running' }) } });
  assert.equal(legacy.nodes.find(r => r.id === intent.value.id).status, 'running', 'old callId-bearing history is still replayable');
  const fake = await h.run('src_recon', { intentId: 'intent-999', description: 'bad', prompt: 'fixture' });
  assert.equal(fake.isError, true);
  const child = await h.run('src_recon', { intentId: intent.value.id, description: 'fixture child', prompt: 'read fixture only' });
  assert.equal(child.isError, false, JSON.stringify(child));
  assert.equal(h.spawn().request.agentOptions.model, 'current-model');
  assert.equal(h.spawn().request.agentOptions.provider, 'current-provider');
  state = (await h.run('src_state', {})).value;
  assert.equal(state.intents.find(r => r.id === intent.value.id).delegationMode, 'delegate');
  assert.equal(state.intents.find(r => r.id === intent.value.id).childSessionId, 'fixture-child');
  const projection = h.events.reduce(applySrcEvent, srcInitialState);
  assert.equal(projection.nodes.find(r => r.id === intent.value.id).delegationMode, 'delegate');
  const takeover = await h.run('src_update_intent', { intentId: intent.value.id, delegationMode: 'self' });
  assert.equal(takeover.isError, false);
  assert.equal(h.events.reduce(applySrcEvent, srcInitialState).nodes.find(r => r.id === intent.value.id).executionSource, 'commander');
  const childAgent = { id: 'fixture-child', status: 'idle', session: { id: 'fixture-child', header: { parentSession: h.parent.id } } };
  h.agents.set(childAgent.id, childAgent);
  const original = await h.run('src_recover_child', { intentId: intent.value.id, childSessionId: childAgent.id, message: 'only remaining fixture' });
  assert.equal(original.value.status, 'queued');
  assert.equal(routeForChild(childAgent), undefined);
  h.failFollowup(true);
  const failed = await h.run('src_recover_child', { intentId: intent.value.id, childSessionId: childAgent.id, message: 'try current route', inheritParentModel: true });
  assert.equal(failed.isError, true);
  assert.equal(routeForChild(childAgent), undefined);
  h.failFollowup(false);
  const recovered = await h.run('src_recover_child', { intentId: intent.value.id, childSessionId: childAgent.id, message: 'try current route', inheritParentModel: true });
  assert.equal(recovered.value.attempt, 2, 'failed enqueue did not erase earlier attempt or consume another');
  assert.equal(routeForChild(childAgent).model, 'current-model');
  const { agentEvents } = await import('@deepseek-ai/dsh-agent');
  const requestConfig = await agentEvents(h.ctx, childAgent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'old-provider', model: 'old-model', reasoningEffort: 'high' }));
  assert.equal(requestConfig.model, 'current-model');
  assert.equal(requestConfig.reasoningEffort, undefined);
  const assembly = await h.ctx.systemPrompt.assemble({ agent: childAgent, scope: childAgent });
  assert.equal(assembly.variables.model, 'current-model');
  assert.equal(routeForChild({ session: { id: childAgent.id, header: { parentSession: 'other' } } }), undefined);
  const final = await h.run('src_finalize_engagement', { remainingDirections: [], blindSpots: ['http-authz-surface', 'cors-headers', 'dom-xhr', 'dict-budget', 'multi-account-cross-authz'].map(dimension => ({ dimension, status: 'notApplicable', note: 'local fixture without target' })), allowIncomplete: true, allowIncompleteReason: 'fixture limited run' });
  assert.equal(final.isError, false, JSON.stringify(final));
  assert.equal(final.value.completionStatus, 'limited');
  assert.match(final.content[0].text, /受限完成/);
  applySubagent(h.ctx, { provider: 'fork', toolName: 'src_verify', agentOptions: { provider: 'explicit', model: 'explicit-child' } });
  const foreground = await h.run('src_verify', { intentId: shadow.value.id, description: 'explicit fixture', prompt: 'read local fixture', run_in_background: false });
  assert.equal(foreground.isError, false, JSON.stringify(foreground));
  assert.equal(h.spawn().request.agentOptions.model, 'explicit-child');
  assert.equal(foreground.value.status, 'error');
  assert.match(foreground.content[0].text, /Failed child/);
});

test('knowledge library loads real files; document version/source identity; failures not cached; Chinese semantics retained', async t => {
  const h = await fixture(t);
  const root = path.join(h.home, 'cap');
  const rel = 'skills/skill/知识库/auth.md';
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  const text = '# 认证\nAPI model 认证 token 两账户对照。';
  await fs.writeFile(path.join(root, rel), text);
  const manifestReader = async () => ({ items: [{ id: 'clown-src-playbook', dir: root, status: 'installed' }] });
  const errors = [];
  const options = { manifestReader, lessons: async () => [], onError: e => errors.push(e) };
  const rows = await recallKnowledgeCandidates({ intentTitle: '认证', justification: 'API model 验证' }, 5, options);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].readId, rel);
  assert.equal(rows[0].identity, documentIdentity(root, rel, text));
  assert.ok(rows[0].matchedBy.includes('认证'));
  skillReminderRegistry.markRead(h.parent.id, rows[0].identity);
  assert.equal(skillReminderRegistry.isRead(h.parent.id, rows[0].identity), true);
  await fs.writeFile(path.join(root, rel), text + '\nupdated');
  const changed = await recallKnowledgeCandidates({ intentTitle: '认证' }, 5, options);
  assert.notEqual(changed[0].identity, rows[0].identity);
  assert.equal(skillReminderRegistry.isRead(h.parent.id, changed[0].identity), false);
  await fs.rm(path.join(root, 'skills'), { recursive: true });
  assert.deepEqual(await recallKnowledgeCandidates({ intentTitle: '认证' }, 5, options), []);
  assert.equal(errors[0].stage, 'directory');
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), text);
  assert.equal((await recallKnowledgeCandidates({ intentTitle: '认证' }, 5, options)).length, 1);
});

test('Laya strict output, raw local inputs, cancellation and exact advisory cache isolation', async t => {
  const h = await fixture(t), oldFetch = globalThis.fetch;
  t.after(() => globalThis.fetch = oldFetch);
  let calls = 0, prompt = '';
  globalThis.fetch = async (_url, init) => { calls++; prompt = JSON.parse(init.body).text; return new Response(JSON.stringify({ answers: { choice: { choice: 'unexpected', confidence: .9 } } })); };
  const args = { taskType: 'delegate', title: 'fixture', detail: 'full task' };
  assert.equal((await layaDecide(args, { agent: h.parent })).errorType, 'schema');
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ answers: { choice: { choice: 'delegate', confidence: .8 } } })); };
  const good = await layaDecide(args, { agent: h.parent }); assert.equal(good.fallback, false);
  const cached = await layaDecide(args, { agent: h.parent }); assert.equal(cached.cached, true);
  await layaDecide({ ...args, detail: 'changed task' }, { agent: h.parent });
  await layaDecide(args, { agent: { session: { id: 'other' } } });
  assert.equal(calls, 4);
  const abort = new AbortController(); abort.abort();
  assert.equal((await layaDecide(args, { agent: h.parent, signal: abort.signal })).errorType, 'cancelled');
  assert.equal(calls, 4);
  await layaDecide({ ...args, headers: { 'api-key': 'different-identity' } }, { agent: h.parent });
  await layaDecide({ ...args, mode: 'shadow' }, { agent: h.parent });
  assert.equal(calls, 6, 'identity and flag changes invalidate reuse');
  for (const [errorType, mock] of [
    ['http-503', async () => new Response('fixture', { status: 503 })],
    ['json', async () => new Response('{')],
    ['network', async () => { throw new TypeError('fixture connection'); }],
    ['schema', async () => new Response(JSON.stringify({ answers: { choice: { choice: 'delegate', confidence: 2 } } }))]
  ]) {
    resetLayaCacheForTests(); globalThis.fetch = mock;
    assert.equal((await layaDecide(args, { agent: h.parent })).errorType, errorType);
  }
  globalThis.fetch = async (_url, init) => { prompt = JSON.parse(init.body).text; return new Response(JSON.stringify({ answers: { action: { choice: 'pending', confidence: .8 }, risk: { score: 2 } } })); };
  await layaDecide({ taskType: 'risk-grade', url: 'http://fixture.test/rpc', method: 'POST', body: '{"id":1,"method":"tools/list"}', headers: { 'api-key': 'local-fixture-secret' }, justification: 'describe tools without invoking', intentDetail: 'full input meaning' }, { agent: h.parent });
  assert.match(prompt, /local-fixture-secret/); assert.match(prompt, /tools\/list/); assert.match(prompt, /full input meaning/);
  assert.doesNotMatch(prompt, /请求率：0/);
});

// Additional host-pipeline regression: no real target requests, only local fetch fixtures.
test('host Skill recommendation -> read -> real dispatch -> evidence; no duplicate inference and no Laya approval bypass', async t => {
  const h = await fixture(t), oldFetch = globalThis.fetch;
  t.after(() => globalThis.fetch = oldFetch);
  process.env.DSH_SRC_TELEMETRY = 'shadow';
  process.env.DSH_SRC_LAYA_SKILL = 'on';
  process.env.DSH_SRC_LAYA_DECISION = 'on';
  const root = path.join(h.home, 'library');
  const file = 'skills/skill/知识库/zfixture.md';
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  const raw = '# zfixturetoken\n当前本地fixture问题的直接参考文档。';
  await fs.writeFile(path.join(root, file), raw);
  await fs.mkdir(path.join(h.home, 'capabilities'), { recursive: true });
  await fs.writeFile(path.join(h.home, 'capabilities/index.json'), JSON.stringify({ capabilities: [{ id: 'clown-src-playbook', kind: 'skill', dir: root, status: 'installed' }] }));
  await h.run('src_add_goal', { target: 'fixture.test', objective: 'zfixturetoken' });
  const intent = await h.run('src_add_intent', { title: 'zfixturetoken' });
  assert.equal(intent.isError,false,JSON.stringify(intent));
  let skillCalls = 0, actualRequests = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/decide')) {
      const body = JSON.parse(init.body);
      const criteria=body.questions.decision.criteria;
      if ('skip' in criteria) { skillCalls++; return new Response(JSON.stringify({ model:'jev-fixture',answers: { decision: { choice: 'doc-1', confidence: .99,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k==='doc-1'?1:0])) } } })); }
      return new Response(JSON.stringify({ model:'jev-fixture',answers: { decision: { choice: 'read', confidence: 1, probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k==='read'?1:0])) },risk:{choice:'low',confidence:1,probabilities:{low:1,high:0,unknown:0}},verdict:{choice:'allow',confidence:1,probabilities:{allow:1,pending:0}} } }));
    }
    assert.match(String(url), /^https?:\/\/fixture\.test/); actualRequests++;
    return new Response('fixture response', { headers: { 'content-type': 'text/plain' } });
  };
  const request = { method: 'GET', url: 'http://fixture.test/zfixturetoken', justification: 'zfixturetoken', intentId: intent.value.id };
  const first = await h.run('src_http', request);
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.match(first.value.skillHint, /zfixture.md/);
  assert.match(first.content[0].text, /Jev风险审批评估/);
  assert.equal(skillCalls, 1);
  const read = await h.run('src_read_capability', { id: 'clown-src-playbook', file });
  assert.equal(read.isError, false);
  assert.equal(skillReminderRegistry.isRead(h.parent.id, documentIdentity(root, file, raw)), true);
  const second = await h.run('src_http', { ...request, url: request.url + '?second=1' });
  assert.equal(second.isError, false);
  assert.equal(skillCalls, 1, 'same read document filtered before inference');
  assert.equal(actualRequests, 2);
  // Body keywords cannot turn a write into a read; high Laya confidence never approves it.
  const pending = await h.run('src_http', { url: 'http://fixture.test/deleteAccount', method: 'POST', body: '{"note":"query schema"}', justification: 'local pending fixture' });
  assert.equal(pending.value.approval, 'pending'); assert.equal(actualRequests, 2);
  const denied = await h.run('src_resolve_approval', { id: pending.value.pendingApprovalId, action: 'allow' });
  assert.equal(denied.isError, true); assert.equal(actualRequests, 2);
  process.env.DSH_SRC_ALLOW_LEGACY_MODEL_APPROVAL = '1';
  const stillDenied = await h.run('src_resolve_approval', { id: pending.value.pendingApprovalId, action: 'allow' });
  assert.equal(stillDenied.isError, true, 'no production test backdoor');
  const { issueApprovalGrant } = await import('../lib/src/approval-grants.js');
  const approved = await h.run('src_resolve_approval', { id: pending.value.pendingApprovalId, action: 'allow', approvalToken: issueApprovalGrant(h.parent.id, pending.value.pendingApprovalId, 'allow') });
  assert.equal(approved.isError, false, JSON.stringify(approved)); assert.equal(actualRequests, 3);
  const { flushDefaultTelemetry } = await import('../lib/src/telemetry/events.js');
  await flushDefaultTelemetry();
  const dir = path.join(h.home, 'storages/src-telemetry');
  const rows = (await Promise.all((await fs.readdir(dir)).map(f => fs.readFile(path.join(dir, f), 'utf8')))).join('\n').split('\n').filter(Boolean).map(JSON.parse);
  const recommended = rows.find(row => row.event === 'laya.decision' && row.payload.reminded);
  assert.ok(recommended?.payload.recommendationId);
  const id = recommended.payload.recommendationId;
  for (const event of ['skill.read', 'skill.next-action', 'skill.outcome']) assert.ok(rows.some(row => row.event === event && row.payload.recommendationId === id), event);
  assert.equal(rows.find(row => row.event === 'skill.next-action' && row.payload.recommendationId === id).payload.tool, 'src_http');
  assert.equal(rows.find(row => row.event === 'skill.outcome' && row.payload.recommendationId === id).payload.attribution, 'temporal-only');
});

test('host child lifecycle: failure is not completed; real checkpoint supersedes lifecycle notifications', async t => {
  const h = await fixture(t);
  const intent = (await h.run('src_add_intent', { title: 'lifecycle fixture' })).value;
  await h.run('src_recon', { intentId: intent.id, description: 'fixture', prompt: 'bounded task' });
  const childEvents = [];
  const child = { id: 'fixture-child', session: { id: 'fixture-child', header: { parentSession: h.parent.id }, append(type, data) { childEvents.push({ type, data }); } } };
  h.agents.set(child.id, child); h.ctx.sessions.get = id => id === child.id ? child.session : h.parent.session;
  h.ctx.emit('subagent/start', { id: child.id, runId: 'run-fixture', local: true, provider: 'spawn' });
  await new Promise(r => setTimeout(r, 15));
  let state = (await h.run('src_state', {})).value;
  assert.equal(state.intents.find(row => row.id === intent.id).status, 'running');
  h.ctx.emit('subagent/end', { id: child.id, runId: 'run-fixture', local: true, provider: 'spawn', stopReason: 'error' });
  await new Promise(r => setTimeout(r, 15));
  state = (await h.run('src_state', {})).value;
  assert.equal(state.intents.find(row => row.id === intent.id).status, 'failed');
  const checkpoint = await h.run('src_submit', { intentId: intent.id, stage: 'completed', summary: 'local fixture done', facts: [{ kind: 'info', detail: 'fixture evidence', target: 'fixture.test', confidence: .9 }] }, child);
  assert.equal(checkpoint.isError, false, JSON.stringify(checkpoint));
  h.ctx.emit('subagent/end', { id: child.id, runId: 'run-fixture', local: true, provider: 'spawn', stopReason: 'completed' });
  await new Promise(r => setTimeout(r, 15));
  state = (await h.run('src_state', {})).value;
  assert.equal(state.intents.find(row => row.id === intent.id).status, 'completed');
  assert.equal(state.intents.find(row => row.id === intent.id).executionSource, 'child-checkpoint');
});

test('Jev HTTP gate: parent/child low POST execute, unknown/high/failure wait, pending cannot replay itself',async t=>{
 const h=await fixture(t),old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 await saveDecisionSettings({riskMode:'on',skillMode:'off',delegateMode:'off'});
 let hits=0,verdict='allow',risk='low',effect='read',fail=false;
 globalThis.fetch=async(url,init)=>{
  if(String(url).includes('jev.fixture')){
   const incoming=JSON.parse(init.body);
   assert.equal(incoming.state.executionPolicy.targetScopeChecked,true);
   assert.equal(incoming.state.executionPolicy.lowRiskAutoApprovalGranted,true);
   if(fail)return new Response('unavailable',{status:503});
   const p=JSON.parse(init.body);const choices={decision:effect,risk,verdict,objectClass:'not-applicable'};
   return new Response(JSON.stringify({model:'jev-fixture',answers:Object.fromEntries(Object.entries(p.questions).map(([k,q])=>[k,{choice:choices[k],confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(option=>[option,option===choices[k]?1:0]))}]))}));
  }
  hits++;return new Response('fixture response');
 };
 const low=await h.run('src_http',{method:'POST',url:'https://fixture.test/compute',body:'{}',justification:'pure computation no effects'});
 assert.equal(low.value.approval,'allowed-auto');assert.equal(low.value.decisionAuthority,'jev-low-risk');assert.equal(hits,1);
 const child={id:'risk-child',session:{id:'risk-child',header:{parentSession:h.parent.id},append(){}}};
 const childLow=await h.run('src_http',{method:'POST',url:'https://fixture.test/child-compute',body:'{}',justification:'pure computation'},child);
 assert.equal(childLow.value.approval,'allowed-auto');assert.equal(hits,2);
 risk='unknown';verdict='pending';effect='unknown';
 const pending=await h.run('src_http',{method:'POST',url:'https://fixture.test/opaque',body:'{}',justification:'unknown effects'});assert.equal(pending.value.approval,'pending');assert.equal(hits,2);assert.match(pending.value.reason,/POST \/opaque/);assert.match(pending.value.reason,/risk=unknown/);assert.doesNotMatch(pending.value.reason,/高风险\/不确定\/矛盾结论转人工/);
 risk='low';verdict='allow';effect='read';
 const repeat=await h.run('src_http',{method:'POST',url:'https://fixture.test/opaque',body:'{}',justification:'try again'});assert.equal(repeat.value.pendingApprovalId,pending.value.pendingApprovalId);assert.equal(hits,2);
 risk='high';effect='destructive';
 const high=await h.run('src_http',{method:'GET',url:'https://fixture.test/action',justification:'possible harmful side effect'});assert.equal(high.value.approval,'pending');assert.equal(hits,2);
 fail=true;
 const outage=await h.run('src_http',{method:'GET',url:'https://fixture.test/public',justification:'read during outage'});assert.equal(outage.value.approval,'pending');assert.equal(hits,2);
 await saveDecisionSettings({riskMode:'shadow'});
 const shadow=await h.run('src_http',{method:'GET',url:'https://fixture.test/shadow',justification:'shadow read'});assert.equal(shadow.value.approval,'allowed-auto');assert.equal(shadow.value.riskAdvice,undefined);assert.equal(hits,3);
 const outside=await h.run('src_http',{method:'GET',url:'https://other.invalid/',justification:'not authorized'});assert.equal(outside.isError,true);assert.equal(hits,3);
});

test('regression 3291: child credential evidence goes to engagement; bad IDs and asset enums are actionable',async t=>{
 const h=await fixture(t),prev=globalThis.fetch;t.after(()=>globalThis.fetch=prev);
 await saveDecisionSettings({riskMode:'off',skillMode:'off',delegateMode:'off'});
 const intent=(await h.run('src_add_intent',{title:'credential fixture'})).value;
 const child={id:'credential-child',session:{id:'credential-child',header:{parentSession:h.parent.id},append(){}}};
 let hits=0;
 globalThis.fetch=async()=>{hits++;return new Response('login success',{status:200});};
 const bad=await h.run('src_http',{method:'GET',url:'https://fixture.test/',intentId:'goal-1',justification:'baseline'});
 assert.equal(bad.isError,true);assert.match(bad.content[0].text,/goal-\*.*已有intent.*intent-1/);assert.equal(hits,0);
 const asset=await h.run('src_add_asset',{type:'service',value:'https://fixture.test/',source:'user',method:'manual'});
 assert.equal(asset.isError,true);assert.match(asset.content[0].text,/passive|low-impact/);
 const result=await h.run('src_test_credential',{intentId:intent.id,loginUrl:'https://fixture.test/login',username:'fixture-user',candidates:['fixture-pass'],dictionarySource:'isolated fixture'},child);
 assert.equal(result.isError,false,JSON.stringify(result));assert.equal(hits,1);
 const state=(await h.run('src_state',{})).value;
 assert.ok(state.facts.some(row=>row.intentId===intent.id));assert.ok(state.coverage.some(row=>row.phase==='credential-test'));
 assert.ok(h.events.some(r=>r.type==='tool/call'&&r.data.name==='src_add_fact'&&r.data.callId?.startsWith('src-submit-')));
});

test('regression 3291: resident child turn error marks failed before subagent/end',async t=>{
 const h=await fixture(t);
 const intent=(await h.run('src_add_intent',{title:'resident failed child'})).value;
 await h.run('src_recon',{intentId:intent.id,description:'fixture',prompt:'bounded task'});
 const child={id:'fixture-child',header:{parentSession:h.parent.id},events:[]};
 const ended={type:'turn/end',data:{reason:{kind:'error',error:{code:'INVALID_REQUEST',message:'fixture reasoning protocol error'}}}};
 child.events.push(ended);
 h.ctx.emit('session/event',child,ended);
 await new Promise(r=>setTimeout(r,20));
 const state=(await h.run('src_state',{})).value;
 assert.equal(state.intents.find(row=>row.id===intent.id).status,'failed');
 const {childTurnFailure}=await import('../lib/src/child-outcome.js');
 assert.equal(childTurnFailure(child).code,'INVALID_REQUEST');
 child.events.push({type:'turn/start'});assert.equal(childTurnFailure(child),undefined,'new turn is not old failure');
});

test('research records for different findings do not overwrite each other', async t => {
 const h = await fixture(t);
 const intent = (await h.run('src_add_intent', { title:'research identity fixture' })).value;
 const first = (await h.run('src_add_finding', { intentId:intent.id, title:'first', severity:'low', description:'first', impact:'A sufficiently detailed impact description for the first finding.', affectedScope:'fixture.test', remediation:'fix first', pocEvidence:['obs-1'], reproducibleSteps:['step'], rawRequest:'GET /one HTTP/1.1', victimImpact:'A sufficiently detailed victim impact description for first.', attackPrerequisites:'network access only', concreteLossEvidence:[] })).value;
 const second = (await h.run('src_add_finding', { intentId:intent.id, title:'second', severity:'low', description:'second', impact:'A sufficiently detailed impact description for the second finding.', affectedScope:'fixture.test', remediation:'fix second', pocEvidence:['obs-2'], reproducibleSteps:['step'], rawRequest:'GET /two HTTP/1.1', victimImpact:'A sufficiently detailed victim impact description for second.', attackPrerequisites:'network access only', concreteLossEvidence:[] })).value;
 await h.run('src_record_research', { intentId:intent.id, category:'authz', hypothesis:'first hypothesis', findingId:first.id, status:'verified' });
 await h.run('src_record_research', { intentId:intent.id, category:'authz', hypothesis:'second hypothesis', findingId:second.id, status:'testing' });
 const state = (await h.run('src_state',{})).value;
 assert.equal(state.research.filter(row => row.category === 'authz').length, 2);
 const evidenceRead = await h.run('src_get_evidence', {ids: [state.research.find(row => row.category === 'authz').id]});
 assert.equal(evidenceRead.isError, false);
 assert.match(evidenceRead.content[0].text, /intentId=intent-1/);
 assert.match(evidenceRead.content[0].text, /findingId=finding-1/);
 assert.match(evidenceRead.content[0].text, /结论\/停止原因/);
 assert.deepEqual(new Set(state.research.filter(row => row.category === 'authz').map(row => row.findingId)), new Set([first.id, second.id]));
});

test('rejected findings are excluded from finalize verification and report', async t => {
 const h = await fixture(t);
 const intent = (await h.run('src_add_intent', { title:'rejected finalize fixture' })).value;
 const finding = (await h.run('src_add_finding', { intentId:intent.id, title:'rejected candidate', severity:'low', description:'candidate', impact:'A sufficiently detailed impact description for a rejected candidate.', affectedScope:'fixture.test', remediation:'fix', pocEvidence:['obs'], reproducibleSteps:['step'], rawRequest:'GET /rejected HTTP/1.1', victimImpact:'A sufficiently detailed victim impact description for the rejected candidate.', attackPrerequisites:'network access only', concreteLossEvidence:[] })).value;
 await h.run('src_reject_finding', { findingId:finding.id, reason:'duplicate; retain as rejected history' });
 const finalized = (await h.run('src_finalize_engagement', { remainingDirections:[], blindSpots:[{dimension:'http-authz-surface',status:'notApplicable'},{dimension:'cors-headers',status:'notApplicable'},{dimension:'dom-xhr',status:'notApplicable'},{dimension:'dict-budget',status:'notApplicable'},{dimension:'multi-account-cross-authz',status:'notApplicable'}], allowIncomplete:true, allowIncompleteReason:'fixture' })).value;
 assert.doesNotMatch(finalized.blockers.join('\\n'), /finding 缺少独立 verified/);
 const report = (await h.run('src_report',{})).value.markdown;
 assert.doesNotMatch(report, /rejected candidate/);
});
