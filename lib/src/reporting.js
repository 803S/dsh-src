// Pure graph and report projections. No storage, network, or tool registration.

/** Build the exploration-chain dump for one session (pure projection). */
export function buildGraph(state) {
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
/** [local.27] Render one finding as the standardized submission template:
 * 漏洞/情报名称/类型/URL + 4 大节（描述&危害 / 复现证明 / 测试源信息 / 修复方案）。 */
function formatFindingReport(finding, state, goal) {
	const asset = finding.affectedAssetId === void 0 ? void 0 : state.assets.find((a) => a.id === finding.affectedAssetId);
	/* 收集本 finding 涉及的所有 URL，去重，; 分隔。 */
	const urls = (() => {
		const found = new Set();
		const haystack = (finding.pocEvidence ?? []).join("\n") + "\n" + (finding.reproducibleSteps ?? []).join("\n") + "\n" + (finding.rawRequest ?? "") + "\n" + (finding.rawResponse ?? "");
		for (const m of haystack.matchAll(/https?:\/\/[^\s'")\]]+/g)) found.add(m[0]);
		const list = [...found];
		if (list.length === 0) list.push(asset === void 0 ? goal.target : asset.value);
		return list.join("; ");
	})();
	/* 漏洞级别：严重度直接作为级别（报告「漏洞级别」行）。 */
	const severityLabel = finding.severity;
	/* 第 1 节：漏洞描述&发现方式、漏洞利用及危害——动态填充，空字段不显示、不占位。
	/* 第 1 节：漏洞描述&发现方式、漏洞利用及危害。结构：一句话描述 → 【攻击链】垂直从上到下（动态、空步骤不占位）→
	   前端定位信息（前端功能点/应用下载/影响范围，复现必需）。 */
	const section1 = (() => {
		const lines = [];
		/* 一句话描述（简洁）。 */
		if (finding.description !== "") lines.push(finding.description, "");
		/* 攻击链：垂直从上到下。attackChain 字段非空时原样呈现（agent 写好的多行叙事）；否则从结构化字段构建①到⑤，仅非空步骤、不占位。 */
		const chainLines = [];
		const chainField = (finding.attackChain ?? "").trim();
		if (chainField !== "") chainLines.push(chainField);
		else {
			if (finding.discoveryPath !== "") chainLines.push(`① 发现：${finding.discoveryPath}`);
			if ((finding.attackPrerequisites ?? "") !== "") chainLines.push(`② 利用前提：${finding.attackPrerequisites}`);
			if ((finding.impact ?? "") !== "") chainLines.push(`③ 利用过程：${finding.impact}`);
			if ((finding.concreteLossEvidence ?? []).length > 0) chainLines.push(`④ 实际损失：${finding.concreteLossEvidence.join("; ")}`);
			if ((finding.victimImpact ?? "") !== "") chainLines.push(`⑤ 受害者影响：${finding.victimImpact}`);
		}
		if (chainLines.length > 0) lines.push("【攻击链】", ...chainLines, "");
		/* 前端定位信息：复现必需。web 漏洞填前端功能点；app 漏洞要有应用下载；需登录的在②利用前提已注明登录入口。 */
		if (finding.entryPoint !== "") lines.push(`前端功能点：${finding.entryPoint}`);
		if (asset !== void 0 && (asset.type === "app" || asset.type === "mini-program")) {
			const meta = String(asset.meta ?? "");
			const dl = meta.match(/(https?:\/\/[^\s'"]+)/);
			const download = dl !== null ? dl[0] : (asset.value.startsWith("http") ? asset.value : (meta !== "" ? meta : asset.value));
			lines.push(`应用下载：${download}`);
		}
		if (finding.affectedScope !== "") lines.push(`影响范围：${finding.affectedScope}`);
		return lines.join("\n").replace(/\n+$/, "");
	})();
	/* 第 2 节：详细复现/证明过程——请求/响应/脚本走代码框，步骤清晰呈现。 */
	const section2 = (() => {
		const lines = [];
		if ((finding.reproducibleSteps ?? []).length > 0) {
			finding.reproducibleSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
			lines.push("");
		}
		if ((finding.rawRequest ?? "") !== "") lines.push("=== Request ===", "```", finding.rawRequest, "```");
		if ((finding.rawResponse ?? "") !== "") { if (lines.length > 0) lines.push(""); lines.push("=== Response ===", "```", finding.rawResponse, "```"); }
		if ((finding.rawRequest ?? "") === "" && (finding.rawResponse ?? "") === "" && finding.pocEvidence.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push("POC 证据：");
			finding.pocEvidence.forEach((evidence, index) => lines.push(`${index + 1}. ${evidence}`));
		}
		/* [local.27] 一键 PoC 脚本：独立代码块，保留缩进与换行。 */
		if ((finding.pocScript ?? "").trim() !== "") {
			if (lines.length > 0) lines.push("");
			lines.push("一键利用脚本：", "```", finding.pocScript, "```");
		}
		return lines.length === 0 ? "（请补充复现步骤、原始报文或 PoC 脚本）" : lines.join("\n");
	})();
	/* 第 3 节：测试源信息——从 concreteLossEvidence 指针解析账号/订单/IP/证据 + 影响资产，有什么给什么。 */
	const section3 = (() => {
		const lines = [];
		for (const evidenceId of (finding.concreteLossEvidence ?? [])) {
			const fact = state.facts.find((f) => f.id === evidenceId);
			if (fact !== void 0) { lines.push(`- ${fact.target === "" ? "" : fact.target + ": "}${fact.detail}`); continue; }
			const research = (state.research ?? []).find((r) => r.id === evidenceId);
			if (research !== void 0) { lines.push(`- [${research.category}] ${research.hypothesis}${(research.evidence ?? []).length > 0 ? "；证据: " + research.evidence.join("; ") : ""}`); continue; }
			lines.push(`- ${evidenceId}（见对话原始报文 / timeline）`);
		}
		if (asset !== void 0) lines.push(`- 影响资产: [${asset.type}] ${asset.value}${String(asset.meta ?? "") === "" ? "" : "（" + String(asset.meta) + "）"}`);
		return lines.length === 0 ? "（无）" : lines.join("\n");
	})();
	const vulnType = (finding.vulnType ?? "") === "" ? "未分类" : finding.vulnType;
	/* [local.29] 美团 SRC 骨架模板：4 字段 + 漏洞风险详情 4 小节，内容动态填充，空字段不占位。 */
	return [
		`### ${finding.id} ${finding.title}`,
		"",
		`**漏洞名称**：${finding.title}`,
		`**漏洞类型**：${vulnType}`,
		`**漏洞URL**：${urls}`,
		`**漏洞级别**：${severityLabel}`,
		"",
		"**漏洞风险详情**",
		"",
		"**漏洞描述&发现方式、漏洞利用及危害**",
		"",
		section1,
		"",
		"**漏洞的详细复现/证明过程**",
		"",
		section2,
		"",
		"**测试源信息**",
		"",
		section3,
		"",
		"**修复方案**",
		"",
		finding.remediation === "" ? "（请提供有针对性的具体修复方案）" : finding.remediation,
		""
	].join("\n");
}
/** Build the final report for one session (pure projection). */
export function buildReport(state) {
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
	const activeFindings = state.findings.filter((finding) => (finding.status ?? "active") === "active");
	const rejectedFindings = state.findings.filter((finding) => (finding.status ?? "active") === "rejected");
	const chainLines = [
		`- 目标 (goal ${goal.id})「${goal.target}」— 目的: ${goal.objective}`,
		...state.intents.map((intent) => `- 意图 (intent ${intent.id})「${intent.title}」(${anchorOf(intent.id)})${intent.detail === "" ? "" : ` — ${intent.detail}`}`),
		...(() => {
			/* [local.67 #12] 探索链路节输出预算：事实全量渲染在 97-fact 图实证爆窗（compaction×6）。
			 * 只列最近 24 条与 P≥8 意图下的事实；其余给计数与 src_graph 指引。 */
			const FACT_RENDER_LIMIT = 24;
			const factIntentPriority = new Map((state.intents ?? []).map((intent) => [intent.id, intent.priority ?? 5]));
			const allFacts = state.facts ?? [];
			const kept = allFacts.filter((fact, index) => index >= allFacts.length - FACT_RENDER_LIMIT || (factIntentPriority.get(fact.intentId) ?? 5) >= 8);
			const omitted = allFacts.length - kept.length;
			return [...kept.map((fact) => `- 事实 (fact ${fact.id}) [${fact.kind}] ${fact.target === "" ? "" : `${fact.target}: `}${fact.detail} (${anchorOf(fact.id)})`), ...(omitted > 0 ? [`- …（事实共 ${allFacts.length} 条，探索链路仅列最近 ${FACT_RENDER_LIMIT} 条与 P≥8 意图下的事实，其余 ${omitted} 条用 src_graph 查全量）`] : [])];
		})(),
		...activeFindings.map((finding) => `- 漏洞 (finding ${finding.id}) [${finding.severity}] ${finding.title} (${anchorOf(finding.id)})`),
		...rejectedFindings.map((finding) => `- ⚠已打回 (finding ${finding.id}) [${finding.severity}] ${finding.title}——${(finding.rejectReason ?? "").slice(0, 40)}`)
	];
	const findingSections = activeFindings.map((finding) => formatFindingReport(finding, state, goal));
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
		"## 已打回（保留备查 / 防二次提交）",
		...rejectedFindings.length === 0 ? ["（无）"] : rejectedFindings.map((finding) => `- ${finding.id} [${finding.severity}] ${finding.title}——打回备注：${finding.rejectReason ?? "（未填）"}${finding.rejectedAt ? `（${new Date(finding.rejectedAt).toISOString()}）` : ""}`),
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
		...(state.assets ?? []).filter((asset) => asset.type === "ai-surface" || asset.type === "threat-intel").length === 0 ? ["（无）"] : (state.assets ?? []).filter((asset) => asset.type === "ai-surface" || asset.type === "threat-intel").map((asset) => `- [${asset.type}] ${asset.value}（${asset.meta}）— 按 lessons/ai-abuse 套路已测部分见漏洞发现；未测完/需登录态的部分见下方「等你的事」`),
		"",
		"## 覆盖维度声明",
		...(() => {
			const blindSpotRows = (state.coverage ?? []).filter((row) => row.phase === "blind-spot");
			if (blindSpotRows.length === 0) return ["（无——本次未声明覆盖维度，盲区不可见）"];
			const statusLabel = (s) => s === "completed" ? "已覆盖" : s === "blocked" ? "未覆盖" : s === "not-applicable" ? "不适用" : s;
			return blindSpotRows.map((row) => `- ${row.category}: ${statusLabel(row.status)}${(row.limitation ?? "") !== "" ? ` — ${row.limitation}` : ""}${(row.evidence ?? []).length > 0 ? `（证据 ${row.evidence.join(",")})` : ""}`);
		})(),
		"",
		"## ⏸ 等你的事",
		...(() => {
			const pendingTodos = (state.userTodos ?? []).filter((todo) => todo.status === "pending");
			const lines = pendingTodos.map((todo) => `- [${todo.kind}] ${todo.title}${todo.detail === "" ? "" : ` — ${todo.detail}`}`);
			const hangIntents = (state.intents ?? []).filter((intent) => intent.status === "blocked");
			for (const intent of hangIntents) {
				if (pendingTodos.some((todo) => todo.intentId === intent.id)) continue;
				lines.push(`- ${intent.id}/${intent.title} — 已挂起${intent.detail === "" ? "" : `（${intent.detail}）`}: 需要你提供输入或决策后才能继续`);
			}
			return lines.length === 0 ? ["（无——本次任务已完整收敛，无需你操作）"] : [...lines, "", "完成任一项后面板点「已完成」或直接告诉 agent，会话会继续推进对应工作。"];
		})(),
		"",
	].join("\n");
}
