import {assertKnownTarget} from './target-context.js';
import {explicitUserScope,domainGrant,withinDomain} from './user-scope.js';
// Host singleton: lifecycle, trusted scope, pending-row adapter and owned proxies.
// No model-facing setters for scope, decisions, ledger keys or process options.
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, open, rename, realpath, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import {ASSESSMENT_PENDING_LIMIT} from './assessment-queue.js';
import { createScopeRequests } from './scope-requests.js';
import { createEgressBroker } from './broker.js';
import { createProxyControlServer } from './control-server.js';
import { startSessionProxy } from './proxy-process.js';
import { canonicalRequest, gateError, requiresHuman, READ_METHODS } from './plan.js';
import { pinOrigin, pinnedLookup, validateStoredScope } from './scope.js';
/* [local.143] 公共车道（web_fetch / src_read_public_source）的代理发送器：命中代理清单的主机不做本机解析。 */
import { dispatchHttpViaProxy } from './http-dispatch.js';
import { proxyResponse } from './evidence.js';
import { isPublicLookup, publicLookup } from './public-lookup.js';
import { isLocalServeOrigin, localServePins } from './local-serve.js';
import { presentPlan } from './plan-presentation.js';
import { normalizeSafetyPlan, assertReviewedSafety, humanReadSafety, safetyRequests, executeApprovedRequest } from './safety-plan.js';
import { PENDING_CONTINUATION, APPROVAL_CHANNEL_ESCALATION, pendingSingleRequestNotice } from './notifications.js';
/* [local.143] 用途归属：系统默认说明不等于模型自述，也不得当作 justification 送判定服务。 */
import { isSystemDefaultPurpose, purposeAttribution, PURPOSE_SINGLE_CAPTURED, PURPOSE_PRECONDITION_REVIEW, PURPOSE_NO_SAFETY_MATERIAL } from './purpose.js';
/* [local.143] 当前工作线（意图/目标）→ 判定上下文；挑法与投影是纯函数，便于离线复算。 */
import { workContextFrom } from './session-work-context.js';
import { srcJevSessionContextFlag } from '../flags.js';
import { serviceOutage, raiseServiceOutage } from '../decision/service-outage.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOST_REQUEST=Symbol('host-request'), SINGLE_REQUEST=Symbol('single-request');
const hash = value => createHash('sha256').update(value).digest('hex');
/* [审计 2026-10-13 §2] 审批卡要让用户一眼看懂“这是什么操作”，而不是把 effect/risk 原样抛给用户。
 * 纯展示层：不改变授权，也不从文案推导权限；判定值仍原样保留在卡上供审计。 */
function describeReview(review) {
  const effect=review?.effect, objectClass=review?.objectClass;
  // 判定来源（审计 2026-10-14）：本地硬规则与判定服务失败不再混在 mode=unknown 里看不出区别。
  const basis=review?.authority==='hard-boundary'?'（本地确定性危害，判定服务无权覆盖）'
    :review?.authority==='hard-rules'?'（本地只读判定，未调用判定服务）'
    :review?.authority==='jev-unavailable'?`（判定服务不可用${review.errorType?`：${review.errorType}`:''}）`
    :'';
  const text=(()=>{
  if (effect === 'external-probe') return '有界外发探测：仅让目标回调我方控制的对端，不向真实第三方送达、不写业务数据';
  if (effect === 'auth') return '单次登录/注册验证';
  if (effect === 'read') return '只读取回';
  if (effect === 'compute') return '有界计算/校验';
  if (objectClass === 'new-test-file') return '创建新的测试标记，不覆盖既有对象';
  if (objectClass === 'owned-test-file') return effect === 'destructive' ? '清理本次创建、已登记归属的测试文件' : '修改已登记归属且版本匹配的测试文件';
  if (objectClass === 'business-or-unknown') return effect === 'destructive' ? '业务数据删除/破坏' : effect === 'external' ? '外发或费用类操作' : '业务数据写入，或对象归属不明';
  if (effect === 'external') return '外发或费用类操作';
  if (effect === 'destructive') return '删除/破坏/不可逆操作';
  if (effect === 'write') return '写入操作';
  return '影响未定的操作';
  })();
  return `${text}${basis}`;
}
/* [审计 2026-10-13 §2 续] 卡片曾把整段判定 JSON 直接倒给用户（`执行前判定{...}`）。
 * 人话在前、原始值在后：用户先看懂“这是什么操作、谁做的判定、有没有降级”，
 * 审计仍能拿到原样字段（不丢证据，也不靠文案反推权限）。 */
function describeVerdict(review) {
  if (!review || typeof review !== 'object') return '无判定记录（不会自动放行）';
  const parts = [];
  parts.push(`影响=${review.effect ?? 'unknown'}`);
  if (review.objectClass) parts.push(`对象类别=${review.objectClass}`);
  parts.push(`风险=${review.risk ?? 'unknown'}`);
  parts.push(`动作=${review.action ?? 'pending'}`);
  parts.push(review.fallback === true ? '判定服务降级(fallback)' : '判定服务正常');
  if (review.mode) parts.push(`模式=${review.mode}`);
  if (review.riskScore !== undefined) parts.push(`分值=${review.riskScore}`);
  return parts.join('；');
}

