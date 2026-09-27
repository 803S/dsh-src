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
function findingReportWarnings(finding) {
	const text = [finding.title, finding.description, finding.impact, finding.attackPrerequisites, finding.rawRequest, finding.rawResponse, ...(finding.pocEvidence ?? [])].join(" ");
	const hasSession = /(cookie|authorization|bearer|登录|会话|token|credential|认证)/i.test(text);
	const anonymousClaim = /(匿名|未授权|无需登录|unauthenticated|anonymous)/i.test(text);
	const warnings = [];
	if (hasSession && anonymousClaim) warnings.push("⚠ 报告口径警告：证据包含会话/认证材料，不得标注为「匿名未授权」；请改写为对应的登录态越权、认证后可达或凭证暴露口径，并说明测试账号边界。");
	const credentialFinding = /(凭证|密钥|secret|token|jwt|authorization|credential|认证)/i.test(`${finding.title} ${finding.vulnType ?? ""} ${finding.description}`);
	const hasFalseBaseline = /(假值|错误凭证|无效凭证|invalid|baseline|对照|不带认证|无认证|匿名对照)/i.test(text);
	const hasIdentityProof = /(身份|列表|账户|用户信息|me\b|权限|角色|他人|主体)/i.test(text);
	if (credentialFinding && (!hasFalseBaseline || !hasIdentityProof)) warnings.push("⚠ 认钥闸：凭证类 finding 尚缺「假值/无认证对照」或「认钥后身份/列表」证明；请补齐两组差分后再向厂商提交（当前仅作显著警告，不阻塞报告生成）。");
	return warnings;
}

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
		const reportWarnings = findingReportWarnings(finding);
		if (reportWarnings.length > 0) lines.push("【提交前校验警告】", ...reportWarnings, "");
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
/** Build the final report for one session (pure projection).
 * [local.82] 报告=交付物：只保留 漏洞发现（每条自带完整证据链）+ 测试范围与限制。
 * 内部过程数据（探索链路/资产墙/coverage 矩阵/研究矩阵/检查点/待办）撤出报告——
 * UI 各 tab（时间线/资产/todos）与 src_state/src_graph 才是它们的家。 */
export function buildReport(state) {
	if (state.goal === void 0) return [
		"# SRC 漏洞挖掘报告",
		"",
		"（未初始化：尚未调用 src_add_goal。）"
	].join("\n");
	const goal = state.goal;
	const activeFindings = state.findings.filter((finding) => (finding.status ?? "active") === "active");
	const findingSections = activeFindings.map((finding) => formatFindingReport(finding, state, goal));
	/* 范围与限制：blindSpots 声明（全部维度，覆盖/未覆盖/不适用各有诚实边界价值）∪ coverage 行的限制说明 ∪ 跳过接口计数。 */
	const limitationLines = [
		...(state.coverage ?? []).filter((row) => row.phase === "blind-spot").map((row) => {
			const statusLabel = row.status === "completed" ? "已覆盖" : row.status === "blocked" ? "未覆盖" : row.status === "not-applicable" ? "不适用" : row.status;
			return `- ${row.category}: ${statusLabel}${(row.limitation ?? "") !== "" ? ` — ${row.limitation}` : ""}`;
		}),
		...(state.coverage ?? []).filter((row) => row.phase !== "blind-spot" && (row.limitation ?? "") !== "").map((row) => `- ${row.phase}/${row.category}: ${row.limitation}`),
		...(() => {
			const skipped = (state.coverage ?? []).reduce((sum, row) => sum + ((row.endpointsSkipped ?? []).length), 0);
			return skipped > 0 ? [`- 接口对账：跳过 ${skipped} 个接口未测（明细见会话对账数据，不得声明穷尽）`] : [];
		})()
	];
	return [
		"# SRC 漏洞挖掘报告",
		"",
		`- 目标 (target): ${goal.target}`,
		`- 目的 (objective): ${goal.objective}`,
		`- 授权 (authorization): ${goal.authorization === "" ? "（未声明）" : goal.authorization}`,
		"",
		"## 漏洞发现",
		...findingSections.length === 0 ? ["（无）"] : findingSections,
		"",
		"## 测试范围与限制",
		...limitationLines.length === 0 ? ["（无）"] : limitationLines
	].join("\n");
}
