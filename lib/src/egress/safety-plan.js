import { createHash } from 'node:crypto';
import { canonicalRequest, gateError, requiresHuman } from './plan.js';
import { readResponseSnapshot } from '../write-safety.js';
const sha256=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw gateError(code);};
const nonempty=value=>typeof value==='string'&&value.trim().length>0&&value.length<=4096;
function readStep(input, origins) {
  if(!input||Object.keys(input).some(key=>!['request','status','bodySha256'].includes(key)))fail('INVALID_SAFETY_READ');
  const request=canonicalRequest(input.request);
  if(!['GET','HEAD'].includes(request.method)||!origins.includes(new URL(request.url).origin))fail('INVALID_SAFETY_READ');
  // Credential presence alone is not a destructive read, but action-like URLs
  // cannot serve as a supposedly passive precondition/readback request.
  if(requiresHuman({entries:[{request:{...request,headers:[]}}]}))fail('UNSAFE_SAFETY_READ');
  if(!Number.isInteger(input.status)||input.status<200||input.status>599)fail('INVALID_SAFETY_STATUS');
  if(typeof input.bodySha256!=='string'||!/^[a-f0-9]{64}$/.test(input.bodySha256))fail('SAFETY_HASH_REQUIRED');
  return {request,status:input.status,bodySha256:input.bodySha256};
}
export async function normalizeSafetyPlan({home,session,request,input,origins}) {
  if(!input||typeof input!=='object'||Array.isArray(input))fail('SAFETY_PLAN_REQUIRED');
  if(Object.keys(input).some(key=>!['effect','object','recovery','backupRef','precondition','verification','irreversibleAcknowledgement'].includes(key)))fail('INVALID_SAFETY_PLAN');
  if(!['read','compute','replace','create','delete','external'].includes(input.effect)||!nonempty(input.object)||!nonempty(input.recovery))fail('INVALID_SAFETY_PLAN');
  const effect=input.effect;
  if(effect==='read'&&!['GET','HEAD','OPTIONS'].includes(request.method))fail('SAFETY_EFFECT_CONTRADICTION');
  if(effect==='read'&&requiresHuman({entries:[{request:{...request,headers:[]}}]}))fail('SAFETY_EFFECT_CONTRADICTION');
  if(request.method==='DELETE'&&effect!=='delete')fail('SAFETY_EFFECT_CONTRADICTION');
  if(['PUT','PATCH'].includes(request.method)&&effect!=='replace')fail('SAFETY_EFFECT_CONTRADICTION');
  if(['read','compute'].includes(effect)) {
    // A user explicitly reviews compute semantics; it never gets a batch grant.
    return {effect,object:input.object,recovery:input.recovery};
  }
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
