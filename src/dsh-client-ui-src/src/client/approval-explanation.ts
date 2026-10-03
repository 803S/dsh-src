export type ApprovalExplanationInput = {
  method: string
  url: string
  body?: string
  category?: string
  justification?: string
  layaAdvice?: string
  safetyPlan?: {backupRef?:string; snapshotVerified?:boolean; recovery?:string; validationError?:string}
  writeOutcome?: {warning?:string}
}

export type ApprovalExplanation = {
  operation: string
  target: string
  purpose: string
  consequences: string[]
  recovery: string
  decision: string
}

const boundedText = (value: string, limit: number) => {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit) + '…（完整说明见详情）' : text
}

// Explain the stored request, not a regenerated request or the model's safety promises.
// No endpoint-specific allowlists; HTTP method is an operation signal, not proof of safety.
export function explainApproval(input: ApprovalExplanationInput): ApprovalExplanation {
  const method = input.method.toUpperCase()
  let target = '目标地址无法解析，请先核对原始请求'
  try {
    const url = new URL(input.url)
    target = boundedText(`${url.host}${url.pathname}`, 160)
  } catch { /* Never hide a malformed target behind an inferred destination. */ }
  let effect = 'unknown', risk = 'unknown', verdict = 'pending', failed = false
  try {
    const advice: unknown = JSON.parse(input.layaAdvice ?? '{}')
    if (advice && typeof advice === 'object') {
      const row = advice as Record<string, unknown>
      if (typeof row.effect === 'string') effect = row.effect
      if (typeof row.risk === 'string') risk = row.risk
      if (typeof row.verdict === 'string') verdict = row.verdict
      failed = row.fallback === true
    }
  } catch { /* A malformed assessment is unknown, never an approval. */ }
  const purposes = boundedText(input.justification ?? '', 180)
  const consequences: string[] = []
  let operation = `发送一次 ${method} 请求`
  let recovery = '未提供经过验证的恢复方案；不要将“可逆”或“无副作用”的模型说明当作保证。'
  if (method === 'ASSET') {
    operation = '确认资产归属并扩大测试范围'
    consequences.push('确认后该注册域及其子域将进入可测试范围；这不是只登记一个名称。')
    recovery = '后续撤销范围不会撤回已经发送的测试请求。'
  } else if (method === 'RUN') {
    operation = '执行外部能力脚本'
    consequences.push('脚本可能读取或修改文件、运行程序或访问网络；具体影响取决于脚本和参数。')
    recovery = '没有经过验证的脚本回滚方案；需核对脚本说明及备份。'
  } else if (method === 'DELETE') {
    operation = '请求删除目标资源'
    consequences.push('可能删除数据、配置或服务资源，并影响服务可用性；是否可恢复尚未验证。')
  } else if (method === 'PUT') {
    operation = '向目标写入或替换资源'
    consequences.push('PUT 可能整体替换资源；即使只提交少量字段，也可能清空其他配置或中断服务。')
  } else if (method === 'PATCH') {
    operation = '请求修改目标资源'
    consequences.push('可能修改数据或配置；字段联动和实际更新语义尚需确认。')
  } else if (method === 'POST') {
    operation = '提交数据供目标处理'
    consequences.push('可能执行查询、创建数据或触发业务动作；POST 本身不能证明只读。')
  } else {
    operation = `使用 ${method} 获取信息或探测接口`
    consequences.push('可能访问受保护信息；读取方法不保证目标没有业务副作用。')
  }
  if (effect === 'external') consequences.push('评估涉及对外通信：可能触发第三方请求、消息通知或费用；接收方和范围需核对。')
  if (effect === 'auth') consequences.push('评估涉及认证：可能建立会话、增加失败计数或触发账号保护。')
  if (effect === 'destructive' && method !== 'DELETE') consequences.push('评估包含破坏性动作：存在数据丢失或服务不可用风险。')
  if (effect === 'write' && !['PUT', 'PATCH', 'DELETE', 'POST'].includes(method)) consequences.push('尽管使用读取方法，评估仍识别出写入行为；不能按普通读取批准。')
  let requestText = `${input.url}\n${input.body ?? ''}`
  try { requestText = decodeURIComponent(requestText.replace(/\+/g, ' ')) } catch { /* inspect raw text */ }
  if (/<!ENTITY\b/i.test(requestText) && /\bSYSTEM\b/i.test(requestText)) {
    consequences.push('请求声明了 XML 外部实体，可能使服务器读取本地文件或访问其他地址；实际影响取决于解析器与权限。')
  }
  const knownLow = risk === 'low'
  const decision = failed
    ? '风险服务未取得有效结果，无法据此判断安全，需要人工确认。'
    : verdict === 'pending' && knownLow
      ? '风险模型标为低风险，但仍要求人工确认；这不等于已证明无影响。'
      : risk === 'high'
        ? '风险模型提示高风险；请重点核对可能后果和恢复条件。'
        : ['破坏性写入', '越权删改'].includes(input.category ?? '')
          ? '本地边界要求人工确认，不能被模型的低风险判断覆盖。'
          : '当前请求未获自动执行许可；风险或授权条件仍需确认。'
  if(input.safetyPlan?.snapshotVerified) recovery = `原始备份已校验。${boundedText(input.safetyPlan.recovery ?? '恢复步骤尚需明确',120)}；备份存在不等于业务恢复已验证，恢复仍须另行批准。`;
  if(input.safetyPlan?.validationError) consequences.push(`写入方案尚未通过校验：${boundedText(input.safetyPlan.validationError,160)}`);
  if(input.writeOutcome?.warning) consequences.push(input.writeOutcome.warning);
  return {
    operation, target,
    purpose: purposes || '模型未提供清楚的操作目的；不能仅凭原始报文推断。',
    consequences, recovery, decision,
  }
}
