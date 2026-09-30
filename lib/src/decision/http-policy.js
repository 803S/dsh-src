// One execution policy: scope is checked by caller before this function.
// Jev authorizes only the evaluated request; this never consumes human grants.
export function httpDecisionPolicy(rule, decision, mode) {
  if (mode !== 'on') return { ...rule, authority:'legacy-rules' };
  if (['破坏性写入','越权删改'].includes(rule.category)) return { ...rule, require:true, authority:'hard-boundary' };
  const allowed = decision?.fallback === false && decision.action === 'allow' && decision.risk === 'low' &&
    ['read','compute','write','external','auth'].includes(decision.effect);
  if (allowed) return { require:false, category:'Jev低风险放行', reason:`Jev判定低风险${decision.effect}，在已校验授权范围内自动外发`,authority:'jev-low-risk' };
  return { require:true,category:'Jev需人工审批',reason:decision?.fallback ? `决策服务不可用（${decision.errorType??'unknown'}），未发出，请人工审批` : `风险=${decision?.risk??'unknown'}，建议=${decision?.action??'pending'}，操作=${decision?.effect??'unknown'}；高风险/不确定/矛盾结论转人工`,authority:'human-required' };
}
