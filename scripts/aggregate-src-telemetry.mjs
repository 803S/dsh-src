#!/usr/bin/env node
// [Phase 1 telemetry] SRC 遥测聚合报表（优化手册 2026-09-12 §5.4）。
// 用法：node scripts/aggregate-src-telemetry.mjs [telemetry-dir] [--json]
//   dir 缺省顺序：CLI 参数 > DSH_SRC_TELEMETRY_DIR > $DSH_HOME/storages/src-telemetry > ~/.dsh/storages/src-telemetry
//   --json 输出机器可读汇总（其余为人类可读漏斗报表）。
// 读 Phase 1 JSONL（src-telemetry-YYYY-MM-DD.jsonl），零依赖；只读不写。
// 报表四类：漏斗（route→evidence→finding / skill 用率 / 审批 / http）、token 体积估算、
// 重复调用（同会话同键反复调用）、orphan 恢复（intent.recovered）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const dirArg = args.find((a) => !a.startsWith("--"));

const dshHome = () => {
	const raw = (process.env.DSH_HOME ?? "").trim();
	return raw !== "" ? raw : nodePath.join(nodeOs.homedir(), ".dsh");
};
const envDir = (process.env.DSH_SRC_TELEMETRY_DIR ?? "").trim();
const telemetryDir = dirArg ?? (envDir !== "" ? envDir : nodePath.join(dshHome(), "storages", "src-telemetry"));

const rows = [];
let files = 0;
try {
	for (const name of readdirSync(telemetryDir).filter((f) => /^src-telemetry-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
		const abs = nodePath.join(telemetryDir, name);
		files += 1;
		for (const line of readFileSync(abs, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过（半行写入等） */ }
		}
	}
} catch (error) {
	if (error?.code === "ENOENT") {
		console.log(`src telemetry：${telemetryDir} 不存在（尚无会话写入，正常）。`);
		process.exit(0);
	}
	console.error(`无法读取遥测目录 ${telemetryDir}：${error?.message ?? error}`);
	process.exit(1);
}

if (rows.length === 0) {
	console.log(`src telemetry：${telemetryDir} 无数据（files=${files}）。`);
	process.exit(0);
}

/* ---- 基础分组 ---- */
const byEvent = new Map();
for (const row of rows) byEvent.set(row.event, (byEvent.get(row.event) ?? 0) + 1);
const count = (event) => byEvent.get(event) ?? 0;
const payloadOf = (row) => row.payload ?? {};
const distinct = (list) => new Set(list).size;

/* ---- 漏斗 1：路由 → 证据 → finding（按会话去重）---- */
const offeredSessions = rows.filter((r) => r.event === "route.offered").map((r) => r.sessionId);
const selectedSessions = rows.filter((r) => r.event === "route.selected").map((r) => r.sessionId);
const evidenceSessions = rows.filter((r) => r.event === "evidence.created").map((r) => r.sessionId);
const findingSessions = rows.filter((r) => r.event === "evidence.linked" && payloadOf(r).relation === "proves").map((r) => r.sessionId);
const finalizedSessions = rows.filter((r) => r.event === "engagement.finalized").map((r) => r.sessionId);
const findingRate = distinct(offeredSessions) > 0 ? Math.round((distinct(findingSessions) / distinct(offeredSessions)) * 100) : 0;

/* ---- 漏斗 2：skill 用率 ---- */
const skillReads = new Map();
for (const row of rows.filter((r) => r.event === "skill.read")) {
	const key = String(payloadOf(row).skillId ?? "?");
	skillReads.set(key, (skillReads.get(key) ?? 0) + 1);
}
const caps = rows.filter((r) => r.event === "capability.requested" || r.event === "capability.outcome");
const capRequested = rows.filter((r) => r.event === "capability.requested");
const capOutcomes = rows.filter((r) => r.event === "capability.outcome");
const capCompleted = capOutcomes.filter((r) => payloadOf(r).status === "completed");
const capFailed = capOutcomes.filter((r) => payloadOf(r).status === "failed");
const capAvgMs = capOutcomes.filter((r) => Number.isFinite(payloadOf(r).durationMs)).map((r) => payloadOf(r).durationMs);

/* ---- 漏斗 3：审批 ---- */
const waiting = rows.filter((r) => r.event === "approval.waiting");
const resolved = rows.filter((r) => r.event === "approval.resolved");
const allowed = resolved.filter((r) => payloadOf(r).decision === "allow");
const latencies = resolved.filter((r) => Number.isFinite(payloadOf(r).latencyMs) && payloadOf(r).latencyMs > 0).map((r) => payloadOf(r).latencyMs);
const approvalRate = waiting.length > 0 ? Math.round((allowed.length / waiting.length) * 100) : 0;
const byCategory = (list) => {
	const m = new Map();
	for (const row of list) { const k = String(payloadOf(row).category ?? "?"); m.set(k, (m.get(k) ?? 0) + 1); }
	return [...m.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "无";
};

/* ---- 漏斗 4：http ---- */
const httpRows = rows.filter((r) => r.event === "http.request");
const statusMap = new Map();
const hostMap = new Map();
let httpBytes = 0;
for (const row of httpRows) {
	const p = payloadOf(row);
	statusMap.set(p.status ?? 0, (statusMap.get(p.status ?? 0) ?? 0) + 1);
	hostMap.set(p.host ?? "?", (hostMap.get(p.host ?? "?") ?? 0) + 1);
	httpBytes += Number(p.responseBytes ?? 0);
}
const topHosts = [...hostMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, c]) => `${h}=${c}`).join(" ");

