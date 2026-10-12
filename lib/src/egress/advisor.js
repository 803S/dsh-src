import { jevDecide } from '../decision/jev-client.js';
import { buildOperationContext, operationContextToJev } from '../decision/operation-context.js';

// A captured single HTTP request uses the existing request-semantic contract.
// Do not bury it under a scan manifest: that loses method/URL context in the
// single-request classifier. A multi-request plan still requires whole-plan review.
// Identity comes from the real tool call (exec.name/callId) so the Jev payload keeps
// the same operationId and original justification instead of a rebuilt egress_* label.
// scopeChecked=true here is a trusted execution fact: broker.propose has already run
// requireScope/assertScopeCurrent on the user-confirmed scope before assess is called.
export function assessEgressPlan(plan, exec = {}, decide = jevDecide) {
  const sessionId = exec.agent?.session?.id ?? '';
  const callId = exec.callId ?? '';
  const entryTool = typeof exec.name === 'string' && exec.name !== '' ? exec.name : '';

  if (plan.maxRequests === 1 && plan.entries?.length === 1 && plan.entries[0].maxRequests === 1) {
    const request = plan.entries[0].request;
    const opContext = buildOperationContext({
      sessionId,
      callId,
      tool: entryTool || 'egress_http',
      request,
      justification: plan.purpose,
      scopeOrigin: request.url,
      authorization: '出口已由用户确认精确目标；仅低风险操作可自动发送，高危或未知操作仍需人工批准。',
      objective: '审核这一笔真实冻结的目标请求，不授予后续请求或其他目标权限。'
    });

    const jevArgs = operationContextToJev(opContext, {
      taskType: 'risk-grade',
      scopeChecked: true,
      verifiedTestObjects: exec.verifiedTestObjects ?? []
    });

    return decide(jevArgs, exec);
  }

  const opContext = buildOperationContext({
    sessionId,
    callId,
    tool: entryTool || 'egress_scan',
    plan,
    justification: plan.purpose,
    authorization: '出口已由用户确认精确目标；扫描计划中的每个请求须由Jev审核。'
  });

  const jevArgs = operationContextToJev(opContext, {
    taskType: 'scan-plan',
    scopeChecked: true,
    verifiedTestObjects: exec.verifiedTestObjects ?? []
  });

  return decide(jevArgs, exec);
}
