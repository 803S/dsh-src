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
import { canonicalRequest, gateError, requiresHuman, assertScanExecutable } from './plan.js';
import { pinOrigin, pinnedLookup, validateStoredScope } from './scope.js';
import { proxyResponse } from './evidence.js';
import { isPublicLookup, publicLookup } from './public-lookup.js';
import { presentPlan } from './plan-presentation.js';
import { normalizeSafetyPlan, safetyRequests, executeApprovedRequest } from './safety-plan.js';
import { PENDING_CONTINUATION } from './notifications.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOST_REQUEST=Symbol('host-request'), SINGLE_REQUEST=Symbol('single-request');
const hash = value => createHash('sha256').update(value).digest('hex');

export async function createEgressManager({ home, assess, storeFor, directFetch, proxyExecutable, recordEvidence, allowLoopbackFixtures=false, lifecycle, restoreBurp, now=Date.now }) {
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
  function requireScope(session) {
    ensureOpen(); authorizationTicket(session)(); const scope = scopes.get(session);
    if(!scope?.origins?.length) throw gateError('USER_SCOPE_REQUIRED');
    return scope;
  }
  function boundPins(session,url,grant) {
    const scope=requireScope(session);
    if(scope.revision!==grant.scopeRevision||scope.credentialRevision!==grant.credentialRevision)throw gateError('SCOPE_CHANGED');
    const pins=scope.pins[new URL(url).origin];
    if(!pins)throw gateError('OUT_OF_SCOPE');
    return pins;
  }
  async function setUserScope(session, origins, {ifAbsent=false,extend=false,domains=[],excludedDomains=[]}={}) {
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
      const merged=[...new Set([...(previous?.origins??[]),...exact])].sort();
      if(merged.length>256||new Set([...(previous?.domains??[]),...domains]).size>256)throw gateError('SCOPE_CAPACITY');
      const excluded=[...new Set([...(previous?.excludedDomains??[]),...excludedDomains])];
      if(excluded.length>256)throw gateError('SCOPE_CAPACITY');
      next.set(session,{origins:merged,pins:{...previous?.pins,...pins},domains:[...new Set([...(previous?.domains??[]),...domains])],excludedDomains:excluded,revision:excludedDomains.length?randomUUID():previous?.revision??randomUUID(),credentialRevision:previous?.credentialRevision??randomUUID()});
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
  async function ensureRequestScope(session,urls){
    if(urls.some(url=>(scopes.get(session)?.excludedDomains??[]).some(domain=>withinDomain(new URL(url).hostname,domain))))throw gateError('OUT_OF_SCOPE');
    await scopeRequests.require(session,urls);
    const scope=scopes.get(session);
    const additions=[...new Set(urls.map(value=>new URL(value).origin))].filter(origin=>!scope.origins.includes(origin));
    if(additions.length&&additions.every(origin=>(scope.domains??[]).some(domain=>withinDomain(new URL(origin).hostname,domain))))
      await setUserScope(session,additions,{extend:true});
  }
  function publishPending(session,task,input,burp) {
    const identity=JSON.stringify([session,task.id]);
    if(publishing.has(identity))return publishing.get(identity);
    const work=publishPendingRow(session,task,input,burp);
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
      category:'egress/task',reason:`有界任务待审；${input.entries.length}个精确请求，最多${input.maxRequests}次，间隔${input.minIntervalMs}ms；摘要${task.digest}；执行前判定${JSON.stringify(task.review??null)}${input.hostExecution&&!input.hostExecution.safety?'；缺少有效安全材料，不能执行；请先 src_egress_prepare 补齐，再由用户审核新审批单。':''}`,
      justification:summary.purpose};
    const row = await store.findPendingApproval?.(session,'TASK',approval.url,approval.body) ?? await store.addPendingApproval(session,approval);
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
    ensureOpen();exec=execution(exec,session);
    await ensureRequestScope(session,(input.entries??[]).map(e=>e.request.url));
    exec.signal.throwIfAborted();requireScope(session);
    if(input.hostExecution&&permit!==HOST_REQUEST)throw gateError('INVALID_PLAN_FIELD');
    if(burp)input={...input,purpose:`Burp 原生单次发送 ${burp.name}；调用摘要 ${burp.digest}；信任已配置的 Burp 执行冻结参数。若需前置/后置核对，仍由现有受控 HTTP 执行器执行审批单列出的检查。`};
    if(burp)resume={...resume,burp:{name:burp.name,args:burp.args,request:burp.request,digest:burp.digest,...(burp.source?{source:burp.source}:{})}};
    let task = await broker.propose(session,input,exec,{implicitRead:permit===SINGLE_REQUEST,resume});
    if(task.state==='pending'&&permit===SINGLE_REQUEST){
      const request=input.entries[0].request;
      const readable=(['GET','HEAD','OPTIONS'].includes(request.method)&&!['write','destructive','external','auth'].includes(task.review?.effect)||request.method==='POST'&&['read','compute'].includes(task.review?.effect))&&!requiresHuman({entries:[{request}]});
      const safety=pendingSafety??(readable?{effect:'read',object:request.url,recovery:'只读单笔请求；不自动重试或补偿'}:null);
      task={...broker.prepareSingle(session,task.id,safety),review:task.review};
      input=broker.commandPlane.inspect(session,task.id).plan;
    }
    if(task.state==='pending') {
      task.approvalId=await publishPending(session,task,input,burp);
    }
    return task;
  }
  async function authorize(session,input,exec={},burp) {
    ensureOpen();exec=execution(exec,session);
    await ensureRequestScope(session,[input.url]);
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
              return propose(session,{entries:[{request,maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:300000,purpose:exec.egressPurpose??'高危请求缺少有效安全材料，待补充后人工审核',hostExecution:{request,safety:null}},assessmentExec,HOST_REQUEST,burp);
            }
          }
          // A model-provided read recovery description is not a request to run
          // a mutation. The validator checks method/action contradictions;
          // ordinary reads still undergo Jev's actual-request classification.
          if(safety && (!['read','compute'].includes(safety.effect)||safety.precondition||safety.verification)){
            const entries=safetyRequests(request,safety);
            return propose(session,{entries,maxRequests:entries.reduce((n,e)=>n+e.maxRequests,0),minIntervalMs:250,lifetimeMs:300000,purpose:exec.egressPurpose??'单笔请求与前置条件/验证的人工审批',hostExecution:{request,safety}},assessmentExec,HOST_REQUEST,burp);
          }
          return propose(session,{entries:[{request,maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:300000,purpose:exec.egressPurpose??'单笔目标请求，完整内容由出口捕获；需审核实际语义'},assessmentExec,SINGLE_REQUEST,burp,safety);
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
      const needsSafety=durable?.hostExecution&&!durable.hostExecution.safety;
      throw Object.assign(gateError('PENDING_OR_REJECTED'),{taskId:existing.id,approvalId,state:existing.state,...(needsSafety?{reason:'safety-material-required'}:{}),nextAction:`${needsSafety?'确需执行本项时用 src_egress_prepare 补原审批的安全材料，不要重新发送请求或凭目的说明猜正文。':''}${PENDING_CONTINUATION}`});
    }
    const host=broker.commandPlane.binding(session,existing.id);
    if(host.hostExecution){if(!host.automatic)throw gateError('HOST_EXECUTION_ONLY');return {hostTask:host};}
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
          const grant=await authorize(session,request,{egressTaskId:taskId,deferAssessment:true,signal:meta?.signal});
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
  async function fetchTarget(session,url,init={},exec={}) {
    ensureOpen();exec=execution(exec,session);
    if(typeof directFetch!=='function')throw gateError('TRANSPORT_UNAVAILABLE');
    if(isPublicLookup(exec,url))return publicLookup(exec,session,url,init,directFetch);
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
    let sent=false;
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
        if(recordEvidence)await recordEvidence(session,{request:exact,response,grant});
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
      const result={status:'approved',executionState:outcome.verification==='mismatch'||outcome.verification==='unavailable'?'unknown':'executed',responseStatus:outcome.response.status,writeOutcome:{verification:outcome.verification,recovery:outcome.recovery}};
      if(outcome.response.burpSummary)result.responseBody=outcome.response.burpSummary;
      if(result.executionState==='unknown')broker.commandPlane.quarantine(session,binding.taskId);
      if(approvalId){await store.updateApprovalExecution(session,approvalId,result);broker.commandPlane.revoke(session,binding.taskId);return result;}
      if(result.executionState==='executed')broker.commandPlane.completeHost(session,binding.taskId);
      else throw gateError('VERIFICATION_FAILED');
      return {...result,response:outcome.response};
    }catch(error){
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
      requireScope(session);exec.signal?.throwIfAborted();
      const {binding:old,row}=await pendingBinding(session,approvalId);
      if(row.status!=='pending'||deciding.has(`${session}:${approvalId}`))throw gateError('STALE_APPROVAL');
      const original=broker.commandPlane.inspect(session,old.taskId);
      const request=original.plan.hostExecution?.request;
      if(!request)throw gateError('NOT_SINGLE_REQUEST');
      const safety=await normalizeSafetyPlan({home,session,request,input,origins:requireScope(session).origins});
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
        const store=await storeFor(session);
        const row=await store.getPendingApproval(session,approvalId);
        if(row?.category!=='egress/task'||!/^src-egress:\/\/[a-f0-9-]{36}$/.test(row.url))throw gateError('UNKNOWN_TASK');
        const taskId=row.url.slice('src-egress://'.length);
        const result=broker.commandPlane.reconcile(session,taskId,disposition,evidence);
        pending.delete(`${session}:${approvalId}`);
        await store.updateApprovalExecution(session,approvalId,{status:'rejected',executionState:'reconciled',note:'用户已核对结果并撤销旧授权；再次操作必须重新人工审批'});
        return result;
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
        if(!['allow','reject'].includes(action))throw gateError('INVALID_DECISION');
        if(deciding.has(identity))throw gateError('STALE_APPROVAL');
        deciding.add(identity);
        try {
          if(await scopeRequests.has(session,approvalId)){current();return await scopeRequests.decide(session,approvalId,action,note,signal);}
          const {binding,row,store}=await pendingBinding(session,approvalId,action==='allow');
          signal?.throwIfAborted();current();
          let task=broker.commandPlane.inspect(session,binding.taskId,action==='allow'),plan=task.plan;
          // A crash between audit persistence and activation is definitely unsent.
          // Only another explicit user command may resume that original decision.
          const interrupted=row.status==='approved'&&row.userDecision==='allow'&&row.executionState==='authorized'&&task.used===0&&['pending','active'].includes(task.state)&&!task.manifest.toolStarted;
          if(!(row.status==='pending'&&task.state==='pending')&&!(interrupted&&action==='allow'))throw gateError('STALE_APPROVAL');
          if(action==='allow'){
            if(binding.hostExecution&&!plan.hostExecution?.safety){
              // 只在人类显式批准时迁移；查看、启动和后台恢复均不发包。
              broker.commandPlane.repairReadSafety(session,binding.taskId);
              Object.assign(binding,broker.commandPlane.binding(session,binding.taskId));
              task=broker.commandPlane.inspect(session,binding.taskId);plan=task.plan;
            }
            if(!binding.hostExecution)assertScanExecutable(plan);
            if(binding.resume?.burp&&(userExec||!binding.burp?.invoke)){
              if(typeof restoreBurp!=='function')throw gateError('BURP_RESTORE_UNAVAILABLE');
              binding.burp={...binding.resume.burp,...await restoreBurp(session,binding.resume.burp,userExec)};
            }
            binding.burp?.check?.();
          }
          await store.updateApprovalExecution(session,approvalId,{status:action==='allow'?'approved':'rejected',approvalSource:'human-command',userDecision:action,note,executionState:action==='allow'?'authorized':'rejected'});
          signal?.throwIfAborted();current();
          const result=task.state==='active'?{id:task.id,state:task.state,digest:task.digest}:broker.commandPlane.decide(session,binding.taskId,binding.digest,action);
          pending.delete(identity);
          if(action==='allow'&&binding.hostExecution)return await track(executeHost(session,binding,approvalId,store,signal));
          return action==='allow'&&binding.resume?.shell?{...result,resumeTool:'src_egress_plan',taskId:binding.taskId}:result;
        } finally {deciding.delete(identity);}
      }}),

    async close(){
      if(closed)return;closed=true;unsubscribe?.();scopeRequests.clear();shutdown.abort(gateError('CLOSED'));
      await Promise.allSettled([...sessions.values(),...retiredProxies].map(async work=>(await work).close()));
      await Promise.allSettled([...preparation.values(),...publishing.values(),...tracked,scopeWrite]);
      scopeRequests.clear();sessions.clear();retiredProxies.clear();activeProxies.clear();pending.clear();shellPlans.clear();scopes.clear();broker.close();
    },
  };
}
