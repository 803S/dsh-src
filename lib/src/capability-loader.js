/**
 * [local.76 Phase 6] Capability loader + infra defaults, extracted from lib/src.js.
 * Pure/pure-ish units: YAML subset parsing, capability manifest reads, whitelist
 * script launch commands, bounded child processes, and infra default maps.
 * @module @deepseek-ai/dsh-src/src/capability-loader
 */
import { promises as fsPromises } from "node:fs";
import { spawn as childProcessSpawn } from "node:child_process";
import * as nodePath from "node:path";
import * as nodeOs from "node:os";

/**
 * [local.9] Infrastructure setting defaults. Users override per session via
 * src_set_infra; the resolved map is exposed to the UI through the projection.
 */
/** [capability] 轻量解析 ~/.dsh/capabilities.yaml（与 scripts/caps-sync.mjs 同一受限子集：条目键值/内联 map/when 折叠块）。只读展示用，不做写盘。 */
export function parseCapsYamlSubset(text) {
	const out = [];
	let cur = null;
	let curKey = null;
	let sawHeader = false;
	let sawContent = false;
	for (const raw of String(text).split(/\r?\n/)) {
		const line = raw.replace(/\t/g, "    ");
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		sawContent = true;
		if (/^capabilities:\s*$/.test(line)) { sawHeader = true; cur = null; continue; }
		if (/^settings:\s*$/.test(line)) { continue; }
		const item = line.match(/^  - (.+)$/);
		if (item) {
			const kv = item[1].match(/^([A-Za-z_][\w]*):\s*(.*)$/);
			if (!kv) throw new Error("capabilities 条目首行应为 '- id: xxx'");
			cur = { [kv[1]]: kv[2].trim() };
			out.push(cur); curKey = null;
			continue;
		}
		if (!cur) continue;
		const nested = line.match(/^    ([A-Za-z_][\w]*):\s*(.*)$/);
		if (nested) {
			const [, k, v] = nested;
			if (v === ">" || v === "|" || v === "") { curKey = k; cur[k] = ""; }
			else if (v === "true" || v === "false") cur[k] = v === "true";
			else if (v.startsWith("[")) { cur[k] = parseInlineYamlArray(v); curKey = null; }
			else cur[k] = v.trim();
			continue;
		}
		const cont = line.match(/^      (.+)$/);
		if (cont && curKey) { cur[curKey] = `${cur[curKey]} ${cont[1].trim()}`.trim(); }
	}
	if (sawContent && !sawHeader) throw new Error("文件应以 capabilities: 开头");
	return out;
}

/* [local.65] 已拆除 local.63 的覆盖面清单机制（coverage.yaml → goal 创建机械挂待办）：
 * 枚举是 agent 本职，开局把枚举外包给用户是死编排；缺口提示由 src_state.assetGaps 软引导。 */

/* [local.41] capabilities.yaml 内联数组（scripts: [a.sh, b.py]）与标量剥离。 */
export function stripYamlScalar(s) { return (/^".*"$/.test(s) || /^'.*'$/.test(s)) ? s.slice(1, -1) : s; }
export function parseInlineYamlArray(v) {
	const m = v.trim().match(/^\[(.*)\]$/);
	if (m === null) return v.trim();
	return m[1].split(",").map((s) => stripYamlScalar(s.trim())).filter((s) => s !== "");
}
/* [local.41] 外部能力清单读取：优先 caps-sync 产出的 ~/.dsh/capabilities/index.json（含
 * kind/dir/docs/scripts/安装状态），缺失时回退 capabilities.yaml 直接解析（此时只有声明信息，
 * kind 一律视为 mcp、无安装目录）。 */
