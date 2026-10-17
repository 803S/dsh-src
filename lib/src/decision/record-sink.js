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

/** 注册（或清除）录制 sink。重复装配以最后一次为准。 */
export function setDecisionSink(fn) { sink = typeof fn === 'function' ? fn : void 0; }

/** 发射一条判定记录（`record` 由 sink 归一化后再入库）。 */
export function emitDecisionRecord(record) {
	if (sink === void 0) return;
	try { sink(record); } catch { /* 计量是旁路：任何失败都不影响判定与出口 */ }
}
