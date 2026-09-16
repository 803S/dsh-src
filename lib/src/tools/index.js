// Registration adapter for all 45 SRC tools.
// Dependencies are injected by the composition root to keep this module from importing domain/projection internals.
// [Phase 1] 例外：telemetry 是观测旁路叶子模块（只依赖 flags/budget/sink，不碰 domain/projection），直接 import。
// [Phase 2] 例外：flags 同为无依赖叶子（只读 env），src_state 视图版本开关直接 import。
import { createDefaultTelemetry } from "../telemetry/events.js";
/* [Phase 3] 例外：orchestrator shadow 纯函数（只依赖自家兄弟模块，不碰 domain/projection/store），直接 import。 */
import { computeSuggestions } from "../orchestrator/scheduler.js";
import { srcStateVersionFlag, srcOrchestratorFlag, srcEventStoreFlag, srcSurveyFlag } from "../flags.js";
/* [local.77 §10] 例外：assertStoreProjectionConsistency 是无 IO 纯函数（五条一致性断言，§10.3），直接 import。 */
import { assertStoreProjectionConsistency } from "../event-store.js";
/* [local.81 Phase 7] 例外：survey.js 为纯函数叶子（只依赖 flags），种子闭环判定/存活分类/模式判定/FOFA 均直接 import。 */
import { hostOf as surveyHostOf, seedClosureStatus, classifyProbeResponse, surveyModeOf, fofaSearch, crtNameSearch, certspotterSearch, fofaKey } from "../survey.js";

/* [local.62] src_record_lesson 触发器声明解析：逗号分隔字符串 → 数组（写入 lesson-meta.triggers），
 * 任一参数缺省/为空返回 {}（不污染 meta）。项数上限 8、单项 ≤40 字符，防滥用。 */
function parseTriggerList(tools, keywords) {
	const split = (v) => String(v ?? "").split(/[,，、;；\s]+/).map((s) => s.trim()).filter((s) => s !== "").slice(0, 8).map((s) => s.slice(0, 40));
	const t = split(tools);
	const k = split(keywords);
	const out = {};
	if (t.length > 0) out.tools = t;
	if (k.length > 0) out.keywords = k;
	return out;
}

