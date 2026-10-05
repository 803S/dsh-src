export type ApprovalExplanationInput = {
  method: string
  url: string
  body?: string
  category?: string
  reason?: string
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
  if (method === 'SCOPE') {
    let target = '精确范围无法解析，请核对范围单，不要批准'
    try {
      const origins: unknown = JSON.parse(input.body ?? '{}').origins
      if (Array.isArray(origins) && origins.length && origins.every(origin => typeof origin === 'string' && new URL(origin).origin === origin)) target = origins.join('，')
    } catch { /* Keep malformed scope visibly unconfirmed. */ }
    return {
      operation: '仅确认目标出口范围，不发送目标请求', target,
      purpose: boundedText(input.justification ?? '', 180),
      consequences: ['后续请求只能使用确认的精确 origins（协议、主机、端口）；不包含其他子域。', '确认范围不等于批准请求；高危和不确定操作仍须另行审核。'],
      recovery: '本次确认不修改目标资源，无需目标回滚；用户可另行更改出口范围。',
      decision: '范围来自模型提议，必须由用户核对确认；不依赖模型自行授权。',
    }
  }
  if (method === 'TASK') {
    try {
      const stored = JSON.parse(input.body ?? '')
      const hostExecution = !Array.isArray(stored) && Object.hasOwn(stored, 'safety')
      const burp = hostExecution && stored.transport?.kind === 'burp'
      const entries = Array.isArray(stored) ? stored : stored.entries
      if (!Array.isArray(entries) || !entries.length || entries.some(e => typeof e?.request?.url !== 'string' || typeof e?.request?.method !== 'string' || !['http:', 'https:'].includes(new URL(e.request.url).protocol))) throw new Error('invalid manifest')
      const methods: string[] = [...new Set<string>(entries.map(e => e.request.method.toUpperCase()))]
      const mutations = methods.filter(m => !['GET', 'HEAD', 'OPTIONS'].includes(m))
      const consequences = [hostExecution ? '批准后主机可能立即执行原请求及前置/验证步骤；不要让模型再次发送。' : '本次只授权冻结计划，不立即发包；执行时逐笔匹配精确请求、次数、速率及范围。']
      if (burp) consequences.push('目标请求由原生 Burp MCP 执行冻结参数；信任已配置的 Burp。审批单列出的前置/后置检查仍使用受控 HTTP，不由 Burp 代发。MCP 返回不等于目标业务成功。')
      if (methods.includes('DELETE')) consequences.push('冻结清单包含 DELETE：可能删除目标数据或资源，恢复能力必须单独核实。')
      if (mutations.some(m => m !== 'DELETE')) consequences.push(`冻结清单包含 ${mutations.filter(m => m !== 'DELETE').join('/')}：可能修改配置、创建数据或触发业务动作。`)
      consequences.push('GET/HEAD 等读取方法也不保证没有业务副作用；摘要不能代替完整请求清单。')
      if (input.reason) consequences.push(boundedText(input.reason, 300))
      return {
        operation: hostExecution ? `由${burp ? '原生 Burp' : '主机'}执行冻结请求（${methods.join('/')}）` : '授权有限扫描计划（批准本身不发包）',
        target: boundedText(entries.map(e => `${e.request.method} ${e.request.url}`).join('；'), 350),
        purpose: boundedText(input.justification ?? '', 180), consequences,
        recovery: hostExecution ? (stored.safety ? `恢复说明需独立核实：${boundedText(String(stored.safety.recovery ?? '未提供'), 250)}` : '缺少有效安全材料，当前不能执行；须先补齐材料并重新审核。') : '未使用额度不能当成后续命令的授权；已发请求无法通过撤销计划收回。',
        decision: '人工确认不取消出口检查；风险建议不等于执行授权。',
      }
    } catch {
      return { operation: '冻结任务清单无法解析，不要批准', target: '无法确认实际请求目标', purpose: boundedText(input.justification ?? '', 180), consequences: ['不能把 TASK 当作只读 HTTP 方法，也不能推测执行后果。'], recovery: '无法验证安全材料。', decision: '请核对原始审批记录。' }
    }
  }
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
