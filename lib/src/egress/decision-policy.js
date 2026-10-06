// Consume the validated Jev decision, as the existing single-request policy does.
// The minimum of three answer-confidence scores is not a calibrated probability
// of a safe operation. Keep it for audit; do not add a second 0.9 authorization
// threshold on top of the service's read/low/allow verdict. Request-level hard
// vetoes and frozen-scope/budget checks are independent and remain mandatory.
export function allowsLowImpact(advice) {
  return advice?.fallback===false && advice.mode==='on'
    && advice.action==='allow' && advice.risk==='low' && ['read','compute'].includes(advice.effect)
    && Number.isFinite(advice.confidence) && advice.confidence>=0 && advice.confidence<=1;
}

// Durable diagnostic data, never another source of authority. Only enumerated
// fields enter approval history; no provider prose, request secrets or raw reply.
export function reviewSummary(advice,{hardVeto=false,hostExecution=false}={}) {
  const pick=(value,allowed)=>allowed.includes(value)?value:'unknown';
  return {
    effect:pick(advice?.effect,['read','compute','write','external','auth','destructive','unknown']),
    risk:pick(advice?.risk,['low','high','unknown']),
    action:pick(advice?.action,['allow','pending']),
    mode:pick(advice?.mode,['on','off','shadow']),
    fallback:advice?.fallback!==false,
    hardVeto:hardVeto===true,hostExecution:hostExecution===true,
  };
}
