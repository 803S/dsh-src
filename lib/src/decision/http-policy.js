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
  const method = String(context.method ?? '').toUpperCase();
  if (method === 'DELETE') return {
    require:true, category:'删除操作需人工确认', authority:'hard-boundary',
    reason:`${requestLabel({ ...context, rule })}；正在请求删除目标资源。可能造成数据丢失或服务不可用；尚未验证恢复条件，不能保证可逆。Jev的读取或低风险判断不能代替删除授权。请求未发出。`
  };
  if (['PUT','PATCH'].includes(method) && ['read','compute'].includes(decision?.effect)) return {
    require:true, category:'请求动作与风险分类矛盾', authority:'human-required',
    reason:`${requestLabel({ ...context, rule })}；请求使用写入方法，但Jev把它判为只读或纯计算。实际可能替换或修改资源、覆盖配置，影响尚不确定；未验证接口语义和恢复方案前不能承诺无副作用。请求未发出。`
  };
  if (['破坏性写入','越权删改'].includes(rule.category)) return { ...rule, require:true, authority:'hard-boundary', reason:`${requestLabel({ ...context, rule })}；命中本地硬边界：${rule.reason}` };
  const allowed = decision?.fallback === false && decision.action === 'allow' && decision.risk === 'low' &&
    ['read','compute','write','external','auth'].includes(decision.effect);
  if (allowed) return { require:false, category:'Jev低风险放行', reason:`${requestLabel({ ...context, rule })}；Jev允许低风险${decision.effect}，scope已校验，在授权策略内自动外发`,authority:'jev-low-risk' };
  return { require:true, category:'Jev需人工审批', reason:decisionReason(rule, decision, context), authority:'human-required' };
}

export { decisionReason, requestLabel };
