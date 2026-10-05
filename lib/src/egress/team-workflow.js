// Workflow guidance only. Authorization remains enforced by the egress and
// native attempt guards; neither a task description nor a title grants scope.
export const teamWorkflow = `
【AgentTeams 任务交接】
- 若当前是团队成员，你不是指挥官：只执行调度器或 captain 交给你的完整任务，不运行指挥官主循环，不擅自建 goal/intent 或扩大任务。
- 加入团队的欢迎消息不是任务。agent_teams_status 中的标题/状态只是摘要，不是完整执行合同；claim_task 的成功回执也不包含任务正文；若已经领取但尚无正文，应只读查看原生 Team context 指定的 team.json，按task_id核对完整 description/acceptance 和当前 attemptId，不能等一个可能不再派发的同任务回合，也不能按标题猜操作。未收到 description、明确操作要求和适用验收条件时，不凭标题猜请求路径、工具、方法或参数，不抢先 claim；结束当前回合等待自动任务派发，不轮询、不 sleep。任务只有标题时先向 captain 要求完整说明。
- 收到完整任务后，按原文执行指定工具/URL/方法，不用另一个工具的成功代替指定通道的验证。claim_task 获取当前 attempt_id，每次 update_task 都带它；先 in_progress 再 completed/failed。只有实际满足验收才能 completed，入队/领取成功不代表完成。
- captain 创建任务时逐项保留用户要求的工具、URL、方法和验收；用户要求验证审批闸时，须实际调用并取得拒绝/待审证据，不能把“未调用”当成“闸已拦截”。成员 executionPrompt 不另设与任务冲突的限制。成员未完成则结束回合等通知，不循环 status 或代做成员的验收。成员初次欢迎回合结束、短暂 idle 或尚无输出不等于执行失败；不要据此 reassign/interrupt 正在派发或执行的任务，重分配会撤销原 attempt 并中断成员。只有明确失败、实际跑偏或用户要求才按当前状态处理。完整任务派发、团队计划批准、attempt_id 都不授予目标高危操作权限；待审请求不能自行批准或重放。
`;

// Native claim receipts intentionally contain only state/attempt fields. A
// member can claim during its welcome turn before the scheduler delivers the
// assignment; make the missing contract explicit at the point of use.
export function teamClaimDecision(exec,result,decision){
 if(exec.name!=='agent_teams_claim_task'||!exec.agent?.session?.header?.parentSession||result.isError||exec.signal?.aborted||decision.kind!=='accept'||Object.hasOwn(decision,'content')||Object.hasOwn(decision,'value'))return decision;
 if(!result.value?.attempt_id||!Array.isArray(result.content))return decision;
 return {...decision,content:[...result.content,{type:'text',text:'领取回执仅包含任务状态和 attempt_id，不含任务正文。若当前消息没有该任务的完整 description/acceptance，先用 read 只读查看原生 Team context 指定目录中的 team.json，按本回执 task_id 找到任务，核对 assignee 和 attemptId；不要猜目录、URL、命令或验收条件，也不要再次领取。文件不可读、任务不符或说明缺失时向 captain 报告并等待，不能按标题开始发包。已有完整任务时严格按指定工具、命令、顺序和验收执行；先 in_progress，再按真实结果完成。任务说明/领取成功不授予目标范围或高危操作权限。'}]};
}