export function dshHomeOf() { return process.env.DSH_HOME ? nodePath.resolve(process.env.DSH_HOME) : nodePath.join(nodeOs.homedir(), ".dsh"); }
export async function readCapsManifest(dshHome) {
	const indexPath = nodePath.join(dshHome, "capabilities", "index.json");
	try {
		const parsed = JSON.parse(await fsPromises.readFile(indexPath, "utf8"));
		if (Array.isArray(parsed?.capabilities)) return { source: "index", items: parsed.capabilities };
	} catch {}
	try {
		const declared = parseCapsYamlSubset(await fsPromises.readFile(nodePath.join(dshHome, "capabilities.yaml"), "utf8"));
		/* [local.57] 回退路径尊重声明的 kind——skill 型条目此前被硬写成 mcp（开局能力盘点失真）。 */
		/* [local.62] 回退路径携带触发器声明（index.json 缺失时从 yaml 直读，数据编排在降级路径也不失效）。 */
		return { source: "yaml", items: declared.map((c) => ({ id: c.id, kind: c.kind === "skill" ? "skill" : "mcp", from: c.from, enabled: c.enabled !== false, when: typeof c.when === "string" ? c.when : "", ...(Array.isArray(c.triggerAssetTypes) ? { triggerAssetTypes: c.triggerAssetTypes } : {}), ...(Array.isArray(c.triggerKeywords) ? { triggerKeywords: c.triggerKeywords } : {}), ...(typeof c.todoTitle === "string" && c.todoTitle !== "" ? { todoTitle: c.todoTitle, ...(typeof c.todoKind === "string" && c.todoKind !== "" ? { todoKind: c.todoKind } : {}), ...(typeof c.todoDetail === "string" && c.todoDetail !== "" ? { todoDetail: c.todoDetail } : {}) } : {}), status: "unknown" })) };
	} catch (e) {
		/* [local.41] 保留旧语义：清单未创建 vs 解析失败，给 src_list_capabilities 的 parseError。 */
		if (e?.code === "ENOENT") return { source: "none", items: [], parseError: "清单未创建" };
		return { source: "none", items: [], parseError: `清单解析失败：${String(e?.message ?? e).slice(0, 200)}` };
	}
}
export async function capsWiredIds(dshHome) {
	const out = new Set();
	try {
		const patchPath = nodePath.join(dshHome, "profiles", "web", "cordis.patch.yml");
		const patch = await fsPromises.readFile(patchPath, "utf8");
		const seg = patch.match(/── dsh-src capabilities:8<[\s\S]*?capabilities:>8 [^─]*──/);
		for (const m of (seg?.[0] ?? "").matchAll(/id: mcp-([A-Za-z0-9-]+)/g)) out.add(m[1]);
	} catch {}
	return out;
}
/* [local.41] 白名单脚本 → 启动命令。按扩展名选解释器，argv 直传不经 shell（无注入面）。 */
export function capabilityCommand(dirAbs, scriptRel) {
	if (typeof scriptRel !== "string" || scriptRel === "" || scriptRel.includes("..") || nodePath.isAbsolute(scriptRel)) return { error: "script 必须是能力目录内的相对路径" };
	const abs = nodePath.resolve(dirAbs, scriptRel);
	if (abs !== nodePath.resolve(dirAbs) && !abs.startsWith(nodePath.resolve(dirAbs) + nodePath.sep)) return { error: "script 越出能力目录" };
	const ext = nodePath.extname(abs).toLowerCase();
	if (ext === ".sh" || ext === ".bash") return { command: "bash", args: [abs] };
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { command: process.execPath, args: [abs] };
	if (ext === ".py") return { command: "python3", args: [abs] };
	if (ext === "") return { command: abs, args: [] };
	return { error: `不支持的脚本扩展名「${ext}」（支持 .sh/.bash/.js/.mjs/.cjs/.py 或无扩展名可执行文件）` };
}
/* [local.41] 执行能力脚本：捕获 stdout/stderr（封顶），超时 SIGKILL。close 事件保证管道排空。 */
export function runCapabilityProcess(command, args, cwd, env, timeoutMs) {
	return new Promise((resolve) => {
		const child = childProcessSpawn(command, args, { cwd, env: { ...process.env, ...(env ?? {}), DSH_CAP_RUN: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "";
		child.stdout?.on("data", (d) => { if (out.length < 20000) out += String(d); });
		child.stderr?.on("data", (d) => { if (err.length < 20000) err += String(d); });
		const timer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch {}
			resolve({ exitCode: -1, output: `${out}${err ? `\n[stderr]\n${err}` : ""}\n[timeout] 超过 ${(timeoutMs / 1000).toFixed(0)}s 被终止`.trim().slice(0, 12000) });
		}, timeoutMs);
		child.on("error", (e) => { clearTimeout(timer); resolve({ exitCode: -1, output: `[spawn error] ${String(e).slice(0, 300)}` }); });
		child.on("close", (code) => {
			clearTimeout(timer);
			const combined = `${out}${err ? (out !== "" ? "\n[stderr]\n" : "") + err : ""}`.trim();
			resolve({ exitCode: code ?? -1, output: combined.slice(0, 12000) });
		});
	});
}
/* [local.48] 带硬超时的子进程执行（detached 进程组，超时先 SIGTERM 后 SIGKILL 整组——
 * caps-sync 内部会再 spawn git/npm，逐个杀不可靠）。供 src_add_capability 调 caps-sync 用。 */
export function runChildWithTimeout(argv, opts = {}) {
	return new Promise((resolve) => {
		const child = childProcessSpawn(argv[0], argv.slice(1), { env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let out = "", err = "", timedOut = false;
		const killTree = (signal) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
		const timer = setTimeout(() => {
			timedOut = true;
			killTree("SIGTERM");
			setTimeout(() => killTree("SIGKILL"), 5000);
		}, opts.timeoutMs ?? 900000);
		child.stdout?.on("data", (d) => { if (out.length < 60000) out += String(d); });
		child.stderr?.on("data", (d) => { if (err.length < 60000) err += String(d); });
		child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: "", err: String(e), timedOut }); });
		child.on("close", (code) => { clearTimeout(timer); resolve({ code: timedOut ? -2 : (code ?? -1), out: out.trim(), err: err.trim(), timedOut }); });
	});
}
export const SRC_INFRA_DEFAULTS = Object.freeze({
	proxyUrl: "",
	burpMcpPort: "9876",
	burpProxyJarPath: "",
	testAccount: "",
	testPhone: "",
	httpTimeoutMs: "8000"
});
export const SRC_INFRA_KEYS = Object.freeze(Object.keys(SRC_INFRA_DEFAULTS));
export const SRC_INFRA_LABELS = Object.freeze({
	proxyUrl: "HTTP 代理（http://127.0.0.1:7890，留空=全直连。仅 google/github 等无法直连的站点自动走代理，国内目标一律直连）",
	burpMcpPort: "Burp MCP 监听端口（默认 9876；默认端口下面板配置即全部，改端口需同步设 BURP_SSE_URL 并重启）",
	burpProxyJarPath: "Burp MCP 自定义桥脚本绝对路径（一般留空=包 patch 默认 ~/.dsh/tools/burp-mcp-bridge.mjs。仅记录/参考，实际接线由包内 cordis.patch.yml 默认提供）",
	testAccount: "越权对照测试账号（user:pass 或用户名；水平越权 A/B 对照）",
	testPhone: "短信/验证码测试手机号，多个用逗号分隔（短信轰炸、验证码爆破类测试用）",
	httpTimeoutMs: "单请求超时毫秒（1000..60000）"
});

