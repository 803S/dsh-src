// Tell the model what the host actually did, never turn approval into replay.
export const PENDING_CONTINUATION='只挂起这一操作及依赖它的工作，立即继续其他独立的低风险工作或分析已有证据。不要因一项待审结束整个任务，不重发、不换通道、不sleep或轮询；确实没有独立工作时才结束当前回合等用户回注。';
/* [审计 2026-10-13 §2] 审批通道不可用（子代理/委派会话的 approval policy=never）时，
 * 待审项不能变成死路或负结论：必须原样把 approvalId 升级给能弹审批的父会话/用户。
 * 复核会话的注册正例就死在这里——子代理解不了“补安全材料”，父会话又没收到可执行的升级指令。 */
export const APPROVAL_CHANNEL_ESCALATION='若本上下文不能弹出审批提示（例如子代理/委派会话），把待审 approvalId 原样交回父会话处理，由父会话或用户在审批卡决定；不要重发请求、不要换工具或路径规避、不要改写原请求、也不要因等待把该方向记成不可利用或耗尽。';
/** 单笔冻结请求待审时的确定说明：用户可直接放行，也可以先补材料。 */
export function pendingSingleRequestNotice({approvalId,taskId,needsMaterial=false}={}) {
  const label=approvalId?`审批单 ${approvalId}（任务 ${taskId??'-'}）`:'本笔待审操作';
  const material=needsMaterial
    ? '只有在确实需要前置校验/备份/回读材料时才用 src_egress_prepare 补充（补充会作废旧审批）；'
    : '';
  return `${label}是已冻结的单笔请求，等待用户决定：用户可直接批准发送该原请求（仅一次），也可拒绝。${material}批准只能由用户通过原生审批命令完成，模型不能自行 resolve 或重放。${APPROVAL_CHANNEL_ESCALATION}${PENDING_CONTINUATION}`;
}
export function egressInterruption(error) {
 if(!/^SRC_GATE_/.test(error?.code??'')&&error?.safeNotSent!==false)return null;
 return {requiresDecision:true,stopped:error.safeNotSent===false?'outcome-unknown':'approval-blocked',
   sent:error.safeNotSent===false?'unknown':false,gateCode:error.code??'EGRESS_OUTCOME_UNKNOWN',
   ...(error.approvalId?{pendingApprovalId:error.approvalId}:{}),...(error.taskId?{taskId:error.taskId}:{}),
   nextAction:error.nextAction??PENDING_CONTINUATION};
}
export function egressDecisionMessage(category,id,action,result){
 if(category==='egress/scope')return `【出口范围确认结果】${id}：${result.nextAction} 本次只处理范围，没有发送任何目标请求。`;
 if(action==='reject')return `【出口任务已拒绝】${id}：未授权执行，不得重放、改参数或换工具规避。`;
 if(result.resumeTool==='src_egress_plan')return `【出口bash计划已批准】${id}：尚未执行，不会抢占正在进行的独立bash。需要继续本分支时，先调用src_egress_plan，携taskId=${result.taskId}及原参数选择冻结计划，再执行对应bash；不能重新申请或扩大预算。`;
 if(result.executionState==='executed')return `【出口请求执行结果】${id}：主机已执行，响应状态 ${result.responseStatus}。禁止模型重放；请读取已记录证据继续。`;
 if(result.executionState)return `【出口执行需核对】${id}：状态 ${result.executionState}。不要重放，先人工核对目标与执行记录。`;
 return `【出口任务授权结果】${id}：用户已批准冻结的有限计划，但尚未发送请求。按原工具的恢复说明继续：src_scan_surface 携带原 taskId 和原参数；只有 bash 扫描计划才在显式恢复后绑定下一次实际启动的bash及其后代。参数、次数、速率、范围不可扩张；不要重新提计划。`;
}
