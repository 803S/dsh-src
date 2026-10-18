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
  const method = String(context.method ?? '').toUpperCase();
  // ① 确定危害：本地终审，判定服务不能覆盖（也不依赖它是否启用）。
  if (method === 'DELETE' || rule?.hardBoundary === true) return {
    require:true, category:rule?.hardBoundary===true?(rule.category ?? '本地硬边界'):'删除操作需人工确认', authority:'hard-boundary',
    reason:rule?.hardBoundary===true
      ? `${requestLabel({ ...context, rule })}；命中本地确定危害（终审，判定服务无权覆盖）：${rule.reason}请求未发出。`
      : `${requestLabel({ ...context, rule })}；正在请求删除目标资源。可能造成数据丢失或服务不可用；尚未验证恢复条件，不能保证可逆。Jev的读取或低风险判断不能代替删除授权。请求未发出。`
  };
  // ② 明确只读：本地事实，直接放行，不调用、也不等待判定服务。
  if (rule?.verdict === 'read-clear') return { require:false, category:'只读方法（本地硬规则）', authority:'hard-rules', reason:`${requestLabel({ ...context, rule })}；${rule.reason}（未调用判定服务）` };
  // ③ 其余交判定服务；服务未启用时沿用本地规则（legacy）。
  if (mode !== 'on') return { ...rule, authority:'legacy-rules', ...(rule.require ? { reason:`${requestLabel({ ...context, rule })}；本地规则要求人工审批（判定服务未启用）：${rule.reason}` } : {}) };
  if (['PUT','PATCH'].includes(method) && ['read','compute'].includes(decision?.effect)) return {
    require:true, category:'请求动作与风险分类矛盾', authority:'human-required',
    reason:`${requestLabel({ ...context, rule })}；请求使用写入方法，但Jev把它判为只读或纯计算。实际可能替换或修改资源、覆盖配置，影响尚不确定；未验证接口语义和恢复方案前不能承诺无副作用。请求未发出。`
  };
  // [审批语义修正 2026-10-18] 名单里原本就写着 external，只因判定服务把 external 硬判 high 才从未生效——
  // 那等于把“真实外发不会自动”寄托在另一处的常量上。现按“影响”而非“是否出网”分级：
  // external-probe（只回调我方控制端）可自动；external（经业务通道向真实地址送达/费用/内部管理接口）一律人工。
  const allowed = decision?.fallback === false && decision.action === 'allow' && decision.risk === 'low' &&
    ['read','compute','write','external-probe','auth'].includes(decision.effect);
  if (allowed) return { require:false, category:'Jev低风险放行', reason:`${requestLabel({ ...context, rule })}；Jev允许低风险${decision.effect}，scope已校验，在授权策略内自动外发`,authority:'jev-low-risk' };
  return { require:true, category:'Jev需人工审批', reason:decisionReason(rule, decision, context), authority: decision?.fallback ? 'jev-unavailable' : 'human-required' };
}

export { decisionReason, requestLabel };
