// 拒绝时随“未发送”一起回给执行方（模型/子进程）的最小可操作说明。
// 这里只解释“为什么没发送、下一步能做什么”，不参与任何授权判定：
// 提示文本从不改变 claim/审批结果，缺席也绝不改变拒绝本身。
export const DENY_HINTS = Object.freeze({
  SRC_GATE_REQUEST_NOT_APPROVED: '该请求不在冻结计划的精确清单内：方法、URL、头部集合与正文必须与计划条目逐字节一致（客户端自动加的 User-Agent、Accept 也参与比对）。改用 src_http 按申报头部原样发送，或重新提交包含这些头部的 src_egress_plan。',
  SRC_GATE_REQUEST_PENDING: '同一精确请求已有一张待审批卡。不要重复发送或换通道重试，告知用户等待审批结论。',
  SRC_GATE_PREVIOUSLY_DENIED_OR_UNKNOWN: '该精确请求此前被人工拒绝或结果不明，本会话内不可重试；需要人工核对后才能继续。',
  SRC_GATE_WRONG_EXECUTION_LANE: '当前执行通道与冻结计划的车道不一致：代理/子进程车道不能使用 host 车道（或反向）的计划。',
  SRC_GATE_TASK_NOT_ACTIVE: '冻结计划不在 active 状态（待审/已拒绝/已撤销/已完成）。先看待办或重新申请范围，不要继续发送。',
  SRC_GATE_BUDGET_EXHAUSTED: '该计划的请求次数预算已用完；预算不会被退还或扩张，需重新申请。',
  SRC_GATE_RATE_LIMIT: '同一目标的最小发送间隔未到；按计划间隔稍后重试。',
  SRC_GATE_ORIGIN_BUSY: '同一目标已有一笔在途请求；等它结束后再按计划继续。',
  SRC_GATE_OPERATION_BLOCKED: '同一操作的其它请求正在等待人工审批；既有任务不能用来绕过精确请求待审。',
  SRC_GATE_RESOURCE_REQUIRES_REVIEW: '该资源存在风险或结果不明记录，必须人工核对后才能继续。',
  SRC_GATE_TEST_OBJECT_CHANGED: '测试对象已被改动，原计划不再成立。',
  SRC_GATE_EXPIRED: '冻结计划或执行窗口已过期，需要重新申请范围/计划。',
  SRC_GATE_CONTROL_FAILURE: '闸控制面调用失败，请求未发送；不要假设已发送，按错误码处理。',
});

export const deniedBodyHint = code => (typeof code === 'string' ? DENY_HINTS[code] ?? null : null);
