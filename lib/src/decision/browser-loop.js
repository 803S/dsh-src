// Browser fast-loop 的最小薄层：observation -> 代码候选 -> Laya index -> hard guard。
// 不拥有 browser/context/page 生命周期；动作始终通过宿主已经注册的 MCP tool 执行。

import { createHash } from "node:crypto";
import { createDefaultTelemetry } from "../telemetry/events.js";
import { layaDecide } from "./laya-client.js";

const ALLOWED_OPERATIONS = new Set(["click", "wait"]);
const MCP_TOOL_NAMES = Object.freeze({ snapshot: "mcp__playwright__browser_snapshot", click: "mcp__playwright__browser_click", wait: "mcp__playwright__browser_wait_for" });
const SNAPSHOT_REF = /\[ref=([^\]]+)\]/g;

export function extractSnapshotText(result) {
	const value = result?.value ?? result;
	if (typeof value === "string") return value;
	if (typeof value?.text === "string") return value.text;
	const blocks = Array.isArray(value?.content) ? value.content : (Array.isArray(result?.content) ? result.content : []);
	return blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

export function browserFingerprint(observation) {
	const stable = String(observation ?? "")
		.replace(/\s+\[active\]/g, "")
		.replace(/\s+\[focused\]/g, "")
		.replace(/\s+\[busy\]/g, "");
	return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

/** 从 Playwright accessibility snapshot 生成保守的、编号的动作候选。 */
export function buildBrowserCandidates(observation) {
	const text = String(observation ?? "");
	const candidates = [];
	for (const line of text.split("\n")) {
		const ref = [...line.matchAll(SNAPSHOT_REF)][0]?.[1];
		if (!ref) continue;
		const normalized = line.trim();
		const isClickable = /\b(button|link|checkbox|tab|menuitem)\b/i.test(normalized);
		if (!isClickable) continue;
		const label = normalized.replace(/\s*\[ref=[^\]]+\]/, "").replace(/^[-*]\s*/, "").trim().slice(0, 160);
		candidates.push({ index: candidates.length, operation: "click", targetRef: ref, label, allowed: true, guard: { page: "same-fingerprint" } });
	}
	// 第一版不放 done，也不让 Laya 生成任意 type value。wait 仅是安全兜底，
	// 不进入 Laya 候选，避免模型在存在可执行 click 时选择 wait；fallbackBrowserCandidate
	// 会在决策失败或非法时构造它。
	return candidates;
}

export function browserDecisionPrompt({ goal, observation, fingerprint, candidates }) {
	const rows = candidates.map((candidate) => `${candidate.index}: ${candidate.operation}${candidate.targetRef ? ` target=${candidate.targetRef}` : ""} label=${candidate.label}`).join("\n");
	return `目标：${String(goal ?? "完成当前本地页面动作")}
observation fingerprint：${fingerprint}
页面 observation（只读，不要生成 selector）：
${String(observation ?? "").slice(0, 12000)}
代码生成候选（只能选择 index）：
${rows}
规则：只返回候选 index；不要选择候选之外的值；没有 done 候选；不要生成 selector、URL、坐标、JavaScript 或参数。`;
}

export async function chooseBrowserCandidate({ goal, observation, candidates }, exec) {
	if (!Array.isArray(candidates) || candidates.length === 0) return { index: -1, confidence: 0, source: "rules", fallback: true, latency: 0 };
	const fingerprint = browserFingerprint(observation);
	const result = await layaDecide({
		taskType: "browser-index",
		goal,
		observation,
		fingerprint,
		candidates,
		exec
	}, exec);
	const rawIndex = result.index?.choice ?? result.action;
	const index = /^\d+$/.test(String(rawIndex)) ? Number(rawIndex) : -1;
	return {
		index: Number.isInteger(index) ? index : -1,
		confidence: Number(result.confidence ?? 0),
		probabilities: result.index?.probabilities ?? result.probabilities ?? {},
		source: result.source ?? "fallback",
		fallback: result.fallback === true,
		latency: Number(result.latency ?? 0)
	};
}

export function fallbackBrowserCandidate(candidates) {
	return {
		index: Array.isArray(candidates) ? candidates.length : 0,
		operation: "wait",
		targetRef: null,
		label: "等待页面稳定",
		allowed: true,
		guard: { page: "same-fingerprint" }
	};
}

export function guardBrowserCandidate({ candidate, candidates, observationFingerprint, currentObservationFingerprint, currentObservation = "", allowedUrl }) {
	if (!candidate) return { allowed: false, code: "index_not_found" };
	if (!ALLOWED_OPERATIONS.has(candidate.operation)) return { allowed: false, code: "operation_not_allowed" };
	if (candidate.operation !== "wait" && !candidates.includes(candidate)) return { allowed: false, code: "index_not_found" };
	if (candidate.allowed !== true) return { allowed: false, code: "candidate_not_allowed" };
	if (observationFingerprint !== currentObservationFingerprint) return { allowed: false, code: "stale_observation" };
	if (allowedUrl !== true) return { allowed: false, code: "url_out_of_scope" };
	if (candidate.operation === "click" && typeof candidate.targetRef !== "string") return { allowed: false, code: "target_missing" };
	if (candidate.targetRef && !String(currentObservation).includes(`[ref=${candidate.targetRef}]`)) return { allowed: false, code: "target_missing" };
	return { allowed: true, code: "" };
}

export function browserActionArguments(candidate) {
	if (candidate.operation === "click") return { target: candidate.targetRef, element: candidate.label };
	return { time: 0.05 };
}

/**
 * Adapt the loop's callback-shaped events to the existing SRC JSONL sink.
 * The sink remains fire-and-forget; a broken telemetry directory cannot affect
 * the host executor or the browser action.
 */
export function createBrowserTelemetry(exec, { telemetry, engagementId = "" } = {}) {
	const sessionId = exec?.agent?.session?.id ?? "";
	const sink = telemetry ?? createDefaultTelemetry();
	return (event, payload = {}) => {
		const row = {
			taskType: "browser",
			sessionId,
			engagementId: engagementId || sessionId,
			adopted: payload.adopted ?? false,
			...payload
		};
		try {
			if (typeof sink === "function") sink(event, row);
			else sink.emit(event, { sessionId, engagementId: engagementId || sessionId }, row);
		} catch {}
	};
}

/**
 * One action cycle. The host supplies executeTool so this adapter never owns
 * MCP/page/context lifetimes and cannot invent a tool name or argument value.
 */
export async function runBrowserLoop({ goal, executeTool, allowedUrl = false, telemetry, engagementId = "", decide = chooseBrowserCandidate }, exec) {
	if (typeof executeTool !== "function") throw new TypeError("browser loop requires the host tool executor");
	const emit = createBrowserTelemetry(exec, { telemetry, engagementId });
	const runTool = async (name, args) => executeTool(name, args, exec);
	const observationStarted = Date.now();
	let first;
	try {
		first = await runTool(MCP_TOOL_NAMES.snapshot, {});
	} catch (error) {
		emit("browser.observation", { observationFingerprint: "", candidateCount: 0, operation: "snapshot", targetRef: null, latency: Date.now() - observationStarted, source: "playwright", fallback: false, executed: true, success: false, failureCode: "snapshot_error", guardCode: "" });
		throw error;
	}
	if (first?.isError === true) {
		emit("browser.observation", { observationFingerprint: "", candidateCount: 0, operation: "snapshot", targetRef: null, latency: Date.now() - observationStarted, source: "playwright", fallback: false, executed: true, success: false, failureCode: "snapshot_error", guardCode: "" });
		throw new Error("browser snapshot failed");
	}
	const observation = extractSnapshotText(first);
	const fingerprint = browserFingerprint(observation);
	const candidates = buildBrowserCandidates(observation);
	emit("browser.observation", { observationFingerprint: fingerprint, candidateCount: candidates.length, operation: "snapshot", targetRef: null, latency: Date.now() - observationStarted, source: "playwright", fallback: false, executed: true, success: true, failureCode: "", guardCode: "" });
	let decision = await decide({ goal, observation, candidates }, exec);
	let candidate = candidates[decision.index];
	if (!candidate || decision.fallback) {
		candidate = fallbackBrowserCandidate(candidates);
		decision = { ...decision, index: candidate?.index ?? -1, fallback: true, source: decision.source ?? "fallback" };
	}
	emit("browser.decision", { observationFingerprint: fingerprint, candidateCount: candidates.length, chosenIndex: decision.index, confidence: decision.confidence, probabilities: decision.probabilities, operation: candidate?.operation ?? "", targetRef: candidate?.targetRef ?? null, latency: decision.latency, source: decision.source, fallback: decision.fallback, adopted: decision.fallback !== true, executed: false, success: false, failureCode: "", guardCode: "" });
	let currentSnapshot;
	try {
		currentSnapshot = await runTool(MCP_TOOL_NAMES.snapshot, {});
	} catch (error) {
		emit("browser.guard", { observationFingerprint: fingerprint, candidateCount: candidates.length, chosenIndex: decision.index, operation: candidate?.operation ?? "", targetRef: candidate?.targetRef ?? null, latency: 0, source: "playwright", fallback: decision.fallback, adopted: false, guardCode: "snapshot_error", executed: false, success: false, failureCode: "snapshot_error" });
		throw error;
	}
	if (currentSnapshot?.isError === true) {
		emit("browser.guard", { observationFingerprint: fingerprint, candidateCount: candidates.length, chosenIndex: decision.index, operation: candidate?.operation ?? "", targetRef: candidate?.targetRef ?? null, latency: 0, source: "playwright", fallback: decision.fallback, adopted: false, guardCode: "snapshot_error", executed: false, success: false, failureCode: "snapshot_error" });
		throw new Error("browser revalidation snapshot failed");
	}
	const currentObservation = extractSnapshotText(currentSnapshot);
	const currentFingerprint = browserFingerprint(currentObservation);
	const guard = guardBrowserCandidate({ candidate, candidates, observationFingerprint: fingerprint, currentObservationFingerprint: currentFingerprint, currentObservation, allowedUrl });
	if (!guard.allowed) {
		emit("browser.guard", { observationFingerprint: fingerprint, candidateCount: candidates.length, chosenIndex: decision.index, operation: candidate?.operation ?? "", targetRef: candidate?.targetRef ?? null, latency: 0, source: "hard-guard", fallback: decision.fallback, adopted: false, guardCode: guard.code, executed: false, success: false, failureCode: guard.code });
		return { observation, fingerprint, currentObservation, currentFingerprint, candidates, decision, guard, executed: false, success: false };
	}
	emit("browser.guard", { observationFingerprint: fingerprint, candidateCount: candidates.length, chosenIndex: decision.index, operation: candidate.operation, targetRef: candidate.targetRef, latency: 0, source: "hard-guard", fallback: decision.fallback, adopted: false, guardCode: "", executed: false, success: true, failureCode: "" });
	const toolName = candidate.operation === "click" ? MCP_TOOL_NAMES.click : MCP_TOOL_NAMES.wait;
	const actionStarted = Date.now();
	let action;
	try {
		action = await runTool(toolName, browserActionArguments(candidate));
	} catch (error) {
		emit("browser.action", { observationFingerprint: fingerprint, candidateCount: candidates.length, chosenIndex: decision.index, operation: candidate.operation, targetRef: candidate.targetRef, latency: Date.now() - actionStarted, source: toolName, fallback: decision.fallback, adopted: !decision.fallback, executed: true, success: false, failureCode: "tool_error", guardCode: "" });
		throw error;
	}
	if (action?.isError === true) {
		emit("browser.action", { observationFingerprint: fingerprint, candidateCount: candidates.length, chosenIndex: decision.index, operation: candidate.operation, targetRef: candidate.targetRef, latency: Date.now() - actionStarted, source: toolName, fallback: decision.fallback, adopted: !decision.fallback, executed: true, success: false, failureCode: "tool_error", guardCode: "" });
		return { observation, fingerprint, currentObservation, currentFingerprint, candidates, decision, guard, executed: true, success: false, action };
	}
	let afterSnapshot;
	try {
		afterSnapshot = await runTool(MCP_TOOL_NAMES.snapshot, {});
	} catch (error) {
		emit("browser.action", { observationFingerprint: fingerprint, candidateCount: candidates.length, chosenIndex: decision.index, operation: candidate.operation, targetRef: candidate.targetRef, latency: Date.now() - actionStarted, source: toolName, fallback: decision.fallback, adopted: !decision.fallback, executed: true, success: false, failureCode: "after_snapshot_error", guardCode: "" });
		throw error;
	}
	const after = extractSnapshotText(afterSnapshot);
	const success = afterSnapshot?.isError !== true;
	emit("browser.action", { observationFingerprint: fingerprint, candidateCount: candidates.length, chosenIndex: decision.index, operation: candidate.operation, targetRef: candidate.targetRef, latency: Date.now() - actionStarted, source: toolName, fallback: decision.fallback, adopted: !decision.fallback, executed: true, success, failureCode: success ? "" : "after_snapshot_error", guardCode: "" });
	return { observation, fingerprint, currentObservation, currentFingerprint, candidates, decision, guard, executed: true, success, action, afterObservation: after, afterFingerprint: browserFingerprint(after) };
}

export { ALLOWED_OPERATIONS, MCP_TOOL_NAMES };
