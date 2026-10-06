// Tell the model what the host actually did, never turn approval into replay.
export const PENDING_CONTINUATION='只挂起这一操作及依赖它的工作，立即继续其他独立的低风险工作或分析已有证据。不要因一项待审结束整个任务，不重发、不换通道、不sleep或轮询；确实没有独立工作时才结束当前回合等用户回注。';
export function egressDecisionMessage(category,id,action,result){
 if(category==='egress/scope')return `【出口范围确认结果】${id}：${result.nextAction} 本次只处理范围，没有发送任何目标请求。`;
 if(action==='reject')return `【出口任务已拒绝】${id}：未授权执行，不得重放、改参数或换工具规避。`;
 if(result.resumeTool==='src_egress_plan')return `【出口bash计划已批准】${id}：尚未执行，不会抢占正在进行的独立bash。需要继续本分支时，先调用src_egress_plan，携taskId=${result.taskId}及原参数选择冻结计划，再执行对应bash；不能重新申请或扩大预算。`;
 if(result.executionState==='executed')return `【出口请求执行结果】${id}：主机已执行，响应状态 ${result.responseStatus}。禁止模型重放；请读取已记录证据继续。`;
 if(result.executionState)return `【出口执行需核对】${id}：状态 ${result.executionState}。不要重放，先人工核对目标与执行记录。`;
 return `【出口任务授权结果】${id}：用户已批准冻结的有限计划，但尚未发送请求。按原工具的恢复说明继续：src_scan_surface 携带原 taskId 和原参数；只有 bash 扫描计划才在显式恢复后绑定下一次实际启动的bash及其后代。参数、次数、速率、范围不可扩张；不要重新提计划。`;
}
