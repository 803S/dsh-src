/** [local.106] 判定计量出口（单一录制点）。
 *
 * 录制点只有一个：`jevDecide()` 的返回值出口——出口即录，所有任务类型、
 * 所有 fallback/错误/短路路径一次性覆盖：不会漏点，也不会重复计数。
 * `jev-client` 只负责声明「发生了一次判定」，真正落库交给宿主在 `apply()` 里注册的 sink
 * （sink 侧才有 store）。
 *
 * 三条硬约束（计量绝不能影响安全判定）：
 * ① 未注册 sink 时静默（未装配插件的进程、纯客户端构建）；
 * ② sink 抛错只吞掉，绝不向上冒泡；
 * ③ 不 await：判定返回值不等存储（fire-and-forget），落库慢/失败都拖不住判定。
 */
let sink;

/* 本地短路错误码：服务根本没被问过，既不是工作量也不是服务故障，不入计量。
 * （对照：circuitOpen/network/timeout/http-4xx/schema/review 类错误都算真实故障，必须计。） */
const NO_WORK = new Set(['unsupported-task', 'child-not-applicable', 'no-candidates', 'disabled', 'not-configured']);

/** 一次判定是否值得计量：真实工作量（含失败）→ true；本地短路 → false。 */
export function isRecordableDecision(value) {
	return !(value !== null && typeof value === 'object' && NO_WORK.has(String(value.errorType ?? '')));
}

/** [local.148] 归账会话解析（代理/脚本车道的判定曾经整批丢失）。
 *
 * 2026-10-19 审计：`lib/src.js` 的 sink 用 `sessionIdOf(exec)` 取会话，而出口闸的代理车道
 * （bash/curl 经 mitm 回连 control server）传进来的 exec 是合成对象
 * （`{egressTaskId, deferAssessment, signal, srcSessionId}`，**没有 agent.session**），
 * `sessionIdOf` 直接抛错 → 被 catch 吞成一行 warn → 该车道的判定一条都不入计量。
 * 现场后果：step30 的 4 笔同形 POST 里「3 笔自动放行、1 笔挂人工卡」，历史里只留下其中
 * 工具车道的那一条，事后无法解释“为什么只有 jdoe 要审批”（真实原因是 jdoe 是真实账号，
 * 判定服务按 external/high 判）。
 *
 * 语义：工具 exec 的 `agent.session.id` 优先（身份真值）；次要来源是 manager 在
 * `authorize`/`propose` 处盖章的 `srcSessionId`。解析不到就返回空串，绝不抛错——
 * 计量是旁路，不能因为拿不到会话名而让判定路径出现异常。
 */
export function sessionIdForDecision(exec) {
	const owned = exec?.agent?.session?.id;
	if (typeof owned === 'string' && owned !== '') return owned;
	const stamped = exec?.srcSessionId;
	return typeof stamped === 'string' ? stamped : '';
}

/** 注册（或清除）录制 sink。重复装配以最后一次为准。 */
export function setDecisionSink(fn) { sink = typeof fn === 'function' ? fn : void 0; }

/** 发射一条判定记录（`record` 由 sink 归一化后再入库）。 */
export function emitDecisionRecord(record) {
	if (sink === void 0) return;
	try { sink(record); } catch { /* 计量是旁路：任何失败都不影响判定与出口 */ }
}
