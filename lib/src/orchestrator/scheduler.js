// Orchestrator shadow 调度器（optimization handbook Phase 3，§6.2）。
// computeSuggestions 是纯函数：给定 state 视图切片，推导 shadow 建议列表，不执行
// 任何写入、不轮询、不重发（approval pending 手册明文「等待事件」）。
// on 模式的后台 tick/lease 属宿主钩子依赖，未实施（基线「明确不做」第 1 条）。
//
// 建议五类（每类映射 §6.1 状态机一条边）：
// 1. enqueue          planned intent → queued（「为 intent 创建创建 job」）
// 2. orphan-recover   running 失联（recovery.js 规则）→ orphaned（「child failure」）
// 3. approval-wait    pending 审批 → waiting-approval（不重发、不轮询）
// 4. user-todo        pending 用户待办 → blocked
// 5. finalize         全部 intent 终态且无 pending 阻塞 → completed（「为 finalize 创建 job」）

import { makeSuggestion, dedupeSuggestions } from "./queue.js";
import { detectOrphanCandidates } from "./recovery.js";

const TERMINAL_INTENT_STATUSES = new Set(["completed", "failed", "deprecated"]);

/** intent 级建议计算。输入全部来自 store.sessionData() 的纯切片；now 可注入以便测试。 */
export function computeSuggestions({ intents = [], checkpoints = [], pendingApprovals = [], userTodos = [], coverageRows = [], now = Date.now() } = {}) {
	const raw = [];

	// 1. planned → queued
	for (const intent of intents) {
		if (intent?.status !== "planned") continue;
		raw.push(makeSuggestion({
			kind: "enqueue",
			intentId: intent.id,
			from: "planned",
			to: "queued",
			reason: "planned intent awaits execution",
			dedupeExtra: "enqueue",
			priority: Number(intent.priority) || 0
		}));
	}

	// 2. running 失联 → orphaned
	for (const cand of detectOrphanCandidates({ intents, checkpoints, now })) {
		raw.push(makeSuggestion({
			kind: "orphan-recover",
			intentId: cand.intentId,
			from: "running",
			to: "orphaned",
			reason: cand.reason,
			dedupeExtra: cand.dedupeExtra,
			priority: 5
		}));
	}

	// 3. pending 审批 → waiting-approval（等待事件，不轮询不重发）
	for (const approval of pendingApprovals) {
		if (approval?.status !== "pending") continue;
		raw.push(makeSuggestion({
			kind: "approval-wait",
			intentId: approval.intentId ?? "",
			from: "running",
			to: "waiting-approval",
			reason: `approval ${approval.id ?? "?"} pending (no polling by design)`,
			dedupeExtra: String(approval.id ?? ""),
			priority: 8
		}));
	}

	// 4. pending 用户待办 → blocked
	for (const todo of userTodos) {
		if (todo?.status !== "pending") continue;
		raw.push(makeSuggestion({
			kind: "user-todo",
			intentId: todo.intentId ?? "",
			from: "running",
			to: "blocked",
			reason: `user todo ${todo.id ?? "?"} pending`,
			dedupeExtra: String(todo.id ?? ""),
			priority: 9
		}));
	}

	// 5.5 [local.85] blocked 收尾未审计墙：blocked intent 且 coverage 无对应 phase=intent completed 行（即被墙挡住未回审计）→ 建议跟进。coverage 参数由调用方传入。
	for (const intent of intents) {
		if (intent?.status !== "blocked") continue;
		const cov = (coverageRows ?? []).find((row) => row?.phase === "intent" && row?.evidence?.includes?.(intent.id) && row?.status === "completed");
		if (cov !== void 0) continue;
		raw.push(makeSuggestion({
			kind: "wall-audit",
			intentId: intent.id,
			from: "blocked",
			to: "running",
			reason: `blocked intent ${intent.id} 有未审计面（签名墙/风控墙本身应审计，见 lessons/signature-wall-audit）`,
			 dedupeExtra: `wall-audit:${intent.id}`,
			priority: 6
		}));
	}

	// 6. finalize：全部 intent 终态且无 pending 审批/待办 → engagement 级完成建议
	const hasOpen = intents.some((i) => !TERMINAL_INTENT_STATUSES.has(i?.status))
		|| pendingApprovals.some((a) => a?.status === "pending")
		|| userTodos.some((t) => t?.status === "pending");
	if (intents.length > 0 && !hasOpen) {
		raw.push(makeSuggestion({
			kind: "finalize",
			intentId: "",
			from: "running",
			to: "completed",
			reason: "all intents terminal, no pending approvals/todos",
			dedupeExtra: "finalize",
			priority: 10
		}));
	}

	const suggestions = dedupeSuggestions(raw).sort((a, b) => a.priority - b.priority);
	return {
		suggestions,
		counts: suggestions.reduce((acc, s) => { acc[s.kind] = (acc[s.kind] ?? 0) + 1; return acc; }, {})
	};
}
