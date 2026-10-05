import { createHmac } from 'node:crypto';
import { EgressLedger } from './ledger.js';
import { normalizePlan, canonicalRequest, requestDigest, resourceDigest, requiresHuman, assertScanExecutable, assertScopeCurrent, gateError } from './plan.js';
import { safetyRequests } from './safety-plan.js';
import { allowsLowImpactRead, reviewSummary } from './decision-policy.js';
import { assessEgressPlan } from './advisor.js';
import { createAssessmentQueue } from './assessment-queue.js';

// Host-only factory. commandPlane MUST NOT be exposed to tools or the proxy API.
// scopeFor is trusted user-authorized scope, not model-created asset inventory.
export function createEgressBroker({ filename, key, scopeFor, assess = assessEgressPlan, now = Date.now }) {
  if (!Buffer.isBuffer(key) || key.length < 32 || typeof scopeFor !== 'function') throw gateError('INVALID_BROKER_CONFIG');
  key = Buffer.from(key);
  const mac = value => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  const ledger = new EgressLedger(filename, mac('ledger-key-id'));
  const plans = new Map();
  let closed = false;
  const assessments=createAssessmentQueue();
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
  async function propose(session, input, exec = {}, { implicitRead = false } = {}) {
    open(); sessionKey(session);
    exec.signal?.throwIfAborted();
    for(const [id,plan] of plans)if(plan.value.expiresAt<=now())plans.delete(id);
    if(plans.size>=128)throw gateError('PLAN_CAPACITY');
    const plan = normalizePlan(input, scope(session), now());
    const release=await assessments.acquire(exec.signal);
    try {
    open();exec.signal?.throwIfAborted();assertScopeCurrent(plan,scope(session),now());
    if(plans.size>=128)throw gateError('PLAN_CAPACITY');
    // Never hand a mutable authorization object to an advisor.
    let advice;
    try { advice = await assess(structuredClone(plan), exec); }
    catch { advice = { fallback: true }; }
    open(); exec.signal?.throwIfAborted();
    assertScopeCurrent(plan, scope(session), now());
    const automatic = !plan.hostExecution && !requiresHuman(plan) && allowsLowImpactRead(advice);
    const digest = mac([session, plan]);
    const manifest = { implicitRead:implicitRead===true&&automatic&&plan.maxRequests===1&&plan.entries.length===1, lane:plan.hostExecution?'host':'proxy', expiresAt: plan.expiresAt, maxRequests: plan.maxRequests, minIntervalMs: plan.minIntervalMs,
      entries: plan.entries.map(entry => ({ digest: requestDigest(key, entry.request), resource: resourceDigest(key, entry.request), maxRequests: entry.maxRequests, used: 0 })) };
    if(plans.size>=128)throw gateError('PLAN_CAPACITY');
    const result = ledger.add(session, digest, manifest, automatic ? 'active' : 'pending');
    plans.set(result.id, { session, value: plan, digest });
    return { ...result, review:reviewSummary(advice,{hardVeto:requiresHuman(plan),hostExecution:!!plan.hostExecution}), reason: result.state === 'active' ? 'bounded-low-risk-plan' : 'human-review-required' };
    } finally { release(); }
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
    startToolTask(session,id,input){
      const plan=current(session,id);
      const expected=normalizePlan(input,scope(session),now());
      // A resume selects an existing frozen plan; it never renews its expiry.
      expected.expiresAt=plan.value.expiresAt;
      if(JSON.stringify(expected)!==JSON.stringify(plan.value))throw gateError('PLAN_CHANGED');
      const row=ledger.get(session,id);
      if(row.state!=='active')throw gateError('TASK_NOT_AUTHORIZED');
      if(plan.toolStarted||row.used!==0)throw gateError('TOOL_TASK_ALREADY_STARTED');
      plan.toolStarted=true;
      return {id,state:row.state,expiresAt:plan.value.expiresAt};
    },
    completeToolTask(session,id){
      open();sessionKey(session);
      const plan=plans.get(id);
      if(!plan||plan.session!==session||!plan.toolStarted)throw gateError('UNKNOWN_TASK');
      const result=ledger.completeTool(session,id);
      plans.delete(id);return result;
    },
    hasActiveTasks(session,taskId){
      open();sessionKey(session);
      for(const [id,plan] of plans){
        if(plan.session!==session||plan.value.expiresAt<=now()||(taskId&&id!==taskId))continue;
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
    dataPlane: Object.freeze({ claim:(session,id,input)=>claim(session,id,input,'proxy'), finish(session, dispatchId, outcome) { open(); sessionKey(session); const finished=ledger.finish(session, dispatchId, outcome, now());if(finished?.completedImplicitRead)plans.delete(finished.taskId); } }),
    commandPlane: Object.freeze({
      history(session,id){
        open();sessionKey(session);const task=ledger.get(session,id);
        return {id:task.id,state:task.state,used:task.used,maxRequests:task.manifest.maxRequests,expiresAt:task.expires};
      },
      inspect(session, id) { const plan = current(session, id); return { ...ledger.get(session, id), plan: structuredClone(plan.value) }; },
      decide(session, id, digest, action) { const plan = current(session, id); if(action==='allow'&&plan.value.hostExecution&&!plan.value.hostExecution.safety)throw gateError('SAFETY_PLAN_REQUIRED'); if (action === 'allow' && !plan.value.hostExecution) assertScanExecutable(plan.value); return ledger.decide(session, id, digest, action, now()); },
      reconcile(session,id,disposition,evidence) {open();const result=ledger.reconcile(sessionKey(session),id,disposition,evidence,now());plans.delete(id);return result;},
      quarantine(session,id) { open(); return ledger.quarantine(sessionKey(session),id); },
      claimHost(session,id,request) { return claim(session,id,request,'host'); },
      revoke(session, id) { open(); ledger.revoke(sessionKey(session), id); },
    }),
    close() { if (!closed) { closed = true; assessments.close(); plans.clear(); ledger.close(); key.fill(0); } },
  };
}
