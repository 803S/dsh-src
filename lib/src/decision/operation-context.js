import { createHash } from 'node:crypto';

/**
 * 统一构造操作上下文（Operation Context），贯穿执行入口与出口。
 * 遵循 docs/implementation-handoff-output-first-20261011.md 规范：
 * - 携带 operationId / sessionId / intentId
 * - 明确主模型操作理由（标记为模型解释）
 * - 工具名、原始参数、命令、cwd
 * - 脚本/文件或载荷指纹
 * - 预期/冻结请求及目标
 */
export function buildOperationContext({
  sessionId = '',
  intentId = '',
  callId = '',
  tool = '',
  command = '',
  cwd = '',
  args = {},
  justification = '',
  objective = '',
  authorization = '',
  scopeOrigin = '',
  goalTarget = '',
  expectedEvidence = '',
  request = null,
  plan = null,
  signals = []
} = {}) {
  const normSessionId = String(sessionId ?? '');
  const normCallId = String(callId ?? '');
  const operationId = normCallId ? `${normSessionId}:${tool || 'op'}:${normCallId}` : `${normSessionId}:${tool || 'op'}:${Date.now()}`;

  const payloadString = JSON.stringify({
    tool,
    command,
    args,
    request: request ? { method: request.method, url: request.url } : null,
    plan: plan ? { maxRequests: plan.maxRequests, entriesCount: plan.entries?.length } : null
  });
  const digest = createHash('sha256').update(payloadString).digest('hex').slice(0, 16);

  return {
    operationId,
    sessionId: normSessionId,
    intentId: String(intentId ?? ''),
    tool: String(tool ?? ''),
    command: String(command ?? ''),
    cwd: String(cwd ?? ''),
    arguments: args,
    digest,
    justification: String(justification ?? ''),
    objective: String(objective ?? ''),
    authorization: String(authorization ?? ''),
    scopeOrigin: String(scopeOrigin ?? ''),
    goalTarget: String(goalTarget ?? ''),
    expectedEvidence: String(expectedEvidence ?? ''),
    request,
    plan,
    signals: Array.isArray(signals) ? signals : [],
    // 标记为模型解释，不直接作为安全保证
    modelInterpretation: Boolean(justification)
  };
}

/**
 * 将统一 Operation Context 投影为 Jev 评估参数。
 */
export function operationContextToJev(context, { taskType = 'risk-grade', verifiedTestObjects = [] } = {}) {
  return {
    taskType,
    operationId: context.operationId,
    tool: context.tool,
    command: context.command,
    cwd: context.cwd,
    title: context.intentTitle ?? '',
    detail: context.intentDetail ?? '',
    justification: context.justification,
    objective: context.objective,
    authorization: context.authorization,
    expectedEvidence: context.expectedEvidence,
    scopeOrigin: context.scopeOrigin,
    goalTarget: context.goalTarget,
    scopeChecked: Boolean(context.scopeOrigin || context.goalTarget),
    verifiedTestObjects,
    ...(context.request ? {
      method: context.request.method,
      url: context.request.url,
      headers: context.request.headers,
      body: context.request.body
    } : {}),
    ...(context.plan ? { plan: context.plan } : {})
  };
}
