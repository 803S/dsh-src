import { createHash } from 'node:crypto';
import { canonicalRequest, gateError, requiresHuman, readClearRequest } from './plan.js';
import { readResponseSnapshot } from '../write-safety.js';
import { READ_LIKE_EFFECTS, SAFETY_EFFECTS, SAFETY_READ_EFFECTS, SAFETY_MATERIAL_STEP_EFFECTS, SAFETY_BACKUP_EFFECTS, materialEffectsFor } from '../decision/effect-policy.js';
const sha256=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw gateError(code);};
const nonempty=value=>typeof value==='string'&&value.trim().length>0&&value.length<=4096;
// 只从冻结的Jev判定补齐旧只读单；绝不把GET本身当作无副作用证明。
// 例外：本地明确只读（读方法 + 无任何可疑语义词）本身就是确定性事实，不依赖判定服务是否调用成功。
export function reviewedReadSafety(request, review) {
  if (!request || !['GET','HEAD','OPTIONS','POST'].includes(request.method) || requiresHuman({entries:[{request}]})) return null;
  if (readClearRequest(request)) return {effect:'read',object:request.url,recovery:'只读单笔请求；不自动重试或补偿'};
  if (!READ_LIKE_EFFECTS.includes(review?.effect) || review.risk!=='low'
    || review.action!=='allow' || review.fallback!==false || review.mode!=='on') return null;
  // external-probe 与 read/compute 同级放行，但文案必须如实说明它确实出网（只是没有对外影响），
  // 不能让它冒充“只读”，否则审批记录会丢掉“目标向我方探测端发起过回调”这个事实。
  return review.effect==='external-probe'
    ? {effect:'external-probe',object:request.url,recovery:'有界外发探测：仅让目标对我方控制端发起一次回调；不自动重试或补偿'}
    : {effect:review.effect,object:request.url,recovery:'只读/计算单笔请求；不自动重试或补偿'};
}
// 仅由可信人类命令使用：这是人类对冻结单笔语义的确认，不是Jev自动放行。
export function humanReadSafety(request, review) {
  if (!request || !['GET','HEAD','OPTIONS','POST'].includes(request.method)
    || review?.effect!=='unknown' || review.risk!=='unknown' || review.action!=='pending'
    || review.hardVeto===true || requiresHuman({entries:[{request}]})) return null;
  return {effect:'compute',object:request.url,recovery:'人类确认本笔仅读取/校验/计算，无持久写入、外发或资源耗尽；仅发送一次，不自动重试或补偿'};
}
// 模型的安全说明不能覆盖独立判定；旧冻结单也在批准前执行相同检查。
export function assertReviewedSafety(request, safety, review) {
  if(!safety)fail('SAFETY_PLAN_REQUIRED');
  const required=materialEffectsFor(review?.effect);
  if(required&&!required.includes(safety.effect))fail('SAFETY_EFFECT_CONTRADICTION');
  if(SAFETY_MATERIAL_STEP_EFFECTS.includes(safety.effect)&&(!safety.precondition||!safety.verification))fail('SAFETY_PLAN_REQUIRED');
  if(SAFETY_BACKUP_EFFECTS.includes(safety.effect)&&!nonempty(safety.backupRef))fail('SAFETY_PLAN_REQUIRED');
  if(safety.effect==='external'&&safety.irreversibleAcknowledgement!=='external-effect-cannot-be-automatically-undone')fail('IRREVERSIBLE_ACK_REQUIRED');
  if(request.method==='DELETE'&&safety.effect!=='delete'||['PUT','PATCH'].includes(request.method)&&safety.effect!=='replace')fail('SAFETY_EFFECT_CONTRADICTION');
}
function readStep(input, origins) {
  if(!input||Object.keys(input).some(key=>!['request','status','bodySha256'].includes(key)))fail('INVALID_SAFETY_READ');
  const request=canonicalRequest(input.request);
  if(!['GET','HEAD'].includes(request.method)||!origins.includes(new URL(request.url).origin))fail('INVALID_SAFETY_READ');
  // 这里仅拒绝编码/方法歧义；实际读取语义在人工批准前独立交给Jev核验。
  if(requiresHuman({entries:[{request:{...request,headers:[]}}]}))fail('UNSAFE_SAFETY_READ');
  if(!Number.isInteger(input.status)||input.status<200||input.status>599)fail('INVALID_SAFETY_STATUS');
  if(typeof input.bodySha256!=='string'||!/^[a-f0-9]{64}$/.test(input.bodySha256))fail('SAFETY_HASH_REQUIRED');
  return {request,status:input.status,bodySha256:input.bodySha256};
}
// 空对象是可选结构的空占位，不声称有检查；非空但无效的声明必须报错。
const hasStep=value=>value!==undefined&&!(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0);
export async function normalizeSafetyPlan({home,session,request,input,origins}) {
  if(!input||typeof input!=='object'||Array.isArray(input))fail('SAFETY_PLAN_REQUIRED');
  if(Object.keys(input).some(key=>!['effect','object','recovery','backupRef','precondition','verification','irreversibleAcknowledgement','semantics'].includes(key)))fail('INVALID_SAFETY_PLAN');
  if(input.semantics!==undefined&&!['replace','merge'].includes(input.semantics))fail('INVALID_SAFETY_PLAN');
  if(!SAFETY_EFFECTS.includes(input.effect))fail('INVALID_SAFETY_PLAN');
  const effect=input.effect;
  if(effect==='read'&&!['GET','HEAD','OPTIONS','POST'].includes(request.method))fail('SAFETY_EFFECT_CONTRADICTION');
  if(effect==='read'&&requiresHuman({entries:[{request:{...request,headers:[]}}]}))fail('SAFETY_EFFECT_CONTRADICTION');
  if(request.method==='DELETE'&&effect!=='delete')fail('SAFETY_EFFECT_CONTRADICTION');
  if(['PUT','PATCH'].includes(request.method)&&effect!=='replace')fail('SAFETY_EFFECT_CONTRADICTION');
  // 说明不产生授权；低风险仍由Jev审核。显式给出的检查必须验证并执行，不能静默丢弃。
  if(SAFETY_READ_EFFECTS.includes(effect))return {
    effect,object:nonempty(input.object)?input.object:request.url,
    recovery:nonempty(input.recovery)?input.recovery:'无自动重试或补偿；操作语义由Jev独立判定',
    ...(hasStep(input.precondition)?{precondition:readStep(input.precondition,origins)}:{}),
    ...(hasStep(input.verification)?{verification:readStep(input.verification,origins)}:{}),
  };
  if(!nonempty(input.object)||!nonempty(input.recovery))fail('INVALID_SAFETY_PLAN');
  const precondition=readStep(input.precondition,origins);
  const verification=readStep(input.verification,origins);
  if(['GET','HEAD'].includes(request.method)&&[precondition,verification].some(step=>step.request.url===request.url))fail('SIDE_EFFECT_URL_IS_NOT_READBACK');
  let backupRef;
  if(['replace','delete'].includes(effect)) {
    const original=await readResponseSnapshot(home,session,input.backupRef,precondition.request.url);
    if(sha256(Buffer.from(original.body))!==precondition.bodySha256)fail('BACKUP_PRECONDITION_MISMATCH');
    if(effect==='replace'&&request.method==='PUT'&&/json/i.test(original.contentType)) {
      let before,after;
      try {before=JSON.parse(original.body);after=JSON.parse(Buffer.from(request.bodyBase64,'base64').toString('utf8'));}catch{fail('INVALID_REPLACEMENT_JSON');}
      function preserveFields(a,b){if(a&&typeof a==='object'&&!Array.isArray(a))for(const key of Object.keys(a)){if(!b||!Object.hasOwn(b,key))fail('PARTIAL_REPLACEMENT');preserveFields(a[key],b[key]);}}
      preserveFields(before,after);
    }
    backupRef=input.backupRef;
  }
  if(effect==='external'&&input.irreversibleAcknowledgement!=='external-effect-cannot-be-automatically-undone')fail('IRREVERSIBLE_ACK_REQUIRED');
  return {effect,object:input.object,recovery:input.recovery,precondition,verification,...(backupRef?{backupRef}:{}),...(effect==='external'?{irreversibleAcknowledgement:input.irreversibleAcknowledgement}:{})};
}
export function safetyRequests(request,safety) {
  const ordered=[...(safety?.precondition?[safety.precondition.request]:[]),request,...(safety?.verification?[safety.verification.request]:[])];
  const entries=new Map();
  for(const item of ordered){const key=JSON.stringify(item),existing=entries.get(key);if(existing)existing.maxRequests++;else entries.set(key,{request:item,maxRequests:1});}
  return [...entries.values()];
}
export async function executeApprovedRequest({request,safety,send,signal,onPhase}) {
  signal?.throwIfAborted();
  if(safety?.precondition) {
    await onPhase('precondition');
    const before=await send(safety.precondition.request);
    const body=Buffer.from(await before.arrayBuffer());
    if(before.status!==safety.precondition.status||sha256(body)!==safety.precondition.bodySha256)fail('PRECONDITION_CHANGED');
  }
  await onPhase('sending');
  signal?.throwIfAborted();
  const response=await send(request);
  const result={response,verification:'not-required',recovery:safety?.recovery??'No automatic replay or compensation'};
  if(safety?.verification) {
    await onPhase('verification');
    try {
      const after=await send(safety.verification.request);
      const body=Buffer.from(await after.arrayBuffer());
      result.verification=after.status===safety.verification.status&&sha256(body)===safety.verification.bodySha256?'matched':'mismatch';
      result.verificationStatus=after.status;
    } catch {result.verification='unavailable';}
  }
  return result;
}
