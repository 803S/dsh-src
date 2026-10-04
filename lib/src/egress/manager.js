// Host singleton: lifecycle, trusted scope, pending-row adapter and owned proxies.
// No model-facing setters for scope, decisions, ledger keys or process options.
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, open, rename, realpath, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createEgressBroker } from './broker.js';
import { createProxyControlServer } from './control-server.js';
import { startSessionProxy } from './proxy-process.js';
import { canonicalRequest, gateError, requiresHuman } from './plan.js';
import { pinOrigin, pinnedLookup, validateStoredScope } from './scope.js';
import { proxyResponse } from './evidence.js';
import { isPublicLookup, publicLookup } from './public-lookup.js';
import { presentPlan } from './plan-presentation.js';
import { normalizeSafetyPlan, safetyRequests, executeApprovedRequest } from './safety-plan.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOST_REQUEST=Symbol('host-request'), SINGLE_REQUEST=Symbol('single-request');
const hash = value => createHash('sha256').update(value).digest('hex');

export async function createEgressManager({ home, assess, storeFor, directFetch, proxyExecutable, recordEvidence, allowLoopbackFixtures=false }) {
  const root = path.join(home, 'control', 'src-egress');
  await mkdir(root, { recursive:true, mode:0o700 }); await chmod(root,0o700);
  const keyFile = path.join(root,'binding-key');
  try {
    const file=await open(keyFile,'wx',0o600);
    try {await file.writeFile(randomBytes(32));await file.sync();}finally {await file.close();}
    const directory=await open(root,'r');try {await directory.sync();}finally {await directory.close();}
  } catch(error) { if(error.code !== 'EEXIST') throw error; }
  const key = await readFile(keyFile);
  const scopes = new Map(), sessions = new Map(), pending = new Map(), preparation = new Map(), shellPlans = new Map();
  const scopeFile = path.join(root,'scopes.json');
  try {
    const saved = JSON.parse(await readFile(scopeFile,'utf8'));
    if (!Array.isArray(saved)) throw gateError('CORRUPT_SCOPES');
    for (const entry of saved){if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string')throw gateError('CORRUPT_SCOPES');scopes.set(entry[0],validateStoredScope(entry[1],{allowLoopbackFixtures}));}
  } catch(error) { if(error.code !== 'ENOENT') throw error; }
  const broker = createEgressBroker({filename:path.join(root,'ledger.sqlite'),key,scopeFor:session=>scopes.get(session),...(assess?{assess}:{})});
  key.fill(0);
  let closed = false, scopeWrite = Promise.resolve();
  const shutdown = new AbortController();
  const tracked = new Set(), activeProxies = new Set();
  function track(work) { tracked.add(work); work.finally(()=>tracked.delete(work)).catch(()=>{}); return work; }
  function execution(exec={}) { return {...exec,signal:exec.signal?AbortSignal.any([exec.signal,shutdown.signal]):shutdown.signal}; }
  function prunePending() {
    for(const [id,binding] of pending)if(binding.expiresAt<=Date.now())pending.delete(id);
  }
  const ensureOpen = () => { if(closed) throw gateError('CLOSED'); };
  function requireScope(session) {
    ensureOpen(); const scope = scopes.get(session);
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
  async function setUserScope(session, origins) {
    ensureOpen();
    if(typeof session !== 'string' || !session || !Array.isArray(origins) || !origins.length || origins.length > 256) throw gateError('INVALID_SCOPE');
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
      ensureOpen();
      if(!scopes.has(session)&&scopes.size>=1024)throw gateError('SCOPE_CAPACITY');
      const next = new Map(scopes);
      next.set(session,{origins:exact,pins,revision:randomUUID(),credentialRevision:randomUUID()});
      const temporary=scopeFile+'.'+randomUUID()+'.tmp';
      try {
        const file=await open(temporary,'wx',0o600);
        try { await file.writeFile(JSON.stringify([...next])); await file.sync(); } finally { await file.close(); }
        ensureOpen(); await rename(temporary,scopeFile);
        const directory=await open(root,'r');try {await directory.sync();}finally {await directory.close();}
      }
      finally { await rm(temporary,{force:true}); }
      scopes.clear(); for(const [id,scope] of next)scopes.set(id,scope);
      return structuredClone(next.get(session));
    });
    scopeWrite=work;return work;
  }
  async function publishPending(session, task, input) {
    prunePending();
    if(pending.size>=128)throw gateError('PENDING_CAPACITY');
    const store = await storeFor(session);
    ensureOpen();
    if (!store) throw gateError('APPROVAL_STORE_UNAVAILABLE');
    // Full request secrets are held only by broker, not put into a session event.
    const summary=presentPlan(input);
    const row = await store.addPendingApproval(session,{method:'TASK',url:`src-egress://${task.id}`,path:'/',headers:'',body:JSON.stringify(summary.hostExecution?{entries:summary.entries,safety:summary.hostExecution.safety}:summary.entries),
      category:'egress/task',reason:`有界任务待审；${input.entries.length}个精确请求，最多${input.maxRequests}次，间隔${input.minIntervalMs}ms；摘要${task.digest}`,
      justification:summary.purpose});
    pending.set(`${session}:${row.id}`,{taskId:task.id,digest:task.digest,hostExecution:input.hostExecution,expiresAt:broker.commandPlane.inspect(session,task.id).plan.expiresAt});
    return row.id;
  }
  async function propose(session,input,exec={},permit) {
    requireScope(session);
    exec=execution(exec);
    if(input.hostExecution&&permit!==HOST_REQUEST)throw gateError('INVALID_PLAN_FIELD');
    let task = await broker.propose(session,input,exec);
    if(task.state==='pending'&&permit===SINGLE_REQUEST){
      const request=input.entries[0].request;
      const readable=!requiresHuman({entries:[{request:{...request,headers:[]}}]});
      const safety=readable?{effect:'read',object:request.url,recovery:'只读单笔请求；不自动重试或补偿'}:null;
      task=broker.prepareSingle(session,task.id,safety);
      input=broker.commandPlane.inspect(session,task.id).plan;
    }
    if(task.state==='pending') {
      try { task.approvalId=await publishPending(session,task,input); }
      catch(error){broker.commandPlane.revoke(session,task.id);throw error;}
    }
    return task;
  }
  async function authorize(session,input,exec={}) {
    requireScope(session);
    exec=execution(exec);
    const request=canonicalRequest(input);
    let existing=exec.egressTaskId?{id:exec.egressTaskId,state:'active'}:broker.find(session,request);
    if(!existing) {
      const identity=session+':'+hash(JSON.stringify(request));
      let work=preparation.get(identity);
      if(!work){
        if(preparation.size>=4)throw gateError('ASSESSMENT_CAPACITY');
        work=(async()=>{
          const assessmentExec=exec.deferAssessment?{...exec,signal:shutdown.signal}:exec;
          // First assess an ordinary one-request plan. Only a pending decision
          // is converted to a command-only execution lane; no extra Jev call.
          let safety;
          if(exec.egressSafetyPlan)safety=await normalizeSafetyPlan({home,session,request,input:exec.egressSafetyPlan,origins:requireScope(session).origins});
          if(safety){
            const entries=safetyRequests(request,safety);
            return propose(session,{entries,maxRequests:entries.reduce((n,e)=>n+e.maxRequests,0),minIntervalMs:250,lifetimeMs:300000,purpose:exec.egressPurpose??'单笔请求与前置条件/验证的人工审批',hostExecution:{request,safety}},assessmentExec,HOST_REQUEST);
          }
          return propose(session,{entries:[{request,maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:300000,purpose:exec.egressPurpose??'单笔目标请求，完整内容由出口捕获；需审核实际语义'},assessmentExec,SINGLE_REQUEST);
        })();
        preparation.set(identity,work);
        work.finally(()=>preparation.delete(identity)).catch(()=>{});
      }
      if(exec.deferAssessment)throw gateError('ASSESSING_NOT_SENT');
      existing=await work;
    }
    if(existing.state!=='active')throw Object.assign(gateError('PENDING_OR_REJECTED'),{taskId:existing.id,approvalId:existing.approvalId,state:existing.state});
    // Waiting never renews a task or consumes an extra grant; dead/unknown sends
    // eventually return busy, not an automatic replay or unlimited queue.
    for(let attempt=0;attempt<(exec.deferAssessment?6:60);attempt++){
      exec.signal?.throwIfAborted();
      try{return broker.dataPlane.claim(session,existing.id,request);}
      catch(error){if(!['SRC_GATE_RATE_LIMIT','SRC_GATE_ORIGIN_BUSY'].includes(error.code)||attempt===(exec.deferAssessment?5:59))throw error;await delay(250);}
    }
  }
  async function sessionProxy(session) {
    ensureOpen();
    if(typeof session!=='string'||!session)throw gateError('INVALID_SESSION');
    let work=sessions.get(session);
    if(work){
      const proxy=await work;
      if(!proxy.alive()){
        await proxy.waitForParking();ensureOpen();
        if(!activeProxies.has(session)&&activeProxies.size>=4)throw gateError('PROXY_CAPACITY');
        activeProxies.add(session);
        try{await proxy.activate();}catch(error){activeProxies.delete(session);throw error;}
      }
      return proxy;
    }
    if(sessions.size>=1024)throw gateError('SESSION_CAPACITY');
    if(activeProxies.size>=4)throw gateError('PROXY_CAPACITY');
    activeProxies.add(session);
    work=(async()=>{
      const directory=path.join(root,hash(session));await mkdir(directory,{recursive:true,mode:0o700});
      const socketDirectory=await mkdtemp('/private/tmp/src-egress-');
      const socket=path.join(socketDirectory,'control.sock');
      const token=randomBytes(32).toString('hex');
      const control=createProxyControlServer({sessionId:session,taskId:'host-selected',token,dataPlane:{
        claim:async(_session,_task,request,meta)=>{
          const target=new URL(request.url);
          requireScope(session);
          const grant=await authorize(session,request,{egressTaskId:shellPlans.get(session),deferAssessment:true,signal:meta?.signal});
          let pin;
          try{pin=boundPins(session,request.url,grant)[0];}catch(error){broker.dataPlane.finish(session,grant.dispatchId,'outcome_unknown');throw error;}
          return {...grant,upstreamAddress:pin.address,upstreamPort:Number(target.port)||(target.protocol==='https:'?443:80)};
        },
        finish:async(id,dispatch,outcome,response,context)=>{
          try{
            if(outcome==='response_received'){
              const actual=proxyResponse(response);
              if(recordEvidence)await recordEvidence(id,{request:canonicalRequest(context.request),response:actual,grant:context.grant});
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
        proxy=await startSessionProxy({directory:path.join(directory,'mitm'),publicCA:path.join(publicDirectory,'ca.pem'),controlSocket:socket,token,executable:proxyExecutable,canPark:()=>!broker.hasActiveTasks(session),onPark:()=>activeProxies.delete(session)});
        return {...proxy,get pid(){return proxy.pid;},readOnlyPaths:[publicDirectory],protectedPaths:[root,await realpath(root),socketDirectory],close:cleanup};
      }catch(error){await cleanup();throw error;}
    })();
    work.catch(()=>activeProxies.delete(session));
    sessions.set(session,work);
    // Keep a failed startup terminal: never silently replace a dead proxy under live jobs.
    return work;
  }
  async function fetchTarget(session,url,init={},exec={}) {
    ensureOpen();
    if(typeof directFetch!=='function')throw gateError('TRANSPORT_UNAVAILABLE');
    if(isPublicLookup(exec,url))return publicLookup(exec,session,url,init,directFetch);
    const headers=Array.isArray(init.headers)?init.headers:init.headers instanceof Headers?[...init.headers.entries()]:Object.entries(init.headers??{});
    const signal=exec.signal&&init.signal?AbortSignal.any([exec.signal,init.signal]):exec.signal??init.signal;
    exec={...exec,signal};
    if(init.body!==undefined&&typeof init.body!=='string'&&!Buffer.isBuffer(init.body))throw gateError('UNSUPPORTED_BODY');
    const request=canonicalRequest({url:String(url),method:init.method??'GET',headers,bodyBase64:Buffer.from(init.body??'').toString('base64')});
    const grant=await authorize(session,request,exec);
    try{
      exec.signal?.throwIfAborted();
      const pins=boundPins(session,request.url,grant);
      const response=await directFetch(request.url,{...init,lookup:pinnedLookup(pins),method:request.method,headers:Object.fromEntries(request.headers),redirect:'manual',signal});
      if(recordEvidence)await recordEvidence(session,{request,response,grant});
      broker.dataPlane.finish(session,grant.dispatchId,'response_received');
      return response;
    }catch(error){
      try{broker.dataPlane.finish(session,grant.dispatchId,'outcome_unknown');}catch{}
      // It is not safe to retry merely because evidence persistence failed.
      error.safeNotSent=false;throw error;
    }
  }
  async function executeHost(session,binding,approvalId,store,signal) {
    signal=execution({signal}).signal;
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
        const response=await directFetch(exact.url,{lookup:pinnedLookup(pins),method:exact.method,headers:Object.fromEntries(exact.headers),body:exact.bodyBase64?Buffer.from(exact.bodyBase64,'base64'):undefined,redirect:'manual',signal});
        if(recordEvidence)await recordEvidence(session,{request:exact,response,grant});
        broker.dataPlane.finish(session,grant.dispatchId,'response_received');
        return response;
      }catch(error){try{broker.dataPlane.finish(session,grant.dispatchId,'outcome_unknown');}catch{}throw error;}
    };
    try {
      const outcome=await executeApprovedRequest({request,safety,send,signal,onPhase:async phase=>{
        await store.updateApprovalExecution(session,approvalId,{executionState:phase});
        if(phase==='sending')sent=true;
      }});
      const result={status:'approved',executionState:outcome.verification==='mismatch'||outcome.verification==='unavailable'?'unknown':'executed',responseStatus:outcome.response.status,writeOutcome:{verification:outcome.verification,recovery:outcome.recovery}};
      if(result.executionState==='unknown')broker.commandPlane.quarantine(session,binding.taskId);
      await store.updateApprovalExecution(session,approvalId,result);
      broker.commandPlane.revoke(session,binding.taskId);
      return result;
    }catch(error){
      if(sent)broker.commandPlane.quarantine(session,binding.taskId);
      broker.commandPlane.revoke(session,binding.taskId);
      await store.updateApprovalExecution(session,approvalId,{status:'approved',executionState:sent?'unknown':'failed-before-send',executionError:error.code??'EGRESS_EXECUTION_FAILED'});
      throw error;
    }
  }
  return {
    propose,
    async preparePending(session,approvalId,input,exec={}) {
      requireScope(session);exec.signal?.throwIfAborted();
      const old=pending.get(`${session}:${approvalId}`);
      if(!old)throw gateError('STALE_APPROVAL');
      const original=broker.commandPlane.inspect(session,old.taskId);
      const request=original.plan.hostExecution?.request;
      if(!request)throw gateError('NOT_SINGLE_REQUEST');
      const safety=await normalizeSafetyPlan({home,session,request,input,origins:requireScope(session).origins});
      exec.signal?.throwIfAborted();
      const task=broker.prepareSingle(session,old.taskId,safety);
      pending.delete(`${session}:${approvalId}`);
      const next=broker.commandPlane.inspect(session,task.id).plan;
      try {task.approvalId=await publishPending(session,task,next);}
      catch(error){broker.commandPlane.revoke(session,task.id);throw error;}
      const store=await storeFor(session);
      await store.updateApprovalExecution(session,approvalId,{status:'rejected',executionState:'superseded',note:`安全材料已更新，旧批准无效；请审核 ${task.approvalId}`});
      return task;
    },
    async proposeShellTask(session,input,exec) {
      const task=await propose(session,input,exec);
      shellPlans.set(session,task.id);
      return task;
    },
    fetch:(...args)=>track(fetchTarget(...args)),sessionProxy,
    // Install only in the trusted command handler, never tools/execute context.
    user:Object.freeze({setScope:setUserScope,getScope:session=>structuredClone(scopes.get(session)),
      status(){ensureOpen();return {activeWorkerSlots:activeProxies.size,maxWorkers:4,reservedSessionPorts:sessions.size,idleStopMs:120000};},
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
        const binding=pending.get(`${session}:${approvalId}`);
        if(binding){
          try {const row=broker.commandPlane.inspect(session,binding.taskId);return {...row,plan:presentPlan(row.plan)};}
          catch(error){if(!['SRC_GATE_UNKNOWN_TASK','SRC_GATE_EXPIRED','SRC_GATE_SCOPE_CHANGED'].includes(error.code))throw error;}
        }
        const store=await storeFor(session);
        const row=await store.getPendingApproval(session,approvalId);
        if(row?.category!=='egress/task')throw gateError('UNKNOWN_TASK');
        return {state:'stale',approvalId,executable:false,reason:'授权已过期、范围已变更或服务已重启；旧审批不可执行。核对结果后使用 reconcile，再提交新任务。',summary:row.body};
      },
      async decide(session,approvalId,action,note='',signal){
        const binding=pending.get(`${session}:${approvalId}`);if(!binding)throw gateError('STALE_APPROVAL');
        const store=await storeFor(session);
        const result=broker.commandPlane.decide(session,binding.taskId,binding.digest,action);
        if(action==='allow'&&binding.hostExecution){
          pending.delete(`${session}:${approvalId}`);
          return track(executeHost(session,binding,approvalId,store,signal));
        }
        await store.updateApprovalExecution(session,approvalId,{status:action==='allow'?'approved':'rejected',approvalSource:'human-command',userDecision:action,note,executionState:action==='allow'?'authorized':'rejected'});
        pending.delete(`${session}:${approvalId}`);return result;
      }}),
    async close(){
      if(closed)return;closed=true;shutdown.abort(gateError('CLOSED'));
      await Promise.allSettled([...sessions.values()].map(async work=>(await work).close()));
      await Promise.allSettled([...preparation.values(),...tracked,scopeWrite]);
      sessions.clear();activeProxies.clear();pending.clear();shellPlans.clear();scopes.clear();broker.close();
    },
  };
}
