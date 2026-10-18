import { jevDecide } from '../decision/jev-client.js';
import { buildOperationContext, operationContextToJev } from '../decision/operation-context.js';
import { createDefaultTelemetry, emitLayaDecision } from '../telemetry/events.js';
import { srcLayaDecisionFlag } from '../flags.js';
import { declaredPurpose } from './purpose.js';

/* [审计 2026-10-13 §1] 出口闸（broker→advisor）的 risk-grade/scan-plan 判定以前完全不进 telemetry，
 * 内层已真实调用 Jev 但当天 JSONL 里 risk-grade=0，导致审计只能看到 delegate/skill，无法核验风险漏斗。
 * 这里补一条旁路发射：只报告判定字段与受控测试对象数量，不带请求内容/凭据，
 * 任何失败都不能改变或阻断判定路径。
 * 以 DSH_SRC_LAYA_DECISION 为真实开关（off=静默；shadow/on=落观测行）：
 * 部署 web/headless 默认 on，而测试进程默认 off，避免单测把行写进真实 ~/.dsh 遥测库污染事后审计。 */
const riskTelemetry = createDefaultTelemetry();
function reportRiskDecision(value, exec, taskType, requestArgs) {
  if (!value || typeof value !== 'object') return value;
  if (srcLayaDecisionFlag() === 'off') return value;
  try {
    const { action, effect, risk, objectClass, riskScore, confidence, probabilities, source, provider, model, requestedModel, fallback, latency, advisoryOnly, mode, errorType } = value;
    emitLayaDecision(riskTelemetry, exec, { taskType, action, effect, risk, objectClass, riskScore, confidence, probabilities, source, provider, model, requestedModel, fallback: fallback === true, latency, advisoryOnly, mode, errorType, verifiedTestObjectCount: Array.isArray(requestArgs?.verifiedTestObjects) ? requestArgs.verifiedTestObjects.length : 0 });
  } catch { /* 观测旁路绝不能影响出口判定 */ }
  return value;
}
function decideAndReport(decide, args, exec, taskType) {
  let result;
  try { result = decide(args, exec); }
  catch (error) { reportRiskDecision({ action: 'pending', effect: 'unknown', fallback: true, errorType: String(error?.code ?? 'threw') }, exec, taskType, args); throw error; }
  return Promise.resolve(result).then(value => reportRiskDecision(value, exec, taskType, args));
}

// A captured single HTTP request uses the existing request-semantic contract.
// Do not bury it under a scan manifest: that loses method/URL context in the
// single-request classifier. A multi-request plan still requires whole-plan review.
// Identity comes from the real tool call (exec.name/callId) so the Jev payload keeps
// the same operationId and original justification instead of a rebuilt egress_* label.
// scopeChecked=true here is a trusted execution fact: broker.propose has already run
// requireScope/assertScopeCurrent on the user-confirmed scope before assess is called.
/** 会话事实（当前意图标题/详情 + 目标）：由宿主在 propose/authorize 时挂成惰性 thunk。
 *  取不到就是取不到——绝不能因此伪造意图，也不能让它影响判定流程。 */
async function resolveWorkContext(exec) {
  try {
    if (typeof exec.srcWorkContext === 'function') return await exec.srcWorkContext();
    return exec.srcWorkContext ?? null;
  } catch { return null; }
}
export function assessEgressPlan(plan, exec = {}, decide = jevDecide) {
  return assessEgressPlanAsync(plan, exec, decide);
}
/* [local.143] 判定输入的诚实性：①系统默认用途不是模型自述，不能当 justification 送进去
 * （否则判定服务拿到的是一句“需审核实际语义”的自我指涉，只能判 unknown——现场空 body POST /api/users/ 实案）；
 * ②把用户声明的意图/目标一并送入，让判定服务能按“这笔请求在已声明工作线上的语义”判，而不是只看方法+URL。 */
async function assessEgressPlanAsync(plan, exec = {}, decide = jevDecide) {
  const sessionId = exec.agent?.session?.id ?? '';
  const callId = exec.callId ?? '';
  const entryTool = typeof exec.name === 'string' && exec.name !== '' ? exec.name : '';
  const work = await resolveWorkContext(exec);
  const justification = declaredPurpose(plan.purpose);
  /* 授权说明优先用会话里用户自己写下的那句话（事实来源），没有才退回出口已确认的通用表述。 */
  /* 授权说明优先用会话里用户自己写下的那句话（事实来源），没有才退回出口已确认的通用表述；
   * 单笔/批量各自的兜底文案分开，避免把单笔措辞套到扫描计划上。 */
  const authorization = work?.authorization
    || '出口已由用户确认精确目标；仅低风险操作可自动发送，高危或未知操作仍需人工批准。';
  const scanAuthorization = work?.authorization
    || '出口已由用户确认精确目标；扫描计划中的每个请求须由Jev审核。';

  if (plan.maxRequests === 1 && plan.entries?.length === 1 && plan.entries[0].maxRequests === 1) {
    const request = plan.entries[0].request;
    const opContext = buildOperationContext({
      sessionId,
      callId,
      tool: entryTool || 'egress_http',
      request,
      justification,
      intentId: work?.intentId ?? '',
      intentTitle: work?.intentTitle ?? '',
      intentDetail: work?.intentDetail ?? '',
      scopeOrigin: request.url,
      goalTarget: work?.goalTarget ?? '',
      authorization,
      objective: work?.goalObjective || '审核这一笔真实冻结的目标请求，不授予后续请求或其他目标权限。'
    });

    const jevArgs = operationContextToJev(opContext, {
      taskType: 'risk-grade',
      scopeChecked: true,
      verifiedTestObjects: exec.verifiedTestObjects ?? []
    });

    return decideAndReport(decide, jevArgs, exec, 'risk-grade');
  }

  const opContext = buildOperationContext({
    sessionId,
    callId,
    tool: entryTool || 'egress_scan',
    plan,
    justification,
    intentId: work?.intentId ?? '',
    intentTitle: work?.intentTitle ?? '',
    intentDetail: work?.intentDetail ?? '',
    goalTarget: work?.goalTarget ?? '',
    authorization: scanAuthorization
  });

  const jevArgs = operationContextToJev(opContext, {
    taskType: 'scan-plan',
    scopeChecked: true,
    verifiedTestObjects: exec.verifiedTestObjects ?? []
  });

  return decideAndReport(decide, jevArgs, exec, 'scan-plan');
}
