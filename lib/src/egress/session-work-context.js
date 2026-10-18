/* [local.143] 会话事实 → 判定上下文。
 *
 * 现场实案（session-86887dce…）：会话里明明有“未授权调试脚本与信息泄露面验证”这类在用意图、
 * 也有明确的目标与授权说明，但送给判定服务的 title/detail 恒为空串、justification 只是一句
 * 系统默认用途；判定服务手上只剩“一个空 body 的 POST /api/users/”，只能判 effect=unknown。
 *
 * 本模块只做一件事：从会话数据里挑出“当前工作线”，并把事实如实投影成判定上下文。
 * 它不做安全判定、不推导授权、不编造缺失字段——取不到就留空，由调用方原样透传。
 */

/** 意图取值优先级：在用 > 计划 > 受阻 > 已完成 > 失败 > 已废弃（同分取最新）。 */
const INTENT_RANK = { running: 5, planned: 4, blocked: 3, completed: 2, failed: 1, deprecated: 0 };

export function pickWorkIntent(intents) {
	const list = (Array.isArray(intents) ? intents : []).filter(row => row && typeof row === 'object');
	if (list.length === 0) return null;
	let best = null, bestScore = -1;
	for (const row of list) {
		const score = INTENT_RANK[row.status ?? 'planned'] ?? 0;
		// sessionData 已按 createdAt 升序，取 >= 让同分时后者（更新）胜出
		if (score >= bestScore) { best = row; bestScore = score; }
	}
	return best;
}

/** 会话数据（store.sessionData 形状）→ 判定上下文；无事实即空串，不编造。 */
export function workContextFrom(data) {
	const intent = pickWorkIntent(data?.intents);
	return {
		intentId: String(intent?.id ?? ''),
		intentTitle: String(intent?.title ?? '').slice(0, 200),
		intentDetail: String(intent?.detail ?? '').slice(0, 600),
		goalTarget: String(data?.goal?.target ?? '').slice(0, 200),
		goalObjective: String(data?.goal?.objective ?? '').slice(0, 600),
		authorization: String(data?.goal?.authorization ?? '').slice(0, 600)
	};
}
