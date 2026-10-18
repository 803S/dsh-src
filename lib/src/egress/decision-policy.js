import { PLAN_LANE_AUTO_EFFECTS, OBJECT_CLASS_SCOPED_EFFECTS, OBJECT_CLASSES, EFFECTS } from '../decision/effect-policy.js';
// Consume the validated Jev decision, as the existing single-request policy does.
// The classification confidence is not a calibrated probability of a safe
// operation. Keep it for audit; do not add a second 0.9 authorization
// threshold on top of the service's read/low/allow verdict. Request-level hard
// vetoes and frozen-scope/budget checks are independent and remain mandatory.
export function allowsLowImpact(advice, plan, owned=[]) {
  if(!(advice?.fallback===false && advice.mode==='on' && advice.action==='allow' && advice.risk==='low'
    && Number.isFinite(advice.confidence) && advice.confidence>=0 && advice.confidence<=1))return false;
  // unknown操作分类不等于unknown风险；明确low/allow仍可批准有限的非替换/删除请求。
  if(PLAN_LANE_AUTO_EFFECTS.includes(advice.effect))return !plan?.entries.some(e=>['PUT','PATCH','DELETE'].includes(e.request.method));
  if(!plan||plan.maxRequests!==1||plan.entries.length!==1)return false;
  const request=plan.entries[0].request;
  if(advice.effect==='write'&&advice.objectClass==='new-test-file')return request.method==='POST'||request.method==='PUT'&&request.headers.some(([name,value])=>name==='if-none-match'&&value==='*');
  return OBJECT_CLASS_SCOPED_EFFECTS.includes(advice.effect)&&advice.objectClass==='owned-test-file'&&owned.length===1;
}

// Durable diagnostic data, never another source of authority. Only enumerated
// fields enter approval history; no provider prose, request secrets or raw reply.
// authority 说明本次判定由谁作出：hard-boundary=本地确定危害终审、hard-rules=本地明确只读放行、
// jev-low-risk=判定服务低风险放行、jev-unavailable=判定服务不可用/返回不合法而挂人工、
// human-required=判定服务要求人工、legacy-rules=判定服务未启用时沿用本地规则。
// errorType 保留判定失败原因（timeout/network/schema/http-XXX 等），否则卡片只写
// mode=unknown 无法区分“未启用”与“调用失败”（审计 2026-10-13 诊断缺口）。
export function reviewSummary(advice,{hardVeto=false,hostExecution=false,authority}={}) {
  const pick=(value,allowed)=>allowed.includes(value)?value:'unknown';
  return {
    effect:pick(advice?.effect,EFFECTS),
    risk:pick(advice?.risk,['low','high','unknown']),
    action:pick(advice?.action,['allow','pending']),
    mode:pick(advice?.mode,['on','off','shadow','not-applicable']),
    fallback:advice?.fallback!==false,
    objectClass:pick(advice?.objectClass,OBJECT_CLASSES),
    hardVeto:hardVeto===true,hostExecution:hostExecution===true,
    authority:pick(authority,['hard-boundary','hard-rules','jev-low-risk','jev-unavailable','human-required','legacy-rules']),
    ...(advice?.errorType?{errorType:String(advice.errorType).slice(0,64)}:{}),
  };
}