/* ---- token/体积估算：payload 字符数 ÷4 当 token 代理值（telemetry 行本身不进上下文，仅供观测盘估算）---- */
let payloadChars = 0;
const charsByEvent = new Map();
for (const row of rows) {
	const n = JSON.stringify(payloadOf(row) ?? {}).length;
	payloadChars += n;
	charsByEvent.set(row.event, (charsByEvent.get(row.event) ?? 0) + n);
}
const tokenEstimate = Math.round(payloadChars / 4);

/* ---- 重复调用：同 sessionId+event+键 反复出现 ---- */
const dupKeyOf = (row) => {
	const p = payloadOf(row);
	switch (row.event) {
		case "skill.read": return `${r0(p.skillId)}`;
		case "capability.requested": return `${r0(p.capabilityId)}/${r0(p.script)}`;
		case "http.request": return `${r0(p.host)}${r0(p.path)}:${r0(p.method)}`;
		case "route.offered": case "route.selected": return r0(p.primary);
		case "submit.checkpoint": return `${r0(p.intentId)}:${r0(p.stage)}`;
		case "engagement.finalized": return "finalize";
		default: return "";
	}
};
function r0(v) { return String(v ?? "?"); }
const dupGroups = new Map();
for (const row of rows) {
	const key = `${row.sessionId}|${row.event}|${dupKeyOf(row)}`;
	if (key.endsWith("|")) continue;
	dupGroups.set(key, (dupGroups.get(key) ?? 0) + 1);
}
const duplicates = [...dupGroups.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 12);

/* ---- orphan/恢复 ---- */
const recoveries = rows.filter((r) => r.event === "intent.recovered").map((r) => `${r0(payloadOf(r).intentId)}(${r0(payloadOf(r).attempt)}/4)`);

/* ---- 事件时间窗 ---- */
const times = rows.map((r) => Number(r.occurredAt ?? 0)).filter((n) => n > 0);
const window = times.length > 0 ? `${new Date(Math.min(...times)).toISOString()} → ${new Date(Math.max(...times)).toISOString()}` : "n/a";

/* ---- orchestrator shadow 建议聚合（json/文本两模式共用；必须在 jsonMode 块前声明防 TDZ）----
   [local.78 修复] 原 L153/L189 引用未定义变量必崩（ReferenceError），orchestrator 段无论何种模式都报表炸。 */
const suggestions = rows.filter((r) => r.event === "orchestrator.suggestion");
const suggestionByKind = new Map();
for (const row of suggestions) { const k = r0(payloadOf(row).kind); suggestionByKind.set(k, (suggestionByKind.get(k) ?? 0) + 1); }
const selectedBySession = new Map();
for (const row of rows.filter((r) => r.event === "route.selected")) {
	if (!selectedBySession.has(row.sessionId)) selectedBySession.set(row.sessionId, []);
	selectedBySession.get(row.sessionId).push(r0(payloadOf(row).primary));
}
const suggestionComparison = [...new Set(suggestions.map((r) => r0(payloadOf(r).intentId)))].slice(0, 8).map((intentId) => {
	const suggested = [...new Set(suggestions.filter((r) => r0(payloadOf(r).intentId) === intentId).map((r) => r0(payloadOf(r).to)))];
	return { intentId, suggested, actual: selectedBySession.get(intentId) ?? [] };
});

