// Orphan 恢复判定纯函数（optimization handbook Phase 3，§6.4）。
// 恢复条件沿用当前 src_recover_child 的 checkpoint 规则，但 shadow 模式下只产出
// orphaned 建议事件，不执行任何唤醒/状态写入（on 模式未实施，属基线「明确不做」）。
//
// 规则（手册 §6.4）：
// - running 且该 intent 无任何 checkpoint → no-checkpoint（沿用 src_recover_child
//   「即使从未提交 checkpoint 也可以唤醒」语义）。
// - 最新 checkpoint stage=progress 且超过 30 分钟 → stale-progress。

/** 手册 §6.4：progress checkpoint 超过 30 分钟视为失联。 */
export const ORPHAN_PROGRESS_MAX_AGE_MS = 30 * 60 * 1000;

/** 从 intents/checkpoints 推导 orphaned 候选。checkpoint 形状见 store.js
 * appendCheckpoint：{ id, intentId, childSessionId, stage, createdAt, ... }。 */
export function detectOrphanCandidates({ intents = [], checkpoints = [], now = Date.now() } = {}) {
	const candidates = [];
	for (const intent of intents) {
		if (intent?.status !== "running") continue;
		const own = checkpoints
			.filter((c) => c?.intentId === intent.id)
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
		if (own.length === 0) {
			candidates.push({
				intentId: intent.id,
				childSessionId: intent.childSessionId ?? "",
				reason: "no-checkpoint",
				dedupeExtra: "no-checkpoint"
			});
			continue;
		}
		const latest = own[0];
		const age = now - (latest.createdAt ?? 0);
		if (latest.stage === "progress" && age > ORPHAN_PROGRESS_MAX_AGE_MS) {
			candidates.push({
				intentId: intent.id,
				childSessionId: latest.childSessionId ?? intent.childSessionId ?? "",
				reason: `stale-progress (${Math.round(age / 60000)}min)`,
				dedupeExtra: `stale-${latest.id}`
			});
		}
	}
	return candidates;
}
