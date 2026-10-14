import { gateError } from '../egress/plan.js';

// 判定服务「基础设施故障」与「安全结论」的分离（2026-10-14 现场实证）。
//
// 现场：~/.dsh/settings/src-decision.json 的 apiKey 失效 → 每次 risk-grade 都是 http-401。
// 旧行为把每个被拦请求都写一张 category='egress/task' 的待审卡，reason 里写着
// 「影响未定的操作（判定服务不可用：http-401）」——28 次调用 → 32 张卡，用户只能逐张拒绝，
// 而且卡片语义是错的：那不是「这个请求可疑」，而是「判定服务坏了」。
//
// 现在的规则：
//   基础设施故障（网络/超时/5xx/401/403/未配置/被取消）→ 不产生任何按请求的审批卡，
//   也不产生安全结论；改为抛一个可重试的闸错误 + 每个会话至多一条「待办」提醒用户修服务。
//   语义类失败（schema/json 非法）仍按原计划挂人工审批：那是「服务判不了」，不是「服务坏了」。
const OUTAGE_TEXT = {
  network: '网络不可达',
  timeout: '请求超时',
  config: '读取判定服务配置失败',
  'not-configured': '未配置 endpoint',
  cancelled: '调用被取消',
};

/** 判定失败是否属于「服务本身坏了」而不是「判不了这笔请求」。 */
export function serviceOutage(review) {
  if (review?.fallback === false) return void 0;
  const type = String(review?.errorType ?? '');
  if (OUTAGE_TEXT[type] !== void 0) return { type, text: OUTAGE_TEXT[type] };
  if (/^http-(?:401|403)$/.test(type)) return { type, text: `判定服务拒绝认证（${type}：apiKey 无效/过期/被撤销）` };
  if (/^http-5\d\d$/.test(type)) return { type, text: `判定服务端错误（${type}）` };
  if (type === 'circuit-open') return { type, text: '判定服务持续失败，已短路' };
  return void 0;
}

/** 用户可读的一句结论（工具结果与卡片文案共用，不再让用户自己猜 mode/errorType）。 */
export function serviceOutageMessage(outage, {shortCircuitSeconds = 0} = {}) {
  return `判定服务不可用（${outage.text}）。本次请求未发送，也不是「该请求可疑」的安全结论——` +
    `所有未判定请求都被挡住，修好服务前无法继续外发。修法：${outage.type.startsWith('http-40')
      ? '更新 ~/.dsh/settings/src-decision.json 的 apiKey（当前 token 已失效）后重发同一请求'
      : '恢复判定服务可达后重发同一请求'}（本错误可重试）；` +
    `${shortCircuitSeconds > 0 ? `本会话已短路约 ${shortCircuitSeconds}s，期间不会重复调用判定服务。` : '期间不会为每笔请求生成审批卡。'}`;
}

/**
 * 抛可重试的闸错误，并尽最大努力留下一条会话级「待办」提醒（按标题前缀去重，只提醒一次）。
 * 注意：这里绝不写 pending_approvals——审批卡代表「请求需要人决策」，本故障不代表那个。
 */
export async function raiseServiceOutage(store, sessionId, { outage, detail = '' } = {}) {
  const text = serviceOutageMessage(outage);
  try {
    const existing = await store.findUserTodoByTitlePrefix?.(sessionId, '判定服务不可用');
    if (existing === void 0) {
      await store.upsertUserTodo(sessionId, {
        title: `判定服务不可用（${outage.type}）：先修 src-decision.json 再继续`,
        detail: `${text}\n${detail ? `涉及请求：${detail}\n` : ''}修复后重发同一请求即可；期间不要换通道绕行，也不要重复挂审批。`,
        kind: 'decision',
        status: 'pending',
      });
    }
  } catch { /* 待办只是提醒：写不进去不影响闸本身 */ }
  throw Object.assign(gateError('DECISION_UNAVAILABLE'), { retryable: true, outageType: outage.type, message: `SRC_GATE_DECISION_UNAVAILABLE：${text}` });
}
