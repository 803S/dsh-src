import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { promises as dns } from "node:dns";
//#region src/instructions.ts
/** Stable protocol prose shown to the decision agent. */
const SRC_INSTRUCTIONS = `\
你是SRC 漏洞挖掘指挥官（决策 agent）。输入：目标(target) + 目的(objective)。

始终沿【探索链路】推进：goal（目标）→ spawns → intent（意图）→ yields → fact（事实）
→ derived_from → intent（由事实推导的新意图）→ proves → finding（漏洞），并在每一步调用
src_* 工具把节点与边写进记录；资产单独记录并挂接父子关系。
记录纪律：只有你（决策 agent）调用 src_add_*、src_record_recon、src_state、src_graph 和 src_report。
探索/执行子 agent 只能调用 src_submit，把结构化结果直接提交到指定父 intent；该工具只接受
子 agent，服务端会从会话关系确定父会话。子 agent 最终回复只保留提交计数和关键结论；你无需转录明细。

【输入与范围】默认前提：用户已在正规 SRC/漏测平台注册白帽账号并遵守其规则，即视为已取得授权；无需每次要求用户声明或出示授权凭证。用户可输入主域名、URL、公司名、品牌名或项目名。输入是明确主域名/URL 时直接调用 src_add_goal 开干；输入是公司名/品牌名/项目名时，自行用 web/bash 工具解析到明确域名后直接调用 src_add_goal 开干。不要把解析步骤当文字复述，直接用工具去做。仅当无法唯一确定正式目标域名时才用 ask_user_question 问用户。授权字段 authorization 可留空或写“SRC 平台注册授权”，不阻塞流程。
【goal】调用 src_add_goal 记录确认后的目标与目的（授权声明一并写入）；新 goal 会清空本会话的
  旧探索图，重新开始。
【intent】先调用 src_state 检查既有 intent；同一目标、范围和验证方法的意图只能保留一个，已有等价
  intent（含进行中、已完成或 blocked）不得再次创建或委派。默认按以下阶段拆分并行或串行 intent：
  1) 被动组织/域名/证书/DNS/ASN/公开页面侦察；2) 低影响主机与 Web 指纹、robots/sitemap、登录边界、API 网关、OpenAPI/GraphQL、JS 接口线索；3) 认证、授权、会话和业务流程假设；4) 注入、XSS、SSRF、文件上传、越权、敏感信息、配置暴露、供应链和业务逻辑验证；5) 独立复核、影响确认和报告整理。仅当目标、范围或验证方法实质不同，才调用 src_add_intent 并委派执行子 agent。可同时创建多个彼此独立且不重复的 intent，并在同一回合分别调用多个 subagent 或 subagent_fork 并发执行；每个委派必须使用它自己的父 intentId。
  委派前必须调用 src_add_intent，并把该调用刚返回的实际 id 原样写入每个子 agent 提示中的父 intentId。
  禁止传入或保留 delegation-intent-id、intent-id、<intentId> 等占位符；例如返回 id 为 intent-1 时，
  委派必须明确写“父 intentId: intent-1”。委派内容还必须包含：目标、授权范围、待验证任务、相关事实摘要、
  已知资产及可引用的资产 ID。
  不要把完整日志喂给子 agent。全部委派发起后立即结束当前回合：不要使用 Start-Sleep、轮询、等待工具或
  shell 命令来等候。子 agent 的完成事件和摘要会自动注入本会话；收到后再根据新增记录继续推进。
【侦察策略】先用 src_scan_surface 做单次预检，识别 WAF/CDN/挑战页、认证边界和限速响应。遇到 WAF 拦截页/403/challenge：这不是停止信号，而是“需先绕过才能继续”的信号。对防护本身做有界绕过试探（换 UA、降速、分块、方法/编码变换，低 RPS + 有限请求预算）；绕不过才返回 requiresDecision 交指挥官决策。对特定载荷的过滤名单（如 <img onerror> 被拦但 <b> 通）做向量枚举（未拦截标签/编码/解析差异）——这是 bypass-filter-list 研究，属 SRC 高价值漏洞范畴，不算“绕过 WAF”。429 限速先退避降速重试，持续 429 才停。禁止的是无界爆破、拒绝服务、千万级字典、隐蔽大规模扫描；撞到 WAF/403 必须先绕过防护才能继续暴力/遍历/构造载荷类动作，绕不过则停。优先使用被动来源（含 Google dorks 信息收集：泄露凭证/敏感文件/目录结构/索引页/历史缓存/云资产）、页面链接、JS 静态提取、证书透明日志和 DNS 线索，再决定是否主动测绘。
【研究】漏洞研究应借鉴 pentest 的提案→决策→执行循环：先从事实形成假设，再为每个假设创建独立 intent；没有复现证据只能提交 fact/hypothesis，不得提交 finding。验证必须覆盖前置条件、权限边界、最小化 POC、影响范围、误报可能和修复方向；禁止无界爆破、拒绝服务、扩大范围或外传数据。允许的有界验证：①验证码爆破——4 位验证码且无滑块/滑块可绕时，~30 次遍历即可证明任意用户接管；②短信轰炸——~10 次发送测试，无频率限制即成立（medium+）；③小并发爆破——公开密码规则/默认凭据场景用 src_test_credential（低 RPS、有限次数、撞不可绕验证码即停）。
【fact】子 agent 每发现一组独立、已确认的事实/资产/漏洞，就立即调用 src_submit 作为实时检查点，
  不要等到任务结束。直接把发现清单（kind: port/service/vuln/finding/http/info, target, detail, confidence）、
  资产和已确认漏洞提交到该 intent；每批只能包含此前未提交的数据。提交后父会话的记录和渗透页会自动刷新。
  子 agent 最终回复只保留结论、证据摘要和累计计数。
【finding】子 agent 仅在证据已确认时随 src_submit 提交漏洞：title、severity
  （critical/high/medium/low/info）、description，并**必须**给出可复现步骤
  （reproducibleSteps：按顺序的复现命令/请求/动作，至少一条）。
【asset】子 agent 提交的主机/端口/服务/端点/子域都应成为资产，并尽量保留 source、method、confidence 和 candidate/confirmed/excluded 状态。parentId 只能引用委派中已提供的资产 ID；finding 的 affectedAssetId 同样只能引用委派中已提供的资产 ID。无法确定父资产或影响资产时省略对应字段、先按根资产提交，不得臆造 ID。
【覆盖率】每个重要资产都应为侦察、认证/API、漏洞类别和复核阶段调用 src_record_coverage，明确 planned/running/completed/blocked/not-applicable；遇到 WAF、限速、缺少账号、环境不可用或授权排除时必须写 limitation，不得把未测试当作无漏洞。
【研究矩阵】每个漏洞假设都先调用 src_record_research，记录 category、hypothesis、preconditions 和证据，按 hypothesis→testing→reproduced→verified 或 false-positive/blocked 推进；只有 verified 且 finding 字段完整时才进入最终报告。
【bypass 研究】broken-access-control/bypass 类是 SRC 高分漏洞，必须作为正式研究类别而不是一律当作违规：authentication-bypass、authorization-bypass、idor-bola、tenant-isolation、workflow-bypass、method-bypass、path-normalization、parser-discrepancy、rate-limit-bypass、cache-auth-boundary、waf-rule-gap、oauth-flow-bypass。流程是：先创建 intent 和 src_record_research 假设，再由复核子 agent 用 src_test_bypass 做有界 baseline→variant 差分验证（提供 baseline、少量变体、researchId 与授权上下文）；src_test_bypass 只在目标 host/subdomain 内、仅允许 GET/HEAD/OPTIONS 和显式 allowBody 的 POST、低 RPS；遇 WAF/403/429/challenge 时先做有界绕过试探（含过滓名单向量枚举：替换标签/编码/方法变体是正常 variant），绕不过才返回 requiresDecision，也不自动创建 finding。只有出现可复现的权限/授权边界差分、且附上授权影响证明和独立复核，才把 research 推进到 verified；仅凭 403→200 或改 header 得到 200 不算漏洞，误报防护与影响证明是必选项。禁止代理池轮换、无限重试和隐蔽大规模扫描。
【框架与 nDay】识别出开源框架/知名组件指纹（如 VAppServer、VSB 站群、致远 OA、Sea.js、常见 CMS）后，立即创建框架研究 intent：①查公开 CVE/历史漏洞（NVD/CNNVD/GitHub advisory/exploit-db，用 web 搜索）匹配版本范围，把“框架+版本+已知漏洞”落 research（category: nday）；②开源框架直接拉源码（GitHub/Gitee）做定向白盒审计（category: framework-audit），针对目标定制点（如特定 jsp/DWR 接口族）找注入/越权/反序列化。nDay 验证做最小化 PoC 确认（不利用、不深入），命中即 high+ finding。
【认证策略】发现大部分业务需登录时按决策树推进：①先用 Google dorks 被动找泄露凭证（GitHub filename:.env "<domain>"、"<domain>" password、Gitee/文库/网盘，SRC 认可白帽凭此登录测试；已知凭据复现不受爆破配额约束）；②找不到则用 ask_user_question 引导用户提供已登录 Burp 请求/浏览器 HAR（须声明授权测试账号），src_import_traffic 完整保留认证头入库（auth-profile fact），子 agent 复用凭据构造请求测登录态越权面、判断凭据权限范围（如普通用户 token 能否读到他人数据=横向越权实锤）。安全红线：只测凭据对应账户自身的越权面，不横向；只对授权域名跑 dork。
【Burp MCP 工具面】环境挂有 mcp__burp__* 工具（PortSwigger 官方 proxy → Burp Pro 的 MCP 扩展）时的用法：①mcp__burp__get_proxy_history 拉真实浏览流量（含 React module federation chunk、找回密码等静态扫不到的 API），按目标 host 过滤后把请求喂给 src_import_traffic(mode=mcp) 统一落库；②从 proxy 流量提取 Cookie/Authorization 完整构造认证画像（auth-profile fact，可直接复用）；③mcp__burp__send_to_repeater 可把构造好的 POC 请求写回 Burp 由人工复核。Burp 未开时这些工具不可用——走 HAR/raw 文件导入兜底。React chunk 404 类问题优先用此通道解决，不做静态反推。
【推进】用 src_state 观察链路：有新事实 → 推导新 intent → 继续；证据不足 → 扩展侦察
  或换方向。
【终止】目标达成、收益递减、被人类打断或 blocked 时：先调用 src_finalize_engagement 检查未完成 intent、保护信号、未复核 finding、真实危害门禁和报告字段；问题处理完或明确记录限制后，再调用 src_report 产出最终报告（含每个漏洞的标准报告字段与可复现步骤）。

【子 agent 故障处理】子 agent 中途失败（超时、异常退出、长时间无 checkpoint 提交）不会自动重试：收到失败通知后，你必须先查看子 agent 已产出的输出与已提交的 checkpoint，判断已完成部分；剩余工作用 src_recover_child 定向唤醒（同一子 agent 最多两次），或创建新 intent 重新委派；不得假装没发生、不得直接放弃。子 agent 的失败结论也要以 fact 形式落图，避免重复踩坑。

【定级指南（对齐小米 SRC 四档）】严重=直接获取系统权限/RCE/核心数据库数据；高=敏感数据泄露/重要业务越权（如任意用户简历读取）；中=普通越权/一般信息泄露/短信轰炸/验证码爆破可利用；低=反射 XSS/一般未授权信息/轻微逻辑缺陷。提交 finding 时 severity 按此基准判定，impact 描述需注明对应平台定级依据；小程序/App 资产必须记录下载方式（应用商店 URL/二维码）作为 meta。AI 站点类发现先落 ai-surface 资产并标注 manual-recommended，不作为自动 finding。
【漏洞质量标准（SRC）】SRC 要求真实危害漏洞，渗透测试式的信息泄露/指纹/banner 类发现只能算 fact 或低价值 finding，不能作为达成目标的停止条件。真实危害指：未授权数据访问/越权、注入、上传、逻辑漏洞、SSRF、账号/会话安全等可证明实际影响的漏洞。报告停止前必须确认存在 medium 及以上、有可复现 POC（raw 包含接口地址）且经独立复核 verified 的 finding。

纪律：
- 你是唯一“拍板”者；探索与执行一律委派子 agent，你自己不直接动手。audit/verify 类 intent 必须委派 src_audit/src_verify 子 agent 并产生 checkpoint（checkpoint 为空视同未完成），禁止单纯靠主 agent 自己用 bash/web 验证后直接写 finding。
- 完整记录落在 storage domain；子 agent 用 src_submit 直写父 intent，主 agent 只接收摘要，避免上下文爆炸。
- 委派是异步的：发起后立刻返回，绝不阻塞等待子 agent；完成结果会自动回注。
- 互不依赖且不重复的探索方向应拆为多个 intent 并并发委派；有依赖关系的 intent 必须等其前置事实回注后再创建。
- 任何偏离授权目标范围（src_state 中的目标/授权）的意图都应被拒绝。
- 漏洞必须有可复现步骤，否则视为事实而非 finding。
- 与用户的所有交互一律使用中文：汇报进展、ask_user_question 提问、最终报告均用中文；子 agent 的提交与回复、工具摘要也用中文，不要切回英文。
- 不要复述动作步骤或解释下一步要怎么做：直接调用 src_* 或 web/bash 工具去做。说了“要检查 robots.txt”就等于没做，必须在同一回合真正发出工具调用。反复复述同一句而不调用工具是错误。`;
//#endregion
//#region src/projection.ts
/**
* The standing `src` session-projection unit: folds the logged
* `src_*` tool calls into the engagement's current exploration graph, so
* the UI reconstructs the same graph from the session log alone — pure
* mathematics, replay-safe, no storage-domain reads. Node/edge ids replicate
* the store's deterministic `<kind>-<n>` counters, so edges resolve across the
* fold. Writes that would violate the store's referential discipline are
* skipped, mirroring the store's rejection. Malformed or foreign events leave
* the state untouched.
* @module @deepseek-ai/dsh-src/src/projection
*/
/** Wire payload schema of the `src` projection (standing state or pre-init null). */
const srcProjectionSchema = z.union([z.object({
	goal: z.object({
		id: z.string(),
		target: z.string(),
		objective: z.string(),
		authorization: z.string()
	}),
	nodes: z.array(z.union([
		z.object({
			id: z.string(),
			kind: z.literal("intent"),
			title: z.string(),
			detail: z.string(),
			status: z.enum(["planned", "running", "completed", "blocked", "failed"])
		}),
		z.object({
			id: z.string(),
			kind: z.literal("fact"),
			factKind: z.enum([
				"port",
				"service",
				"vuln",
				"finding",
				"http",
				"info"
			]),
			intentId: z.string(),
			target: z.string(),
			detail: z.string(),
			confidence: z.number()
		}),
		z.object({
			id: z.string(),
			kind: z.literal("finding"),
			intentId: z.string(),
			title: z.string(),
			severity: z.enum([
				"critical",
				"high",
				"medium",
				"low",
				"info"
			]),
			description: z.string(),
			steps: z.array(z.string()),
			impact: z.string(),
			affectedScope: z.string(),
			remediation: z.string(),
			pocEvidence: z.array(z.string()),
			affectedAssetId: z.union([z.string(), z.undefined()])
		})
	])),
	assets: z.array(z.object({
		id: z.string(),
		type: z.enum([
			"root-domain",
			"subdomain",
			"ip",
			"service",
			"app",
			"endpoint"
		]),
		value: z.string(),
		meta: z.string(),
		source: z.string(), method: z.enum(["passive", "low-impact", "authorized-active", "user-confirmed"]), confidence: z.number(), status: z.enum(["candidate", "confirmed", "excluded"])
	})),
	coverage: z.array(z.object({ id: z.string(), assetId: z.union([z.string(), z.undefined()]), phase: z.string(), category: z.string(), status: z.enum(["planned", "running", "completed", "blocked", "not-applicable"]), evidence: z.array(z.string()), limitation: z.string(), updatedAt: z.number() })),
	research: z.array(z.object({ id: z.string(), intentId: z.string(), category: z.string(), hypothesis: z.string(), preconditions: z.array(z.string()), status: z.enum(["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"]), stopReason: z.string(), evidence: z.array(z.string()), findingId: z.union([z.string(), z.undefined()]), updatedAt: z.number() })),
	checkpoints: z.array(z.object({
		id: z.string(), intentId: z.string(), childSessionId: z.string(),
		stage: z.enum(["progress", "completed", "blocked", "failed"]), summary: z.string(),
		facts: z.number(), assets: z.number(), findings: z.number(), batchKey: z.string(), createdAt: z.number()
	})),
	edges: z.array(z.object({
		id: z.string(),
		kind: z.enum([
			"spawns",
			"yields",
			"derived_from",
			"proves",
			"parent"
		]),
		sourceId: z.string(),
		targetId: z.string()
	})),
	counts: z.object({
		intents: z.number().int().nonnegative(),
		facts: z.number().int().nonnegative(),
		findings: z.number().int().nonnegative(),
		assets: z.number().int().nonnegative(),
		coverage: z.number().int().nonnegative(),
		research: z.number().int().nonnegative(),
		checkpoints: z.number().int().nonnegative()
	})
}), z.null()]);
/** Initial state: an uninitialized engagement (view projects to null). */
const srcInitialState = {
	goal: null,
	nodes: [],
	assets: [],
	coverage: [],
	research: [],
	checkpoints: [],
	edges: [],
	counters: {
		intent: 0,
		fact: 0,
		finding: 0,
		asset: 0,
		edge: 0
	}
};
/** The closed enum values of the wire payloads. */
const FACT_KINDS$1 = new Set([
	"port",
	"service",
	"vuln",
	"finding",
	"http",
	"info"
]);
const SEVERITIES$1 = new Set([
	"critical",
	"high",
	"medium",
	"low",
	"info"
]);
const ASSET_TYPES$1 = new Set([
	"root-domain",
	"subdomain",
	"ip",
	"service",
	"app",
	"endpoint",
	"mini-program",
	"client",
	"firmware",
	"ai-surface",
	"threat-intel"
]);
/** Read one tool call's raw arguments as an object, or undefined when absent/malformed. */
function argsOf(event) {
	if (event.type !== "tool/call" || !event.data.name.startsWith("src_")) return void 0;
	try {
		const parsed = JSON.parse(event.data.arguments);
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Read a string argument, or '' when absent/not a string. */
function str(value) {
	return typeof value === "string" ? value : "";
}
/** Append a node and its edge, capped (oldest dropped). */
function withNode(state, edgeKind, sourceId, node, counters) {
	const edge = {
		id: `edge-${counters.edge + 1}`,
		kind: edgeKind,
		sourceId,
		targetId: node.id
	};
	return {
		...state,
		counters: {
			...counters,
			edge: counters.edge + 1
		},
		nodes: [...state.nodes, node].slice(-200),
		edges: [...state.edges, edge].slice(-200)
	};
}
/** Append an asset and its optional parent edge, capped (oldest dropped). */
function withAsset(state, asset, parentId, counters) {
	const assets = [...state.assets, asset].slice(-200);
	if (parentId === void 0) return {
		...state,
		counters,
		assets
	};
	const edge = {
		id: `edge-${counters.edge + 1}`,
		kind: "parent",
		sourceId: parentId,
		targetId: asset.id
	};
	return {
		...state,
		counters: {
			...counters,
			edge: counters.edge + 1
		},
		assets,
		edges: [...state.edges, edge].slice(-200)
	};
}
/** The next deterministic id of one node kind (the goal is fixed as `goal-1`). */
function nextNodeId(state, kind) {
	const counters = {
		...state.counters,
		[kind]: state.counters[kind] + 1
	};
	return {
		id: `${kind}-${counters[kind]}`,
		counters
	};
}
/** Look up an existing folded node by id and kind. */
function findNode(state, id, kind) {
	return state.nodes.find((node) => node.id === id && node.kind === kind);
}
/** Fold one session event into the standing src state (pure, replay-safe). */
function applySrcEvent(state, event) {
	const submission = event;
	if (submission.type === "src/submit") {
		const data = submission.data;
		const intentId = str(data.intentId);
		if (intentId === "") return state;
		const replay = (name, args, current) => applySrcEvent(current, {
			type: "tool/call",
			data: {
				name,
				arguments: JSON.stringify(args)
			}
		});
		let next = state;
		for (const fact of Array.isArray(data.facts) ? data.facts : []) if (fact !== null && typeof fact === "object") next = replay("src_add_fact", {
			...fact,
			intentId
		}, next);
		for (const asset of Array.isArray(data.assets) ? data.assets : []) if (asset !== null && typeof asset === "object") next = replay("src_add_asset", asset, next);
		for (const finding of Array.isArray(data.findings) ? data.findings : []) if (finding !== null && typeof finding === "object") next = replay("src_add_finding", {
			...finding,
			intentId
		}, next);
		return next;
	}
	if (event.type !== "tool/call") return state;
	const args = argsOf(event);
	if (args === void 0) return state;
	switch (event.data.name) {
		case "src_record_recon": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			let next = state;
			for (const asset of Array.isArray(args.assets) ? args.assets : []) if (asset && typeof asset === "object") next = replay("src_add_asset", { ...asset, source: str(args.source) || "unknown", method: str(args.method) || "passive", confidence: typeof asset.confidence === "number" ? asset.confidence : .5, status: str(asset.status) || "confirmed" }, next);
			for (const fact of Array.isArray(args.facts) ? args.facts : []) if (fact && typeof fact === "object") next = replay("src_add_fact", { ...fact, intentId }, next);
			return next;
		}
		case "src_add_goal": {
			const target = str(args.target);
			const objective = str(args.objective);
			if (target === "" || objective === "") return state;
			return {
				goal: {
					id: "goal-1",
					target,
					objective,
					authorization: str(args.authorization)
				},
				nodes: [],
				assets: [],
				coverage: [],
				research: [],
				checkpoints: [],
				edges: [],
				counters: {
					intent: 0,
					fact: 0,
					finding: 0,
					asset: 0,
					edge: 0
				}
			};
		}
		case "src_add_intent": {
			const title = str(args.title);
			const detail = str(args.detail);
			if (title === "") return state;
			if (state.nodes.some((node) => node.kind === "intent" && node.title.toLowerCase() === title.toLowerCase() && node.detail.toLowerCase() === detail.toLowerCase())) return state;
			const goalId = str(args.goalId);
			const derivedFromFactId = str(args.derivedFromFactId);
			if ((goalId !== "" ? 1 : 0) + (derivedFromFactId !== "" ? 1 : 0) !== 1) return state;
			if (goalId !== "") {
				if (state.goal === null || goalId !== state.goal.id) return state;
				const { id, counters } = nextNodeId(state, "intent");
				return withNode(state, "spawns", goalId, {
					id,
					kind: "intent",
					title,
					detail,
					status: "planned"
				}, counters);
			}
			if (findNode(state, derivedFromFactId, "fact") === void 0) return state;
			const { id: derivedId, counters: derivedCounters } = nextNodeId(state, "intent");
			return withNode(state, "derived_from", derivedFromFactId, {
				id: derivedId,
				kind: "intent",
				title,
				detail,
				status: "planned"
			}, derivedCounters);
		}
		case "src_add_fact": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const detail = str(args.detail);
			if (detail === "") return state;
			const target = str(args.target);
			const candidateKind = typeof args.kind === "string" && FACT_KINDS$1.has(args.kind) ? args.kind : "info";
			if (state.nodes.some((node) => node.kind === "fact" && node.intentId === intentId && node.factKind === candidateKind && node.target.toLowerCase() === target.toLowerCase() && node.detail.toLowerCase() === detail.toLowerCase())) return state;
			const kind = typeof args.kind === "string" && FACT_KINDS$1.has(args.kind) ? args.kind : "info";
			const confidence = typeof args.confidence === "number" && Number.isFinite(args.confidence) ? Math.min(1, Math.max(0, args.confidence)) : .5;
			const { id, counters } = nextNodeId(state, "fact");
			return withNode(state, "yields", intentId, {
				id,
				kind: "fact",
				factKind: kind,
				intentId,
				target,
				detail,
				confidence
			}, counters);
		}
		case "src_add_finding": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const title = str(args.title);
			if (title === "") return state;
			const steps = Array.isArray(args.reproducibleSteps) ? args.reproducibleSteps.filter((step) => typeof step === "string" && step !== "") : [];
			const impact = str(args.impact);
			const affectedScope = str(args.affectedScope);
			const remediation = str(args.remediation);
			const pocEvidence = Array.isArray(args.pocEvidence) ? args.pocEvidence.filter((item) => typeof item === "string" && item !== "") : [];
			if (steps.length === 0 || impact === "" || affectedScope === "" || remediation === "" || pocEvidence.length === 0) return state;
			const severity = typeof args.severity === "string" && SEVERITIES$1.has(args.severity) ? args.severity : "info";
			const affectedAssetId = str(args.affectedAssetId);
			if (affectedAssetId !== "" && !state.assets.some((asset) => asset.id === affectedAssetId)) return state;
			if (state.nodes.some((node) => node.kind === "finding" && node.title.toLowerCase() === title.toLowerCase() && (node.affectedAssetId ?? "") === affectedAssetId)) return state;
			const { id, counters } = nextNodeId(state, "finding");
			return withNode(state, "proves", intentId, {
				id,
				kind: "finding",
				intentId,
				title,
				severity,
				description: str(args.description),
				impact,
				affectedScope,
				remediation,
				pocEvidence,
				steps,
				entryPoint: str(args.entryPoint),
				discoveryPath: str(args.discoveryPath),
				rawRequest: str(args.rawRequest),
				rawResponse: str(args.rawResponse),
				affectedAssetId: affectedAssetId === "" ? void 0 : affectedAssetId
			}, counters);
		}
		case "src_record_coverage": {
			const phase = str(args.phase), category = str(args.category), status = args.status;
			if (phase === "" || category === "" || !["planned", "running", "completed", "blocked", "not-applicable"].includes(status)) return state;
			const record = { id: str(args.id) || `coverage-${state.coverage.length + 1}`, assetId: str(args.assetId) || void 0, phase, category, status, evidence: Array.isArray(args.evidence) ? args.evidence.filter((x) => typeof x === "string") : [], limitation: str(args.limitation), updatedAt: Number(args.updatedAt) || 0 };
			const existing = state.coverage.findIndex((row) => row.assetId === record.assetId && row.phase === phase && row.category === category);
			const coverage = [...state.coverage];
			if (existing >= 0) coverage[existing] = { ...record, id: coverage[existing].id }; else coverage.push(record);
			return { ...state, coverage: coverage.slice(-500) };
		}
		case "src_record_research": {
			const intentId = str(args.intentId), category = str(args.category), hypothesis = str(args.hypothesis), status = args.status;
			if (intentId === "" || findNode(state, intentId, "intent") === void 0 || category === "" || hypothesis === "" || !["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"].includes(status)) return state;
			const record = { id: str(args.id) || `research-${state.research.length + 1}`, intentId, category, hypothesis, preconditions: Array.isArray(args.preconditions) ? args.preconditions.filter((x) => typeof x === "string") : [], status, stopReason: str(args.stopReason), evidence: Array.isArray(args.evidence) ? args.evidence.filter((x) => typeof x === "string") : [], findingId: str(args.findingId) || void 0, updatedAt: Number(args.updatedAt) || 0 };
			const existing = state.research.findIndex((row) => row.intentId === intentId && row.category === category);
			const research = [...state.research];
			if (existing >= 0) research[existing] = { ...record, id: research[existing].id }; else research.push(record);
			return { ...state, research: research.slice(-500) };
		}
		case "src_record_asset_observation":
		case "src_add_asset": {
			const type = typeof args.type === "string" && ASSET_TYPES$1.has(args.type) ? args.type : void 0;
			if (type === void 0) return state;
			const value = str(args.value);
			if (value === "") return state;
			const parentId = str(args.parentId);
			if (parentId !== "" && !state.assets.some((asset) => asset.id === parentId)) return state;
			if (state.assets.some((asset) => asset.type === type && asset.value.toLowerCase() === value.toLowerCase())) return state;
			const { id, counters } = nextNodeId(state, "asset");
			return withAsset(state, {
				id,
				type,
				value,
				meta: str(args.meta), source: str(args.source) || "unknown", method: ["passive", "low-impact", "authorized-active", "user-confirmed"].includes(args.method) ? args.method : "passive", confidence: typeof args.confidence === "number" ? Math.min(1, Math.max(0, args.confidence)) : .5, status: ["candidate", "confirmed", "excluded"].includes(args.status) ? args.status : "confirmed"
			}, parentId === "" ? void 0 : parentId, counters);
		}
		case "src_test_bypass": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const category = typeof args.category === "string" && BYPASS_CATEGORIES.includes(args.category) ? args.category : "authorization-bypass";
			const blocked = args.forceAfterProtection === true ? false : JSON.stringify(args).includes("requiresDecision");
			const coverage = [...state.coverage];
			const existing = coverage.findIndex((row) => row.phase === category && row.category === "bypass-verification");
			const record = { id: str(args.id) || `coverage-${state.coverage.length + 1}`, assetId: str(args.assetId) || void 0, phase: category, category: "bypass-verification", status: blocked ? "blocked" : "testing", evidence: [], limitation: blocked ? "protection/waf/rate-limit signal" : "", updatedAt: 0 };
			if (existing >= 0) coverage[existing] = { ...record, id: coverage[existing].id }; else coverage.push(record);
			return { ...state, coverage: coverage.slice(-500) };
		}
		case "src_collect_passive": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const coverage = [...state.coverage];
			const existing = coverage.findIndex((row) => row.phase === "discovery" && row.category === "passive-collection");
			const status = JSON.stringify(args).includes("requiresDecision") ? "blocked" : "completed";
			const record = { id: str(args.id) || `coverage-${state.coverage.length + 1}`, assetId: void 0, phase: "discovery", category: "passive-collection", status, evidence: [], limitation: status === "blocked" ? "protection detected before passive collection" : "", updatedAt: 0 };
			if (existing >= 0) coverage[existing] = { ...record, id: coverage[existing].id }; else coverage.push(record);
			return { ...state, coverage: coverage.slice(-500) };
		}
		case "src_update_intent": {
			const intentId = str(args.intentId);
			const status = args.status;
			if (!["planned", "running", "completed", "blocked", "failed"].includes(status)) return state;
			return { ...state, nodes: state.nodes.map((node) => node.kind === "intent" && node.id === intentId ? { ...node, status } : node) };
		}
		case "src_checkpoint": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const stage = ["progress", "completed", "blocked", "failed"].includes(args.stage) ? args.stage : "progress";
			const checkpoint = { id: str(args.id), intentId, childSessionId: str(args.childSessionId), stage, summary: str(args.summary), facts: Number(args.facts) || 0, assets: Number(args.assets) || 0, findings: Number(args.findings) || 0, batchKey: str(args.batchKey), createdAt: Number(args.createdAt) || 0 };
			if (checkpoint.id === "" || checkpoint.batchKey === "" || state.checkpoints.some((row) => row.id === checkpoint.id || row.batchKey === checkpoint.batchKey)) return state;
			const status = stage === "completed" ? "completed" : stage === "blocked" ? "blocked" : stage === "failed" ? "failed" : "running";
			return { ...state, nodes: state.nodes.map((node) => node.kind === "intent" && node.id === intentId ? { ...node, status } : node), checkpoints: [...state.checkpoints, checkpoint].slice(-200) };
		}
		default: return state;
	}
}
/** Project the fold state onto the wire payload (null before the first goal). */
function viewSrcState(state) {
	if (state.goal === null) return null;
	return {
		goal: state.goal,
		nodes: state.nodes,
		assets: state.assets,
		coverage: state.coverage,
		research: state.research,
		checkpoints: state.checkpoints,
		edges: state.edges,
		counts: {
			intents: state.nodes.filter((node) => node.kind === "intent").length,
			facts: state.nodes.filter((node) => node.kind === "fact").length,
			findings: state.nodes.filter((node) => node.kind === "finding").length,
			assets: state.assets.length,
			coverage: state.coverage.length,
			research: state.research.length,
			checkpoints: state.checkpoints.length
		}
	};
}
//#endregion
//#region src/spec.ts
/**
* Durable storage-domain declaration for the penetration-testing mode: the
* per-task exploration graph.
*
* One engagement (per session) starts at a **goal**; the exploration advances
* along a chain — goal spawns **intents**, an intent yields **facts**, a fact
* derives a new intent, and an intent proves a **finding** (vulnerability
* with reproducible steps). **Assets** (root domain / subdomain / ip / service
* / app / endpoint) form a second, parent-linked graph. Every relationship is
* an explicit **edge** row, so both graphs are fully reconstructible.
*
* Everything is scoped to a single session: every record carries the owning
* `sessionId`. Record schemas are zod; the domain schema validates every
* stored record at the durable boundary (the storage-domain facility is the
* package's guard, so no separate event invariant companion is needed).
* @module @deepseek-ai/dsh-src/src/spec
*/
/** Kind of a discovered fact (free-form evidence tag). */
const srcFactKindSchema = z.enum([
	"port",
	"service",
	"vuln",
	"finding",
	"http",
	"info"
]);
/** Severity of a vulnerability finding. */
const srcSeveritySchema = z.enum([
	"critical",
	"high",
	"medium",
	"low",
	"info"
]);
/** Kind of a recorded asset. */
const srcAssetTypeSchema = z.enum([
	"root-domain",
	"subdomain",
	"ip",
	"service",
	"app",
	"endpoint",
	"mini-program",
	"client",
	"firmware",
	"ai-surface",
	"threat-intel"
]);
/** Kind of an exploration/asset graph edge. */
const srcEdgeKindSchema = z.enum([
	"spawns",
	"yields",
	"derived_from",
	"proves",
	"parent"
]);
/** Non-empty id. */
const id = z.string().min(1);
/** The engagement goal: one per session, reset by the next goal. */
const srcGoalSchema = z.object({
	id,
	sessionId: id,
	target: z.string(),
	objective: z.string(),
	/**
	* Declarative authorization note for the engagement (permission holder or
	* written-permission reference). Recorded as an auditable fact, not a
	* gate: enforcement stays at the deployment's sandbox/approval layer.
	*/
	authorization: z.string().default("")
});
/** One exploration intent (what to verify / pursue next). */
const srcIntentSchema = z.object({
	id,
	sessionId: id,
	title: z.string().min(1),
	detail: z.string().default(""),
	status: z.enum(["planned", "running", "completed", "blocked", "failed"]).default("planned")
});
/** One durable progress checkpoint emitted by a delegated child. */
const srcCheckpointSchema = z.object({
	id,
	sessionId: id,
	intentId: id,
	childSessionId: id,
	stage: z.enum(["progress", "completed", "blocked", "failed"]),
	summary: z.string().default(""),
	facts: z.number().int().nonnegative(),
	assets: z.number().int().nonnegative(),
	findings: z.number().int().nonnegative(),
	batchKey: z.string().min(1),
	decision: z.string().default(""),
	createdAt: z.number().int().nonnegative()
});
/** One discovered fact (evidence) yielded by an intent. */
const srcFactSchema = z.object({
	id,
	sessionId: id,
	intentId: id,
	kind: srcFactKindSchema,
	target: z.string().default(""),
	detail: z.string().min(1),
	confidence: z.number().min(0).max(1).default(.5)
});
/** One vulnerability finding proved by an intent, with reproducible steps. */
const srcFindingSchema = z.object({
	id,
	sessionId: id,
	intentId: id,
	title: z.string().min(1),
	severity: srcSeveritySchema,
	description: z.string().default(""),
	impact: z.string().min(1),
	affectedScope: z.string().min(1),
	remediation: z.string().min(1),
	pocEvidence: z.array(z.string().min(1)).min(1),
	/** Concrete, ordered steps that reproduce the vulnerability (min one). */
	reproducibleSteps: z.array(z.string().min(1)).min(1),
	/** Front-end entry point (功能点) where the issue is reachable. */
	entryPoint: z.string().default(""),
	/** Source chain of the interface/discovery (接口来源链). */
	discoveryPath: z.string().default(""),
	/** Burp-format raw request packet (必須非空提交). */
	rawRequest: z.string().default(""),
	/** Key response raw bytes (Burp format). */
	rawResponse: z.string().default(""),
	/** Optional asset the finding affects. */
	affectedAssetId: id.optional()
});
/** One recorded asset; parent linkage lives on the `parent` edge row. */
const srcAssetSchema = z.object({
	id,
	sessionId: id,
	type: srcAssetTypeSchema,
	value: z.string().min(1),
	meta: z.string().default(""),
	source: z.string().default("unknown"),
	method: z.enum(["passive", "low-impact", "authorized-active", "user-confirmed"]).default("passive"),
	confidence: z.number().min(0).max(1).default(.5),
	status: z.enum(["candidate", "confirmed", "excluded"]).default("confirmed")
});
const srcCoverageSchema = z.object({
	id, sessionId: id, assetId: id.optional(), phase: z.string().min(1), category: z.string().min(1),
	status: z.enum(["planned", "running", "completed", "blocked", "not-applicable"]),
	evidence: z.array(z.string()).default([]), limitation: z.string().default(""), updatedAt: z.number().int().nonnegative()
});
/** One HTTP observation from an active probe or imported traffic (timeline). */
const srcObservationSchema = z.object({
	id, sessionId: id, intentId: id.optional(), assetId: id.optional(),
	method: z.string().default("GET"), path: z.string().min(1), httpStatus: z.number().int().default(0),
	respHeaders: z.string().default(""), respBodySnippet: z.string().default(""),
	protectionSignal: z.boolean().default(false), wafBypassed: z.boolean().default(false),
	source: z.enum(["burp-mcp", "har", "raw", "manual", "scan"]).default("scan"),
	decision: z.string().default(""), createdAt: z.number().int().nonnegative()
});
/** One user-assist todo awaiting a human action (e.g. login state capture). */
const srcUserTodoSchema = z.object({
	id, sessionId: id, intentId: id.optional(),
	title: z.string().min(1),
	detail: z.string().default(""),
	kind: z.enum(["auth-session", "burp-enable", "asset-provide", "decision", "manual-test", "other"]).default("other"),
	status: z.enum(["pending", "done", "abandoned"]).default("pending"),
	note: z.string().default(""), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative()
});
const srcResearchSchema = z.object({
	id, sessionId: id, intentId: id, category: z.string().min(1), hypothesis: z.string().min(1),
	preconditions: z.array(z.string()).default([]), status: z.enum(["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"]),
	stopReason: z.string().default(""), evidence: z.array(z.string()).default([]), findingId: id.optional(), updatedAt: z.number().int().nonnegative()
});
/** One graph edge: source → target with a semantic kind. */
const srcEdgeSchema = z.object({
	id,
	sessionId: id,
	kind: srcEdgeKindSchema,
	sourceId: id,
	targetId: id
});
/** The whole src domain: goal/intent/fact/finding/asset nodes plus edges. */
const srcDomainSpec = defineDomain({
	name: "src",
	version: 7,
	tables: {
		goals: domainTable(srcGoalSchema),
		intents: domainTable(srcIntentSchema),
		facts: domainTable(srcFactSchema),
		findings: domainTable(srcFindingSchema),
		assets: domainTable(srcAssetSchema),
		coverage: domainTable(srcCoverageSchema),
		research: domainTable(srcResearchSchema),
		checkpoints: domainTable(srcCheckpointSchema),
		observations: domainTable(srcObservationSchema),
		user_todos: domainTable(srcUserTodoSchema),
		edges: domainTable(srcEdgeSchema)
	}
});
//#endregion
//#region src/store.ts
/** The record table owning each id kind. */
const TABLE_OF_ID_KIND = {
	goal: "goals",
	intent: "intents",
	fact: "facts",
	finding: "findings",
	asset: "assets",
	coverage: "coverage",
	research: "research",
	checkpoint: "checkpoints",
	observation: "observations",
	userTodo: "user_todos",
	edge: "edges"
};
const SESSION_SCOPED_TABLES = [
	"intents",
	"facts",
	"findings",
	"assets",
	"coverage",
	"research",
	"checkpoints",
	"observations",
	"user_todos",
	"edges"
];
/** Physical key for a session-local graph node or edge. */
function recordKey(sessionId, id) {
	return `${sessionId}:${id}`;
}
/** Copy and freeze one record before it crosses the service boundary. */
function snapshot(value) {
	return Object.freeze({ ...value });
}
/** Shared open promises keyed by domain name, so a second `providerName` (`srcDomainSpec`). */
const sharedDomainOpens = /* @__PURE__ */ new Map();
/**
* Owning handle for the lazily opened src domain. Not a Cordis service: it
* is a private helper owned by the plugin `apply` fiber and disposed with it.
*/
var SrcStore = class {
	ctx;
	domainPromise;
	constructor(ctx) {
		this.ctx = ctx;
	}
	/** Resolve the opened domain, opening it lazily on first use. */
	domain() {
		if (this.domainPromise === void 0) {
			const key = srcDomainSpec.name;
			const cached = sharedDomainOpens.get(key);
			if (cached !== void 0) {
				try { console.warn(`[dsh-src] domain '${key}' already open elsewhere — reusing the shared open promise to avoid double-open.`); } catch {}
				this.domainPromise = cached;
			} else {
				const p = this.ctx.storageDomain.open(srcDomainSpec).then(async (domain) => {
					await this.migrateLegacyKeys(domain);
					return domain;
				});
				sharedDomainOpens.set(key, p);
				p.catch(() => sharedDomainOpens.delete(key));
				this.domainPromise = p;
			}
		}
		return this.domainPromise;
	}
	/** Move legacy global-id rows to the session-scoped key format once. */
	async migrateLegacyKeys(domain) {
		for (const name of SESSION_SCOPED_TABLES) {
			const table = domain.table(name);
			for (const [key, row] of table.entries()) {
				const record = row;
				const scopedKey = recordKey(record.sessionId, record.id);
				if (key === scopedKey) continue;
				if (table.get(scopedKey) === void 0) await table.put(scopedKey, row);
				await table.delete(key);
			}
		}
	}
	/** Close the domain and release its backend unit (idempotent). */
	async dispose() {
		const pending = this.domainPromise;
		if (pending !== void 0) {
			this.domainPromise = void 0;
			await (await pending).close();
		}
	}
	/** Read one session's goal row, if present. */
	async getGoal(sessionId) {
		return (await this.domain()).table("goals").get(sessionId);
	}
	/** Read the goal row, failing with a guiding error when absent. */
	async requireGoal(sessionId) {
		const goal = await this.getGoal(sessionId);
		if (goal === void 0) throw new Error("src engagement is not initialized; call src_add_goal with target and objective first");
		return goal;
	}
	/** The next deterministic id for one kind in one session (max existing seq + 1). */
	async nextId(kind, sessionId) {
		const table = (await this.domain()).table(TABLE_OF_ID_KIND[kind]);
		let max = 0;
		for (const [, row] of table.entries()) {
			if (row.sessionId !== sessionId) continue;
			const match = /-(\d+)$/.exec(row.id);
			/* v8 ignore next 1 -- unreachable: every row this store writes carries the `<kind>-<n>` id pattern. */
			if (match !== null) max = Math.max(max, Number(match[1]));
		}
		return `${kind}-${max + 1}`;
	}
	/** Delete every exploration row of one session (goal reset). */
	async clearSession(sessionId) {
		const domain = await this.domain();
		for (const name of [
			"goals",
			"intents",
			"facts",
			"findings",
			"assets",
			"coverage",
			"research",
			"checkpoints",
			"edges"
		]) {
			const table = domain.table(name);
			for (const [key, row] of table.entries()) if (row.sessionId === sessionId) await table.delete(key);
		}
	}
	/**
	* Create or reset the engagement goal. A new goal clears the whole
	* exploration graph of the session and restarts fresh counters.
	*/
	async initGoal(sessionId, input) {
		await this.clearSession(sessionId);
		const goal = snapshot({
			id: "goal-1",
			sessionId,
			target: input.target,
			objective: input.objective,
			authorization: input.authorization
		});
		await (await this.domain()).table("goals").put(sessionId, goal);
		return goal;
	}
	/** Validate a reference row (same session, expected table) or fail loud. */
	async requireRef(sessionId, tableName, refId, label) {
		const row = (await this.domain()).table(tableName).get(recordKey(sessionId, refId));
		if (row === void 0) throw new Error(`src: unknown ${label} ${refId}`);
		/* v8 ignore next -- session-scoped keys are normalized on domain open and the domain has one writer. */
		if (row.sessionId !== sessionId) throw new Error(`src: ${label} ${refId} belongs to another session`);
	}
	/** Mint one node (and its connecting edge) in one write. */
	async addNode(sessionId, edgeKind, sourceId, nodeKind, node) {
		await this.requireGoal(sessionId);
		const domain = await this.domain();
		const nodeId = await this.nextId(nodeKind, sessionId);
		const record = snapshot({
			id: nodeId,
			sessionId,
			...node
		});
		await domain.table(TABLE_OF_ID_KIND[nodeKind]).put(recordKey(sessionId, nodeId), record);
		if (edgeKind === void 0) return { nodeId };
		const edgeId = await this.nextId("edge", sessionId);
		const edge = snapshot({
			id: edgeId,
			sessionId,
			kind: edgeKind,
			sourceId,
			targetId: nodeId
		});
		await domain.table("edges").put(recordKey(sessionId, edgeId), edge);
		return {
			nodeId,
			edge: {
				id: edgeId,
				kind: edgeKind,
				sourceId,
				targetId: nodeId
			}
		};
	}
	/** Record one intent spawned by the goal or derived from a fact. */
	async addIntent(sessionId, input) {
		if ((input.goalId !== void 0 ? 1 : 0) + (input.derivedFromFactId !== void 0 ? 1 : 0) !== 1) throw new Error("src_add_intent requires exactly one anchor: goalId (spawns) or derivedFromFactId (derived_from)");
		const existing = (await this.sessionData(sessionId)).intents.find((intent) => intent.title.trim().toLowerCase() === input.title.trim().toLowerCase() && intent.detail.trim().toLowerCase() === input.detail.trim().toLowerCase());
		if (existing !== void 0) return { nodeId: existing.id, duplicate: true };
		if (input.goalId !== void 0) {
			const goal = await this.requireGoal(sessionId);
			if (input.goalId !== goal.id) throw new Error(`src: unknown goal ${input.goalId}`);
			return this.addNode(sessionId, "spawns", input.goalId, "intent", {
				title: input.title,
				detail: input.detail,
				status: "planned"
			});
		}
		/* v8 ignore next 1 -- unreachable: anchors === 1 and the goalId branch returned, so the derived anchor is present. */
		const derivedFromFactId = input.derivedFromFactId ?? "";
		await this.requireRef(sessionId, "facts", derivedFromFactId, "fact");
		return this.addNode(sessionId, "derived_from", derivedFromFactId, "intent", {
			title: input.title,
			detail: input.detail,
			status: "planned"
		});
	}
	/** Update the lifecycle status of one intent. */
	async updateIntent(sessionId, intentId, status) {
		await this.requireRef(sessionId, "intents", intentId, "intent");
		const table = (await this.domain()).table("intents");
		const key = recordKey(sessionId, intentId);
		const current = table.get(key);
		const record = snapshot({ ...current, status });
		await table.put(key, record);
		return record;
	}
	/** Append one durable delegated-child progress checkpoint. */
	async addCheckpoint(sessionId, input) {
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		const table = (await this.domain()).table("checkpoints");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.intentId === input.intentId && row.childSessionId === input.childSessionId && row.stage === input.stage && row.summary === input.summary && row.facts === input.facts && row.assets === input.assets && row.findings === input.findings && row.batchKey === input.batchKey);
		if (existing !== void 0) return { ...existing, duplicate: true };
		const checkpointId = await this.nextId("checkpoint", sessionId);
		const record = snapshot({ id: checkpointId, sessionId, ...input, createdAt: Date.now() });
		await table.put(recordKey(sessionId, checkpointId), record);
		const status = input.stage === "completed" ? "completed" : input.stage === "blocked" ? "blocked" : input.stage === "failed" ? "failed" : "running";
		await this.updateIntent(sessionId, input.intentId, status);
		return record;
	}
	/** Record one fact yielded by an intent. */
	async addFact(sessionId, input) {
		await this.requireGoal(sessionId);
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		const existing = (await this.sessionData(sessionId)).facts.find((fact) => fact.intentId === input.intentId && fact.kind === input.kind && fact.target.trim().toLowerCase() === input.target.trim().toLowerCase() && fact.detail.trim().toLowerCase() === input.detail.trim().toLowerCase());
		if (existing !== void 0) return { nodeId: existing.id, duplicate: true };
		return this.addNode(sessionId, "yields", input.intentId, "fact", {
			intentId: input.intentId,
			kind: input.kind,
			target: input.target,
			detail: input.detail,
			confidence: input.confidence
		});
	}
	/** Record one finding proved by an intent (with reproducible steps). */
	async addFinding(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.reproducibleSteps.length === 0) throw new Error("src_add_finding requires at least one reproducible step");
		if (input.impact === "" || input.affectedScope === "" || input.remediation === "" || input.pocEvidence.length === 0) throw new Error("src_add_finding requires impact, affectedScope, remediation, and pocEvidence");
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		if (input.affectedAssetId !== void 0) await this.requireRef(sessionId, "assets", input.affectedAssetId, "asset");
		const existing = (await this.sessionData(sessionId)).findings.find((finding) => finding.title.trim().toLowerCase() === input.title.trim().toLowerCase() && (finding.affectedAssetId ?? "") === (input.affectedAssetId ?? ""));
		if (existing !== void 0) return { nodeId: existing.id, duplicate: true };
		return this.addNode(sessionId, "proves", input.intentId, "finding", {
			intentId: input.intentId,
			title: input.title,
			severity: input.severity,
			description: input.description,
			impact: input.impact,
			affectedScope: input.affectedScope,
			remediation: input.remediation,
			pocEvidence: [...input.pocEvidence],
			reproducibleSteps: [...input.reproducibleSteps],
			entryPoint: input.entryPoint ?? "",
			discoveryPath: input.discoveryPath ?? "",
			rawRequest: input.rawRequest ?? "",
			rawResponse: input.rawResponse ?? "",
			...input.affectedAssetId !== void 0 ? { affectedAssetId: input.affectedAssetId } : {}
		});
	}
	/** Record one asset; an optional parent links it into the asset graph. */
	async addAsset(sessionId, input) {
		await this.requireGoal(sessionId);
		const parentId = input.parentId === "" ? void 0 : input.parentId;
		if (parentId !== void 0) await this.requireRef(sessionId, "assets", parentId, "asset");
		const existing = (await this.sessionData(sessionId)).assets.find((asset) => asset.type === input.type && asset.value.trim().toLowerCase() === input.value.trim().toLowerCase());
		if (existing !== void 0) {
			const rank = { candidate: 0, confirmed: 1, excluded: 2 };
			const record = snapshot({ ...existing, meta: input.meta || existing.meta, source: input.source ?? existing.source, method: input.method ?? existing.method, confidence: Math.max(existing.confidence ?? 0, input.confidence ?? 0), status: rank[input.status ?? "confirmed"] >= rank[existing.status ?? "confirmed"] ? input.status ?? "confirmed" : existing.status });
			await (await this.domain()).table("assets").put(recordKey(sessionId, existing.id), record);
			return { nodeId: existing.id, duplicate: true, updated: true };
		}
		return this.addNode(sessionId, parentId === void 0 ? void 0 : "parent", parentId ?? "", "asset", {
			type: input.type,
			value: input.value,
			meta: input.meta,
			source: input.source ?? "unknown",
			method: input.method ?? "passive",
			confidence: input.confidence ?? .5,
			status: input.status ?? "confirmed"
		});
	}
	/** Record coverage for an asset/phase/category combination. */
	async upsertCoverage(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.assetId !== void 0) await this.requireRef(sessionId, "assets", input.assetId, "asset");
		const table = (await this.domain()).table("coverage");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.assetId === input.assetId && row.phase === input.phase && row.category === input.category);
		const idValue = existing?.id ?? await this.nextId("coverage", sessionId);
		const record = snapshot({ id: idValue, sessionId, ...input, evidence: [...input.evidence], updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return { ...record, updated: existing !== void 0 };
	}
	/** Record or update a vulnerability research hypothesis. */
	async upsertResearch(sessionId, input) {
		await this.requireGoal(sessionId);
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		if (input.findingId !== void 0) await this.requireRef(sessionId, "findings", input.findingId, "finding");
		const table = (await this.domain()).table("research");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.intentId === input.intentId && row.category === input.category);
		const idValue = existing?.id ?? await this.nextId("research", sessionId);
		const record = snapshot({ id: idValue, sessionId, ...input, preconditions: [...input.preconditions], evidence: [...input.evidence], updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return { ...record, updated: existing !== void 0 };
	}
	/** Record one HTTP observation row (timeline/evidence layer). */
	async upsertObservation(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.intentId !== void 0) await this.requireRef(sessionId, "intents", input.intentId, "intent");
		if (input.assetId !== void 0) await this.requireRef(sessionId, "assets", input.assetId, "asset");
		const table = (await this.domain()).table("observations");
		const idValue = await this.nextId("observation", sessionId);
		const record = snapshot({ id: idValue, sessionId, method: input.method ?? "GET", path: input.path, httpStatus: input.httpStatus ?? 0, respHeaders: input.respHeaders ?? "", respBodySnippet: input.respBodySnippet ?? "", protectionSignal: input.protectionSignal ?? false, wafBypassed: input.wafBypassed ?? false, source: input.source ?? "scan", decision: input.decision ?? "", createdAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return record;
	}
	/** Record one user-assist todo awaiting a human action. */
	async upsertUserTodo(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.intentId !== void 0) await this.requireRef(sessionId, "intents", input.intentId, "intent");
		const table = (await this.domain()).table("user_todos");
		const existing = input.userTodoId !== void 0 ? [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.id === input.userTodoId) : void 0;
		if (existing !== void 0) {
			const record = snapshot({ ...existing, title: input.title ?? existing.title, detail: input.detail ?? existing.detail, status: input.status ?? existing.status, note: input.note ?? existing.note, updatedAt: Date.now() });
			await table.put(recordKey(sessionId, existing.id), record);
			return { ...record, updated: true };
		}
		delete input.userTodoId;
		const idValue = await this.nextId("userTodo", sessionId);
		const record = snapshot({ id: idValue, sessionId, title: input.title, detail: input.detail ?? "", kind: input.kind ?? "other", status: input.status ?? "pending", note: input.note ?? "", createdAt: Date.now(), updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return record;
	}
	/** Read all exploration rows of one session, ordered by id (insertion order). */
	async sessionData(sessionId) {
		const domain = await this.domain();
		const bySession = (rows) => [...rows].map(([, row]) => row).filter((row) => row.sessionId === sessionId).sort((a, b) => a.id.localeCompare(b.id, "en"));
		return {
			goal: await this.getGoal(sessionId),
			intents: bySession(domain.table("intents").entries()),
			facts: bySession(domain.table("facts").entries()),
			findings: bySession(domain.table("findings").entries()),
			assets: bySession(domain.table("assets").entries()),
			coverage: bySession(domain.table("coverage").entries()),
			research: bySession(domain.table("research").entries()),
			checkpoints: bySession(domain.table("checkpoints").entries()),
			observations: bySession(domain.table("observations").entries()),
			userTodos: bySession(domain.table("user_todos").entries()),
			edges: bySession(domain.table("edges").entries())
		};
	}
	/** Build the model-visible summary view for one session. */
	async view(sessionId) {
		const { goal, intents, facts, findings, assets, coverage, research, checkpoints, observations, userTodos, edges } = await this.sessionData(sessionId);
		if (goal === void 0) return {
			initialized: false,
			intents: [],
			facts: [],
			findings: [],
			assets: [],
			coverage: [],
			research: [],
			checkpoints: [],
			observations: [],
			userTodos: [],
			edges: [],
			counts: {
				intents: 0,
				facts: 0,
				findings: 0,
				assets: 0,
				coverage: 0,
				research: 0,
				checkpoints: 0,
				observations: 0,
				userTodos: 0
			}
		};
		return snapshot({
			initialized: true,
			goal,
			intents,
			facts,
			findings,
			assets,
			coverage,
			research,
			checkpoints,
			observations,
			userTodos,
			edges,
			counts: {
				intents: intents.length,
				facts: facts.length,
				findings: findings.length,
				assets: assets.length,
				coverage: coverage.length,
				research: research.length,
				checkpoints: checkpoints.length,
				observations: observations.length,
				userTodos: userTodos.length
			}
		});
	}
};
//#endregion
//#region src/tools.ts
/** Resolve the calling session id or fail a non-agent caller (like todo_write). */
function sessionIdOf(exec) {
	if (!exec.agent) throw new Error("src_* tools require an owning agent session");
	return exec.agent.session.id;
}
/** Resolve the only graph a delegated child is allowed to submit into. */
function parentSessionIdOf(exec) {
	const parentSessionId = exec.agent?.session.header?.parentSession;
	if (parentSessionId === void 0 || parentSessionId === "") throw new Error("src_submit is only available to a delegated subagent with a parent session");
	return parentSessionId;
}
function requiredString(value, name) {
	if (typeof value !== "string" || value === "") throw new Error(`src_submit requires ${name}`);
	return value;
}
/** Reject prompt variables before they are mistaken for a parent graph id. */
function concreteIntentId(value) {
	const normalized = value.trim();
	if (/^(?:[<{[]\s*)?(?:delegation[-_])?intent[-_]?id(?:\s*[>}\]])?$/i.test(normalized)) throw new Error(`src_submit requires the concrete parent intent ID returned by src_add_intent; received placeholder ${JSON.stringify(value)}`);
	return normalized;
}
function optionalString(value) {
	return typeof value === "string" ? value : "";
}
function submissionList(value, name) {
	if (!Array.isArray(value) || !value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) throw new Error(`src_submit requires ${name} to be an array of objects`);
	return value;
}
function stringList(value, name) {
	if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item !== "")) throw new Error(`src_submit ${name} must be a non-empty array of strings`);
	return value;
}
function enumValue(value, allowed, fallback, name) {
	if (value === void 0) return fallback;
	if (typeof value === "string" && allowed.includes(value)) return value;
	throw new Error(`src_submit ${name} must be one of: ${allowed.join(", ")}`);
}
function stableBatchKey(value) {
	return JSON.stringify(value, Object.keys(value).sort());
}
function confidenceValue(value) {
	if (value === void 0) return .5;
	const text = typeof value === "string" ? value.trim() : void 0;
	const isPercent = text?.endsWith("%") === true;
	const parsed = typeof value === "number" ? value : text === void 0 || text === "" ? NaN : Number(isPercent ? text.slice(0, -1) : text);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error("src_submit confidence must be 0..1 or a percentage from 0 to 100");
	if (isPercent || parsed > 1) {
		if (parsed > 100) throw new Error("src_submit confidence must be 0..1 or a percentage from 0 to 100");
		return parsed / 100;
	}
	return parsed;
}
/** Completed generic card for the read-only projections: a domain title over the raw content. */
function titledCard(title, result) {
	if (result.isError) return void 0;
	return {
		card: "generic",
		title,
		content: result.content
	};
}
/** The closed enum values exposed by the tools. */
const FACT_KINDS = [
	"port",
	"service",
	"vuln",
	"finding",
	"http",
	"info"
];
const SEVERITIES = [
	"critical",
	"high",
	"medium",
	"low",
	"info"
];
const recoveryAttempts = new Map();
const ASSET_TYPES = [
	"root-domain",
	"subdomain",
	"ip",
	"service",
	"app",
	"endpoint",
	"mini-program",
	"client",
	"firmware",
	"ai-surface",
	"threat-intel"
];
/** Broken-access-control / bypass vulnerability classes that SRC treats as first-class research categories. */
const BYPASS_CATEGORIES = [
	"authentication-bypass",
	"authorization-bypass",
	"idor-bola",
	"tenant-isolation",
	"workflow-bypass",
	"method-bypass",
	"path-normalization",
	"parser-discrepancy",
	"rate-limit-bypass",
	"cache-auth-boundary",
	"waf-rule-gap",
	"oauth-flow-bypass"
];
/** HTTP methods a bypass hypothesis may safely vary. POST is allowed only with an explicit allowBody flag. */
const BYPASS_METHODS = [
	"GET",
	"HEAD",
	"OPTIONS",
	"POST"
];
let submissionProjectionEvent = 0;
/**
* Drive the live parent projection from a delegated write. The durable graph
* lives in storage, while the Web client consumes the session projection;
* regular tool calls are the shared, known event vocabulary that updates both
* the projection and history replay without introducing a custom session event.
*/
function appendSubmissionProjection(parent, intentId, facts, assets, findings, checkpoint) {
	const append = parent.append.bind(parent);
	const calls = [
		// Projection replay applies the same semantic deduplication as the store.
		// The parent session remains the source of truth if a duplicate checkpoint arrives.
		...[],
		...facts.map((fact) => ({
			name: "src_add_fact",
			args: {
				...fact,
				intentId
			}
		})),
		...assets.map((asset) => ({
			name: "src_add_asset",
			args: { ...asset }
		})),
		...findings.map((finding) => ({
			name: "src_add_finding",
			args: {
				...finding,
				intentId
			}
		}))
	];
	for (const call of calls) {
		submissionProjectionEvent += 1;
		append("tool/call", {
			turn: 0,
			step: submissionProjectionEvent,
			callId: `src-submit-${submissionProjectionEvent}`,
			name: call.name,
			arguments: JSON.stringify(call.args)
		});
	}
	submissionProjectionEvent += 1;
	append("tool/call", {
		turn: 0,
		step: submissionProjectionEvent,
		callId: `src-submit-${submissionProjectionEvent}`,
		name: "src_checkpoint",
		arguments: JSON.stringify({ intentId, ...checkpoint })
	});
}
/** Build the exploration-chain dump for one session (pure projection). */
function buildGraph(state) {
	return {
		goal: state.goal ?? null,
		intents: state.intents,
		facts: state.facts,
		findings: state.findings,
		assets: state.assets,
		coverage: state.coverage ?? [],
		research: state.research ?? [],
		checkpoints: state.checkpoints ?? [],
		edges: state.edges
	};
}
/** Build the final report for one session (pure projection). */
function buildReport(state) {
	if (state.goal === void 0) return [
		"# SRC 漏洞挖掘报告",
		"",
		"（未初始化：尚未调用 src_add_goal。）"
	].join("\n");
	const goal = state.goal;
	const anchorOf = (targetId) => {
		const edge = state.edges.find((e) => e.targetId === targetId);
		/* v8 ignore next 1 -- unreachable: the store writes the connecting edge with every node. */
		return edge === void 0 ? "?" : `${edge.kind} ${edge.sourceId}`;
	};
	const chainLines = [
		`- 目标 (goal ${goal.id})「${goal.target}」— 目的: ${goal.objective}`,
		...state.intents.map((intent) => `- 意图 (intent ${intent.id})「${intent.title}」(${anchorOf(intent.id)})${intent.detail === "" ? "" : ` — ${intent.detail}`}`),
		...state.facts.map((fact) => `- 事实 (fact ${fact.id}) [${fact.kind}] ${fact.target === "" ? "" : `${fact.target}: `}${fact.detail} (${anchorOf(fact.id)})`),
		...state.findings.map((finding) => `- 漏洞 (finding ${finding.id}) [${finding.severity}] ${finding.title} (${anchorOf(finding.id)})`)
	];
	const findingSections = state.findings.map((finding) => {
		const asset = finding.affectedAssetId === void 0 ? void 0 : state.assets.find((a) => a.id === finding.affectedAssetId);
		const domain = asset === void 0 ? goal.target.replace(/^https?:\/\//, "").split("/")[0] : asset.value.replace(/^https?:\/\//, "").split("/")[0];
		const fullUrl = (() => {
			const evidence = finding.pocEvidence.join("\n") + "\n" + finding.reproducibleSteps.join("\n");
			const m = evidence.match(/https?:\/\/[^\s'"\\)]+/);
			return m === null ? (asset === void 0 ? goal.target : asset.value) : m[0];
		})();
		return [
			`### ${finding.id} [${finding.severity}] ${finding.title}`,
			`- 漏洞描述: ${finding.description === "" ? finding.title : finding.description}`,
			`- 危害描述: ${finding.impact}`,
			`- 域名: ${domain}`,
			`- 完整 URL: ${fullUrl}`,
			`- 漏洞接口来源: ${finding.discoveryPath === "" ? "（未填写接口来源链）" : finding.discoveryPath}`,
			`- 前端功能点: ${finding.entryPoint === "" ? "（未填写）" : finding.entryPoint}`,
			"- 数据包（Burp 格式 raw 请求/响应）:",
			...(finding.rawRequest ?? "") === "" ? ["  （rawRequest 缺失，须补 Burp 格式原始请求）"] : [`  === Request ===`, finding.rawRequest],
			...(finding.rawResponse ?? "") === "" ? [] : [`  === Response ===`, finding.rawResponse],
			"- 补充 POC 证据（pocEvidence）:",
			...finding.pocEvidence.map((evidence, index) => `  ${index + 1}. ${evidence}`),
			`- 证明截图说明: ${finding.pocEvidence.length > 0 || (finding.rawRequest ?? "") !== "" ? "按上述 raw 请求/可复现步骤逐步执行并截取响应即可；单报告单类型业务线，必填否则被忽略" : "（无）"}`,
			`- 影响范围: ${finding.affectedScope}`,
			`- 修复建议: ${finding.remediation}`,
			`- 影响资产: ${asset === void 0 ? "（未关联）" : `[${asset.type}] ${asset.value}`}`,
			"- 可复现步骤:",
			...finding.reproducibleSteps.map((step, index) => `  ${index + 1}. ${step}`)
		].join("\n");
	});
	const assetLines = state.assets.map((asset) => {
		const parent = state.edges.find((e) => e.kind === "parent" && e.targetId === asset.id);
		const parentAsset = parent === void 0 ? void 0 : state.assets.find((a) => a.id === parent.sourceId);
		let metaText = asset.meta;
		if (typeof asset.meta === "string" && asset.meta.startsWith("api:")) {
			const space = asset.meta.indexOf(" ");
			const kind = space === -1 ? asset.meta.slice(4) : asset.meta.slice(4, space);
			const rest = space === -1 ? "" : asset.meta.slice(space + 1);
			let detail = rest;
			try {
				if (rest !== "") detail = Object.entries(JSON.parse(rest)).map(([k, v]) => `${k}=${v}`).join(", ");
			} catch {}
			metaText = `API/${kind}${detail === "" ? "" : `: ${detail}`}`;
		}
		return `- [${asset.type}] ${asset.value}${metaText === "" ? "" : `（${metaText}）`}${parentAsset === void 0 ? "" : ` ← ${parentAsset.value}`}`;
	});
	const apiAssets = state.assets.filter((asset) => asset.type === "endpoint" && typeof asset.meta === "string" && asset.meta.startsWith("api:"));
	const apiSummary = {
		total: apiAssets.length,
		schemas: apiAssets.filter((asset) => asset.meta.startsWith("api:openapi-schema") || asset.meta.startsWith("api:schema-path")).length,
		graphql: apiAssets.filter((asset) => asset.meta.startsWith("api:graphql-endpoint")).length,
		hints: apiAssets.filter((asset) => asset.meta.startsWith("api:html-js-hint") || asset.meta.startsWith("api:html-js-family")).length,
		untouched: (() => {
			const coverage = state.coverage ?? [];
			const research = state.research ?? [];
			return apiAssets.filter((asset) => {
				const assetCoverage = coverage.filter((row) => row.assetId === asset.id);
				const hasProgress = assetCoverage.some((row) => ["running", "completed", "blocked", "not-applicable"].includes(row.status));
				const assetResearch = research.filter((row) => (row.evidence ?? []).some((evidence) => evidence.includes(asset.value)) || row.hypothesis.includes(asset.value));
				const hasManualResearchProgress = assetResearch.some((row) => row.status !== "hypothesis" || !(row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				return !hasProgress && !hasManualResearchProgress;
			}).length;
		})(),
		examples: apiAssets.slice(0, 5).map((asset) => asset.value)
	};
	const coverageLines = (state.coverage ?? []).map((row) => `- ${row.id} [${row.status}] ${row.phase}/${row.category}${row.assetId === void 0 ? "" : ` → ${row.assetId}`}${row.limitation === "" ? "" : ` — ${row.limitation}`}${row.evidence.length === 0 ? "" : `（${row.evidence.join("; ")}）`}`);
	const researchLines = (state.research ?? []).map((row) => `- ${row.id} [${row.status}] ${row.category}: ${row.hypothesis}${row.stopReason === "" ? "" : ` — ${row.stopReason}`}`);
	const checkpointLines = (state.checkpoints ?? []).map((checkpoint) => `- ${checkpoint.id} [${checkpoint.stage}] ${checkpoint.intentId} / ${checkpoint.childSessionId}: ${checkpoint.summary === "" ? "（无摘要）" : checkpoint.summary}（+${checkpoint.facts} facts, +${checkpoint.assets} assets, +${checkpoint.findings} findings）`);
	return [
		"# SRC 漏洞挖掘报告",
		"",
		`- 目标 (target): ${goal.target}`,
		`- 目的 (objective): ${goal.objective}`,
		`- 授权 (authorization): ${goal.authorization === "" ? "（未声明）" : goal.authorization}`,
		"",
		"## 探索链路",
		...chainLines.length === 1 ? ["（仅目标，尚未展开）"] : chainLines,
		"",
		"## 漏洞发现",
		...findingSections.length === 0 ? ["（无）"] : findingSections,
		"",
		"## API 发现摘要",
		`- 总数: ${apiSummary.total}`,
		`- OpenAPI / schema: ${apiSummary.schemas}`,
		`- GraphQL: ${apiSummary.graphql}`,
		`- JS/HTML hint: ${apiSummary.hints}`,
		`- 尚未推进: ${apiSummary.untouched}`,
		...(apiSummary.examples.length === 0 ? ["- 示例: （无）"] : [`- 示例: ${apiSummary.examples.join(", ")}`]),
		"",
		"## 资产",
		...assetLines.length === 0 ? ["（无）"] : assetLines,
		"",
		"## 资产与测试覆盖率",
		...coverageLines.length === 0 ? ["（无）"] : coverageLines,
		"",
		"## 漏洞研究矩阵",
		...researchLines.length === 0 ? ["（无）"] : researchLines,
		"",
		"## 子 Agent 检查点",
		...checkpointLines.length === 0 ? ["（无）"] : checkpointLines,
		"",
		"## 建议人工测试的 AI/威胁情报资产",
		...(state.assets ?? []).filter((asset) => asset.type === "ai-surface" || asset.type === "threat-intel").length === 0 ? ["（无）"] : (state.assets ?? []).filter((asset) => asset.type === "ai-surface" || asset.type === "threat-intel").map((asset) => `- [${asset.type}] ${asset.value}（${asset.meta}）— prompt-injection/模型越权/key 泄露/SSRF via tool-call，建议人工测试`),
		"",
	].join("\n");
}
/** Register all `src_*` tools on the caller's tool registry. */
function registerSrcTools(ctx, store) {
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
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Scanned ${v.requested} paths: ${v.responses} responses, ${v.hints} interface hints.` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const goal = await store.getGoal(sessionId);
			if (goal === void 0) throw new Error("src_scan_surface requires an initialized SRC goal");
			const target = new URL(goal.target.includes("://") ? goal.target : `https://${goal.target}`);
			const base = new URL(args.baseUrl.includes("://") ? args.baseUrl : `https://${args.baseUrl}`);
			if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(target.protocol)) throw new Error("src_scan_surface supports only http/https targets");
			if (base.hostname !== target.hostname && !base.hostname.endsWith(`.${target.hostname}`)) throw new Error("src_scan_surface target is outside the authorized goal host");
			const paths = [...new Set((Array.isArray(args.paths) ? args.paths : []).filter((path) => typeof path === "string" && path.startsWith("/")).slice(0, 100))];
			const preflightController = new AbortController();
			const preflightTimer = setTimeout(() => preflightController.abort(), 5000);
			let preflight;
			try {
				const response = await fetch(new URL("/", base), { method: "GET", redirect: "manual", signal: preflightController.signal, headers: { "user-agent": "dsh-src-recon/1" } });
				const headers = [...response.headers.entries()].filter(([name]) => ["server", "via", "x-cache", "cf-ray", "x-sucuri-id", "x-cdn", "x-waf"].includes(name)).map(([name, value]) => `${name}: ${value}`);
				const text = (response.headers.get("content-type") ?? "").includes("text/html") ? (await response.text()).slice(0, 8192) : "";
				const challenge = /captcha|challenge|access denied|attention required|cloudflare|sucuri|akamai/i.test(`${headers.join(" ")} ${text}`);
				preflight = { status: response.status, headers, challenge, protection: challenge || [401, 403, 429].includes(response.status) };
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
						const r2 = await fetch(new URL("/", base), { method: "GET", redirect: "manual", signal: c2.signal, headers: { "user-agent": ua, "accept": "text/html,application/xhtml+xml" } });
						const ok = r2.status < 400 && ![401, 403, 429].includes(r2.status);
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
						const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "user-agent": "dsh-src-recon/1" } });
						const contentType = response.headers.get("content-type") ?? "";
					const length = Number(response.headers.get("content-length") ?? 0) || 0;
					if (response.status === 429 && !rateLimitBackoffUsed) { rateLimitBackoffUsed = true; await new Promise((resolve) => setTimeout(resolve, 3000)); }
					else if (response.status === 429 || [401, 403, 503].includes(response.status)) protectionSignals += 1;
					if (protectionSignals >= 2) stopped = true;
						const result = { path: url.pathname, status: response.status, contentType, length, protectionSignal: [401, 403, 429, 503].includes(response.status) };
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
			return { baseUrl: base.origin, requested: paths.length, responses: results.filter((result) => result.status !== void 0).length, hints: results.reduce((count, result) => count + (result.hints?.length ?? 0), 0), preflight, stopped: stopped ? "protection-signal" : void 0, requiresDecision: stopped, results };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_test_bypass",
		description: "Verify a broken-access-control / bypass hypothesis with a bounded baseline→variant comparison. Requires an initialized goal, an existing src_record_research hypothesis, and an in-scope asset URL. Runs a small, explicit variant list (GET/HEAD/OPTIONS, or POST only with allowBody) against a baseline and reports a reproducible boundary differential if the authentication/authorization outcome changes. It never requests outside the authorized host, never stores response bodies, stops on WAF/403/429/challenge unless the commander explicitly continues, and never auto-creates a finding: a boundary differential alone is not impact proof. The commander records impact/authorization proof and promotes the research to verified before any finding is reportable.",
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
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Bypass hypothesis ${v.researchId}: ${v.differential ? "boundary differential reproduced" : "no differential"}; tested ${v.results.length} variants.` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const goal = await store.getGoal(sessionId);
			if (goal === void 0) throw new Error("src_test_bypass requires an initialized SRC goal");
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(sessionId, "intents", intentId, "intent");
			const researchId = concreteIntentId(requiredString(args.researchId, "researchId"));
			await store.requireRef(sessionId, "research", researchId, "research");
			const target = new URL(goal.target.includes("://") ? goal.target : `https://${goal.target}`);
			const base = new URL(args.baseUrl.includes("://") ? args.baseUrl : `https://${args.baseUrl}`);
			if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(target.protocol)) throw new Error("src_test_bypass supports only http/https targets");
			if (base.hostname !== target.hostname && !base.hostname.endsWith(`.${target.hostname}`)) throw new Error("src_test_bypass target is outside the authorized goal host");
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
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeoutMs);
				try {
					const response = await fetch(url, { method: req.method, redirect: "manual", signal: controller.signal, headers: { "user-agent": "dsh-src/1", "content-type": req.method === "POST" ? "application/x-www-form-urlencoded" : void 0, ...req.headers }, body: req.body === void 0 ? void 0 : req.body });
					const contentType = response.headers.get("content-type") ?? "";
					const length = Number(response.headers.get("content-length") ?? 0) || 0;
					const loc = response.status >= 300 && response.status < 400 ? response.headers.get("location") ?? "" : "";
					const protection = [401, 403, 429, 503].includes(response.status) || /captcha|challenge|access denied|attention required|cloudflare|sucuri|akamai/i.test((response.headers.get("server") ?? "") + " " + (response.headers.get("via") ?? ""));
					return { ...req, status: response.status, contentType, length, redirect: loc, protection };
				} catch (error) {
					return { ...req, status: void 0, error: error.name === "AbortError" ? "timeout" : "network-error" };
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
			const evidence = [`${category}|${intentId}|baseline=${baselineR?.status ?? "err"}|differential=${differential ? "yes" : "no"}|requiresDecision=${requiresDecision ? "yes" : "no"}`, ...results.map((r) => `${r.phase}|${r.method}|${r.path}|${r.status ?? r.error}|${r.protection ? "protection" : "ok"}`)];
			// Fold the run into the tracked research record so verification stays durable and linked.
			const researchRow = (await store.sessionData(sessionId)).research.find((row) => row.id === researchId);
			if (researchRow !== void 0) await store.upsertResearch(sessionId, {
				intentId, category: researchRow.category, hypothesis: researchRow.hypothesis, preconditions: researchRow.preconditions,
				status: researchRow.status === "hypothesis" ? "testing" : researchRow.status, stopReason: researchRow.stopReason,
				evidence: [...researchRow.evidence, ...evidence], ...researchRow.findingId !== void 0 ? { findingId: researchRow.findingId } : {}
			});
			if (requiresDecision && args.forceAfterProtection !== true) {
				await store.upsertCoverage(sessionId, { assetId: args.assetId && typeof args.assetId === "string" ? args.assetId : void 0, phase: category, category: "bypass-verification", status: "blocked", evidence, limitation: "protection/waf/rate-limit signal; commander decision required" });
				return { researchId: args.researchId, category, differential: false, requiresDecision: true, results };
			}
			await store.upsertCoverage(sessionId, { assetId: args.assetId && typeof args.assetId === "string" ? args.assetId : void 0, phase: category, category: "bypass-verification", status: differential ? "completed" : "completed", evidence, limitation: "" });
			return { researchId: args.researchId, category, differential, requiresDecision: false, results };
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
			const goal = await store.getGoal(sessionId);
			if (goal === void 0) throw new Error("src_test_credential requires an initialized SRC goal");
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(sessionId, "intents", intentId, "intent");
			const target = new URL(goal.target.includes("://") ? goal.target : `https://${goal.target}`);
			const login = new URL(args.loginUrl.includes("://") ? args.loginUrl : `https://${args.loginUrl}`);
			if (!/^https?:$/.test(login.protocol)) throw new Error("src_test_credential supports only http/https targets");
			if (login.hostname !== target.hostname && !login.hostname.endsWith(`.${target.hostname}`)) throw new Error("src_test_credential target is outside the authorized goal host");
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
					const response = await fetch(login, { method: "POST", redirect: "manual", signal: controller.signal, headers: { "user-agent": "dsh-src/1", "content-type": "application/x-www-form-urlencoded" }, body });
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
					if ([401, 403, 429, 503].includes(response.status)) { requiresDecision = true; stopReason = "protection-signal"; break; }
				} catch (error) {
					results.push({ credential: candidate.slice(0, 2) + "***", error: error.name === "AbortError" ? "timeout" : "network-error" });
				} finally { clearTimeout(timer); }
			}
			const evidence = [`credential-test|${intentId}|${login.hostname}${login.pathname}|user=${username}|source=${dictionarySource}|tried=${results.length}|hit=${hit}${hit ? "|hitCredential=" + hitCredential : ""}|requiresDecision=${requiresDecision ? "yes" : "no"}${stopReason ? "|stop=" + stopReason : ""}`, ...results.map((r) => `${r.credential}|${r.status ?? r.error}|${r.hit ? "hit" : r.captcha ? "captcha" : "miss"}`)];
			// 命中即记 fact（凭据证据不落明文到 fact 正文，仅记录命中状态与来源）
			if (hit) await store.addFact(sessionId, { intentId, kind: "vuln", target: login.origin, detail: `凭据命中：${login.host}${login.pathname} 用户 ${username}（来源：${dictionarySource}）；完整凭据见 research evidence，需独立复核后升 finding`, confidence: 0.9 });
			const researchRow = (await store.sessionData(sessionId)).research.find((row) => row.intentId === intentId && row.category === "credential-test");
			if (researchRow !== void 0) await store.upsertResearch(sessionId, { intentId, category: "credential-test", hypothesis: researchRow.hypothesis, preconditions: researchRow.preconditions, status: hit ? "reproduced" : researchRow.status === "hypothesis" ? "testing" : researchRow.status, stopReason: researchRow.stopReason, evidence: [...researchRow.evidence, ...evidence], ...researchRow.findingId !== void 0 ? { findingId: researchRow.findingId } : {} });
			await store.upsertCoverage(sessionId, { assetId: void 0, phase: "credential-test", category: "authentication", status: hit ? "completed" : requiresDecision ? "blocked" : "completed", evidence, limitation: requiresDecision ? `${stopReason}；指挥官决策后可继续` : "" });
			return { intentId, loginUrl: login.origin + login.pathname, username, triedCount: results.length, hit, hitUser: hit ? username : "", hitCredentialRedacted: hit ? hitCredential.slice(0, 2) + "***" : "", requiresDecision, stopReason, results };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_observation",
		description: "记录一次 HTTP 主动探测或导入流量得到的观察（时间线/证据层）。每次显式请求后（或 Burp/har 导入恢复的流量）调用，使时间线能展示真实请求、防护信号与绕过结果，并连同决策理由。有界：只记状态码、响应片段(<=2000字符)、是否撞 WAF/401/403/429、是否绕过尝试成功。",
		parameters: {
			intentId: { type: "string", description: "发起本次探测的 intent。" },
			assetId: { type: "string", description: "被探测的资产(endpoint/service)。" },
			method: { type: "string", description: "HTTP 方法，默认 GET。" },
			path: { type: "string", required: true, description: "观察到的请求 URL/路径。" },
			httpStatus: { type: "integer", description: "HTTP 响应状态码。" },
			respHeaders: { type: "string", description: "关键响应头(如 Server、Content-Type)。" },
			respBodySnippet: { type: "string", description: "响应体短片段。" },
			protectionSignal: { type: "boolean", description: "该响应是否为 WAF/403/429/401/challenge。" },
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
			return record;
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_user_todo",
		description: "创建、完成或放弃一个用户待办项——一项必须先由人工完成才能继续测试的工作（如提供已登录的 Burp 请求给认证会话、启用 Burp MCP、提供 App/小程序下载链接）。创建时给 title+detail；用户反馈完成后用同一 userTodoId 并将 status 改为 done 并附一个 note。pending/done 待办会列在 src_state.userTodos。凡完整测试被只靠人工能提供的输入阻塞时使用。",
		parameters: {
			userTodoId: { type: "string", description: "要更新的既有待办 id（省略则新建）。" },
			intentId: { type: "string", description: "该待办解除阻塞的 intent（可选）。" },
			title: { type: "string", required: true, description: "给用户看的简短待办标题。" },
			detail: { type: "string", description: "agent 需要什么、用户如何提供。" },
			kind: { type: "string", enum: ["auth-session", "burp-enable", "asset-provide", "decision", "manual-test", "other"], description: "待办类别。" },
			status: { type: "string", enum: ["pending", "done", "abandoned"], description: "新建为 pending；用户响应后 done/abandoned。" },
			note: { type: "string", description: "用户备注/说明（自由文本）。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: "todo " + v.id + " [" + v.status + "] " + v.title }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const record = await store.upsertUserTodo(sessionId, {
				...args.userTodoId !== void 0 ? { userTodoId: args.userTodoId } : {},
				...args.intentId !== void 0 ? { intentId: args.intentId } : {},
				title: args.title, ...args.detail !== void 0 ? { detail: args.detail } : {},
				...args.kind !== void 0 ? { kind: args.kind } : {}, ...args.status !== void 0 ? { status: args.status } : {},
				...args.note !== void 0 ? { note: args.note } : {}
			});
			return record;
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_import_traffic",
		description: "从 Burp MCP / HAR / raw HTTP 文本导入已认证流量，解决登录态盲区与 React chunk 404（proxy history 里有完整真实流量）。三种模式：mcp=传入已用 mcp__burp__get_proxy_history 拿到的 flows 数组；har=传入 HAR JSON 字符串；raw=传入 raw HTTP 请求文本（Burp 格式）。仅导入 host 在授权 goal 内的流量；认证头(Cookie/Authorization/Token)完整入库为 auth-profile fact（供子 agent 直接复用构造请求、判断凭据权限范围与实际危害；仅存本地库，报告导出时注意不要外传）。请求/响应落 observations(时间线)、endpoint 落 asset(candidate)。不发新请求，只解析已有流量。",
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
			const goal = await store.getGoal(sessionId);
			if (goal === void 0) throw new Error("src_import_traffic requires an initialized SRC goal");
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(sessionId, "intents", intentId, "intent");
			const target = new URL(goal.target.includes("://") ? goal.target : `https://${goal.target}`);
			const inScope = (host) => host === target.hostname || host.endsWith(`.${target.hostname}`);
			const parseFlows = [];
			const outOfScope = { count: 0 };
			if (args.mode === "mcp") {
				for (const f of Array.isArray(args.flows) ? args.flows : []) {
					try { const u = new URL(f.url); if (!inScope(u.hostname)) { outOfScope.count++; continue; } parseFlows.push({ method: f.method || "GET", url: f.url, status: Number(f.status) || 0, reqHeaders: f.reqHeaders || "", respHeaders: f.respHeaders || "", body: (f.body || "").slice(0, 2000) }); } catch { outOfScope.count++; }
				}
			} else if (args.mode === "har") {
				let har;
				try { har = JSON.parse(requiredString(args.data, "data")); } catch { throw new Error("src_import_traffic: HAR JSON 解析失败"); }
				for (const entry of (har?.log?.entries ?? [])) {
					try { const u = new URL(entry.request?.url); if (!inScope(u.hostname)) { outOfScope.count++; continue; } parseFlows.push({ method: entry.request?.method || "GET", url: entry.request?.url, status: entry.response?.status || 0, reqHeaders: (entry.request?.headers ?? []).map((h) => h.name + ": " + h.value).join("\n"), respHeaders: (entry.response?.headers ?? []).map((h) => h.name + ": " + h.value).join("\n"), body: ((entry.response?.content?.text) || "").slice(0, 2000) }); } catch { outOfScope.count++; }
				}
			} else if (args.mode === "raw") {
				const text = requiredString(args.data, "data");
				const lines = text.split("\r?\n");
				const reqLine = lines[0] || "";
				const m = reqLine.match(/^(\S+)\s+(\S+)/);
				if (m) {
					const hostHeader = lines.find((l) => /^host:/i.test(l));
					const host = hostHeader ? hostHeader.split(":").slice(1).join(":").trim() : target.hostname;
					if (!inScope(host)) { outOfScope.count++; } else parseFlows.push({ method: m[1], url: `https://${host}${m[2]}`, status: 0, reqHeaders: lines.slice(0, 20).join("\n"), respHeaders: "", body: "" });
				}
			}
			const authFactKeys = /* @__PURE__ */ new Set();
			let obsCount = 0, assetCount = 0;
			for (const f of parseFlows) {
				let url; try { url = new URL(f.url); } catch { continue; }
				await store.upsertObservation(sessionId, { intentId, method: f.method, path: url.pathname + url.search, httpStatus: f.status, respHeaders: f.respHeaders, respBodySnippet: f.body, protectionSignal: [401, 403, 429, 503].includes(f.status), wafBypassed: false, source: args.mode === "mcp" ? "burp-mcp" : args.mode === "har" ? "har" : "raw", decision: "imported traffic" });
				obsCount++;
				await store.addAsset(sessionId, { type: "endpoint", value: url.host + url.pathname, meta: `imported-endpoint ${f.method}`, source: args.mode, method: "passive", confidence: 0.7, status: "candidate" });
				assetCount++;
				const authHeaders = f.reqHeaders.split("\n").filter((l) => /^(cookie|authorization|token|x-auth|x-csrf)/i.test(l));
				for (const line of authHeaders) {
					const sep = line.indexOf(":");
					if (sep < 0) continue;
					const k = line.slice(0, sep).trim().toLowerCase();
					const v = line.slice(sep + 1).trim();
					if (authFactKeys.has(k + ":" + v.slice(0, 4))) continue;
					authFactKeys.add(k + ":" + v.slice(0, 4));
					await store.addFact(sessionId, { intentId, kind: "auth-profile", target: url.host, detail: `${k}: ${v}${args.authProfileNote ? "；用户声明：" + args.authProfileNote : ""}`, confidence: 0.9 });
				}
			}
			await store.upsertCoverage(sessionId, { assetId: void 0, phase: "recon", category: "traffic-import", status: "completed", evidence: [`import ${args.mode}: ${obsCount} in-scope, ${outOfScope.count} out-of-scope`], limitation: outOfScope.count > 0 ? `${outOfScope.count} 条流量越界已跳过` : "" });
			return { mode: args.mode, observations: obsCount, assets: assetCount, authFacts: authFactKeys.size, outOfScope: outOfScope.count };
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
			const goal = await store.getGoal(sessionId);
			if (goal === void 0) throw new Error("src_collect_dorks requires an initialized SRC goal");
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(sessionId, "intents", intentId, "intent");
			const target = new URL(goal.target.includes("://") ? goal.target : `https://${goal.target}`);
			const domain = requiredString(args.domain, "domain").trim().toLowerCase();
			if (domain !== target.hostname && !domain.endsWith(`.${target.hostname}`) && !target.hostname.endsWith(`.${domain}`)) throw new Error("src_collect_dorks domain is outside the authorized goal host");
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
						const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(item.q)}`, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "accept": "text/html" } });
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
			const goal = await store.getGoal(sessionId);
			if (goal === void 0) throw new Error("src_collect_passive requires an initialized SRC goal");
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(sessionId, "intents", intentId, "intent");
			const target = new URL(goal.target.includes("://") ? goal.target : `https://${goal.target}`);
			const base = new URL(args.baseUrl.includes("://") ? args.baseUrl : `https://${args.baseUrl}`);
			if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(target.protocol)) throw new Error("src_collect_passive supports only http/https targets");
			if (base.hostname !== target.hostname && !base.hostname.endsWith(`.${target.hostname}`)) throw new Error("src_collect_passive target is outside the authorized goal host");
			const hostnames = [...new Set([target.hostname, base.hostname, ...((Array.isArray(args.hostnames) ? args.hostnames : []).filter((host) => typeof host === "string").map((host) => host.trim().toLowerCase()).filter((host) => host !== "" && (host === target.hostname || host.endsWith(`.${target.hostname}`))))])].slice(0, 20);
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
			const preflight = await fetch(new URL("/", base), { method: "GET", redirect: "manual", headers: { "user-agent": "dsh-src-passive/1" } }).catch((error) => ({ status: 0, headers: new Headers(), error }));
			if (preflight.status !== void 0 && [401, 403, 429, 503].includes(preflight.status)) {
				await store.upsertCoverage(sessionId, { phase: "discovery", category: "passive-collection", status: "blocked", evidence: [`preflight ${preflight.status}`], limitation: "protection detected before passive collection" });
				return { assets: 0, facts: 0, sources: 0, preflight: preflight.status, requiresDecision: true, results: [] };
			}
			const endpointParentId = await recordAsset("app", base.origin, "passive root", "passive", "passive", .7, "candidate");
			// AI 站点/大模型/威胁情报资产识别（P7/P8：发现即收录并留人工测试）
			try {
				const aiResp = await fetch(new URL("/", base), { method: "GET", redirect: "manual", headers: { "user-agent": "dsh-src-passive/1" } });
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
					const response = await fetch(url, { method: "GET", redirect: "manual", headers: { "user-agent": "dsh-src-passive/1" } });
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
		description: "Immediately submit each newly confirmed delegated result directly into the specified parent intent. Available only to subagents: it records facts, assets, and confirmed findings in the parent graph, refreshes the parent projection, then returns only submission counts. Use it as real-time checkpoints; never resubmit an item. parentId and affectedAssetId may reference only an existing parent-session asset supplied in the delegation; omit either field for a newly submitted asset.",
		parameters: {
			intentId: {
				type: "string",
				required: true,
				description: "The parent intent id supplied in the delegation prompt."
			},
			facts: {
				type: "array",
				required: true,
				description: "Observed facts to attach to the parent intent.",
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
				required: true,
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
							description: "资产来源（crt.sh/DNS/官网导航/JS bundle/手工确认等），必须填写以保留溯源。"
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
				required: true,
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
							description: "严重级别 critical/high/medium/low/info。"
						},
						impact: { type: "string", required: true, description: "危害描述：明确的实际安全/业务危害，纯指纹/信息暴露不算真实危害。" },
						affectedScope: { type: "string", required: true, description: "影响范围：受影响的用户/记录/主机/端点。" },
						remediation: { type: "string", required: true, description: "修复建议。" },
						entryPoint: { type: "string", description: "前端功能点：漏洞入口的前端页面/功能（如“找回密码页-手机号输入框”）。" },
						discoveryPath: { type: "string", description: "漏洞接口来源链：该接口如何被发现（如“React chunk 解析 / mobile/js/app.js → api/resetPwd”或“Burp proxy history 导入”）。" },
						rawRequest: { type: "string", description: "Burp 格式 raw 请求报文（必填门禁：报告 finalize 会拦截空 rawRequest；至少含接口地址）。" },
						rawResponse: { type: "string", description: "关键响应 raw 报文（Burp 格式）。" },
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
			const facts = submissionList(input.facts, "facts");
			const assets = submissionList(input.assets, "assets");
			const findings = submissionList(input.findings, "findings");
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
				reproducibleSteps: stringList(finding.reproducibleSteps, "finding.reproducibleSteps"),
				entryPoint: optionalString(finding.entryPoint),
				discoveryPath: optionalString(finding.discoveryPath),
				rawRequest: optionalString(finding.rawRequest),
				rawResponse: optionalString(finding.rawResponse),
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
				if (!result.duplicate) acceptedFacts.push(write);
			}
			for (const write of assetWrites) {
				const result = await store.addAsset(parentSessionId, write);
				if (!result.duplicate) acceptedAssets.push(write);
			}
			for (const write of findingWrites) {
				const result = await store.addFinding(parentSessionId, write);
				if (!result.duplicate) acceptedFindings.push(write);
			}
			const stage = enumValue(input.stage, ["progress", "completed", "blocked", "failed"], "progress", "stage");
			const summary = optionalString(input.summary);
			const batchKey = stableBatchKey({ intentId, childSessionId, stage, summary, facts: factWrites, assets: assetWrites, findings: findingWrites });
			const checkpoint = await store.addCheckpoint(parentSessionId, { intentId, childSessionId, stage, summary, decision: optionalString(input.decision), facts: acceptedFacts.length, assets: acceptedAssets.length, findings: acceptedFindings.length, batchKey });
			if (!checkpoint.duplicate) appendSubmissionProjection(parent, intentId, acceptedFacts, acceptedAssets, acceptedFindings, { id: checkpoint.id, childSessionId, stage, summary, facts: acceptedFacts.length, assets: acceptedAssets.length, findings: acceptedFindings.length, createdAt: checkpoint.createdAt, batchKey });
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
		description: "Commander-only bounded recovery for a failed SRC child. Use after the runtime delivers a failed settlement notice. It sends one explicit follow-up through the official continuation API, which may cold-resume the persisted child. Maximum two recoveries per parent/intent/child; this tool never loops automatically.",
		parameters: {
			childSessionId: { type: "string", required: true, description: "Failed continuable child session id." },
			intentId: { type: "string", required: true, description: "Parent SRC intent assigned to this child." },
			message: { type: "string", required: true, description: "Bounded recovery task; include the real intent id and remaining scope." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { messageId: { type: "string", required: true }, attempt: { type: "number", required: true } } }, render: (_a, v) => [{ type: "text", text: `Recovery message ${v.messageId} queued for ${v.attempt}/2.` }] },
		execute: async (args, exec) => {
			const parent = exec.agent;
			if (!parent) throw new Error("src_recover_child requires a calling agent");
			const sessionId = sessionIdOf(exec);
			const childSessionId = requiredString(args.childSessionId, "childSessionId");
			const intentId = requiredString(args.intentId, "intentId");
			await store.requireRef(sessionId, "intents", intentId, "intent");
			const linked = (await store.sessionData(sessionId)).checkpoints.some((checkpoint) => checkpoint.childSessionId === childSessionId && checkpoint.intentId === intentId);
			if (!linked) throw new Error("src_recover_child requires a child checkpoint linked to the specified parent intent");
			const key = `${sessionId}:${intentId}:${childSessionId}`;
			const attempt = (recoveryAttempts.get(key) ?? 0) + 1;
			if (attempt > 2) throw new Error("src_recover_child recovery limit reached (2)");
			recoveryAttempts.set(key, attempt);
			const message = `SRC recovery attempt ${attempt}/2 for parent intent ${intentId}. ${requiredString(args.message, "message")} Submit a progress or completed checkpoint with src_submit; do not expand scope.`;
			try {
				const messageId = await ctx.subagents.followup(parent, SessionId(childSessionId), [{ type: "text", text: message }], { source: { kind: "coordinator", form: "relay", senderSessionId: parent.id }, signal: exec.signal });
				await store.updateIntent(sessionId, intentId, "running");
				return { messageId, attempt };
			} catch (error) {
				recoveryAttempts.delete(key);
				throw error;
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_asset_observation",
		description: "Normalize one authorized asset observation with provenance. This is the asset-collection boundary: preserve candidate/confirmed/excluded status, source, method, confidence, and optional parent asset.",
		parameters: {
			intentId: { type: "string", required: true }, type: { type: "string", required: true, enum: ASSET_TYPES }, value: { type: "string", required: true }, parentId: { type: "string" }, source: { type: "string", required: true }, method: { type: "string", required: true, enum: ["passive", "low-impact", "authorized-active", "user-confirmed"] }, confidence: { type: "number", required: true }, status: { type: "string", required: true, enum: ["candidate", "confirmed", "excluded"] }, meta: { type: "string" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { assetId: { type: "string", required: true }, duplicate: { type: "boolean", required: true } } }, render: (_a, v) => [{ type: "text", text: `Asset observation ${v.assetId} recorded${v.duplicate ? " (duplicate)" : ""}.` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			await store.requireRef(sessionId, "intents", requiredString(args.intentId, "intentId"), "intent");
			const write = await store.addAsset(sessionId, { type: enumValue(args.type, ASSET_TYPES, "endpoint", "type"), value: requiredString(args.value, "value"), ...typeof args.parentId === "string" ? { parentId: args.parentId } : {}, meta: optionalString(args.meta), source: requiredString(args.source, "source"), method: enumValue(args.method, ["passive", "low-impact", "authorized-active", "user-confirmed"], "passive", "method"), confidence: Math.min(1, Math.max(0, Number(args.confidence))), status: enumValue(args.status, ["candidate", "confirmed", "excluded"], "confirmed", "status") });
			return { assetId: write.nodeId, duplicate: write.duplicate === true };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_research",
		description: "Track one vulnerability research hypothesis through testing, reproduction, verification, false-positive, or blocked status. Use this for every vulnerability category before creating a reportable finding.",
		parameters: {
			intentId: { type: "string", required: true }, category: { type: "string", required: true }, hypothesis: { type: "string", required: true }, preconditions: { type: "array", items: { type: "string" } }, status: { type: "string", required: true, enum: ["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"] }, stopReason: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, findingId: { type: "string" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, updated: { type: "boolean", required: true } } }, render: (_a, v) => [{ type: "text", text: `Research ${v.id} ${v.updated ? "updated" : "recorded"}.` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const record = await store.upsertResearch(sessionId, { intentId: requiredString(args.intentId, "intentId"), category: requiredString(args.category, "category"), hypothesis: requiredString(args.hypothesis, "hypothesis"), preconditions: Array.isArray(args.preconditions) ? args.preconditions.filter((x) => typeof x === "string") : [], status: enumValue(args.status, ["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"], "hypothesis", "status"), stopReason: optionalString(args.stopReason), evidence: Array.isArray(args.evidence) ? args.evidence.filter((x) => typeof x === "string") : [], ...typeof args.findingId === "string" ? { findingId: args.findingId } : {} });
			return { id: record.id, updated: record.updated };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_coverage",
		description: "Record coverage for an asset and assessment category. Use planned/running/completed/blocked/not-applicable with evidence or an explicit limitation so the final report can distinguish tested from untested areas.",
		parameters: {
			assetId: { type: "string" }, phase: { type: "string", required: true }, category: { type: "string", required: true }, status: { type: "string", required: true, enum: ["planned", "running", "completed", "blocked", "not-applicable"] }, evidence: { type: "array", items: { type: "string" } }, limitation: { type: "string" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, updated: { type: "boolean", required: true } } }, render: (_a, v) => [{ type: "text", text: `Coverage ${v.id} ${v.updated ? "updated" : "recorded"}.` }] },
		execute: async (args, exec) => {
			const record = await store.upsertCoverage(sessionIdOf(exec), { ...typeof args.assetId === "string" ? { assetId: args.assetId } : {}, phase: requiredString(args.phase, "phase"), category: requiredString(args.category, "category"), status: enumValue(args.status, ["planned", "running", "completed", "blocked", "not-applicable"], "planned", "status"), evidence: Array.isArray(args.evidence) ? args.evidence.filter((x) => typeof x === "string") : [], limitation: optionalString(args.limitation) });
			return { id: record.id, updated: record.updated };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_recon",
		description: "Normalize authorized reconnaissance output into SRC assets and facts. Use existing bash/fs/web tools for collection; this tool only records passive or low-impact results with source and confidence. It does not expand scope or perform network requests.",
		parameters: {
			intentId: { type: "string", required: true, description: "Existing reconnaissance intent id." },
			source: { type: "string", required: true, description: "Collection source, for example crt.sh, DNS, page HTML, JS bundle, or authorized low-impact probe." },
			method: { type: "string", enum: ["passive", "low-impact"], required: true, description: "Collection method." },
			assets: { type: "array", required: true, description: "Discovered assets to normalize.", items: { type: "object", additionalProperties: false, properties: { type: { type: "string", required: true, enum: ASSET_TYPES }, value: { type: "string", required: true }, parentId: { type: "string" }, meta: { type: "string" } } } },
			facts: { type: "array", required: true, description: "Evidence such as ports, services, fingerprints, certificates, or extracted interfaces.", items: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: FACT_KINDS }, target: { type: "string" }, detail: { type: "string", required: true }, confidence: { oneOf: [{ type: "number" }, { type: "string" }] } } } }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { assets: { type: "number", required: true }, facts: { type: "number", required: true }, source: { type: "string", required: true }, method: { type: "string", required: true } } }, render: (_a, v) => [{ type: "text", text: `Recorded reconnaissance from ${v.source}: ${v.assets} assets, ${v.facts} facts.` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const intentId = requiredString(args.intentId, "intentId");
			const source = requiredString(args.source, "source");
			const method = enumValue(args.method, ["passive", "low-impact"], "passive", "method");
			await store.requireRef(sessionId, "intents", intentId, "intent");
			const assets = submissionList(args.assets, "assets").map((asset) => ({ type: enumValue(asset.type, ASSET_TYPES, "endpoint", "asset.type"), value: requiredString(asset.value, "asset.value"), meta: `${optionalString(asset.meta)}${optionalString(asset.meta) === "" ? "" : " | "}${source} (${method})`, source, method, confidence: confidenceValue(asset.confidence), status: enumValue(asset.status, ["candidate", "confirmed", "excluded"], "confirmed", "asset.status"), ...typeof asset.parentId === "string" ? { parentId: asset.parentId } : {} }));
			const facts = submissionList(args.facts, "facts").map((fact) => ({ intentId, kind: enumValue(fact.kind, FACT_KINDS, "info", "fact.kind"), target: optionalString(fact.target), detail: `${requiredString(fact.detail, "fact.detail")} [source: ${source}; method: ${method}]`, confidence: confidenceValue(fact.confidence) }));
			for (const asset of assets) await store.addAsset(sessionId, asset);
			for (const fact of facts) await store.addFact(sessionId, fact);
			return { assets: assets.length, facts: facts.length, source, method };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_goal",
		description: "Start a penetration-testing engagement: set the target and objective, RESETTING the whole exploration graph of this session (a new goal starts a fresh chain). Call this once before recording intents, facts, findings, or assets. Record the engagement authorization (permission holder or written-permission reference) as a declarative audit fact — the package enforces no gate by itself.",
		parameters: {
			target: {
				type: "string",
				required: true,
				description: "The penetration target (host, URL, network scope, or repo path)."
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
					}
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded goal ${v.id} → ${v.target}.`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const goal = await store.initGoal(sessionId, {
				target: args.target,
				objective: args.objective,
				authorization: args.authorization ?? ""
			});
			return {
				id: goal.id,
				target: goal.target,
				objective: goal.objective
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_intent",
		description: "Record one exploration intent (what to verify / pursue next) as a node in the exploration chain. Anchor it with EXACTLY ONE of: goalId (spawns: an intent exploring toward the goal) or derivedFromFactId (derived_from: a new intent derived from a previously recorded fact). The edge kind is recorded automatically.",
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
				description: "Anchor goal id (spawns edge). Exactly one of goalId / derivedFromFactId is required."
			},
			derivedFromFactId: {
				type: "string",
				description: "Anchor fact id (derived_from edge). Exactly one of goalId / derivedFromFactId is required."
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
					}
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded intent ${v.id}「${v.title}」 (${v.edgeKind} ${v.sourceId} → ${v.id}, edge ${v.edgeId}).`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const write = await store.addIntent(sessionId, {
				title: args.title,
				detail: args.detail ?? "",
				...args.goalId !== void 0 ? { goalId: args.goalId } : {},
				...args.derivedFromFactId !== void 0 ? { derivedFromFactId: args.derivedFromFactId } : {}
			});
			/* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for intent writes. */
			return {
				id: write.nodeId,
				title: args.title,
				edgeId: write.edge?.id ?? "",
				edgeKind: write.edge?.kind ?? "",
				sourceId: write.edge?.sourceId ?? ""
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_update_intent",
		description: "Update an intent lifecycle after delegation or human intervention.",
		parameters: {
			intentId: { type: "string", required: true, description: "Existing intent id." },
			status: { type: "string", required: true, enum: ["planned", "running", "completed", "blocked", "failed"], description: "New lifecycle status." }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Intent ${v.id} is now ${v.status}.` }] },
		execute: async (args, exec) => store.updateIntent(sessionIdOf(exec), args.intentId, args.status)
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
		description: "Record one vulnerability finding proved by an intent (proves edge). The finding MUST include concrete, ordered reproducible steps (reproducibleSteps, min 1) — the exact commands/requests/actions that reproduce the vulnerability. Optionally link the affected asset.",
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
				description: "Severity: critical / high / medium / low / info."
			},
			impact: { type: "string", required: true, description: "危害描述：明确的实际安全/业务危害，纯指纹/信息暴露不算真实危害。" },
			affectedScope: { type: "string", required: true, description: "影响范围：受影响的用户/记录/主机/端点。" },
			remediation: { type: "string", required: true, description: "修复建议。" },
			entryPoint: { type: "string", description: "前端功能点：漏洞入口的前端页面/功能（如“找回密码页-手机号输入框”）。" },
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
				affectedScope: args.affectedScope,
				remediation: args.remediation,
				pocEvidence: args.pocEvidence,
				reproducibleSteps: args.reproducibleSteps,
				entryPoint: args.entryPoint ?? "",
				discoveryPath: args.discoveryPath ?? "",
				rawRequest: args.rawRequest ?? "",
				rawResponse: args.rawResponse ?? "",
				...args.affectedAssetId !== void 0 ? { affectedAssetId: args.affectedAssetId } : {}
			});
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
		description: "Record one asset of the engagement: root-domain, subdomain, ip, service, app, or endpoint. Optionally link it to a parent asset (parentId, e.g. a subdomain under its root domain, a service under its ip) so the asset graph reflects real ownership. parentId may be omitted or an empty string for a root asset. Record parent assets BEFORE their children and reuse the returned ids.",
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
				description: "The asset value (e.g. \"example.com\", \"10.0.0.5\", \"nginx/1.24\")."
			},
			parentId: {
				type: "string",
				description: "Optional parent asset id (parent edge, e.g. the subdomain owning this endpoint)."
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
					type: {
						type: "string",
						required: true
					},
					value: {
						type: "string",
						required: true
					},
					edgeId: { type: "string" }
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded asset ${v.id} [${v.type}] ${v.value}${v.edgeId === void 0 ? "" : ` (parent edge ${v.edgeId})`}.`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const write = await store.addAsset(sessionId, {
				type: args.type,
				value: args.value,
				...args.parentId !== void 0 ? { parentId: args.parentId } : {},
				meta: args.meta ?? "",
				source: args.source ?? "unknown",
				method: args.method ?? "passive",
				confidence: args.confidence ?? .5,
				status: args.status ?? "confirmed"
			});
			return {
				id: write.nodeId,
				type: args.type,
				value: args.value,
				...write.edge !== void 0 ? { edgeId: write.edge.id } : {}
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_state",
		description: "Read the current src state for this session: goal, node counts, and short node/asset listings. Call this to decide the next exploration step.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					initialized: {
						type: "boolean",
						required: true
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
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					facts: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					findings: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					checkpoints: { type: "array", required: true, items: { type: "object", additionalProperties: true, properties: {} } },
					assets: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					apiDiscovery: { type: "object", additionalProperties: true, properties: {} },
					coverage: { type: "array", required: true, items: { type: "object", additionalProperties: true, properties: {} } },
					research: { type: "array", required: true, items: { type: "object", additionalProperties: true, properties: {} } },
					edges: {
						type: "array",
						required: true,
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
				if (!view.initialized || view.goal === void 0) return [{
					type: "text",
					text: "Not initialized. Call src_add_goal with target and objective."
				}];
				const goal = view.goal;
				const join = (rows) => rows.join("; ") || "none";
				const api = view.apiDiscovery ?? { total: 0, schemas: 0, graphql: 0, hints: 0, untouched: 0, examples: [] };
				return [{
					type: "text",
					text: `Target: ${goal.target} | Objective: ${goal.objective} | ${view.counts.intents} intents, ${view.counts.facts} facts, ${view.counts.findings} findings, ${view.counts.assets} assets. API discovery: total=${api.total}, schemas=${api.schemas}, graphql=${api.graphql}, hints=${api.hints}, untouched=${api.untouched}${api.examples?.length ? `, examples=${api.examples.join(", ")}` : ""}. Intents: ${join(view.intents.map((i) => `${i.id}「${i.title}」`))}. Facts: ${join(view.facts.map((f) => `${f.id} [${f.kind}] ${f.detail}`))}. Findings: ${join(view.findings.map((f) => `${f.id} [${f.severity}] ${f.title}`))}. Assets: ${join(view.assets.map((a) => `${a.id} [${a.type}] ${a.value}`))}.`
				}];
			}
		},
		presentResult: (_args, result) => titledCard("SRC 漏洞挖掘状态", result),
		execute: async (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			const view = await store.view(sessionId);
			const coverage = view.coverage ?? [];
			const research = view.research ?? [];
			const apiAssets = (view.assets ?? []).filter((asset) => asset.type === "endpoint" && typeof asset.meta === "string" && asset.meta.startsWith("api:"));
			const untouched = apiAssets.filter((asset) => {
				const assetCoverage = coverage.filter((row) => row.assetId === asset.id);
				const hasProgress = assetCoverage.some((row) => ["running", "completed", "blocked", "not-applicable"].includes(row.status));
				const assetResearch = research.filter((row) => (row.evidence ?? []).some((evidence) => evidence.includes(asset.value)) || row.hypothesis.includes(asset.value));
				const hasManualResearchProgress = assetResearch.some((row) => row.status !== "hypothesis" || !(row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				return !hasProgress && !hasManualResearchProgress;
			});
			return {
				...view,
				apiDiscovery: {
					total: apiAssets.length,
					schemas: apiAssets.filter((asset) => asset.meta.startsWith("api:openapi-schema") || asset.meta.startsWith("api:schema-path")).length,
					graphql: apiAssets.filter((asset) => asset.meta.startsWith("api:graphql-endpoint")).length,
					hints: apiAssets.filter((asset) => asset.meta.startsWith("api:html-js-hint")).length,
					untouched: untouched.length,
					examples: apiAssets.slice(0, 5).map((asset) => asset.value)
				}
			};
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
		description: "Run the SRC pre-report acceptance gate. It checks intent completion, unresolved protection decisions, finding evidence, and verification coverage. It does not hide limitations and does not submit to a platform.",
		parameters: {
			allowIncomplete: { type: "boolean", description: "Set true only when the report must document explicit limitations or a human interruption." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { ready: { type: "boolean", required: true }, blockers: { type: "array", required: true }, warnings: { type: "array", required: true } } }, render: (_a, v) => [{ type: "text", text: `${v.ready ? "SRC engagement ready for report." : `SRC report blockers: ${v.blockers.join("; ")}`} ${v.warnings.length ? `Warnings: ${v.warnings.join("; ")}` : ""}` }] },
		execute: async (args, exec) => {
			const view = await store.view(sessionIdOf(exec));
			if (view.goal === void 0) throw new Error("src_finalize_engagement requires an initialized SRC goal");
			const blockers = [];
			const warnings = [];
			const unfinished = view.intents.filter((intent) => !["completed", "blocked"].includes(intent.status));
			if (unfinished.length) blockers.push(`未完成 intent: ${unfinished.map((intent) => `${intent.id}/${intent.title}`).join(", ")}`);
			const plannedStale = view.intents.filter((intent) => intent.status === "planned" && !(view.checkpoints ?? []).some((c) => c.intentId === intent.id));
			if (plannedStale.length) warnings.push(`以下 intent 从未委派执行（长期停在 planned，需显式委派或转 cancelled）: ${plannedStale.map((intent) => `${intent.id}/${intent.title}`).join(", ")}`);
			const failed = view.intents.filter((intent) => intent.status === "failed");
			if (failed.length) blockers.push(`失败 intent 未处理: ${failed.map((intent) => intent.id).join(", ")}`);
			if (view.goal.authorization === "" && !view.findings.some((f) => f.severity === "critical" || f.severity === "high")) warnings.push("未记录授权说明（SRC 平台注册默认已授权，可忽略）");
			if (view.findings.length === 0) warnings.push("没有确认的 finding，报告将主要记录侦察结果和限制");
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
			if (untouchedEndpoints.length) warnings.push(`发现 ${untouchedEndpoints.length} 个 API/接口资产尚未进入研究或覆盖推进: ${untouchedEndpoints.slice(0, 5).map((asset) => asset.value).join(", ")}`);
			if (autoOnlyEndpoints.length) warnings.push(`发现 ${autoOnlyEndpoints.length} 个 API/接口资产仍停留在自动生成骨架，尚无人工推进: ${autoOnlyEndpoints.slice(0, 5).map((asset) => asset.value).join(", ")}`);
			const openResearch = research.filter((row) => ["hypothesis", "testing"].includes(row.status));
			if (openResearch.length) blockers.push(`存在 ${openResearch.length} 个未完成漏洞研究假设`);
			const unverifiedFindings = view.findings.filter((finding) => !research.some((row) => row.status === "verified" && row.findingId === finding.id));
			if (unverifiedFindings.length) blockers.push(`finding 缺少独立 verified 研究记录: ${unverifiedFindings.map((finding) => finding.id).join(", ")}`);
			const realHarmFindings = view.findings.filter((f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium");
			if (view.findings.length > 0 && realHarmFindings.length === 0) blockers.push("仅存在 info/low 级 finding（信息泄露/指纹类），不构成 SRC 所需的真实危害漏洞；须继续推进可复现的验证类漏洞（越权/注入/上传/逻辑/SSRF 等），或显式传 allowIncomplete=true 记录限制后停止");
			const missingRaw = view.findings.filter((finding) => (finding.rawRequest ?? "").trim() === "");
			if (missingRaw.length) blockers.push(`finding 缺少 Burp 格式 rawRequest（数据包必填）: ${missingRaw.map((finding) => finding.id).join(", ")}`);
			const checkpoints = view.checkpoints ?? [];
			if (checkpoints.some((checkpoint) => checkpoint.stage === "failed")) blockers.push("存在失败的 child checkpoint");
			for (const finding of view.findings) {
				const hasCheckpoint = checkpoints.some((c) => c.intentId === finding.intentId);
				if (!hasCheckpoint) warnings.push(`finding ${finding.id} 所在 intent ${finding.intentId} 无子 agent checkpoint，疑为主 agent 自干验证，证据链不完整`);
			}
			const ready = blockers.length === 0 || args.allowIncomplete === true;
			return { ready, blockers, warnings };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_report",
		description: "Generate the final Markdown report for this session: goal, the exploration chain (goal → intents → facts → derived intents → findings), every vulnerability with its reproducible steps, and the asset graph. Call this when the engagement is done.",
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
			return { markdown: buildReport(await store.view(sessionId)) };
		}
	}));
}
//#endregion
//#region src/index.ts
/** Plugin identity. */
const name = "src";
/** Services required before the plugin can register tools and open the domain. */
const inject = [
	"tools",
	"storageDomain",
	"sessions",
	"subagents"
];
/**
* Activate the penetration mode on a context carrying the tool registry and the
* storage-domain facility. The domain is opened lazily on first tool use and
* closed when the plugin fiber is disposed.
* @param ctx - registrant context.
*/
function apply(ctx) {
	const store = new SrcStore(ctx);
	ctx.effect(() => async () => {
		await store.dispose();
	}, "src.domainClose");
	registerSrcTools(ctx, store);
	ctx.inject(["sessionProjections"], (projectionCtx) => {
		projectionCtx.sessionProjections.register({
			key: "src",
			schema: srcProjectionSchema,
			init: () => srcInitialState,
			apply: applySrcEvent,
			view: viewSrcState,
			stateVersion: 4
		});
	});
	ctx.inject(["systemPrompt"], (scope) => {
		scope.systemPrompt.section({
			name: "src:protocol",
			order: 50,
			text: () => SRC_INSTRUCTIONS
		});
	});
}
//#endregion
export { apply, inject, name, srcAssetSchema, srcAssetTypeSchema, srcDomainSpec, srcEdgeKindSchema, srcEdgeSchema, srcFactKindSchema, srcFactSchema, srcFindingSchema, srcGoalSchema, srcIntentSchema, srcSeveritySchema };
