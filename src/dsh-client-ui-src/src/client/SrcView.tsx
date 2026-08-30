import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PropsLocale } from '../../types/slots'
import type { SrcProjection } from '../../types/projection'
import { ExploreView } from './ExploreView.tsx'
import { FindingsView } from './FindingsView.tsx'
import { AssetsView } from './AssetsView.tsx'
import { ReportView } from './ReportView.tsx'
import css from './SrcView.module.css'

type TodoRow = {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly detail?: string
  readonly status: 'pending' | 'done' | 'abandoned'
  readonly note?: string
  readonly createdAt?: number
} 

		/**
		* SrcView: the 渗透 conversation-view tab. A pure projection-mode
		* surface — the standing `src` projection (engagement goal plus the
		* exploration graph) arrives through `useProjection('src')`, so the tab
		* owns no store and needs no host RPC. The view renders one engagement header
		* card (goal target, objective, authorization, node counts) over a sub-tab
		* bar: 探索链路 (the chain as an interactive graph), 漏洞 (findings with
		* reproducible steps), 资产 (list or graph), and 报告 (copyable Markdown).
		* Absent projection
		* (capability or session not composed) or null (no `src_add_goal` yet)
		* renders the guiding empty note.
		*/
		/** The four sub-tabs of the view. */
		const TABS = [
			"explore",
			"findings",
			"assets",
			"timeline",
			"todos",
			"infra",
			"report"
		];
		/** Sub-tab label keys. */
		const TAB_LABELS: Record<string, string> = {
			explore: "view.tab.explore",
			findings: "view.tab.findings",
			assets: "view.tab.assets",
			timeline: "view.tab.timeline",
			todos: "view.tab.todos",
			infra: "view.tab.infra",
			report: "view.tab.report"
		};
		function TodoListView({ src, t, runCommand }: { readonly src: SrcProjection; readonly t: PropsLocale['t']; readonly runCommand?: ((cmd: string) => Promise<{ kind: string; text: string }>) | undefined }) {
			const [busyId, setBusyId] = useState<string | null>(null);
			const [feedback, setFeedback] = useState<string | null>(null);
			/** [local.9] todo currently awaiting an optional user note before the feedback is sent. */
			const [noteFor, setNoteFor] = useState<{ id: string; status: string } | null>(null);
			const [noteText, setNoteText] = useState("");
			const todos = (Array.isArray(src.userTodos) ? src.userTodos : []).slice().sort((a: TodoRow, b: TodoRow) => {
				const rank = (row: TodoRow) => row.status === "pending" ? 0 : row.status === "done" ? 1 : 2;
				return rank(a) - rank(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0);
			});
			if (todos.length === 0) return<div className={css.empty}>暂无用户待办（需要登录态/Burp 协助等人工事项会出现在这里）</div>;
			const sendTodoFeedback = async (todoId: string, status: string, note = "") => {
				if (busyId !== null || runCommand === void 0) return;
				setBusyId(todoId);
				setFeedback(null);
				setNoteFor(null);
				setNoteText("");
				try {
					const trimmed = String(note ?? "").trim();
					const result = await runCommand(`/src-todo ${todoId} ${status}${trimmed === "" ? "" : ` ${trimmed}`}`);
					setFeedback(result.kind === "success" ? `已转达 ${todoId} → ${status === "done" ? "已完成" : status === "abandoned" ? "已放弃" : "重新打开"}${trimmed === "" ? "" : `（备注：${trimmed.slice(0, 60)}）`}，等待 agent 处理…` : `命令返回错误：${result.text}`);
				} catch (error: any) {
					setFeedback(`发送失败：${error?.message ?? String(error)}`);
				} finally {
					setBusyId(null);
				}
			};
			return<div className={css.list}>{feedback !== null &&<div style={{ color: busyId !== null ? "var(--dsw-alias-state-warn-primary, #e80)" : "var(--dsw-alias-state-error-primary, #c33)", fontSize: 12, padding: "2px 4px" }}>{feedback}</div>}{todos.map((todo) =><div className={css.card} style={{ borderLeft: `3px solid ${todo.status === "done" ? "var(--dsw-alias-state-success-primary, #3c9)" : todo.status === "abandoned" ? "var(--dsw-alias-label-tertiary, #999)" : "var(--dsw-alias-state-warn-primary, #e80)"}`, marginBottom: 4, padding: "6px 10px", fontSize: 13 }}><div>{todo.status === "done" ? "\u2705" : todo.status === "abandoned" ? "\u274C" : "\u26A0\uFE0F"} <strong>{todo.title}</strong> <span style={{ color: "var(--dsw-alias-label-tertiary, #888)" }}>{`[${todo.kind}]`}</span><span style={{ color: "var(--dsw-alias-label-caption, #aaa)", marginLeft: 6, fontSize: 11 }}>{todo.id}</span></div>{todo.detail !== "" &&<div>{todo.detail}</div>}{todo.note !== "" &&<div style={{ color: "var(--dsw-alias-state-success-primary, #3c9)" }}>用户备注：{todo.note}</div>}{todo.status === "pending" && runCommand !== void 0 &&<div style={{ marginTop: 4 }}>{noteFor?.id === todo.id ?<><div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(127,127,127,.3)", background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))" }}><div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)", marginBottom: 5 }}>{(noteFor as { status: string }).status === "done" ? "\u2713 标记为已完成 \u2014\u2014 补充备注（可选，会转达给 AI）" : "\u2717 放弃此项 \u2014\u2014 说明原因（可选，会转达给 AI）"}</div><textarea autoFocus={true} rows={3} value={noteText} placeholder={(noteFor as { status: string }).status === "done" ? "如：已用 Burp 抓好登录包\n（Enter 发送，Shift+Enter 换行）" : "如：暂不测短信，跳过这项\n（Enter 发送，Shift+Enter 换行）"} onChange={(event) => setNoteText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendTodoFeedback(todo.id, (noteFor as { status: string }).status, noteText); } if (event.key === "Escape") setNoteFor(null); }} style={{ display: "block", width: "100%", boxSizing: "border-box", fontSize: 13, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", background: "transparent", color: "inherit", resize: "vertical", minHeight: 60, fontFamily: "inherit", lineHeight: 1.5 }} /><div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center", marginTop: 7 }}><button type="button" disabled={busyId !== null} onClick={() => void sendTodoFeedback(todo.id, (noteFor as { status: string }).status, noteText)} style={buttonStyle((noteFor as { status: string }).status === "done" ? "var(--dsw-alias-state-success-primary, #3c9)" : "var(--dsw-alias-label-tertiary, #999)")}>{busyId !== null ? "发送中…" : "发送"}</button><button type="button" onClick={() => setNoteFor(null)} style={buttonStyle("var(--dsw-alias-label-tertiary, #888)")}>取消</button></div></div></> :<div style={{ display: "flex", gap: 6, alignItems: "center" }}><button type="button" disabled={busyId !== null} onClick={() => { setNoteText(""); setNoteFor({ id: todo.id, status: "done" }); }} style={buttonStyle("var(--dsw-alias-state-success-primary, #3c9)")}>✓ 我已完成</button><button type="button" disabled={busyId !== null} onClick={() => { setNoteText(""); setNoteFor({ id: todo.id, status: "abandoned" }); }} style={buttonStyle("var(--dsw-alias-label-tertiary, #999)")}>✗ 放弃此项</button>{busyId === todo.id &&<span style={{ color: "var(--dsw-alias-state-warn-primary, #e80)", fontSize: 12 }}>发送中…</span>}</div>}</div>}</div>)}</div>;
		}
		/** Shared inline style for the small todo action buttons. */
		function buttonStyle(color: string): CSSProperties {
			return { 
				cursor: "pointer", 
				background: "color-mix(in oklab, var(--dsw-alias-bg-layer-2) 80%, transparent)", 
				borderRadius: "999px", 
				padding: "4px 14px", 
				fontSize: "12px", 
				fontWeight: "500",
				color: "var(--dsw-alias-label-primary)",
				lineHeight: "18px",
				backdropFilter: "blur(4px)",
				transition: "border-color 130ms ease, box-shadow 130ms ease",
				boxShadow: "0 1px 2px rgba(0,0,0,.03)",
				border: `1px solid ${color}`
			};
		}
		/** [local.31] 高危请求待审区：显示完整请求本体 + 批准/拒绝按钮 + 备注 textarea。
		 *  左右分栏布局由调用方负责，本组件只渲染右侧待审列表。 */
		function ApprovalListView({ src, t, runCommand }: { readonly src: SrcProjection; readonly t: PropsLocale['t']; readonly runCommand?: ((cmd: string) => Promise<{ kind: string; text: string }>) | undefined }) {
			const [busyId, setBusyId] = useState<string | null>(null);
			const [feedback, setFeedback] = useState<string | null>(null);
			const [noteFor, setNoteFor] = useState<{ id: string; action: string } | null>(null);
			const [noteText, setNoteText] = useState("");
			const approvals = (Array.isArray(src.pendingApprovals) ? src.pendingApprovals : []).slice().sort((a, b) => {
				const rank = (row: { status: string }) => row.status === "pending" ? 0 : row.status === "approved" ? 1 : 2;
				return rank(a) - rank(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0);
			});
			if (approvals.length === 0) return<div className={css.empty}>暂无待审请求（高危删改/越权请求会挂在这里等你批准）</div>;
			const sendApproval = async (id: string, action: string, note = "") => {
				if (busyId !== null || runCommand === void 0) return;
				setBusyId(id);
				setFeedback(null);
				setNoteFor(null);
				setNoteText("");
				try {
					const trimmed = String(note ?? "").trim();
					const result = await runCommand(`/src-approve ${id} ${action}${trimmed === "" ? "" : ` ${trimmed}`}`);
					setFeedback(result.kind === "success" ? `已转达 ${id} → ${action === "allow" ? "批准" : "拒绝"}${trimmed === "" ? "" : `（备注：${trimmed.slice(0, 60)}）`}，等待 agent 发出/丢弃…` : `命令返回错误：${result.text}`);
				} catch (error: any) {
					setFeedback(`发送失败：${error?.message ?? String(error)}`);
				} finally {
					setBusyId(null);
				}
			};
			return<div className={css.list}>{feedback !== null &&<div style={{ color: busyId !== null ? "var(--dsw-alias-state-warn-primary, #e80)" : "var(--dsw-alias-state-error-primary, #c33)", fontSize: 12, padding: "2px 4px" }}>{feedback}</div>}{approvals.map((ap) =><div className={css.card} style={{ borderLeft: `3px solid ${ap.status === "approved" ? "var(--dsw-alias-state-success-primary, #3c9)" : ap.status === "rejected" ? "var(--dsw-alias-label-tertiary, #999)" : "var(--dsw-alias-state-error-primary, #c33)"}`, marginBottom: 4, padding: "6px 10px", fontSize: 13 }}><div>⚠️ <strong>{ap.method} {ap.url}</strong> <span style={{ color: "var(--dsw-alias-state-error-primary, #c33)" }}>{`[${ap.category}]`}</span><span style={{ color: "var(--dsw-alias-label-caption, #aaa)", marginLeft: 6, fontSize: 11 }}>{ap.id}</span></div>{ap.status !== "pending" &&<div style={{ color: ap.status === "approved" ? "var(--dsw-alias-state-success-primary, #3c9)" : "var(--dsw-alias-label-tertiary, #999)", fontSize: 12 }}>{ap.status === "approved" ? `已批准${ap.responseStatus > 0 ? ` → 响应 ${ap.responseStatus}` : ""}` : "已拒绝"}{ap.note !== "" ? `· 备注：${ap.note}` : ""}</div>}{ap.justification !== "" &&<div style={{ color: "var(--dsw-alias-label-tertiary, #888)" }}>{ap.justification}</div>}{ap.reason !== "" &&<div style={{ color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 12 }}>分类理由：{ap.reason}</div>}<details style={{ marginTop: 2 }}><summary style={{ cursor: "pointer", color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 11 }}>请求报文</summary><pre style={preStyle(240)}>{ap.method} {ap.url}{ap.headers !== "" ? `\n${ap.headers}` : ""}{ap.body !== "" ? `\n\n${ap.body}` : ""}</pre></details>{ap.status === "pending" && runCommand !== void 0 &&<div style={{ marginTop: 4 }}>{noteFor?.id === ap.id ?<><div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(127,127,127,.3)", background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))" }}><div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)", marginBottom: 5 }}>{(noteFor as { action: string }).action === "allow" ? "批准——补充备注（可选，会转达给 AI）" : "拒绝——说明原因（可选，会转达给 AI）"}</div><textarea autoFocus={true} rows={3} value={noteText} placeholder={(noteFor as { action: string }).action === "allow" ? "如：可信测试账号、是自己的资源\n（Enter 发送，Shift+Enter 换行）" : "如：不批准，可能误伤真实用户\n（Enter 发送，Shift+Enter 换行）"} onChange={(event) => setNoteText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendApproval(ap.id, (noteFor as { action: string }).action, noteText); } if (event.key === "Escape") setNoteFor(null); }} style={{ display: "block", width: "100%", boxSizing: "border-box", fontSize: 13, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", background: "transparent", color: "inherit", resize: "vertical", minHeight: 60, fontFamily: "inherit", lineHeight: 1.5 }} /><div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center", marginTop: 7 }}><button type="button" disabled={busyId !== null} onClick={() => void sendApproval(ap.id, (noteFor as { action: string }).action, noteText)} style={buttonStyle((noteFor as { action: string }).action === "allow" ? "var(--dsw-alias-state-success-primary, #3c9)" : "var(--dsw-alias-label-tertiary, #999)")}>{busyId !== null ? "发送中…" : "发送"}</button><button type="button" onClick={() => setNoteFor(null)} style={buttonStyle("var(--dsw-alias-label-tertiary, #888)")}>取消</button></div></div></> :<div style={{ display: "flex", gap: 6, alignItems: "center" }}><button type="button" disabled={busyId !== null} onClick={() => { setNoteText(""); setNoteFor({ id: ap.id, action: "allow" }); }} style={buttonStyle("var(--dsw-alias-state-success-primary, #3c9)")}>✓ 批准</button><button type="button" disabled={busyId !== null} onClick={() => { setNoteText(""); setNoteFor({ id: ap.id, action: "reject" }); }} style={buttonStyle("var(--dsw-alias-label-tertiary, #999)")}>✗ 拒绝</button>{busyId === ap.id &&<span style={{ color: "var(--dsw-alias-state-warn-primary, #e80)", fontSize: 12 }}>发送中…</span>}</div>}</div>}</div>)}</div>;
		}
		function timelineDetailPre(label: string, text: string, maxHeight = 200): ReactNode {
			return<div style={{ marginTop: 4 }}><span style={{ color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 11 }}>{label}</span><pre style={preStyle(maxHeight)}>{text}</pre></div>;
		}
		/** [local.9] One labeled key/value row in the timeline detail panel. */
		function timelineDetailRow(label: string, value: unknown): ReactNode {
			if (value === void 0 || value === null || String(value) === "") return null;
			return<div style={{ margin: "2px 0", wordBreak: "break-all" }}><span style={{ color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 11, marginRight: 6 }}>{label}</span>{String(value)}</div>;
		}
		/** [local.9] Full-field rendering of the selected timeline event, by kind. */
		function TimelineDetail({ event }: { readonly event: any }) {
			const e = event;
			if (e.kind === "observation") return<>{timelineDetailRow("请求", `${e.method} ${e.path} → ${e.httpStatus}`)}{timelineDetailRow("来源", e.source)}{e.protectionSignal ? timelineDetailRow("防护信号", "是（403/429/WAF 拦截特征）") : null}{e.wafBypassed ? timelineDetailRow("绕过结果", "已绕过") : null}{e.decision !== "" && timelineDetailRow("决策理由", e.decision)}{e.assetId && timelineDetailRow("关联资产", e.assetId)}{e.intentId && timelineDetailRow("所属意图", e.intentId)}{e.respHeaders !== "" && timelineDetailPre(`响应头（截断至 600 字符，当前 ${e.respHeaders.length}）：`, e.respHeaders, 140)}{e.respBodySnippet !== "" && timelineDetailPre(`响应体片段（截断至 1200 字符，当前 ${e.respBodySnippet.length}）：`, e.respBodySnippet, 220)}</>;
			if (e.kind === "checkpoint") return<>{timelineDetailRow("阶段", e.stage)}{timelineDetailRow("小结", e.summary)}{timelineDetailRow("决策", e.decision)}{timelineDetailRow("产出增量", `+${e.facts} 事实 · +${e.assets} 资产 · +${e.findings} ��洞`)}{e.batchKey !== "" && timelineDetailRow("批次", e.batchKey)}{e.childSessionId && timelineDetailRow("子会话", e.childSessionId)}{e.intentId && timelineDetailRow("所属意图", e.intentId)}</>;
			if (e.kind === "fact") return<>{timelineDetailRow("类型", `[${e.factKind}]`)}{timelineDetailRow("内容", e.detail)}{e.target !== "" && timelineDetailRow("目标", e.target)}{e.confidence !== void 0 && timelineDetailRow("置信度", `${Math.round(e.confidence * 100)}%`)}{e.intentId && timelineDetailRow("所属意图", e.intentId)}</>;
			if (e.kind === "finding") {
				const asset = e.affectedAssetId === void 0 ? void 0 : e.allAssets?.find((candidate: any) => candidate.id === e.affectedAssetId);
				return<>{timelineDetailRow("等级", e.severity)}{timelineDetailRow("标题", e.title)}{e.description !== "" && timelineDetailRow("描述", e.description)}{e.impact !== "" && timelineDetailRow("实际危害（攻击者视角）", e.impact)}{e.victimImpact !== void 0 && e.victimImpact !== "" && timelineDetailRow("受害者视角", e.victimImpact)}{e.discoveryPath !== "" && timelineDetailRow("漏洞接口来源", e.discoveryPath)}{e.entryPoint !== "" && timelineDetailRow("前端功能点/入口", e.entryPoint)}{e.affectedScope !== "" && timelineDetailRow("影响范围", e.affectedScope)}{e.remediation !== "" && timelineDetailRow("修复建议", e.remediation)}{asset && timelineDetailRow("受影响资产", `${asset.type} ${asset.value}${asset.status ? ` (${asset.status})` : ""}`)}{e.rawRequest !== "" && timelineDetailPre("原始请求：", e.rawRequest, 200)}{e.rawResponse !== "" && timelineDetailPre("原始响应：", e.rawResponse, 200)}</>;
			}
			/* intent */
			return<>{timelineDetailRow("状态", e.status)}{timelineDetailRow("详情", e.detail)}</>;
		}
		function TimelineView({ src, t }: { readonly src: SrcProjection; readonly t: PropsLocale['t'] }) {
			/* Facts live inside nodes (kind === "fact"); there is no top-level facts array. */
			const factNodes = (Array.isArray(src.nodes) ? src.nodes : []).filter((node) => node.kind === "fact");
			const checkpoints = Array.isArray(src.checkpoints) ? src.checkpoints : [];
			const findingRows = Array.isArray(src.findings) ? src.findings : [];
			const assets = Array.isArray(src.assets) ? src.assets : [];
			const intentStatusMark = (status: string) => status === "completed" ? "✓" : status === "blocked" ? "✗" : status === "failed" ? "!" : status === "deprecated" ? "⊘" : "·";
			const factEvents = factNodes.map((f: any) => ({ kind: "fact", id: f.id, parent: f.intentId, factKind: f.factKind, target: f.target ?? "", detail: f.detail, confidence: f.confidence, at: f.createdAt ?? 0, short: `[事实][${f.factKind}] ${(f.detail ?? "").slice(0, 80)}` }));
			const findingEvents = findingRows.map((f: any) => ({ ...f, kind: "finding", id: f.id, parent: f.intentId, allAssets: assets, at: f.createdAt ?? 0, short: `[漏洞][${f.severity}] ${f.title}` }));
			const intentEvents = (src.nodes ?? []).filter((node: any) => node.kind === "intent").map((i: any) => ({ kind: "intent", id: i.id, parent: null, title: i.title, detail: i.detail, status: i.status, at: i.createdAt ?? 0, short: `[意图] ${intentStatusMark(i.status)} ${i.title}${i.priority ? ` [P${i.priority}]` : ""}` }));
			const ckEvents = checkpoints.map((c: any) => ({ kind: "checkpoint", id: c.id, parent: c.intentId, stage: c.stage, summary: c.summary ?? "", decision: c.decision ?? "", facts: c.facts ?? 0, assets: c.assets ?? 0, findings: c.findings ?? 0, batchKey: c.batchKey ?? "", childSessionId: c.childSessionId, at: c.createdAt, short: `[检查点][${c.stage}] +${c.facts}f/+${c.assets}a/+${c.findings}v · ${(c.summary || "").slice(0, 60)}${(c.summary ?? "").length > 60 ? "…" : ""}` }));
			const obsEvents = (Array.isArray(src.observations) ? src.observations : []).map((o: any) => ({ kind: "observation", id: o.id, parent: o.intentId, method: o.method, path: o.path, httpStatus: o.httpStatus, protectionSignal: !!o.protectionSignal, wafBypassed: !!o.wafBypassed, source: o.source, decision: o.decision ?? "", assetId: o.assetId, respHeaders: o.respHeaders ?? "", respBodySnippet: o.respBodySnippet ?? "", at: o.createdAt, short: `[探测] ${o.method} ${o.path} → ${o.httpStatus}${o.protectionSignal ? " ⛔WAF" : ""}${o.wafBypassed ? " ✂已绕过" : ""}` }));
			const events = [...intentEvents, ...factEvents, ...findingEvents, ...ckEvents, ...obsEvents].sort((a: any, b: any) => (a.at - b.at) || a.id.localeCompare(b.id));
			const [filter, setFilter] = useState("all");
			const [selectedKey, setSelectedKey] = useState<string | null>(null);
			if (events.length === 0) return<div className={css.empty}>{t("timeline.empty")}</div>;
			const filtered = filter === "all" ? events : events.filter((e: any) => e.kind === filter);
			const color = (k: string) => k === "finding" ? "var(--dsw-alias-state-error-primary, #d33)" : k === "fact" ? "var(--dsw-alias-state-info-primary, #39c)" : k === "checkpoint" ? "var(--dsw-alias-label-tertiary, #999)" : k === "observation" ? "var(--dsw-alias-state-warn-primary, #e80)" : "var(--dsw-alias-state-success-primary, #3c9)";
			const fmtTime = (at: number) => at > 0 ? new Date(at).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" }) : "--:--";
			const chips = [["all", `全部 ${events.length}`], ["intent", "意图"], ["fact", "事实"], ["finding", "漏洞"], ["checkpoint", "检查点"], ["observation", "探测"]];
			const selected = filtered.find((e) => `${e.kind}-${e.id}` === selectedKey) ?? filtered[filtered.length - 1] ?? null;
			return<div className={css.list} style={{ display: "flex", flexDirection: "column", gap: 6 }}><div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{chips.map(([key, label]) =><button type="button" onClick={() => setFilter(key)} style={{ cursor: "pointer", fontSize: 12, padding: "1px 10px", borderRadius: 999, border: `1px solid ${color(key === "all" ? "var(--dsw-alias-label-tertiary, #888)" : key)}`, background: filter === key ? "rgba(127,127,127,.18)" : "transparent", color: "inherit" }}>{label}</button>)}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "stretch" }}><div style={{ flex: "1 1 240px", minWidth: 220, maxHeight: 430, overflowY: "auto", borderRight: "1px solid rgba(127,127,127,.25)", paddingRight: 4 }} data-testid="src-timeline-list">{filtered.map((e) => {
						const key = `${e.kind}-${e.id}`;
						return<div onClick={() => setSelectedKey(key)} style={{ cursor: "pointer", display: "flex", gap: 6, alignItems: "baseline", padding: "3px 6px", borderRadius: 6, marginBottom: 2, fontSize: 12, background: selectedKey === key || selected === e ? "rgba(127,127,127,.16)" : "transparent" }} data-testid="src-timeline-item"><span style={{ color: color(e.kind), flexShrink: 0 }}>●</span><span style={{ color: "var(--dsw-alias-label-tertiary, #888)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{fmtTime(e.at)}</span><span style={{ wordBreak: "break-all" }}>{e.short}</span></div>;
					})}</div><div style={{ flex: "1.4 1 280px", minWidth: 240, maxHeight: 430, overflowY: "auto", fontSize: 13 }} data-testid="src-timeline-detail">{selected === null ? t("timeline.empty") :<><div style={{ fontWeight: 600, marginBottom: 4 }}><span style={{ color: color(selected.kind), marginRight: 6 }}>●</span>{selected.short}</div>{selected.parent && timelineDetailRow("所属意图", selected.parent)}<TimelineDetail event={selected} /></>}</div></div></div>;
		}
		/** Shared inline style for timeline detail <pre> blocks. */
		function preStyle(maxHeight: number): CSSProperties {
			return { whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))", borderRadius: 6, margin: "2px 0 0", padding: "4px 8px", fontSize: 11, lineHeight: "16px", maxHeight, overflowY: "auto" };
		}
		/** [local.9] 基础设施 tab：出站代理 / Burp MCP / 测试账号等运行参数，经 /src-infra 人机命令写回。 */
		function InfraView({ src, t, runCommand }: { readonly src: SrcProjection; readonly t: PropsLocale['t']; readonly runCommand?: ((cmd: string) => Promise<{ kind: string; text: string }>) | undefined }) {
			const resolved = src.infra ?? {};
			const [draft, setDraft] = useState<Record<string, string>>({});
			const [busyKey, setBusyKey] = useState<string | null>(null);
			const [burpTesting, setBurpTesting] = useState(false);
			const [proxyTesting, setProxyTesting] = useState(false);
			const [copyingInfra, setCopyingInfra] = useState(false);
			const [feedback, setFeedback] = useState<string | null>(null);
			if (runCommand === void 0) return<div className={css.empty}>当前会话不支持命令回传，无法在此修改基础设施设置。</div>;
			const save = async (key: string, value: string) => {
				if (busyKey !== null) return;
				setBusyKey(key);
				setFeedback(null);
				try {
					const trimmed = String(value ?? "").trim();
					const result = await runCommand(`/src-infra ${key} ${trimmed === "" ? "-" : trimmed}`);
					setFeedback(result.kind === "success" ? `已保存 ${key}${trimmed === "" ? "（清空恢复默认）" : ""}` : `命令返回错误：${result.text}`);
				} catch (error: any) {
					setFeedback(`保存失败：${error?.message ?? String(error)}`);
				} finally {
					setBusyKey(null);
				}
			};
			const sendTool = async (cmd: string, setter: (v: boolean) => void, doneText: string) => {
				if (busyKey !== null) return;
				setter(true);
				setFeedback(null);
				try {
					const result = await runCommand(cmd);
					setFeedback(result.kind === "success" ? result.text || doneText : `命令返回错误：${result.text}`);
				} catch (error: any) {
					setFeedback(`发送失败：${error?.message ?? String(error)}`);
				} finally {
					setter(false);
				}
			};
			const row_proxyUrl =<div className={css.fieldRow}><label className={css.fieldLabel} title="留空=全直连。仅 google/github 等无法直连的境外站点自动走代理，国内目标一律直连">HTTP 代理</label><input value={draft.proxyUrl ?? resolved.proxyUrl ?? ""} placeholder="http://127.0.0.1:7890（留空=直连）" title="留空=全直连。仅 google/github 等无法直连的境外站点自动走代理，国内目标一律直连" onChange={(event) => setDraft((prev) => ({ ...prev, proxyUrl: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") void save("proxyUrl", draft.proxyUrl ?? ""); }} style={{ flex: 1, minWidth: 120, fontSize: 12, padding: "5px 9px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1)", background: "transparent", color: "inherit", fontFamily: true ? "ui-monospace, monospace" : "inherit" }} /><button type="button" disabled={busyKey !== null} onClick={() => void save("proxyUrl", draft.proxyUrl ?? "")} style={buttonStyle("var(--dsw-alias-state-success-primary, #3c9)")}>{busyKey === "proxyUrl" ? "保存中…" : "保存"}</button></div>;
			const row_httpTimeoutMs =<div className={css.fieldRow}><label className={css.fieldLabel} title="单请求超时毫秒（1000..60000），留空用默认 8000">HTTP 超时(ms)</label><input value={draft.httpTimeoutMs ?? resolved.httpTimeoutMs ?? ""} placeholder="8000" title="单请求超时毫秒（1000..60000），留空用默认 8000" onChange={(event) => setDraft((prev) => ({ ...prev, httpTimeoutMs: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") void save("httpTimeoutMs", draft.httpTimeoutMs ?? ""); }} style={{ flex: 1, minWidth: 120, fontSize: 12, padding: "5px 9px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1)", background: "transparent", color: "inherit", fontFamily: false ? "ui-monospace, monospace" : "inherit" }} /><button type="button" disabled={busyKey !== null} onClick={() => void save("httpTimeoutMs", draft.httpTimeoutMs ?? "")} style={buttonStyle("var(--dsw-alias-state-success-primary, #3c9)")}>{busyKey === "httpTimeoutMs" ? "保存中…" : "保存"}</button></div>;
			const row_burpMcpPort =<div className={css.fieldRow}><label className={css.fieldLabel} title="Burp Pro「MCP Server」扩展的监听端口，默认 9876。默认端口下面板配置即全部；改非 9876 端口需同步在接线块 env 设 BURP_SSE_URL 并重启（见 README）">Burp 监听端口</label><input value={draft.burpMcpPort ?? resolved.burpMcpPort ?? ""} placeholder="9876" title="Burp Pro「MCP Server」扩展的监听端口，默认 9876。默认端口下面板配置即全部；改非 9876 端口需同步在接线块 env 设 BURP_SSE_URL 并重启（见 README）" onChange={(event) => setDraft((prev) => ({ ...prev, burpMcpPort: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") void save("burpMcpPort", draft.burpMcpPort ?? ""); }} style={{ flex: 1, minWidth: 120, fontSize: 12, padding: "5px 9px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1)", background: "transparent", color: "inherit", fontFamily: false ? "ui-monospace, monospace" : "inherit" }} /><button type="button" disabled={busyKey !== null} onClick={() => void save("burpMcpPort", draft.burpMcpPort ?? "")} style={buttonStyle("var(--dsw-alias-state-success-primary, #3c9)")}>{busyKey === "burpMcpPort" ? "保存中…" : "保存"}</button></div>;
			const row_testAccount =<div className={css.fieldRow}><label className={css.fieldLabel} title="越权 A/B 对照测试账号凭据；登录不了时 agent 会转用户待办">对照账号</label><input value={draft.testAccount ?? resolved.testAccount ?? ""} placeholder="user:pass 或用户名" title="越权 A/B 对照测试账号凭据；登录不了时 agent 会转用户待办" onChange={(event) => setDraft((prev) => ({ ...prev, testAccount: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") void save("testAccount", draft.testAccount ?? ""); }} style={{ flex: 1, minWidth: 120, fontSize: 12, padding: "5px 9px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1)", background: "transparent", color: "inherit", fontFamily: false ? "ui-monospace, monospace" : "inherit" }} /><button type="button" disabled={busyKey !== null} onClick={() => void save("testAccount", draft.testAccount ?? "")} style={buttonStyle("var(--dsw-alias-state-success-primary, #3c9)")}>{busyKey === "testAccount" ? "保存中…" : "保存"}</button></div>;
			const row_testPhone =<div className={css.fieldRow}><label className={css.fieldLabel} title="短信/验证码类测试用，多个逗号分隔；仅限授权测试">测试手机号</label><input value={draft.testPhone ?? resolved.testPhone ?? ""} placeholder="13800138000,13900139000" title="短信/验证码类测试用，多个逗号分隔；仅限授权测试" onChange={(event) => setDraft((prev) => ({ ...prev, testPhone: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") void save("testPhone", draft.testPhone ?? ""); }} style={{ flex: 1, minWidth: 120, fontSize: 12, padding: "5px 9px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1)", background: "transparent", color: "inherit", fontFamily: false ? "ui-monospace, monospace" : "inherit" }} /><button type="button" disabled={busyKey !== null} onClick={() => void save("testPhone", draft.testPhone ?? "")} style={buttonStyle("var(--dsw-alias-state-success-primary, #3c9)")}>{busyKey === "testPhone" ? "保存中…" : "保存"}</button></div>;
			const row_burpPath =<div className={css.fieldRow}><label className={css.fieldLabel} title="Burp MCP 自定义桥脚本绝对路径。一般留空=包 patch 默认桥 ~/.dsh/tools/burp-mcp-bridge.mjs（caps-sync 自动安装）">自定义桥路径</label><input value={draft.burpProxyJarPath ?? resolved.burpProxyJarPath ?? ""} placeholder="~/.dsh/tools/burp-mcp-bridge.mjs（留空=默认）" title="仅供 agent 参考与接线记录；实际接线在 profile patch，改后重启 dsh web 生效" onChange={(event) => setDraft((prev) => ({ ...prev, burpProxyJarPath: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") void save("burpProxyJarPath", draft.burpProxyJarPath ?? ""); }} style={{ flex: 1, minWidth: 120, fontSize: 12, padding: "5px 9px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1)", background: "transparent", color: "inherit", fontFamily: "ui-monospace, monospace" }} /><button type="button" disabled={busyKey !== null} onClick={() => void save("burpProxyJarPath", draft.burpProxyJarPath ?? "")} style={buttonStyle("var(--dsw-alias-state-success-primary, #3c9)")}>{busyKey === "burpProxyJarPath" ? "保存中…" : "保存"}</button></div>;
			const bridgeSnippet = [
				"# 包内 cordis.patch.yml 已默认启用以下接线（无需手改）；改端口示例：",
				"- insert:",
				"    - id: mcp-burp",
				"      name: '@deepseek-ai/dsh-mcp-client'",
				"      config:",
				"        serverName: burp",
				"        transport: stdio",
				"        command: bash",
				"        args:",
				"          - '-c'",
				"          - 'B=\"$HOME/.dsh/tools/burp-mcp-bridge.mjs\"; if [ -f \"$B\" ]; then exec node \"$B\"; fi'  # 自愈桥：断连自动重开会话",
				"        env: { BURP_SSE_URL: 'http://localhost:9877/' }   # 仅改端口时需要",
				"        failOnStartupError: false"
			].join("\n");
			return<div className={css.list}>{feedback !== null &&<div style={{ color: busyKey !== null ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-success-primary)", fontSize: 12, padding: "2px 4px" }}>{feedback}</div>}<div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}><button type="button" disabled={copyingInfra || busyKey !== null} title="把最近配置过的其他会话的设置复制到本会话并覆盖当前值；新会话建目标（src_add_goal）时已自动沿用，此按钮用于重新复制或覆盖当前值" onClick={() => void sendTool("/src-infra-copy", setCopyingInfra, "沿用中…")} style={buttonStyle("var(--dsw-alias-state-success-primary, #3c9)")}>{copyingInfra ? "沿用中…" : "沿用上次会话的基础设施"}</button><span style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 11 }}>新会话建目标时自动沿用，免逐项重填</span></div><div className={css.card}><div className={css.groupHead}><span className={css.groupTitle}>网络出站</span><button type="button" disabled={proxyTesting || busyKey !== null} title="服务端直接经代理请求探针地址，结果只显示在这里，不打扰 agent" onClick={() => void sendTool("/src-proxy-test", setProxyTesting, "测活中…")} style={buttonStyle("var(--dsw-alias-state-info-primary, #69c)")}>{proxyTesting ? "测活中…" : "测试代理连通"}</button></div>{row_proxyUrl}{row_httpTimeoutMs}</div><div className={css.card}><div className={css.groupHead}><span className={css.groupTitle}>Burp MCP</span><button type="button" disabled={burpTesting || busyKey !== null} title="先经自愈桥 tools_list，再真实拉一条 proxy history 验证完整链路" onClick={() => void sendTool("/src-burp-test", setBurpTesting, "发送中…")} style={buttonStyle("var(--dsw-alias-state-info-primary, #69c)")}>{burpTesting ? "测试中…" : "测试连接"}</button></div>{row_burpMcpPort}{row_burpPath}<div style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 11 }}>前置：Burp Pro 装「MCP Server」扩展并点 Start。接线开箱即用（包 patch 默认启用）；桥未装时跑一次 caps-sync 即自动安装</div></div><div className={css.card}><div className={css.groupTitle}>测试凭据</div>{row_testAccount}{row_testPhone}</div><details style={{ fontSize: 12 }}><summary style={{ cursor: "pointer", color: "var(--dsw-alias-label-tertiary)" }}>高级：cordis 接线片段与进程级代理</summary><pre style={preStyle(200)}>{bridgeSnippet}\n\n# 进程级代理（可选）：dsh 主进程全部流量走系统代理时，启动前设置\n# HTTPS_PROXY=http://127.0.0.1:7890 NODE_OPTIONS=--use-env-proxy\n# 插件内的 HTTP 代理仅作用于 SRC 出站请求，与此互不影响。</pre></details></div>;
		}
		export function SrcView({ useProjection, t, runCommand }: {
  readonly useProjection: (key: string) => SrcProjection | null | undefined
  readonly t: PropsLocale['t']
  readonly runCommand?: ((cmd: string) => Promise<{ kind: string; text: string }>) | undefined
}) {
			const src = useProjection("src");
			const [tab, setTab] = useState("explore");
			if (src === void 0 || src === null) return<div className={css.empty} data-testid="src-view"><span className={css.emptyText}>{t("view.empty")}</span></div>;
			return<section className={css.root} data-testid="src-view"><header className={css.card}>{src.goal !== null && src.goal.objective !== "" && <p className={css.objective}>目的：{src.goal.objective}</p>}<div className={css.cardTitle} style={{ alignItems: "center" }}><h2 className={css.target} style={{ fontSize: 18 }}>{src.goal === null ? "" : src.goal.target}</h2>{src.goal !== null && src.goal.authorization !== "" && <span className={css.badge} title={src.goal.authorization}>授权：{src.goal.authorization.length > 24 ? `${src.goal.authorization.slice(0, 24)}…` : src.goal.authorization}</span>}</div>{(() => {
								const pendingTodos = (src.userTodos ?? []).filter((row) => row.status === "pending").length;
								const pendingApprovals = (src.pendingApprovals ?? []).filter((row) => row.status === "pending").length;
								/* [local.33] 认证预算：src_test_bypass 认证请求计数 used/limit（会话级）。≥80% 变警示色，触顶红。 */
								const authBudget = src.authBudget;
								const authBudgetAccent = authBudget === void 0 || authBudget.used === 0 ? css.statMuted : authBudget.used >= authBudget.limit ? css.statAccent : authBudget.used * 5 >= authBudget.limit * 4 ? css.statWarn : "";
								const stats = [
									["意图", src.counts!.intents, ""],
									["事实", src.counts!.facts, ""],
									["资产", src.counts!.assets, ""],
									["漏洞", src.counts!.findings, src.counts!.findings > 0 ? css.statAccent : ""],
									["检查点", src.counts!.checkpoints ?? 0, (src.counts!.checkpoints ?? 0) === 0 ? css.statMuted : ""],
									["探测", src.counts!.observations ?? 0, (src.counts!.observations ?? 0) === 0 ? css.statMuted : ""],
									["待办", pendingTodos, pendingTodos > 0 ? css.statAccent : css.statMuted],
									["待审", pendingApprovals, pendingApprovals > 0 ? css.statAccent : css.statMuted],
									["认证", authBudget === void 0 ? "—" : `${authBudget.used}/${authBudget.limit}`, authBudgetAccent]
								];
								return<div className={css.statTrack}>{stats.map(([label, value, accent]) => <div className={`${css.stat} ${accent}`}><div className={css.statValue}>{value}</div><div className={css.statLabel}>{label}</div></div>)}</div>;
							})()}{src.apiDiscovery && (src.apiDiscovery.total ?? 0) > 0 &&<p className={css.counts}>API 发现：{src.apiDiscovery.total ?? 0} · schema {src.apiDiscovery.schemas ?? 0} · GraphQL {src.apiDiscovery.graphql ?? 0} · hint {src.apiDiscovery.hints ?? 0} · 未推进 {src.apiDiscovery.untouched ?? 0}</p>}</header><nav className={css.tabs} data-testid="src-tabs">{TABS.map((tabKey) =><button type="button" className={css.tab} aria-pressed={tab === tabKey} data-testid={`src-tab-${tabKey}`} onClick={() => {
								setTab(tabKey);
							}}>{t(TAB_LABELS[tabKey])}{(() => {
									const badgeFor = (key: string) => {
										if (key === "findings") return src.counts!.findings;
										if (key === "assets") return src.counts!.assets;
										if (key === "timeline") return (src.checkpoints?.length ?? 0) + ((src.nodes ?? []).filter((node) => node.kind === "fact").length) + (src.findings?.length ?? 0) + (src.observations?.length ?? 0);
										if (key === "todos") return (src.userTodos ?? []).filter((row) => row.status === "pending").length + (src.pendingApprovals ?? []).filter((row) => row.status === "pending").length;
										return 0;
									};
									const n = badgeFor(tabKey);
									if (n === 0) return null;
									return<span className={`${css.tabBadge} ${tabKey === "todos" ? css.tabBadgeHot : ""}`}>{n}</span>;
								})()}</button>)}</nav><div className={css.content}>{(() => { switch (tab) { case "explore": return <ExploreView src={src} t={t} />; case "findings": return <FindingsView src={src} t={t} runCommand={runCommand} />; case "assets": return <AssetsView src={src} t={t} />; case "timeline": return <TimelineView src={src} t={t} />; case "todos": return <Fragment><div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}><div style={{ flex: "1 1 0", minWidth: 0 }}><div style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", marginBottom: 4 }}>待办事项</div><TodoListView src={src} t={t} runCommand={runCommand} /></div><div style={{ flex: "1 1 0", minWidth: 0 }}><div style={{ fontSize: 12, color: "var(--dsw-alias-state-error-primary, #c33)", marginBottom: 4 }}>⚠️ 高危请求待审</div><ApprovalListView src={src} t={t} runCommand={runCommand} /></div></div></Fragment>; case "infra": return <InfraView src={src} t={t} runCommand={runCommand} />; case "report": return <ReportView src={src} t={t} />; default: return null; } })()}</div></section>;
		}
		//#endregion
		