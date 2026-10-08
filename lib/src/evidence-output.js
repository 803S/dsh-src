// Model-facing evidence formatting. No runtime/store dependency.
import { localAddressNotice } from './egress/target-context.js';
import { CREDENTIAL_HEADER_RE, redactText } from "./credentials.js";
import { PENDING_CONTINUATION } from './egress/notifications.js';

export function clip(value, limit = 1200) {
	const text = String(value ?? "");
	return text.length > limit ? `${text.slice(0, limit)}\n…[截断 ${text.length} 字符]` : text;
}

export function requestSecrets(headers = {}) {
	return Object.entries(headers).filter(([k]) => CREDENTIAL_HEADER_RE.test(k)).flatMap(([key, value]) => {
		const s = String(value);
		const basic = /^Basic\s+(\S+)/i.exec(s);
		let decoded = '';
		if (basic) { try {decoded=Buffer.from(basic[1],'base64').toString('utf8');}catch{} }
		return [s, ...(decoded.includes(':') ? [decoded] : []), ...(/^cookie$/i.test(key) ? s.split(/;\s*/).map((part) => part.includes("=") ? part.slice(part.indexOf("=") + 1) : "") : [s.replace(/^(Bearer|Basic)\s+/i, "")])].filter(Boolean);
	});
}

