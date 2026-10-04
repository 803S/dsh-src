import { createHmac } from 'node:crypto';
import { EgressLedger } from './ledger.js';
import { normalizePlan, canonicalRequest, requestDigest, resourceDigest, requiresHuman, assertScanExecutable, assertScopeCurrent, gateError } from './plan.js';
import { safetyRequests } from './safety-plan.js';
import { jevDecide } from '../decision/jev-client.js';

// Host-only factory. commandPlane MUST NOT be exposed to tools or the proxy API.
// scopeFor is trusted user-authorized scope, not model-created asset inventory.
export function createEgressBroker({ filename, key, scopeFor, assess = (plan, exec) => jevDecide({ taskType: 'scan-plan', plan, scopeChecked: true }, exec), now = Date.now }) {
  if (!Buffer.isBuffer(key) || key.length < 32 || typeof scopeFor !== 'function') throw gateError('INVALID_BROKER_CONFIG');
  key = Buffer.from(key);
  const mac = value => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  const ledger = new EgressLedger(filename, mac('ledger-key-id'));
  const plans = new Map();
  let closed = false, evaluations = 0;
  const open = () => { if (closed) throw gateError('CLOSED'); };
  const sessionKey = session => { if (typeof session !== 'string' || !session || session.length > 256) throw gateError('INVALID_SESSION'); return session; };
  // Scope provider is synchronous so no revocation race occurs between check and CAS.
  function scope(session) {
    const value = scopeFor(session);
    if (!value || typeof value.then === 'function') throw gateError('INVALID_SCOPE_PROVIDER');
    return value;
  }
  function current(session, id) {
    open(); sessionKey(session);
    const plan = plans.get(id);
    if (!plan || plan.session !== session) throw gateError('UNKNOWN_TASK');
    assertScopeCurrent(plan.value, scope(session), now());
    return plan;
  }
  async function propose(session, input, exec = {}) {
    open(); sessionKey(session);
    exec.signal?.throwIfAborted();
    for(const [id,plan] of plans)if(plan.value.expiresAt<=now())plans.delete(id);
    if(plans.size>=128)throw gateError('PLAN_CAPACITY');
    if(evaluations>=4)throw gateError('ASSESSMENT_CAPACITY');
    const plan = normalizePlan(input, scope(session), now());
    evaluations++;
    try {
    // Never hand a mutable authorization object to an advisor.
    let advice;
    try { advice = await assess(structuredClone(plan), exec); }
    catch { advice = { fallback: true }; }
    open(); exec.signal?.throwIfAborted();
    assertScopeCurrent(plan, scope(session), now());
    const automatic = !plan.hostExecution && !requiresHuman(plan) && advice?.fallback === false && advice.mode === 'on'
      && advice.action === 'allow' && advice.risk === 'low' && advice.effect === 'read'
      && Number.isFinite(advice.confidence) && advice.confidence >= 0.9 && advice.confidence <= 1;
    const digest = mac([session, plan]);
    const manifest = { lane:plan.hostExecution?'host':'proxy', expiresAt: plan.expiresAt, maxRequests: plan.maxRequests, minIntervalMs: plan.minIntervalMs,
      entries: plan.entries.map(entry => ({ digest: requestDigest(key, entry.request), resource: resourceDigest(key, entry.request), maxRequests: entry.maxRequests, used: 0 })) };
    if(plans.size>=128)throw gateError('PLAN_CAPACITY');
    const result = ledger.add(session, digest, manifest, automatic ? 'active' : 'pending');
    plans.set(result.id, { session, value: plan, digest });
    return { ...result, reason: result.state === 'active' ? 'bounded-low-risk-plan' : 'human-review-required' };
    } finally { evaluations--; }
  }
  function prepareSingle(session,id,safety) {
    const previous=current(session,id);
    const original=previous.value.hostExecution?.request??previous.value.entries[0]?.request;
    if(!previous.value.hostExecution&&(previous.value.entries.length!==1||previous.value.maxRequests!==1))throw gateError('NOT_SINGLE_REQUEST');
    const entries=safetyRequests(original,safety);
    const plan=normalizePlan({entries,maxRequests:entries.reduce((n,e)=>n+e.maxRequests,0),minIntervalMs:previous.value.minIntervalMs,
      lifetimeMs:Math.min(300000,previous.value.expiresAt-now()),purpose:previous.value.purpose,hostExecution:{request:original,safety:safety??null}},scope(session),now());
    const digest=mac([session,plan]);
    const manifest={lane:'host',expiresAt:plan.expiresAt,maxRequests:plan.maxRequests,minIntervalMs:plan.minIntervalMs,
      entries:plan.entries.map(entry=>({digest:requestDigest(key,entry.request),resource:resourceDigest(key,entry.request),maxRequests:entry.maxRequests,used:0}))};
    const result=ledger.supersede(session,id,previous.digest,digest,manifest);
    plans.delete(id);plans.set(result.id,{session,value:plan,digest});
    return result;
  }
  function claim(session, id, input, lane = 'proxy') {
    const plan = current(session, id);
    const request = canonicalRequest(input);
    const result = ledger.claim(session, id, requestDigest(key, request), new URL(request.url).origin, now(), lane);
    return { ...result, taskId: id, planDigest: plan.digest, scopeRevision:plan.value.scopeRevision,credentialRevision:plan.value.credentialRevision };
  }
  return {
    // Called by trusted SRC tools to submit a plan; it grants no human approval.
    propose,
    prepareSingle,
    hasActiveTasks(session){
      open();sessionKey(session);
      for(const [id,plan] of plans){
        if(plan.session!==session||plan.value.expiresAt<=now())continue;
        const row=ledger.get(session,id);
        if(row.state==='active'&&row.used<row.manifest.maxRequests)return true;
      }
      return false;
    },
    // Host-only lookup. The client never selects another session or task.
    find(session, input) {
      open(); sessionKey(session);
      const digest = requestDigest(key, input);
      return ledger.find(session,digest);
    },
    dataPlane: Object.freeze({ claim:(session,id,input)=>claim(session,id,input,'proxy'), finish(session, dispatchId, outcome) { open(); sessionKey(session); ledger.finish(session, dispatchId, outcome, now()); } }),
    commandPlane: Object.freeze({
      inspect(session, id) { const plan = current(session, id); return { ...ledger.get(session, id), plan: structuredClone(plan.value) }; },
      decide(session, id, digest, action) { const plan = current(session, id); if(action==='allow'&&plan.value.hostExecution&&!plan.value.hostExecution.safety)throw gateError('SAFETY_PLAN_REQUIRED'); if (action === 'allow' && !plan.value.hostExecution) assertScanExecutable(plan.value); return ledger.decide(session, id, digest, action, now()); },
      reconcile(session,id,disposition,evidence) {open();const result=ledger.reconcile(sessionKey(session),id,disposition,evidence,now());plans.delete(id);return result;},
      quarantine(session,id) { open(); return ledger.quarantine(sessionKey(session),id); },
      claimHost(session,id,request) { return claim(session,id,request,'host'); },
      revoke(session, id) { open(); ledger.revoke(sessionKey(session), id); },
    }),
    close() { if (!closed) { closed = true; plans.clear(); ledger.close(); key.fill(0); } },
  };
}
