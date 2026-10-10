// bash/curl 原工具写操作防护（2026-10-09 plan §7.3 提前项）。
// 背景：CVE 会话实证 219 次 bash 全程绕过 src_http 治理（PUT/DELETE/POST 零审批、无限速、无快照），
// Jev HTTP 决策 0 条；目标管理端若真被 curl -X DELETE/DROP 命中即是"删库"级风险。
// 职责：静态分析 bash 命令文本，识别 (a) 对 scope 目标主机的写动词 HTTP、 (b) 本机破坏性命令，(c) 大流量扫描器。
// 默认生产 DSH_SRC_BASH_GATE=ask：经宿主 tools/pre-execute 返回 {kind:'ask'}，审批 allowed-once 才执行；
// shadow 仅遥测/记会话事件不拦，off 完全关闭。
// 诚实边界：静态 shell 解析可被变量拼接/base64/脚本绕过，定位是"防误操作+给审计"，不是对抗性沙箱。
// 所有 poc 一律独立于工具路径，只用惰性 flags；任何异常回落 allow（不能因守卫 bug 卡住合法命令）。

const WRITE_METHODS = new Set(["PUT", "POST", "DELETE", "PATCH"]);
const HTTP_TOOLS = ["curl", "wget", "http", "https", "aria2c"];

/** 提取命令片段中"疑似 HTTP 写动词请求"（curl/… 带显式 -X 方法 / --request / -F 表单 / -T 上传）。
 *  返回命中描述数组；只匹配显式写动词，GET/HEAD/OPTIONS 不拦。 */
export function findHttpWriteOps(command, scopeHosts = []) {
	const hits = [];
	const tok = String(command ?? "");
	const scopeRe = scopeHosts.length > 0 ? new RegExp(`(?:https?:)?//(?:[^/@\\s]@)?([^/\\s:]+)`, "g") : null;
	let hasScopeUrl = false;
	if (scopeRe) {
		for (const m of tok.matchAll(scopeRe)) {
			const h = m[1].toLowerCase().replace(/\.$/, "");
			if (scopeHosts.some((s) => h === String(s).toLowerCase() || h.endsWith("." + String(s).toLowerCase()))) { hasScopeUrl = true; break; }
		}
	}
	if (/\bcurl\b/.test(tok)) {
		for (const m of tok.matchAll(/(?:-X|--request)\s+([A-Z]+)/gi)) {
			if (WRITE_METHODS.has(m[1].toUpperCase())) hits.push({ kind: "http-write", method: m[1].toUpperCase(), scope: hasScopeUrl, cmd: "curl" });
		}
		// curl -d/--data 默认把 GET 改成 POST；不能只识别显式 -X POST。
		if (/(^|\s)(-d|--data|--data-raw|--data-binary|--data-urlencode)(\s|=)/.test(tok)) hits.push({ kind: "http-write", method: "POST", scope: hasScopeUrl, cmd: "curl", implicit: true });
		if (/(^|\s)(-T|--upload-file|\-F|--form)(\s|=)/.test(tok)) hits.push({ kind: "http-write", method: "PUT/UPLOAD", scope: hasScopeUrl, cmd: "curl" });
	}
	for (const m of tok.matchAll(/\b(?:wget|http|https)\b[^;&\n]*?(?:--method|post|put|delete|patch)/gi)) {
		hits.push({ kind: "http-write", method: "HTTP", scope: hasScopeUrl, cmd: m[0].split(/\s/)[0] });
	}
	return { hits, hasScopeUrl };
}

/** 本机破坏性/危险命令：范围外删除、drop/truncate 库、dd/mkfs、关机重启、kube 删除等。 */
const DANGEROUS_LOCAL = [
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(\/|\/\*|~\s*\/?\*|\$HOME\s*\/?\*)/,
	/\b(?:drop|truncate)\s+table\b/i,
	/\b(?:DROP|TRUNCATE)\s+DATABASE\b/i,
	/--drop-database|\bdropdb\b/i,
	/\bdd\s+if=.*of=\/dev\/(?:sda|sdb|sdc|nvme|disk)/,
	/\bmkfs\b/i,
	/\bshutdown\b|\breboot\b|\bpoweroff\b/i,
	/\bkubectl\s+delete\s+namespace\b|\bhelm\s+delete\b/i,
	/\bgit\s+push\s+.*--force\b/i,
	/psql\s+.*(?:-c|-f).*(?:drop|truncate)/i,
	/mysql\s+.*(?:-e|-execute).*(?:drop|truncate)/i,
	/\bservice\s+\w+\s+(stop|restart)\b|\bsystemctl\s+(stop|restart)\b/i
];
export function findDangerousLocal(command) {
	const tok = String(command ?? "");
	return DANGEROUS_LOCAL.map((re, i) => (re.test(tok) ? { kind: "local-dangerous", index: i } : null)).filter(Boolean);
}

/** 大流量扫描器（高并发 fuzz/端口/注入工具，可能超出 rate limit 对靶场/真实目标产生冲击）。 */
const SCANNERS = [/\bffuf\b/, /\bnuclei\b/, /\bsqlmap\b/, /\bhydra\b/, /\bwfuzz\b/, /\bdirsearch\b/, /\bgobuster\b/, /\bmasscan\b/];
export function findScanners(command) {
	const tok = String(command ?? "");
	const out = [];
	for (const re of SCANNERS) { const m = re.exec(tok); if (m) out.push({ kind: "scanner", tool: m[0] }); }
	return out;
}

/** 汇总判定。mode: shadow(默认，只 telemetry/mark) | ask。 */
export function classifyBashCommand(command, { scopeHosts = [], mode = "shadow" } = {}) {
	const write = findHttpWriteOps(command, scopeHosts);
	const local = findDangerousLocal(command);
	const scan = findScanners(command);
	const signals = [...write.hits, ...local, ...scan];
	if (signals.length === 0) return { verdict: "allow", signals: [] };
	const needsAsk = mode === "ask" && signals.length > 0;
	return { verdict: needsAsk ? "ask" : "shadow", signals, scopeTarget: write.hasScopeUrl };
}

/** 生成 user 可读的自然语言原因（做某事/可能后果/恢复）。 */
export function explainBashGate(signals) {
	const parts = signals.map((s) => {
		if (s.kind === "http-write") return `对目标发起 ${s.method} 写请求（可能修改或删除目标数据，恢复不保证；批准才按原文执行一次，发送前中断可恢复）`;
		if (s.kind === "local-dangerous") return `检测到本机破坏性命令（删除/删库/格式化/关机，不可逆）`;
		if (s.kind === "scanner") return `高并发扫描器 ${s.tool}（可能超出速率限制冲击目标）`;
		return s.kind;
	});
	return "bash 命令包含需要人工确认的操作：" + [...new Set(parts)].join("；") + "。仅作审批边界提示，不是安全保证。";
}