export async function createEgressManager({ home, assess, storeFor, directFetch, proxyFetch=dispatchHttpViaProxy, proxyExecutable, recordEvidence, appendApproval, allowLoopbackFixtures=false, lifecycle, restoreBurp, now=Date.now }) {
  lifecycle=await lifecycle;
  const root = path.join(home, 'control', 'src-egress');
  await mkdir(root, { recursive:true, mode:0o700 }); await chmod(root,0o700);
  const keyFile = path.join(root,'binding-key');
  try {
    const file=await open(keyFile,'wx',0o600);
    try {await file.writeFile(randomBytes(32));await file.sync();}finally {await file.close();}
    const directory=await open(root,'r');try {await directory.sync();}finally {await directory.close();}
  } catch(error) { if(error.code !== 'EEXIST') throw error; }
  const key = await readFile(keyFile);
  const scopes = new Map(), sessions = new Map(), pending = new Map(), preparation = new Map(), shellPlans = new Map(), deciding = new Set(), publishing = new Map();
  const networkObservers=new Map();
  function observeNetwork(session,record){for(const fn of networkObservers.get(session)??[])fn(record);}
  function watchNetwork(session,fn){
    const set=networkObservers.get(session)??new Set();set.add(fn);networkObservers.set(session,set);
    return ()=>{set.delete(fn);if(!set.size)networkObservers.delete(session);};
  }
  const scopeFile = path.join(root,'scopes.json');
  try {
    const saved = JSON.parse(await readFile(scopeFile,'utf8'));
    if (!Array.isArray(saved)) throw gateError('CORRUPT_SCOPES');
    for (const entry of saved){if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string')throw gateError('CORRUPT_SCOPES');scopes.set(entry[0],validateStoredScope(entry[1],{allowLoopbackFixtures}));}
  } catch(error) { if(error.code !== 'ENOENT') throw error; }
  const broker = createEgressBroker({filename:path.join(root,'ledger.sqlite'),key,now,scopeFor:session=>scopes.get(session),...(assess?{assess}:{})});
  key.fill(0);
  let closed = false, scopeWrite = Promise.resolve();
  const shutdown = new AbortController(),sessionControllers=new Map();
  const authorizationTicket=session=>lifecycle?.ticket(session,true)??(()=>{});
  function sessionSignal(session){
    authorizationTicket(session)();
    if(!sessionControllers.has(session))sessionControllers.set(session,new AbortController());
    return sessionControllers.get(session).signal;
  }
  const tracked = new Set(), activeProxies = new Set(), retiredProxies = new Set();
  const shellUsers = new Map();
  function track(work) { tracked.add(work); work.finally(()=>tracked.delete(work)).catch(()=>{}); return work; }
  function execution(exec={},session) { return {...exec,signal:AbortSignal.any([...(exec.signal?[exec.signal]:[]),shutdown.signal,...(session?[sessionSignal(session)]:[])])}; }
  function prunePending() {
    while(pending.size>=128)pending.delete(pending.keys().next().value);
  }
  const ensureOpen = () => { if(closed) throw gateError('CLOSED'); };
  function lockApproval(session,approvalId){
    const identity=`${session}:${approvalId}`;
    if(deciding.has(identity))throw gateError('STALE_APPROVAL');
    deciding.add(identity);
    return ()=>deciding.delete(identity);
  }
  function requireScope(session) {
    ensureOpen(); authorizationTicket(session)(); const scope = scopes.get(session);
    if(!scope?.origins?.length&&!scope?.readOrigins?.length) throw gateError('USER_SCOPE_REQUIRED');
    return scope;
  }
  function boundPins(session,url,grant) {
    const scope=requireScope(session);
    if(scope.revision!==grant.scopeRevision||scope.credentialRevision!==grant.credentialRevision)throw gateError('SCOPE_CHANGED');
    const origin=new URL(url).origin;
    // 本机 POC 托管 origin 不在持久化 scope 里（私网 pin 不能入库），目的地直接由注册表给出。
    const pins=scope.pins[origin]??localServePins(origin);
    if(!pins)throw gateError('OUT_OF_SCOPE');
    return pins;
  }
  async function setUserScope(session, origins, {ifAbsent=false,extend=false,domains=[],excludedDomains=[],readOnly=false}={}) {
    ensureOpen();const current=authorizationTicket(session);
    if(typeof session !== 'string' || !session || !Array.isArray(origins) || (!origins.length&&!domains.length&&!excludedDomains.length) || origins.length > 256) throw gateError('INVALID_SCOPE');
    domains=[...new Set(domains.map(domainGrant))];
    excludedDomains=[...new Set(excludedDomains.map(domainGrant))];
    const exact = [...new Set(origins.map(origin=>{
      const url = new URL(origin);
      if(!['https:','http:'].includes(url.protocol)||url.origin!==origin)throw gateError('INVALID_SCOPE');
      return origin;
    }))].sort();
    if(!scopes.has(session)&&scopes.size>=1024)throw gateError('SCOPE_CAPACITY');
    const pins={};
    for(const origin of exact)pins[origin]=await pinOrigin(origin,{allowLoopbackFixtures});
    // Serialize persistence and publish only after atomic replacement.
    const work = scopeWrite.catch(()=>{}).then(async()=>{
      ensureOpen();current();
      if(ifAbsent&&(scopes.get(session)?.origins.length||scopes.get(session)?.domains?.length))throw gateError('STALE_APPROVAL');
      if(!scopes.has(session)&&scopes.size>=1024)throw gateError('SCOPE_CAPACITY');
      const next = new Map(scopes);
      const previous=extend?scopes.get(session):undefined;
      // readOnly：只读通道（readOrigins）自动记录已访问 origin——授权读，不授权写。
      const merged=readOnly?[...new Set(previous?.origins??[])].sort():[...new Set([...(previous?.origins??[]),...exact])].sort();
      const mergedRead=[...new Set([...(previous?.readOrigins??[]),...(readOnly?exact:[])])].sort();
      if(merged.length>256||mergedRead.length>256||new Set([...(previous?.domains??[]),...domains]).size>256)throw gateError('SCOPE_CAPACITY');
      const excluded=[...new Set([...(previous?.excludedDomains??[]),...excludedDomains])];
      if(excluded.length>256)throw gateError('SCOPE_CAPACITY');
      next.set(session,{origins:merged,readOrigins:mergedRead,pins:{...previous?.pins,...pins},domains:[...new Set([...(previous?.domains??[]),...domains])],excludedDomains:excluded,revision:excludedDomains.length?randomUUID():previous?.revision??randomUUID(),credentialRevision:previous?.credentialRevision??randomUUID()});
      const temporary=scopeFile+'.'+randomUUID()+'.tmp';
      try {
        const file=await open(temporary,'wx',0o600);
        try { await file.writeFile(JSON.stringify([...next])); await file.sync(); } finally { await file.close(); }
        ensureOpen();current(); await rename(temporary,scopeFile);
        const directory=await open(root,'r');try {await directory.sync();}finally {await directory.close();}
      }
      finally { await rm(temporary,{force:true}); }
      current();scopes.set(session,next.get(session));
      return structuredClone(next.get(session));
    });
    scopeWrite=work;return work;
  }
  const unsubscribe=lifecycle?.subscribe(async(ids,{deleteAuthorization}={})=>{
    if(!deleteAuthorization||closed)return;
    const removed=new Set(ids),proxies=[];
    for(const session of removed){
      scopes.delete(session);sessionControllers.get(session)?.abort(gateError('SESSION_REVOKED'));sessionControllers.delete(session);
      shellPlans.delete(session);
    }
    for(const [id,binding] of pending){
      if(removed.has(binding.sessionId)){broker.commandPlane.revoke(binding.sessionId,binding.taskId);pending.delete(id);}
    }
    for(const [identity,work] of sessions){
      if(!removed.has(JSON.parse(identity)[0]))continue;
      sessions.delete(identity);activeProxies.delete(identity);shellUsers.delete(identity);
      retiredProxies.add(work);
      proxies.push(work.then(proxy=>proxy.retire(),error=>{if(error.code!=='SRC_GATE_BROWSER_SESSION_RESET')throw error;}));
    }
    const persist=scopeWrite.catch(()=>{}).then(async()=>{
      const temporary=scopeFile+'.'+randomUUID()+'.tmp';
      try{
        const file=await open(temporary,'wx',0o600);
        try{await file.writeFile(JSON.stringify([...scopes]));await file.sync();}finally{await file.close();}
        await rename(temporary,scopeFile);
        const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}
      }finally{await rm(temporary,{force:true});}
    });
    scopeWrite=persist;
    const results=await Promise.allSettled([persist,...proxies]);
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  });
  const scopeRequests=createScopeRequests({storeFor,setScope:setUserScope,getScope:session=>scopes.get(session),ticket:authorizationTicket});
  async function ensureRequestScope(session,requests){
    // 请求以 {url,method} 形式传入：范围只约束写/影响类方法。
    const list=(requests??[]).map(value=>typeof value==='string'?{url:value,method:undefined}:value);
    const read=target=>READ_METHODS.has(String(target.method??'').toUpperCase());
    for(const target of list)assertKnownTarget(scopes.get(session),target.url,{method:target.method,allowUnscopedLoopback:allowLoopbackFixtures});
    // 本机 POC 托管 origin 先摘出去：它不属外部目标，不建范围卡、不写范围。
    const external=list.filter(target=>!isLocalServeOrigin(new URL(target.url).origin));
    const writes=external.filter(target=>!read(target)),reads=external.filter(read);
    // 写类才走「没有声明范围就先问用户」；纯只读的第一次请求不再挂范围卡。
    if(writes.length)await scopeRequests.require(session,writes.map(target=>target.url));
    else if(reads.length)await scopeRequests.require(session,reads.map(target=>target.url),{advisory:true});
    const scope=scopes.get(session)??{origins:[],readOrigins:[],domains:[]};
    const inDomain=origin=>(scope.domains??[]).some(domain=>withinDomain(new URL(origin).hostname,domain));
    // 人类声明过的注册域：域内 origin 直接进写入范围（读写在域内一视同仁）。
    const granted=[...new Set(external.map(target=>new URL(target.url).origin))].filter(origin=>!(scope.origins??[]).includes(origin)&&inDomain(origin));
    if(granted.length)await setUserScope(session,granted,{extend:true});
    // 域外只读：只记只读通道（授权读，不授权写）。本机 POC 托管 origin 不入库：它不是外部目标，
    // 且私网 pin 会被 validateStoredScope 判为 CORRUPT_SCOPES。
    const readOnly=[...new Set(reads.map(target=>new URL(target.url).origin))].filter(origin=>!(scope.origins??[]).includes(origin)&&!inDomain(origin)&&!(scope.readOrigins??[]).includes(origin)&&!isLocalServeOrigin(origin));
    if(readOnly.length)await setUserScope(session,readOnly,{extend:true,readOnly:true});
  }
  function publishPending(session,task,input,burp) {
    const identity=JSON.stringify([session,task.id]);
    if(publishing.has(identity))return publishing.get(identity);
    /* [2026-10-14 现场] 判定服务自身故障（网络/5xx/401/未配置）不是安全结论：
     * 旧行为给每个被拦请求都发一张「判定服务不可用」待审卡（现场 32 张），现改为会话级单条待办提醒 + 可重试闸错误。
     * 本地确定危害（hardVeto）的卡仍照发：用户仍可能想放行这笔 DELETE，不能被服务故障连累。 */
    const outage=task.review?.hardVeto===true?void 0:serviceOutage(task.review);
    const work=(async()=>{
      if(outage){
        const store=await storeFor(session);
        const first=input?.entries?.[0]?.request;
        await raiseServiceOutage(store,session,{outage,detail:first?`${first.method} ${first.url}`:''});
      }
      return publishPendingRow(session,task,input,burp);
    })();
    publishing.set(identity,work);
    work.finally(()=>publishing.delete(identity)).catch(()=>{});
    return work;
  }
  async function publishPendingRow(session, task, input, burp) {
    const current=authorizationTicket(session);prunePending();
    const store = await storeFor(session);
    ensureOpen();
    if (!store) throw gateError('APPROVAL_STORE_UNAVAILABLE');
    // Full request secrets are held only by broker, not put into a session event.
    const summary=presentPlan(input);
    const approval = {method:'TASK',url:`src-egress://${task.id}`,path:'/',headers:'',body:JSON.stringify(summary.hostExecution?{entries:summary.entries,safety:summary.hostExecution.safety,...(burp?{transport:{kind:'burp',tool:burp.name,digest:burp.digest}}:{})}:summary.entries),
      category:'egress/task',reason:`有界任务待审（${describeReview(task.review)}）；${input.entries.length}个精确请求，最多${input.maxRequests}次，间隔${input.minIntervalMs}ms；摘要${task.digest}；判定依据：${describeVerdict(task.review)}；用途说明（${purposeAttribution(summary.purpose)}）：${String(summary.purpose||'(无)').slice(0,300)}；执行前判定${JSON.stringify(task.review??null)}${input.hostExecution&&!input.hostExecution.safety?(humanReadSafety(input.hostExecution.request,task.review)?'；本笔实际影响未定，请用户核对冻结请求，确认无写入或外发后单次放行，无需为读取/计算虚构备份。':'；这是单笔冻结请求：用户可直接批准发送原请求（仅一次）或拒绝；不覆盖/删除既有对象时无需先补材料，确需前置校验/备份/回读时才用 src_egress_prepare 补充。'):''}`,
      justification:summary.purpose};
    const existing=await store.findPendingApproval?.(session,'TASK',approval.url,approval.body);
    const row=existing ?? await store.addPendingApproval(session,approval);
    if(!existing) await appendApproval?.(session,row);
    current();broker.commandPlane.bindApproval(session,task.id,row.id);
    pending.set(`${session}:${row.id}`,{...broker.commandPlane.binding(session,task.id),burp});
    return row.id;
  }
  async function pendingBinding(session, approvalId, checkScope=true) {
    const store=await storeFor(session),row=await store.getPendingApproval(session,approvalId);
    const taskId=row?.category==='egress/task'&&/^src-egress:\/\/([a-f0-9-]{36})$/.exec(row.url)?.[1];
    if(!taskId)throw gateError('STALE_APPROVAL');
    const binding=broker.commandPlane.binding(session,taskId,checkScope);
    if(binding.approvalId&&binding.approvalId!==approvalId)throw gateError('STALE_APPROVAL');
    if(!binding.approvalId)broker.commandPlane.bindApproval(session,taskId,approvalId);
    const cached=pending.get(`${session}:${approvalId}`);
    if(cached?.taskId===taskId)binding.burp=cached.burp;
    return {binding,row,store};
  }
  async function propose(session,input,exec={},permit,burp,pendingSafety,resume={}) {
    ensureOpen();exec=withWorkContext(session,execution(exec,session));
    await ensureRequestScope(session,(input.entries??[]).map(entry=>({url:entry.request.url,method:entry.request.method})));
    exec.signal.throwIfAborted();requireScope(session);
    if(input.hostExecution&&permit!==HOST_REQUEST)throw gateError('INVALID_PLAN_FIELD');
    if(burp)input={...input,purpose:`Burp 原生单次发送 ${burp.name}；调用摘要 ${burp.digest}；信任已配置的 Burp 执行冻结参数。若需前置/后置核对，仍由现有受控 HTTP 执行器执行审批单列出的检查。`};
    if(burp)resume={...resume,burp:{name:burp.name,args:burp.args,request:burp.request,digest:burp.digest,...(burp.source?{source:burp.source}:{})}};
    let task = await broker.propose(session,input,exec,{implicitRead:permit===SINGLE_REQUEST,resume});
    if(task.state==='pending'&&permit===SINGLE_REQUEST){
      const request=input.entries[0].request;
      const readable=['GET','HEAD','OPTIONS','POST'].includes(request.method)&&['read','compute'].includes(task.review?.effect)&&!requiresHuman({entries:[{request}]});
      const safety=pendingSafety??(readable?{effect:task.review.effect,object:request.url,recovery:'只读/计算单笔请求；不自动重试或补偿'}:null);
      task={...broker.prepareSingle(session,task.id,safety),review:task.review};
      input=broker.commandPlane.inspect(session,task.id).plan;
    }
    if(task.state==='pending') {
      task.approvalId=await publishPending(session,task,input,burp);
    }
    return task;
  }
  async function authorize(session,input,exec={},burp) {
    ensureOpen();exec=withWorkContext(session,execution(exec,session));
    await ensureRequestScope(session,[{url:input.url,method:input.method}]);
    exec.signal.throwIfAborted();requireScope(session);
    const request=canonicalRequest(input);
    let existing=exec.egressTaskId?{id:exec.egressTaskId,state:'active'}:broker.find(session,request);
    // A Burp invocation is never an alias for a previously granted shell scan.
    // Pending/denied requests still dominate across all transports.
    if(burp&&existing?.state==='active')existing=undefined;
    if(!existing) {
      const identity=session+':'+hash(JSON.stringify(request))+(burp?':'+randomUUID():'');
      let work=preparation.get(identity);
      if(!work){
        if(preparation.size>=ASSESSMENT_PENDING_LIMIT)throw gateError('ASSESSMENT_CAPACITY');
        work=(async()=>{
          const assessmentExec=exec.deferAssessment?{...exec,signal:shutdown.signal}:exec;
          // First assess an ordinary one-request plan. Only a pending decision
          // is converted to a command-only execution lane; no extra Jev call.
          let safety;
          if(exec.egressSafetyPlan){
            try {safety=await normalizeSafetyPlan({home,session,request,input:exec.egressSafetyPlan,origins:requireScope(session).origins});}
            catch(error){
              // Invalid write safety material must not erase the pending action
              // or lead the model into endless parameter retries. It grants no
              // permission: a null-safety host task cannot be approved/sent.
              if(!['PUT','PATCH','DELETE'].includes(request.method)&&!requiresHuman({entries:[{request}]}))throw error;
              return propose(session,{entries:[{request,maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:300000,purpose:exec.egressPurpose??PURPOSE_NO_SAFETY_MATERIAL,hostExecution:{request,safety:null}},assessmentExec,HOST_REQUEST,burp);
            }
          }
          // A model-provided read recovery description is not a request to run
          // a mutation. The validator checks method/action contradictions;
          // ordinary reads still undergo Jev's actual-request classification.
          if(safety && (!['read','compute'].includes(safety.effect)||safety.precondition||safety.verification)){
            const entries=safetyRequests(request,safety);
            return propose(session,{entries,maxRequests:entries.reduce((n,e)=>n+e.maxRequests,0),minIntervalMs:250,lifetimeMs:300000,purpose:exec.egressPurpose??PURPOSE_PRECONDITION_REVIEW,hostExecution:{request,safety}},assessmentExec,HOST_REQUEST,burp);
          }
          return propose(session,{entries:[{request,maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:300000,purpose:exec.egressPurpose??PURPOSE_SINGLE_CAPTURED},assessmentExec,SINGLE_REQUEST,burp,safety);
        })();
        preparation.set(identity,work);
        work.finally(()=>preparation.delete(identity)).catch(()=>{});
      }
      // A normal first request must wait for its review, not be unconditionally
      // rejected merely because no plan was pre-seeded. Cancellation is checked
      // below before claiming any dispatch; no automatic target replay.
      existing=await work;
    }
    if(existing.state!=='active'){
      let durable;
      if(existing.state==='pending')durable=broker.commandPlane.binding(session,existing.id);
      const approvalId=existing.approvalId??durable?.approvalId??(durable?await publishPending(session,{...existing,review:durable.review},broker.commandPlane.inspect(session,existing.id).plan,durable.resume?.burp):undefined);
      const humanRead=durable?.hostExecution&&!durable.hostExecution.safety&&humanReadSafety(durable.hostExecution.request,durable.review);
      let needsSafety=false;
      if(durable?.hostExecution&&!humanRead){
        try{assertReviewedSafety(durable.hostExecution.request,durable.hostExecution.safety,durable.review);}
        catch{needsSafety=true;}
      }
      /* [审计 2026-10-13 §2] 不再把“补安全材料”写成唯一出路：那会把单笔待审变成子代理绕不出的死路
       * （复核会话 src_egress_prepare 两次 SRC_GATE_INVALID_SAFETY_READ，注册正例停摆）。
       * 用户可直接在审批卡放行冻结请求；材料是可选项，且补充前不得重发/改写原请求。 */
      const nextAction=humanRead
        ? `本笔实际影响未定；请用户核对冻结请求，确认为低影响时可在审批卡单次放行，无需为读取/计算虚构备份。${APPROVAL_CHANNEL_ESCALATION}${PENDING_CONTINUATION}`
        : needsSafety
          ? `${pendingSingleRequestNotice({approvalId,taskId:existing.id,needsMaterial:true})}`
          : PENDING_CONTINUATION;
      throw Object.assign(gateError('PENDING_OR_REJECTED'),{taskId:existing.id,approvalId,state:existing.state,...(humanRead?{reason:'human-impact-confirmation-required'}:needsSafety?{reason:'safety-material-required'}:{}),nextAction});
    }
    const host=broker.commandPlane.binding(session,existing.id);
    if(host.hostExecution){
      if(!host.automatic)throw gateError('HOST_EXECUTION_ONLY');
      // 旧版未发送的自动计划可能尚未审核辅助请求；首次执行补核验。
      if(!host.automaticSafetyReviewed){
        try{await broker.commandPlane.assertExecutable(session,host.taskId,exec);}
        catch(error){broker.commandPlane.completeHost(session,host.taskId);throw error;}
      }
      return {hostTask:host};
    }
    // Waiting never renews a task or consumes an extra grant; dead/unknown sends
    // eventually return busy, not an automatic replay or unlimited queue.
    // Proxy and direct tools share the same bounded pre-send wait: the former
    // 1.25s proxy-only window rejected ordinary bursts at the 250ms origin rate.
    for(let attempt=0;attempt<60;attempt++){
      exec.signal?.throwIfAborted();
      try{return broker.dataPlane.claim(session,existing.id,request);}
      catch(error){if(!['SRC_GATE_RATE_LIMIT','SRC_GATE_ORIGIN_BUSY'].includes(error.code)||attempt===59)throw error;await delay(250);}
    }
  }
  async function sessionProxy(session,taskId) {
    ensureOpen();const current=authorizationTicket(session);
    if(typeof session!=='string'||!session)throw gateError('INVALID_SESSION');
    const identity=JSON.stringify([session,taskId??null]);
    let work=sessions.get(identity);
    if(work){
      const proxy=await work;current();
      if(!proxy.alive()){
        await proxy.waitForParking();ensureOpen();
        if(!activeProxies.has(identity)&&activeProxies.size>=4)throw gateError('PROXY_CAPACITY');
        activeProxies.add(identity);
        try{await proxy.activate();}catch(error){activeProxies.delete(identity);throw error;}
      }
      return proxy;
    }
    if(sessions.size+retiredProxies.size>=1024)throw gateError('SESSION_CAPACITY');
    if(activeProxies.size>=4)throw gateError('PROXY_CAPACITY');
    activeProxies.add(identity);
    work=(async()=>{
      const directory=path.join(root,hash(identity));await mkdir(directory,{recursive:true,mode:0o700});
      const socketDirectory=await mkdtemp('/private/tmp/src-egress-');
      const socket=path.join(socketDirectory,'control.sock');
      const token=randomBytes(32).toString('hex');
      const control=createProxyControlServer({sessionId:session,taskId:'host-selected',token,dataPlane:{
        claim:async(_session,_task,request,meta)=>{
          current();const target=new URL(request.url);
          let grant;
          try{grant=await authorize(session,request,{egressTaskId:taskId,deferAssessment:true,signal:meta?.signal});}
          catch(error){observeNetwork(session,{kind:'denied',origin:target.origin,code:/^SRC_GATE_[A-Z_]+$/.test(error.code??'')?error.code:'SRC_GATE_CONTROL_FAILURE'});throw error;}
          let pin;
          try{current();pin=boundPins(session,request.url,grant)[0];}catch(error){broker.dataPlane.finish(session,grant.dispatchId,'outcome_unknown');throw error;}
          return {...grant,upstreamAddress:pin.address,upstreamPort:Number(target.port)||(target.protocol==='https:'?443:80)};
        },
        finish:async(id,dispatch,outcome,response,context)=>{
          try{
            if(outcome==='response_received'){
              const actual=proxyResponse(response);
              if(recordEvidence)await recordEvidence(id,{request:canonicalRequest(context.request),response:actual,grant:context.grant});
              broker.observeResponse(id,context.grant,canonicalRequest(context.request),actual);
            }
            broker.dataPlane.finish(id,dispatch,outcome);
          }catch(error){try{broker.dataPlane.finish(id,dispatch,'outcome_unknown');}catch{}throw error;}
        },
      }});
      let proxy,publicDirectory;
      const cleanup=async()=>{
        await proxy?.close();control.closeAllConnections();
        if(control.listening)await new Promise(resolve=>control.close(resolve));
        await rm(socketDirectory,{recursive:true,force:true});
        if(publicDirectory)await rm(publicDirectory,{recursive:true,force:true});
      };
      try {
        await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(socket,resolve);});
        publicDirectory=await mkdtemp('/private/tmp/src-egress-ca-');
        proxy=await startSessionProxy({directory:path.join(directory,'mitm'),publicCA:path.join(publicDirectory,'ca.pem'),controlSocket:socket,token,executable:proxyExecutable,
          canPark:()=>!closed&&!shellUsers.get(identity)&&(!taskId||!broker.hasActiveTasks(session,taskId)),
          canRetire:()=>!closed&&!!taskId&&!shellUsers.get(identity)&&!broker.hasActiveTasks(session,taskId),onPark:()=>activeProxies.delete(identity)});
        current();return {...proxy,get pid(){return proxy.pid;},readOnlyPaths:[publicDirectory],protectedPaths:[root,await realpath(root),socketDirectory],close:cleanup};
      }catch(error){await cleanup();throw error;}
    })();
    work.catch(()=>activeProxies.delete(identity));
    sessions.set(identity,work);
    // Keep a failed startup terminal: never silently replace a dead proxy under live jobs.
    return work;
  }
  /* 会话级 infra（proxyUrl/httpTimeoutMs）：公共车道需要它来判断本机解析能不能作数。
     读失败按“无代理”处理（直连 + 本机校验），绝不因为读配置失败而放宽地址校验。 */
  async function sessionInfra(session) {
    try { return await storeFor(session)?.getInfra?.(session); } catch { return undefined; }
  }
  /* [local.143] 会话事实（当前意图 + 目标）：判定服务需要它才知道这笔请求挂在用户声明的哪条工作线上。
   * 惰性 thunk 随 exec 传进 assess——只有真正要问判定服务时才读 store，自动放行的只读请求零成本。
   * 读不到就返回 null：本条只影响判定输入的信息量，绝不影响授权与失败关闭。 */
  const workContexts = new Map();
  async function sessionWorkContext(session) {
    const cached = workContexts.get(session);
    if (cached && now() - cached.at < 5000) return cached.value;
    let value = null;
    try {
      const store = await storeFor(session);
      value = workContextFrom(await store?.sessionData?.(session));
    } catch { value = null; }
    if (workContexts.size >= 256) workContexts.delete(workContexts.keys().next().value);
    workContexts.set(session, { at: now(), value });
    return value;
  }
  /* 默认 off：现场消融显示，把会话自述喂给判定服务会让它把 external/unknown 改判成 read/low/allow
   *（被审对象用自述说轻自己的请求）。开关只控制“是否提供上下文”，不放宽任何门槛；
   * 开启后必须同时补上“判定不得单向下调本地门槛”的兜底。见 docs/jev-context-feed-ablation-20261018.md。 */
  function withWorkContext(session, exec) {
    if (srcJevSessionContextFlag() !== 'on') return exec;
    if (typeof exec?.srcWorkContext === 'function') return exec;
    return { ...exec, srcWorkContext: () => sessionWorkContext(session) };
  }
  async function fetchTarget(session,url,init={},exec={}) {
    ensureOpen();exec=execution(exec,session);
    if(typeof directFetch!=='function')throw gateError('TRANSPORT_UNAVAILABLE');
    if(isPublicLookup(exec,url))return publicLookup(exec,session,url,init,directFetch,{infra:await sessionInfra(session),sendViaProxy:proxyFetch});
    const headers=Array.isArray(init.headers)?init.headers:init.headers instanceof Headers?[...init.headers.entries()]:Object.entries(init.headers??{});
    const signal=exec.signal&&init.signal?AbortSignal.any([exec.signal,init.signal]):exec.signal??init.signal;
    exec={...exec,signal};
    if(init.body!==undefined&&typeof init.body!=='string'&&!Buffer.isBuffer(init.body))throw gateError('UNSUPPORTED_BODY');
    const request=canonicalRequest({url:String(url),method:init.method??'GET',headers,bodyBase64:Buffer.from(init.body??'').toString('base64')});
    const grant=await authorize(session,request,exec);
    if(grant.hostTask)return (await executeHost(session,grant.hostTask,undefined,undefined,exec.signal,init.onSend)).response;
    try{
      exec.signal?.throwIfAborted();
      const pins=boundPins(session,request.url,grant);
      init.onSend?.();
      const response=await directFetch(request.url,{...init,lookup:pinnedLookup(pins),method:request.method,headers:Object.fromEntries(request.headers),redirect:'manual',signal});
      if(recordEvidence)await recordEvidence(session,{request,response,grant});
      broker.observeResponse(session,grant,request,response);
      broker.dataPlane.finish(session,grant.dispatchId,'response_received');
      return response;
    }catch(error){
      try{broker.dataPlane.finish(session,grant.dispatchId,'outcome_unknown');}catch{}
      // It is not safe to retry merely because evidence persistence failed.
      error.safeNotSent=false;throw error;
    }
  }
  async function executeHost(session,binding,approvalId,store,signal,onSend) {
    signal=execution({signal},session).signal;
    const {request,safety}=binding.hostExecution;
    let sent=false,lastEvidence;
    const send=async exact=>{
      signal?.throwIfAborted();
      let grant;
      for(let attempt=0;attempt<60;attempt++){
        try{grant=broker.commandPlane.claimHost(session,binding.taskId,exact);break;}
        catch(error){if(!['SRC_GATE_RATE_LIMIT','SRC_GATE_ORIGIN_BUSY'].includes(error.code)||attempt===59)throw error;await delay(250);}
      }
      try {
        signal?.throwIfAborted();
        const pins=boundPins(session,exact.url,grant);
        onSend?.();
        // 前置只读检查已发出，不代表被审批的主操作已发送。
        if(JSON.stringify(exact)===JSON.stringify(request))sent=true;
        if(binding.burp&&JSON.stringify(exact)===JSON.stringify(request)){
          const {summary}=await invokeBurp(session,binding.burp,grant,signal);
          return {status:0,burpSummary:summary}; // MCP success is not an HTTP status.
        }
        const response=await directFetch(exact.url,{lookup:pinnedLookup(pins),method:exact.method,headers:Object.fromEntries(exact.headers),body:exact.bodyBase64?Buffer.from(exact.bodyBase64,'base64'):undefined,redirect:'manual',signal});
        const evidence=recordEvidence?await recordEvidence(session,{request:exact,response,grant}):undefined;
        if(JSON.stringify(exact)===JSON.stringify(request))lastEvidence=evidence;
        broker.observeResponse(session,grant,exact,response);
        broker.dataPlane.finish(session,grant.dispatchId,'response_received');
        return response;
      }catch(error){try{broker.dataPlane.finish(session,grant.dispatchId,'outcome_unknown');}catch{}throw error;}
    };
    try {
      binding.burp?.check();
      const outcome=await executeApprovedRequest({request,safety,send,signal,onPhase:async phase=>{
        if(approvalId)await store.updateApprovalExecution(session,approvalId,{executionState:phase});
      }});
      const result={status:'approved',executionState:outcome.verification==='mismatch'||outcome.verification==='unavailable'?'unknown':'executed',responseStatus:outcome.response.status,...(lastEvidence?.evidenceId?{responseEvidenceId:lastEvidence.evidenceId}:{}),writeOutcome:{verification:outcome.verification,recovery:outcome.recovery}};
      if(outcome.response.burpSummary)result.responseBody=outcome.response.burpSummary;
      if(result.executionState==='unknown')broker.commandPlane.quarantine(session,binding.taskId);
      if(approvalId){await store.updateApprovalExecution(session,approvalId,result);broker.commandPlane.revoke(session,binding.taskId);return result;}
      if(result.executionState==='executed')broker.commandPlane.completeHost(session,binding.taskId);
      else throw gateError('VERIFICATION_FAILED');
      return {...result,response:outcome.response};
    }catch(error){
      error.safeNotSent=!sent;
      if(sent)broker.commandPlane.quarantine(session,binding.taskId);
      broker.commandPlane.revoke(session,binding.taskId);
      if(approvalId)await store.updateApprovalExecution(session,approvalId,{status:'approved',executionState:sent?'unknown':'failed-before-send',executionError:error.code??'EGRESS_EXECUTION_FAILED'});
      throw error;
    }
  }
  async function invokeBurp(session,burp,grant,signal){
    burp.check();signal.throwIfAborted();
    const value=await burp.invoke(signal);
    if(value?.isError||!Array.isArray(value?.content))throw gateError('BURP_TOOL_FAILED');
    const serialized=JSON.stringify(value);
    if(Buffer.byteLength(serialized)>8*1024*1024)throw gateError('RESPONSE_LIMIT');
    const summary=`Burp MCP 已返回；不从非结构化输出推断 HTTP 状态或业务成功。工具=${burp.name}；调用摘要=${burp.digest}；结果字节=${Buffer.byteLength(serialized)}；结果SHA256=${hash(serialized)}`;
    const request=presentPlan({entries:[{request:burp.request,maxRequests:1}],purpose:'Burp MCP'}).entries[0].request;
    const store=await storeFor(session);
    await store.upsertObservation(session,{method:request.method,path:request.url,httpStatus:0,reqHeaders:JSON.stringify(request.headers),reqBodySnippet:request.body,respBodySnippet:summary,source:'raw',decision:`原生 Burp 调用；task=${grant.taskId}; dispatch=${grant.dispatchId}；未保存可能包含凭据的 MCP 原文`});
    broker.dataPlane.finish(session,grant.dispatchId,'response_received');
    return {value,summary};
  }
  return {
    propose,
    sendBurp:(session,captured,exec,sender)=>track((async()=>{
      exec=execution(exec,session);
      const burp={...captured,...sender};burp.check();
      let grant;
      try{grant=await authorize(session,burp.request,exec,burp);}
      catch(error){
        if(!['SRC_GATE_PENDING_OR_REJECTED','SRC_GATE_USER_SCOPE_REQUIRED'].includes(error.code))throw error;
        return {value:{content:[{type:'text',text:JSON.stringify({sent:false,code:error.code,approvalId:error.approvalId,reason:error.reason,nextAction:error.nextAction??PENDING_CONTINUATION})}]}};
      }
      try{
        boundPins(session,burp.request.url,grant); // scope/version check, not Burp DNS pinning
        return {value:(await invokeBurp(session,burp,grant,exec.signal)).value};
      }catch(error){
        try{broker.dataPlane.finish(session,grant.dispatchId,'outcome_unknown');}catch{}
        error.safeNotSent=false;throw error;
      }
    })()),
    async preparePending(session,approvalId,input,exec={}) {
      const release=lockApproval(session,approvalId);
      try {
      requireScope(session);exec.signal?.throwIfAborted();
      const {binding:old,row}=await pendingBinding(session,approvalId);
      if(row.status!=='pending')throw gateError('STALE_APPROVAL');
      const original=broker.commandPlane.inspect(session,old.taskId);
      const request=original.plan.hostExecution?.request;
      if(!request)throw gateError('NOT_SINGLE_REQUEST');
      const safety=await normalizeSafetyPlan({home,session,request,input,origins:requireScope(session).origins});
      assertReviewedSafety(request,safety,old.review);
      exec.signal?.throwIfAborted();
      // The primary request is unchanged. Preserve its original review for
      // audit visibility; new safety material still requires fresh human approval.
      let task;
      if(original.state==='superseded'&&original.manifest.supersededBy){
        const saved=broker.commandPlane.inspect(session,original.manifest.supersededBy);
        if(saved.state!=='pending'||JSON.stringify(saved.plan.hostExecution?.safety)!==JSON.stringify(safety))throw gateError('PREPARATION_ALREADY_UPDATED');
        task={id:saved.id,digest:saved.digest,state:saved.state,expiresAt:null,review:old.review};
      }else task={...broker.prepareSingle(session,old.taskId,safety),review:old.review};
      pending.delete(`${session}:${approvalId}`);
      const next=broker.commandPlane.inspect(session,task.id).plan;
      task.approvalId=await publishPending(session,task,next,old.burp??old.resume?.burp);
      const store=await storeFor(session);
      await store.updateApprovalExecution(session,approvalId,{status:'rejected',executionState:'superseded',note:`安全材料已更新，旧批准无效；请审核 ${task.approvalId}`});
      return task;
      } finally {release();}
    },
    async prepareToolTask(session,input,exec,taskId){
      const task=taskId!==undefined?{id:taskId,state:'active'}:await propose(session,input,exec);
      return task.state==='active'?broker.startToolTask(session,task.id,input):task;
    },
    completeToolTask:(session,taskId)=>broker.completeToolTask(session,taskId),
    async proposeShellTask(session,input,exec,taskId) {
      const task=taskId?broker.selectShellTask(session,taskId,input):await propose(session,input,exec,undefined,undefined,undefined,{shell:true});
      if(task.state==='active')shellPlans.set(session,task.id);
      return task;
    },
    async shellExecution(session){
      const taskId=shellPlans.get(session);
      // The proxy's task binding is immutable. Descendants keep this port and
      // its finite plan; subsequent ordinary commands get a separate port.
      const proxy=await sessionProxy(session,taskId);
      if(taskId){const identity=JSON.stringify([session,taskId]);shellUsers.set(identity,(shellUsers.get(identity)??0)+1);}
      return {taskId,proxy};
    },
    claimShellTask(session,taskId){
      ensureOpen();if(!taskId)return;
      if(shellPlans.get(session)!==taskId)throw gateError('STALE_SHELL_TASK');
      broker.startShellTask(session,taskId);
      shellPlans.delete(session);
    },
    async releaseShellProxy(session,taskId,proxy){
      if(!taskId)return;
      const identity=JSON.stringify([session,taskId]);
      const remaining=(shellUsers.get(identity)??1)-1;
      if(remaining>0)shellUsers.set(identity,remaining);else shellUsers.delete(identity);
      // Keep denial responses available until the foreground script finishes.
      // A surviving child can retire the worker after its final response.
      if(!closed&&!broker.hasActiveTasks(session,taskId))await proxy.parkIfIdle();
    },
    fetch:(...args)=>track(fetchTarget(...args)),sessionProxy,
    watchNetwork,
    checkTarget:(session,url,method)=>{ensureOpen();assertKnownTarget(scopes.get(session),url,{method,allowUnscopedLoopback:allowLoopbackFixtures});},
    // Install only in the trusted command handler, never tools/execute context.
    user:Object.freeze({setScope:setUserScope,getScope:session=>structuredClone(scopes.get(session)),
      async seedScope(session,sourceSession){
        if(scopes.get(session)?.origins.length||scopes.get(session)?.domains?.length||sourceSession?.id!==session)return;
        const store=await storeFor(session);
        // 不越过已存在的范围审批，包括人工拒绝、待审和中断的决定。
        if((await store.listScopeApprovals(session)).length)return;
        const {origins,domains}=explicitUserScope(sourceSession);
        if(origins.length||domains.length){try{await setUserScope(session,origins,{ifAbsent:true,extend:true,domains});}catch(error){if(error.code!=='SRC_GATE_STALE_APPROVAL')throw error;}}
      },
      async confirmDomain(session,domain,action){
        domain=domainGrant(domain);
        if(action==='allow')return setUserScope(session,[],{domains:[domain],extend:true});
        if(action!=='reject')throw gateError('INVALID_DECISION');
        return setUserScope(session,[],{excludedDomains:[domain],extend:true});
      },
      status(){ensureOpen();return {activeWorkerSlots:activeProxies.size,maxWorkers:4,reservedSessionPorts:sessions.size+retiredProxies.size,retiredSessionPorts:retiredProxies.size,idleStopMs:120000};},
      async reconcile(session,approvalId,disposition,evidence) {
        ensureOpen();
        const release=lockApproval(session,approvalId);
        try {
        const store=await storeFor(session);
        const row=await store.getPendingApproval(session,approvalId);
        if(row?.category!=='egress/task'||!/^src-egress:\/\/[a-f0-9-]{36}$/.test(row.url))throw gateError('UNKNOWN_TASK');
        const taskId=row.url.slice('src-egress://'.length);
        const result=broker.commandPlane.reconcile(session,taskId,disposition,evidence);
        pending.delete(`${session}:${approvalId}`);
        await store.updateApprovalExecution(session,approvalId,{status:'rejected',executionState:'reconciled',note:'用户已核对结果并撤销旧授权；再次操作必须重新人工审批'});
        return result;
        } finally {release();}
      },
      async inspect(session,approvalId) {
        ensureOpen();prunePending();
        if(await scopeRequests.has(session,approvalId))return scopeRequests.inspect(session,approvalId);
        const store=await storeFor(session);
        const row=await store.getPendingApproval(session,approvalId);
        if(row?.category==='egress/scope')return {state:'stale',approvalId,kind:'scope',executable:false,sendsRequest:false,reason:'范围确认单已失效或服务已重启；不会发送请求。请核对当前范围；确需确认时由用户用 /src-egress-scope 显式设置精确 origins。',summary:row.body};
        if(row?.category!=='egress/task')throw gateError('UNKNOWN_TASK');
        // Pending bindings are removed on approval. Their removal says nothing
        // about validity or execution; inspect the bound task and durable result.
        const taskId=/^src-egress:\/\/([a-f0-9-]{36})$/.exec(row.url)?.[1];
        if(!taskId)throw gateError('UNKNOWN_TASK');
        const base={approvalId,executable:false,sendsRequest:false,summary:row.body};
        if(row.executionState==='executed')return {...base,state:'executed',responseStatus:row.responseStatus,reason:'主机已执行并记录结果；查看不会再次发送，禁止重放。'};
        if(['unknown','cancelled'].includes(row.executionState))return {...base,state:row.executionState,reason:'执行结果不确定；查看不会重试，请先人工核对目标和记录。'};
        try {const task=broker.commandPlane.inspect(session,taskId);return {...task,plan:presentPlan(task.plan),approvalId,sendsRequest:false};}
        catch(error){if(!['SRC_GATE_UNKNOWN_TASK','SRC_GATE_EXPIRED','SRC_GATE_SCOPE_CHANGED','SRC_GATE_POLICY_CHANGED','SRC_GATE_FROZEN_PLAN_UNAVAILABLE'].includes(error.code))throw error;}
        let history;
        try{history=broker.commandPlane.history(session,taskId);}catch(error){if(error.code!=='SRC_GATE_UNKNOWN_TASK')throw error;}
        if(history?.state==='revoked')return {...base,...history,reason:'计划已撤销或结果不确定；先核对目标及执行记录，禁止盲目重放。'};
        if(history&&['completed_tool','completed_read','denied','reconciled'].includes(history.state))return {...base,...history,reason:history.state.startsWith('completed_')?'计划已完成并注销未使用额度；不会重放。':history.state==='denied'?'用户已拒绝；不会执行或重新签发。':'用户已核对并撤销旧授权；不会重放。'};
        return {state:'stale',approvalId,executable:false,reason:'执行窗口已结束、范围/策略已变更或旧版记录缺少冻结原文；旧审批不可执行。正常等待和重启不会使新审批失效。核对结果后使用 reconcile，再提交新任务。',summary:row.body};
      },
      async decide(session,approvalId,action,note='',signal,userExec){
        ensureOpen();const current=authorizationTicket(session),identity=`${session}:${approvalId}`;
        const confirmRead=action==='allow-read';
        if(confirmRead)action='allow';
        if(!['allow','reject'].includes(action))throw gateError('INVALID_DECISION');
        const release=lockApproval(session,approvalId);
        try {
          if(await scopeRequests.has(session,approvalId)){if(confirmRead)throw gateError('INVALID_DECISION');current();return await scopeRequests.decide(session,approvalId,action,note,signal);}
          const {binding,row,store}=await pendingBinding(session,approvalId,action==='allow');
          signal?.throwIfAborted();current();
          let task=broker.commandPlane.inspect(session,binding.taskId,action==='allow'),plan=task.plan;
          // A crash between audit persistence and activation is definitely unsent.
          // Only another explicit user command may resume that original decision.
          const recoverable=row.status==='approved'&&row.userDecision==='allow'&&row.executionState==='failed-before-send'
            &&row.executionError==='SRC_GATE_RESOURCE_REQUIRES_REVIEW'&&['revoked','pending'].includes(task.state)&&task.used===0&&!task.manifest.toolStarted;
          if(recoverable&&(confirmRead||action==='reject')){
            if(!binding.hostExecution||plan.entries.length!==1||plan.maxRequests!==1||!humanReadSafety(binding.hostExecution.request,binding.review))throw gateError('UNSAFE_RETRY');
            if(task.state==='revoked')broker.commandPlane.restoreUnsent(session,binding.taskId,action==='allow');
            task=broker.commandPlane.inspect(session,binding.taskId,action==='allow');plan=task.plan;
          }
          const interrupted=row.status==='approved'&&row.userDecision==='allow'&&row.executionState==='authorized'&&task.used===0&&['pending','active'].includes(task.state)&&!task.manifest.toolStarted;
          const interruptedRejection=row.status==='rejected'&&row.userDecision==='reject'&&task.state==='pending'&&task.used===0&&!task.manifest.toolStarted;
          if(!(row.status==='pending'&&task.state==='pending')&&!(recoverable&&(confirmRead||action==='reject'))&&!interrupted&&!(interruptedRejection&&action==='reject'))throw gateError('STALE_APPROVAL');
          if(action==='allow'){
            if(confirmRead){
              if(!binding.hostExecution || plan.entries.length!==1 || plan.maxRequests!==1 || !humanReadSafety(binding.hostExecution.request,binding.review))throw gateError('SAFETY_PLAN_REQUIRED');
              note=['人类确认冻结单笔请求无持久写入、外发或资源耗尽',note].filter(Boolean).join('；');
            }
            if(binding.hostExecution&&!plan.hostExecution?.safety&&confirmRead){
              // allow-read turns only a Jev-unknown single request into the
              // explicit human low-impact lane. A normal human allow keeps the
              // frozen safety=null request intact and uses the human decision.
              broker.commandPlane.repairReadSafety(session,binding.taskId,true);
              Object.assign(binding,broker.commandPlane.binding(session,binding.taskId));
              task=broker.commandPlane.inspect(session,binding.taskId);plan=task.plan;
            }
            await broker.commandPlane.assertExecutable(session,binding.taskId,execution({signal},session),{humanApproved:true});
            signal?.throwIfAborted();current();
            if(binding.resume?.burp&&(userExec||!binding.burp?.invoke)){
              if(typeof restoreBurp!=='function')throw gateError('BURP_RESTORE_UNAVAILABLE');
              binding.burp={...binding.resume.burp,...await restoreBurp(session,binding.resume.burp,userExec)};
            }
            binding.burp?.check?.();
          }
          await store.updateApprovalExecution(session,approvalId,{status:action==='allow'?'approved':'rejected',approvalSource:'human-command',userDecision:action,note,executionState:action==='allow'?'authorized':'rejected',executionError:''});
          // 持久拒绝必须落到账本；此步骤不发请求，不因回合取消留下半张拒绝单。
          if(action==='allow')signal?.throwIfAborted();current();
          const humanApproved=action==='allow'&&!confirmRead;
          const result=task.state==='active'&&action==='allow'?{id:task.id,state:task.state,digest:task.digest}:broker.commandPlane.decide(session,binding.taskId,binding.digest,action,confirmRead,humanApproved);
          pending.delete(identity);
          if(action==='allow'&&binding.hostExecution)return await track(executeHost(session,binding,approvalId,store,signal));
          return action==='allow'&&binding.resume?.shell?{...result,resumeTool:'src_egress_plan',taskId:binding.taskId}:result;
        } finally {release();}
      }}),

    async close(){
      if(closed)return;closed=true;unsubscribe?.();scopeRequests.clear();shutdown.abort(gateError('CLOSED'));
      await Promise.allSettled([...sessions.values(),...retiredProxies].map(async work=>(await work).close()));
      await Promise.allSettled([...preparation.values(),...publishing.values(),...tracked,scopeWrite]);
      scopeRequests.clear();sessions.clear();retiredProxies.clear();activeProxies.clear();pending.clear();shellPlans.clear();scopes.clear();broker.close();
    },
  };
}
