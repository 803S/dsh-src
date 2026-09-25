// Model-facing evidence formatting. No runtime/store dependency.
import { CREDENTIAL_HEADER_RE, redactText } from "./credentials.js";

export function clip(value, limit = 1200) {
	const text = String(value ?? "");
	return text.length > limit ? `${text.slice(0, limit)}\n…[截断 ${text.length} 字符]` : text;
}

export function requestSecrets(headers = {}) {
	return Object.entries(headers).filter(([k]) => CREDENTIAL_HEADER_RE.test(k)).flatMap(([key, value]) => {
		const s = String(value);
		return [s, ...(/^cookie$/i.test(key) ? s.split(/;\s*/).map((part) => part.includes("=") ? part.slice(part.indexOf("=") + 1) : "") : [s.replace(/^(Bearer|Basic)\s+/i, "")])].filter(Boolean);
	});
}

export function sanitizeEvidence(value, secrets = []) {
	let text = String(value ?? "");
	for (const secret of [...secrets].filter((v) => typeof v === "string" && v.length > 0).sort((a, b) => b.length - a.length)) text = text.split(secret).join("<stored>");
	return redactText(text).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<stored>@");
}

export function safeHeaders(headers, secrets = []) {
	const entries = typeof headers?.entries === "function" ? [...headers.entries()] : Object.entries(headers ?? {});
	return clip(entries.map(([key, value]) => `${key}: ${CREDENTIAL_HEADER_RE.test(key) || /^set-cookie$/i.test(key) ? "<stored>" : sanitizeEvidence(value, secrets)}`).join("\n"), 4000);
}

export function safeRequestBody(body, secrets = []) {
	const sensitive = /^(?:password|passwd|pwd|token|access_token|refresh_token|secret|authorization|cookie|api[_-]?key)$/i;
	let value = String(body ?? "");
	try {
		const scrub = (v) => Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sensitive.test(k) ? "<stored>" : scrub(x)])) : v;
		value = JSON.stringify(scrub(JSON.parse(value)));
	} catch {
		value = value.replace(/(^|[&\s])((?:password|passwd|pwd|token|access_token|refresh_token|secret|authorization|cookie|api[_-]?key)=)[^&\s]*/gi, "$1$2<stored>");
	}
	return clip(sanitizeEvidence(value, secrets), 4000);
}

export function renderHttp(_args, v) {
	const executed = v.approval === "allowed" || v.approval === "allowed-auto";
	const lines = [executed ? `src_http ${v.status} ${v.method} ${v.path}（已执行）` : `src_http ${v.approval === "pending" ? "已挂起待审" : "未执行"} ${v.pendingApprovalId ?? v.approval}（未发出）。${v.reason ?? ""}`];
	if (executed) {
		if (v.url) lines.push(v.url);
		if (v.responseHeaders) lines.push(`响应头：\n${v.responseHeaders}`);
		lines.push(`响应体${v.truncated ? "［截断］" : ""}${v.deduped ? "［去重］" : ""}：\n${clip(v.responseBody, _args.full === true ? 32000 : 2600)}`);
		if (v.evidenceId) lines.push(`证据 ${v.evidenceId}：src_get_evidence({ids:["${v.evidenceId}"],full:true}) 可读已存脱敏报文（最多32KB），无需重发请求。`);
		if (v.evidenceError) lines.push(`⚠ ${v.evidenceError}`);
	}
	if (v.skillHint) lines.push(v.skillHint);
	return [{ type: "text", text: lines.join("\n") }];
}

export function renderScan(_args, v) {
	const rows = v.results ?? [];
	return [{ type: "text", text: [`Scanned ${v.requested} paths: ${v.responses} responses, ${v.hints} interface hints.`, `预检 ${v.preflight?.status ?? 0}${v.stopped ? `；停止 ${v.stopped}` : ""}；requiresDecision=${v.requiresDecision === true}`, ...rows.slice(0, 40).map((r) => clip(`${r.path} → ${r.status ?? r.error} ${r.contentType ?? ""} ${r.protectionSignal ? "[protected]" : ""} hints=${(r.hints ?? []).slice(0, 8).join(", ")}`, 500)), ...(rows.length > 40 ? [`…省略 ${rows.length - 40} 条，缩小 paths 批次读取。`] : []), clip(v.multiBackendNote ?? "", 1500)].join("\n") }];
}

export function renderBypass(_args, v) {
	return [{ type: "text", text: [`Bypass hypothesis ${v.researchId}: ${v.differential ? "boundary differential reproduced" : "no differential"}; tested ${v.results.length} variants.`, ...v.results.map((r) => clip(`${r.phase ?? ""} ${r.method} ${r.path} → ${r.status ?? r.error}${r.protection ? " [protected]" : ""} length=${r.length ?? 0}`, 500)), `requiresDecision=${v.requiresDecision === true}；边界差分不等于影响证明。`, ...(v.lessonHints ?? [])].join("\n") }];
}

export function renderDecisionView(v) {
	const lines = [`SRC 状态（${v.view} v2）：${v.counts?.intents ?? 0} intents / ${v.counts?.facts ?? 0} facts / ${v.counts?.findings ?? 0} findings`, v.goal ? `目标 ${v.goal.target}：${clip(v.goal.objective, 300)}` : "未初始化，请先 src_add_goal。"];
	const section = (name, rows, format, max = 12) => {
		if (!rows?.length) return;
		lines.push(`${name}：`, ...rows.slice(0, max).map((r) => clip(format(r), 600)));
		if (rows.length > max) lines.push(`…另 ${rows.length - max} 项未展示`);
	};
	section("下一步", v.nextActions, (r) => `${r.id}[${r.status}] P${r.priority} ${r.reason}`);
	section("阻塞", v.blockedReasons, (r) => `${r.id} ${r.code}: ${r.reason} → ${r.action}`);
	section("运行/恢复", v.runningWork ?? v.orphanIntents, (r) => `${r.intentId} ${r.status ?? "orphan"} ${r.childId ?? r.childSessionId ?? ""} ${r.hint ?? ""}`);
	section("任务", v.intents, (r) => `${r.id}[${r.status}] P${r.priority} ${r.title}`);
	section("待审批", (v.pendingApprovals ?? []).filter((r) => r.status === "pending"), (r) => `${r.id} ${r.method} ${redactText(r.url)} ${r.reason}`);
	section("用户待办", (v.userTodos ?? []).filter((r) => r.status === "pending"), (r) => `${r.id} ${r.title}`);
	section("证据", v.recentFacts, (r) => `${r.id} ${r.target ?? ""} ${r.detail}`);
	if (v.evidenceIndex) lines.push(`证据索引：${(v.evidenceIndex.recent ?? []).join(", ")}；HTTP：${(v.evidenceIndex.observations ?? []).join(", ")}；省略 ${v.evidenceIndex.omitted ?? 0} 条；用 src_get_evidence 按 ID 读取。`);
	section("finding（非收录承诺）", v.findings, (r) => `${r.id}[${r.status ?? "active"}/${r.severity}] ${r.title}`);
	section("收尾阻塞", v.finalizeBlockers, String);
	section("提示", v.warnings, String);
	return [{ type: "text", text: lines.join("\n") }];
}