export function createRegisterSrcTools(dependencies) {
	const {
		defineTool, SessionId, dns, fsPromises, fsSync, nodePath, nodeOs, fileURLToPath, pathToFileURL, childProcessSpawn, httpCreateServer,
		assetGrantHosts, assetGrantHostsFor, hostCoveredByAssets, parseGoalHost, isPlausiblePublicHost, str, dshHomeOf, readCapsManifest, capsWiredIds,
		capabilityCommand, runCapabilityProcess, runChildWithTimeout, SRC_INFRA_KEYS, SRC_INFRA_LABELS, isProxyUrl, makeHttpFetch, htmlToText,
		SRC_AUTH_REQUEST_BUDGET, closeProofServer, liveProofServers, lanIPv4, recoveryAttempts, sessionIdOf, parentSessionIdOf, visibleSessionIds,
		resolveEngagementSession, requiredString, concreteIntentId, optionalString, submissionList, stringList, enumValue, stableBatchKey,
		confidenceValue, titledCard, FACT_KINDS, SEVERITIES, ASSET_TYPES, BYPASS_CATEGORIES, BYPASS_METHODS, buildGraph, buildReport,
		classifyHttpRequest, lessonsDataDir, listAllLessons, lessonIndexLines, readLessonFile, sessionLessons, lessonsForContext, lessonHintLines, appendObservationProjection,
		routePlaybookV2, commitSyntheticMutation, appendSyntheticEvents, syntheticEvent, appendSessionToolEvent, appendSubmissionProjection,
		credentialVaultDir, writeCredential, readCredential, credentialHeaders, redactCredential, redactText, stripCredentialHeaders, CREDENTIAL_HEADER_RE, describeHttpBody,
		addApprovalLock, removeApprovalLock
	} = dependencies;
	return function registerSrcTools(ctx, store) {
	/* [Phase 1 telemetry] 观测旁路发射器（优化手册 2026-09-12 §5）：fire-and-forget，任何失败
	 * 不影响工具路径（events.js emit 内部吞错，这里再兜一层）。行结构见 lib/src/telemetry/events.js，
	 * payload 上限 4KB（budgetEvent 截断）。engagementId 缺省时惰性解析 goal 会话；解析失败回退 sessionId。 */
	const telemetry = createDefaultTelemetry();
	const tel = (exec, event, payload = {}, engagementId) => {
		try {
			const sessionId = sessionIdOf(exec);
			if (engagementId !== void 0) {
				telemetry.emit(event, { sessionId, engagementId }, payload);
				return;
			}
			resolveEngagementSession(store, ctx, exec).then(
				(engagement) => telemetry.emit(event, { sessionId, engagementId: engagement }, payload),
				() => telemetry.emit(event, { sessionId }, payload)
			).catch(() => {});
		} catch {}
	};
	ctx.tools.register(defineTool({
		name: "src_scan_surface",
		description: "Run a bounded authorized HTTP surface scan for the SRC recon role. This performs only low-impact GET requests and returns normalized status/title/content-type/path hints; it never writes findings or stores response bodies.",
		parameters: {
			baseUrl: { type: "string", required: true, description: "Authorized target URL or host." },
			paths: { type: "array", required: true, description: "Explicit small path list; maximum 100 paths (low-impact bounded scan).", items: { type: "string" } },
			concurrency: { type: "number", description: "1..32, default 8. Automatically reduced when protection is detected." },
			rps: { type: "number", description: "Requests per second, 1..10, default 4. Scanning stops on rate-limit signals." },
			forceAfterPreflight: { type: "boolean", description: "Only use after explicit commander decision; never bypasses WAF automatically." },
			timeoutMs: { type: "number", description: "Request timeout, 1000..15000, default 5000." }
		},
		/* [local.68 #20] 同域多后端注脚：分簇数据与注脚随输出体返回（additionalProperties 已开放），命中时在渲染行后追加。 */
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Scanned ${v.requested} paths: ${v.responses} responses, ${v.hints} interface hints.${v.multiBackendNote === void 0 ? "" : `\n${v.multiBackendNote}`}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_scan_surface requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const base = new URL(args.baseUrl.includes("://") ? args.baseUrl : `https://${args.baseUrl}`);
			if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(target.protocol)) throw new Error("src_scan_surface supports only http/https targets");
			if (base.hostname !== target.hostname && !base.hostname.endsWith(`.${target.hostname}`) && !hostCoveredByAssets(await assetGrantHostsFor(store, engagementId ?? sessionId), base.hostname)) throw new Error("src_scan_surface target is outside the authorized goal host and not in the asset inventory (if it belongs to the target organization, register it via src_add_asset with a source note, then retry; otherwise hand it to the parent agent)");
			const paths = [...new Set((Array.isArray(args.paths) ? args.paths : []).filter((path) => typeof path === "string" && path.startsWith("/")).slice(0, 100))];
			const preflightController = new AbortController();
			const preflightTimer = setTimeout(() => preflightController.abort(), 5000);
			let preflight;
			try {
				const response = await http(new URL("/", base), { method: "GET", redirect: "manual", signal: preflightController.signal, headers: { "user-agent": "dsh-src-recon/1" } });
				const headers = [...response.headers.entries()].filter(([name]) => ["server", "via", "x-cache", "cf-ray", "x-sucuri-id", "x-cdn", "x-waf"].includes(name)).map(([name, value]) => `${name}: ${value}`);
				const text = (response.headers.get("content-type") ?? "").includes("text/html") ? (await response.text()).slice(0, 8192) : "";
				const challenge = /captcha|challenge|access denied|attention required|cloudflare|sucuri|akamai/i.test(`${headers.join(" ")} ${text}`);
				preflight = { status: response.status, headers, challenge, /* [local.32] 401=认证边界非风控，不再触发预检保护 */ protection: challenge || [403, 429].includes(response.status) };
			} catch (error) { preflight = { status: 0, headers: [], challenge: false, protection: false, error: error.name === "AbortError" ? "timeout" : "network-error" }; }
			finally { clearTimeout(preflightTimer); }
			if (preflight.protection && args.forceAfterPreflight !== true) {
				// Bounded bypass attempt: try a few UA/method variants at low rate before giving up.
				const bypassUas = ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv/127.0) Gecko/20100101 Firefox/127.0", "curl/8.4.0"];
				const bypassAttempts = [];
				let bypassed = false;
				for (const ua of bypassUas) {
					const c2 = new AbortController();
					const t2 = setTimeout(() => c2.abort(), 5000);
					try {
						const r2 = await http(new URL("/", base), { method: "GET", redirect: "manual", signal: c2.signal, headers: { "user-agent": ua, "accept": "text/html,application/xhtml+xml" } });
						const ok = r2.status < 400 && ![403, 429].includes(r2.status); /* [local.32] 401 已被 <400 排除；仅 403/429 视为未绕过 */
						bypassAttempts.push({ ua: ua.slice(0, 24), status: r2.status, ok });
						if (ok) { bypassed = true; break; }
					} catch { bypassAttempts.push({ ua: ua.slice(0, 24), status: 0, ok: false }); } finally { clearTimeout(t2); }
				}
				if (!bypassed) return { baseUrl: base.origin, requested: 0, responses: 0, hints: 0, preflight, bypassAttempted: true, bypassed: false, stopped: "protection-detected", requiresDecision: true, bypassAttempts, results: [] };
			}
			const concurrency = Math.min(32, Math.max(1, Number(args.concurrency) || 8));
			const rps = Math.min(10, Math.max(1, Number(args.rps) || 4));
			const timeoutMs = Math.min(15000, Math.max(1000, Number(args.timeoutMs) || 5000));
			const interval = 1000 / rps;
			let cursor = 0;
			let lastStart = 0;
			const results = [];
			let stopped = false;
			let protectionSignals = 0;
			let rateLimitBackoffUsed = false;
			const worker = async () => {
				while (true) {
					const index = cursor++;
					if (index >= paths.length || stopped) return;
					const now = Date.now();
					const wait = Math.max(0, lastStart + interval - now);
					if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
					lastStart = Date.now();
					const url = new URL(paths[index], base);
					if (url.hostname !== base.hostname) continue;
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), timeoutMs);
					try {
						const response = await http(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "user-agent": "dsh-src-recon/1" } });
						const contentType = response.headers.get("content-type") ?? "";
					const length = Number(response.headers.get("content-length") ?? 0) || 0;
					if (response.status === 429 && !rateLimitBackoffUsed) { rateLimitBackoffUsed = true; await new Promise((resolve) => setTimeout(resolve, 3000)); }
					else if (response.status === 429 || [403, 503].includes(response.status)) protectionSignals += 1; /* [local.32] 401 不再计入风控信号 */
					if (protectionSignals >= 2) stopped = true;
						const result = { path: url.pathname, status: response.status, contentType, length, protectionSignal: [403, 429, 503].includes(response.status) }; /* [local.32] 401=认证边界非风控 */
						/* [local.68 #20] Cookie 名抓取：服务名前缀（如 klb_session→klb）是多后端的强信号。 */
						const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
						if (setCookie.length > 0) result.cookieNames = setCookie.map((c) => c.split("=")[0]?.trim() ?? "").filter(Boolean).slice(0, 10);
						if (contentType.includes("text/html") || contentType.includes("javascript")) {
							const text = (await response.text()).slice(0, 65536);
							result.hints = [...new Set([...text.matchAll(/(?:src|href|fetch|axios(?:\.get|\.post)?)[\\s=('\"]+([^\\s'\"<>`)]+)/gi)].map((match) => match[1]).filter((value) => value.startsWith("/")))].slice(0, 100);
						}
						results.push(result);
					} catch (error) {
						results.push({ path: url.pathname, error: error.name === "AbortError" ? "timeout" : "network-error" });
					} finally { clearTimeout(timer); }
				}
			};
			await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()));
			/* [local.68 #20] 同域多后端侦察：对照报告实证（顺丰 baggageservice 面 9 条发现全在「同域另一个应用」），
			 * 前缀分簇 + chunk/Cookie 服务名线索让多后端面结构化显形——顺丰会话只测了 /hkhub_attend/*，
			 * /api/* 面踩都没踩。≥2 个陌生前缀簇时注脚提示逐簇登记 asset 并扫描其前端，复用 assetGaps 注脚机制。 */
			const prefixClusters = /* @__PURE__ */ new Map();
			for (const result of results) {
				const segments = String(result.path ?? "/").split("/").filter(Boolean);
				const prefix = "/" + (segments[0] ?? "");
				const cluster = prefixClusters.get(prefix) ?? { paths: 0, hints: 0, crossPrefixHints: /* @__PURE__ */ new Set(), cookieServices: /* @__PURE__ */ new Set() };
				cluster.paths += 1;
				cluster.hints += result.hints?.length ?? 0;
				for (const h of result.hints ?? []) {
					const seg = h.split("/").filter(Boolean);
					if (seg.length > 0 && "/" + seg[0] !== prefix) cluster.crossPrefixHints.add("/" + seg[0]);
				}
				for (const name of result.cookieNames ?? []) {
					const m = /^([a-z][a-z0-9]{1,15})[-_]/i.exec(name);
					if (m) cluster.cookieServices.add(m[1].toLowerCase());
				}
				prefixClusters.set(prefix, cluster);
			}
			const clusters = [...prefixClusters.entries()].map(([prefix, c]) => ({ prefix, paths: c.paths, hints: c.hints, ...(c.crossPrefixHints.size > 0 ? { crossPrefixHints: [...c.crossPrefixHints].slice(0, 8) } : {}), ...(c.cookieServices.size > 0 ? { cookieServices: [...c.cookieServices].slice(0, 8) } : {}) })).sort((a, b) => b.paths - a.paths);
			const cookieServices = [...new Set(clusters.flatMap((c) => c.cookieServices ?? []))];
			const multiBackendNote = clusters.filter((c) => c.prefix !== "/").length >= 2 || cookieServices.length >= 2
				? ` 同域疑似多后端：URL 前缀簇 ${clusters.map((c) => `${c.prefix}(路径×${c.paths},提示×${c.hints}${(c.crossPrefixHints ?? []).length ? `,chunk 提及 ${(c.crossPrefixHints).join("/")}` : ""}${(c.cookieServices ?? []).length ? `,Cookie 服务名 ${(c.cookieServices).join("/")}` : ""})`).join("、")}${cookieServices.length >= 2 ? `；Cookie 服务名前缀 ${cookieServices.join("/")}（多后端强信号）` : ""}——逐簇登记 asset（src_add_asset type=endpoint）并各自扫描其前端，别只测一个前缀。`
				: "";
			/* [local.12] never emit undefined-valued properties: tool outputs must survive lossless JSON snapshotting. */
			return { baseUrl: base.origin, requested: paths.length, responses: results.filter((result) => result.status !== void 0).length, hints: results.reduce((count, result) => count + (result.hints?.length ?? 0), 0), preflight, ...(stopped ? { stopped: "protection-signal" } : {}), requiresDecision: stopped, results, prefixClusters: clusters, ...(multiBackendNote !== "" ? { multiBackendNote } : {}) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_test_bypass",
		description: "local.67] Verify a broken-access-control / bypass hypothesis with a bounded baseline→variant comparison. Requires an initialized goal, an existing src_record_research hypothesis, and an in-scope asset URL. Runs a small, explicit variant list against a baseline and reports a reproducible boundary differential if the authentication/authorization outcome changes. 类别枚举（本工具是协议 bypass 节的唯一家）：authentication-bypass、authorization-bypass、idor-bola、tenant-isolation、workflow-bypass、method-bypass、path-normalization、parser-discrepancy、rate-limit-bypass、cache-auth-boundary、waf-rule-gap、oauth-flow-bypass。有界语义：仅目标 host/subdomain 内；GET/HEAD/OPTIONS（POST 需显式 allowBody）；低 RPS；遇 WAF/403/429/challenge 停（指挥官可显式放行继续）；不存响应体；不自动建 finding——仅凭 403→200 或改 header 得 200 不算漏洞，边界差分≠影响证明，指挥官记录 impact/授权证明并把 research 推 verified 后才可进报告。禁止代理池轮换、无限重试和隐蔽大规模扫描。",
		parameters: {
			intentId: { type: "string", required: true, description: "Existing research intent id." },
			researchId: { type: "string", required: true, description: "Existing src_record_research record id this run maps to." },
			category: { type: "string", required: true, enum: BYPASS_CATEGORIES, description: "Bypass vulnerability class." },
			baseUrl: { type: "string", required: true, description: "Authorized target URL or host." },
			baseline: { type: "object", additionalProperties: false, required: true, description: "Baseline request that establishes the current authorization outcome.", properties: { method: { type: "string", enum: ["GET", "HEAD", "OPTIONS"] }, path: { type: "string", required: true }, headers: { type: "object", additionalProperties: true, description: "Optional headers to keep identical; bounded to 8 by the executor." } } },
			variants: { type: "array", required: true, description: "Explicit variants to compare against the baseline, max 10.", items: { type: "object", additionalProperties: false, properties: { method: { type: "string", enum: BYPASS_METHODS }, path: { type: "string", required: true }, headers: { type: "object", additionalProperties: true, description: "Headers to vary; bounded to 8 by the executor." }, rawBody: { type: "string" }, allowBody: { type: "boolean" }, note: { type: "string" } } } },
			rps: { type: "number", description: "Requests per second, 1..5, default 1." },
			forceAfterProtection: { type: "boolean", description: "Only use after explicit commander decision (a confirmed scope and a tracked hypothesis are already required)." }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Bypass hypothesis ${v.researchId}: ${v.differential ? "boundary differential reproduced" : "no differential"}; tested ${v.results.length} variants.${v.lessonHints === void 0 ? "" : `\n${v.lessonHints.join("\n")}`}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_test_bypass requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(engagementId ?? sessionId, "intents", intentId, "intent");
			const researchId = concreteIntentId(requiredString(args.researchId, "researchId"));
			await store.requireRef(engagementId ?? sessionId, "research", researchId, "research");
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const base = new URL(args.baseUrl.includes("://") ? args.baseUrl : `https://${args.baseUrl}`);
			if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(target.protocol)) throw new Error("src_test_bypass supports only http/https targets");
			if (base.hostname !== target.hostname && !base.hostname.endsWith(`.${target.hostname}`) && !hostCoveredByAssets(await assetGrantHostsFor(store, engagementId ?? sessionId), base.hostname)) throw new Error("src_test_bypass target is outside the authorized goal host and not in the asset inventory (if it belongs to the target organization, register it via src_add_asset with a source note, then retry; otherwise hand it to the parent agent)");
			const category = enumValue(args.category, BYPASS_CATEGORIES, "authorization-bypass", "category");
			const baselineInput = args.baseline;
			const variantInputs = (Array.isArray(args.variants) ? args.variants : []).filter((v) => v && typeof v === "object").slice(0, 10);
			if (variantInputs.length === 0) throw new Error("src_test_bypass requires at least one variant");
			const rps = Math.min(5, Math.max(1, Number(args.rps) || 1));
			const interval = 1000 / rps;
			const timeoutMs = 10000;
			const total = variantInputs.length + 1;
			const results = [];
			let requiresDecision = false;
			const normalized = (req) => {
				const method = typeof req.method === "string" && BYPASS_METHODS.includes(req.method.toUpperCase()) ? req.method.toUpperCase() : "GET";
				const headers = {};
				if (req.headers && typeof req.headers === "object") for (const [key, value] of Object.entries(req.headers)) { if (Object.keys(headers).length >= 8) break; if (typeof key === "string" && typeof value === "string") headers[key] = value; }
				let body = void 0;
				if (method === "POST" && req.allowBody === true && typeof req.rawBody === "string") body = req.rawBody.slice(0, 4096);
				return { method, path: typeof req.path === "string" && req.path.startsWith("/") ? req.path : "/", headers, body, note: typeof req.note === "string" ? req.note : "" };
			};
			const requests = [{ ...normalized(baselineInput), phase: "baseline" }, ...variantInputs.map((v, i) => ({ ...normalized(v), phase: `variant-${i + 1}` }))];
			const runOne = async (req) => {
				const url = new URL(req.path, base);
				if (url.hostname !== base.hostname) return { ...req, error: "off-host", skipped: true };
				/* [local.23] 认证态流量独立计数：带 Authorization/Cookie 的请求进独立预算（防锁号 + 防被风控画像）。 */
				const isAuthed = Object.keys(req.headers ?? {}).some((name) => { const l = name.toLowerCase(); return l === "authorization" || l === "cookie"; });
				let authBudgetUsed = void 0;
				if (isAuthed) authBudgetUsed = store.countAuthRequest(sessionId, 1);
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeoutMs);
				try {
					const defaultContentType = req.method === "POST" && !Object.keys(req.headers ?? {}).some((name) => name.toLowerCase() === "content-type") ? { "content-type": "application/x-www-form-urlencoded" } : {};
					const response = await http(url, { method: req.method, redirect: "manual", signal: controller.signal, headers: { "user-agent": "dsh-src/1", ...defaultContentType, ...req.headers }, body: req.body === void 0 || typeof req.body !== "string" ? void 0 : req.body });
					const contentType = response.headers.get("content-type") ?? "";
					const length = Number(response.headers.get("content-length") ?? 0) || 0;
					const loc = response.status >= 300 && response.status < 400 ? response.headers.get("location") ?? "" : "";
					const protection = [403, 429, 503].includes(response.status) || /captcha|challenge|access denied|attention required|cloudflare|sucuri|akamai/i.test((response.headers.get("server") ?? "") + " " + (response.headers.get("via") ?? ""));
					return { ...req, status: response.status, contentType, length, redirect: loc, protection, ...(isAuthed ? { authed: true, authBudgetUsed } : {}) };
				} catch (error) {
					const { status: _droppedStatus, ...reqRest } = req;
					return { ...reqRest, error: error.name === "AbortError" ? "timeout" : "network-error" };
				} finally { clearTimeout(timer); }
			};
			let lastStart = 0;
			for (const req of requests) {
				const wait = Math.max(0, lastStart + interval - Date.now());
				if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
				lastStart = Date.now();
				const result = await runOne(req);
				// Normalize baseline protection for differential comparison later; never auto-bypass.
				if (result.phase !== "baseline" && result.protection && args.forceAfterProtection !== true) { requiresDecision = true; results.push(result); break; }
				results.push(result);
			}
			const baselineR = results.find((r) => r.phase === "baseline");
			const baselineAllowed = !!(baselineR && baselineR.status !== void 0 && baselineR.status < 400 && baselineR.status !== 403);
			const differential = results.filter((r) => r.phase !== "baseline" && r.status !== void 0).find((r) => {
				const allowed = r.status < 400 && r.status !== 403;
				return allowed !== baselineAllowed && r.protection !== true;
			}) !== void 0;
			/* [local.23] 认证预算/401 连发检查。预算为软信号：触顶不报错，提示剩余矩阵格转待办。 */
			const authBudgetUsed = results.filter((r) => r.authed === true).reduce((acc, r) => Math.max(acc, r.authBudgetUsed ?? 0), 0);
			const authBudgetExhausted = authBudgetUsed >= SRC_AUTH_REQUEST_BUDGET;
			/* 401 连发：本次运行中认证请求连续返回 401 ≥3 → 会话可能失效，转「重新登录」待办模板。 */
			const authed401Streak = (() => {
				let streak = 0; let max = 0;
				for (const r of results) {
					if (r.authed === true && r.status === 401) { streak += 1; max = Math.max(max, streak); }
					else if (r.authed === true) streak = 0;
				}
				return max;
			})();
			const sessionLikelyExpired = authed401Streak >= 3;
			const evidence = [`${category}|${intentId}|baseline=${baselineR?.status ?? "err"}|differential=${differential ? "yes" : "no"}|requiresDecision=${requiresDecision ? "yes" : "no"}`, ...results.map((r) => `${r.phase}|${r.method}|${r.path}|${r.status ?? r.error}|${r.protection ? "protection" : "ok"}`)];
			// Fold the run into the tracked research record so verification stays durable and linked.
			const researchRow = (await store.sessionData(sessionId)).research.find((row) => row.id === researchId);
			if (researchRow !== void 0) await store.upsertResearch(sessionId, {
				intentId, category: researchRow.category, hypothesis: researchRow.hypothesis, preconditions: researchRow.preconditions,
				status: researchRow.status === "hypothesis" ? "testing" : researchRow.status, stopReason: researchRow.stopReason,
				evidence: [...researchRow.evidence, ...evidence], ...researchRow.findingId !== void 0 ? { findingId: researchRow.findingId } : {}
			});
			/* [local.33] 认证预算可视化：本次发出过认证请求就把权威计数推给投影（UI 头部「认证 used/limit」格）。 */
			if (authBudgetUsed > 0 && exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_auth_budget", { used: authBudgetUsed, limit: SRC_AUTH_REQUEST_BUDGET });
			/* [local.62] 决策点注入：按 bypass 类别匹配经验触发器（categories 字段），命中即推送。 */
			let bypassLessonHints;
			try { bypassLessonHints = lessonHintLines(await lessonsForContext({ tool: "src_test_bypass", category })); } catch {}
			const bypassHintsSpread = bypassLessonHints !== void 0 && bypassLessonHints.length > 0 ? { lessonHints: bypassLessonHints } : {};
			if (requiresDecision && args.forceAfterProtection !== true) {
				await store.upsertCoverage(sessionId, { assetId: args.assetId && typeof args.assetId === "string" ? args.assetId : void 0, phase: category, category: "bypass-verification", status: "blocked", evidence, limitation: "protection/waf/rate-limit signal; commander decision required" });
				return { researchId: args.researchId, category, differential: false, requiresDecision: true, results, ...bypassHintsSpread, ...(sessionLikelyExpired ? { sessionLikelyExpired: true } : {}), ...(authBudgetExhausted ? { authBudgetExhausted: true, authBudgetUsed, authBudgetLimit: SRC_AUTH_REQUEST_BUDGET } : {}) };
			}
			await store.upsertCoverage(sessionId, { assetId: args.assetId && typeof args.assetId === "string" ? args.assetId : void 0, phase: category, category: "bypass-verification", /* [local.47] 无论有无差分都记 completed：必要方向是否适用由调用前判断，bypass 打不出来只是没测出漏洞 */
				status: "completed", evidence, limitation: "" });
			return { researchId: args.researchId, category, differential, requiresDecision: false, results, ...bypassHintsSpread, ...(sessionLikelyExpired ? { sessionLikelyExpired: true } : {}), ...(authBudgetExhausted ? { authBudgetExhausted: true, authBudgetUsed, authBudgetLimit: SRC_AUTH_REQUEST_BUDGET } : {}) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_test_credential",
		description: "对登录接口做有界凭据验证（小并发爆破/泄露凭据复现）。仅限公开密码规则/默认凭据/泄露凭证场景：最多 50 次尝试、RPS≤0.5、遇不可绕验证码即停。成功命中即构成弱口令/任意用户接管 finding 证据（仍需独立复核）；失败记 fact。不做无界字典爆破、不横向尝试其他账号。",
		parameters: {
			intentId: { type: "string", required: true, description: "现有研究 intent id。" },
			loginUrl: { type: "string", required: true, description: "授权目标登录/认证接口 URL（须在 goal host 内）。" },
			username: { type: "string", required: true, description: "目标账号（来自泄露凭据/公开样本/默认规则）。" },
			candidates: { type: "array", required: true, description: "候选密码列表（来源：公开密码规则如 Lzit@身份证后8位、默认凭据、泄露凭证），最多 50 条。", items: { type: "string" } },
			rps: { type: "number", description: "每秒请求数，0.1..0.5，默认 0.5。" },
			dictionarySource: { type: "string", required: true, description: "字典来源说明（密码规则/默认凭据/泄露凭证出处），写入证据。" },
			authProfileId: { type: "string", description: "可选：已导入认证画像 id（带验证码会话）。" },
			captchaBypassNote: { type: "string", description: "若登录需验证码：填写已验证的验证码可绕依据（如 4 位无滑块/滑块可绕，~30 次遍历计划）；未验证则遇验证码即停。" },
			stopOnCaptcha: { type: "boolean", description: "默认 true：遇验证码且无法绕过时立即停止并返回 requiresDecision。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `凭据验证：${v.hit ? `命中！${v.hitUser}（${v.triedCount} 次尝试）` : `未命中（${v.triedCount ?? 0} 次尝试）`}${v.requiresDecision ? "; 需指挥官决策" : ""}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_test_credential requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(engagementId ?? sessionId, "intents", intentId, "intent");
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const login = new URL(args.loginUrl.includes("://") ? args.loginUrl : `https://${args.loginUrl}`);
			if (!/^https?:$/.test(login.protocol)) throw new Error("src_test_credential supports only http/https targets");
			if (login.hostname !== target.hostname && !login.hostname.endsWith(`.${target.hostname}`) && !hostCoveredByAssets(await assetGrantHostsFor(store, engagementId ?? sessionId), login.hostname)) throw new Error("src_test_credential target is outside the authorized goal host and not in the asset inventory (if it belongs to the target organization, register it via src_add_asset with a source note, then retry; otherwise hand it to the parent agent)");
			const username = requiredString(args.username, "username");
			const candidates = (Array.isArray(args.candidates) ? args.candidates : []).filter((c) => typeof c === "string" && c.length > 0).slice(0, 50);
			if (candidates.length === 0) throw new Error("src_test_credential requires at least one candidate");
			const rps = Math.min(0.5, Math.max(0.1, Number(args.rps) || 0.5));
			const interval = 1000 / rps;
			const dictionarySource = requiredString(args.dictionarySource, "dictionarySource");
			const stopOnCaptcha = args.stopOnCaptcha !== false;
			const results = [];
			let hit = false;
			let hitCredential = "";
			let requiresDecision = false;
			let stopReason = "";
			let lastStart = 0;
			for (const candidate of candidates) {
				const wait = Math.max(0, lastStart + interval - Date.now());
					if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
				lastStart = Date.now();
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 10000);
				try {
					const body = new URLSearchParams({ username, password: candidate }).toString();
					const response = await http(login, { method: "POST", redirect: "manual", signal: controller.signal, headers: { "user-agent": "dsh-src/1", "content-type": "application/x-www-form-urlencoded" }, body });
					const text = (await response.text()).slice(0, 4096);
					// 验证码/滑块检测：页面或响应含验证码特征且未声明可绕 → 停
					if (stopOnCaptcha && args.captchaBypassNote === void 0 && /captcha|验证码|slider|滑块|geetest/i.test(text)) {
							requiresDecision = true; stopReason = "captcha-detected-unverifiable"; results.push({ credential: "***", status: response.status, captcha: true }); break;
						}
					// 命中判定：302/200 且响应不含失败特征
					const failPattern = /(密码错误|账号或密码|用户名或密码|login.*(fail|error)|invalid|incorrect|失败)/i;
					const looksHit = [200, 302].includes(response.status) && !failPattern.test(text);
					results.push({ credential: candidate.slice(0, 2) + "***", status: response.status, hit: looksHit });
					if (looksHit) { hit = true; hitCredential = candidate; break; }
					if ([403, 429, 503].includes(response.status)) { requiresDecision = true; stopReason = "protection-signal"; break; } /* [local.32] 401=凭据被拒（JSON 登录的正常未命中），继续跑完字典 */
				} catch (error) {
					results.push({ credential: candidate.slice(0, 2) + "***", error: error.name === "AbortError" ? "timeout" : "network-error" });
				} finally { clearTimeout(timer); }
			}
			/* [local.54] 命中凭据入凭证库（可后续作 testAccount 复用），evidence 只留引用不落明文。 */
			let hitRefSuffix = "";
			if (hit && hitCredential !== "") {
				try {
					const written = await writeCredential({ dshHome: dshHomeOf(), sessionId, label: `credential-hit-${username}`, credential: hitCredential, note: `src_test_credential 命中：${login.host}${login.pathname}（来源：${dictionarySource}）` });
					await store.upsertTestAccount(sessionId, { label: `命中账号-${username}`, credentialRef: written.ref, note: `src_test_credential 字典命中（${dictionarySource}），登录 ${login.host}${login.pathname}` });
					hitRefSuffix = `|hitCredentialRef=${written.ref}`;
				} catch { hitRefSuffix = "|hitCredentialRef=(vault-write-failed)"; }
			}
			const evidence = [`credential-test|${intentId}|${login.hostname}${login.pathname}|user=${username}|source=${dictionarySource}|tried=${results.length}|hit=${hit}${hitRefSuffix}|requiresDecision=${requiresDecision ? "yes" : "no"}${stopReason ? "|stop=" + stopReason : ""}`, ...results.map((r) => `${r.credential}|${r.status ?? r.error}|${r.hit ? "hit" : r.captcha ? "captcha" : "miss"}`)];
			// 命中即记 fact（凭据证据不落明文到 fact 正文，仅记录命中状态与来源）
			if (hit) await store.addFact(sessionId, { intentId, kind: "vuln", target: login.origin, detail: `凭据命中：${login.host}${login.pathname} 用户 ${username}（来源：${dictionarySource}）；完整凭据已入本地凭证库（credentialRef 见 research evidence），需独立复核后升 finding`, confidence: 0.9 });
			const researchRow = (await store.sessionData(sessionId)).research.find((row) => row.intentId === intentId && row.category === "credential-test");
			if (researchRow !== void 0) await store.upsertResearch(sessionId, { intentId, category: "credential-test", hypothesis: researchRow.hypothesis, preconditions: researchRow.preconditions, status: hit ? "reproduced" : researchRow.status === "hypothesis" ? "testing" : researchRow.status, stopReason: researchRow.stopReason, evidence: [...researchRow.evidence, ...evidence], ...researchRow.findingId !== void 0 ? { findingId: researchRow.findingId } : {} });
			await store.upsertCoverage(sessionId, { assetId: void 0, phase: "credential-test", category: "authentication", status: hit ? "completed" : requiresDecision ? "blocked" : "completed", evidence, limitation: requiresDecision ? `${stopReason}；指挥官决策后可继续` : "" });
			return { intentId, loginUrl: login.origin + login.pathname, username, triedCount: results.length, hit, hitUser: hit ? username : "", hitCredentialRedacted: hit ? hitCredential.slice(0, 2) + "***" : "", requiresDecision, stopReason, results };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_observation",
		description: "记录一次 HTTP 主动探测或导入流量得到的观察（时间线/证据层）。每次显式请求后（或 Burp/har 导入恢复的流量）调用，使时间线能展示真实请求、防护信号与绕过结果，并连同决策理由。有界：只记状态码、响应片段(<=2000字符)、是否撞 WAF/403/429（401 是认证边界不是风控）、是否绕过尝试成功。",
		parameters: {
			intentId: { type: "string", description: "发起本次探测的 intent。" },
			assetId: { type: "string", description: "被探测的资产(endpoint/service)。" },
			method: { type: "string", description: "HTTP 方法，默认 GET。" },
			path: { type: "string", required: true, description: "观察到的请求 URL/路径。" },
			httpStatus: { type: "integer", description: "HTTP 响应状态码。" },
			respHeaders: { type: "string", description: "关键响应头(如 Server、Content-Type)。" },
			respBodySnippet: { type: "string", description: "响应体短片段。" },
			protectionSignal: { type: "boolean", description: "该响应是否为 WAF/403/429/challenge（401 是认证边界发现信号，不算风控拦截，不置真）。" },
			wafBypassed: { type: "boolean", description: "此处防护绕过尝试是否成功。" },
			source: { type: "string", enum: ["burp-mcp", "har", "raw", "manual", "scan"], description: "流量来源。" },
			decision: { type: "string", description: "本次探测后为何继续/停止/绕过。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: "observation " + v.id + " " + v.method + " " + v.path + " -> " + v.httpStatus + (v.protectionSignal ? " (protected)" : "") + (v.wafBypassed ? " (bypassed)" : "") }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const record = await store.upsertObservation(sessionId, {
				...args.intentId !== void 0 ? { intentId: args.intentId } : {},
				...args.assetId !== void 0 ? { assetId: args.assetId } : {},
				method: args.method, path: args.path, httpStatus: args.httpStatus ?? 0,
				respHeaders: args.respHeaders ?? "", respBodySnippet: (args.respBodySnippet ?? "").slice(0, 2000),
				protectionSignal: args.protectionSignal ?? false, wafBypassed: args.wafBypassed ?? false,
				source: args.source ?? "scan", decision: args.decision ?? ""
			});
			/* [Phase 1 telemetry] 观察也是证据层一行。 */
			tel(exec, "evidence.created", { evidenceType: "observation", evidenceId: record.id, intentId: args.intentId ?? "", status: record.httpStatus ?? 0, protectionSignal: record.protectionSignal === true, wafBypassed: record.wafBypassed === true });
			return record;
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_user_todo",
		description: "创建、完成或放弃用户待办——必须先由人工完成才能继续的工作（提供登录态/启用 Burp/提供资产/拍板）。创建时给 title+detail；用户反馈完成后用同一 userTodoId 将 status 改 done 附 note；pending/done 待办列在 src_state.userTodos。【铁律】待办是单点挂起不是全局暂停——建完必须立即转向其他不受阻方向继续推进，禁止因等用户停摆或 finalize。【auth-session 登录态】创建前先调 mcp__burp__get_proxy_http_history_regex(regex=目标host) 试拉一次，已有流量直接 src_import_traffic(mode=mcp) 免建待办；确需创建时 detail 引导用户走 Burp 抓包三步：①打开 Burp 并给浏览器挂上代理 ②登录目标站点 ③回面板点「已完成」；之后你拉包导入认证画像。禁止要求用户提供 HAR 文件或在对话里贴原始报文；仅 Burp MCP 确认不可用才降级 HAR 并在 detail 说明。burp-enable 类提示启动 Burp 并确认 MCP 扩展已 Start。【枚举纪律 [local.65]】枚举类工作（找小程序/App/子域/关联域名）先用自身能力做（本机微信包扫描、下载反编译、测绘、被动侦察），穷尽拿不到才挂待办，detail 写明已试手段与结果，不把本职工作外包给用户。",
		parameters: {
			userTodoId: { type: "string", description: "要更新的既有待办 id（省略则新建）。" },
			intentId: { type: "string", description: "该待办解除阻塞的 intent（可选）。" },
			title: { type: "string", description: "给用户看的简短待办标题。新建时必填；更新既有待办（传 userTodoId）时可省略，服务端保留原标题。" },
			detail: { type: "string", description: "agent 需要什么、用户如何提供。" },
			kind: { type: "string", enum: ["auth-session", "burp-enable", "asset-provide", "decision", "manual-test", "other"], description: "待办类别。" },
			status: { type: "string", enum: ["pending", "done", "abandoned"], description: "新建为 pending；用户响应后 done/abandoned。" },
			note: { type: "string", description: "用户备注/说明（自由文本）。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: "todo " + v.id + " [" + v.status + "] " + v.title }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.60] title 降可选后把「新建缺 title」的硬错误从 schema 层移到 execute 层：指导性报错而非宿主干巴 invalid arguments（同 attackPrerequisites 先例）。 */
			if (args.userTodoId === void 0 && (typeof args.title !== "string" || args.title.trim() === "")) throw new Error("src_user_todo 新建待办必须给 title（给用户看的简短标题）。只更新状态/备注时改传 userTodoId + status/note，无需 title");
			const record = await store.upsertUserTodo(sessionId, {
				...args.userTodoId !== void 0 ? { userTodoId: args.userTodoId } : {},
				...args.intentId !== void 0 ? { intentId: args.intentId } : {},
				...(typeof args.title === "string" && args.title !== "" ? { title: args.title } : {}), ...args.detail !== void 0 ? { detail: args.detail } : {},
				...args.kind !== void 0 ? { kind: args.kind } : {}, ...args.status !== void 0 ? { status: args.status } : {},
				...args.note !== void 0 ? { note: args.note } : {}
			});
			return record;
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_import_traffic",
		description: "从 Burp MCP / HAR / raw HTTP 文本导入已认证流量，解决登录态盲区与 React chunk 404（proxy history 里有完整真实流量）。三种模式：mcp=传入已用 mcp__burp__get_proxy_history 拿到的 flows 数组；har=传入 HAR JSON 字符串；raw=传入 raw HTTP 请求文本（Burp 格式）。仅导入 host 在授权 goal 内的流量；认证头(Cookie/Authorization/Token)自动存入本地凭证目录（0600）并以 auth-profile fact + testAccount 行登记引用（credentialRef），fact 只存 header 名与引用不落明文；返回 credentialRefs 供 src_http 直接引用。请求/响应落 observations(时间线)、endpoint 落 asset(candidate)。不发新请求，只解析已有流量。安全红线：只测凭据对应账户自身的越权面，不做横向扩散；凭据即用即取不批量囤积。",
		parameters: {
			intentId: { type: "string", required: true, description: "现有研究 intent id。" },
			mode: { type: "string", required: true, enum: ["mcp", "har", "raw"], description: "导入来源模式。" },
			data: { type: "string", description: "har 模式传 HAR JSON 字符串；raw 模式传 raw HTTP 文本。" },
			flows: { type: "array", description: "mcp 模式传入的流量数组，元素含 method/url/status/reqHeaders/respHeaders/body。", items: { type: "object", additionalProperties: true } },
			authProfileNote: { type: "string", description: "可选：用户声明的授权测试账号说明（落 evidence）。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: "导入流量：" + v.observations + " 条 observation，" + v.assets + " 个 endpoint asset，" + v.authFacts + " 条认证画像；跳过越界 " + v.outOfScope }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_import_traffic requires an initialized SRC goal");
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(engagementId ?? sessionId, "intents", intentId, "intent");
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const inScope = (host) => host === target.hostname || host.endsWith(`.${target.hostname}`);
			const parseFlows = [];
			const outOfScope = { count: 0 };
			if (args.mode === "mcp") {
				for (const f of Array.isArray(args.flows) ? args.flows : []) {
					try { const u = new URL(f.url); if (!inScope(u.hostname)) { outOfScope.count++; continue; } const hdrText = (h) => typeof h === "string" ? h : h !== null && typeof h === "object" ? Object.entries(h).map(([k2, v2]) => `${k2}: ${String(v2)}`).join("\n") : ""; parseFlows.push({ method: f.method || "GET", url: f.url, status: Number(f.status) || 0, reqHeaders: hdrText(f.reqHeaders), respHeaders: hdrText(f.respHeaders), body: (f.body || "").slice(0, 2000) }); } catch { outOfScope.count++; }
				}
			} else if (args.mode === "har") {
				let har;
				try { har = JSON.parse(requiredString(args.data, "data")); } catch { throw new Error("src_import_traffic: HAR JSON 解析失败"); }
				for (const entry of (har?.log?.entries ?? [])) {
					try { const u = new URL(entry.request?.url); if (!inScope(u.hostname)) { outOfScope.count++; continue; } parseFlows.push({ method: entry.request?.method || "GET", url: entry.request?.url, status: entry.response?.status || 0, reqHeaders: (entry.request?.headers ?? []).map((h) => h.name + ": " + h.value).join("\n"), respHeaders: (entry.response?.headers ?? []).map((h) => h.name + ": " + h.value).join("\n"), body: ((entry.response?.content?.text) || "").slice(0, 2000) }); } catch { outOfScope.count++; }
				}
			} else if (args.mode === "raw") {
				const text = requiredString(args.data, "data");
				const lines = text.split(/\r?\n/);
				const reqLine = lines[0] || "";
				const m = reqLine.match(/^(\S+)\s+(\S+)/);
				if (m) {
					const hostHeader = lines.find((l) => /^host:/i.test(l));
					const host = hostHeader ? hostHeader.split(":").slice(1).join(":").trim() : target.hostname;
					if (!inScope(host)) { outOfScope.count++; } else parseFlows.push({ method: m[1], url: `https://${host}${m[2]}`, status: 0, reqHeaders: lines.slice(0, 20).join("\n"), respHeaders: "", body: "" });
				}
			}
			const authFactKeys = /* @__PURE__ */ new Set();
			const importedRefs = [];
			let obsCount = 0, assetCount = 0;
			for (const f of parseFlows) {
				let url; try { url = new URL(f.url); } catch { continue; }
				await store.upsertObservation(sessionId, { intentId, method: f.method, path: url.pathname + url.search, httpStatus: f.status, respHeaders: f.respHeaders, respBodySnippet: f.body, protectionSignal: [403, 429, 503].includes(f.status), wafBypassed: false, source: args.mode === "mcp" ? "burp-mcp" : args.mode === "har" ? "har" : "raw", decision: "imported traffic" }); /* [local.32] 401 不再算风控 */
				appendObservationProjection(exec, intentId, { method: f.method, path: url.pathname + url.search, httpStatus: f.status, protectionSignal: [403, 429, 503].includes(f.status), wafBypassed: false, source: args.mode === "mcp" ? "burp-mcp" : args.mode === "har" ? "har" : "raw", decision: "imported traffic" });
				obsCount++;
				await store.addAsset(sessionId, { type: "endpoint", value: url.host + url.pathname, meta: `imported-endpoint ${f.method}`, source: args.mode, method: "passive", confidence: 0.7, status: "candidate" });
				assetCount++;
				const authHeaders = f.reqHeaders.split(/\r?\n/).filter((l) => /^(cookie|authorization|token|x-auth|x-csrf)/i.test(l));
				for (const line of authHeaders) {
					const sep = line.indexOf(":");
					if (sep < 0) continue;
					const k = line.slice(0, sep).trim().toLowerCase();
					const v = line.slice(sep + 1).trim();
					if (v === "" || authFactKeys.has(k + ":" + v.slice(0, 4))) continue;
					authFactKeys.add(k + ":" + v.slice(0, 4));
					/* [local.54] 认证头入凭证库：fact detail 只存 header 名 + credentialRef（不落明文），
					   同步登记 testAccount 行供多账号矩阵直接引用（label 可由 src_add_test_account 覆盖更新）。 */
					let refSuffix = "";
					try {
						const written = await writeCredential({ dshHome: dshHomeOf(), sessionId, label: `imported-${k}`, credential: line, note: `src_import_traffic(${args.mode}) ${url.host}${args.authProfileNote ? "；用户声明：" + args.authProfileNote : ""}` });
						await store.upsertTestAccount(sessionId, { label: `imported-${k}-${url.host}`, credentialRef: written.ref, note: `src_import_traffic(${args.mode}) 提取的认证头${args.authProfileNote ? "；用户声明：" + args.authProfileNote : ""}` });
						refSuffix = `；credentialRef=${written.ref}`;
						importedRefs.push({ label: `imported-${k}-${url.host}`, credentialRef: written.ref });
					} catch { refSuffix = "；（凭证库写入失败，未存明文）"; }
					await store.addFact(sessionId, { intentId, kind: "auth-profile", target: url.host, detail: `${k}: <已存凭证库>${refSuffix}${args.authProfileNote ? "；用户声明：" + args.authProfileNote : ""}`, confidence: 0.9 });
				}
			}
			await store.upsertCoverage(sessionId, { assetId: void 0, phase: "recon", category: "traffic-import", status: "completed", evidence: [`import ${args.mode}: ${obsCount} in-scope, ${outOfScope.count} out-of-scope`], limitation: outOfScope.count > 0 ? `${outOfScope.count} 条流量越界已跳过` : "" });
			return { mode: args.mode, observations: obsCount, assets: assetCount, authFacts: authFactKeys.size, outOfScope: outOfScope.count, credentialRefs: importedRefs };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_collect_dorks",
		description: "对授权域名做 Google/GitHub dorks 被动信息收集（五类产出：泄露凭证/敏感文件/目录结构与索引页/历史缓存与临时文件/云资产泄露）。只对 goal 授权域名生成 dork；工具尽力直接抓取 DuckDuckGo html 端点，被拦截时把查询串落 fact 并指示用 web_search 执行。发现的泄露凭证/敏感文件/泄露 URL 各落 fact 或 candidate asset，供 src_test_credential（配额豁免）与后续研究消费。红线：只对授权域名跑 dork；泄露凭据只测对应账户自身越权面，不横向。",
		parameters: {
			intentId: { type: "string", required: true, description: "现有侦察 intent id。" },
			domain: { type: "string", required: true, description: "授权目标主域（须在 goal host 范围内）。" },
			categories: { type: "array", description: "可选：限定类别（credential/sensitive-file/directory/history/cloud），默认全五类。", items: { type: "string", enum: ["credential", "sensitive-file", "directory", "history", "cloud"] } },
			fetchResults: { type: "boolean", description: "默认 true：尽力直接抓取搜索结果；false 只生成查询串落 fact。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: "dorks 收集：生成 " + v.queries + " 条查询，抓取 " + v.fetched + " 条结果，落 " + v.facts + " facts / " + v.assets + " assets" }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_collect_dorks requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(engagementId ?? sessionId, "intents", intentId, "intent");
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const domain = requiredString(args.domain, "domain").trim().toLowerCase();
			if (domain !== target.hostname && !domain.endsWith(`.${target.hostname}`) && !target.hostname.endsWith(`.${domain}`)) {
			/* [local.43] 资产清单双向覆盖：domain 在某资产下，或某资产 host 在 domain 下（对主域做 dorks 的场景）。 */
			const dorksAssetHosts = await assetGrantHostsFor(store, engagementId ?? sessionId);
			if (!dorksAssetHosts.some((a) => domain === a || domain.endsWith(`.${a}`) || a.endsWith(`.${domain}`))) throw new Error("src_collect_dorks domain is outside the authorized goal host and not in the asset inventory (register the domain via src_add_asset with a source note, then retry; otherwise hand it to the parent agent)");
		}
			const wanted = Array.isArray(args.categories) && args.categories.length > 0 ? args.categories.filter((c) => ["credential", "sensitive-file", "directory", "history", "cloud"].includes(c)) : ["credential", "sensitive-file", "directory", "history", "cloud"];
			const dorkSets = {
				"credential": [
					`site:github.com "${domain}" password`,
					`site:github.com filename:.env "${domain}"`,
					`site:gitee.com "${domain}" 密码 OR password`,
					`"${domain}" password OR 密码 filetype:env OR filetype:txt OR filetype:log`
				],
				"sensitive-file": [
					`site:${domain} filetype:bak OR filetype:sql OR filetype:zip OR filetype:tar.gz OR filetype:7z`,
					`site:${domain} inurl:config OR inurl:.env OR inurl:web.config OR inurl:settings`,
					`site:${domain} inurl:".git" OR inurl:"svn/entries" OR inurl:.DS_Store`,
					`site:${domain} inurl:swagger OR inurl:api-docs OR inurl:openapi`
				],
				"directory": [
					`site:${domain} intitle:"index of"`,
					`site:${domain} inurl:admin OR inurl:manage OR inurl:backend OR inurl:login`,
					`site:${domain} inurl:upload OR inurl:backup OR inurl:temp`
				],
				"history": [
					`site:${domain} filetype:log OR filetype:tmp`,
					`site:${domain} inurl:test OR inurl:dev OR inurl:debug OR inurl:old`
				],
				"cloud": [
					`site:${domain} "AccessKeyId" OR "SecretAccessKey" OR "x-amz"`,
					`"${domain}" bucket OR oss OR cos site:github.com`
				]
			};
			const queries = [];
			for (const category of wanted) for (const q of dorkSets[category]) queries.push({ category, q });
			let fetchedCount = 0;
			let blockedSources = 0;
			const evidence = [];
			if (args.fetchResults !== false) {
				for (const item of queries.slice(0, 6)) {
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), 6000);
					try {
						const response = await http(`https://duckduckgo.com/html/?q=${encodeURIComponent(item.q)}`, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "accept": "text/html" } });
						fetchedCount += 1;
						if (response.status !== 200) { blockedSources += 1; evidence.push(`ddg|${item.category}|${response.status}|blocked`); continue; }
						const text = (await response.text()).slice(0, 200000);
					const hits = [...text.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].slice(0, 10);
						if (hits.length === 0) { evidence.push(`ddg|${item.category}|200|no-results`); continue; }
						for (const hit of hits) {
							const href = hit[1].replace(/&amp;/g, "&");
							const title = hit[2].replace(/<[^>]+>/g, "").trim();
							await store.addFact(sessionId, { intentId, kind: "info", target: domain, detail: `dorks[${item.category}] 命中：${title} — ${href.slice(0, 300)}（查询：${item.q}）`, confidence: 0.6 });
						}
						evidence.push(`ddg|${item.category}|200|${hits.length} hits`);
					} catch (error) {
						blockedSources += 1;
						evidence.push(`ddg|${item.category}|error|${error.name === "AbortError" ? "timeout" : "network"}`);
					} finally { clearTimeout(timer); }
				}
			}
			let facts = 0;
			for (const item of queries) {
				await store.addFact(sessionId, { intentId, kind: "info", target: domain, detail: `dorks[${item.category}] 查询：${item.q}；${blockedSources > 0 ? "直接抓取被拦或部分被拦，请用 web_search 执行并回填结果" : "可直接执行或用 web_search"}`, confidence: 0.5 });
				facts += 1;
			}
			await store.upsertCoverage(sessionId, { assetId: void 0, phase: "recon", category: "dorks", status: "completed", evidence: [`dorks ${domain}: ${queries.length} queries, ${fetchedCount} fetched, ${blockedSources} blocked`, ...evidence], limitation: blockedSources > 0 ? `${blockedSources} 个来源被拦，需 web_search 补齐` : "" });
			return { domain, queries: queries.length, fetched: fetchedCount, blockedSources, facts, assets: 0, categories: wanted };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_collect_passive",
		description: "Run a bounded passive discovery pass for an authorized goal host. It fetches robots.txt, sitemap.xml, the homepage, a bounded set of same-host HTML/JS URLs, and common OpenAPI/Swagger/GraphQL metadata paths, then performs limited DNS A/CNAME lookups for in-scope hostnames. Discovered assets are normalized as candidates only; no findings are created and no response bodies are persisted.",
		parameters: {
			intentId: { type: "string", required: true, description: "Existing reconnaissance intent id." },
			baseUrl: { type: "string", required: true, description: "Authorized target URL or host." },
			hostnames: { type: "array", description: "Optional additional in-scope hostnames to resolve passively.", items: { type: "string" } },
			maxHints: { type: "number", description: "Maximum extracted URL hints to follow, default 20, cap 50." }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Passive discovery collected ${v.assets} assets and ${v.facts} facts from ${v.sources} sources.` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_collect_passive requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(engagementId ?? sessionId, "intents", intentId, "intent");
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const base = new URL(args.baseUrl.includes("://") ? args.baseUrl : `https://${args.baseUrl}`);
			if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(target.protocol)) throw new Error("src_collect_passive supports only http/https targets");
			const passiveAssetHosts = await assetGrantHostsFor(store, engagementId ?? sessionId);
			if (base.hostname !== target.hostname && !base.hostname.endsWith(`.${target.hostname}`) && !hostCoveredByAssets(passiveAssetHosts, base.hostname)) throw new Error("src_collect_passive target is outside the authorized goal host and not in the asset inventory (register it via src_add_asset with a source note, then retry; otherwise hand it to the parent agent)");
			const hostnames = [...new Set([target.hostname, base.hostname, ...((Array.isArray(args.hostnames) ? args.hostnames : []).filter((host) => typeof host === "string").map((host) => host.trim().toLowerCase()).filter((host) => host !== "" && (host === target.hostname || host.endsWith(`.${target.hostname}`) || hostCoveredByAssets(passiveAssetHosts, host))))])].slice(0, 20);
			const maxHints = Math.min(50, Math.max(0, Number(args.maxHints) || 20));
			const fetched = [];
			const facts = [];
			const assets = [];
			const signals = [];
			const apiMeta = (kind, details = {}) => `api:${kind}${Object.keys(details).length === 0 ? "" : ` ${JSON.stringify(details)}`}`;
			const normalizeEndpointHint = (hint) => {
				if (typeof hint !== "string" || hint === "") return "";
				try {
					const normalized = new URL(hint, base);
					if (normalized.origin !== base.origin) return "";
					return `${normalized.pathname}${normalized.search}`;
				} catch {
					return hint.startsWith("/") ? hint : "";
				}
			};
			const coverageSkeleton = async (assetId, assetValue, tags = []) => {
				const rows = [
					{ phase: "web", category: "authentication" },
					{ phase: "api", category: "authorization" },
					{ phase: "api", category: "idor-bola" }
				];
				if (tags.includes("graphql")) rows.push({ phase: "api", category: "graphql" });
				if (tags.includes("openapi")) rows.push({ phase: "api", category: "schema-review" });
				for (const row of rows) await store.upsertCoverage(sessionId, { assetId, phase: row.phase, category: row.category, status: "planned", evidence: [`auto-skeleton ${assetValue}`], limitation: "" });
			};
			const researchSkeleton = async (assetValue, tags = [], hints = []) => {
				const rows = [
					{ category: "authorization", hypothesis: `${assetValue} may expose authorization boundary weaknesses` },
					{ category: "idor-bola", hypothesis: `${assetValue} may accept object identifiers without proper ownership checks` }
				];
				if (tags.includes("graphql")) {
					rows.push({ category: "graphql", hypothesis: `${assetValue} GraphQL schema and operations require authorization review` });
					rows.push({ category: "authorization-bypass", hypothesis: `${assetValue} GraphQL operations may bypass field or resolver authorization` });
				}
				if (tags.includes("openapi")) rows.push({ category: "workflow-bypass", hypothesis: `${assetValue} documented API paths may expose workflow/state transition weaknesses` });
				if (hints.length > 0) rows.push({ category: "method-bypass", hypothesis: `${assetValue} paths [${hints.slice(0, 6).join(", ")}] may behave differently across HTTP methods or parameter combinations` });
				for (const row of rows) await store.upsertResearch(sessionId, { intentId, category: row.category, hypothesis: row.hypothesis, preconditions: ["authorized target", `derived from passive discovery: ${assetValue}`], status: "hypothesis", stopReason: "", evidence: [`auto-skeleton ${assetValue}`] });
			};
			const recordAsset = async (type, value, meta, source, method = "passive", confidence = .55, status = "candidate", parentId, coverageTags = []) => {
				const record = await store.addAsset(sessionId, { type, value, meta, source, method, confidence, status, ...parentId ? { parentId } : {} });
				assets.push({ id: record.nodeId, type, value, status, source });
				if (type === "endpoint") await coverageSkeleton(record.nodeId, value, coverageTags);
				return record.nodeId;
			};
			const recordFact = async (kind, targetValue, detail, confidence = .6) => {
				const record = await store.addFact(sessionId, { intentId, kind, target: targetValue, detail, confidence });
				facts.push(record.id);
			};
			const preflight = await http(new URL("/", base), { method: "GET", redirect: "manual", headers: { "user-agent": "dsh-src-passive/1" } }).catch((error) => ({ status: 0, headers: { get: () => null }, error }));
			if (preflight.status !== void 0 && [403, 429, 503].includes(preflight.status)) { /* [local.32] 401=认证边界非风控，passive 收集继续 */
				await store.upsertCoverage(sessionId, { phase: "discovery", category: "passive-collection", status: "blocked", evidence: [`preflight ${preflight.status}`], limitation: "protection detected before passive collection" });
				return { assets: 0, facts: 0, sources: 0, preflight: preflight.status, requiresDecision: true, results: [] };
			}
			const endpointParentId = await recordAsset("app", base.origin, "passive root", "passive", "passive", .7, "candidate");
			// AI 站点/大模型/威胁情报资产识别（P7/P8：发现即收录并留人工测试）
			try {
				const aiResp = await http(new URL("/", base), { method: "GET", redirect: "manual", headers: { "user-agent": "dsh-src-passive/1" } });
				const aiBody = ((aiResp.headers.get("content-type") ?? "").includes("text") ? await aiResp.text() : "").slice(0, 65536);
				// 第一层：代码信号粗筛（关键词+结构信号），命中才进入 agent 语义复核漏斗
				const aiSignals = ["openai", "anthropic", "deepseek", "qwen", "通义", "kimi", "moonshot", "gemini", "midjourney", "stable-diffusion", "chatgpt", "大模型", "llm", "智能助手", "智能客服", "ai助手", "ai 助手", "copilot", "chatbot", "completions", "embeddings", "prompt", "sk-", "gpt"];
				const tiSignals = ["fofa", "shodan", "censys", "奇安信", "qianxin", "威胁情报", "ti.aliyun", "virustotal", "微步", "情报订阅"];
				const lower = aiBody.toLowerCase();
				const aiHits = aiSignals.filter((k) => lower.includes(k));
				const tiHits = tiSignals.filter((k) => lower.includes(k));
				// 结构信号：/api/chat、/v1/completions、/api/ai 等路径特征 + SSE 流式响应头
				const aiPathSignals = /\/api\/(chat|ai|llm|completions|assistant)|\/v1\/(chat|completions|embeddings)|event-stream/i;
				const aiConfidence = aiHits.length === 0 ? (aiPathSignals.test(aiBody) ? 0.5 : 0) : Math.min(0.9, 0.5 + aiHits.length * 0.15);
				if (aiBody !== "" && aiConfidence >= 0.5) {
					// 第二层：agent 语义复核——不自动定论，落 candidate 资产+复核假设，由 audit 子 agent 拉取页面语义判断"是否真 AI 面"
					const aiId = await recordAsset("ai-surface", base.origin, `ai:signal ${aiHits.slice(0, 4).join(",") || "path-pattern"} conf=${aiConfidence.toFixed(2)} needs-llm-review`, "passive", "passive", aiConfidence, "candidate");
					await recordFact("info", base.origin, `AI 面粗筛信号（${aiHits.slice(0, 4).join(",") || "路径特征"}，置信 ${aiConfidence.toFixed(2)}）：需子 agent 拉取页面语义复核是否真实 AI 服务（排除营销文案误报），复核通过后测 prompt-injection/模型越权/key 泄露/SSRF via tool-call`, aiConfidence);
					await store.upsertResearch(sessionId, { intentId, category: "ai-abuse", hypothesis: `${base.origin} 疑似 AI 面（信号：${aiHits.slice(0, 3).join(",") || "路径特征"}）——先语义复核真伪，再测 prompt-injection/模型越权/key 泄露`, preconditions: ["authorized target", "ai-surface signal detected", "needs llm review before testing"], status: "hypothesis", stopReason: "", evidence: [`auto-skeleton ai-surface ${base.origin}`, `signal-confidence ${aiConfidence.toFixed(2)}`, "nextStep: llm-review-then-manual-test"] });
					assets.push({ id: aiId, type: "ai-surface", value: base.origin, status: "candidate", source: "passive" });
				}
				if (tiHits.length > 0) {
					await recordAsset("threat-intel", base.origin, `ti:signal ${tiHits.slice(0, 3).join(",")} needs-llm-review`, "passive", "passive", .6, "candidate");
					await recordFact("info", base.origin, "威胁情报平台特征信号，需子 agent 语义复核后留人工测试", .5);
				}
			} catch {}
			const commonApiPaths = ["/openapi.json", "/openapi.yaml", "/swagger.json", "/swagger/v1/swagger.json", "/api-docs", "/v3/api-docs", "/graphql"];
			const urls = [new URL("/robots.txt", base), new URL("/sitemap.xml", base), new URL("/", base), ...commonApiPaths.map((path) => new URL(path, base))];
			for (const url of urls) {
				try {
					const response = await http(url, { method: "GET", redirect: "manual", headers: { "user-agent": "dsh-src-passive/1" } });
					const contentType = response.headers.get("content-type") ?? "";
					const body = contentType.includes("text") || contentType.includes("xml") || contentType.includes("javascript") ? (await response.text()).slice(0, 65536) : "";
					fetched.push({ url: url.pathname, status: response.status, contentType });
					if (url.pathname === "/robots.txt" && body !== "") {
						for (const match of body.matchAll(/^\s*(?:Allow|Disallow|Sitemap):\s*(.+)$/gmi)) {
							const hint = match[1].trim();
							if (hint.startsWith("http")) continue;
							if (hint.startsWith("/")) await recordFact("http", base.origin, `robots.txt hint ${hint}`);
						}
					}
					if (url.pathname === "/sitemap.xml" && body !== "") {
						for (const match of body.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
							const hinted = new URL(match[1].trim(), base);
							if (hinted.hostname === base.hostname || hinted.hostname.endsWith(`.${target.hostname}`)) {
								await recordAsset(hinted.hostname === target.hostname ? "root-domain" : "subdomain", hinted.hostname, "sitemap.xml", "sitemap.xml", "passive", .7, "candidate");
								await recordFact("http", hinted.origin, `sitemap.xml loc ${hinted.pathname}`);
							}
						}
					}
					if (url.pathname !== "/robots.txt" && url.pathname !== "/sitemap.xml" && response.status >= 200 && response.status < 300) {
						if (/graphql/i.test(url.pathname) || /application\/graphql-response\+json|application\/json/i.test(contentType) && /__schema|query|mutation/i.test(body)) {
							await recordAsset("endpoint", `${base.origin}${url.pathname}`, apiMeta("graphql-endpoint", { sourcePath: url.pathname }), "passive", "passive", .8, "candidate", endpointParentId, ["graphql"]);
							await recordFact("http", `${base.origin}${url.pathname}`, `graphql candidate ${url.pathname}`);
							const gqlHints = [...new Set([...body.matchAll(/\b(query|mutation)\s+([A-Za-z0-9_]+)/g)].map((match) => `${match[1]} ${match[2]}`).slice(0, 12))];
							for (const op of gqlHints) await recordFact("http", `${base.origin}${url.pathname}`, `graphql operation ${op}`);
							await researchSkeleton(`${base.origin}${url.pathname}`, ["graphql"], gqlHints);
						}
						if (/openapi|swagger|api-docs/i.test(url.pathname) || /openapi\s*:\s*3|swagger\s*:\s*['\"]?2/i.test(body)) {
							await recordAsset("endpoint", `${base.origin}${url.pathname}`, apiMeta("openapi-schema", { sourcePath: url.pathname }), "passive", "passive", .85, "candidate", endpointParentId, ["openapi"]);
							await recordFact("http", `${base.origin}${url.pathname}`, `api schema candidate ${url.pathname}`);
							const schemaHints = [];
							const openapiMethods = new Set();
							const openapiParams = new Set();
							try {
								const parsed = JSON.parse(body);
								if (parsed && typeof parsed === "object" && parsed.paths && typeof parsed.paths === "object") {
									for (const [pathKey, pathValue] of Object.entries(parsed.paths)) {
										if (typeof pathKey === "string" && pathKey.startsWith("/")) {
											schemaHints.push(pathKey);
											await recordAsset("endpoint", `${base.origin}${pathKey}`, apiMeta("schema-path", { path: pathKey }), "passive", "passive", .7, "candidate", endpointParentId, ["openapi"]);
										}
										if (pathValue && typeof pathValue === "object") {
											for (const [methodKey, methodValue] of Object.entries(pathValue)) {
												if (typeof methodKey === "string" && /^(get|post|put|delete|patch|options|head)$/i.test(methodKey)) openapiMethods.add(methodKey.toUpperCase());
												const params = methodValue && typeof methodValue === "object" ? methodValue.parameters : void 0;
												if (Array.isArray(params)) for (const param of params) if (param && typeof param === "object" && typeof param.name === "string") openapiParams.add(param.name);
											}
										}
									}
								}
							} catch {}
							for (const match of body.matchAll(/"\/(?:api|v\d+|graphql)[^"\s]{0,120}"|'\/(?:api|v\d+|graphql)[^'\s]{0,120}'/g)) {
								const raw = match[0].slice(1, -1);
								if (!schemaHints.includes(raw)) schemaHints.push(raw);
								await recordAsset("endpoint", `${base.origin}${raw}`, apiMeta("schema-path", { path: raw }), "passive", "passive", .7, "candidate", endpointParentId, ["openapi"]);
							}
							for (const method of [...openapiMethods, ...new Set([...body.matchAll(/\b(get|post|put|delete|patch|options|head)\b/gi)].map((match) => match[1].toUpperCase()).slice(0, 12))]) await recordFact("info", `${base.origin}${url.pathname}`, `openapi method ${method}`);
							for (const param of [...openapiParams, ...new Set([...body.matchAll(/"name"\s*:\s*"([A-Za-z0-9_.-]{1,40})"/g)].map((match) => match[1]).slice(0, 20))]) await recordFact("info", `${base.origin}${url.pathname}`, `openapi parameter ${param}`);
							await researchSkeleton(`${base.origin}${url.pathname}`, ["openapi"], schemaHints);
						}
					}
					if ((contentType.includes("text/html") || contentType.includes("javascript")) && body !== "") {
						const hints = [...new Set([...body.matchAll(/(?:src|href|fetch|axios(?:\.get|\.post)?)[\s=('\"]+([^\s'\"<>`]+)/gi)].map((match) => normalizeEndpointHint(match[1])).filter(Boolean).slice(0, maxHints))];
						const hintFamilies = [...new Set(hints.map((hint) => hint.split("?")[0]).filter(Boolean))];
						for (const hint of hints) {
							await recordFact("http", base.origin, `interface hint ${hint}`);
							await recordAsset("endpoint", `${base.origin}${hint}`, apiMeta("html-js-hint", { path: hint }), "passive", "passive", .65, "candidate", endpointParentId, ["html-js-hint"]);
						}
						for (const family of hintFamilies) {
							if (!hints.includes(family)) await recordAsset("endpoint", `${base.origin}${family}`, apiMeta("html-js-family", { path: family }), "passive", "passive", .6, "candidate", endpointParentId, ["html-js-hint"]);
						}
						if (hints.length) await researchSkeleton(base.origin, ["html-js-hint"], hintFamilies);
						for (const param of [...new Set([...body.matchAll(/[?&]([a-zA-Z0-9_.-]{2,40})=/g)].map((match) => match[1]).slice(0, 30))]) await recordFact("info", base.origin, `parameter hint ${param}`);
					}
				} catch (error) {
					signals.push(String(error?.name ?? error));
				}
			}
			for (const host of hostnames) {
				try {
					const [a, cname] = await Promise.all([dns.resolve4(host).catch(() => []), dns.resolveCname(host).catch(() => [])]);
					for (const ip of a.slice(0, 8)) await recordAsset("ip", ip, host, "dns", "passive", .8, "candidate");
					for (const alias of cname.slice(0, 8)) await recordAsset("subdomain", alias.toLowerCase(), host, "dns", "passive", .75, "candidate");
					await recordFact("info", host, `dns a=${a.length} cname=${cname.length}`);
				} catch (error) {
					signals.push(`dns:${host}`);
				}
			}
			await store.upsertCoverage(sessionId, { phase: "discovery", category: "passive-collection", status: signals.length > 0 ? "blocked" : "completed", evidence: [...fetched.map((row) => `${row.url} ${row.status}`), ...signals], limitation: signals.length > 0 ? "some passive signals were blocked or failed" : "" });
			return { assets: assets.length, facts: facts.length, sources: fetched.length + hostnames.length, requiresDecision: false, results: fetched };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_submit",
		description: "Immediately submit each newly confirmed delegated result directly into the specified parent intent. Subagent-only: records facts, assets, and confirmed findings in the parent graph, refreshes the parent projection, then returns only submission counts. Use it as real-time checkpoints — submit each batch of confirmed discoveries immediately, never resubmit an item. parentId and affectedAssetId may reference only an existing parent-session asset supplied in the delegation; omit either field when unsure — never invent ids. All three arrays are optional: omit findings/assets/facts that do not apply instead of sending empty arrays. Final reply keeps only counts and key conclusions (field-level requirements live in each schema).",
		parameters: {
			intentId: {
				type: "string",
				required: true,
				description: "The parent intent id supplied in the delegation prompt."
			},
			facts: {
				type: "array",
				description: "Observed facts to attach to the parent intent。每条只允许 kind/target/detail/confidence；资产字段（type/value 等）属 assets 项或 src_add_asset，塞进 facts 会被拒。",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							enum: FACT_KINDS,
							description: "Fact kind (default info)."
						},
						target: {
							type: "string",
							description: "Host, URL, or service this fact refers to."
						},
						detail: {
							type: "string",
							required: true,
							description: "Confirmed evidence."
						},
						confidence: { oneOf: [{
							type: "number",
							description: "Confidence 0..1, or 0..100 as a percentage."
						}, {
							type: "string",
							description: "Percentage such as \"90%\"."
						}] }
					}
				}
			},
			assets: {
				type: "array",
				description: "New assets discovered during execution. parentId may reference only an existing parent-session asset supplied in the delegation.",
				items: {
					type: "object",
					additionalProperties: true,
					properties: {
						type: {
							type: "string",
							required: true,
							enum: ASSET_TYPES,
							description: "Asset type: root-domain / subdomain / ip / service / app / endpoint."
						},
						value: {
							type: "string",
							required: true,
							description: "Asset value."
						},
						parentId: {
							type: "string",
							description: "Existing parent-session asset id, when known."
						},
						meta: {
							type: "string",
							description: "Optional asset metadata."
						},
						source: {
							type: "string",
							description: "资产来源（crt.name/certspotter/FOFA/DNS/官网导航/JS bundle/手工确认等），必须填写以保留溯源。"
						},
						method: {
							type: "string",
							enum: ["passive", "low-impact", "authorized-active", "user-confirmed"],
							description: "发现方法，默认 passive。"
						},
						confidence: { oneOf: [{ type: "number" }, { type: "string" }], description: "置信度 0..1 或百分比。" },
						status: {
							type: "string",
							enum: ["candidate", "confirmed", "excluded"],
							description: "资产状态；被动发现的默认 candidate。"
						}
					}
				}
			},
			stage: { type: "string", enum: ["progress", "completed", "blocked", "failed"], description: "Checkpoint lifecycle stage; default progress." },
			summary: { type: "string", description: "Bounded progress or completion summary." },
			decision: { type: "string", description: "为何在本次 checkpoint 后继续/停止/换向/绕过（决策理由，进时间线）。" },
			findings: {
				type: "array",
				description: "已确认的漏洞。每个 finding 只能是一个类型、一条业务线、一个漏洞点；不得把不同类型/不同业务线塞进同一个 finding。",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						title: {
							type: "string",
							required: true,
							description: "漏洞标题（中文）。"
						},
						severity: {
							type: "string",
							enum: SEVERITIES,
							description: "严重级别 critical/high/medium/low（无 info 级：仅配置缺陷/头反射无敏感数据证明的信号不进漏洞清单）。"
						},
						impact: { type: "string", required: true, description: "危害论证：攻击者视角的具体利用场景——如何构造利用（恶意页面/请求）、实际拿到什么数据或权限、危害哪些用户/业务；纯配置问题或信息罗列不算。≥40字。" },
						affectedScope: { type: "string", required: true, description: "影响范围：受影响的用户/记录/主机/端点。" },
						remediation: { type: "string", required: true, description: "修复建议。" },
						entryPoint: { type: "string", description: "前端功能点：web 漏洞必填，漏洞入口的前端页面/功能（如“找回密码页-手机号输入框”、“个人中心-修改头像弹窗”）。厂商复现需先从前端到达漏洞点，仅给接口不够（接口可能本就公开）。" },
						discoveryPath: { type: "string", description: "漏洞接口来源链：该接口如何被发现（如“React chunk 解析 / mobile/js/app.js → api/resetPwd”或“Burp proxy history 导入”）。" },
						rawRequest: { type: "string", description: "Burp 格式 raw 请求报文（必填门禁：报告 finalize 会拦截空 rawRequest；至少含接口地址）。" },
						rawResponse: { type: "string", description: "关键响应 raw 报文（Burp 格式）。" },
						victimImpact: { type: "string", description: "[Phase 0.5 #11b] medium 及以上必填（三要素②受害者交互与视角：谁受害、需要做什么（或完全无交互）、损失什么、是否可察觉；≥30字）。low 可缺省：未授权可达+PoC 即可入库，如实标 low。" },
						attackPrerequisites: { type: "string", description: "危害论证③利用前提（强烈建议提供，漏传存空）：钓鱼页托管域要求（厂商 SRC 是否要求自有域）、需登录哪个业务/账号类型、需要的用户动作；若漏洞需登录必须注明登录入口 URL（厂商复现要先登录才能到达漏洞点）。前提不满足时不得提交。" },
						concreteLossEvidence: { type: "array", description: "[Phase 0.5 #11b] medium 及以上必填（三要素③实际损失证据指针：至少一条指向真实 fact/observation/research 的 id（含敏感响应体或外带记录）；仅头反射证据不算）。low 可缺省，提供时服务端校验存在性。", items: { type: "string" } },
						pocEvidence: { type: "array", required: true, description: "POC 证据，补充证据；数据包主字段用 rawRequest。", items: { type: "string" } },
						description: {
							type: "string",
							description: "漏洞描述：清楚说明漏洞是什么、在什么接口产生。"
						},
						reproducibleSteps: {
							type: "array",
							required: true,
							description: "One or more ordered commands, requests, or actions that reproduce the vulnerability.",
							items: { type: "string" }
						},
						affectedAssetId: {
							type: "string",
							description: "Existing affected parent-session asset id, when known."
						}
					}
				}
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					facts: {
						type: "number",
						required: true
					},
					assets: {
						type: "number",
						required: true
					},
					findings: { type: "number", required: true },
					checkpointId: { type: "string", required: true },
					stage: { type: "string", required: true },
					duplicateCheckpoint: { type: "boolean", required: true }
				}
			},
			render: (_a, value) => [{
				type: "text",
				text: `Submitted ${value.facts} facts, ${value.assets} assets, and ${value.findings} findings to the parent session.`
			}]
		},
		execute: async (args, exec) => {
			const childSessionId = sessionIdOf(exec);
			const parentSessionId = parentSessionIdOf(exec);
			const input = args;
			const intentId = concreteIntentId(requiredString(input.intentId, "intentId"));
			/* [local.17] 三个数组均可省略（无 finding 的提交不必传空数组），缺省按空列表处理。 */
			const facts = submissionList(Array.isArray(input.facts) ? input.facts : [], "facts");
			const assets = submissionList(Array.isArray(input.assets) ? input.assets : [], "assets");
			const findings = submissionList(Array.isArray(input.findings) ? input.findings : [], "findings");
			const parent = ctx.sessions.get(parentSessionId);
			if (parent === void 0) throw new Error(`src_submit parent session ${parentSessionId} is not live`);
			const factWrites = facts.map((fact) => ({
				intentId,
				kind: enumValue(fact.kind, FACT_KINDS, "info", "fact.kind"),
				target: optionalString(fact.target),
				detail: requiredString(fact.detail, "fact.detail"),
				confidence: confidenceValue(fact.confidence)
			}));
			const assetWrites = assets.map((asset) => ({
				type: enumValue(asset.type, ASSET_TYPES, "endpoint", "asset.type"),
				value: requiredString(asset.value, "asset.value"),
				meta: optionalString(asset.meta),
				source: typeof asset.source === "string" && asset.source !== "" ? asset.source : "delegated-subagent",
				method: enumValue(asset.method, ["passive", "low-impact", "authorized-active", "user-confirmed"], "passive", "asset.method"),
				confidence: confidenceValue(asset.confidence) ?? 0.5,
				status: enumValue(asset.status, ["candidate", "confirmed", "excluded"], "candidate", "asset.status"),
				...typeof asset.parentId === "string" ? { parentId: asset.parentId } : {}
			}));
			const findingWrites = findings.map((finding) => ({
				intentId,
				title: requiredString(finding.title, "finding.title"),
				severity: enumValue(finding.severity, SEVERITIES, "info", "finding.severity"),
				description: optionalString(finding.description),
				impact: requiredString(finding.impact, "finding.impact"),
				affectedScope: requiredString(finding.affectedScope, "finding.affectedScope"),
				remediation: requiredString(finding.remediation, "finding.remediation"),
				pocEvidence: stringList(finding.pocEvidence, "finding.pocEvidence"),
				attackPrerequisites: typeof finding.attackPrerequisites === "string" ? finding.attackPrerequisites : "",
				concreteLossEvidence: Array.isArray(finding.concreteLossEvidence) ? finding.concreteLossEvidence.filter((item) => typeof item === "string") : [],
				reproducibleSteps: stringList(finding.reproducibleSteps, "finding.reproducibleSteps"),
				entryPoint: optionalString(finding.entryPoint),
				discoveryPath: optionalString(finding.discoveryPath),
				rawRequest: optionalString(finding.rawRequest),
				rawResponse: optionalString(finding.rawResponse),
				victimImpact: typeof finding.victimImpact === "string" ? finding.victimImpact : "",
				...typeof finding.affectedAssetId === "string" ? { affectedAssetId: finding.affectedAssetId } : {}
			}));
			await store.requireRef(parentSessionId, "intents", intentId, "intent");
			for (const asset of assetWrites) if (asset.parentId !== void 0 && asset.parentId !== "") await store.requireRef(parentSessionId, "assets", asset.parentId, "asset");
			for (const finding of findingWrites) if (finding.affectedAssetId !== void 0 && finding.affectedAssetId !== "") await store.requireRef(parentSessionId, "assets", finding.affectedAssetId, "asset");
			const acceptedFacts = [];
			const acceptedAssets = [];
			const acceptedFindings = [];
			for (const write of factWrites) {
				const result = await store.addFact(parentSessionId, write);
				if (!result.duplicate) { acceptedFacts.push(write); tel(exec, "evidence.created", { evidenceType: "fact", evidenceId: result.nodeId ?? "", intentId, kind: write.kind, source: "src_submit" }, parentSessionId); }
			}
			for (const write of assetWrites) {
				const result = await store.addAsset(parentSessionId, write);
				if (!result.duplicate) acceptedAssets.push(write);
			}
			for (const write of findingWrites) {
				const result = await store.addFinding(parentSessionId, write);
				if (!result.duplicate) { acceptedFindings.push(write); tel(exec, "evidence.linked", { sourceId: intentId, targetId: result.nodeId ?? "", relation: "proves", severity: write.severity, source: "src_submit" }, parentSessionId); }
			}
			const stage = enumValue(input.stage, ["progress", "completed", "blocked", "failed"], "progress", "stage");
			const summary = optionalString(input.summary);
			const batchKey = stableBatchKey({ intentId, childSessionId, stage, summary, facts: factWrites, assets: assetWrites, findings: findingWrites });
			const checkpoint = await store.addCheckpoint(parentSessionId, { intentId, childSessionId, stage, summary, decision: optionalString(input.decision), facts: acceptedFacts.length, assets: acceptedAssets.length, findings: acceptedFindings.length, batchKey });
			/* [Phase 1 telemetry] 提交漏斗：submit.checkpoint=子代理产出节奏；intent.completed=intent 生命终点。 */
			tel(exec, "submit.checkpoint", { checkpointId: checkpoint.id, intentId, stage, childSessionId, facts: acceptedFacts.length, assets: acceptedAssets.length, findings: acceptedFindings.length, duplicate: checkpoint.duplicate === true }, parentSessionId);
			if (stage === "completed" && checkpoint.duplicate !== true) tel(exec, "intent.completed", { intentId, evidenceCount: acceptedFacts.length + acceptedFindings.length, checkpointId: checkpoint.id }, parentSessionId);
			if (!checkpoint.duplicate) appendSubmissionProjection(parent, intentId, acceptedFacts, acceptedAssets, acceptedFindings, { id: checkpoint.id, childSessionId, stage, summary, facts: acceptedFacts.length, assets: acceptedAssets.length, findings: acceptedFindings.length, createdAt: checkpoint.createdAt, batchKey }, optionalString(input.decision));
			return {
				facts: acceptedFacts.length,
				assets: acceptedAssets.length,
				findings: acceptedFindings.length,
				checkpointId: checkpoint.id,
				stage,
				duplicateCheckpoint: checkpoint.duplicate === true
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_recover_child",
		description: "定向唤醒一个失联/失败的 SRC 子代理继续未完成的工作（即使它从未提交过 checkpoint 也可以）。三类场景都用它：收到子代理失败通知、src_state 的 orphanIntents 列出该子代理（web 重启/中途死亡后失联）、以及暂时性 API 上游错误（424）。同一 parent/intent/child 最多四次；唤醒后从断点继续。不自动循环。",
		parameters: {
			childSessionId: { type: "string", required: true, description: "Failed continuable child session id." },
			intentId: { type: "string", required: true, description: "Parent SRC intent assigned to this child." },
			message: { type: "string", required: true, description: "Bounded recovery task; include the real intent id and remaining scope." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { messageId: { type: "string", required: true }, attempt: { type: "number", required: true } } }, render: (_a, v) => [{ type: "text", text: `Recovery message ${v.messageId} queued for ${v.attempt}/4.` }] },
		execute: async (args, exec) => {
			const parent = exec.agent;
			if (!parent) throw new Error("src_recover_child requires a calling agent");
			const sessionId = sessionIdOf(exec);
			const childSessionId = requiredString(args.childSessionId, "childSessionId");
			const intentId = requiredString(args.intentId, "intentId");
			await store.requireRef(sessionId, "intents", intentId, "intent");
			/* [local.15] Accept the recovery even when the child never submitted a checkpoint:
			 * a child that dies to an API failure mid-first-turn has no checkpoint yet, and
			 * requiring one made src_recover_child unusable for exactly the children that most
			 * need recovery. The intent linkage (verified above) is the authority binding the
			 * child to this parent; the child session id comes from the runtime's own failed-settlement notice. */
			const key = `${sessionId}:${intentId}:${childSessionId}`;
			const attempt = (recoveryAttempts.get(key) ?? 0) + 1;
			if (attempt > 4) throw new Error("src_recover_child recovery limit reached (4): 把该 intent 已有 checkpoint 结论落 fact 后标 failed，新建 intent 重新委派剩余范围");
			recoveryAttempts.set(key, attempt);
			const message = `SRC recovery attempt ${attempt}/4 for parent intent ${intentId}. ${requiredString(args.message, "message")} Submit a progress or completed checkpoint with src_submit; do not expand scope.`;
			try {
				const messageId = await ctx.subagents.followup(parent, SessionId(childSessionId), [{ type: "text", text: message }], { source: { kind: "coordinator", form: "relay", senderSessionId: parent.id }, signal: exec.signal });
				await store.updateIntent(sessionId, intentId, "running");
				tel(exec, "intent.recovered", { intentId, attempt, childSessionId }, sessionId);
				return { messageId, attempt };
			} catch (error) {
				recoveryAttempts.delete(key);
				throw error;
			}
		}
	}));
	// [local.8] src_record_asset_observation 工具注册已删除（与 src_add_asset 冗余）；fold case 保留以兼容旧会话投影回放。
	ctx.tools.register(defineTool({
		name: "src_record_research",
		description: "Track one vulnerability research hypothesis through testing, reproduction, verification, false-positive, or blocked status. Use this for every vulnerability category before creating a reportable finding.",
		parameters: {
			intentId: { type: "string", required: true }, category: { type: "string", required: true }, hypothesis: { type: "string", required: true }, preconditions: { type: "array", items: { type: "string" } }, status: { type: "string", required: true, enum: ["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"] }, stopReason: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, findingId: { type: "string" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, updated: { type: "boolean", required: true }, negativeChecklist: { type: "string" } } }, render: (_a, v) => [{ type: "text", text: `Research ${v.id} ${v.updated ? "updated" : "recorded"}.${v.negativeChecklist !== void 0 ? `\n${v.negativeChecklist}` : ""}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const record = await store.upsertResearch(sessionId, { intentId: requiredString(args.intentId, "intentId"), category: requiredString(args.category, "category"), hypothesis: requiredString(args.hypothesis, "hypothesis"), preconditions: Array.isArray(args.preconditions) ? args.preconditions.filter((x) => typeof x === "string") : [], status: enumValue(args.status, ["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"], "hypothesis", "status"), stopReason: optionalString(args.stopReason), evidence: Array.isArray(args.evidence) ? args.evidence.filter((x) => typeof x === "string") : [], ...typeof args.findingId === "string" ? { findingId: args.findingId } : {} });
			/* [local.67 #18] 阴性判定回炉注脚：negative/blocked 落盘时在返回值里强制带自查清单——
			 * 顺丰 415×5 盲发+「上传白名单」错误归因直接入图的教训（通道差异与请求形态未穷尽就定性）。
			 * 载体选工具返回值（闸类，模型错了会被纠正）而非 lesson——lesson 读用率 0 已实证。 */
			const negativeChecklist = record.status === "false-positive" || record.status === "blocked" ? "【阴性回炉自查】定性前请逐条确认：①是否已换请求形态重试（方法/Content-Type/参数名/编码/路径变体）？②失败是否可能源于本机通道（TLS/代理/限流）或请求构造而非端点行为？未穷尽前不要把「不可利用/不可达」写入 stopReason。" : "";
			/* [Phase 1 telemetry] 研究假设也是证据；带 findingId 时补关联边事件。 */
			tel(exec, "evidence.created", { evidenceType: "research", evidenceId: record.id, intentId: record.intentId ?? "", status: record.status, category: record.category ?? "" });
			if (typeof args.findingId === "string" && args.findingId !== "") tel(exec, "evidence.linked", { sourceId: record.id, targetId: args.findingId, relation: "verifies" });
			return { id: record.id, updated: record.updated, ...(negativeChecklist !== "" ? { negativeChecklist } : {}) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_get_infra",
		description: "读取本会话基础设施设置的生效值（默认值合并会话覆盖）：HTTP 代理 proxyUrl、Burp MCP 端口 burpMcpPort、mcp-proxy.jar 路径 burpProxyJarPath、越权对照账号 testAccount、短信测试手机号 testPhone、单请求超时 httpTimeoutMs。执行短信轰炸/验证码爆破、水平越权对照、或需要代理出网的侦察前必须重读本工具取最新值——用户随时可能在面板修改，禁止沿用旧读取结果。【代理策略】proxyUrl 仅对 google/github/shodan 等无法直连的境外站点生效（工具层自动判断），国内目标一律直连；不要为国内目标反复改 proxyUrl，也不要因个别请求失败全局换代理——先判断该不该直连，再用 curl --max-time 有界重试。【沿用机制】新会话首次 src_add_goal 时若本会话从未保存过设置，自动沿用最近配置过的其他会话基础设施，无需重复询问用户。testAccount：优先脚本登录构造低权会话做 A/B 对照，无法自动登录时建用户待办，禁止臆造凭据；testPhone 多个用逗号分隔。",
		parameters: {},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: Object.entries(v.infra ?? {}).map(([key, value]) => `${key}=${value === "" ? "(空)" : value}`).join("; ") }] },
		execute: async (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理没有自己的 infra 覆盖行，沿 parentSession 链找到第一个有覆盖的会话读取。 */
			const chain = visibleSessionIds(ctx, exec);
			let infra = await store.getInfra(chain[0]);
			for (const id of chain.slice(1)) {
				const overrides = await store.getInfraOverrides(id);
				if (overrides.length > 0) { infra = await store.getInfra(id); break; }
			}
			return {
				infra,
				labels: SRC_INFRA_LABELS,
				processEnvProxy: {
					httpsProxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "",
					httpProxy: process.env.HTTP_PROXY ?? process.env.http_proxy ?? "",
					useEnvProxyFlag: process.execArgv.includes("--use-env-proxy") || /(^|\s)--use-env-proxy(\s|$)/.test(process.env.NODE_OPTIONS ?? "")
				}
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_list_capabilities",
		description: "列出外部能力（MCP 工具面扩展，如 JS 逆向/二进制/移动端分析）的声明与状态，读 caps-sync 产出的能力索引（缺索引时回退 capabilities.yaml）。两类形态：mcp 型（接线后工具面出现 mcp__<id>__*）与 skill 型（文档+白名单脚本，用 src_read_capability 读文档、src_run_capability 执行脚本）。逐条给出 id/形态/来源/状态/when 触发场景。任务疑似需要客户端逆向类能力而当前工具面没有对应工具时调用；未就绪的告知用户编辑 ~/.dsh/capabilities.yaml 后运行 node <dsh-src包>/scripts/caps-sync.mjs 并重启 dsh。只读操作。",
		parameters: {},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: (v.items ?? []).map((c) => {
			const state = c.kind === "skill"
				? (c.status === "installed" ? "✓已安装" : c.status === "failed" ? "✗安装失败（重跑 caps-sync 看报错）" : c.enabled === false ? "×已停用" : "○未安装")
				: (c.wired ? "✓已接线" : c.enabled === false ? "×已停用" : "○已启用但未接线：重跑 caps-sync+重启");
			const extra = [c.when ? `适用:${c.when}` : "", c.kind === "skill" && Array.isArray(c.scripts) && c.scripts.length ? `白名单脚本:${c.scripts.join(" ")}` : ""].filter(Boolean).join("；");
			return `${state} [${c.kind ?? "mcp"}] ${c.id}${extra ? " — " + extra : ""}`;
		}).join("\n") || "清单为空或未创建 ~/.dsh/capabilities.yaml" }] },
		execute: async (_args, _exec) => {
			const dshHome = dshHomeOf();
			const manifest = await readCapsManifest(dshHome);
			const wired = await capsWiredIds(dshHome);
			/* [local.42] lossless 边界：undefined 值字段不得裸返（skill 型 wired 未定义、非数组 scripts、
			 * 缺失 docs 都会以 undefined 键落到 tool 输出，lossless-JSON 序列化直接炸——真实会话首发现）。
			 * 改条件展开，未提供的字段不落键。 */
			return {
				source: manifest.source,
				...(manifest.parseError !== void 0 ? { parseError: manifest.parseError } : {}),
				items: manifest.items.map((c) => ({
					id: c.id,
					kind: c.kind ?? "mcp",
					from: c.from,
					enabled: c.enabled !== false,
					status: c.status ?? (c.enabled !== false ? "declared" : "disabled"),
					...((c.kind ?? "mcp") === "mcp" ? { wired: wired.has(c.id) } : {}),
					when: typeof c.when === "string" ? c.when : "",
					...(c.docs !== void 0 && c.docs !== null ? { docs: c.docs } : {}),
					...(Array.isArray(c.scripts) ? { scripts: c.scripts } : {})
				}))
			};
		}
	}));

	ctx.tools.register(defineTool({
		name: "src_add_capability",
		description: "一键接入外部能力（仅指挥官；不要求已初始化 engagement）。一条命令完成：解析来源（GitHub 链接自动探测 npm registry——命中则走 npm: 免 GitHub 网络；也接受 npm:<pkg>[@ver]、git:<url>、owner/repo）→ 结构化写入 capabilities.yaml（免手改文件、免 sandbox 纠纷）→ 调 caps-sync 完成 clone/npm 安装、npx 预热、patch 接线与能力索引 → 返回清单状态。proxy 参数缺省时沿用清单既有 settings.proxy。mcp 型接线后需重启 dsh web 生效；验证方式：重启后工具面出现 mcp__<id>__*，或调 src_test_capability——不要用 bash 手动 npx 冒烟、更不要 pkill 按名杀进程（会与 dsh web 拉起的真服务实例打架甚至误杀）。id 已存在时不改清单、仅重跑 sync（网络失败后重试安全）。",
		parameters: {
			from: { type: "string", required: true, description: "能力来源：npm:<pkg>[@ver]、git:<url>、path:</绝对路径>（本机目录直装，如仓库内 skills/ 目录）、https://github.com/o/r、owner/repo 或 npm 包名（自动探测 registry）。" },
			id: { type: "string", description: "能力 id（小写字母开头，小写字母/数字/连字符，≤31 字符）。缺省从来源推导；推导失败或冲突时必须显式给。" },
			kind: { type: "string", enum: ["mcp", "skill"], description: "mcp=接 MCP 工具面（默认）；skill=文档+白名单脚本（src_read_capability/src_run_capability 使用）。" },
			when: { type: "string", description: "一句话适用场景（建议提供，≤200 字符），出现在 src_list_capabilities 的适用列。" },
			docs: { type: "string", description: "skill 型：文档入口相对路径（如 SKILL.md/README.md）。" },
			scripts: { type: "array", items: { type: "string" }, description: "skill 型：白名单脚本相对路径数组（≤20 项，如 scripts/hello.sh）。" },
			entry: { type: "string", description: "mcp 型 git 来源：构建产物启动文件相对路径，默认 dist/index.js。" },
			ref: { type: "string", description: "git 分支/标签。" },
			proxy: { type: "string", description: "http(s)://host:port。清单无 settings.proxy 时写入持久化（已有则忽略此参数沿用清单值）。" },
			prewarm: { type: "boolean", description: "npm 型 mcp 是否预热本地缓存（默认 true，加速首次 npx 启动）。" },
			enabled: { type: "boolean", description: "默认 true；false 则登记为停用（不接线）。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: v.error ? `✗ ${v.error}` : [
			`${v.registered ? "✓ 已登记" : "ℹ 已存在（清单未改动）"} [${v.kind}] ${v.id} ← ${v.from}`,
			v.resolvedVia ? `  来源解析：${v.resolvedVia}` : "",
			v.existingFrom ? `  ⚠ 清单中实际来源：${v.existingFrom}（本次输入未覆盖）` : "",
			v.proxyWritten ? `  已写入 settings.proxy=${v.proxyWritten}` : "",
			`  sync：${v.sync?.timedOut ? "超时（15 分钟硬上限）" : v.sync?.code === 0 ? "成功" : `失败（exit ${v.sync?.code}）`}`,
			`  状态：${v.status ?? "unknown"}${v.kind === "mcp" ? (v.wired ? "（已接线）" : "（未接线）") : ""}${v.dir ? `\n  目录：${v.dir}` : ""}`,
			v.sync && v.sync.code !== 0 && v.sync.output ? `  sync 输出尾部：\n${v.sync.output.split("\n").slice(-8).map((l) => "    " + l).join("\n")}` : "",
			`  下一步：${v.nextSteps}`
		].filter(Boolean).join("\n") }] },
		execute: async (args) => {
			/* [local.48] 依赖 caps-sync.mjs 的纯函数（动态导入，缺文件时给可操作的报错）。 */
			const scriptPath = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "caps-sync.mjs");
			const capsSync = await import(pathToFileURL(scriptPath).href).catch(() => null);
			if (capsSync === null) throw new Error("src_add_capability: 找不到 scripts/caps-sync.mjs——重新部署 dsh-src（node scripts/deploy.mjs）后重试");
			const rawFrom = requiredString(args.from, "from").trim();
			const dshHome = dshHomeOf();
			const yamlPath = nodePath.join(dshHome, "capabilities.yaml");
			/* 接线目标 profile：优先从本插件副本路径推导（…/profiles/<name>/node_modules/…），
			 * 推导不出（如从 repo 直跑）回退 $DSH_HOME/profiles/web。 */
			let profileDir = nodePath.join(dshHome, "profiles", "web");
			const probeProfile = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
			if (nodePath.basename(nodePath.dirname(probeProfile)) === "profiles" && fsSync.existsSync(nodePath.join(probeProfile, "cordis.patch.yml"))) profileDir = probeProfile;
			/* 接线目标预检：sync 装完才发现目标不合法会留下半登记状态，先拦。 */
			if (!fsSync.existsSync(nodePath.join(profileDir, "cordis.patch.yml"))) throw new Error(`src_add_capability: 接线目标 ${profileDir} 缺 cordis.patch.yml（不是已初始化的 dsh profile）——先初始化 profile 后重试`);
			/* 代理：参数 > 清单既有值；写盘仅当清单尚无 settings.proxy。 */
			const proxyParam = typeof args.proxy === "string" ? args.proxy.trim() : "";
			if (proxyParam !== "" && !/^https?:\/\/[A-Za-z0-9.\-_]+:\d{1,5}$/.test(proxyParam)) throw new Error("src_add_capability: proxy 格式应为 http://host:port");
			const proxyEnvVars = proxyParam !== "" ? { HTTPS_PROXY: proxyParam, HTTP_PROXY: proxyParam, https_proxy: proxyParam, http_proxy: proxyParam } : {};
			/* ① 解析来源（npm registry 优先）。 */
			const resolved = await capsSync.resolveFrom(rawFrom, { env: { ...process.env, ...proxyEnvVars }, timeoutMs: 45000 });
			const kind = args.kind === "skill" ? "skill" : "mcp";
			/* ② id：显式 > 推导。 */
			let id = typeof args.id === "string" ? args.id.trim().toLowerCase() : "";
			if (id === "") id = capsSync.deriveCapId(resolved.from);
			if (id === "") throw new Error(`src_add_capability: 无法从来源推导合法 id（${resolved.from}），请显式传 id（小写字母开头，仅小写字母/数字/连字符）`);
			if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error(`src_add_capability: id「${id}」不合法（小写字母开头，仅小写字母/数字/连字符，≤31 字符）`);
			/* ③ 清单：用目录锁保护 read/判重/append/write 临界区，避免并发调用丢条目。 */
			await fsPromises.mkdir(dshHome, { recursive: true });
			const lockPath = `${yamlPath}.lock`;
			let lockAcquired = false;
			for (let attempt = 0; attempt < 120; attempt++) {
				try { await fsPromises.mkdir(lockPath); lockAcquired = true; break; } catch (e) {
					if (e?.code !== "EEXIST") throw new Error(`src_add_capability: 清单锁创建失败：${String(e?.message ?? e)}`);
					try {
						const lockAge = Date.now() - (await fsPromises.stat(lockPath)).mtimeMs;
						if (lockAge > 120000) { await fsPromises.rm(lockPath, { recursive: true, force: true }); continue; }
					} catch {}
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}
			if (!lockAcquired) throw new Error("src_add_capability: 清单正在被其他接入任务修改，等待超时；请稍后重试");
			let yamlText = "";
			let oldCaps = [];
			let registered = true, proxyWritten = "";
			let existingEntry;
			try {
				try { yamlText = await fsPromises.readFile(yamlPath, "utf8"); } catch (e) { if (e?.code !== "ENOENT") throw new Error(`src_add_capability: 清单读取失败：${String(e?.message ?? e)}`); }
				if (yamlText !== "") {
					try { oldCaps = capsSync.parseCapsYaml(yamlText).caps; } catch (e) { throw new Error(`src_add_capability: 现有清单解析失败，请先手动修复 ${yamlPath}：${String(e?.message ?? e)}`); }
				}
				const oldIds = oldCaps.map((c) => c.id);
				existingEntry = oldCaps.find((c) => c.id === id);
				if (existingEntry !== void 0) {
					registered = false;
				} else {
					const entry = { id, from: resolved.from, kind, ...(typeof args.when === "string" && args.when.trim() !== "" ? { when: args.when } : {}), ...(kind === "skill" && typeof args.docs === "string" && args.docs.trim() !== "" ? { docs: args.docs.trim() } : {}), ...(Array.isArray(args.scripts) ? { scripts: args.scripts } : {}), ...(kind === "mcp" && typeof args.entry === "string" && args.entry.trim() !== "" ? { entry: args.entry.trim() } : {}), ...(typeof args.ref === "string" && args.ref.trim() !== "" ? { ref: args.ref.trim() } : {}), ...(args.enabled === false ? { enabled: false } : {}) };
					let next = yamlText;
				/* settings.proxy 持久化：仅当清单尚无 settings 块或块内无 proxy。 */
				if (proxyParam !== "" && !/^settings:\s*$/m.test(next)) next = `settings:\n  proxy: ${proxyParam}\n\n` + next;
				else if (proxyParam !== "" && !/(^\n?  proxy:\s*\S)/m.test(next.slice(Math.max(0, next.indexOf("settings:")), next.indexOf("settings:") + 200))) {
					next = next.replace(/^settings:\s*$/m, `settings:\n  proxy: ${proxyParam}`);
				}
				const appended = capsSync.appendCapabilityEntry(next, entry, oldIds);
				/* 追加后整体重解析校验 settings.proxy 合法性，失败即放弃写盘。 */
				if (proxyParam !== "" && typeof appended.parsed.settings.proxy === "string" && !/^https?:\/\/[A-Za-z0-9.\-_]+:\d{1,5}$/.test(appended.parsed.settings.proxy)) throw new Error("src_add_capability: 写入后 settings.proxy 校验失败，放弃写盘");
					await fsPromises.mkdir(dshHome, { recursive: true });
					const tempYamlPath = `${yamlPath}.tmp-${process.pid}-${Date.now()}`;
					await fsPromises.writeFile(tempYamlPath, appended.text, "utf8");
					await fsPromises.rename(tempYamlPath, yamlPath);
					if (proxyParam !== "" && appended.parsed.settings.proxy === proxyParam) proxyWritten = proxyParam;
				}
			} finally {
				await fsPromises.rm(lockPath, { recursive: true, force: true });
			}
			/* ④ spawn caps-sync：安装/预热/接线/索引（15 分钟硬上限，超时杀进程组）。 */
			const syncArgs = [process.execPath, scriptPath, "--yaml", yamlPath, "--profile-dir", profileDir];
			if (args.prewarm === false) syncArgs.push("--no-prewarm");
			const sync = await runChildWithTimeout(syncArgs, { env: { ...process.env, ...proxyEnvVars }, timeoutMs: 900000 });
			/* ⑤ 回读清单状态（index.json 优先）。 */
			const manifest = await readCapsManifest(dshHome);
			const item = manifest.items.find((c) => c.id === id);
			let wired = false;
			try {
				const patch = await fsPromises.readFile(nodePath.join(profileDir, "cordis.patch.yml"), "utf8");
				const seg = patch.match(/── dsh-src capabilities:8<[\s\S]*?capabilities:>8 [^─]*──/);
				wired = new RegExp(`id: mcp-${id}\\b`).test(seg?.[0] ?? "");
			} catch {}
			const nextSteps = kind === "mcp"
				? (wired ? "重启 dsh web 后工具面出现 mcp__<id>__* 即生效；验证用 src_test_capability 或直接调工具，禁止手动 npx 冒烟/pkill" : "sync 未接线（看上方 sync 输出尾部修来源/网络），修好后重调本工具（同 id 安全重试）")
				: (item?.status === "installed" ? "无需重启；src_read_capability 读文档、src_run_capability 跑白名单脚本（挂审批）" : "安装未就绪（看上方 sync 输出尾部），修好后重调本工具（同 id 安全重试）");
			return {
				id,
				from: resolved.from,
				resolvedVia: resolved.resolvedVia,
				kind,
				registered,
				...(existingEntry !== void 0 && existingEntry.from !== resolved.from ? { existingFrom: existingEntry.from } : {}),
				...(proxyWritten !== "" ? { proxyWritten } : {}),
				yamlPath,
				profileDir,
				sync: { code: sync.code, ...(sync.timedOut ? { timedOut: true } : {}), output: `${sync.out}${sync.err !== "" ? (sync.out !== "" ? "\n[stderr]\n" : "") + sync.err : ""}`.slice(-4000) },
				status: item?.status ?? (sync.code === 0 ? "declared" : "failed"),
				...(kind === "mcp" ? { wired } : {}),
				...(item?.dir !== void 0 && item?.dir !== null ? { dir: item.dir } : {}),
				nextSteps
			};
		}
	}));

	ctx.tools.register(defineTool({
		name: "src_test_capability",
		description: "端到端测活一个外部能力：①确认它在 profile patch 能力区段已接线 ②按清单来源真实 spawn 其启动命令（npm 型 npx 拉起、git 型 node entry），观察 4 秒内是否稳定存活（stdio MCP server 启动后应挂起等输入而非退出）。返回 spawn 结果与诊断建议。仅指挥官可调；npm 型首次会触发包下载可能较慢。这不是完整 MCP tools/list 握手——最终以工具面出现 mcp__<id>__* 为准。",
		parameters: {
			id: { type: "string", required: true, description: "capabilities.yaml 里的能力 id。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: v.ok ? `✓ ${v.id}: 进程启动并存活 ${v.aliveMs}ms${v.hint ? "。" + v.hint : ""}` : `✗ ${v.id}: ${v.reason}${v.hint ? "。" + v.hint : ""}` }] },
		execute: async (args, exec) => {
			const id = requiredString(args.id, "id");
			if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error("id 格式不合法");
			const dshHome = process.env.DSH_HOME ? nodePath.resolve(process.env.DSH_HOME) : nodePath.join(nodeOs.homedir(), ".dsh");
			/* 接线检查 */
			let wired = false;
			try {
				const patchPath = nodePath.join(dshHome, "profiles", "web", "cordis.patch.yml");
				if (fsSync.existsSync(patchPath)) {
					const patch = await fsPromises.readFile(patchPath, "utf8");
					const seg = patch.match(/── dsh-src capabilities:8<[\s\S]*?capabilities:>8 [^─]*──/);
					wired = new RegExp(`id: mcp-${id}\\b`).test(seg?.[0] ?? "");
				}
			} catch {}
			/* 清单读取 */
			let cap;
			try { cap = (await readCapsManifest(dshHome)).items.find((c) => c.id === id); } catch {}
			if (!cap) return { id, ok: false, wired, reason: "清单中无此 id 或清单不可读" };
			if (cap.enabled === false) return { id, ok: false, wired, reason: "该能力 enabled: false" };
			/* [local.41] skill 型：不接 MCP 工具面，验证目录+文档齐备即可。 */
			if ((cap.kind ?? "mcp") === "skill") {
				const dirOk = typeof cap.dir === "string" && cap.dir !== "" && fsSync.existsSync(cap.dir);
				const docsOk = dirOk && (typeof cap.docs === "string" && cap.docs !== "" ? fsSync.existsSync(nodePath.join(cap.dir, cap.docs)) : ["SKILL.md", "README.md", "README_CN.md"].some((f) => fsSync.existsSync(nodePath.join(cap.dir, f))));
				return { id, ok: dirOk && docsOk, wired: true, aliveMs: 0, reason: dirOk && docsOk ? void 0 : "能力目录或文档缺失（重跑 caps-sync）", hint: dirOk && docsOk ? "skill 型不接 MCP 工具面：用 src_read_capability 读文档、src_run_capability 执行白名单脚本" : void 0 };
			}
			if (!wired) return { id, ok: false, wired: false, reason: "未出现在 patch 接线区段", hint: "先运行 caps-sync 并重启 dsh web" };
			/* 构造 spawn 命令 */
			const capsDir = nodePath.join(dshHome, "capabilities");
			const isNpm = String(cap.from ?? "").startsWith("npm:");
			const command = isNpm ? "npx" : "node";
			const capDir = typeof cap.dir === "string" && cap.dir !== "" ? cap.dir : nodePath.join(capsDir, id);
			const cmdArgs = isNpm ? ["-y", cap.from.slice(4)] : [nodePath.join(capDir, typeof cap.entry === "string" && cap.entry !== "" ? cap.entry : "dist/index.js")];
			const childEnv = { ...process.env };
			if (cap.env && typeof cap.env === "object") for (const [k, v] of Object.entries(cap.env)) childEnv[k] = String(v);
			childEnv.DSH_CAP_TEST = "1";
			const startedAt = Date.now();
			let stdout = "", stderr = "", exited = null;
			await new Promise((resolveProbe) => {
				const child = childProcessSpawn(command, cmdArgs, { env: childEnv, cwd: isNpm ? undefined : capDir, stdio: ["pipe", "pipe", "pipe"] });
				const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolveProbe(); }, 4000);
				child.stdout?.on("data", (d) => { stdout += String(d).slice(0, 500); });
				child.stderr?.on("data", (d) => { stderr += String(d).slice(0, 500); });
				child.on("error", (e) => { clearTimeout(timer); exited = `spawn error: ${String(e).slice(0, 200)}`; resolveProbe(); });
				child.on("exit", (code, signal) => { if (exited === null) exited = `exit code=${code} signal=${signal}`; });
				setTimeout(() => { if (exited === null) { try { child.kill("SIGKILL"); } catch {} } }, 4200);
			});
			const aliveMs = Date.now() - startedAt;
			const survived = aliveMs >= 3800;
			return {
				id,
				ok: survived,
				wired,
				aliveMs,
				reason: survived ? void 0 : exited ?? "提前退出",
				stdoutHead: stdout.trim().slice(0, 300) || void 0,
				stderrHead: stderr.trim().slice(0, 300) || void 0,
				hint: survived ? (isNpm ? "npx 已拉起；重启 dsh 后工具面应出现 mcp__" + id + "__*" : "构建产物可运行；重启 dsh 后工具面应出现 mcp__" + id + "__*") : "查 stderrHead；git 型先确认 build 已成功、entry 路径正确"
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_read_capability",
		description: "读取一个外部能力（skill 型）的文档入口（默认 SKILL.md/README.md）或其能力目录内的指定文件，了解用法后再用 src_run_capability 执行其白名单脚本。仅指挥官可调；只读、输出截断。mcp 型能力的用法直接看工具面 mcp__<id>__* 工具描述即可，无需本工具。",
		parameters: {
			id: { type: "string", required: true, description: "capabilities.yaml 里的能力 id（src_list_capabilities 可查）。" },
			file: { type: "string", description: "能力目录内相对路径（可选；默认清单 docs 字段，未声明则自动探测 SKILL.md > README.md > README_CN.md）。禁止路径穿越。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, file: { type: "string", required: true }, text: { type: "string", required: true }, truncated: { type: "boolean", required: true } } }, render: (_a, v) => [{ type: "text", text: `能力 ${v.id} 文档（${v.file}${v.truncated ? "，已截断" : ""}）：\n${v.text}` }] },
		execute: async (args, exec) => {
			const id = requiredString(args.id, "id");
			if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error("id 格式不合法");
			const dshHome = dshHomeOf();
			const item = (await readCapsManifest(dshHome)).items.find((c) => c.id === id);
			if (item === void 0) throw new Error(`src_read_capability: 能力 ${id} 不在清单中`);
			if (item.status !== "installed" || typeof item.dir !== "string" || item.dir === "") throw new Error(`src_read_capability: 能力 ${id} 未安装（status=${item.status ?? "unknown"}），先重跑 caps-sync`);
			/* 目标文件：显式指定 > 清单 docs > 自动探测 */
			const candidates = typeof args.file === "string" && args.file !== "" ? [args.file] : [typeof item.docs === "string" && item.docs !== "" ? item.docs : void 0, "SKILL.md", "README.md", "README_CN.md"].filter((f) => typeof f === "string");
			for (const rel of candidates) {
				if (rel.includes("..") || nodePath.isAbsolute(rel)) throw new Error(`src_read_capability: 文件路径 ${rel} 非法（禁止绝对路径/穿越）`);
				const abs = nodePath.resolve(item.dir, rel);
				if (!abs.startsWith(nodePath.resolve(item.dir) + nodePath.sep)) throw new Error(`src_read_capability: 文件 ${rel} 越出能力目录`);
				if (!fsSync.existsSync(abs) || !fsSync.statSync(abs).isFile()) continue;
				const raw = await fsPromises.readFile(abs, "utf8");
				const MAX = 12000;
				tel(exec, "skill.read", { skillId: id, source: `capability-doc:${rel}`, bytes: raw.length });
				return { id, file: rel, text: raw.length > MAX ? raw.slice(0, MAX) : raw, truncated: raw.length > MAX };
			}
			throw new Error(`src_read_capability: 能力 ${id} 目录内未找到文档（试过：${candidates.join("、")}）。可用 file 参数指定能力目录内其他文件`);
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_run_capability",
		description: "执行一个外部能力（skill 型）白名单内的脚本（如反编译 APK、提取端点、跑分析器）。安全闸：①脚本必须在 capabilities.yaml 的 scripts 白名单内 ②执行前异步挂起待审（用户在面板「待办」tab 批准后才真正运行），本工具返回 pendingApprovalId 后即返回，之后用 src_resolve_approval(id, allow|reject) 推进——批准后脚本 stdout/stderr 随审批结果返回。产出按纪律经 src_record_observation 固化。仅指挥官可调；需要已初始化的 SRC goal。mcp 型能力不走本工具，直接用其 mcp__<id>__* 工具。",
		parameters: {
			id: { type: "string", required: true, description: "capabilities.yaml 里的能力 id。" },
			script: { type: "string", required: true, description: "白名单内的脚本相对路径（如 scripts/extract-endpoints.sh）。" },
			args: { type: "array", description: "脚本参数（字符串数组，逐项传给脚本 argv；可选）。" },
			timeoutMs: { type: "number", description: "超时毫秒数（可选，默认 120000，上限 600000，超时 SIGKILL）。" },
			justification: { type: "string", description: "给用户看的授权说明：为什么跑这个脚本、预期产出什么（可选，会显示在待审面板）。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { pendingApprovalId: { type: "string", required: true }, dedupe: { type: "boolean", required: true }, id: { type: "string", required: true }, script: { type: "string", required: true }, url: { type: "string", required: true }, hint: { type: "string", required: true }, lessonHints: { type: "array", items: { type: "string" } } } }, render: (_a, v) => [{ type: "text", text: `${v.dedupe ? "已存在相同待审请求，复用" : "已挂起待审"}：${v.pendingApprovalId}（${v.url}）。${v.hint}${v.lessonHints === void 0 ? "" : `\n${v.lessonHints.join("\n")}`}` }] },
		execute: async (args, exec) => {
			const id = requiredString(args.id, "id");
			const script = requiredString(args.script, "script");
			if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error("id 格式不合法");
			if (Array.isArray(args.args) && (args.args.length > 20 || args.args.some((a) => typeof a !== "string" || a.length > 200))) throw new Error("src_run_capability: args 必须是 ≤20 项、每项 ≤200 字符的字符串数组");
			if (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0 || args.timeoutMs > 600000)) throw new Error("src_run_capability: timeoutMs 必须在 (0, 600000] 内");
			const dshHome = dshHomeOf();
			const item = (await readCapsManifest(dshHome)).items.find((c) => c.id === id);
			if (item === void 0) throw new Error(`src_run_capability: 能力 ${id} 不在清单中`);
			if ((item.kind ?? "mcp") !== "skill") throw new Error(`src_run_capability: 能力 ${id} 是 mcp 型，直接用其 mcp__${id}__* 工具`);
			if (item.status !== "installed" || typeof item.dir !== "string" || item.dir === "") throw new Error(`src_run_capability: 能力 ${id} 未安装（status=${item.status ?? "unknown"}），先重跑 caps-sync`);
			if (!Array.isArray(item.scripts) || !item.scripts.includes(script)) throw new Error(`src_run_capability: 脚本 ${script} 不在能力 ${id} 的白名单内（允许：${Array.isArray(item.scripts) && item.scripts.length ? item.scripts.join("、") : "（无）"}。如需调整改 ~/.dsh/capabilities.yaml 后重跑 caps-sync）`);
			const cmd = capabilityCommand(item.dir, script);
			if (cmd.error !== void 0) throw new Error(`src_run_capability: ${cmd.error}`);
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			if (engagementId === void 0) throw new Error("src_run_capability requires an initialized SRC goal");
			const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.min(args.timeoutMs, 600000) : 120000;
			const url = `capability://${id}/${script}`;
			const bodyJson = JSON.stringify({ args: Array.isArray(args.args) ? args.args : [], timeoutMs });
			/* [local.62] 决策点注入：跑能力脚本前按能力 id/脚本名匹配经验触发器（如小程序线已沉淀的坑）。 */
			let runCapLessonHints;
			try { runCapLessonHints = lessonHintLines(await lessonsForContext({ tool: "src_run_capability", text: `${id} ${script} ${str(args.justification)}` })); } catch {}
			const runCapHintsSpread = runCapLessonHints !== void 0 && runCapLessonHints.length > 0 ? { lessonHints: runCapLessonHints } : {};
			/* [local.31] 同参重复提交复用既有 pending，不堆队列。 */
			const existing = await store.findPendingApproval(engagementId, "RUN", url, bodyJson);
			if (existing !== void 0) return { pendingApprovalId: existing.id, dedupe: true, id, script, url, hint: "同参数请求已在待审队列，勿重复提交；用 src_resolve_approval 推进", ...runCapHintsSpread };
			const justification = str(args.justification) !== "" ? str(args.justification) : `运行能力 ${id} 的白名单脚本 ${script}${Array.isArray(args.args) && args.args.length ? `（参数：${args.args.join(" ")}）` : ""}`;
			const pending = await store.addPendingApproval(engagementId, { method: "RUN", url, path: script, headers: "", body: bodyJson, category: "capability-run", reason: "外部能力脚本执行需人工授权（命令执行面）", justification });
			/* [local.60] 审批锁（capability:// 无 host，桥不比对，仅记账一致性）。 */
			try { await addApprovalLock(dshHomeOf(), { id: pending.id, method: "RUN", url, category: "capability-run", createdAt: Date.now() }); } catch {}
			const approvalEvent = { id: pending.id, method: "RUN", url, path: script, headers: "", body: bodyJson, category: "capability-run", reason: "外部能力脚本执行需人工授权（命令执行面）", justification };
			if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_record_pending_approval", approvalEvent);
			/* [local.58] 跨会话审批投影对齐（同 src_http）：子代理挂起的能力运行审批补进 engagement 父日志。 */
			const runCapabilitySessionId = sessionIdOf(exec);
			if (engagementId !== runCapabilitySessionId) appendSessionToolEvent(ctx.sessions.get(engagementId), "src_record_pending_approval", approvalEvent);
			/* [Phase 1 telemetry] 能力请求 + 高危挂起两个漏斗点。 */
			tel(exec, "capability.requested", { capabilityId: id, jobId: pending.id, script, approvalRequired: true }, engagementId);
			tel(exec, "approval.waiting", { approvalId: pending.id, category: "capability-run", risk: "外部能力脚本执行需人工授权（命令执行面）", capabilityId: id, script }, engagementId);
			return { pendingApprovalId: pending.id, dedupe: false, id, script, url, hint: "脚本尚未执行。用户在「待办」tab 待审批准后调 src_resolve_approval(该 id, allow)；批准即执行，stdout/stderr 随审批结果返回", ...runCapHintsSpread };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_fetch_policy",
		description: "抓取厂商 SRC/安全应急响应中心的漏洞评分与收录规则��面正文（只读一次 GET；境外站点自动走会话代理，国内站点直连）。用于【厂商规则】步骤：把返回正文的要点存为 fact(category=vendor-policy)。仅指挥官可调。",
		parameters: {
			url: { type: "string", required: true, description: "规则页面 URL（http/https）。" },
			maxLength: { type: "number", description: "返回正文最大字符数，默认 8000，上限 20000。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `[${v.status}] ${v.url}（${v.chars} 字符）\n${v.text}${v.scrapeHint === void 0 ? "" : `\n\n⚠️ ${v.scrapeHint}`}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const infra = await store.getInfra(sessionId);
			const http = makeHttpFetch(infra);
			const url = requiredString(args.url, "url");
			let parsed;
			try { parsed = new URL(url); } catch { throw new Error("src_fetch_policy: url 无法解析"); }
			if (!/^https?:$/.test(parsed.protocol)) throw new Error("src_fetch_policy supports only http/https urls");
			const maxChars = Math.min(Math.max(Number(args.maxLength) || 8000, 500), 20000);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number.parseInt(String(infra.httpTimeoutMs ?? ""), 10) || 15000, 2000), 60000));
			try {
				const response = await http(url, { method: "GET", signal: controller.signal });
				const raw = await response.text();
				const text = htmlToText(raw).slice(0, maxChars);
				/* [local.57] SPA 空壳/反爬拦截检测：正文拿不到时主动引导去能力清单找抓取方法论 skill，
				 * 不要让指挥官自行放弃「无法抓取」（中通会话实测：sec.zto.com SPA + 公众号反爬，
				 * src-rules-scraper/wechat-mp-reader 明明已安装却没被想起）。 */
				const spaBlocked = /enable javascript|javascript is (required|disabled)|needs? javascript|环境异常|异常环境|完成验证|验证码|安全验证|captcha|just a moment|access denied|请开启 javascript/i.test(text) || /<div[^>]+id=["'](?:app|root)["'][^>]*>\s*<\/div>/i.test(raw);
				const scrapeHint = response.status === 200 && text.length > 40 && !spaBlocked ? void 0 : "响应疑似 SPA 空壳或反爬拦截，正文无法直读。不要直接放弃：调 src_list_capabilities 查看已安装的抓取方法论能力（如 src-rules-scraper：SPA 站经浏览器渲染后从 performance 面板找 JSON API 再取规则；wechat-mp-reader：微信公众号文章 curl+UA 直抓），src_read_capability 读取后按流程执行；也可改用 web_search 找规则全文的公开镜像/转载。";
				return { status: response.status, url, chars: text.length, text, ...scrapeHint !== void 0 ? { scrapeHint } : {} };
			} finally {
				clearTimeout(timer);
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_set_infra",
		description: `写入一项基础设施设置（仅指挥官）。key 必须是：${SRC_INFRA_KEYS.join(" / ")}。value 为字符串（≤300 字符）：proxyUrl 形如 http://127.0.0.1:7890 或留空表示直连；burpMcpPort 为端口数字；httpTimeoutMs 取值 1000..60000；testPhone 为手机号列表（多个用逗号分隔）；testAccount 为对照账号凭据，格式 user:pass 或用户名。`,
		parameters: {
			key: { type: "string", required: true, description: "设置键。" },
			value: { type: "string", required: true, description: "设置值（字符串）。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { key: { type: "string", required: true }, value: { type: "string", required: true }, updatedAt: { type: "number", required: true } } }, render: (_a, v) => [{ type: "text", text: `已保存基础设施设置 ${v.key}=${v.value === "" ? "(空)" : v.value}。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const key = requiredString(args.key, "key");
			if (!SRC_INFRA_KEYS.includes(key)) throw new Error(`src_set_infra key 必须是 ${SRC_INFRA_KEYS.join(" / ")}`);
			const value = (typeof args.value === "string" ? args.value : String(args.value ?? "")).trim();
			if (value.length > 300) throw new Error("src_set_infra value 过长（≤300 字符）");
			if (key === "proxyUrl" && value !== "" && !isProxyUrl(value)) throw new Error("proxyUrl 格式应为 http://127.0.0.1:7890");
			if (key === "burpMcpPort" && value !== "" && !/^\d{1,5}$/.test(value)) throw new Error("burpMcpPort 应为端口号数字");
			if (key === "httpTimeoutMs") { const parsed = Number(value === "" ? "8000" : value); if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 60000) throw new Error("httpTimeoutMs 取值为 1000..60000 的整数毫秒"); }
			if (key === "testPhone" && value !== "") {
				const phones = value.split(/[,，、;；\s]+/).filter((part) => part !== "");
				if (phones.length === 0 || phones.some((part) => !/^\+?\d{5,15}$/.test(part))) throw new Error("testPhone 应为纯数字手机号（可带国家码 +），多个用逗号分隔");
			}
			/* [local.54] testAccount 凭据不再落明文：入本地凭证库，infra 表与工具返回只存 credentialRef。 */
			let storedValue = value;
			if (key === "testAccount" && value !== "") {
				const written = await writeCredential({ dshHome: dshHomeOf(), sessionId, label: "legacy-infra", credential: value, note: "src_set_infra testAccount（旧通道）" });
				storedValue = written.ref;
			}
			const record = await store.setInfra(sessionId, key, storedValue);
			return { key: record.key, value: record.value, updatedAt: record.updatedAt };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_test_account",
		description: "[local.23/54] 添加/更新一条越权对照测试账号凭据（多账号矩阵）。粘贴式 label 主通道：直接粘完整 Cookie/Authorization 字符串；凭据自动存入本地凭证目录（$DSH_HOME/storages/src-credentials/，权限 0600），会话内只保留 credential:// 引用与指纹，不再落明文——后续 src_http 用返回的 credentialRef 引用即可。同一会话内 label 去重覆盖。仅指挥官可调；用于水平/垂直越权 A/B 对照与多账号交叉矩阵。交叉矩阵动作：A 的资源 ID × B 的会话、普通会话 × 管理端端点清单；认证头一律 credentialRef 注入，不要把 Cookie/Authorization 明文粘进 headers 或对话。凭据即用即取，不批量囤积。",
		parameters: {
			label: { type: "string", required: true, description: "本组凭据的标识（如 ‘商家账号B’/‘管理员号’），同一会话 label 去重。" },
			credential: { type: "string", description: "完整凭据串：Cookie 头、Authorization 头、或 user:pass。直接粘贴 Burp 抓包的 Cookie: ... 整行。长度上限 8000 字符。与 credentialRef 二选一。" },
			credentialRef: { type: "string", description: "已有凭证引用（credential://…，来自既往 src_add_test_account 返回值或 src_import_traffic 提取）：同一条凭据换 label 登记时直接引用，免重复粘贴。与 credential 二选一。" },
			note: { type: "string", description: "备注（账号角色/来源/过期提醒等）。" },
			sourceObservationId: { type: "string", description: "归因兜底：若凭据来自某条 observation（如从代理流量里提取的会话 token），填该 observation id。主通道是直接粘贴凭据。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, label: { type: "string", required: true }, credentialRef: { type: "string" }, fingerprint: { type: "string" }, updated: { type: "boolean", required: true }, updatedAt: { type: "number", required: true } } }, render: (_a, v) => [{ type: "text", text: `已${v.updated ? "更新" : "新增"}测试账号 ${v.label}（id ${v.id}，凭据已入凭证库）。后续请求用 credentialRef=${v.credentialRef ?? "（旧记录无引用，重粘一次即迁移）"}。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const label = requiredString(args.label, "label").trim();
			if (label.length > 80) throw new Error("src_add_test_account label 过长（≤80 字符）");
			const sourceObservationId = typeof args.sourceObservationId === "string" ? args.sourceObservationId.trim() : "";
			/* [local.54] 凭证专用目录：明文只写入 0600 凭证文件，业务表/投影/事件只留 credentialRef+指纹。 */
			let credentialRef = "";
			let fingerprint = "";
			const rawCredential = typeof args.credential === "string" ? args.credential : "";
			const refInput = typeof args.credentialRef === "string" ? args.credentialRef.trim() : "";
			if (rawCredential === "" && refInput === "") throw new Error("src_add_test_account 需要 credential 或 credentialRef（二选一）");
			if (rawCredential !== "") {
				if (rawCredential.length > 8000) throw new Error("src_add_test_account credential 过长（≤8000 字符；过长的 Cookie 应裁剪为相关字段）");
				const written = await writeCredential({ dshHome: dshHomeOf(), sessionId, label, credential: rawCredential, note: typeof args.note === "string" ? args.note : "" });
				credentialRef = written.ref;
				fingerprint = written.fingerprint;
			} else {
				credentialRef = refInput;
				fingerprint = refInput.replace(/^credential:\/\//, "").slice(0, 16);
			}
			const record = await store.upsertTestAccount(sessionId, { label, credentialRef, note: typeof args.note === "string" ? args.note : "", ...(sourceObservationId !== "" ? { sourceObservationId } : {}) });
			return { id: record.id, label: record.label, credentialRef, ...(fingerprint !== "" ? { fingerprint } : {}), updated: record.updated, updatedAt: record.updatedAt };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_domain_note",
		description: "[local.24] 沉淀一条域笔记（按目标域名跨会话积累）。同一目标+标题覆盖更新不膨胀。仅指挥官可调。用于：记域指纹（资产/技术栈/认证机制）、坑位（踩过的雷如某接口限流/某子域 WAF）、已否假设摘要、基线素材。续测同目标时 src_add_goal 会自动返回历史域笔记做 briefing，避免重复钻枯井。注意：单次会话的已否假设本身仍用 src_record_research 落盘，本工具只记跨会话复用价值的摘要。",
		parameters: {
			category: { type: "string", required: true, enum: ["fingerprint", "pitfall", "falsified-summary", "baseline", "misc"], description: "fingerprint=域指纹（技术栈/认证机制/资产布局），pitfall=坑位（限流/WAF/踩雷），falsified-summary=已否假设摘要，baseline=基线素材（覆盖维度经验值），misc=其他。" },
			title: { type: "string", required: true, description: "标题（≤200 字符），同目标+标题去重覆盖。" },
			content: { type: "string", required: true, description: "正文（≤8000 字符）。结构化一点便于复用：坑位记现象+绕过尝试+结论。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, target: { type: "string", required: true }, title: { type: "string", required: true }, updated: { type: "boolean", required: true }, updatedAt: { type: "number", required: true } } }, render: (_a, v) => [{ type: "text", text: `已${v.updated ? "更新" : "新增"}域笔记 [${v.target}] ${v.title}（id ${v.id}）。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_record_domain_note requires an initialized SRC goal (call src_add_goal first)");
			const title = requiredString(args.title, "title").trim();
			if (title.length > 200) throw new Error("src_record_domain_note title 过长（≤200 字符）");
			const content = requiredString(args.content, "content");
			if (content.length > 8000) throw new Error("src_record_domain_note content 过长（≤8000 字符）");
			const category = enumValue(args.category, ["fingerprint", "pitfall", "falsified-summary", "baseline", "misc"], "misc", "category");
			const record = await store.upsertDomainNote(sessionId, { target: goal.target, category, title, content });
			/* [local.33] 落库后刷新投影快照：UI explore 侧栏即时可见（含 content 全文）。 */
			try {
				if (exec.agent !== void 0) {
					const noteRows = (await store.listDomainNotes(goal.target)).slice(0, 50).map((row) => ({ id: row.id, category: row.category, title: row.title, content: row.content, sourceSessionId: row.sourceSessionId, createdAt: row.createdAt, updatedAt: row.updatedAt }));
					appendSessionToolEvent(exec.agent.session, "src_domain_notes_snapshot", { notes: noteRows });
				}
			} catch {}
			return { id: record.id, target: record.target, title: record.title, updated: record.updated, updatedAt: record.updatedAt };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_list_domain_notes",
		description: "[local.24] 列出当前目标的全部域笔记（按目标域名跨会话积累，历史任何会话沉淀的都可见）。只读。用于会话中途回顾：本目标踩过哪些坑、有什么域指纹、已否假设摘要，避免重复钻枯井。content 不返回（精简），需要全文用 src_add_goal 开局的 priorContext 或后续单条查看。",
		parameters: {},
		output: { schema: { type: "object", additionalProperties: false, properties: { target: { type: "string", required: true }, notes: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, category: { type: "string", required: true }, title: { type: "string", required: true }, sourceSessionId: { type: "string", required: true }, updatedAt: { type: "number", required: true } } } } } }, render: (_a, v) => [{ type: "text", text: `目标 ${v.target} 域笔记（${v.notes.length} 条）：${v.notes.length === 0 ? "（无）" : "\n" + v.notes.map((n) => `- [${n.category}] ${n.title}（来自会话 ${n.sourceSessionId}）`).join("\n")}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_list_domain_notes requires an initialized SRC goal (call src_add_goal first)");
			const notes = (await store.listDomainNotes(goal.target)).map((row) => ({ id: row.id, category: row.category, title: row.title, sourceSessionId: row.sourceSessionId, updatedAt: row.updatedAt }));
			return { target: goal.target, notes };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_set_goal_target",
		description: "修正当前会话的目标域名（不清空探索图、不重置计数）：传入目标字符串，自动提取主机名写回 goal.target。用于目标带杂质说明文字、或其他 src_* 工具报「无法解析出目标域名」时自我修正。",
		parameters: {
			target: { type: "string", required: true, description: "目标主域名或 URL（如 mi.com）。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, target: { type: "string", required: true } } }, render: (_a, v) => [{ type: "text", text: `Goal target 已更新为 ${v.target}。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_set_goal_target requires an initialized SRC goal (call src_add_goal first)");
			const updated = await store.updateGoalTarget(engagementId ?? sessionId, parseGoalHost(requiredString(args.target, "target"), "target"));
			return { id: updated.id, target: updated.target };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_coverage",
		description: "Record coverage for an asset and assessment category. Use planned/running/completed/blocked/not-applicable with evidence or an explicit limitation so the final report can distinguish tested from untested areas. [local.60] 单资产结论（某个 host 测完/受阻/不适用）必须带 assetId 对准具体资产——面板资产页按它显示覆盖徽标（已测/受阻/不适用），用户靠它区分『测过』和『没碰过』；只有 phase×category 级的全局结论才省略 assetId。",
		parameters: {
			assetId: { type: "string" }, phase: { type: "string", required: true }, category: { type: "string", required: true }, status: { type: "string", required: true, enum: ["planned", "running", "completed", "blocked", "not-applicable"] }, evidence: { type: "array", items: { type: "string" } }, limitation: { type: "string" },
			/* [local.78 接口对账] 声明「穷尽/全测绘」类结论时必须带清单对账数字：从接口清单提取总数、真实实测数、跳过数。
			   finalize gate 用这三个数字对账 observations——tested 声明 > 实测 observation 去重数即判 blocker（防嘴上穷尽）。 */
			endpointsTotal: { type: "number" }, endpointsTested: { type: "number" }, endpointsSkipped: { type: "array", items: { type: "string" } }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, updated: { type: "boolean", required: true } } }, render: (_a, v) => [{ type: "text", text: `Coverage ${v.id} ${v.updated ? "updated" : "recorded"}.` }] },
		execute: async (args, exec) => {
			const record = await store.upsertCoverage(sessionIdOf(exec), { ...typeof args.assetId === "string" && args.assetId.trim() !== "" ? { assetId: args.assetId.trim() } : {}, phase: requiredString(args.phase, "phase"), category: requiredString(args.category, "category"), status: enumValue(args.status, ["planned", "running", "completed", "blocked", "not-applicable"], "planned", "status"), evidence: Array.isArray(args.evidence) ? args.evidence.filter((x) => typeof x === "string") : [], limitation: optionalString(args.limitation), ...Number.isFinite(args.endpointsTotal) ? { endpointsTotal: args.endpointsTotal } : {}, ...Number.isFinite(args.endpointsTested) ? { endpointsTested: args.endpointsTested } : {}, ...Array.isArray(args.endpointsSkipped) ? { endpointsSkipped: args.endpointsSkipped.filter((x) => typeof x === "string") } : {} });
			return { id: record.id, updated: record.updated };
		}
	}));
	// [local.8] src_record_recon 工具注册已删除（与 src_add_asset/src_add_fact 冗余）；fold case 保留以兼容旧会话投影回放。
	/* [local.32] src_http 软速率帽：同会话两次「实际发出」的最小间隔 250ms（≈≤4 rps，对齐 src_scan_surface 默认）。
	   只约束发送起始时刻的间距，延迟而非拒绝；审批挂起路径不发包、不受影响。进程内 per-session 串行 gate，
	   同会话并行多调用也会被排开；仅约束真实发出的两个入口（src_http 放行分支、src_resolve_approval 重放）。 */
	const SRC_HTTP_MIN_INTERVAL_MS = 250;
	const srcHttpSendGates = new Map();
	function srcHttpThrottle(sessionId) {
		const key = String(sessionId ?? "?");
		const prev = srcHttpSendGates.get(key) ?? Promise.resolve();
		const next = prev.then(() => new Promise((resolve) => {
			const last = srcHttpSendGates.get(`${key}:at`) ?? 0;
			const wait = Math.max(0, last + SRC_HTTP_MIN_INTERVAL_MS - Date.now());
			setTimeout(() => {
				srcHttpSendGates.set(`${key}:at`, Date.now());
				resolve();
			}, wait);
		}));
		srcHttpSendGates.set(key, next.catch(() => {}));
		return next;
	}
	ctx.tools.register(defineTool({
		name: "src_http",
		description: "[local.26/31/54/60/67] 所有对授权目标发出的 HTTP 请求一律走本工具（不要用 bash 里的 curl）。软速率帽 ≥250ms/请求（延迟不拒绝）。认证头优先用 credentialRef 引用（src_add_test_account / src_import_traffic 返回，凭据从本地凭证库读取不落会话明文），非敏感头才写 headers。破坏性/越权/未授权写请求异步挂起待审（面板「待办」tab），agent 不阻塞继续其他方向；返回 approval=pending 说明已挂起未发出——不要重复发起（去重复用 pending），也不要绕用 bash curl 硬发；批准后调 src_resolve_approval(allow) 发出原请求（认证头重注入），拒绝则 reject 转其他方向。【审批锁，硬闸】挂起期间同 host+path 禁止经 Burp MCP（send_http1/2_request）、curl 等任何通道绕行——桥接层直接拒绝并提示审批 id；只有等批准或 reject 两条路。【判据】方法无关、信任接口命名规则：①强删改语义词（close/cancel/remove/delete/drop/reset/destroy/purge 等）GET 也挂；②有认证头+写方法+他人资源 id（userId/uid 命中小整数）→越权挂；③无认证头+写方法+非读语义 path→未授权写挂。放行：自己 token+自己资源写；强读语义 path 的未授权探测。fail-closed：无 store 时绝不发出。【响应体透传】responseBody：text/json 类默认前 2KB（凭证掩码；同 host+method+path 完全相同响应去重，full:true 强制完整）；二进制只回长度；JSON 形态 body 未带 Content-Type 自动补 application/json（防 415 假阴性）。",
		parameters: {
			url: { type: "string", required: true, description: "完整目标 URL（http/https），必须在 goal host 范围内。" },
			method: { type: "string", required: true, enum: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP 方法。" },
			headers: { type: "object", description: "非敏感请求头（userId/Content-Type/X-From 等）。认证头（Cookie/Authorization/x-*-auth/token）不要粘在这里——用 credentialRef 引用，避免明文进会话日志。", additionalProperties: true },
			credentialRef: { type: "string", description: "凭据引用（credential://…，来自 src_add_test_account 或 src_import_traffic 的返回值）：请求时从本地凭证库读取并注入认证头。与 headers 里的同名认证头冲突时以凭证库为准。" },
			body: { type: "string", description: "请求体（POST/PUT/PATCH 时）。" },
			full: { type: "boolean", description: "响应体强制完整返回（跳过 2KB 截断与去重；写入后回读、越权前后对比等前后响应本应不同的场景用）。" },
			justification: { type: "string", required: true, description: "一句话说明本次请求目的与预期结果（写入审批卡，用户凭此判断是否批准）。破坏性操作请明确标注不可逆。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: v.approval === "allowed" || v.approval === "allowed-auto" ? `src_http ${v.status} ${v.method} ${v.path}（已执行）` : v.approval === "pending" ? `src_http 已挂起待审 ${v.pendingApprovalId ?? ""}（未发出）。${v.reason ?? ""}` : `src_http 未执行：审批 ${v.approval}——${v.reason ?? ""}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_http requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const u = new URL(String(args.url ?? ""));
			if (!/^https?:$/.test(u.protocol)) throw new Error("src_http supports only http/https targets");
			if (u.hostname !== target.hostname && !u.hostname.endsWith(`.${target.hostname}`) && !hostCoveredByAssets(await assetGrantHostsFor(store, engagementId ?? sessionId), u.hostname)) throw new Error("src_http target is outside the authorized goal host and not in the asset inventory (if it belongs to the target organization, register it via src_add_asset with a source note, then retry; otherwise hand it to the parent agent)");
			const method = String(args.method ?? "GET").toUpperCase();
			const rawHeaders = args.headers && typeof args.headers === "object" ? Object.fromEntries(Object.entries(args.headers).filter(([k, v]) => typeof k === "string" && typeof v === "string")) : {};
			const body = typeof args.body === "string" ? args.body : void 0;
			/* [local.54] 认证头走凭证库：credentialRef 存在时从本地凭证目录读取注入认证头（显式 headers 同名键被凭证库覆盖）；
			   分类用完整 headers——认证头是否在场是越权判据。headers 里直接粘的认证头只在挂起分支自动入库（免无谓写盘）。 */
			const refInput = typeof args.credentialRef === "string" ? args.credentialRef.trim() : "";
			let credentialRef = "";
			let credentialSecret = "";
			let headers = rawHeaders;
			if (refInput !== "") {
				const secret = await readCredential({ dshHome: dshHomeOf(), ref: refInput });
				headers = { ...rawHeaders, ...credentialHeaders(secret) };
				credentialRef = refInput;
				credentialSecret = secret;
			}
			/* 掩码名单：凭据原文 + 解析出的认证头值（echo 回显/错误页会把值原样返回，仅掩原文不够）。 */
			const credentialSecretValues = credentialSecret === "" ? [] : [credentialSecret, ...Object.values(credentialHeaders(credentialSecret)).filter((v) => typeof v === "string" && v.trim().length >= 8)];
			/* [local.67 #17-④] Content-Type 自动补全硬闸：JSON 形态 body 未显式指定 Content-Type 时自动补
			 * application/json。fetch 对字符串 body 不自动带头——顺丰 415×5 盲发整类假阴性的根因，一行消灭。
			 * 在分类与挂起持久化之前补，重放用的 sanitizedHeaders 自带 Content-Type。 */
			let contentTypeAutoAdded = false;
			if (body !== void 0 && body !== "" && /^[{[]/.test(body.trim()) && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
				headers = { ...headers, "content-type": "application/json" };
				contentTypeAutoAdded = true;
			}
			/* [local.26] 分类：纯函数判定是否挂起审批。 */
			const verdict = classifyHttpRequest({ method, path: u.pathname, headers, body, query: u.search });
			if (!verdict.require) {
				/* [local.32] 放行：先过软速率帽（≥250ms 间隔，延迟而非拒绝），再直接发出并返回响应。 */
				const httpT0 = Date.now();
				await srcHttpThrottle(engagementId ?? sessionId);
				const response = await http(u, { method, redirect: "manual", headers: { "user-agent": "dsh-src/1", ...headers }, ...(body !== void 0 ? { body } : {}) });
				/* [local.67 #17] 响应体透传：agent 唯一的取证与诊断来源，只回状态码是 415×5 盲发与
				 * Content-Type 假阴性的直接代价。截断/去重/掩码统一走 describeHttpBody。 */
				let rawBodyText = "";
				try { rawBodyText = await response.text(); } catch {}
				const described = describeHttpBody({ url: String(u), method, status: response.status, contentType: response.headers?.get?.("content-type") ?? "", rawBody: rawBodyText, secrets: credentialSecretValues, full: args.full === true });
				/* [Phase 1 telemetry] http 漏斗：直发放行的每次出站请求（host/path/方法/状态/耗时/响应长度）。 */
				tel(exec, "http.request", { host: u.hostname, path: u.pathname, method, status: response.status, durationMs: Date.now() - httpT0, responseBytes: rawBodyText.length, approval: "allowed-auto", ...(credentialRef !== "" ? { credentialRef } : {}) }, engagementId ?? sessionId);
				return { method, path: u.pathname, status: response.status, approval: "allowed-auto", reason: verdict.reason, ...(contentTypeAutoAdded ? { contentTypeAutoAdded } : {}), responseBody: described.body, ...(described.truncated ? { truncated: true } : {}), ...(described.deduped ? { deduped: true } : {}) };
		}
		/* [local.31] 高风险：异步挂起待审队列（不再用 dsh-user-approval 同步 seam——它只支持轮次内且无输入框，
		   用户实测没法输入/没法继续）。落入 pending_approvals 表，agent 不阻塞、继续其他方向；用户在 SRC 面板「审批」区
		   批准/拒绝，后 src_resolve_approval 原样重放。去重：同 method+url+body 已有 pending 的复用而非堆队列。 */
		const justification = String(args.justification ?? "").trim();
		/* [local.54] 持久化前脱敏：待审行 headers 只存非认证头，认证头由 credentialRef 重放时重注入；
		   旧习惯直接粘在 headers 里的认证头此时自动入凭证库存引用（内容寻址，同凭据只落一份文件）。 */
		if (credentialRef === "") {
			const rawAuthKeys = Object.keys(rawHeaders).filter((k) => CREDENTIAL_HEADER_RE.test(k));
			if (rawAuthKeys.length > 0) {
				const credentialText = rawAuthKeys.map((k) => `${k}: ${rawHeaders[k]}`).join("\n");
				const written = await writeCredential({ dshHome: dshHomeOf(), sessionId, label: "src_http auto-vault", credential: credentialText, note: "src_http headers 内联认证头自动入库" });
				credentialRef = written.ref;
			}
		}
		const sanitizedHeaders = stripCredentialHeaders(headers);
		const headersText = Object.entries(sanitizedHeaders).map(([k, v]) => `${k}: ${v}`).join("\n");
		const storedBody = body !== void 0 ? body : "";
		const dedup = await store.findPendingApproval(engagementId ?? sessionId, method, String(u), storedBody);
		if (dedup !== void 0) {
			return { method, path: u.pathname, status: 0, approval: "pending", pendingApprovalId: dedup.id, reason: `已有同请求待审 ${dedup.id}，不要重复挂起。请告知用户到 SRC 面板「审批」区审批。` };
		}
		const pending = await store.addPendingApproval(engagementId ?? sessionId, { method, url: String(u), path: u.pathname, headers: headersText, ...(credentialRef !== "" ? { credentialRef } : {}), body: storedBody, category: verdict.category, reason: verdict.reason, justification });
		/* [local.60] 审批锁：挂起期间同 host+path 禁止经 Burp 桥等通道绕行发送（burp-mcp-bridge 每次发送前比对锁）。写锁失败不阻塞主流程（审批行已落库，锁只是纵深防御）。 */
		try { await addApprovalLock(dshHomeOf(), { id: pending.id, method, url: String(u), category: verdict.category, createdAt: Date.now() }); } catch {}
		/* [Phase 1 telemetry] 高危挂起漏斗点：等待用户批准的每个请求。 */
		tel(exec, "approval.waiting", { approvalId: pending.id, category: verdict.category, risk: verdict.reason, method, host: u.hostname, path: u.pathname }, engagementId ?? sessionId);
		/* 同步 fold：发合成事件让投影立即出现待审节点。 */
		const approvalEvent = { id: pending.id, method, url: String(u), path: u.pathname, headers: headersText, body: storedBody, category: verdict.category, reason: verdict.reason, justification, ...(credentialRef !== "" ? { credentialRef } : {}) };
		if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_record_pending_approval", approvalEvent);
		/* [local.58] 跨会话审批投影对齐：审批行落在 engagement（父）单元，但合成事件只落在调用者自己的日志——
		   子代理挂起的审批父投影永远看不到（中通会话 approval-1/3/4 store 在库、captain 面板待审区空的实测漂移）。
		   跨会话时向父日志补同一条事件；fold 案例按 id 幂等去重，父自身调用不重复合成。 */
		if (engagementId !== void 0 && engagementId !== sessionId) appendSessionToolEvent(ctx.sessions.get(engagementId), "src_record_pending_approval", approvalEvent);
		return { method, path: u.pathname, status: 0, approval: "pending", pendingApprovalId: pending.id, reason: `已挂起待审（${verdict.category}），未发出。请告知用户到 SRC 面板「待办」tab 审批区批准或拒绝。批准后调 src_resolve_approval(id=${pending.id}, action=allow) 发出原请求并据响应推进；拒绝则调 src_resolve_approval(id=${pending.id}, action=reject) 记理由后转其他方向。` };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_goal",
		description: "Start a penetration-testing engagement: set the target and objective, RESETTING the whole exploration graph of this session (a new goal starts a fresh chain). Call this once before recording intents, facts, findings, or assets. Record the engagement authorization (permission holder or written-permission reference) as a declarative audit fact — the package enforces no gate by itself.",
		parameters: {
			target: {
				type: "string",
				required: true,
				description: "The penetration target host or URL (e.g. mi.com or https://mi.com). 描述性后缀会自动剥离，尽量传裸域名。"
			},
			objective: {
				type: "string",
				required: true,
				description: "The purpose / completion objective of this engagement."
			},
			authorization: {
				type: "string",
				description: "Optional declarative authorization note (who authorized the engagement, or a written-permission reference)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					target: {
						type: "string",
						required: true
					},
					objective: {
						type: "string",
						required: true
					},
					lessonIndex: { type: "array", items: { type: "string" } },
					priorContext: { type: "object", additionalProperties: true },
					infraInherited: { type: "object", additionalProperties: true },
					capabilities: { type: "array", items: { type: "object", additionalProperties: true } }
				}
			},
			render: (_a, v) => {
				const lines = [`Recorded goal ${v.id} → ${v.target}.`];
				if (Array.isArray(v.lessonIndex) && v.lessonIndex.length > 0) lines.push(`已有经验库（同类漏洞先 src_read_lesson 读全文再定验证方案）：`, v.lessonIndex.join("\n"));
				if (v.priorContext && Object.keys(v.priorContext).length > 0) {
					lines.push("", `【跨会话 briefing】此目标历史（${v.priorContext.priorSessions ?? 0} 次先前会话）：`);
					if (Array.isArray(v.priorContext.notes) && v.priorContext.notes.length > 0) lines.push(`域笔记：`, ...v.priorContext.notes.map((n) => `- [${n.category}] ${n.title}`));
					if (Array.isArray(v.priorContext.falsifiedHypotheses) && v.priorContext.falsifiedHypotheses.length > 0) lines.push(`已否假设（勿重复钻枯井）：`, ...v.priorContext.falsifiedHypotheses.map((h) => `- [${h.category}] ${h.hypothesis}（${h.stopReason || "未记录理由"}）`));
					if (Array.isArray(v.priorContext.findings) && v.priorContext.findings.length > 0) lines.push(`已确认漏洞（复用/回归）：`, ...v.priorContext.findings.map((f) => `- [${f.severity}] ${f.title}`));
				}
				if (v.infraInherited && typeof v.infraInherited.summary === "string" && v.infraInherited.summary !== "") lines.push("", `【基础设施已自动沿用上次会话】${v.infraInherited.summary}——出站请求将走该配置；如需调整，到 SRC 面板「基础设施」页修改或让用户改。`);
				/* [local.57] 能力盘点：开局即可见的外部能力牌面（配合【外部能力路由】纪律使用）。 */
				if (Array.isArray(v.capabilities) && v.capabilities.length > 0) {
					lines.push("", `【已安装能力】${v.capabilities.length} 项（详情用 src_list_capabilities，用法用 src_read_capability）：`, ...v.capabilities.map((c) => `- ${c.kind === "skill" ? "skill" : "mcp"} ${c.id}${c.when ? ` — ${c.when}` : ""}`));
				}
				/* [local.80] 开局引导（运行时返回文本，不进静态预算）：流量导入 + 扫前端先行，避免从零静态爬。 */
				lines.push("", "开局建议（各跑一次再开 intent）：① src_import_traffic 导入 Burp proxy history（拿登录态真实 API 面，比静态爬 JS 全）② src_scan_surface 扫前端（前缀分簇/多后端/Cookie 服务名信号）。");
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.9] Normalize dirty targets ("mi.com（小米在线服务主域…）") to a bare host. */
			const normalizedHost = parseGoalHost(requiredString(args.target, "target"), "target");
			const goal = await store.initGoal(sessionId, {
				target: normalizedHost,
				objective: args.objective,
				authorization: args.authorization ?? ""
			});
			let lessonIndex = [];
			try { lessonIndex = await lessonIndexLines(); } catch {}
			/* [local.24] 跨会话 briefing：同目标的历史域笔记 + 已否假设 + 已确认 findings，
			 * 续测同目标时开局即可见，不重复钻已否枯井、复用已得成果。 */
			let priorContext;
			try { priorContext = await store.collectPriorContext(normalizedHost, sessionId); } catch {}
			const hasPrior = priorContext !== void 0 && Object.keys(priorContext).length > 0;
			/* [local.32] 基础设施默认沿用上次会话：本会话从未保存过任何覆盖项时，自动把最近配置过的
			 * 其他会话的设置（proxyUrl/Burp 端口等）复制过来，新会话免重填。显式保存过则完全尊重本会话
			 * （infra 表不随 goal 重置清空）；与面板「沿用上次会话的基础设施」按钮同一积木
			 * （latestOtherInfra + setInfra + 合成 src_set_infra 事件同步投影）。 */
			let infraInherited;
			try {
				const ownOverrides = await store.getInfraOverrides(sessionId);
				if (ownOverrides.length === 0) {
					const source = await store.latestOtherInfra(sessionId);
					const keys = source === void 0 ? [] : Object.keys(source.overrides);
					if (keys.length > 0) {
						await commitSyntheticMutation(exec.agent?.session, async () => {
							for (const key of keys) await store.setInfra(sessionId, key, source.overrides[key]);
							return { value: void 0, events: keys.map((key) => syntheticEvent("src_set_infra", { key, value: source.overrides[key] })) };
						}, appendSessionToolEvent);
						infraInherited = { keys, summary: keys.map((key) => `${key}=${source.overrides[key]}`).join("，") };
					}
				}
			} catch {}
			/* [local.33] 域笔记快照进投影：开局把本目标的全部跨会话域笔记推给 UI（explore 侧栏只读列表，含 content）。 */
			try {
				if (exec.agent !== void 0) {
					const noteRows = (await store.listDomainNotes(normalizedHost)).slice(0, 50).map((row) => ({ id: row.id, category: row.category, title: row.title, content: row.content, sourceSessionId: row.sourceSessionId, createdAt: row.createdAt, updatedAt: row.updatedAt }));
					appendSessionToolEvent(exec.agent.session, "src_domain_notes_snapshot", { notes: noteRows });
				}
			} catch {}
			/* [local.57] 能力盘点进开局：clown-src skill 的教训——skill 用率低的根因是「不知道手上有牌」。
			 * 建 goal 时把已安装能力的 id/形态/触发场景直接返回给指挥官（免额外调 src_list_capabilities），
			 * 配合 system prompt 的路由表，抓取受阻/查规则/公众号文章时第一时间想到用 skill。 */
			let capabilities;
			try {
				const capHome = dshHomeOf();
				const manifest = await readCapsManifest(capHome);
				capabilities = manifest.items.filter((c) => c.enabled !== false).slice(0, 12).map((c) => ({
					id: c.id,
					kind: c.kind ?? "mcp",
					...(typeof c.when === "string" && c.when !== "" ? { when: c.when } : {})
				}));
				if (capabilities.length === 0) capabilities = void 0;
			} catch { capabilities = void 0; }
			/* [local.65] 拆除 local.63 的 goal 级机械覆盖待办：枚举是 agent 本职（本机微信包扫描、下载
			 * 反编译、测绘、被动侦察），开局就把枚举外包给用户是死编排——assetGaps 的软提示与能力
			 * 盘点已足够引导 agent 自主决定何时枚举、何时求助。待办只留给真正需要用户的事。 */
			return {
				id: goal.id,
				target: goal.target,
				objective: goal.objective,
				...(lessonIndex.length > 0 ? { lessonIndex } : {}),
				...(hasPrior ? { priorContext } : {}),
				...(infraInherited !== void 0 ? { infraInherited } : {}),
				...(capabilities !== void 0 ? { capabilities } : {})
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_intent",
		description: "Record one exploration intent (what to verify / pursue next) as a node in the exploration chain. Automatically routes matching clown-src expert playbooks and returns bounded document pointers/checks. Anchor it with EXACTLY ONE of: goalId (spawns: an intent exploring toward the goal) or derivedFromFactId (derived_from: a new intent derived from a previously recorded fact). The edge kind is recorded automatically.",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "Short intent title (e.g. \"enumerate web endpoints\")."
			},
			detail: {
				type: "string",
				description: "Optional detail (scope, hypothesis, expected evidence)."
			},
			goalId: {
				type: "string",
				description: "锚点：goal 的 id（见 src_add_goal 返回或 src_state）。漏传且 goal 存在时自动锚定；从已落库事实推导时改传 derivedFromFactId。两锚点只传一个。"
			},
			derivedFromFactId: {
				type: "string",
				description: "锚点（可选，替代 goalId）：从某个已落库 fact 推导新意图时传该 fact 的 id。两锚点只允许传一个。"
			},
			priority: {
				type: "number",
				description: "Optional priority 1-9（9 最高），src_state 按降序排列——高产出面排前面。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					playbook: { type: "object", additionalProperties: true, properties: {} },
					edgeId: {
						type: "string",
						required: true
					},
					edgeKind: {
						type: "string",
						required: true
					},
					sourceId: {
						type: "string",
						required: true
					},
					lessonHints: { type: "array", items: { type: "string" } }
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded intent ${v.id}「${v.title}」 (${v.edgeKind} ${v.sourceId} → ${v.id}, edge ${v.edgeId}).${v.lessonHints === void 0 ? "" : `\n${v.lessonHints.join("\n")}`}`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.57] 锚点自愈：中通会话实测模型建 intent 时两锚点全漏（title/detail/priority 齐全但无
			 * goalId），报 exactly-one-anchor 错浪费一整轮重试。goal 是 spawn 锚的自然缺省——锚点缺失且
			 * 当前 goal 存在时自动锚到它（derived_from 语义仍需显式传 factId，不猜）。无 goal 时报错文案
			 * 直接指向 src_add_goal。 */
			if (args.goalId === void 0 && args.derivedFromFactId === void 0) {
				const goal = await store.requireGoal(sessionId).catch(() => void 0);
				if (goal === void 0) throw new Error("src_add_intent 缺少锚点：当前会话还没有 goal，先调 src_add_goal 建目标，再 src_add_intent(goalId=<返回的 goal id>)；从已落库事实推导新意图时传 derivedFromFactId=<fact id>。");
				args = { ...args, goalId: goal.id };
			}
			/* [local.66] 双锚点自愈：hackone 会话（session-f64ff5b1）实测 deepseek-v4 与 glm-5.3-flash 建
			 * 派生 intent 时都系统性把 goalId 和 derivedFromFactId 一起传，报 exactly-one-anchor 错后模型
			 * 自己删一个重传，5 次各浪费一轮。双传时 derived_from 语义更具体（从已落库事实推导）——直接
			 * 弃 goalId 按 fact 锚；fact 不存在时 store 会给出明确的 unknown fact 报错，模型可改传 goalId。 */
			if (args.goalId !== void 0 && args.derivedFromFactId !== void 0) {
				args = { ...args, goalId: void 0 };
			}
			const routed = routePlaybookV2(args.title, args.detail ?? "");
			/* [local.75 Phase 5] Router v2：candidates 带分数（title×3/detail×1），primary=最高分；keys/checks 语义与旧版一致（回归闸测试锁）。 */
			const write = await store.addIntent(sessionId, {
				title: args.title,
				detail: args.detail ?? "",
				...args.goalId !== void 0 ? { goalId: args.goalId } : {},
				...args.derivedFromFactId !== void 0 ? { derivedFromFactId: args.derivedFromFactId } : {},
				...args.priority !== void 0 ? { priority: args.priority } : {},
				playbook: routed
			});
			/* [Phase 1 telemetry] 路由漏斗：offered=建意图时机械路由命中；selected=实际采纳（重复提交不发，防漏斗灌水）。 */
			if (write.duplicate !== true) {
				tel(exec, "route.offered", { candidates: routed.keys, signals: routed.matchedBy, primary: routed.keys[0] ?? "" });
				tel(exec, "route.selected", { skillId: routed.keys[0] ?? "", candidates: routed.keys, reason: "playbook-attach", override: false });
			}
			/* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for intent writes. */
			/* [local.62] 决策点注入：建意图时按标题/详情机械匹配经验触发器，命中即推送（不用模型自觉去搜）。 */
			let lessonHints;
			try { lessonHints = lessonHintLines(await lessonsForContext({ tool: "src_add_intent", text: `${args.title ?? ""} ${args.detail ?? ""}` })); } catch {}
			return {
				id: write.nodeId,
				title: args.title,
				playbook: routed,
				edgeId: write.edge?.id ?? "",
				edgeKind: write.edge?.kind ?? "",
				sourceId: write.edge?.sourceId ?? "",
				...(lessonHints !== void 0 && lessonHints.length > 0 ? { lessonHints } : {})
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_update_intent",
		description: "Update an intent lifecycle or re-plan it (Decide semantics): adjust execution priority (1-9; src_state lists high priority first), or mark consciously abandoned directions as status=deprecated (failed=tried and failed; deprecated=decided not to pursue — does not block finalize and needs no user todo, but record the rationale as a fact). Deprecating a completed intent is rejected.",
		parameters: {
			intentId: { type: "string", required: true, description: "Existing intent id." },
			status: { type: "string", enum: ["planned", "running", "completed", "blocked", "failed", "deprecated"], description: "New lifecycle status. Optional when only adjusting priority." },
			priority: { type: "number", description: "Optional execution priority 1-9 (9 highest). Optional when only changing status." }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Intent ${v.id} updated${v.status !== void 0 ? `: status=${v.status}` : ""}${v.priority !== void 0 ? `, priority=P${v.priority}` : ""}.` }] },
		execute: async (args, exec) => {
			if (args.status === void 0 && args.priority === void 0) throw new Error("src_update_intent requires status or priority");
			if (args.priority !== void 0 && (!Number.isInteger(args.priority) || args.priority < 1 || args.priority > 9)) throw new Error("src_update_intent priority must be an integer in 1..9");
			const sessionId = sessionIdOf(exec);
			if (args.status === "deprecated") {
				const current = (await store.sessionData(sessionId)).intents.find((row) => row.id === args.intentId);
				if (current === void 0) throw new Error(`src: unknown intent ${args.intentId}`);
				if (current.status === "completed") throw new Error(`intent ${args.intentId} 已完成，不能废弃（deprecated 只用于评估后决定不做的方向）`);
			}
			return store.updateIntent(sessionId, args.intentId, args.status, args.priority);
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_fact",
		description: "Record one discovered fact (evidence) yielded by an intent. This is a decision-agent tool; execution subagents submit facts through src_submit.",
		parameters: {
			intentId: {
				type: "string",
				required: true,
				description: "The intent id that yielded this fact (yields edge)."
			},
			detail: {
				type: "string",
				required: true,
				description: "The fact content (e.g. \"tcp/80 open\", \"login endpoint returns 200 on default creds\")."
			},
			kind: {
				type: "string",
				enum: FACT_KINDS,
				description: "Fact kind (default info)."
			},
			target: {
				type: "string",
				description: "Host/URL/service this fact refers to."
			},
			confidence: {
				oneOf: [{
					type: "number",
					description: "Confidence 0..1, or 0..100 as a percentage."
				}, {
					type: "string",
					description: "Percentage such as \"90%\"."
				}],
				description: "Confidence (default 0.5)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					kind: {
						type: "string",
						required: true
					},
					detail: {
						type: "string",
						required: true
					},
					edgeId: {
						type: "string",
						required: true
					}
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded fact ${v.id} [${v.kind}] ${v.detail} (edge ${v.edgeId}).`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const write = await store.addFact(sessionId, {
				intentId: args.intentId,
				kind: args.kind ?? "info",
				target: args.target ?? "",
				detail: args.detail,
				confidence: confidenceValue(args.confidence)
			});
			/* [Phase 1 telemetry] 证据写入漏斗点。 */
			if (write.duplicate !== true) tel(exec, "evidence.created", { evidenceType: "fact", evidenceId: write.nodeId, intentId: args.intentId, kind: args.kind ?? "info" });
			/* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for fact writes. */
			return {
				id: write.nodeId,
				kind: args.kind ?? "info",
				detail: args.detail,
				edgeId: write.edge?.id ?? ""
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_finding",
		description: "Record one PROVED vulnerability finding (proves edge). 准入闸（#11b）：未授权可达+可复现 PoC 即可入库，severity 如实标 low 起评；medium 及以上必须危害链三要素齐备（victimImpact/attackPrerequisites/concreteLossEvidence），三要素也是 low 升危 medium+ 的依据。仅配置缺陷无 PoC 的信号不是 finding：改记 src_record_research 或建 src_user_todo；severity 无 info 级。",
		parameters: {
			intentId: {
				type: "string",
				required: true,
				description: "The intent id that proved this finding (proves edge)."
			},
			title: {
				type: "string",
				required: true,
				description: "Short finding title (e.g. \"SQL injection in /search\")."
			},
			severity: {
				type: "string",
				required: true,
				enum: SEVERITIES,
				description: "Severity: critical / high / medium / low。无 info 级——仅配置缺陷/头反射无敏感数据证明的信号改记 research，不进漏洞清单。"
			},
			impact: { type: "string", required: true, description: "危害论证①攻击者能力：如何构造利用（恶意页面/请求）、实际拿到什么数据或权限、危害哪些用户/业务；纯配置问题或信息罗列不算。≥40字。" },
			victimImpact: { type: "string", description: "[local.67 #11b] medium 及以上必填（三要素①受害者视角：谁受害、需要做什么（或完全无交互）、损失什么、是否可察觉；≥30字）。low 可缺省：未授权可达+PoC 即可入库，如实标 low；三要素是 low 升危 medium+ 的依据。" },
			attackPrerequisites: { type: "string", description: "危害论证③利用前提（强烈建议提供，漏传存空）：钓鱼页托管域要求（厂商 SRC 是否要求自有域）、需登录哪个业务/账号类型、需要的用户动作；若漏洞需登录必须注明登录入口 URL（厂商复现要先登录才能到达漏洞点）。前提不满足时不得提交（如厂商要求自有域而利用需任意外域）。" },
			concreteLossEvidence: { type: "array", description: "[local.67 #11b] medium 及以上必填（三要素③实际损失证据指针：至少一条指向本会话真实 fact/observation/research 的 id，其内容须含敏感响应体或外带记录；仅请求头/响应头反射变化的证据不算）。low 可缺省，提供时服务端校验存在性。", items: { type: "string" } },
			affectedScope: { type: "string", required: true, description: "影响范围：受影响的用户/记录/主机/端点。" },
			remediation: { type: "string", required: true, description: "修复建议。" },
			entryPoint: { type: "string", description: "前端功能点：web 漏洞必填，漏洞入口的前端页面/功能（如“找回密码页-手机号输入框”、“个人中心-修改头像弹窗”）。厂商复现需先从前端到达漏洞点，仅给接口不够（接口可能本就公开）。" },
			discoveryPath: { type: "string", description: "漏洞接口来源链：该接口如何被发现（如“React chunk 解析 / mobile/js/app.js → api/resetPwd”或“Burp proxy history 导入”）。" },
			rawRequest: { type: "string", description: "Burp 格式 raw 请求报文（必填门禁：报告 finalize 会拦截空 rawRequest；至少含接口地址）。" },
			rawResponse: { type: "string", description: "关键响应 raw 报文（Burp 格式）。" },
			pocEvidence: { type: "array", required: true, description: "POC 证据，补充证据；数据包主字段用 rawRequest。", items: { type: "string" } },
			reproducibleSteps: {
				type: "array",
				required: true,
				description: "Ordered steps that reproduce the vulnerability (commands, requests, actions). At least one step is required (enforced at the durable boundary).",
				items: { type: "string" }
			},
			description: {
				type: "string",
				description: "Impact / root-cause description."
			},
			attackChain: {
				type: "string",
				description: "[local.26] 攻击链叙事（多跳/组合利用时必填）：从发现→利用前提→利用过程→实际损失→受害者影响，串成一条闭合链；单步漏洞可不填，报告会由各字段拼接。用户打回「没看懂攻击链」时用 src_update_finding 补此字段重提。"
			},
			vulnType: {
				type: "string",
				description: "[local.26] 漏洞/情报类型（报告提交模板用）：该漏洞的类别名称，如「登录认证漏洞」「越权漏洞」「信息泄露」「短信轰炸」「文件上传漏洞」「SSRF」「XSS」等。用于报告「漏洞/情报类型」行。"
			},
			pocScript: {
				type: "string",
				description: "[local.27] 一键 PoC 脚本（报告以 ``` 代码块渲染，保留缩进与换行）：可直接运行的利用脚本（Python/Bash/curl 等），含参数说明与注释。用户打回「写个一键脚本」时用 src_update_finding 补此字段。"
			},
			affectedAssetId: {
				type: "string",
				description: "Optional asset id this finding affects."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					severity: {
						type: "string",
						required: true
					},
					edgeId: {
						type: "string",
						required: true
					}
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded finding ${v.id} [${v.severity}] ${v.title} (edge ${v.edgeId}).`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const write = await store.addFinding(sessionId, {
				intentId: args.intentId,
				title: args.title,
				severity: args.severity,
				description: args.description ?? "",
				impact: args.impact,
				victimImpact: typeof args.victimImpact === "string" ? args.victimImpact : "",
				attackPrerequisites: typeof args.attackPrerequisites === "string" ? args.attackPrerequisites : "",
				concreteLossEvidence: Array.isArray(args.concreteLossEvidence) ? args.concreteLossEvidence : [],
				affectedScope: args.affectedScope,
				remediation: args.remediation,
				pocEvidence: args.pocEvidence,
				reproducibleSteps: args.reproducibleSteps,
				entryPoint: args.entryPoint ?? "",
				discoveryPath: args.discoveryPath ?? "",
				rawRequest: args.rawRequest ?? "",
				rawResponse: args.rawResponse ?? "",
				attackChain: args.attackChain ?? "",
				vulnType: args.vulnType ?? "",
				pocScript: args.pocScript ?? "",
				...args.affectedAssetId !== void 0 ? { affectedAssetId: args.affectedAssetId } : {}
			});
			/* [Phase 1 telemetry] finding 写入 + proves 关联边（finding_rate 漏斗的产出锚点）。 */
			if (write.duplicate !== true) {
				tel(exec, "evidence.created", { evidenceType: "finding", evidenceId: write.nodeId, intentId: args.intentId, severity: args.severity });
				tel(exec, "evidence.linked", { sourceId: args.intentId, targetId: write.nodeId, relation: "proves" });
			}
			/* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for finding writes. */
			return {
				id: write.nodeId,
				title: args.title,
				severity: args.severity,
				edgeId: write.edge?.id ?? ""
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_asset",
		description: "Register one engagement asset: root-domain, subdomain, ip, service, app, endpoint, mini-program, client, firmware, ai-surface, threat-intel. 授权边界（资产清单即许可）：探测类工具按「goal 主域内或资产清单内」放行，主域外 host 必须先登记。归属三档：明显属于目标组织→confirmed 直接登记（source 写判定依据）；疑似无法公开验证→改调 src_request_asset_confirm 请用户确认整域；确定不属于→不登记；禁止把疑似登 confirmed 蒙混。source 必填（crt.name/certspotter/FOFA/DNS/JS 提取/品牌归属判断等审计线索）；重复登记合并只升状态；excluded 不作为授权依据。parentId 只能引用委派中已提供的资产 ID，先登记父资产再引用返回 id；不确定就省略，禁止臆造 ID。",
		parameters: {
			type: {
				type: "string",
				required: true,
				enum: ASSET_TYPES,
				description: "Asset type: root-domain / subdomain / ip / service / app / endpoint."
			},
			value: {
				type: "string",
				required: true,
				description: "The asset value (e.g. \"example.com\", \"192.0.2.5\", \"nginx/1.24\"). host 形态的值用于授权匹配（https://ai.mi.test/ 或 ai.mi.test 均可）。"
			},
			source: {
				type: "string",
				required: true,
				description: "发现/归属判定来源与依据（必填，审计线索：crt.name/certspotter/FOFA/DNS/JS 提取/品牌归属判断等）。"
			},
			parentId: {
				type: "string",
				description: "Optional parent asset id (parent edge, e.g. the subdomain owning this endpoint)."
			},
			method: {
				type: "string",
				description: "发现方式（默认 passive；自由文本如 active/manual/low-impact）。"
			},
			confidence: {
				type: "number",
				description: "置信度 0..1（默认 0.5）。"
			},
			status: {
				type: "string",
				enum: ["candidate", "confirmed", "excluded"],
				description: "状态：candidate=被动发现待核实，confirmed=已核实（默认），excluded=判定排除（不作为授权依据）。"
			},
			meta: {
				type: "string",
				description: "Optional free-form metadata (version, technology, note)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					duplicate: { type: "boolean" },
					type: {
						type: "string",
						required: true
					},
					value: {
						type: "string",
						required: true
					},
					assetHost: { type: "string" },
					edgeId: { type: "string" }
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded asset ${v.id} [${v.type}] ${v.value}${v.edgeId === void 0 ? "" : ` (parent edge ${v.edgeId})`}${v.assetHost === void 0 ? "" : `；授权匹配 host: ${v.assetHost}（探测类工具按资产清单放行该 host，excluded 除外）`}.`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.43] 沿 parentSession 链解析 engagement 会话：子代理（recon/audit）登记也写入同一份
			 * 资产清单——授权闸（assetGrantHostsFor）读的就是 engagement 会话的 assets。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const assetWrite = {
				type: args.type,
				value: args.value,
				...(args.parentId !== void 0 ? { parentId: args.parentId } : {}),
				meta: args.meta ?? "",
				source: requiredString(args.source, "source"),
				method: args.method ?? "passive",
				confidence: args.confidence ?? .5,
				status: args.status ?? "confirmed"
			};
			const write = await store.addAsset(engagementId ?? sessionId, assetWrite);
			/* [local.57] 委托写入的投影对齐：子代理把资产写入 engagement（父）单元后，父会话事件日志里
			 * 并没有这条 src_add_asset 事件（常规 tool/call 只落在子代理自己的日志）——历史加载按父日志
			 * fold，子代理登记的资产会全部消失（中通会话 asset-44..57 实测漂移）。跨会话写入补合成投影事件。 */
			if (engagementId !== void 0 && engagementId !== sessionId) {
				appendSessionToolEvent(ctx.sessions.get(engagementId), "src_add_asset", assetWrite);
			}
			/* [local.68 #1] 触发器引擎已拆：能力触发编排（发现资产自动挂待办）是「发现什么就加编排」
			 * 模式的唯一幸存实例，与「拆编排、保引导」路线冲突——能力清单 when+枚举纪律承接同一语义
			 * （登记 mini-program 资产后由 agent 按 src_user_todo 枚举纪律自行挂待办）。git revert 可整体找回。 */
			const assetHosts = assetGrantHosts([{ value: args.value, status: args.status ?? "confirmed" }]);
			return {
				id: write.nodeId,
				duplicate: write.duplicate === true,
				type: args.type,
				value: args.value,
				...assetHosts.length > 0 ? { assetHost: assetHosts[0] } : {},
				...write.edge !== void 0 ? { edgeId: write.edge.id } : {}
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_state",
		description: "Read the current src state for this session: goal, node counts, and short node/asset listings. Call this to decide the next exploration step.",
		parameters: {
			detail: { type: "string", enum: ["summary", "evidence", "orchestration", "legacy"], description: "视图模式：summary=决策最小视图（evidenceIndex 索引+行动项，正文按 id 用 src_get_evidence 拉取）；evidence=证据视图（最近 12 条事实全文+finding 证据指针全量）；orchestration=编排视图（intents 生命周期+孤儿/委托/待办/待审批）；legacy=v1 全量视图。缺省按 DSH_SRC_STATE_VERSION（默认 v1/legacy）。" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				description: "v1 legacy 视图（additionalProperties 覆盖 v2 字段）；detail=summary/evidence/orchestration 时返回 v2 结构化字段（version/view/nextActions/blockedReasons/runningWork/evidenceIndex/findings/skillHints/finalizeBlockers/warnings/recentFacts）。",
				properties: {
					version: { type: "number" },
					view: { type: "string" },
					initialized: {
						type: "boolean"
					},
					goal: {
						type: "object",
						additionalProperties: true,
						properties: {}
					},
					counts: {
						type: "object",
						additionalProperties: true,
						properties: {}
					},
					intents: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					facts: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					factsOmitted: { type: "number" },
					findings: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					checkpoints: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					assets: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					apiDiscovery: { type: "object", additionalProperties: true, properties: {} },
					coverage: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					research: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					observations: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					userTodos: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					pendingApprovals: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					orphanIntents: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					delegationState: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					runtimeChildren: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					unassignedRuntimeChildren: { type: "array", items: { type: "string" } },
					testAccounts: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					domainNotes: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
					authBudget: { type: "object", additionalProperties: true, properties: {} },
					assetScope: { type: "object", additionalProperties: true, properties: {} },
					assetGaps: { type: "object", additionalProperties: true, properties: {} },
					infra: { type: "object", additionalProperties: true, properties: {} },
					edges: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					}
				}
			},
			render: (_a, v) => {
				const view = v;
				/* [Phase 2] v2 结构化视图渲染：紧凑摘要行（正文已按视图裁剪）。 */
				if (view.version === 2) {
					const label = view.view === "evidence" ? "证据视图" : view.view === "orchestration" ? "编排视图" : "决策视图";
					const next = (view.nextActions ?? []).map((row) => `${row.id}[${row.status}]`).join(";");
					const omitted = view.evidenceIndex?.omitted ?? 0;
					return [{ type: "text", text: `SRC 状态（${label} v2）：${view.counts?.intents ?? 0} intents / ${view.counts?.facts ?? 0} facts / ${view.counts?.findings ?? 0} findings${next ? ` | 下一步 ${next}` : ""}${omitted > 0 ? ` | 省略 ${omitted} 条事实（按 id 用 src_get_evidence 拉正文）` : ""}` }];
				}
				if (!view.initialized || view.goal === void 0) return [{
					type: "text",
					text: "Not initialized. Call src_add_goal with target and objective."
				}];
				const goal = view.goal;
				const join = (rows) => rows.join("; ") || "none";
				const playbookOf = (intent) => intent.playbook?.keys?.length ? `专题=${intent.playbook.keys.join("+")}；先读=${intent.playbook.docs.slice(-2).join(",")}；首轮=${intent.playbook.checks.slice(0, 2).join(" / ")}` : "";
				const api = view.apiDiscovery ?? { total: 0, schemas: 0, graphql: 0, hints: 0, untouched: 0, examples: [] };
				const pendingTodos = (view.userTodos ?? []).filter((row) => row.status === "pending");
				const todoNote = pendingTodos.length ? ` Pending user todos (${pendingTodos.length}): ${pendingTodos.map((row) => `${row.id}「${row.title}」`).join("; ")}.` : "";
				const pendingApprovalRows = (view.pendingApprovals ?? []).filter((row) => row.status === "pending");
				const approvalNote = pendingApprovalRows.length ? ` Pending approvals (${pendingApprovalRows.length}): ${pendingApprovalRows.map((row) => `${row.id}「${row.method} ${row.url}」`).join("; ")}. Ask the user to approve/reject via the 待审 panel or src_resolve_approval.` : "";
				const orphanNote = (view.orphanIntents ?? []).length ? ` Orphan running intents (${view.orphanIntents.length}): ${view.orphanIntents.map((o) => o.hint).join(" | ")}. Handle each per its hint now (src_recover_child or record a fact and mark failed); do NOT keep waiting on running status.` : "";
				const delegationNote = (view.delegationState ?? []).length ? ` Delegation: ${view.delegationState.map((d) => `${d.intentId}[${d.status}]${d.childSessionIds?.length ? `(${d.childSessionIds.join(",")})` : ""}`).join("; ")}.` : "";
				const scopeNote = ` 授权边界：资产清单即许可——可测 host ${view.assetScope.grantableHosts} 个，跨 ${view.assetScope.distinctDomains} 个主域（${view.assetScope.topDomains.map((t) => `${t.host}×${t.count}`).join(", ") || "无"}）。清单外 host 先 src_add_asset 登记（source 写判定依据）再探测。`;
				/* [local.63] 资产类缺口注脚：结构化回答「还有什么没测」。 */
				const assetGapsNote = view.assetGaps === void 0 ? "" : (view.assetGaps.gaps.length > 0 ? ` 资产类缺口：${view.assetGaps.gaps.join("、")}（先自行枚举登记——小程序扫本机微信包、App 抔下载反编译、子域走被动侦察，穷尽自身手段拿不到才挂待办找用户）。` : ` 资产类覆盖：核心四类全有登记。`);
				const factsNote = (view.factsOmitted ?? 0) > 0 ? ` Facts omitted: ${view.factsOmitted}（只列最近 24 条与 P≥8 意图下的事实；全量用 src_graph）.` : "";
				return [{
					type: "text",
					text: `Target: ${goal.target} | Objective: ${goal.objective} | ${view.counts.intents} intents, ${view.counts.facts} facts, ${view.counts.findings} findings, ${view.counts.assets} assets. API discovery: total=${api.total}, schemas=${api.schemas}, graphql=${api.graphql}, hints=${api.hints}, untouched=${api.untouched}${api.examples?.length ? `, examples=${api.examples.join(", ")}` : ""}. Intents: ${join([...view.intents].sort((a, b) => (b.priority ?? 5) - (a.priority ?? 5) || a.id.localeCompare(b.id, "en")).map((i) => `${i.id}「${i.title}」${i.status !== "planned" ? `[${i.status}]` : ""}${i.priority !== void 0 ? `[P${i.priority}]` : ""}${playbookOf(i) ? `{${playbookOf(i)}}` : ""}`))}. Facts: ${join(view.facts.map((f) => `${f.id} [${f.kind}] ${f.detail}`))}. Findings: ${join(view.findings.map((f) => `${f.id} [${f.severity}] ${f.title}`))}. Assets: ${join(view.assets.map((a) => `${a.id} [${a.type}] ${a.value}`))}.${factsNote}${todoNote}${approvalNote}${orphanNote}${delegationNote}${scopeNote}${assetGapsNote}`
				}];
			}
		},
		presentResult: (_args, result) => titledCard("SRC 漏洞挖掘状态", result),
		execute: async (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			const view = await store.view(sessionId);
			/* [Phase 3] Orchestrator shadow（手册 §6）：每次 src_state 视为调度器观测点——
			 * 只计算建议并发旁路事件（DSH_SRC_ORCHESTRATOR=off 时零开销），不执行任何状态写入、
			 * 不轮询、不重发。建议同时附在 v2 orchestration 视图（shadowSuggestions）供人/模型
			 * 对照实际行为；对比报表由 aggregate-src-telemetry.mjs 产出。 */
			const orchFlag = srcOrchestratorFlag();
			let shadowSuggestions = [];
			if (orchFlag !== "off") {
				try {
					const plan = computeSuggestions({
						intents: view.intents ?? [],
						checkpoints: view.checkpoints ?? [],
						pendingApprovals: view.pendingApprovals ?? [],
						userTodos: view.userTodos ?? []
					});
					shadowSuggestions = plan.suggestions;
					for (const s of shadowSuggestions) {
						tel(exec, "orchestrator.suggestion", { kind: s.kind, intentId: s.intentId, from: s.from, to: s.to, reason: s.reason, dedupeKey: s.dedupeKey, priority: s.priority, ...(s.warnings?.length ? { warnings: s.warnings } : {}) });
					}
				} catch {}
			}
			const coverage = view.coverage ?? [];
			const research = view.research ?? [];
			const apiAssets = (view.assets ?? []).filter((asset) => asset.type === "endpoint" && typeof asset.meta === "string" && asset.meta.startsWith("api:"));
			/* [local.77 §10.3] 五条一致性断言观测点（DSH_SRC_EVENT_STORE=off 零开销；shadow/on 发
			 * projection.divergence 旁路事件，永不阻塞工具路径）。断言失败不修正、只观测。 */
			if (srcEventStoreFlag() !== "off") {
				try {
					const allRows = [ ...(view.intents ?? []), ...(view.facts ?? []), ...(view.findings ?? []), ...(view.assets ?? []), ...(view.checkpoints ?? []), ...(view.pendingApprovals ?? []), ...(view.userTodos ?? []) ];
					const problems = assertStoreProjectionConsistency({ intents: view.intents, findings: view.findings, checkpoints: view.checkpoints, pendingApprovals: view.pendingApprovals, allRows }, { findings: view.findings, blockedReasons: (view.pendingApprovals ?? []).filter((row) => row.status === "pending").map((row) => row.id), evidenceLinks: [], allRows: allRows });
					for (const p of problems) {
						tel(exec, "projection.divergence", { rule: p.rule, detail: p.detail });
					}
				} catch {}
			}
			const untouched = apiAssets.filter((asset) => {
				const assetCoverage = coverage.filter((row) => row.assetId === asset.id);
				const hasProgress = assetCoverage.some((row) => ["running", "completed", "blocked", "not-applicable"].includes(row.status));
				const assetResearch = research.filter((row) => (row.evidence ?? []).some((evidence) => evidence.includes(asset.value)) || row.hypothesis.includes(asset.value));
				const hasManualResearchProgress = assetResearch.some((row) => row.status !== "hypothesis" || !(row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				return !hasProgress && !hasManualResearchProgress;
			});
			/* [local.40] 孤儿 running intent 巡检：web 重启/子代理死亡后父代理对着 running 干等是已知卡死模式。
			 * 判据（纯数据，不依赖宿主运行时）：running intent 无任何 checkpoint，或最新 checkpoint 停在
			 * progress（无 completed/failed/blocked 收尾）且距今 ≥30 分钟。 */
			const ORPHAN_IDLE_MS = 30 * 60 * 1000;
			const now = Date.now();
			let runtimeChildren = [];
			let runtimeChildrenAvailable = false;
			if (typeof ctx.subagents?.listChildren === "function") {
				try {
					const listed = await ctx.subagents.listChildren(sessionId, exec.signal);
					runtimeChildren = (Array.isArray(listed) ? listed : []).map((entry) => entry.kind === "child"
						? { id: String(entry.id), mode: entry.mode, activity: entry.activity, ...(entry.label ? { label: entry.label } : {}) }
						: { id: String(entry.id), status: "diagnostic", reason: entry.reason });
					runtimeChildrenAvailable = true;
				} catch {
					/* Runtime enumeration is advisory; checkpoint-based state remains authoritative. */
				}
			}
			const childById = new Map(runtimeChildren.filter((entry) => entry.status !== "diagnostic").map((entry) => [entry.id, entry]));
			const unassignedRuntimeChildren = runtimeChildren.filter((entry) => entry.status !== "diagnostic").map((entry) => entry.id);
			const delegationState = (view.intents ?? []).map((intent) => {
				const checkpoints = (view.checkpoints ?? []).filter((checkpoint) => checkpoint.intentId === intent.id);
				const childSessionIds = [...new Set(checkpoints.map((checkpoint) => checkpoint.childSessionId).filter(Boolean))];
				const runtime = childSessionIds.map((id) => childById.get(id)).filter(Boolean);
				let status = intent.status;
				if (intent.status === "running") status = checkpoints.length === 0 ? "not-started" : "progress-unfinished";
				if (intent.status === "running" && runtime.some((entry) => entry.activity === "running")) status = "running";
				if (intent.status === "running" && runtime.some((entry) => entry.activity === "inactive") && status === "not-started") status = "ready";
				return { intentId: intent.id, title: intent.title, status, childSessionIds, ...(runtime.length > 0 ? { runtime } : {}), ...(runtimeChildrenAvailable ? { runtimeObserved: true } : {}) };
			});
			const orphanIntents = (view.intents ?? []).filter((intent) => intent.status === "running").map((intent) => {
				const checkpoints = (view.checkpoints ?? []).filter((c) => c.intentId === intent.id);
				if (checkpoints.length === 0) {
					/* [local.42] lossless 边界：无 checkpoint 分支的字段不落 undefined 键（同 src_list_capabilities 修复）。 */
					return { intentId: intent.id, title: intent.title, hint: `${intent.id}「${intent.title}」running 但无任何 checkpoint（子代理从未汇报或重启丢失）→ 若已知 childSessionId 用 src_recover_child 唤醒（从未提交过 checkpoint 也可唤醒），否则新建 intent 重新委派` };
				}
				const last = checkpoints.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
				const idle = now - last.createdAt;
				if (last.stage === "progress" && idle >= ORPHAN_IDLE_MS) {
					const minutes = Math.round(idle / 60000);
					return { intentId: intent.id, title: intent.title, childSessionId: last.childSessionId, lastStage: last.stage, lastCheckpointAt: last.createdAt, idleMinutes: minutes, hint: `${intent.id}「${intent.title}」running 但子代理 ${last.childSessionId} 已失联 ${minutes} 分钟（最后 checkpoint ${last.id} 停在 progress 未收尾）→ 先 src_recover_child(childSessionId="${last.childSessionId}", intentId="${intent.id}") 唤醒补收尾；唤醒失败则把 checkpoint 已有结论落 fact、intent 标 failed、剩余范围新建 intent` };
				}
				return null;
			}).filter((row) => row !== null);
			const assetScopeHosts = assetGrantHosts(view.assets ?? []);
			const assetScopeDomains = new Map();
			for (const scopeHost of assetScopeHosts) {
				const base = scopeHost.split(".").slice(-2).join(".");
				assetScopeDomains.set(base, (assetScopeDomains.get(base) ?? 0) + 1);
			}
			const scopeAssets = view.assets ?? [];
			/* [local.63] 资产类覆盖缺口（机械）：核心四类对照已登记资产。问「还有什么没测」永远有结构化答案——
			 * 「图里没有」不等于「世界里没有」，缺口类先自行枚举登记再谈测完。 */
			const ASSET_GAP_CLASSES = ["root-domain", "subdomain", "app", "mini-program"];
			const gapTypeCounts = {};
			for (const a of scopeAssets) gapTypeCounts[a.type] = (gapTypeCounts[a.type] ?? 0) + 1;
			const assetGaps = { present: ASSET_GAP_CLASSES.filter((t) => (gapTypeCounts[t] ?? 0) > 0).map((t) => ({ type: t, count: gapTypeCounts[t] })), gaps: ASSET_GAP_CLASSES.filter((t) => (gapTypeCounts[t] ?? 0) === 0) };
			const assetScope = { model: "asset-inventory", totalAssets: scopeAssets.length, grantableHosts: assetScopeHosts.length, distinctDomains: assetScopeDomains.size, topDomains: [...assetScopeDomains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([host, count]) => ({ host, count })), byStatus: { candidate: scopeAssets.filter((asset) => asset.status === "candidate").length, confirmed: scopeAssets.filter((asset) => asset.status === "confirmed").length, excluded: scopeAssets.filter((asset) => asset.status === "excluded").length } };
			/* [local.67 #12] src_state 输出预算（顺丰实证：97-fact 图全量渲染 → compaction×6 → 终局 oversized）。
			 * 事实分级：只出最近 24 条与 P≥8 意图下的事实，其余给计数+src_graph 指引；
			 * 输出侧减法与 #17 截断/去重同属一轮。finding 素材类事实（被 finding 引用）永不省略。 */
			const SRC_STATE_FACT_LIMIT = 24;
			const allFacts = view.facts ?? [];
			const intentPriorityById = new Map((view.intents ?? []).map((intent) => [intent.id, intent.priority ?? 5]));
			const findingEvidenceIds = new Set((view.findings ?? []).flatMap((f) => Array.isArray(f.pocEvidence) ? f.pocEvidence : []));
			const keptFacts = allFacts.filter((fact, index) => index >= allFacts.length - SRC_STATE_FACT_LIMIT || (intentPriorityById.get(fact.intentId) ?? 5) >= 8 || findingEvidenceIds.has(fact.id));
			const factsOmitted = allFacts.length - keptFacts.length;
			const legacyView = {
				...view,
				facts: keptFacts,
				...(factsOmitted > 0 ? { factsOmitted } : {}),
				orphanIntents,
				delegationState,
				runtimeChildren,
				unassignedRuntimeChildren,
				assetScope,
				assetGaps,
				apiDiscovery: {
					total: apiAssets.length,
					schemas: apiAssets.filter((asset) => asset.meta.startsWith("api:openapi-schema") || asset.meta.startsWith("api:schema-path")).length,
					graphql: apiAssets.filter((asset) => asset.meta.startsWith("api:graphql-endpoint")).length,
					hints: apiAssets.filter((asset) => asset.meta.startsWith("api:html-js-hint")).length,
					untouched: untouched.length,
					examples: apiAssets.slice(0, 5).map((asset) => asset.value)
				}
			};
			/* [Phase 2] v2 结构化视图：summary/evidence/orchestration 三视图。
			 * 默认仍是 v1（DSH_SRC_STATE_VERSION=2 或 detail= 显式切换；v1 兼容窗口 30 天）。
			 * 事实分级：summary 只给 evidenceIndex 索引（recent 12 + byIntent 计数）；
			 * finding 引用的证据指针全量透传（medium+ 报告与 finalize 依赖）；
			 * 正文按 id 用 src_get_evidence 拉取，不再整图渲染。 */
			const requestedDetail = String(_args.detail ?? "");
			const detailMode = requestedDetail === "summary" || requestedDetail === "evidence" || requestedDetail === "orchestration" || requestedDetail === "legacy" ? requestedDetail : srcStateVersionFlag() === "2" ? "summary" : "legacy";
			if (detailMode === "legacy") return legacyView;
			const goal2 = view.goal === void 0 ? null : { id: view.goal.id, target: view.goal.target, objective: view.goal.objective };
			const RECENT_EVIDENCE_LIMIT = 12;
			const allFacts2 = view.facts ?? [];
			const recentFacts2 = allFacts2.slice(-RECENT_EVIDENCE_LIMIT);
			const byIntent2 = {};
			for (const fact of allFacts2) {
				const bucket = byIntent2[fact.intentId] ?? (byIntent2[fact.intentId] = { count: 0, lastId: fact.id });
				bucket.count += 1;
				bucket.lastId = fact.id;
			}
			const evidenceIndex2 = { recent: recentFacts2.map((fact) => fact.id), byIntent: byIntent2, omitted: Math.max(0, allFacts2.length - RECENT_EVIDENCE_LIMIT) };
			/* finding 证据永不裁剪：指针数组全量透传。 */
			const findings2 = (view.findings ?? []).map((finding) => ({ id: finding.id, title: finding.title, severity: finding.severity, status: finding.status, evidence: Array.isArray(finding.pocEvidence) ? finding.pocEvidence : [] }));
			if (detailMode === "evidence") return { version: 2, view: "evidence", initialized: view.initialized, goal: goal2, counts: view.counts, findings: findings2, recentFacts: recentFacts2, evidenceIndex: evidenceIndex2, hint: "recentFacts 为最近 12 条事实全文；更早的按 evidenceIndex 的 id 用 src_get_evidence 拉取正文。" };
			if (detailMode === "orchestration") return { version: 2, view: "orchestration", initialized: view.initialized, goal: goal2, counts: view.counts, intents: (view.intents ?? []).map((intent) => ({ id: intent.id, title: intent.title, status: intent.status, priority: intent.priority ?? 5 })), orphanIntents, delegationState, runtimeChildren, unassignedRuntimeChildren, pendingApprovals: view.pendingApprovals ?? [], userTodos: view.userTodos ?? [], ...(orchFlag !== "off" ? { shadowSuggestions } : {}) };
			const openStatuses2 = ["planned", "running", "blocked"];
			const openIntents2 = (view.intents ?? []).filter((intent) => openStatuses2.includes(intent.status)).sort((a, b) => (b.priority ?? 5) - (a.priority ?? 5));
			const pendingApprovals2 = (view.pendingApprovals ?? []).filter((row) => row.status === "pending");
			const pendingTodos2 = (view.userTodos ?? []).filter((row) => row.status === "pending");
			const blockedReasons2 = [...pendingApprovals2.map((row) => ({ code: "approval.pending", id: row.id, action: "ask-user", reason: `${row.method ?? "GET"} ${row.url ?? ""}` })), ...pendingTodos2.map((row) => ({ code: "user-todo.pending", id: row.id, action: "ask-user", reason: row.title }))];
			const runningWork2 = [...delegationState.filter((row) => row.status === "running").map((row) => ({ intentId: row.intentId, childId: (row.childSessionIds ?? []).join(",") || "", status: "running" })), ...orphanIntents.map((row) => ({ intentId: row.intentId, childId: row.childSessionId ?? "", status: "orphan", hint: row.hint }))];
			const skillHints2 = coverage.filter((row) => row.status !== "completed" && row.status !== "not-applicable").slice(0, 8).map((row) => ({ skillId: row.category || row.phase, reason: `${row.status}${row.limitation ? `：${row.limitation}` : ""}` }));
			const finalizeBlockers2 = [...(blockedReasons2.length > 0 ? [`${blockedReasons2.length} 项挂起等用户（approval/user-todo）——不要干等，继续其他方向`] : []), ...(openIntents2.length > 0 ? [`${openIntents2.length} 个 intent 未收尾（planned/running/blocked）`] : [])];
			const warnings2 = [...(evidenceIndex2.omitted > 0 ? [`facts omitted ${evidenceIndex2.omitted}（只保留最近 12 条索引+byIntent 计数）——按 id 用 src_get_evidence 拉正文`] : [])];
			return { version: 2, view: "summary", initialized: view.initialized, goal: goal2, counts: view.counts, nextActions: openIntents2.slice(0, 8).map((intent) => ({ id: intent.id, kind: "intent", status: intent.status, priority: intent.priority ?? 5, reason: intent.title })), blockedReasons: blockedReasons2, runningWork: runningWork2, evidenceIndex: evidenceIndex2, findings: findings2, skillHints: skillHints2, finalizeBlockers: finalizeBlockers2, warnings: warnings2 };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_get_evidence",
		description: "按 ID 拉取证据正文（fact/obs/finding/asset/research/intent，可混合多个 id）。src_state 的 summary/evidence 视图只给 evidenceIndex 索引，用本工具按 id 取回全文；默认单条 4KB 截断，full:true 放宽到 32KB。",
		parameters: {
			ids: { type: "array", required: true, items: { type: "string" }, description: "证据 id 列表（fact-N / obs-N / finding-N / asset-N / research-N / intent-N），最多 32 个。" },
			full: { type: "boolean", description: "true 时单条上限放宽到 32KB（默认 4KB 截断）。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: (v.items ?? []).map((row) => row.found ? `${row.id}（${row.kind}）${row.truncated ? "［已截断］" : ""}：${row.content}` : `${row.id}：未找到（不在本会话图内）`).join("\n---\n") }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const view = await store.view(sessionId);
			const nodes = [];
			const pushNodes = (kind, rows, format) => { for (const row of rows ?? []) nodes.push({ kind, row, format }); };
			pushNodes("fact", view.facts, (f) => `[${f.factKind ?? "fact"}] ${f.target ?? ""} ${f.detail ?? ""}`.trim());
			pushNodes("obs", view.observations, (o) => `${o.method} ${o.path} → ${o.httpStatus}${o.protectionSignal ? "（防护信号）" : ""} ${o.decision ?? ""} ${o.respBodySnippet ?? ""}`.trim());
			pushNodes("finding", view.findings, (f) => `${f.title}［${f.severity}］${f.impact ?? ""} 证据：${(f.pocEvidence ?? []).join(" | ")}`);
			pushNodes("asset", view.assets, (a) => `${a.type} ${a.value} ${a.meta ?? ""}`.trim());
			pushNodes("research", view.research, (r) => `${r.category} ${r.hypothesis}［${r.status}］证据：${(r.evidence ?? []).join(" | ")}`);
			pushNodes("intent", view.intents, (i) => `${i.title}［${i.status}］${i.detail ?? ""}`);
			const byId = new Map(nodes.map((entry) => [entry.row.id, entry]));
			const limit = args.full === true ? 32000 : 4000;
			const items = (Array.isArray(args.ids) ? args.ids : []).slice(0, 32).map((rawId) => {
				const id = String(rawId ?? "");
				const entry = byId.get(id);
				if (!entry) return { id, found: false };
				const text = entry.format(entry.row);
				const truncated = text.length > limit;
				return { id, found: true, kind: entry.kind, content: truncated ? `${text.slice(0, limit)}\n…[截断] 共 ${text.length} 字符，full:true 可放宽` : text, truncated };
			});
			return { items, missing: items.filter((row) => !row.found).length };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_graph",
		description: "Dump the full exploration graph of this session as JSON: goal, intents, facts, findings, assets, and every edge (spawns / yields / derived_from / proves / parent). Use this to review the chain before reporting.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { graph: {
					type: "object",
					additionalProperties: true,
					properties: {}
				} }
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v.graph)
			}]
		},
		presentResult: (_args, result) => titledCard("SRC 探索图", result),
		execute: async (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			return { graph: buildGraph(await store.view(sessionId)) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_finalize_engagement",
		description: "Run the SRC pre-report acceptance gate. It checks intent completion, unresolved protection decisions, finding evidence, verification coverage, pending user todos, and remaining derivable directions. It does not hide limitations and does not submit to a platform.",
		parameters: {
			remainingDirections: { type: "array", required: true, description: "收官自查（必填）：枚举当前还能推进的方向。非空不拒绝但逐条入收官警告与报告 coverage limitation（须能说清为何不建 intent）；穷尽传 []。同类面内动作归这里；结构性没碰的类别归 blindSpots。", items: { type: "string" } },
			blindSpots: { type: "array", required: true, description: "覆盖维度声明（必填）：期望维度 = 基线 http-authz-surface/cors-headers/dom-xhr/dict-budget/multi-account-cross-authz ∪ 信号派生（wss→websocket；app/mini-program→mobile-api）。每项 {dimension, status, note?, evidenceId?}（dimension 误写 category 自动映射）。缺项被拒；covered 必须带可解析 evidenceId；uncovered 的可行动盲区同回合建 src_user_todo。", items: { type: "object", additionalProperties: false, properties: { dimension: { type: "string", description: "维度名（与 status 同为每项必填；若误传了 category 别名则可省，服务端自动取 category）。" }, category: { type: "string", description: "dimension 的兼容别名：历史模型常把维度名误写进 category，传了它且未传 dimension 时服务端当 dimension 用。" }, status: { type: "string", enum: ["covered", "uncovered", "notApplicable"], required: true }, note: { type: "string" }, evidenceId: { type: "string", description: "covered 必填：指向真实 fact/finding/intent/research 的 id，服务端校验存在性。" } } } },
			allowIncomplete: { type: "boolean", description: "Set true only when the report must document explicit limitations or a human interruption." },
			allowIncompleteReason: { type: "string", description: "Required when allowIncomplete=true. 停止原因（如 WAF 全拦/范围耗尽/用户指示停止），原样进报告受限完成声明。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { ready: { type: "boolean", required: true }, blockers: { type: "array", required: true }, warnings: { type: "array", required: true }, lessonHints: { type: "array", items: { type: "string" } } } }, render: (_a, v) => [{ type: "text", text: `${v.ready ? "SRC engagement ready for report." : `SRC report blockers: ${v.blockers.join("; ")}`} ${v.warnings.length ? `Warnings: ${v.warnings.join("; ")}` : ""}${v.lessonHints === void 0 ? "" : `\n${v.lessonHints.join("\n")}`}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const view = await store.view(sessionId);
			if (view.goal === void 0) throw new Error("src_finalize_engagement requires an initialized SRC goal");
			let incompleteReason = "";
			if (args.allowIncomplete === true) {
				incompleteReason = typeof args.allowIncompleteReason === "string" ? args.allowIncompleteReason.trim() : "";
				if (incompleteReason === "") throw new Error("allowIncomplete=true 时必须提供 allowIncompleteReason（说明为何带限制出报告：WAF 全程拦截/范围耗尽/用户指示停止等）；该声明会作为 coverage 行写入报告的「资产与测试覆盖率」一节");
				const record = await store.upsertCoverage(sessionId, { assetId: void 0, phase: "report", category: "受限完成声明", status: "not-applicable", evidence: [], limitation: incompleteReason });
				if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_record_coverage", { id: record.id, phase: "report", category: "受限完成声明", status: "not-applicable", evidence: [], limitation: incompleteReason, updatedAt: record.updatedAt });
			}
			const blockers = [];
			const warnings = [];
			/* [local.20] 收官三闸：remainingDirections 枚举 / pending 待办 / blocked 无待办。 */
			const directions = Array.isArray(args.remainingDirections) ? args.remainingDirections.filter((d) => typeof d === "string" && d.trim() !== "") : null;
			if (directions === null) throw new Error("src_finalize_engagement 需要 remainingDirections 参数（收官自查）：逐项列出当前还能推进的方向；确已穷尽传空数组 []");
			/* [local.68 #6] 折中：保留必填，但非空数组从「拒绝」降为逐条警告——硬闸只制造摩擦（hackone 实证
			 * 模型会编方向凑数，5 条 running 尾巴没被枚举出来；收官过早由 pending 待办闸拦住）。 */
			if (directions.length > 0) warnings.push(`遗留可推进方向 ${directions.length} 条（不再拦截，但已入收官记录）：${directions.map((d) => `「${d}」→ 已建成 intent 继续推？还是为何不建（超范围/需用户决策/收益不足）`).join("；")}——逐条交代会随本警告返回给用户并建议写入报告 coverage limitation`);
			/* [local.22] 覆盖维度声明闸（blindSpots）：期望维度必须全声明；covered 必须带可解析证据。 */
			const blindSpots = Array.isArray(args.blindSpots) ? args.blindSpots : null;
			if (blindSpots === null) throw new Error("src_finalize_engagement 需要 blindSpots 参数（覆盖维度声明）：逐项声明适用维度的 covered/uncovered/notApplicable；期望维度 = 基线 http-authz-surface/cors-headers/dom-xhr/dict-budget/multi-account-cross-authz ∪ 信号派生（wss 资产→websocket；app/mini-program 资产→mobile-api）。缺项被拒，covered 必须带可解析的 evidenceId");
			const BS_STATUS_MAP = { covered: "completed", uncovered: "blocked", notApplicable: "not-applicable" };
			const declaredDims = /* @__PURE__ */ new Set();
			const validBlindSpots = [];
			for (const entry of blindSpots) {
				if (entry === null || typeof entry !== "object") continue;
				/* [local.58] dimension 误写成 category 的兼容映射（中通会话实测 3 条全用 category 被宿主 schema 拒绝重试浪费一轮；schema 已同步声明 category 别名）。 */
				const dimension = typeof entry.dimension === "string" && entry.dimension.trim() !== "" ? entry.dimension.trim() : typeof entry.category === "string" ? entry.category.trim() : "";
				const status = entry.status;
				if (dimension === "" || !["covered", "uncovered", "notApplicable"].includes(status)) continue;
				declaredDims.add(dimension);
				const evidenceId = typeof entry.evidenceId === "string" ? entry.evidenceId.trim() : "";
				validBlindSpots.push({ dimension, status, note: typeof entry.note === "string" ? entry.note : "", evidenceId });
			}
			/* 期望维度 = 基线 ∪ 信号派生（从投影资产）。 */
			const BLIND_SPOT_BASELINE = ["http-authz-surface", "cors-headers", "dom-xhr", "dict-budget", "multi-account-cross-authz"];
			const expectedDims = new Set(BLIND_SPOT_BASELINE);
			for (const asset of (view.assets ?? [])) {
				const v = (asset.value ?? "").toLowerCase();
				if (/^wss:\/\//.test(v) || asset.type === "endpoint" && /\bws\b|websocket/.test(v)) expectedDims.add("websocket");
				if (asset.type === "app" || asset.type === "mini-program") expectedDims.add("mobile-api");
			}
			const missingDims = [...expectedDims].filter((d) => !declaredDims.has(d));
			if (missingDims.length > 0) blockers.push(`覆盖维度声明缺项：以下适用维度未声明状态（期望 covered/uncovered/notApplicable）：${missingDims.join(", ")}。盲区必须显式可见，不许默认跳过`);
			/* covered 必须带可解析 evidenceId。 */
			const evidenceExists = (id) => {
				if (id === "") return false;
				if ((view.intents ?? []).some((n) => n.id === id)) return true;
				if ((view.facts ?? []).some((n) => n.id === id)) return true;
				if ((view.findings ?? []).some((n) => n.id === id)) return true;
				if ((view.research ?? []).some((r) => r.id === id)) return true;
				return false;
			};
			const noEvidence = validBlindSpots.filter((b) => b.status === "covered" && !evidenceExists(b.evidenceId));
			if (noEvidence.length > 0) blockers.push(`以下维度标 covered 但 evidenceId 缺失或不可解析（必须指向真实 fact/finding/intent/research 的 id）：${noEvidence.map((b) => `${b.dimension}(${b.evidenceId === "" ? "无 evidenceId" : b.evidenceId})`).join(", ")}。「以为测到了」比「没测到」更危险——请提供证据指针或改标 uncovered 并说明原因`);
			/* 启发式警告：wss 资产存在但无相关研究/覆盖记录，提示可能漏测。 */
			if (expectedDims.has("websocket")) {
				const wsResearch = (view.research ?? []).some((r) => /websocket|ws\b/i.test(r.hypothesis)) || (view.coverage ?? []).some((c) => /websocket|ws\b/i.test(c.category));
				const wsEntry = validBlindSpots.find((b) => b.dimension === "websocket");
				if (wsEntry && wsEntry.status === "covered" && !wsResearch) warnings.push(`websocket 维度标 covered 但找不到对应研究/覆盖记录——确认 evidenceId 指向的是真正的 WebSocket 测试证据`);
			}
			/* uncovered 可行动盲区 → 提示同回合建待办（多账号场景是已知高频项）。 */
			const actionableUncovered = validBlindSpots.filter((b) => b.status === "uncovered" && b.dimension === "multi-account-cross-authz");
			if (actionableUncovered.length > 0) {
				const hasAccountTodo = (view.userTodos ?? []).some((t) => /账号|account|越权.*对照|第二.*账号/i.test(t.title + " " + t.detail));
				if (!hasAccountTodo) warnings.push(`multi-account-cross-authz 标 uncovered（缺多账号无法测垂直越权/租户隔离）但未建对应 src_user_todo——请同回合建待办请求用户提供第二测试账号，而非只写进报告尾节`);
			}
			/* 持久化 blindSpots 为 coverage 行（phase=blind-spot，复用现有表免迁移）。 */
			for (const b of validBlindSpots) {
				const record = await store.upsertCoverage(sessionId, { assetId: void 0, phase: "blind-spot", category: b.dimension, status: BS_STATUS_MAP[b.status], evidence: b.evidenceId !== "" ? [b.evidenceId] : [], limitation: b.note });
				if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_record_coverage", { id: record.id, phase: "blind-spot", category: b.dimension, status: BS_STATUS_MAP[b.status], evidence: b.evidenceId !== "" ? [b.evidenceId] : [], limitation: b.note, updatedAt: record.updatedAt });
			}
			const unfinished = view.intents.filter((intent) => !["completed", "blocked", "deprecated"].includes(intent.status)); /* [local.42] deprecated=评估后主动放弃，不算未完成 */
			if (unfinished.length) blockers.push(`未完成 intent: ${unfinished.map((intent) => `${intent.id}/${intent.title}`).join(", ")}`);
			const plannedStale = view.intents.filter((intent) => intent.status === "planned" && !(view.checkpoints ?? []).some((c) => c.intentId === intent.id));
			if (plannedStale.length) warnings.push(`以下 intent 从未委派执行（长期停在 planned，需显式委派或标 deprecated 主动放弃）: ${plannedStale.map((intent) => `${intent.id}/${intent.title}`).join(", ")}`);
			const failed = view.intents.filter((intent) => intent.status === "failed");
			if (failed.length) blockers.push(`失败 intent 未处理: ${failed.map((intent) => intent.id).join(", ")}`);
			const deprecatedIntents = view.intents.filter((intent) => intent.status === "deprecated"); /* [local.42] */
			if (deprecatedIntents.length) warnings.push(`已主动废弃的 intent（Decide 评估后放弃，无需待办；请在报告 coverage limitation 写明放弃依据）: ${deprecatedIntents.map((intent) => `${intent.id}/${intent.title}`).join(", ")}`);
			if (view.goal.authorization === "" && !view.findings.some((f) => f.severity === "critical" || f.severity === "high")) warnings.push("未记录授权说明（SRC 平台注册默认已授权，可忽略）");
			if (view.findings.length === 0) warnings.push("没有确认的 finding，报告将主要记录侦察结果和限制");
			const pendingTodos = (view.userTodos ?? []).filter((todo) => todo.status === "pending");
			if (pendingTodos.length) blockers.push(`存在 ${pendingTodos.length} 个未完成的用户待办（${pendingTodos.map((todo) => `${todo.id}:${todo.title}`).join(", ")}）：有等待用户的操作就不算穷尽——除非其他方向已全部穷尽且确需带限制出报告（传 allowIncomplete），否则应继续推进或等待回注后再收官`);
			/* [local.79] checkpoint 完整性闸：divergence 12 次实证的主通道。 */
			const doneCheckpoints = new Set((view.checkpoints ?? []).filter((c) => c.stage === "completed").map((c) => c.intentId));
			const completedNoCheckpoint = view.intents.filter((intent) => intent.status === "completed" && !doneCheckpoints.has(intent.id) && intent.systemMigration !== true);
			if (completedNoCheckpoint.length > 0) blockers.push(`以下 intent 标 completed 但没有任何 stage=completed 的 checkpoint（委派结果从未回流，"说测完了但实际没测"的主通道）: ${completedNoCheckpoint.map((i) => `${i.id}/${i.title}`).join(", ")}。请补 src_submit(stage=completed, summary=实测结论) 或如实把 intent 改回 running`);
			/* [local.79] 资产覆盖对账：confirmed 资产既无 coverage 行绑定也无 fact 文本提及 → 疑似"登记了没测"。 */
			const coveredAssetIds = new Set(((view.coverage ?? [])).filter((row) => typeof row.assetId === "string" && row.assetId !== "").map((row) => row.assetId));
			const hostOf = (v) => { try { return new URL(/^https?:\/\//.test(v) ? v : `https://${v}`).hostname; } catch { return String(v).toLowerCase(); } };
			const goalHost = hostOf(view.goal.target ?? "");
			for (const asset of view.assets ?? []) {
				if (asset.status !== "confirmed") continue;
				const mentioned = (view.facts ?? []).some((f) => hostOf(asset.value) === hostOf(f.target ?? "") || String(f.detail ?? "").includes(hostOf(asset.value))) || (view.findings ?? []).some((f) => String(f.detail ?? "").includes(hostOf(asset.value)));
				if (!coveredAssetIds.has(asset.id) && !mentioned) warnings.push(`资产 ${asset.id}（${asset.type}: ${asset.value}）已 confirmed 但没有任何 coverage 行绑定、也没有任何 fact/finding 提及——确认是否真的测过；没测就继续测或如实标 excluded`);
			}
			/* [local.79] 范围外候选升级：candidate 状态的主机型资产（goal 域外）必须交给用户拍板，不许悄悄躺平。 */
			const externalCandidates = (view.assets ?? []).filter((a) => a.status === "candidate" && ["subdomain", "root-domain", "ip"].includes(a.type) && (() => { const h = hostOf(a.value); return h !== goalHost && !h.endsWith(`.${goalHost}`); })());
			if (externalCandidates.length > 0) {
				const hasScopeTodo = (view.userTodos ?? []).some((t) => t.status === "pending" && /范围|授权|scope|扩/i.test(`${t.title ?? ""}${t.detail ?? ""}`));
				if (!hasScopeTodo) warnings.push(`发现 ${externalCandidates.length} 个授权范围外的候选主机型资产（${externalCandidates.slice(0, 5).map((a) => a.value).join(", ")}${externalCandidates.length > 5 ? "…" : ""}）但没有对应的范围决策待办——建 src_user_todo 请用户拍板是否扩授权范围，或标 excluded 说明不属于本目标。顺丰教训：隔壁域 8 条 finding 白丢`);
			}
			const blockedIntents = view.intents.filter((intent) => intent.status === "blocked");
			if (blockedIntents.length && (view.userTodos ?? []).length === 0) blockers.push(`以下 intent 标记为 blocked 但从未创建任何用户待办——若阻塞源于缺用户输入（登录态/资产/人工操作），必须先建 src_user_todo（intentId 关联）再收官；若与技术相关请在 coverage limitation 写明依据: ${blockedIntents.map((intent) => `${intent.id}/${intent.title}`).join(", ")}`);
			else if (blockedIntents.length) {
				for (const intent of blockedIntents) {
					const linked = (view.userTodos ?? []).some((todo) => todo.intentId === intent.id || todo.status === "done" || new RegExp(intent.title.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(`${todo.title} ${todo.detail}`));
					if (!linked) warnings.push(`blocked intent ${intent.id}/${intent.title} 没有找到关联的用户待办：若它在等用户输入，请补建 src_user_todo 并用 intentId 关联；若非用户依赖请在 coverage limitation 写明依据`);
				}
			}
			const coverage = view.coverage ?? [];
			if (coverage.length === 0) warnings.push("没有覆盖率记录，无法证明测试范围完整性");
			const incompleteCoverage = coverage.filter((row) => ["planned", "running", "blocked"].includes(row.status));
			if (incompleteCoverage.length) warnings.push(`存在 ${incompleteCoverage.length} 项未完成或受阻的覆盖记录`);
			const research = view.research ?? [];
			const discoveryEndpoints = (view.assets ?? []).filter((asset) => asset.type === "endpoint" && ((asset.meta ?? "").startsWith("api:") || /(openapi|graphql|schema-path|html-js-hint)/i.test(asset.meta ?? "")));
			const untouchedEndpoints = discoveryEndpoints.filter((asset) => {
				const assetCoverage = coverage.filter((row) => row.assetId === asset.id);
				const hasProgress = assetCoverage.some((row) => ["running", "completed", "blocked", "not-applicable"].includes(row.status));
				const assetResearch = research.filter((row) => (row.evidence ?? []).some((evidence) => evidence.includes(asset.value)) || row.hypothesis.includes(asset.value));
				const hasManualResearchProgress = assetResearch.some((row) => row.status !== "hypothesis" || !(row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				return !hasProgress && !hasManualResearchProgress;
			});
			const autoOnlyEndpoints = discoveryEndpoints.filter((asset) => {
				const assetCoverage = coverage.filter((row) => row.assetId === asset.id);
				const assetResearch = research.filter((row) => (row.evidence ?? []).some((evidence) => evidence.includes(asset.value)) || row.hypothesis.includes(asset.value));
				const onlyPlannedCoverage = assetCoverage.length > 0 && assetCoverage.every((row) => row.status === "planned" && (row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				const onlyAutoResearch = assetResearch.length > 0 && assetResearch.every((row) => row.status === "hypothesis" && (row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				return onlyPlannedCoverage && onlyAutoResearch;
			});
			if (untouchedEndpoints.length) blockers.push(`发现 ${untouchedEndpoints.length} 个 API/接口资产尚未进入研究或覆盖推进——收官前必须逐一推进（委派验证）或明确降级理由（传 allowIncomplete 并在 reason 中说明）: ${untouchedEndpoints.slice(0, 5).map((asset) => asset.value).join(", ")}`);
			if (autoOnlyEndpoints.length) blockers.push(`发现 ${autoOnlyEndpoints.length} 个 API/接口资产仍停留在自动生成骨架，尚无人工推进——收官前必须逐一验证或明确降级理由: ${autoOnlyEndpoints.slice(0, 5).map((asset) => asset.value).join(", ")}`);
			/* [local.78 接口对账闸] 「穷尽」从模型自述变成数字对账：带 endpointsTotal/Tested 的 coverage 行，tested 声明
			   与 observations 实际去重 path 数对不上即 blocker。顺丰会话实测教训：claim「30+ 接口全测绘」时 observations
			   去重仅 6 个 path——清单只活在 bash 里，gate 无从发力。现在数字入库，嘴上穷尽立刻现形。 */
			const auditedCoverage = coverage.filter((row) => Number.isFinite(row.endpointsTotal) && row.endpointsTotal > 0);
			if (auditedCoverage.length > 0) {
				/* [local.78] 对账口径 method+path 去重：同 path GET+POST 混测是常态（顺丰会话 118 URL/76 POST），仅按 path 去重会低估实测数误报虚报。 */
				const observedKeys = new Set((view.observations ?? []).map((o) => `${String(o.method ?? "GET")} ${String(o.path ?? "")}`).filter((k) => !k.endsWith(" ")));
				for (const row of auditedCoverage) {
					const claimed = row.endpointsTested ?? 0;
					const skipped = row.endpointsSkipped ?? [];
					const accounted = claimed + skipped.length;
					if (claimed > observedKeys.size) {
						blockers.push(`coverage ${row.id}（${row.phase}/${row.category}）声明实测 ${claimed} 个接口，但 observations 里去重 method+path 仅 ${observedKeys.size} 个——实测数与请求记录对不上，请补 src_record_observation 或如实下调 endpointsTested`);
					}
					if (accounted < row.endpointsTotal) {
						blockers.push(`coverage ${row.id}（${row.phase}/${row.category}）对账缺口：清单 ${row.endpointsTotal} = 实测 ${claimed} + 跳过 ${skipped.length} 差 ${row.endpointsTotal - accounted} 个未说明去向——补全 endpointsSkipped 或继续测试后收官`);
					}
					if (skipped.length > 0 && row.status === "completed") {
						warnings.push(`coverage ${row.id} 标 completed 但跳过了 ${skipped.length} 个接口（${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}）——报告需如实列出未测清单，不得声明穷尽`);
					}
				}
			}
			/* [local.79] 通道收归提示：有对账数字但 observations 稀疏 = 关键请求绕过了受控通道。 */
			if (auditedCoverage.length > 0 && (view.observations ?? []).length < 5) warnings.push(`coverage 已声明接口对账数字，但 observations 仅 ${(view.observations ?? []).length} 条——大量测试请求疑似绕过 src_http 走了裸 curl，审计链路缺失。收官前用 src_http 重放关键请求（同 method+path 各一条即可），否则报告证据不可复现`);
			const openResearch = research.filter((row) => ["hypothesis", "testing"].includes(row.status));
			if (openResearch.length) blockers.push(`存在 ${openResearch.length} 个未完成漏洞研究假设`);
			const unverifiedFindings = view.findings.filter((finding) => !research.some((row) => row.status === "verified" && row.findingId === finding.id));
			if (unverifiedFindings.length) blockers.push(`finding 缺少独立 verified 研究记录: ${unverifiedFindings.map((finding) => finding.id).join(", ")}。须先委派 src_verify 子代理独立复核，并以 src_record_research(status=verified, findingId=…) 关联后再 finalize；确需带限制停止则传 allowIncomplete=true 并附 allowIncompleteReason`);
			const mediumPlusFindings = view.findings.filter((f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium");
			if (view.findings.length > 0 && mediumPlusFindings.length === 0) warnings.push("仅存在 low 级 finding：未授权可达类如实标 low 即可交付（数量是产出不是 KPI）；若有尚未尝试的组合利用方向（带登录态重放/敏感参数变换）先推进或转待办，再收官");
			const thinImpact = view.findings.filter((finding) => (finding.impact ?? "").trim().length < 40);
			if (thinImpact.length) warnings.push(`以下 finding 的 impact 危害论证过短（<40字），可能缺少具体利用场景（攻击者怎么构造、拿到什么、危害谁），建议补全后再出报告: ${thinImpact.map((finding) => finding.id).join(", ")}`);
			const thinVictim = view.findings.filter((finding) => (finding.victimImpact ?? "").trim().length < 30);
			if (thinVictim.length) warnings.push(`以下 finding 缺少受害者视角危害（victimImpact <30字）：报告需按攻击者/受害者双视角呈现——谁受害、损失什么、是否可察觉: ${thinVictim.map((finding) => finding.id).join(", ")}`);
			try {
				const distilled = await sessionLessons(sessionId);
				if (view.findings.length > 0 && distilled.length === 0) warnings.push("本次会话有 finding 但未沉淀任何经验（src_record_lesson）：若验证套路或人工引导修正有可复用价值，请先沉淀再出报告，供后续同类漏洞直接复用");
			} catch {}
			/* [local.35] 域笔记沉淀闸（软警告）：本会话踩过目标特有信号（防护/限流/已否假设）却零域笔记新增 → 提醒补记。
			   仿 lesson 先例：提示词是建议、闸才是法律；但不硬阻断——记什么、怎么分类仍由 agent 判断，只堵「完全忘记」。
			   信号口径与 401 语义一致：401 是认证边界发现信号不算信号，只算 429/403/503 与 protectionSignal。 */
			try {
				const ownNoteCount = (await store.listDomainNotes(view.goal.target)).filter((row) => row.sourceSessionId === sessionId).length;
				const signalObservations = (view.observations ?? []).filter((o) => o.protectionSignal === true || [429, 403, 503].includes(o.httpStatus));
				const falsifiedOrBlocked = (view.research ?? []).filter((row) => row.status === "false-positive" || row.status === "blocked");
				if (ownNoteCount === 0 && (signalObservations.length > 0 || falsifiedOrBlocked.length > 0)) {
					warnings.push(`本次会话遇到 ${signalObservations.length} 个防护/限流信号、${falsifiedOrBlocked.length} 条已否/受阻假设，但未沉淀任何域笔记（src_record_domain_note）——这些是目标特有情报，记下后新会话开局自动 briefing，不重复钻枯井。若确无可记内容可忽略本警告`);
				}
			} catch {}
			/* [local.44] 归属确认收尾闸（软警告）：还有用户未处理的资产归属确认 → 提醒（不阻断）。
			 *  未决确认意味着部分探测方向被闸拦着等用户，报告里应说明哪些方向因归属未决未覆盖。 */
			try {
				const unresolvedConfirms = [...((await (await store.domain()).table("pending_approvals")).entries())].map(([, row]) => row).filter((row) => row.sessionId === sessionId && row.status === "pending" && row.method === "ASSET");
				if (unresolvedConfirms.length > 0) warnings.push(`有 ${unresolvedConfirms.length} 条资产归属确认仍待用户处理（${unresolvedConfirms.map((row) => `${row.id}:${row.url}`).join(", ")}）——这些注册域在用户确认前整域不可测，报告中应作为覆盖限制说明，不要擅自视为已授权或已排除`);
			} catch {}
			const missingRaw = view.findings.filter((finding) => (finding.rawRequest ?? "").trim() === "");
			if (missingRaw.length) blockers.push(`finding 缺少 Burp 格式 rawRequest（数据包必填）: ${missingRaw.map((finding) => finding.id).join(", ")}`);
			const checkpoints = view.checkpoints ?? [];
			if (checkpoints.some((checkpoint) => checkpoint.stage === "failed")) blockers.push("存在失败的 child checkpoint");
			for (const finding of view.findings) {
				const hasCheckpoint = checkpoints.some((c) => c.intentId === finding.intentId);
				if (!hasCheckpoint) warnings.push(`finding ${finding.id} 所在 intent ${finding.intentId} 无子 agent checkpoint，疑为主 agent 自干验证，证据链不完整`);
			}
			const ready = blockers.length === 0 || args.allowIncomplete === true;
			if (args.allowIncomplete === true && blockers.length > 0) warnings.push(`已按「受限完成」处理 ${blockers.length} 项阻断项，声明已写入报告: ${incompleteReason}`);
			/* [local.62] 决策点注入：出报告前按 finalize 决策点匹配经验触发器（submission-quality 等声明 tools=[src_finalize_engagement]），收音标准自动推送。 */
			let finalizeLessonHints;
			try { finalizeLessonHints = lessonHintLines(await lessonsForContext({ tool: "src_finalize_engagement", text: `收官报告 ${view.goal?.target ?? ""}` })); } catch {}
			/* [Phase 1 telemetry] 收官评估快照：ready/阻断项/警告/产出计数，漏斗的 engagement 级终点。 */
			tel(exec, "engagement.finalized", { ready, allowIncomplete: args.allowIncomplete === true, blockersCount: blockers.length, warningsCount: warnings.length, findingsCount: view.findings.length, intentsCount: view.intents.length }, sessionId);
			return { ready, blockers, warnings, ...(finalizeLessonHints !== void 0 && finalizeLessonHints.length > 0 ? { lessonHints: finalizeLessonHints } : {}) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_report",
		description: "Generate the final Markdown deliverable report: goal header, every confirmed vulnerability with its full evidence chain (discovery, prerequisites, exploitation, loss, PoC, remediation), and the test scope & limitations declaration. Internal process data (exploration chain, assets, coverage matrix, checkpoints, todos) is intentionally NOT in the report — use src_state/src_graph or the UI tabs for it. Call this when the engagement is done.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { markdown: {
					type: "string",
					required: true
				} }
			},
			render: (_a, v) => [{
				type: "text",
				text: v.markdown
			}]
		},
		presentResult: (_args, result) => titledCard("SRC 漏洞挖掘报告", result),
		execute: async (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			let markdown = buildReport(await store.view(sessionId));
			/* [local.16] Append the lessons distilled by this session (skill-style md files). */
			try {
				const lessons = await sessionLessons(sessionId);
				if (lessons.length > 0) markdown += "\n## 本次沉淀的经验（src_read_lesson 可读全文）\n" + lessons.map((row) => `- ${row.title}（id=${JSON.stringify(row.file)}，类型：${row.vulnType}）`).join("\n") + "\n";
			} catch {}
			return { markdown };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_update_finding",
		description: "重写一个已确认 finding 的字段（仅更新传入的字段），更新直接落库并实时反映在面板漏洞列表与报告里——人工引导后的修订一律走本工具，不要把修订内容写到本地文件或只在回复文本里复述。重点重写 impact/victimImpact/pocEvidence/reproducibleSteps/rawRequest，改完重新 src_report；禁止靠新增重复 finding 覆盖。重写 POC 时同样遵守真实场景规则：受控域名如实声明、个人 VPS 用局域网 IP、禁 127.0.0.1/localhost。",
		parameters: {
			findingId: { type: "string", required: true, description: "要修订的 finding id（先 src_state 查看）。" },
			title: { type: "string", description: "新标题（不得与其他 finding 重名）。" },
			severity: { type: "string", enum: SEVERITIES, description: "新严重级别（critical/high/medium/low，无 info 级）。" },
			description: { type: "string", description: "漏洞描述：清楚说明漏洞是什么、在什么接口产生。" },
			impact: { type: "string", description: "攻击者视角利用场景：怎么构造、拿到什么、危害谁，≥40字。" },
			victimImpact: { type: "string", description: "受害者视角危害：谁受害、损失什么、是否可察觉，≥30字。" },
			affectedScope: { type: "string", description: "影响范围。" },
			remediation: { type: "string", description: "修复建议。" },
			entryPoint: { type: "string", description: "前端功能点（整体重写）：web 漏洞必填的前端入口页面/功能。" },
			discoveryPath: { type: "string", description: "接口来源链。" },
			rawRequest: { type: "string", description: "Burp 格式 raw 请求报文。" },
			rawResponse: { type: "string", description: "关键响应 raw 报文。" },
			pocEvidence: { type: "array", items: { type: "string" }, description: "补充 POC 证据（整体替换）。" },
			attackPrerequisites: { type: "string", description: "利用前提（整体重写）：钓鱼托管域要求、需登录业务、用户动作；若漏洞需登录注明登录入口 URL。" },
			attackChain: { type: "string", description: "[local.26] 攻击链叙事（整体重写）：用户打回「没看懂攻击链」时补此字段——从发现→利用前提→利用过程→实际损失→受害者影响串成闭合链后重提。" },
			vulnType: { type: "string", description: "[local.26] 漏洞/情报类型（报告模板用）：如「登录认证漏洞」「越权漏洞」「信息泄露」。" },
			pocScript: { type: "string", description: "[local.27] 一键 PoC 脚本（整体重写，报告以 ``` 代码块渲染）：可直接运行的利用脚本，保留缩进。" },
			concreteLossEvidence: { type: "array", items: { type: "string" }, description: "实际损失证据指针（整体替换）：指向真实 fact/observation/research 的 id。" },
			reproducibleSteps: { type: "array", items: { type: "string" }, description: "复现步骤（整体替换，至少一条）。" },
			affectedAssetId: { type: "string", description: "影响资产 id；传空字符串解除关联。" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, updated: { type: "array", items: { type: "string" }, required: true } } },
			render: (_a, v) => [{ type: "text", text: `已重写 ${v.id} 的 ${v.updated.length} 个字段：${v.updated.join(", ")}。修订已落库，面板漏洞列表与报告即时生效。` }]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const patch = {};
			for (const key of ["title", "severity", "description", "impact", "victimImpact", "affectedScope", "remediation", "entryPoint", "discoveryPath", "rawRequest", "rawResponse", "attackPrerequisites", "attackChain", "vulnType", "pocScript"]) if (typeof args[key] === "string") patch[key] = args[key];
			if (Array.isArray(args.pocEvidence)) patch.pocEvidence = args.pocEvidence.filter((item) => typeof item === "string" && item !== "");
			if (Array.isArray(args.concreteLossEvidence)) patch.concreteLossEvidence = args.concreteLossEvidence.filter((item) => typeof item === "string" && item !== "");
			if (patch.severity === "info") throw new Error("src_update_finding 拒绝：severity=info 已移除——若该 finding 实为研究信号（仅配置缺陷/头反射无敏感数据证明），在 impact/victimImpact 如实改写并降为 low，或在描述中明确标注不提交原因；不要用 info 把注水项合法化");
			if (Array.isArray(args.reproducibleSteps) && args.reproducibleSteps.filter((step) => typeof step === "string" && step !== "").length === 0) throw new Error("reproducibleSteps 不能清空为 0 条——漏洞必须有可复现步骤");
			if (Array.isArray(args.reproducibleSteps)) patch.reproducibleSteps = args.reproducibleSteps.filter((step) => typeof step === "string" && step !== "");
			if (typeof args.affectedAssetId === "string") patch.affectedAssetId = args.affectedAssetId;
			if (Object.keys(patch).length === 0) throw new Error("没有提供任何要更新的字段");
			await store.updateFinding(sessionId, requiredString(args.findingId, "findingId"), patch);
			/* Synthetic tool/call keeps the projection fold in sync with the direct write. */
			if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_update_finding", { ...patch, findingId: args.findingId });
			return { id: String(args.findingId), updated: Object.keys(patch) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_reject_finding",
		description: "[local.26] 打回一条 finding：置为 rejected 并记用户备注。打回的 finding 不删除、保留在图里——准入闸会拦住相似项的二次提交，后续 finding 与之组合可成实锤时可引用其 id。备注是给 agent 的可操作指令，驱动后续动作。仅决策 agent（commander）可调。",
		parameters: {
			findingId: { type: "string", required: true, description: "要打回的 finding id（先 src_state 查看）。" },
			reason: { type: "string", required: true, description: "用户打回备注（≤500 字）：为什么打回 + 要 agent 做什么（如「梳理下攻击链」「写个输入手机号和次数的一键脚本」）。备注即动作指令。" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, status: { type: "string", required: true }, rejectReason: { type: "string", required: true } } },
			render: (_a, v) => [{ type: "text", text: `已打回 finding ${v.id}（status=rejected）。备注：${v.rejectReason}。该 finding 保留在图里：准入闸会拦住相似项二次提交；agent 应按备注动作（梳理攻击链 / 产 PoC 脚本）后用 src_update_finding 补 attackChain 再决定是否重提。` }]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const findingId = requiredString(args.findingId, "findingId");
			const reason = requiredString(args.reason, "reason");
			const updated = await store.rejectFinding(sessionId, findingId, reason);
			/* Synthetic tool/call keeps the projection fold in sync with the direct write. */
			if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_reject_finding", { findingId, reason, rejectedAt: updated.rejectedAt ?? 0 });
			return { id: findingId, status: "rejected", rejectReason: updated.rejectReason ?? reason };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_resolve_approval",
		description: "[local.31] 审批一条挂起的待审请求：HTTP 型 allow→原样重放存储的请求并返回响应码与响应体（responseBody，截断+掩码，full:true 强制完整；重放的是审批过的高价值请求，finding PoC 就靠这份响应）；capability-run 型（method=RUN，来自 src_run_capability）allow→执行白名单脚本并在结果 runOutput 里返回脚本输出；reject→丢弃、记理由。仅决策 agent（commander）可调。用户在 SRC 面板「待办」tab 审批区点批准/拒绝后，你（agent）收到 followup 消息应立即调本工具。幂等：已 approved/rejected 的不可重复审批。",
		parameters: {
			id: { type: "string", required: true, description: "待审请求 id（src_http 挂起时返回的 pendingApprovalId，或 src_state 查询）。" },
			action: { type: "string", required: true, enum: ["allow", "reject"], description: "allow=批准发出原请求；reject=拒绝丢弃。" },
			note: { type: "string", description: "用户审批备注（可选，会记入待审记录）。" },
			full: { type: "boolean", description: "重放响应体强制完整返回（跳过 2KB 截断与去重；写入后回读、越权前后对比等场景用）。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, status: { type: "string", required: true }, method: { type: "string", required: true }, url: { type: "string", required: true }, responseStatus: { type: "number", required: true }, note: { type: "string", required: true }, runOutput: { type: "string" }, responseBody: { type: "string" } } }, render: (_a, v) => [{ type: "text", text: v.status === "approved" ? (v.method === "RUN" ? `已批准并执行 ${v.url}（exit=${v.responseStatus}）。脚本输出：\n${v.runOutput ?? "（无输出）"}` : `已批准并发出待审请求 ${v.id}：${v.method} ${v.url} → 响应 ${v.responseStatus}。据响应推进（成功则记录证据/产 finding；失败则转其他方向）。${v.responseBody !== void 0 ? `\n响应体：\n${v.responseBody}` : ""}`) : `已拒绝待审请求 ${v.id}：${v.method} ${v.url} 不发出。备注：${v.note}。转其他方向。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const id = requiredString(args.id, "id");
			const action = requiredString(args.action, "action");
			if (action !== "allow" && action !== "reject") throw new Error("src_resolve_approval action 必须是 allow 或 reject");
			const note = str(args.note);
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_resolve_approval requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			/* [local.32] 重放同样过软速率帽（与 src_http 放行分支同一闸）。 */
			const throttledHttp = async (url, init) => {
				await srcHttpThrottle(engagementId ?? sessionId);
				const replayT0 = Date.now();
				const response = await http(url, init);
				/* [Phase 1 telemetry] 审批重放也是一次真实出站请求，进 http 漏斗（replay 标记区分直发）。 */
				try {
					const replayUrl = new URL(String(url));
					tel(exec, "http.request", { host: replayUrl.hostname, path: replayUrl.pathname, method: init?.method ?? "GET", status: response.status, durationMs: Date.now() - replayT0, replay: true, approvalId: id }, engagementId ?? sessionId);
				} catch {}
				return response;
			};
			/* [local.41] capability-run 审批的执行器：从待审行 url 解析 id/script，查清单拿目录与 env，白名单已在挂起时校验。 */
			const runCapability = async (row) => {
				const capT0 = Date.now();
				const m = /^capability:\/\/([a-z][a-z0-9-]{1,30})\/(.+)$/.exec(String(row.url ?? ""));
				if (m === null) throw new Error("capability-run 待审行 url 非法（内部错误）");
				const item = (await readCapsManifest(dshHomeOf())).items.find((c) => c.id === m[1]);
				if (item === void 0 || item.status !== "installed" || typeof item.dir !== "string" || item.dir === "") throw new Error(`能力 ${m[1]} 未安装或已移除：先重跑 caps-sync`);
				const cmd = capabilityCommand(item.dir, m[2]);
				if (cmd.error !== void 0) throw new Error(`脚本 ${m[2]} 不可执行：${cmd.error}`);
				let extraArgs = [], timeoutMs = 120000;
				try {
					const b = JSON.parse(row.body ?? "{}");
					if (Array.isArray(b?.args)) extraArgs = b.args.map(String);
					const t = Number(b?.timeoutMs);
					if (Number.isFinite(t) && t > 0) timeoutMs = Math.min(t, 600000);
				} catch {}
				try {
					const run = await runCapabilityProcess(cmd.command, [...cmd.args, ...extraArgs], item.dir, item.env ?? void 0, timeoutMs);
					/* [Phase 1 telemetry] 能力执行结果漏斗点（completed/failed + 耗时 + 退出码）。 */
					tel(exec, "capability.outcome", { jobId: row.id, capabilityId: m[1], script: m[2], status: run.exitCode < 0 ? "failed" : "completed", durationMs: Date.now() - capT0, exitCode: run.exitCode }, engagementId ?? sessionId);
					return run;
				} catch (error) {
					tel(exec, "capability.outcome", { jobId: row.id, capabilityId: m[1], script: m[2], status: "failed", durationMs: Date.now() - capT0, errorCode: String(error?.message ?? error).slice(0, 120) }, engagementId ?? sessionId);
					throw error;
				}
			};
			/* [local.44] 资产归属确认（method=ASSET）只能由用户在面板或 /src-approve 决定——
			 *  那是授权边界的扩大/排除，agent 不可自批（否则人工确认形同虚设）。 */
			const selfApproval = await store.getPendingApproval(engagementId ?? sessionId, id);
			if (selfApproval?.method === "ASSET") throw new Error("资产归属确认（asset-attribution）只能由用户在 SRC 面板「待审」区或 /src-approve 命令决定，agent 不可代批；提交后耐心等待用户处理即可");
			const updated = await store.resolvePendingApproval(engagementId ?? sessionId, id, action, note, throttledHttp, runCapability, async (ref) => readCredential({ dshHome: dshHomeOf(), ref }), { full: args.full === true });
			/* [local.60] 审批已解决（allow/reject 均算）→ 清锁，解除同 host+path 的绕行拦截。失败不阻塞主流程。 */
			try { await removeApprovalLock(dshHomeOf(), id); } catch {}
			const resolvedEvent = { id, action, note, responseStatus: updated.responseStatus ?? 0, ...(typeof updated.responseBody === "string" && updated.responseBody !== "" ? { responseBody: updated.responseBody } : {}) };
			if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_resolve_approval", resolvedEvent);
			/* [local.58] 跨会话审批 resolution 对齐：子代理解决审批时父投影不能 stale（resolve fold 按 id 匹配，
			   父投影无此行时是安全 no-op）。 */
			if (engagementId !== void 0 && engagementId !== sessionId) appendSessionToolEvent(ctx.sessions.get(engagementId), "src_resolve_approval", resolvedEvent);
			/* [Phase 1 telemetry] 审批解决漏斗点：decision（allow/reject）+ 等待时长（挂起→解决）。 */
			tel(exec, "approval.resolved", { approvalId: id, decision: action, method: updated.method, category: updated.category ?? "", status: updated.status, latencyMs: selfApproval?.createdAt !== void 0 ? Math.max(0, Date.now() - selfApproval.createdAt) : 0, ...(updated.method === "RUN" ? { capabilityId: /^capability:\/\/([^/]+)\//.exec(String(updated.url ?? ""))?.[1] ?? "" } : {}) }, engagementId ?? sessionId);
			return { id, status: updated.status, method: updated.method, url: updated.url, responseStatus: updated.responseStatus ?? 0, note: updated.note, ...(updated.runOutput !== void 0 ? { runOutput: updated.runOutput } : {}), ...(typeof updated.responseBody === "string" && updated.responseBody !== "" ? { responseBody: updated.responseBody } : {}) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_request_asset_confirm",
		description: "[local.44] 资产归属人工确认：探测面遇到 goal 主域外、疑似目标组织但无法公开验证归属的注册域（相似域名/陌生主域但业务关联）时，向用户发起整域归属确认。用户确认后整个注册域（主域+全部子域）纳入授权清单，否则整域排除。仅指挥官可调。何时用：①明显属于目标组织的域（品牌域/主域名/公开控股关系，如顺丰项目里的 sf-express.com）→ 直接 src_add_asset 登记 confirmed，不要打扰用户；②无法验证的疑似域 → 本工具，传注册域（如 sfgy1.com，不要传单个子域），evidence 写清判定依据（相似特征/证书/业务引用）；③确定不属于的域不要发起。提交后不阻塞：继续其他方向，用户在面板「待审」区决定后会收到 followup，届时再重试或放弃。",
		parameters: {
			domain: { type: "string", required: true, description: "要确认归属的注册域（如 sfgy1.com；可带 *. 前缀会被归一化剥掉）。传注册域而不是单个子域——确认粒度是整个域。" },
			evidence: { type: "string", required: true, description: "判定为可能属于目标组织的依据（相似域名特征/证书透明记录/页面业务引用/ WhoIs 线索等），会展示给用户供决策。" },
			intentId: { type: "string", description: "关联的 intent id（可选）。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { status: { type: "string", required: true }, pendingApprovalId: { type: "string" }, domain: { type: "string", required: true }, duplicate: { type: "boolean", required: true }, message: { type: "string" } } }, render: (_a, v) => [{ type: "text", text: v.status === "pending" ? `归属确认已提交（${v.pendingApprovalId ?? ""}）：${v.domain} 是否属目标组织由用户决定——确认则整域授权，否决则整域排除。${v.duplicate ? "（同域已有在等确认，未重复提交）" : ""}不要等待，继续其他方向；收到 followup 后再重试或放弃。` : `未提交：${v.message ?? ""}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const raw = requiredString(args.domain, "domain").trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
			const evidence = requiredString(args.evidence, "evidence");
			if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw)) throw new Error(`src_request_asset_confirm domain "${raw}" 不是合法域名（需至少两段标签，如 sfgy1.com）；不要带路径/端口/协议`);
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_request_asset_confirm requires an initialized SRC goal；先 src_add_goal");
			const goalHost = parseGoalHost(goal.target);
			const scopeSession = engagementId ?? sessionId;
			if (raw === goalHost || raw.endsWith(`.${goalHost}`)) return { status: "skipped", domain: raw, duplicate: false, message: "该域在 goal 主域内，本就在授权范围，无需确认" };
			const assets = (await store.sessionData(scopeSession)).assets;
			const grantHosts = assetGrantHosts(assets);
			if (hostCoveredByAssets(grantHosts, raw)) return { status: "skipped", domain: raw, duplicate: false, message: "该域已被资产清单覆盖（已有 confirmed/candidate 资产），无需重复确认" };
			const excludedHost = assets.filter((asset) => asset.status === "excluded").map((asset) => String(asset.value ?? "").trim().toLowerCase().replace(/^\*\./, "").split(/[\s(/]/)[0].replace(/\.$/, "")).find((host) => host !== "" && (raw === host || raw.endsWith(`.${host}`)));
			if (excludedHost !== void 0) return { status: "skipped", domain: raw, duplicate: false, message: `该域此前已被用户否决（excluded 资产覆盖）；如需翻案请在对话里向用户说明后由用户直接指示` };
			const existing = await store.findPendingApproval(scopeSession, "ASSET", raw, "");
			if (existing !== void 0) return { status: "pending", pendingApprovalId: existing.id, domain: raw, duplicate: true };
			const pending = await store.addPendingApproval(scopeSession, { intentId: typeof args.intentId === "string" && args.intentId !== "" ? args.intentId : void 0, method: "ASSET", url: raw, path: "", headers: "", body: "", category: "asset-attribution", reason: evidence, justification: `请确认 ${raw} 是否属于目标组织：确认后整个注册域（主域+全部子域）纳入授权清单；否决则整域排除。` });
			if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_record_pending_approval", { id: pending.id, method: "ASSET", url: raw, path: "", headers: "", body: "", category: "asset-attribution", reason: evidence, justification: `请确认 ${raw} 是否属于目标组织：确认后整域授权，否决则整域排除。` });
			/* [Phase 1 telemetry] 归属确认也是高危挂起（用户决策面）。 */
			tel(exec, "approval.waiting", { approvalId: pending.id, category: "asset-attribution", risk: evidence, domain: raw }, scopeSession);
			return { status: "pending", pendingApprovalId: pending.id, domain: raw, duplicate: false };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_lesson",
		description: "沉淀一条漏洞挖掘经验到经验库（markdown 文件，跨会话永久生效）：同类漏洞以后都按这个套路验证。触发时机：① finding 达到 SRC 收录标准后 ② 经人工引导从“不收”变“收录”后（必须沉淀 before/after 差异）③ 验证中发现关键绕过/证据技巧时。同类型已有文件则合并更新而非新建。",
		parameters: {
			id: { type: "string", description: "经验文件 slug（小写中划线，如 cors-origin-reflection）。同 id 已存在则更新合并该文件；省略则自动生成。" },
			vulnType: { type: "string", required: true, description: "漏洞类型标题（如「CORS 任意 Origin 反射 + Credentials」）。" },
			scenario: { type: "string", required: true, description: "触发场景/识别特征：什么目标上什么信号提示可以试这类漏洞。" },
			verificationPlaybook: { type: "string", required: true, description: "验证套路：分步写清怎么做（请求怎么构造、用什么工具、注意什么边界），后续同类型照此执行。" },
			acceptanceCriteria: { type: "string", required: true, description: "收录标准：满足什么才算达到 SRC 收录标准（危害论证要点、必要证据）。" },
			pitfalls: { type: "string", description: "常见误判/被拒原因：为什么最初不收、缺了什么、怎么补才收（before/after 对比）。" },
			keyEvidence: { type: "string", description: "必抓证据清单（如双向 Origin 头回显截图+Credentials=true 响应头）。" },
			sourceFindingTitle: { type: "string", description: "来源 finding 标题（可选，便于溯源）。" },
			triggerTools: { type: "string", description: "[local.62] 逗号分隔的工具名列表（如 src_finalize_engagement,src_run_capability）：声明后本经验会在这些决策点自动推送（不声明则只能被搜到）。" },
			triggerKeywords: { type: "string", description: "[local.62] 逗号分隔的触发关键词（如 cors,跨域）：建意图/跑能力时标题或详情命中任一词即推送本经验。" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, path: { type: "string", required: true }, updatedExisting: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: `${v.updatedExisting ? "已更新" : "已新建"}经验 ${v.id} → ${v.path}；今后建 goal 时会出现在索引里，同类漏洞直接 src_read_lesson 复用。` }]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const slugBase = (typeof args.id === "string" && /^[-a-z0-9]{3,64}$/.test(args.id) ? args.id : `lesson-${Date.now()}`).replace(/[^-a-z0-9]/g, "-").slice(0, 64);
			const dir = lessonsDataDir();
			let slug = slugBase;
			let existing = "";
			try {
				existing = await fsPromises.readFile(nodePath.join(dir, `${slug}.md`), "utf8");
			} catch {}
			if (existing === "" && typeof args.id !== "string") {
				/* Auto slug from vulnType when not provided; keep it stable for later merges. */
				const pinyinish = String(args.vulnType).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
				slug = pinyinish.length >= 3 ? pinyinish : slugBase;
				try { existing = await fsPromises.readFile(nodePath.join(dir, `${slug}.md`), "utf8"); } catch {}
			}
			await fsPromises.mkdir(dir, { recursive: true });
			const triggerDecl = parseTriggerList(args.triggerTools, args.triggerKeywords);
			const meta = JSON.stringify({ sessionId, vulnType: args.vulnType, sourceFindingTitle: typeof args.sourceFindingTitle === "string" ? args.sourceFindingTitle : "", createdAt: Date.now(), ...(Object.keys(triggerDecl).length > 0 ? { triggers: triggerDecl } : {}) });
			const body = [
				`# ${args.vulnType}`,
				"",
				`## 触发场景`,
				args.scenario,
				"",
				`## 验证套路`,
				args.verificationPlaybook,
				"",
				`## 收录标准`,
				args.acceptanceCriteria,
				"",
				...(typeof args.pitfalls === "string" && args.pitfalls !== "" ? [`## 常见误判与被拒原因`, args.pitfalls, ""] : []),
				...(typeof args.keyEvidence === "string" && args.keyEvidence !== "" ? [`## 必抓证据`, args.keyEvidence, ""] : []),
				...(typeof args.sourceFindingTitle === "string" && args.sourceFindingTitle !== "" ? [`> 来源：${args.sourceFindingTitle}`, ""] : []),
				`<!-- lesson-meta: ${meta} -->`,
				""
			].join("\n");
			await fsPromises.writeFile(nodePath.join(dir, `${slug}.md`), body, "utf8");
			return { id: slug, path: nodePath.join(dir, `${slug}.md`), updatedExisting: existing !== "" };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_read_lesson",
		description: "读一篇经验全文（内置方法论或沉淀经验；沉淀版优先于同名内置版）。开测前对索引里的同类条目先读再验证。",
		parameters: { id: { type: "string", required: true, description: "经验文件 id（来自 goal 返回的索引或 src_search_lessons）。" } },
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, source: { type: "string", required: true }, text: { type: "string", required: true } } }, render: (_a, v) => [{ type: "text", text: `[${v.source}] ${v.text}` }] },
		execute: async (args, exec) => {
			const { text, source } = await readLessonFile(String(args.id));
			/* [Phase 1 telemetry] 经验阅读漏斗点（skill 用率核心指标）。 */
			tel(exec, "skill.read", { skillId: String(args.id), source: `lesson:${source}`, bytes: text.length });
			return { id: String(args.id), source, text };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_search_lessons",
		description: "按关键词搜经验库（内置+沉淀，返回匹配的标题与命中行）。开始验证一类不确定怎么证的漏洞前先搜一次。",
		parameters: { query: { type: "string", required: true, description: "关键词（如 CORS / 短信 / 越权 / apk）。" } },
		output: { schema: { type: "object", additionalProperties: false, properties: { hits: { type: "array", items: { type: "object", additionalProperties: true, properties: {} }, required: true } } }, render: (_a, v) => [{ type: "text", text: v.hits.length === 0 ? `经验库无「${String(_a?.query ?? "")}」相关条目。` : v.hits.map((hit) => `- ${hit.title}（${hit.source}${hit.overrides === true ? "，覆盖内置" : ""}）：${hit.snippet}`).join("\n") }] },
		execute: async (_args, exec) => {
			const query = String(_args.query ?? "").trim().toLowerCase();
			const hits = [];
			if (query !== "") {
				for (const row of await listAllLessons()) {
					try {
						const text = await fsPromises.readFile(nodePath.join(row.dir, `${row.file}.md`), "utf8");
						const line = text.split("\n").find((candidate) => candidate.toLowerCase().includes(query));
						if (line !== void 0 || row.title.toLowerCase().includes(query)) hits.push({ file: row.file, title: row.title, source: row.source, ...(row.overrides === true ? { overrides: true } : {}), snippet: (line ?? row.title).trim().slice(0, 160) });
					} catch {}
				}
			}
			return { hits: hits.slice(0, 20) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_serve_proof",
		description: "在本机起一个受控 HTTP 服务器托管 POC 页面/载荷（把本机局域网 IP 当受控 VPS 用），并记录所有访问作为 OOB 回连证据。用于 XSS 打码、CSRF、SSRF 回连、盲打等需要外部可达 URL 的场景。返回 http://<局域网IP>:<port>/<filename>。服务会在 TTL 到期、goal 重置或插件卸载时自动关闭——验证完立即用 src_stop_serve 显式关闭并取回访问日志随 finding 提交，不留常驻服务。【真实场景构造】需要厂商受控域名的钓鱼类场景如实声明该前置条件，不伪造域名；个人控制 VPS 一律用返回的局域网 IP URL——禁止把 POC 里的主机改写成 127.0.0.1/localhost，那不是真实可达的利用路径，证据无效。",
		parameters: {
			payload: { type: "string", required: true, description: "要托管的完整内容（HTML/JS/文本，≤200KB）。如 XSS POC 页、SSRF 探针 URL 列表。" },
			filename: { type: "string", description: "路径文件名（默认 poc.html）；访问 URL 即 http://<ip>:<port>/<filename>。任意路径都返回同一内容并记入日志。" },
			contentType: { type: "string", description: "Content-Type（默认 text/html; charset=utf-8）。" },
			ttlSeconds: { type: "number", description: "存活秒数，默认 3600，上限 86400，到期自动关闭。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `POC 服务已就绪：${v.url}\n访问日志将在 src_stop_serve 时返回（当前 ${v.hits} 条）。TTL ${Math.round(v.ttlSeconds)}s 到期自动关闭。诱导目标访问该 URL 即可记录回连证据。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const payload = Buffer.from(String(args.payload ?? ""), "utf8");
			if (payload.length === 0) throw new Error("payload 不能为空");
			if (payload.length > 200 * 1024) throw new Error("payload 过大（≤200KB）——POC 页面应最小化");
			const filename = (() => {
				const raw = String(args.filename ?? "poc.html").replace(/^\/+/, "");
				const safe = nodePath.basename(raw);
				return safe === "" || safe === "." ? "poc.html" : safe;
			})();
			const contentType = /^[\w.+-]+\/[-\w.+]+(?:;\s*[\w-]+=[^\r\n;]*)*$/.test(String(args.contentType ?? "text/html; charset=utf-8").trim()) ? String(args.contentType).trim() : "text/html; charset=utf-8";
			const ttlSeconds = Math.min(Math.max(Number(args.ttlSeconds) || 3600, 10), 86400);
			const server = httpCreateServer((_req, res) => {
				if (entry.hits.length < 1000) entry.hits.push({ at: new Date().toISOString(), ip: _req.socket.remoteAddress ?? "", ua: String(_req.headers["user-agent"] ?? "").slice(0, 300), path: (_req.url ?? "/").slice(0, 500) });
				res.writeHead(200, { "content-type": contentType, "access-control-allow-origin": "*" });
				res.end(payload);
			});
			const entry = { sessionId, ...(exec.agent?.session.header?.parentSession !== void 0 ? { parentSessionId: exec.agent.session.header.parentSession } : {}), server, timer: void 0, hits: [], meta: { filename, contentType, ttlSeconds } };
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "0.0.0.0", resolve);
			});
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			const serveId = `serve-${sessionId}-${port}`;
			liveProofServers.set(serveId, entry);
			entry.timer = setTimeout(() => { liveProofServers.delete(serveId); server.close(); }, ttlSeconds * 1000);
			entry.timer.unref?.();
			return {
				serveId,
				url: `http://${lanIPv4()}:${port}/${filename}`,
				ttlSeconds,
				hits: 0
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_stop_serve",
		description: "关闭一个 POC 托管服务器并取回完整访问日志（时间/来源IP/UA/路径）——这是 SSRF/XSS/盲打类漏洞的回连证据，随 src_submit 一并提交。POC 验证完成后立即调用，不留常驻服务。",
		parameters: { serveId: { type: "string", required: true, description: "src_serve_proof 返回的 serveId。" } },
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: v.stopped !== true ? `未找到运行中的服务 ${String(v.serveId)}（可能已到期自动关闭）。` : `已关闭 ${v.serveId}，共 ${v.hits.length} 次访问：\n${v.hits.length === 0 ? "（无访问记录）" : v.hits.map((hit) => `${hit.at} ${hit.ip} ${hit.path} [${hit.ua}]`).join("\n")}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const serveId = requiredString(args.serveId, "serveId");
			const meta = await closeProofServer(sessionId, serveId);
			if (meta === void 0) return { serveId, stopped: false, hits: [] };
			return { serveId, stopped: true, hits: meta.hits };
		}
	}));
	/* [local.81 Phase 7] 测绘种子队列工具：DSH_SRC_SURVEY=off 时不注册（行为与当前完全一致）。 */
	if (srcSurveyFlag() !== "off") ctx.tools.register(defineTool({
		name: "src_survey_seed",
		description: "测绘种子队列与一种子闭环（Phase 7）。动作：add{value,kind?,source?,note?} 入队（去重，返回锁面/自由跳引导）；list 计数+明细；next 取下一个种子——存在未闭环 active 种子时拒绝并返回剩余活面；complete{seedId,outcome=exhausted|dead|superseded}；backfill{value} 回灌根域；probe{seedId} 对种子 host GET 首页存活探测（dead 记种子笔记防重探、alive 入资产流；401/403/登录墙/挑战页判 alive 不丢弃）；fofa{seedId,maxPages?} FOFA 关联域名发现（无 DSH_SRC_FOFA_KEY 降级、锁面禁用、key 不进返回）；ct{seedId} 证书透明度两腿串行（crt.name 子域清单 + certspotter 跨域 SAN 扩展；均无需 key 国内直连；跨域新根域不自动入队——建 src_user_todo 交用户确认）。股权闸：全资主体名/品牌/根域可入队，参股建 src_user_todo 交用户确认默认不挖。",
		parameters: {
			action: { type: "string", required: true, enum: ["add", "list", "next", "complete", "backfill", "probe", "fofa", "ct"], description: "动作。" },
			value: { type: "string", description: "add/backfill：种子值（域名/IP/URL）。" },
			kind: { type: "string", enum: ["root-domain", "subdomain", "ip", "url"], description: "add：种子类型，默认 root-domain。" },
			source: { type: "string", description: "add：来源标签（user-list/js-hint/backfill/fofa/manual）。" },
			note: { type: "string", description: "add/backfill：备注。" },
			seedId: { type: "string", description: "complete/probe/fofa/ct：种子 id。" },
			outcome: { type: "string", enum: ["exhausted", "dead", "superseded"], description: "complete：结果（已穷尽/已死/被取代）。" },
			maxPages: { type: "number", description: "fofa：翻页数上限，默认 3，上限 10。" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: {} },
			render: (_a, v) => {
				const lines = [];
				if (v.action === "add") lines.push(v.duplicate === true ? `种子已在队列：${v.id} ${v.value}（${v.status}）` : `已入队：${v.id} ${v.value}（${v.kind}，${v.status}，来源 ${v.source}）`);
				else if (v.action === "list") lines.push(`种子队列：pending ${v.counts.pending}，active ${v.counts.active}，done ${v.counts.done}，dead ${v.counts.dead}`, ...v.rows.map((row) => `- ${row.id} [${row.status}] ${row.value}（${row.kind}${row.source ? `，${row.source}` : ""}）`));
				else if (v.action === "next") lines.push(v.empty === true ? "种子队列已空（pending/active 均无）——用 add/backfill 入队，或收尾。" : `取到种子 ${v.id} ${v.value}（${v.kind}）已置 active。`);
				else if (v.action === "complete") lines.push(`种子 ${v.id} 已置 ${v.status}（${v.outcome}）。`);
				else if (v.action === "backfill") lines.push(v.duplicate === true ? `回灌值已在队列：${v.id} ${v.value}` : `已回灌：${v.id} ${v.value}（pending）`);
				else if (v.action === "probe") lines.push(`存活探测 ${v.results.length} 个 host：alive ${v.counts.alive}，parked ${v.counts.parked}，dead ${v.counts.dead}。`, ...v.results.map((row) => `- ${row.host} → ${row.outcome}`));
				else if (v.action === "fofa") lines.push(v.degraded === true ? `FOFA 降级：${v.note}` : `FOFA：${v.note}`);
				else if (v.action === "ct") {
					for (const leg of v.legs ?? []) lines.push(`CT ${leg.provider}：${leg.degraded === true ? `降级（${leg.note}）` : `${leg.hosts} 子域入队${leg.roots > 0 ? `，跨域新根域 ${leg.roots} 个（待你确认）` : ""}`}`);
					if ((v.rootsPending ?? []).length > 0) lines.push(...v.rootsPending.map((root) => `- 跨域新根域待确认：${root.value}（依据：${root.basis}）——全资才可入队，已在待办`));
				}
				if (v.guidance !== void 0 && v.guidance !== "") lines.push(v.guidance);
				if (v.equity !== void 0 && v.equity !== "") lines.push(v.equity);
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const goal = await store.requireGoal(sessionId);
			const mode = surveyModeOf(goal.target);
			const EQUITY = "入队前确认组织归属：全资 1-4 级主体名/品牌/根域可直接入队；参股/拿不准的建 src_user_todo 交用户确认，默认不挖。";
			const action = requiredString(args.action, "action");
			if (action === "add" || action === "backfill") {
				const value = requiredString(args.value, "value");
				const kind = action === "backfill" ? "root-domain" : (args.kind ?? "root-domain");
				const source = action === "backfill" ? "backfill" : (args.source ?? "user-list");
				const { seed, duplicate } = await store.addSurveySeed(sessionId, { kind, value, source, note: args.note ?? "" });
				return { action, id: seed.id, value: seed.value, kind: seed.kind, status: seed.status, source: seed.source, duplicate, guidance: mode.guidance, equity: EQUITY };
			}
			if (action === "list") {
				const seeds = await store.surveySeeds(sessionId);
				const counts = { pending: 0, active: 0, done: 0, dead: 0 };
				for (const seed of seeds) counts[seed.status] += 1;
				const rows = seeds.slice(0, 20).map((seed) => ({ id: seed.id, value: seed.value, status: seed.status, kind: seed.kind, source: seed.source }));
				return { action, counts, rows, total: seeds.length, guidance: mode.guidance };
			}
			if (action === "next") {
				const seeds = await store.surveySeeds(sessionId);
				const active = seeds.find((seed) => seed.status === "active");
				if (active !== void 0) {
					const data = await store.sessionData(sessionId);
					const closure = seedClosureStatus(active, { assets: data.assets, coverage: data.coverage, facts: data.facts, findings: data.findings });
					if (!closure.closed) {
						const sample = closure.remaining.slice(0, 5).map((item) => `${item.id}(${item.host})`).join("、");
						throw new Error(`种子 ${active.id}（${active.value}）的活面未处置完（剩 ${closure.remaining.length}）：${sample}${closure.remaining.length > 5 ? " 等" : ""}——挖完/记废/标 excluded 后再取下一个`);
					}
					await store.updateSurveySeed(sessionId, active.id, { status: "done" });
				}
				const pending = seeds.find((seed) => seed.status === "pending");
				if (pending === void 0) return { action, empty: true, guidance: mode.guidance };
				const nextSeed = await store.updateSurveySeed(sessionId, pending.id, { status: "active" });
				return { action, id: nextSeed.id, value: nextSeed.value, kind: nextSeed.kind, guidance: mode.guidance };
			}
			if (action === "complete") {
				const seedId = requiredString(args.seedId, "seedId");
				const outcome = requiredString(args.outcome, "outcome");
				const status = outcome === "dead" ? "dead" : "done";
				const updated = await store.updateSurveySeed(sessionId, seedId, { status });
				return { action, id: updated.id, status: updated.status, outcome, guidance: mode.guidance };
			}
			if (action === "probe") {
				const seedId = requiredString(args.seedId, "seedId");
				const seed = await store.getSurveySeed(sessionId, seedId);
				if (seed === void 0) throw new Error(`probe: 种子 ${seedId} 不存在`);
				const http = makeHttpFetch(await store.getInfra(sessionId));
				const hosts = [...new Set([surveyHostOf(seed.value)])].slice(0, 20);
				const results = [];
				for (const host of hosts) {
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), 8000);
					let outcome;
					try {
						const response = await http(new URL(`https://${host}/`), { method: "GET", redirect: "manual", signal: controller.signal, headers: { "user-agent": "dsh-src-survey/1" } });
						const body = (await response.text()).slice(0, 4096);
						outcome = classifyProbeResponse({ ok: true, status: response.status, bodySnippet: body });
					} catch { outcome = classifyProbeResponse({ ok: false }); } finally { clearTimeout(timer); }
					results.push({ host, outcome });
					if (outcome === "alive") await store.addAsset(sessionId, { type: "subdomain", value: host, source: "survey-probe", status: "candidate", confidence: .6 });
					if (outcome === "dead") {
						const data = await store.sessionData(sessionId);
						const intentId = data.intents[0]?.id;
						if (intentId !== void 0) await store.addFact(sessionId, { intentId, kind: "info", target: host, detail: "非存活：超时/探不通（src_survey_seed probe，防重复探测）", confidence: .6 });
					}
				}
				const counts = { alive: results.filter((row) => row.outcome === "alive").length, parked: results.filter((row) => row.outcome === "parked").length, dead: results.filter((row) => row.outcome === "dead").length };
				return { action, results, counts, guidance: mode.guidance };
			}
			if (action === "fofa") {
				if (mode.mode === "locked") throw new Error("固定站锁面模式禁用 FOFA 自由跳");
				const seedId = requiredString(args.seedId, "seedId");
				const seed = await store.getSurveySeed(sessionId, seedId);
				if (seed === void 0) throw new Error(`fofa: 种子 ${seedId} 不存在`);
				if (fofaKey() === "") return { action, degraded: true, hosts: 0, note: "未配置 DSH_SRC_FOFA_KEY，跳过 FOFA provider；种子闭环不依赖它", guidance: mode.guidance };
				const http = makeHttpFetch(await store.getInfra(sessionId));
				const found = await fofaSearch(seed, { fetchImpl: http, maxPages: args.maxPages });
				let added = 0;
				for (const host of found.hosts.slice(0, 50)) {
					const { duplicate } = await store.addSurveySeed(sessionId, { kind: "subdomain", value: host, source: "fofa", note: `由种子 ${seed.id} FOFA 发现` });
					if (!duplicate) added += 1;
				}
				return { action, degraded: found.degraded, hosts: added, note: found.degraded ? found.note : `provider=fofa, ${added} hosts 入队`, guidance: mode.guidance, equity: EQUITY };
			}
			if (action === "ct") {
				const seedId = requiredString(args.seedId, "seedId");
				const seed = await store.getSurveySeed(sessionId, seedId);
				if (seed === void 0) throw new Error(`ct: 种子 ${seedId} 不存在`);
				const http = makeHttpFetch(await store.getInfra(sessionId));
				const apex = surveyHostOf(seed.value);
				/* 三腿串行之两腿：crt.name 子域清单（最快出全量）+ certspotter 跨域 SAN 扩展（爆集团新根域）。均无需 key，国内直连。 */
				const legs = [];
				const rootsPending = [];
				let added = 0;
				for (const [provider, search] of [["crt.name", crtNameSearch], ["certspotter", certspotterSearch]]) {
					const found = await search(seed, { fetchImpl: http });
					const entry = { provider, degraded: found.degraded, hosts: 0, roots: (found.roots ?? []).length, note: found.note };
					if (found.ok) {
						for (const host of found.hosts.slice(0, 100)) {
							const { duplicate } = await store.addSurveySeed(sessionId, { kind: "subdomain", value: host, source: `ct-${provider}`, note: `由种子 ${seed.id} ${provider} 发现` });
							if (!duplicate) { entry.hosts += 1; added += 1; }
						}
						/* 跨域新根域（同证书签发链的集团新根域）：不自动入队（股权闸）——建 src_user_todo 交用户确认，全资才可入队。 */
						for (const root of (found.roots ?? []).slice(0, 10)) {
							const todo = await store.upsertUserTodo(sessionId, { kind: "decision", title: `跨域新根域待确认：${root}`, detail: `由种子 ${seed.id}（${apex}）经 ${provider} 证书透明度跨域 SAN 发现，同证书签发链。全资才可入队；确认后 add/backfill 入种子队列。` });
							rootsPending.push({ value: root, basis: `${provider} 跨域证书关联（种子 ${seed.id}）`, todoId: todo.id });
						}
					}
					legs.push(entry);
				}
				return { action, legs, added, rootsPending, guidance: mode.guidance, equity: EQUITY };
			}
			throw new Error(`src_survey_seed 未知动作 ${action}`);
		}
	}));
}
//#endregion
//#region src/index.ts
/** Plugin identity. */
}
