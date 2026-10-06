import { createHmac } from 'node:crypto';
import { EgressLedger } from './ledger.js';
import { frozenPlanCodec } from './frozen-plan.js';
import { normalizePlan, canonicalRequest, requestDigest, resourceDigest, requiresHuman, assertScanExecutable, assertScopeCurrent, gateError } from './plan.js';
import { safetyRequests } from './safety-plan.js';
import { allowsLowImpact, reviewSummary } from './decision-policy.js';
import { assessEgressPlan } from './advisor.js';
import { createAssessmentQueue } from './assessment-queue.js';

// Host-only factory. commandPlane MUST NOT be exposed to tools or the proxy API.
// scopeFor is trusted user-authorized scope, not model-created asset inventory.
export function createEgressBroker({ filename, key, scopeFor, assess = assessEgressPlan, now = Date.now }) {
  if (!Buffer.isBuffer(key) || key.length < 32 || typeof scopeFor !== 'function') throw gateError('INVALID_BROKER_CONFIG');
  key = Buffer.from(key);
  const mac = value => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  const ledger = new EgressLedger(filename, mac('ledger-key-id')), codec = frozenPlanCodec(key);
  let closed = false;
  const assessments = createAssessmentQueue();
  const open = () => { if (closed) throw gateError('CLOSED'); };
  const sessionKey = session => { if (typeof session !== 'string' || !session || session.length > 256) throw gateError('INVALID_SESSION'); return session; };
  // Scope provider is synchronous so no revocation race occurs between check and CAS.
  function scope(session) {
    const value = scopeFor(session);
    if (!value || typeof value.then === 'function') throw gateError('INVALID_SCOPE_PROVIDER');
    return value;
  }
  function current(session, id, checkScope = true) {
    open(); sessionKey(session);
    const row = ledger.get(session, id);
    if (['completed_tool', 'completed_read'].includes(row.state)) throw gateError('UNKNOWN_TASK');
    const saved = codec.open(session, row.digest, row.manifest.frozen);
    if (checkScope) assertScopeCurrent(saved.value, scope(session));
    return { ...saved, digest: row.digest, row };
  }
  function manifestFor(session, digest, value, review, resume, implicitRead = false) {
    return { implicitRead, lane: value.hostExecution ? 'host' : 'proxy', lifetimeMs: value.lifetimeMs,
      expiresAt: null, maxRequests: value.maxRequests, minIntervalMs: value.minIntervalMs,
      frozen: codec.seal(session, digest, { value, review, resume }),
      entries: value.entries.map(entry => {
        const auxiliary=!!value.hostExecution&&JSON.stringify(entry.request)!==JSON.stringify(value.hostExecution.request);
        // 兼容账本字段名：safeRead表示Jev明确确认的无副作用读取/计算，不是HTTP方法白名单。
        const safeRead=['GET','HEAD','OPTIONS','POST'].includes(entry.request.method)&&!requiresHuman({entries:[entry]})&&(auxiliary||['read','compute'].includes(review.effect)&&review.risk==='low'&&review.action==='allow'&&!review.fallback&&review.mode==='on');
        return {digest:requestDigest(key,entry.request),resource:resourceDigest(key,entry.request),maxRequests:entry.maxRequests,used:0,auxiliary,safeRead};
      }) };
  }
  async function propose(session, input, exec = {}, { implicitRead = false, resume = null } = {}) {
    open(); sessionKey(session); exec.signal?.throwIfAborted();
    const plan = normalizePlan(input, scope(session));
    const release = await assessments.acquire(exec.signal);
    try {
      open(); exec.signal?.throwIfAborted(); assertScopeCurrent(plan, scope(session));
      // Never hand a mutable authorization object to an advisor.
      let advice;
      try { advice = await assess(structuredClone(plan), exec); }
      catch { advice = { fallback: true }; }
      open(); exec.signal?.throwIfAborted(); assertScopeCurrent(plan, scope(session));
      const automatic = (!plan.hostExecution || ['read','compute'].includes(plan.hostExecution.safety?.effect)) && !requiresHuman(plan) && allowsLowImpact(advice);
      const digest = mac([session, plan, resume]);
      const review = reviewSummary(advice, { hardVeto: requiresHuman(plan), hostExecution: !!plan.hostExecution });
      const manifest = manifestFor(session, digest, plan, review, resume, implicitRead === true && automatic && plan.maxRequests === 1 && plan.entries.length === 1);
      manifest.automatic=automatic;
      const result = ledger.add(session, digest, manifest, automatic ? 'active' : 'pending');
      return { ...result, review, reason: result.state === 'active' ? 'bounded-low-risk-plan' : 'human-review-required' };
    } finally { release(); }
  }
  function prepareSingle(session, id, safety) {
    const previous = current(session, id);
    const original = previous.value.hostExecution?.request ?? previous.value.entries[0]?.request;
    if (!previous.value.hostExecution && (previous.value.entries.length !== 1 || previous.value.maxRequests !== 1)) throw gateError('NOT_SINGLE_REQUEST');
    const entries = safetyRequests(original, safety);
    const plan = normalizePlan({ entries, maxRequests: entries.reduce((n, e) => n + e.maxRequests, 0), minIntervalMs: previous.value.minIntervalMs,
      lifetimeMs: previous.value.lifetimeMs, purpose: previous.value.purpose, hostExecution: { request: original, safety: safety ?? null } }, scope(session));
    const digest = mac([session, plan, previous.resume]);
    return ledger.supersede(session, id, previous.digest, digest, manifestFor(session, digest, plan, previous.review, previous.resume));
  }
  function claim(session, id, input, lane = 'proxy') {
    const plan = current(session, id), request = canonicalRequest(input);
    const result = ledger.claim(session, id, requestDigest(key, request), new URL(request.url).origin, now(), lane);
    return { ...result, taskId: id, planDigest: plan.digest, scopeRevision: plan.value.scopeRevision, credentialRevision: plan.value.credentialRevision };
  }
  return {
    propose, prepareSingle,
    startToolTask(session, id, input) {
      const plan = current(session, id), expected = normalizePlan(input, scope(session));
      if (JSON.stringify(expected) !== JSON.stringify(plan.value)) throw gateError('PLAN_CHANGED');
      // CAS and start timestamp are durable, including tools that send nothing.
      return ledger.startTool(session, id, now());
    },
    selectShellTask(session,id,input) {
      const plan=current(session,id),expected=normalizePlan(input,scope(session));
      if(!plan.resume?.shell||JSON.stringify(expected)!==JSON.stringify(plan.value))throw gateError('PLAN_CHANGED');
      if(plan.row.state!=='active'||plan.row.used||plan.row.manifest.toolStarted)throw gateError('TASK_NOT_AUTHORIZED');
      return {id,state:'active',expiresAt:plan.row.expires||null};
    },
    startShellTask(session,id) {
      const plan=current(session,id);
      if(!plan.resume?.shell)throw gateError('PLAN_CHANGED');
      return ledger.startTool(session,id,now());
    },
    completeToolTask(session, id) {
      const plan = current(session, id);
      if (!plan.row.manifest.toolStarted) throw gateError('UNKNOWN_TASK');
      return ledger.completeTool(session, id);
    },
    hasActiveTasks(session, taskId) { open(); return ledger.hasActive(sessionKey(session), taskId, now()); },
    find(session, input) { open(); return ledger.find(sessionKey(session), requestDigest(key, input)); },
    dataPlane: Object.freeze({ claim: (session, id, input) => claim(session, id, input, 'proxy'),
      finish(session, dispatchId, outcome) { open(); return ledger.finish(sessionKey(session), dispatchId, outcome, now()); } }),
    commandPlane: Object.freeze({
      bindApproval(session, id, approvalId) { current(session, id); ledger.bindApproval(session, id, approvalId); },
      binding(session, id, checkScope = true) {
        const plan = current(session, id, checkScope);
        return { sessionId: session, taskId: id, digest: plan.digest, hostExecution: plan.value.hostExecution,
          review: plan.review, resume: plan.resume, approvalId: plan.row.manifest.approvalId, automatic: plan.row.manifest.automatic===true&&plan.row.manifest.humanApproved!==true };
      },
      history(session, id) {
        open(); const task = ledger.get(sessionKey(session), id);
        return { id: task.id, state: task.state, used: task.used, maxRequests: task.manifest.maxRequests, expiresAt: task.expires || null };
      },
      inspect(session, id, checkScope = true) {
        const { value, row } = current(session, id, checkScope), { frozen, ...manifest } = row.manifest;
        return { ...row, manifest, expires: row.expires || null, plan: value };
      },
      decide(session, id, digest, action) {
        const plan = current(session, id, action === 'allow');
        if (action === 'allow' && plan.value.hostExecution && !plan.value.hostExecution.safety) throw gateError('SAFETY_PLAN_REQUIRED');
        if (action === 'allow' && !plan.value.hostExecution) assertScanExecutable(plan.value);
        return ledger.decide(session, id, digest, action, now());
      },
      reconcile(session, id, disposition, evidence) { open(); return ledger.reconcile(sessionKey(session), id, disposition, evidence, now()); },
      completeHost(session, id) { open(); return ledger.completeTool(sessionKey(session), id); },
      quarantine(session, id) { open(); return ledger.quarantine(sessionKey(session), id); },
      claimHost(session, id, request) { return claim(session, id, request, 'host'); },
      revoke(session, id) { open(); ledger.revoke(sessionKey(session), id); },
    }),
    close() { if (!closed) { closed = true; assessments.close(); ledger.close(); codec.close(); key.fill(0); } },
  };
}