export function sanitizeEvidence(value, secrets = []) {
	let text = String(value ?? "");
	for (const secret of [...secrets].filter((v) => typeof v === "string" && v.length > 0).sort((a, b) => b.length - a.length)) text = text.split(secret).join("<stored>");
	return redactText(text).replace(/(https?:\/\/)[^\s/@"'<>\[\]{},]+:[^\s/@"'<>\[\]{},]+@/gi, "$1<stored>@");
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
	const executed = ['allowed','allowed-auto','allowed-egress'].includes(v.approval) && Number.isInteger(v.status) && v.status >= 100 && v.status <= 599;
	const lines = [executed ? `src_http ${v.status} ${v.method} ${v.path}（已执行）` : `src_http ${v.approval === "pending" ? "已挂起待审" : "未执行"} ${v.pendingApprovalId ?? v.approval}（未发出）。${v.reason ?? ""}`];
	if (!executed && v.nextAction) lines.push(v.nextAction);
	if (!executed && v.approval==='pending' && !v.nextAction) lines.push(PENDING_CONTINUATION);
	if (executed) {
		if (v.url) lines.push(v.url);
		if (v.responseHeaders) lines.push(`响应头：\n${v.responseHeaders}`);
		lines.push(`响应体${v.truncated ? "［截断］" : ""}${v.deduped ? "［去重］" : ""}：\n${clip(v.responseBody, _args.full === true ? 32000 : 2600)}`);
		if (v.evidenceId) lines.push(`证据 ${v.evidenceId}：src_get_evidence({ids:["${v.evidenceId}"],full:true}) 可读已存脱敏报文（最多32KB），无需重发请求。`);
		const addressNote=localAddressNotice(v.responseBody);if(addressNote)lines.push(addressNote);
		if (v.snapshotRef) lines.push(`写前原始备份引用：${v.snapshotRef}（仅本任务同URL可用；显示用脱敏片段不能作为完整回滚原件）。`);
		if (v.snapshotError) lines.push(v.snapshotError);
		if (v.evidenceError) lines.push(`⚠ ${v.evidenceError}`);
	}
	if (v.riskAdvice) lines.push(`${v.riskAdvice.source === "jev" ? "Jev风险审批评估" : "Laya低层风险提示"}（非漏洞结论）：${v.riskAdvice.fallback ? `未取得有效判断：${v.riskAdvice.errorType ?? v.riskAdvice.source}` : `${v.riskAdvice.effect ?? v.riskAdvice.action} / 风险 ${v.riskAdvice.risk ?? "unknown"} / 建议 ${v.riskAdvice.action}`}。执行依据：${v.decisionAuthority ?? "待人工/既有规则"}。`);
	if (v.writeOutcome) lines.push(`写后核对：${v.writeOutcome.warning ?? v.writeOutcome.recovery}`);
	if (v.skillHint) lines.push(v.skillHint);
	return [{ type: "text", text: lines.join("\n") }];
}

export function renderScan(_args, v) {
	if(v.stopped==='approval-pending')return [{type:'text',text:`扫描未发送，待用户审批 ${v.pendingApprovalId}；taskId=${v.taskId}。\n${v.nextAction??PENDING_CONTINUATION}`}];
	const rows = v.results ?? [];
	const results = rows.slice(0, 100).map((r) => clip(`${r.path} → ${r.status ?? r.error} ${r.contentType ?? ""} length=${r.length ?? "unknown"} evidence=${r.evidenceId ?? 'none'} sampleBytes=${r.sampleBytes ?? "unknown"} sampleHash=${r.bodySampleSha256 ?? "unavailable"} title=${r.title ?? ""} ${r.protectionSignal ? "[protected]" : ""} hints=${(r.hints ?? []).slice(0, 8).join(", ")}`, 650));
	const input = v.scanInput;
	return [{ type: "text", text: [`扫描路径 ${v.requested}；有响应 ${v.responses}；失败 ${rows.filter(r=>r.error).length}；未调度 ${Math.max(0,(v.requested??0)-rows.length)}；页面资源线索 ${v.hints}（不等于业务接口）`, `预检 ${v.preflight?.status ?? 0}${v.stopped ? `；停止 ${v.stopped}` : ""}；requiresDecision=${v.requiresDecision === true}`, ...(input ? [`输入 ${input.supplied}；重复 ${input.duplicates}；非法 ${input.invalid}；接受 ${input.accepted}；输入超限省略 ${input.omittedPaths.length}`, ...(input.omittedPaths.length ? [`未执行路径（本批超过100项，不计入覆盖）：${clip(input.omittedPaths.join(", "), 2000)}`] : [])] : []), ...results, ...(rows.length > 100 ? [`另 ${rows.length - 100} 项未展示，不应推断其响应内容。`] : []), "样本hash仅反映有界响应片段。未命中字典不证明目标没有部署应用；不要为读取结果重复发送同一请求。", clip(v.multiBackendNote ?? "", 1500)].join("\n") }];
}

export function renderBypass(_args, v) {
	if(v.gateCode)return [{type:"text",text:`本测试分支未完成：${v.gateCode}；已取得结果${v.results?.length??0}项；本笔发送状态=${v.sent}；审批=${v.pendingApprovalId??"见原待办"}。\n${v.nextAction??PENDING_CONTINUATION}`}];
	return [{ type: "text", text: [`Bypass hypothesis ${v.researchId}: ${v.differential ? "boundary differential reproduced" : "no differential"}; tested ${v.results.length} variants.`, ...v.results.map((r) => clip(`${r.phase ?? ""} ${r.method} ${r.path} → ${r.status ?? r.error}${r.protection ? " [protected]" : ""} length=${r.length ?? 0}`, 500)), `requiresDecision=${v.requiresDecision === true}；边界差分不等于影响证明。`, ...(v.lessonHints ?? [])].join("\n") }];
}

export function renderDecisionView(v) {
	const lines = [`SRC 状态（${v.view} v2）：${v.counts?.intents ?? 0} intents / ${v.counts?.facts ?? 0} facts / ${v.counts?.findings ?? 0} findings`, v.goal ? `目标 ${v.goal.target}：${clip(v.goal.objective, 300)}` : "未初始化，请先 src_add_goal。"];
	if(v.goal?.scopeOrigin)lines.push(`目标记录的精确 origin：${v.goal.scopeOrigin}。只修改目标名称/登记资产不扩大出口授权；页面中的回环地址不是该目标。`);
	const section = (name, rows, format, max = 12) => {
		if (!rows?.length) return;
		lines.push(`${name}：`, ...rows.slice(0, max).map((r) => clip(format(r), 600)));
		if (rows.length > max) lines.push(`…另 ${rows.length - max} 项未展示`);
	};
	section("接口清单（按id用src_get_evidence读取方法/路径）", v.endpointManifestIndex, (m) => `${m.id} ${m.endpoints} endpoints source=${m.source}`);
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
