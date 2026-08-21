
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
const React = require2("react");
const jsxRuntime = require2("react/jsx-runtime");
const { jsx, jsxs, Fragment } = jsxRuntime;
const { renderToString } = require2("react-dom/server");

var react = React;
var react_jsx_runtime = { jsx, jsxs, Fragment };
var SrcView_module_css_default = new Proxy({}, { get: (t, k) => String(k) });
const TABS = ["explore","findings","assets","timeline","todos","report"];
const TAB_LABELS = Object.fromEntries(TABS.map(k => [k, "tab."+k]));
const t = (key, params) => {
  const dict = {
    "tab.todos": "待办", "tab.timeline": "时间线", "tab.explore": "探索",
    "tab.findings": "发现", "tab.assets": "资产", "tab.report": "报告",
    "timeline.empty": "暂无", "view.empty": "空", "view.src": "SRC",
    "counts": (p) => `意图 ${p.intents} · 探测 ${p.observations} · 待处理待办 ${p.userTodos}`
  };
  const v = dict[key];
  if (typeof v === "function") return v(params ?? {});
  return v ?? key;
};

function TodoListView({ src, t, runCommand }) {
			const [busyId, setBusyId] = (0, react.useState)(null);
			const [feedback, setFeedback] = (0, react.useState)(null);
			const todos = (Array.isArray(src.userTodos) ? src.userTodos : []).slice().sort((a, b) => {
				const rank = (row) => row.status === "pending" ? 0 : row.status === "done" ? 1 : 2;
				return rank(a) - rank(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0);
			});
			if (todos.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: SrcView_module_css_default.empty, children: "暂无用户待办（需要登录态/Burp 协助等人工事项会出现在这里）" });
			const sendTodoFeedback = async (todoId, status) => {
				if (busyId !== null || runCommand === void 0) return;
				setBusyId(todoId);
				setFeedback(null);
				try {
					const result = await runCommand(`/src-todo ${todoId} ${status}`);
					setFeedback(result.kind === "success" ? `已转达 ${todoId} → ${status === "done" ? "已完成" : status === "abandoned" ? "已放弃" : "重新打开"}，等待 agent 处理…` : `命令返回错误：${result.text}`);
				} catch (error) {
					setFeedback(`发送失败：${error?.message ?? String(error)}`);
				} finally {
					setBusyId(null);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { className: SrcView_module_css_default.list, children: [
				feedback !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: { color: busyId !== null ? "#e80" : "#c33", fontSize: 12, padding: "2px 4px" }, children: feedback }),
				todos.map((todo) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { className: SrcView_module_css_default.card, style: { borderLeft: `3px solid ${todo.status === "done" ? "#3c9" : todo.status === "abandoned" ? "#999" : "#e80"}`, marginBottom: 4, padding: "6px 10px", fontSize: 13 }, children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						todo.status === "done" ? "\u2705" : todo.status === "abandoned" ? "\u274C" : "\u26A0\uFE0F",
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: todo.title }),
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { color: "#888" }, children: `[${todo.kind}]` }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { color: "#aaa", marginLeft: 6, fontSize: 11 }, children: todo.id })
					] }),
					todo.detail !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: todo.detail }),
					todo.note !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { style: { color: "#3c9" }, children: ["用户备注：", todo.note] }),
					todo.status === "pending" && runCommand !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { style: { marginTop: 4, display: "flex", gap: 6, alignItems: "center" }, children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", { type: "button", disabled: busyId !== null, onClick: () => void sendTodoFeedback(todo.id, "done"), style: buttonStyle("#3c9"), children: "\u2713 我已完成" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", { type: "button", disabled: busyId !== null, onClick: () => void sendTodoFeedback(todo.id, "abandoned"), style: buttonStyle("#999"), children: "\u2717 放弃此项" }),
						busyId === todo.id && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { color: "#e80", fontSize: 12 }, children: "发送中…" })
					] })
				] }, todo.id))
			] });
		}
		/** Shared inline style for the small todo action buttons. */
		function buttonStyle(color) {
			return { cursor: "pointer", background: "transparent", border: `1px solid ${color}`, color, borderRadius: 999, padding: "1px 10px", fontSize: 12, lineHeight: "18px" };
		}
		function TimelineView({ src, t }) {
			const checkpoints = Array.isArray(src.checkpoints) ? src.checkpoints : [];
			const factEvents = (src.facts ?? []).map((f) => ({ kind: "fact", id: f.id, parent: f.intentId, label: `[${f.kind}] ${f.detail}${f.confidence !== void 0 ? ` (${Math.round(f.confidence * 100)}%)` : ""}`, at: f.createdAt ?? 0 }));
			const findingEvents = (src.findings ?? []).map((f) => ({ kind: "finding", id: f.id, parent: f.intentId, label: `[${f.severity}] ${f.title}`, at: f.createdAt ?? 0 }));
			const intentEvents = (src.intents ?? []).map((i) => ({ kind: "intent", id: i.id, parent: null, label: `${i.status === "completed" ? "✓" : i.status === "blocked" ? "✗" : i.status === "failed" ? "!" : "·"} ${i.title}`, at: i.createdAt ?? 0 }));
			const ckEvents = checkpoints.map((c) => ({ kind: "checkpoint", id: c.id, parent: c.intentId, label: `${c.stage} · +${c.facts}f/+${c.assets}a/+${c.findings}v · ${c.summary || ""}${c.decision ? " · " + c.decision : ""}`, at: c.createdAt }));
			const observations = Array.isArray(src.observations) ? src.observations : [];
			const [expandedId, setExpandedId] = (0, react.useState)(null);
			const obsEvents = observations.map((o) => ({ kind: "observation", id: o.id, parent: o.intentId, assetId: o.assetId, respHeaders: o.respHeaders ?? "", respBodySnippet: o.respBodySnippet ?? "", label: `${o.method} ${o.path} -> ${o.httpStatus}${o.protectionSignal ? " (WAF/403/429)" : ""}${o.wafBypassed ? " (bypassed)" : ""} [${o.source}]${o.decision ? " · " + o.decision : ""}`, at: o.createdAt }));
			const events = [...intentEvents, ...factEvents, ...findingEvents, ...ckEvents, ...obsEvents].sort((a, b) => (a.at - b.at) || a.id.localeCompare(b.id));
			if (events.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: SrcView_module_css_default.empty, children: t("timeline.empty") });
			const color = (k) => k === "finding" ? "#d33" : k === "fact" ? "#39c" : k === "checkpoint" ? "#999" : k === "observation" ? "#e80" : "#3c9";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: SrcView_module_css_default.list, children: events.map((e) => {
				const expandable = e.kind === "observation" && (e.respHeaders !== "" || e.respBodySnippet !== "");
				const expanded = expandable && expandedId === e.id;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { className: SrcView_module_css_default.card, style: { borderLeft: `3px solid ${color(e.kind)}`, marginBottom: 4, padding: "6px 10px", fontSize: 13 }, onClick: expandable ? () => setExpandedId(expanded ? null : e.id) : void 0, children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [e.kind, " · ", e.id] }),
					e.parent && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { color: "#888", marginLeft: 8 }, children: `↦ ${e.parent}` }),
					expandable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { color: "#888", marginLeft: 8, fontSize: 11 }, children: expanded ? "▾ 收起详情" : "▸ 点击展开响应详情" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: expandable ? { cursor: "pointer" } : void 0, children: e.label }),
					expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						e.respHeaders !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { style: { marginTop: 4 }, children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { color: "#888", fontSize: 11 }, children: "响应头（截断至 600 字符）：" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", { style: preStyle(120), children: e.respHeaders })
						] }),
						e.respBodySnippet !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { style: { marginTop: 4 }, children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { color: "#888", fontSize: 11 }, children: `响应体片段（截断至 1200 字符，当前 ${e.respBodySnippet.length}）：` }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", { style: preStyle(200), children: e.respBodySnippet })
						] })
					] })
				] }, `${e.kind}-${e.id}`);
			}) });
		}
		/** Shared inline style for timeline detail <pre> blocks. */
		function preStyle(maxHeight) {
			return { whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))", borderRadius: 6, margin: "2px 0 0", padding: "4px 8px", fontSize: 11, lineHeight: "16px", maxHeight, overflowY: "auto" };
		}
		function SrcView({ useProjection, t }) {
			const src = useProjection("src");
			const [tab, setTab] = (0, react.useState)("explore");
			if (src === void 0 || src === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: SrcView_module_css_default.empty,
				"data-testid": "src-view",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: SrcView_module_css_default.emptyText,
					children: t("view.empty")
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: SrcView_module_css_default.root,
				"data-testid": "src-view",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: SrcView_module_css_default.card,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SrcView_module_css_default.cardTitle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: SrcView_module_css_default.target,
									children: src.goal === null ? "" : src.goal.target
								}), src.goal !== null && src.goal.objective !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SrcView_module_css_default.objective,
									children: ["目的：", src.goal.objective]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: SrcView_module_css_default.counts,
								children: t("counts", {
									intents: src.counts.intents,
									facts: src.counts.facts,
									findings: src.counts.findings,
									assets: src.counts.assets,
									checkpoints: src.counts.checkpoints ?? 0,
									observations: src.counts.observations ?? 0,
									userTodos: (src.userTodos ?? []).filter((row) => row.status === "pending").length
								})
							}),
							src.apiDiscovery && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: SrcView_module_css_default.counts,
								children: ["API 发现：", src.apiDiscovery.total ?? 0, " · schema ", src.apiDiscovery.schemas ?? 0, " · GraphQL ", src.apiDiscovery.graphql ?? 0, " · hint ", src.apiDiscovery.hints ?? 0, " · 未推进 ", src.apiDiscovery.untouched ?? 0]
							}),
							src.goal !== null && src.goal.authorization !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: SrcView_module_css_default.authorization,
								children: ["授权：", src.goal.authorization]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("nav", {
						className: SrcView_module_css_default.tabs,
						"data-testid": "src-tabs",
						children: TABS.map((tabKey) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: SrcView_module_css_default.tab,
							"aria-pressed": tab === tabKey,
							"data-testid": `src-tab-${tabKey}`,
							onClick: () => {
								setTab(tabKey);
							},
							children: [
								t(TAB_LABELS[tabKey]),
								tabKey === "findings" ? ` (${src.counts.findings})` : "",
								tabKey === "assets" ? ` (${src.counts.assets})` : "",
								tabKey === "timeline" ? ` (${(src.checkpoints?.length ?? 0) + (src.facts?.length ?? 0) + (src.findings?.length ?? 0) + (src.observations?.length ?? 0)})` : "",
							tabKey === "todos" ? (() => { const pending = (src.userTodos ?? []).filter((row) => row.status === "pending").length; return pending > 0 ? ` (${pending} 待处理)` : ""; })() : ""
							]
						}, tabKey))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: SrcView_module_css_default.content,
						children: [
							tab === "explore" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExploreView, {
								src,
								t
							}),
							tab === "findings" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FindingsView, {
								src,
								t
							}),
							tab === "assets" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AssetsView, {
								src,
								t
							}),
							tab === "timeline" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TimelineView, { src, t }),
						tab === "todos" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TodoListView, { src, t, runCommand }),
							tab === "report" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReportView, {
								src,
								t
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** `src` namespace dictionaries. */
		/** Dictionary namespace owned by this plugin. */
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"counts": "意图 {intents} · 事实 {facts} · 漏洞 {findings} · 资产 {assets} · 检查点 {checkpoints} · 探测 {observations} · 待处理待办 {userTodos}",
			"view.tab.explore": "探索链路",
			"view.tab.findings": "漏洞",
			"view.tab.assets": "资产",
			"view.tab.timeline": "时间线",
			"view.tab.todos": "待办",
			"view.tab.report": "报告",
			"view.src": "渗透",
			"view.empty": "当前会话还没有SRC 漏洞挖掘记录。在「SRC 专业模式」预设下发送目标与目的后，这里会显示探索链路。",
			"explore.empty": "探索链路为空。先调用 src_add_goal 记录目标与目的。",
			"findings.empty": "暂无漏洞记录",
			"assets.empty": "暂无资产记录",
			"timeline.empty": "暂无事件记录（探索链路、子 Agent 检查点、事实与漏洞会按时间线排列）",
			"assets.mode.list": "列表",
			"assets.mode.graph": "图",
			"report.title": "SRC 漏洞挖掘报告",
			"report.hint": "报告基于当前会话记录实时生成",
			"report.copy": "复制",
			"report.copied": "已复制",
			"report.copyFailed": "复制失败，请手动选择报告内容复制",
			"report.download": "保存 .md",
			"report.target": "目标",
			"report.objective": "目的",
			"report.authorization": "授权",
			"report.chain": "探索链路",
			"report.findings": "漏洞发现",
			"report.assets": "资产",
			"report.checkpoints": "子 Agent 检查点",
			"report.description": "描述",
			"report.domain": "域名",
			"report.fullUrl": "完整 URL",
			"report.dataPacket": "数据包（raw POC，含接口地址）",
			"report.screenshot": "证明截图说明",
			"report.screenshotHint": "以上每条 POC 证据均为可直接复现的原始请求/响应文本，截图时按可复现步骤逐步执行并截取响应即可",
			"report.none": "（无）",
			"report.unlinked": "（未关联）",
			"report.undeclared": "（未声明）",
			"report.chainEmpty": "（仅目标，尚未展开）",
			"report.uninitialized": "（未初始化：尚未调用 src_add_goal。）",
			"finding.affected": "影响资产",
			"finding.steps": "可复现步骤",
			"finding.impact": "危害",
			"finding.scope": "影响范围",
			"finding.remediation": "修复建议",
			"finding.evidence": "POC 证据",
			"kind.goal": "目标",
			"kind.intent": "意图",
			"kind.fact": "事实",
			"kind.finding": "漏洞",
			"edge.spawns": "意图链",
			"edge.yields": "产出",
			"edge.derived_from": "推导自",
			"edge.proves": "证实",
			"edge.parent": "隶属",
			"severity.critical": "严重",
			"severity.high": "高危",
			"severity.medium": "中危",
			"severity.low": "低危",
			"severity.info": "提示",
			"asset.type.root-domain": "根域名",
			"asset.type.subdomain": "子域名",
			"asset.type.ip": "IP",
			"asset.type.service": "服务",
			"asset.type.app": "App",
			"asset.type.endpoint": "端点",
			"asset.type.mini-program": "小程序",
			"asset.type.client": "客户端",
			"asset.type.firmware": "固件",
			"asset.type.ai-surface": "AI 服务面",
			"asset.type.threat-intel": "威胁情报",
			"finding.entryPoint": "前端功能点",
			"finding.discoveryPath": "漏洞接口来源",
			"finding.rawRequest": "原始请求",
			"finding.rawResponse": "原始响应"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"counts": "Intents {intents} · Facts {facts} · Findings {findings} · Assets {assets} · Checkpoints {checkpoints} · Probes {observations} · Pending todos {userTodos}",
			"view.tab.explore": "Exploration",
			"view.tab.findings": "Findings",
			"view.tab.assets": "Assets",
			"view.tab.timeline": "Timeline",
			"view.tab.report": "Report",
			"view.src": "Src",
			"view.empty": "No penetration-testing records in this session yet. Start an engagement on the SRC 专业模式 preset and the exploration chain will appear here.",
			"explore.empty": "The exploration chain is empty. Start by recording a goal with src_add_goal.",
			"findings.empty": "No findings recorded yet",
			"assets.empty": "No assets recorded yet",
			"timeline.empty": "No events recorded (exploration chain, child-agent checkpoints, facts and findings appear on the timeline)",
			"assets.mode.list": "List",
			"assets.mode.graph": "Graph",
			"report.title": "Penetration Test Report",
			"report.hint": "Generated from the current session record",
			"report.copy": "Copy",
			"report.copied": "Copied",
			"report.copyFailed": "Copy failed. Select the report content and copy it manually.",
			"report.download": "Save .md",
			"report.target": "Target",
			"report.objective": "Objective",
			"report.authorization": "Authorization",
			"report.chain": "Exploration chain",
			"report.findings": "Findings",
			"report.assets": "Assets",
			"report.checkpoints": "Child-agent checkpoints",
			"report.description": "Description",
			"report.domain": "Domain",
			"report.fullUrl": "Full URL",
			"report.dataPacket": "Data packet (raw POC with endpoint)",
			"report.screenshot": "Screenshot note",
			"report.screenshotHint": "Each POC evidence above is a reproducible raw request/response text; capture the responses while running the steps",
			"report.none": "(none)",
			"report.unlinked": "(unlinked)",
			"report.undeclared": "(undeclared)",
			"report.chainEmpty": "(goal only; not expanded)",
			"report.uninitialized": "(not initialized: src_add_goal has not been called.)",
			"finding.affected": "Affected asset",
			"finding.steps": "Reproducible steps",
			"finding.impact": "Impact",
			"finding.scope": "Affected scope",
			"finding.remediation": "Remediation",
			"finding.evidence": "POC evidence",
			"kind.goal": "Goal",
			"kind.intent": "Intent",
			"kind.fact": "Fact",
			"kind.finding": "Finding",
			"edge.spawns": "spawns",
			"edge.yields": "yields",
			"edge.derived_from": "derived from",
			"edge.proves": "proves",
			"edge.parent": "belongs to",
			"severity.critical": "Critical",
			"severity.high": "High",
			"severity.medium": "Medium",
			"severity.low": "Low",
			"severity.info": "Info",
			"asset.type.root-domain": "Root domain",
			"asset.type.subdomain": "Subdomain",
			"asset.type.ip": "IP",
			"asset.type.service": "Service",
			"asset.type.app": "App",
			"asset.type.endpoint": "Endpoint",
			"asset.type.mini-program": "Mini program",
			"asset.type.client": "Client app",
			"asset.type.firmware": "Firmware",
			"asset.type.ai-surface": "AI surface",
			"asset.type.threat-intel": "Threat intel",
			"finding.entryPoint": "Entry point",
			"finding.discoveryPath": "Discovery path",
			"finding.rawRequest": "Raw request",
			"finding.rawResponse": "Raw response"
		};
		//#endregion
		//#region src/client/index.ts
		/** The agent-preset id whose sessions carry the src capability. */
		const SRC_PRESET = "src-hunter";
		/**
		* Whether a session is composed from the src preset — the session itself
		* or any listed ancestor (subagents of a src session inherit its preset;
		* their own rows may or may not carry `agentPreset` on the wire).
		*/
		function isSrcSession(snapshot, id) {
			let cursor = id;
			const seen = /* @__PURE__ */ new Set();
			const byId = snapshot.byId;
			while (cursor !== void 0 && !seen.has(cursor)) {
				seen.add(cursor);
				const row = byId[cursor];
				if (row?.agentPreset === SRC_PRESET) return true;
				cursor = row?.parentId;
			}
			return false;
		}
		/** Required services for the view registration and its copy. */
		const inject = [
			"slots",
			"locale",
			"sessions"
		];
		/**
		* Client plugin body: the 渗透 view tab over the src projection, mounted
		* per-session (registered while the current session — or a listed ancestor —
		* carries the `src` agent preset, disposed as soon as it does not).
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-src: dictionaries");
			const t = ctx.locale.bind(NS);
			const sessions = ctx.sessions;
			ctx.slots.inject("conversation.view", () => {
				let disposeEntry;
				let sessionId;
				let sessionSrc;
				const sync = () => {
					const snapshot = sessions.list.getSnapshot();
					const current = snapshot.current;
					const src = current === void 0 ? void 0 : isSrcSession(snapshot, current);
					if (current === sessionId && src === sessionSrc) return;
					disposeEntry?.();
					disposeEntry = void 0;
					sessionId = current;
					sessionSrc = src;
					if (current === void 0 || src !== true) return;
					disposeEntry = ctx.slots.register({
						name: "conversation.view",
						id: "src",
						order: 20,
						locale: NS,
						label: () => t("view.src"),
						inject: (sessionId) => ({
							runCommand: async (line) => {
								const outcome = await ctx.remote.commands.execute(sessionId, line, []);
								if (!outcome.ok) throw new Error(`command execute failed: ${outcome.error?.code ?? "?"}: ${outcome.error?.message ?? "transport error"}`);
								return outcome.value === void 0 ? { kind: "error", text: `unknown or malformed command: ${line}` } : outcome.value.result;
							}
						})
					}, SrcView);
				};
				sync();
				const offList = sessions.list.subscribe(sync);
				return () => {
					offList();
					disposeEntry?.();
				};
			});
		}
		//#endregion
		

// ==== 渲染测试 ====
const mockSrc = (todos) => ({
  goal: { id:"goal-1", target:"https://x.test", objective:"测试", authorization:"SRC-1" },
  counts: { intents:1, facts:2, findings:0, assets:3, checkpoints:1, observations:2 },
  apiDiscovery: { total:5, schemas:1, graphql:0, hints:2, untouched:4 },
  userTodos: todos,
  intents: [{ id:"intent-1", kind:"intent", title:"探测", detail:"d", status:"running", createdAt:1 }],
  facts: [], findings: [], checkpoints: [],
  observations: [
    { id:"obs-1", intentId:"intent-1", method:"GET", path:"/admin", httpStatus:403,
      protectionSignal:true, wafBypassed:false, source:"scan", decision:"waf-blocked",
      respHeaders:"Server: nginx\nContent-Type: text/html", respBodySnippet:"<html>blocked</html>", createdAt:100 },
    { id:"obs-2", intentId:"intent-1", method:"GET", path:"/ok", httpStatus:200,
      protectionSignal:false, wafBypassed:false, source:"har", decision:"", createdAt:101 }
  ]
});
const pendingTodos = [{ id:"todo-1", kind:"auth-session", title:"登录态采集", detail:"用账号A登录", status:"pending", note:"", createdAt:10 }];
const runCommand = async (line) => ({ kind: "success", text: "ok:"+line });

const results = {};
for (const name of ["TodoListView","TimelineView"]) {
  try {
    const html = renderToString(React.createElement(eval(name), { src: mockSrc(pendingTodos), t }));
    results[name] = "OK len=" + html.length + (html.includes("我已完成") ? " 含按钮" : "") + (name==="TimelineView" && html.includes("点击展开") ? " 含展开提示" : "");
  } catch (e) { results[name] = "CRASH: " + (e && e.stack || e); }
}
console.log(JSON.stringify(results, null, 2));
