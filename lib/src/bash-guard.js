// bash/curl 原工具候选信号。它不直接授予网络/文件权限；最终执行仍由宿主出口和
// egress broker 决定。Jev 只消费完整上下文并给影响分类，不能替代范围/预算/原文校验。
const WRITE_METHODS = new Set(["PUT", "POST", "DELETE", "PATCH"]);

export function findHttpWriteOps(command, scopeHosts = []) {
	const hits = [];
	const tok = String(command ?? "");
	const scopeRe = scopeHosts.length > 0 ? new RegExp(`(?:https?:)?//(?:[^/@\\s]@)?([^/\\s:]+)`, "g") : null;
	let hasScopeUrl = false;
	if (scopeRe) for (const m of tok.matchAll(scopeRe)) {
		const h = m[1].toLowerCase().replace(/\.$/, "");
		if (scopeHosts.some((s) => h === String(s).toLowerCase() || h.endsWith("." + String(s).toLowerCase()))) { hasScopeUrl = true; break; }
	}
	if (/\bcurl\b/.test(tok)) {
		for (const m of tok.matchAll(/(?:-X|--request)\s+([A-Z]+)/gi)) if (WRITE_METHODS.has(m[1].toUpperCase())) hits.push({ kind: "http-write", method: m[1].toUpperCase(), scope: hasScopeUrl, cmd: "curl" });
		if (/(^|\s)(-d|--data|--data-raw|--data-binary|--data-urlencode)(\s|=)/.test(tok)) hits.push({ kind: "http-write", method: "POST", scope: hasScopeUrl, cmd: "curl", implicit: true });
		if (/(^|\s)(-T|--upload-file|\-F|--form)(\s|=)/.test(tok)) hits.push({ kind: "http-write", method: "PUT/UPLOAD", scope: hasScopeUrl, cmd: "curl" });
	}
	for (const m of tok.matchAll(/\b(?:wget|http|https)\b[^;&\n]*?(?:--method|post|put|delete|patch)/gi)) hits.push({ kind: "http-write", method: "HTTP", scope: hasScopeUrl, cmd: m[0].split(/\s/)[0] });
	return { hits, hasScopeUrl };
}
const DANGEROUS_LOCAL = [
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(\/|\/\*|~\s*\/?\*|\$HOME\s*\/?\*)/, /\b(?:drop|truncate)\s+table\b/i,
	/\b(?:DROP|TRUNCATE)\s+DATABASE\b/i, /--drop-database|\bdropdb\b/i, /\bdd\s+if=.*of=\/dev\/(?:sda|sdb|sdc|nvme|disk)/,
	/\bmkfs\b/i, /\bshutdown\b|\breboot\b|\bpoweroff\b/i, /\bkubectl\s+delete\s+namespace\b|\bhelm\s+delete\b/i,
	/\bgit\s+push\s+.*--force\b/i, /psql\s+.*(?:-c|-f).*(?:drop|truncate)/i, /mysql\s+.*(?:-e|-execute).*(?:drop|truncate)/i,
	/\bservice\s+\w+\s+(stop|restart)\b|\bsystemctl\s+(stop|restart)\b/i
];
export function findDangerousLocal(command) { const tok=String(command??"");return DANGEROUS_LOCAL.map((re,i)=>re.test(tok)?{kind:"local-dangerous",index:i}:null).filter(Boolean); }
const SCANNERS = [/\bffuf\b/, /\bnuclei\b/, /\bsqlmap\b/, /\bhydra\b/, /\bwfuzz\b/, /\bdirsearch\b/, /\bgobuster\b/, /\bmasscan\b/];
export function findScanners(command) { const tok=String(command??"");return SCANNERS.flatMap(re=>{const m=re.exec(tok);return m?[{kind:"scanner",tool:m[0]}]:[]}); }
export function classifyBashCommand(command,{scopeHosts=[],mode="shadow"}={}) {
	const write=findHttpWriteOps(command,scopeHosts),local=findDangerousLocal(command),scan=findScanners(command),signals=[...write.hits,...local,...scan];
	if(!signals.length)return {verdict:"allow",signals:[],scopeTarget:false};
	return {verdict:mode==="ask"?"ask":"shadow",signals,scopeTarget:write.hasScopeUrl};
}
/* [jev-approval-simplification §1.1/审计P0-3] pre-execute 不再组 Jev 决策输入，也不再问 Jev：
 * bash 网络动作的决策只在出口边界（proxy claim → authorize → propose → broker.assess）用
 * 完整冻结请求进行；本机破坏性命令走确定性 ask。原 bashDecisionInput/bashJevNeedsHuman
 * 已随调用点移除，避免残留“预处理即授权”的旧语义。 */
export function explainBashGate(signals,reason='') {
	const parts=signals.map(s=>s.kind==='http-write'?`对目标发起 ${s.method} 写请求（可能修改或删除目标数据，恢复不保证）`:s.kind==='local-dangerous'?`检测到本机破坏性命令（删除/删库/格式化/关机，不可逆）`:s.kind==='scanner'?`扫描器 ${s.tool} 可能产生较大请求量`:s.kind);
	return `bash 命令需要人工确认：${[...new Set(parts)].join('；')}。${reason?`${reason}。`:''}批准只针对明确原命令一次，不扩大范围、次数或权限。`;
}
