import { createHmac } from 'node:crypto';
import { EgressLedger } from './ledger.js';
import { frozenPlanCodec } from './frozen-plan.js';
import { normalizePlan, canonicalRequest, requestDigest, resourceDigest, requiresHuman, assertScanExecutable, assertScopeCurrent, gateError } from './plan.js';
import { safetyRequests, reviewedReadSafety, humanReadSafety, assertReviewedSafety } from './safety-plan.js';
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
  const operation = request => requestDigest(key,{...request,headers:request.headers.filter(([name])=>!['x-trace-id','x-request-id','traceparent','tracestate','user-agent','accept','accept-encoding','referer','origin'].includes(name.toLowerCase()))});
  ledger.upgradeManifests((row,manifest)=>new Map(codec.open(row.session,row.digest,manifest.frozen).value.entries.map(e=>[requestDigest(key,e.request),operation(e.request)])));
  // 自定义租户/用户头也可能切换对象归属，不能只绑定Authorization/Cookie。
  const account = request => mac(request.headers.filter(([name])=>!['content-type','content-length','if-match','if-none-match','accept','accept-encoding','user-agent','connection','x-trace-id','x-request-id','traceparent','tracestate'].includes(name)));
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
    return { implicitRead, reviewVersion:113, operationVersion:2, lane: value.hostExecution ? 'host' : 'proxy', lifetimeMs: value.lifetimeMs,
      expiresAt: null, maxRequests: value.maxRequests, minIntervalMs: value.minIntervalMs,
      frozen: codec.seal(session, digest, { value, review, resume }),
      entries: value.entries.map(entry => {
        const auxiliary=!!value.hostExecution&&JSON.stringify(entry.request)!==JSON.stringify(value.hostExecution.request);
        // 兼容账本字段名：safeRead表示Jev明确确认的无副作用读取/计算，不是HTTP方法白名单。
        const safeRead=['GET','HEAD','OPTIONS','POST'].includes(entry.request.method)&&!requiresHuman({entries:[entry]})&&(auxiliary||['read','compute','unknown'].includes(review.effect)&&review.risk==='low'&&review.action==='allow'&&!review.fallback&&review.mode==='on');
        return {digest:requestDigest(key,entry.request),operation:operation(entry.request),resource:resourceDigest(key,entry.request),maxRequests:entry.maxRequests,used:0,auxiliary,safeRead};
      }) };
  }
  // 调用者持有现有审核队列名额；自动路径与人工路径共用同一组检查。
  async function assertHostExecutable(plan, review, exec) {
    const {request,safety}=plan.hostExecution;
    assertReviewedSafety(request,safety,review);
    const checks=safetyRequests(request,safety).filter(e=>requestDigest(key,e.request)!==requestDigest(key,request));
    for(const entry of checks){
      exec.signal?.throwIfAborted();
      const single={...plan,hostExecution:undefined,entries:[{...entry,maxRequests:1}],maxRequests:1,purpose:'审核冻结的前置检查/回读；GET/HEAD本身不证明无副作用'};
      let advice;
      try {advice=await assess(structuredClone(single),exec);}catch {advice={fallback:true};}
      exec.signal?.throwIfAborted();
      if(!['read','compute'].includes(advice?.effect)||!allowsLowImpact(advice,single)||requiresHuman(single))throw gateError('UNSAFE_SAFETY_READ');
    }
  }
  async function propose(session, input, exec = {}, { implicitRead = false, resume = null } = {}) {
    open(); sessionKey(session); exec.signal?.throwIfAborted();
    const plan = normalizePlan(input, scope(session));
    const release = await assessments.acquire(exec.signal);
    try {
      open(); exec.signal?.throwIfAborted(); assertScopeCurrent(plan, scope(session));
      // Never hand a mutable authorization object to an advisor.
      const owned=plan.entries.flatMap(({request})=>{
        if(!['PUT','PATCH','POST','DELETE'].includes(request.method))return [];
        const proof=ledger.testObject(session,request.url);
        return proof&&proof.etag===request.headers.find(([name])=>name==='if-match')?.[1]&&proof.account===account(request)&&proof.scopeRevision===plan.scopeRevision&&proof.credentialRevision===plan.credentialRevision?[proof]:[];
      });
      let advice;
      try { advice = await assess(structuredClone(plan), {...exec,verifiedTestObjects:owned.map(({url,etag,taskId})=>({url,etag,creationTaskId:taskId}))}); }
      catch { advice = { fallback: true }; }
      open(); exec.signal?.throwIfAborted(); assertScopeCurrent(plan, scope(session));
      const automatic = (!plan.hostExecution || ['read','compute'].includes(plan.hostExecution.safety?.effect)) && !requiresHuman(plan) && allowsLowImpact(advice,plan,owned);
      const digest = mac([session, plan, resume]);
      const review = reviewSummary(advice, { hardVeto: requiresHuman(plan), hostExecution: !!plan.hostExecution });
      if(automatic&&plan.hostExecution){
        await assertHostExecutable(plan,review,exec);
        open();exec.signal?.throwIfAborted();assertScopeCurrent(plan,scope(session));
      }
      const manifest = manifestFor(session, digest, plan, review, resume, implicitRead === true && automatic && ['read','compute','unknown'].includes(advice.effect) && plan.maxRequests === 1 && plan.entries.length === 1);
      manifest.automatic=automatic;
      if(automatic&&plan.hostExecution)manifest.automaticSafetyReviewed=true;
      if(automatic&&advice.objectClass==='owned-test-file')manifest.ownedTestObject=owned[0];
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
    find(session, input) {
      open();sessionKey(session);
      const blocked=ledger.operationBlock(session,{operation:operation(input),resource:resourceDigest(key,input)});
      return blocked?{id:blocked.id,digest:blocked.digest,state:blocked.state}:ledger.find(session,requestDigest(key,input));
    },
    observeResponse(session,grant,request,response) {
      const task=current(session,grant.taskId),review=task.review;
      if(!task.row.manifest.automatic||review.risk!=='low'||review.action!=='allow'||review.effect!=='write')return;
      const isNew=review.objectClass==='new-test-file';
      if(isNew?response.status!==201:review.objectClass!=='owned-test-file'||![200,204].includes(response.status))return;
      const etag=response.headers.get('etag');
      if(!etag||!/^"[\x21\x23-\x7e]{1,200}"$/.test(etag))return;
      let url;
      try{url=new URL(isNew?(response.headers.get('location')??(request.method==='PUT'?request.url:'')):request.url,request.url).href;}catch{return;}
      if(isNew&&!response.headers.get('location')&&request.method!=='PUT')return;
      if(new URL(url).origin!==new URL(request.url).origin)return;
      ledger.rememberTestObject(session,task.row.id,{url,etag,available:true,account:account(request),scopeRevision:task.value.scopeRevision,credentialRevision:task.value.credentialRevision});
    },
    dataPlane: Object.freeze({ claim: (session, id, input) => claim(session, id, input, 'proxy'),
      finish(session, dispatchId, outcome) { open(); return ledger.finish(sessionKey(session), dispatchId, outcome, now()); } }),
    commandPlane: Object.freeze({
      repairReadSafety(session, id, humanConfirmed = false) {
        const saved=current(session,id),execution=saved.value.hostExecution;
        if(!execution || execution.safety) return;
        const safety=humanConfirmed?humanReadSafety(execution.request,saved.review):reviewedReadSafety(execution.request,saved.review);
        if(!safety || saved.value.entries.length!==1 || saved.value.maxRequests!==1
          || requestDigest(key,saved.value.entries[0].request)!==requestDigest(key,execution.request))throw gateError('SAFETY_PLAN_REQUIRED');
        const value={...saved.value,hostExecution:{...execution,safety}},digest=mac([session,value,saved.resume]);
        const manifest={...saved.row.manifest,frozen:codec.seal(session,digest,{value,review:saved.review,resume:saved.resume})};
        ledger.repairPendingSafety(session,id,saved.digest,digest,manifest);
      },
      bindApproval(session, id, approvalId) { current(session, id); ledger.bindApproval(session, id, approvalId); },
      binding(session, id, checkScope = true) {
        const plan = current(session, id, checkScope);
        return { sessionId: session, taskId: id, digest: plan.digest, hostExecution: plan.value.hostExecution,
          review: plan.review, resume: plan.resume, approvalId: plan.row.manifest.approvalId, automatic: plan.row.manifest.automatic===true&&plan.row.manifest.humanApproved!==true,
          automaticSafetyReviewed:plan.row.manifest.automaticSafetyReviewed===true };
      },
      history(session, id) {
        open(); const task = ledger.get(sessionKey(session), id);
        return { id: task.id, state: task.state, used: task.used, maxRequests: task.manifest.maxRequests, expiresAt: task.expires || null };
      },
      inspect(session, id, checkScope = true) {
        const { value, row } = current(session, id, checkScope), { frozen, ...manifest } = row.manifest;
        return { ...row, manifest, expires: row.expires || null, plan: value };
      },
      restoreUnsent(session,id,checkScope=true) { current(session,id,checkScope);return ledger.restoreUnsent(session,id); },
      async assertExecutable(session,id,exec={},options={}) {
        const plan=current(session,id);
        if(plan.value.hostExecution){
          const release=await assessments.acquire(exec.signal);
          try {
            const humanReviewCanRun=options.humanApproved===true&&!plan.value.hostExecution.safety&&!['PUT','PATCH','DELETE'].includes(plan.value.hostExecution.request.method)&&['read','compute','external'].includes(plan.review.effect);
            if(!humanReviewCanRun) await assertHostExecutable(plan.value,plan.review,exec);
            current(session,id);
          } finally {release();}
        }
        else {
          if(['write','destructive','external','auth'].includes(plan.review.effect))throw gateError('WRITE_EXECUTOR_REQUIRED');
          assertScanExecutable(plan.value);
        }
      },
      decide(session, id, digest, action, confirmRead = false, humanApproved = false) {
        const plan = current(session, id, action === 'allow');
        if(action==='allow'){
          const humanReviewCanRun=humanApproved===true&&!!plan.value.hostExecution&&!plan.value.hostExecution.safety&&!['PUT','PATCH','DELETE'].includes(plan.value.hostExecution.request.method)&&['read','compute','external'].includes(plan.review.effect);
          if(plan.value.hostExecution && !humanReviewCanRun) assertReviewedSafety(plan.value.hostExecution.request,plan.value.hostExecution.safety,plan.review);
          else if(!humanReviewCanRun) {
            if(['write','destructive','external','auth'].includes(plan.review.effect))throw gateError('WRITE_EXECUTOR_REQUIRED');
            assertScanExecutable(plan.value);
          }
        }
        let humanReadDigest;
        if(confirmRead){
          const request=plan.value.hostExecution?.request;
          if(action!=='allow'||plan.value.entries.length!==1||plan.value.maxRequests!==1||!humanReadSafety(request,plan.review)||requestDigest(key,request)!==requestDigest(key,plan.value.entries[0].request))throw gateError('SAFETY_PLAN_REQUIRED');
          humanReadDigest=requestDigest(key,request);
        }
        return ledger.decide(session, id, digest, action, now(),humanReadDigest);
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
