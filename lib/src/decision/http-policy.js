// One execution policy: scope is checked by caller before this function.
// Jev authorizes only the evaluated request; this never consumes human grants.
import { IMPACT_DENYING_EFFECTS, READ_LIKE_EFFECTS, SINGLE_LANE_AUTO_EFFECTS } from './effect-policy.js';
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
  if (['PUT','PATCH'].includes(method) && READ_LIKE_EFFECTS.includes(decision?.effect)) return {
    require:true, category:'请求动作与风险分类矛盾', authority:'human-required',
    reason:`${requestLabel({ ...context, rule })}；请求使用写入方法，但Jev把它判为只读、纯计算或有界探测。实际可能替换或修改资源、覆盖配置，影响尚不确定；未验证接口语义和恢复方案前不能承诺无副作用。请求未发出。`
  };
  // [审批语义修正 2026-10-18] 名单里原本就写着 external，只因判定服务把 external 硬判 high 才从未生效——
  // 那等于把“真实外发不会自动”寄托在另一处的常量上。现按“影响”而非“是否出网”分级：
  // external-probe（只回调我方控制端）可自动；external（经业务通道向真实地址送达/费用/内部管理接口）一律人工。
  // 单笔车道可自动的分类唯一维护在 decision/effect-policy.js 的 LANE_AUTO_EFFECTS.single。
  const allowed = decision?.fallback === false && decision.action === 'allow' && decision.risk === 'low' &&
    SINGLE_LANE_AUTO_EFFECTS.includes(decision.effect);
  if (allowed) return { require:false, category:'Jev低风险放行', reason:`${requestLabel({ ...context, rule })}；Jev允许低风险${decision.effect}，scope已校验，在授权策略内自动外发`,authority:'jev-low-risk' };
  /* [local.150 用户拍板 2026-10-19] 无输入只读不再挂人工卡。
   * 判据是本地事实（security.js#impactFreeRead）：读方法 + 无正文 + 无查询串 + 无资源 id + 无强删改词 + 无影响类语义词。
   * 这类报文携带不了任何输入，不可能影响线上环境/业务数据/真实用户；判定服务此时的 unknown/pending/fallback
   * 三种“说不清”（包括调用方没申报用途）不再把成本转给人：发出去、记账，并把“未申报用途”记为调用方缺陷。
   * 判定服务仍然可以**否决**：reject / risk=high / effect∈{write,external,destructive} 一律继续挂人工卡，
   * “无影响”不推翻授权结论；本地硬边界在上面已先于本分支返回。 */
  const jevDenies = decision?.fallback === false && (decision.action === 'reject' || decision.risk === 'high' || IMPACT_DENYING_EFFECTS.includes(decision.effect));
  if (context.impactFree?.impactFree === true && !jevDenies) return {
    require:false, category:'无输入只读（本地事实）', authority:'read-suspicion-auto',
    reason:`${requestLabel({ ...context, rule })}；${context.impactFree.reason}；判定服务结论（risk=${decision?.risk ?? 'unknown'}，verdict=${decision?.action ?? 'unknown'}，effect=${decision?.effect ?? 'unknown'}，fallback=${decision?.fallback === true}）不改变本地事实：无输入读取不构成影响，本轮不挂人工审批。调用方未申报用途属调用方缺陷（审计记录已标注），请日后在 src_http 的 justification 里写明用途。`
  };
  return { require:true, category:'Jev需人工审批', reason:decisionReason(rule, decision, context), authority: decision?.fallback ? 'jev-unavailable' : 'human-required' };
}

export { decisionReason, requestLabel };
