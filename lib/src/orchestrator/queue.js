// Orchestrator 建议 job 工厂 + 幂等键（optimization handbook Phase 3，§6.2 幂等要求）。
// shadow 模式下「job」只是建议对象（永不执行）；幂等键保证同一 (kind, intent, extra)
// 组合的建议在单次计算内只出现一条，重复事件不重复产生建议行。
//
// id 前缀 "sugg-"：与真实 delegation/子代理 id 空间区分，报表与面板不会误当作可执行任务。

import { canTransition } from "./transitions.js";

let suggestionSeq = 0;

/** 构造一条建议。非法迁移（transitions.js 表外）直接降级为 warning 建议而不是抛错
 * ——shadow 建议永不打断工具路径。 */
export function makeSuggestion({ kind, intentId = "", from = "", to = "", reason = "", dedupeExtra = "", priority = 0, warnings = [] } = {}) {
	const dedupeKey = `${kind}:${intentId}:${dedupeExtra}`;
	const base = {
		id: `sugg-${++suggestionSeq}`,
		kind,
		intentId,
		from,
		to,
		reason,
		dedupeKey,
		priority
	};
	if (warnings.length > 0) base.warnings = [...warnings];
	if (from !== "" && to !== "" && !canTransition(from, to)) {
		base.warnings = [...(base.warnings ?? []), `transition "${from}" → "${to}" rejected by state machine`];
	}
	return base;
}

/** 幂等去重：同 dedupeKey 只保留第一条（先到先得，priority 不影响幂等）。 */
export function dedupeSuggestions(suggestions) {
	const seen = new Set();
	const out = [];
	for (const s of suggestions) {
		if (seen.has(s.dedupeKey)) continue;
		seen.add(s.dedupeKey);
		out.push(s);
	}
	return out;
}
