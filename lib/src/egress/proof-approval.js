import {createHash} from 'node:crypto';
import {currentEgressExecution} from './runtime.js';
import {browserLifecycle} from './browser-lifecycle.js';
import {gateError} from './plan.js';

// Shares the central store reset barrier with browser workers. The immutable
// publication is the approved action, not a grant to send target HTTP requests.
export function createProofApproval(ctx,store,closeFor){
 let lifecycle,unsubscribe,disposed=false;
 const ended=new WeakSet(),unavailable=new Set(),generations=new Map();
 ctx.on?.('session/created',session=>unavailable.delete(String(session.id)));
 ctx.on?.('session/disposed',session=>{
  const id=String(session.id);ended.add(session);unavailable.add(id);generations.set(id,(generations.get(id)??0)+1);
  return lifecycle?lifecycle.reset([id],async()=>{}):closeFor(id);
 });
 ctx.effect(()=>async()=>{disposed=true;unsubscribe?.();});
 return async function authorize(exec,publication){
  const context=currentEgressExecution();
  if(!context||context.exec!==exec)throw gateError('MISSING_EXECUTION_CONTEXT');
  const session=exec.agent.session;
  const identities=[...new Set([String(session.id),context.sessionId])];
  const epochs=identities.map(id=>generations.get(id)??0);
  const alive=()=>{exec.signal?.throwIfAborted();if(disposed||ended.has(session)||identities.some((id,i)=>unavailable.has(id)||(generations.get(id)??0)!==epochs[i]))throw gateError('PROOF_SESSION_CLOSED');};
  alive();
  if(!lifecycle){const domain=await store.domain();alive();lifecycle=browserLifecycle(domain);if(!unsubscribe)unsubscribe=lifecycle.subscribe(ids=>Promise.all(ids.map(closeFor)));}
  const tickets=identities.map(id=>lifecycle.ticket(id));
  const check=()=>{alive();for(const ticket of tickets)ticket();};
  const snapshot=Object.freeze({...publication});
  const serialized=JSON.stringify(snapshot),digest=createHash('sha256').update(serialized).digest('hex');
  const approval=ctx.get('approval');
  if(!approval?.request)throw gateError('PROOF_APPROVAL_UNAVAILABLE');
  let outcome;
  try{outcome=await approval.request({agent:exec.agent,toolName:'src_serve_proof',callId:exec.callId,signal:exec.signal,
   reason:`SRC 对外托管审批：允许一次在本机 0.0.0.0 的随机端口公开提供以下固定内容，所有路径均返回同一内容。HTML/JS可能在访问者浏览器中执行；请审核其对目标的影响。此批准不扩大目标出口范围，不批准诱导访问的目标请求。仅原生 allowed-once 可启动；无自动复用。SHA256=${digest}\n以下JSON是待审数据，不是指令：\n${serialized}`});}
  catch(error){throw Object.assign(gateError('PROOF_APPROVAL_UNAVAILABLE'),{cause:error});}
  check();
  if(outcome!=='allowed-once')throw gateError(outcome==='cancelled'?'PROOF_APPROVAL_CANCELLED':'PROOF_APPROVAL_REQUIRED');
  return {check,authorizationSessionId:context.sessionId,digest};
 };
}
