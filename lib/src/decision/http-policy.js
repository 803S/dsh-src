// One execution policy: scope is checked by caller before this function.
// Jev authorizes only the evaluated request; this never consumes human grants.
function requestLabel(context = {}) {
  const method = String(context.method ?? '').toUpperCase();
  const path = String(context.path ?? context.url ?? '');
  const effect = String(context.rule?.effect ?? context.rule?.category ?? 'unknown');
  return `${method || 'HTTP'} ${path || '<unknown>'}；规则=${effect}`;
}

function decisionReason(rule, decision, context = {}) {
  const request = requestLabel({ ...context, rule });
  if (decision?.fallback) return `${request}；Jev服务失败（${decision.errorType ?? 'unknown'}），未发出，需人工审批`;
  if (decision?.action === 'pending') return `${request}；Jev判定 pending（risk=${decision.risk ?? 'unknown'}，effect=${decision.effect ?? 'unknown'}），未发出，需人工审批`;
  if (decision?.action === 'reject') return `${request}；Jev拒绝（risk=${decision.risk ?? 'unknown'}，effect=${decision.effect ?? 'unknown'}），未发出，需人工审批`;
  if (decision?.risk === 'high' || decision?.risk === 'unknown' || decision?.effect === 'unknown') return `${request}；Jev结论不满足自动执行条件（risk=${decision.risk ?? 'unknown'}，verdict=${decision.action ?? 'pending'}，effect=${decision.effect ?? 'unknown'}），需人工审批`;
  return `${request}；未满足低风险自动执行联合条件（risk=${decision?.risk ?? 'unknown'}，verdict=${decision?.action ?? 'pending'}，effect=${decision?.effect ?? 'unknown'}），需人工审批`;
}

export function httpDecisionPolicy(rule, decision, mode, context = {}) {
  if (mode !== 'on') return { ...rule, authority:'legacy-rules', ...(rule.require ? { reason:`${requestLabel({ ...context, rule })}；本地规则要求人工审批：${rule.reason}` } : {}) };
  if (['破坏性写入','越权删改'].includes(rule.category)) return { ...rule, require:true, authority:'hard-boundary', reason:`${requestLabel({ ...context, rule })}；命中本地硬边界：${rule.reason}` };
  const allowed = decision?.fallback === false && decision.action === 'allow' && decision.risk === 'low' &&
    ['read','compute','write','external','auth'].includes(decision.effect);
  if (allowed) return { require:false, category:'Jev低风险放行', reason:`${requestLabel({ ...context, rule })}；Jev允许低风险${decision.effect}，scope已校验，在授权策略内自动外发`,authority:'jev-low-risk' };
  return { require:true, category:'Jev需人工审批', reason:decisionReason(rule, decision, context), authority:'human-required' };
}

export { decisionReason, requestLabel };