if (jsonMode) {
	console.log(JSON.stringify({
		dir: telemetryDir, files, rows: rows.length, window,
		byEvent: Object.fromEntries([...byEvent.entries()].sort()),
		funnel: { offeredSessions: distinct(offeredSessions), selectedSessions: distinct(selectedSessions), evidenceSessions: distinct(evidenceSessions), findingSessions: distinct(findingSessions), finalizedSessions: distinct(finalizedSessions), findingRatePct: findingRate },
		skills: { reads: Object.fromEntries([...skillReads.entries()].sort((a, b) => b[1] - a[1])), capability: { requested: capRequested.length, completed: capCompleted.length, failed: capFailed.length, avgDurationMs: capAvgMs.length ? Math.round(capAvgMs.reduce((a, b) => a + b, 0) / capAvgMs.length) : 0 } },
		approvals: { waiting: waiting.length, waitingByCategory: waiting.reduce((m, r) => { const k = payloadOf(r).category ?? "?"; m[k] = (m[k] ?? 0) + 1; return m; }, {}), resolved: resolved.length, allow: allowed.length, approvalRatePct: approvalRate, avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0 },
		http: { requests: httpRows.length, replays: httpRows.filter((r) => payloadOf(r).replay === true).length, byStatus: Object.fromEntries([...statusMap.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))), topHosts: [...hostMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, c]) => ({ host: h, count: c })), responseBytes: httpBytes },
		volume: { payloadChars, tokenEstimate },
		duplicates: duplicates.map(([key, n]) => ({ key, count: n })),
		recoveries,
		orchestrator: { suggestions: suggestions.length, byKind: Object.fromEntries([...suggestionByKind.entries()].sort()), comparison: suggestionComparison }
	}, null, 2));
	process.exit(0);
}

const line = "=".repeat(64);
console.log(`== src telemetry 汇总 ==`);
console.log(`目录: ${telemetryDir}（files=${files}，rows=${rows.length}）`);
console.log(`窗口: ${window}`);
console.log(line);
console.log(`-- 事件计数 --`);
for (const [event, n] of [...byEvent.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${event.padEnd(24)} ${n}`);
console.log(line);
console.log(`-- 路由→证据→finding 漏斗（按会话去重）--`);
console.log(`  建意图会话(route.offered): ${distinct(offeredSessions)} | 采纳(route.selected): ${distinct(selectedSessions)} | 产证据: ${distinct(evidenceSessions)} | 产 finding: ${distinct(findingSessions)} | finalize: ${distinct(finalizedSessions)}`);
console.log(`  finding_rate = ${findingRate}%`);
console.log(`-- skill 用率 --`);
for (const [id, n] of [...skillReads.entries()].sort((a, b) => b[1] - a[1])) console.log(`  read ${id}: ${n}`);
if (skillReads.size === 0) console.log(`  （无 skill.read——playbook/lesson/能力文档零阅读，§6 疑点）`);
console.log(`  capability: 请求 ${capRequested.length} / 完成 ${capCompleted.length} / 失败 ${capFailed.length}${capAvgMs.length ? ` / 平均 ${Math.round(capAvgMs.reduce((a, b) => a + b, 0) / capAvgMs.length)}ms` : ""}`);
console.log(`-- 审批漏斗 --`);
console.log(`  waiting ${waiting.length}（${byCategory(waiting)}）→ resolved ${resolved.length}（allow ${allowed.length} / reject ${resolved.length - allowed.length}），approval_rate=${approvalRate}%`);
if (latencies.length) console.log(`  平均等待 ${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)}ms`);
console.log(`-- http 漏斗 --`);
console.log(`  请求 ${httpRows.length}（其中审批重放 ${httpRows.filter((r) => payloadOf(r).replay === true).length}），响应累计 ${(httpBytes / 1024).toFixed(1)}KB`);
console.log(`  状态分布: ${[...statusMap.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s}=${c}`).join(" ") || "无"}`);
console.log(`  top hosts: ${topHosts || "无"}`);
console.log(`-- token/体积估算 --`);
console.log(`  payload 合计 ${(payloadChars / 1024).toFixed(1)}KB ≈ ${tokenEstimate} tokens（chars/4 代理值）`);
console.log(line);
console.log(`-- 重复调用 top（同会话+事件+键）--`);
if (duplicates.length === 0) console.log(`  无`);
for (const [key, n] of duplicates) console.log(`  ×${n}  ${key}`);
console.log(`-- orphan 恢复（intent.recovered）--`);
console.log(`  ${recoveries.length === 0 ? "无" : recoveries.join(", ")}`);
console.log(`-- orchestrator shadow：建议 vs 实际（[Phase 3]）--`);
if (suggestions.length === 0) console.log(`  无建议事件（DSH_SRC_ORCHESTRATOR=off 或尚无 src_state 观测点）`);
else {
  console.log(`  建议合计 ${suggestions.length}（${[...suggestionByKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(", ")}）`);
  for (const c of suggestionComparison) console.log(`  ${c.intentId}: 建议[${c.suggested.join(",") || "-"}] vs 实际[${c.actual.join(",") || "-"}]`);
}
