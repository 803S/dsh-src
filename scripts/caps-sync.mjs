#!/usr/bin/env node
// dsh-src 外部能力 sync：capabilities.yaml → 安装(git/npm 型) → 生成 profile patch 能力区段（mcp 型）
// 与能力索引 index.json（全部 kind，skill 型带 dir/docs/scripts 供插件 src_read/run_capability 用）。
// 规范见 docs/CAPABILITIES.md。零依赖（node:24 内置模块 + 手写受限 yaml 子集解析）。
//
// 用法：node scripts/caps-sync.mjs [--yaml <路径>] [--profile-dir <路径>] [--dry-run] [--no-prewarm]
//   --yaml          默认 $DSH_HOME/capabilities.yaml（DSH_HOME 缺省 ~/.dsh）
//   --profile-dir   默认 $DSH_HOME/profiles/web
//   --dry-run       只打印将要做的变更，不写盘、不安装
//   --no-prewarm    跳过 npm 型 mcp 能力的本地预热（默认预热，加速首次 npx 启动）
// [local.48] 网络操作全部带超时（clone 180s/build 300s/npm 600s），超时或网络失败时提示
//   npm registry 备选路线；npm 统一走 $DSH_HOME/.npm-cache 缓存（绕开 ~/.npm 权限坑）。
//   本文件同时被 lib/src.js 的 src_add_capability 动态导入复用（parseCapsYaml/resolveFrom/
//   appendCapabilityEntry 等纯函数），故主流程包在 main() 里、仅直接执行时运行。
import { readFile, writeFile, mkdir, access, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, EOL } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

//#region 受限 yaml 子集解析（只支持本规范用到的形态，报错即指出行号）
function parseCapsYaml(text) {
	const lines = text.split(/\r?\n/);
	let caps = null;
	let settings = {};       // 顶层 settings:（当前仅 proxy）
	let inSettings = false;
	let cur = null;          // 当前能力条目
	let curKey = null;       // 待赋值的顶层键（when 多行场景）
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const no = i + 1;
		if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
		if (/^capabilities:\s*$/.test(raw)) { caps = []; inSettings = false; continue; }
		if (/^settings:\s*$/.test(raw)) { inSettings = true; continue; }
		if (inSettings) {
			const skv = raw.match(/^  ([A-Za-z_][\w]*):\s*(.*)$/);   // settings 内键（2空格缩进）
			if (skv) { settings[skv[1]] = coerce(stripQuotes(skv[2])); continue; }
			throw new Error(`第${no}行：settings 块内只支持 "  key: value" 形式`);
		}
		if (caps === null) throw new Error(`第${no}行：文件必须以 "capabilities:" 或 "settings:" 开头`);
		const item = raw.match(/^  - (.+)$/);            // 条目首行 "  - key: value"
		if (item) {
			const kv = item[1].match(/^([A-Za-z_][\w]*):\s*(.*)$/);
			if (!kv) throw new Error(`第${no}行：条目首行应为 "- id: xxx" 形式`);
			cur = { [kv[1]]: stripQuotes(kv[2]) };
			caps.push(cur);
			curKey = null;
			continue;
		}
		const nested = raw.match(/^    ([A-Za-z_][\w]*):\s*(.*)$/);   // 条目内键（4空格缩进）
		if (nested && cur) {
			const [, k, v] = nested;
			if (v === "{}") cur[k] = {};
			else if (v === "" || v === ">" || v === "|") { curKey = k; if (v !== "") cur[k] = ""; }
			else if (v.startsWith("{")) cur[k] = parseInlineMap(v, no);
			else if (/^\[.*\]$/.test(v.trim())) cur[k] = v.trim().slice(1, -1).split(",").map((s) => coerce(stripQuotes(s.trim()))).filter(Boolean);
			else cur[k] = coerce(stripQuotes(v));
			continue;
		}
		const cont = raw.match(/^      (.+)$/);           // when 的多行续文（6空格）
		if (cont && cur && curKey) {
			cur[curKey] = String(cur[curKey] ?? "").trim() ? `${cur[curKey]} ${cont[1].trim()}` : cont[1].trim();
			continue;
		}
		throw new Error(`第${no}行：无法解析的行「${raw.trim().slice(0, 40)}」（只支持 docs/CAPABILITIES.md 定义的子集）`);
	}
	return { caps: caps ?? [], settings };
}
function stripQuotes(v) {
	const s = v.trim();
	return /^".*"$/.test(s) || /^'.*'$/.test(s) ? s.slice(1, -1) : s;
}
function coerce(v) {
	if (v === "true") return true;
	if (v === "false") return false;
	return v;
}
function parseInlineMap(v, no) {
	const m = v.trim().match(/^\{(.*)\}$/);
	if (!m) throw new Error(`第${no}行：内联 map 格式错误`);
	const out = {};
	for (const pair of m[1].split(",")) {
		if (!pair.trim()) continue;
		const kv = pair.split(":");
		if (kv.length !== 2) throw new Error(`第${no}行：内联 map 键值对错误「${pair.trim()}」`);
		out[kv[0].trim()] = coerce(stripQuotes(kv[1]));
	}
	return out;
}
//#endregion

//#region 常量与参数
const MARK_BEGIN = "# ── dsh-src capabilities:8< 自动生成区段开始（勿手改，改 capabilities.yaml 后重跑 sync）──";
const MARK_END = "# ── dsh-src capabilities:>8 自动生成区段结束 ──";
const argv = process.argv.slice(2);
function argOf(flag, fallback) {
	const i = argv.indexOf(flag);
	return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1].replace(/^~(?=\/|$)/, homedir())) : fallback;
}
const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(homedir(), ".dsh");
const yamlPath = argOf("--yaml", path.join(DSH_HOME, "capabilities.yaml"));
const profileDir = argOf("--profile-dir", path.join(DSH_HOME, "profiles", "web"));
const dryRun = argv.includes("--dry-run");
const noPrewarm = argv.includes("--no-prewarm");
const capsDir = path.join(DSH_HOME, "capabilities");
//#endregion

//#region 工具函数
/* [local.48] timeoutMs>0 时超时先 SIGTERM、5s 后 SIGKILL；超时返回 code:-2 + timedOut:true。
 * 61 分钟悬空 clone 的教训：绝不允许无超时的网络子进程。 */
async function run(cmd, args, opts = {}) {
	const { timeoutMs = 0, ...spawnOpts } = opts;
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOpts });
		let out = "", err = "", timedOut = false;
		const timer = timeoutMs > 0 ? setTimeout(() => {
			timedOut = true;
			try { child.kill("SIGTERM"); } catch {}
			setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
		}, timeoutMs) : null;
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: timedOut ? -2 : code, out: out.trim(), err: err.trim(), timedOut }); });
		child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, out: "", err: String(e), timedOut }); });
	});
}
/* [local.48] npm 统一缓存环境：缓存指向 $DSH_HOME/.npm-cache（绕开 ~/.npm 权限坑——
 * sudo chown 501:20 报错在真实接入会话出现两次），关 audit/fund/update-notifier 减少网络往返。 */
function npmCacheEnv(dshHome) {
	return { npm_config_cache: path.join(dshHome, ".npm-cache"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
}
async function pathExists(p) { try { await access(p); return true; } catch { return false; } }
/* [local.41] npm 引用 → 包名（支持 @scope/pkg@1.2.3 与 pkg@1.2.3）。 */
function npmPkgName(from) {
	const s = from.slice(4);
	const at = s.lastIndexOf("@");
	return at > 0 ? s.slice(0, at) : s;
}
/* [local.41] skill 型能力的实际目录：git 型=clone 目录；npm 型=dest/node_modules/<pkg>。 */
function skillCapDir(c) { return c.from.startsWith("git:") ? path.join(capsDir, c.id) : path.join(capsDir, c.id, "node_modules", npmPkgName(c.from)); }
function log(msg) { console.log(msg); }
function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

//#region [local.48] 供 src_add_capability 复用的纯函数（登记/解析/序列化）
const CAP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
function oneLine(v) { return String(v).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim(); }
/* 校验并序列化一个能力条目为「受限 yaml 子集」的条目行块。非法即抛错（不写盘）。 */
function serializeCapabilityEntry(entry) {
	if (!entry || typeof entry !== "object") throw new Error("条目必须是对象");
	if (typeof entry.id !== "string" || !CAP_ID_RE.test(entry.id)) throw new Error(`id「${String(entry.id)}」不合法（小写字母开头，仅小写字母/数字/连字符，≤31 字符）`);
	if (typeof entry.from !== "string" || !/^(npm|git):/.test(entry.from) || entry.from.length <= 4) throw new Error(`from「${String(entry.from)}」必须以 npm: 或 git: 开头`);
	const kind = entry.kind ?? "mcp";
	if (kind !== "mcp" && kind !== "skill") throw new Error("kind 必须是 mcp 或 skill");
	const rel = (v, name) => {
		if (typeof v !== "string" || v === "" || v.includes("..") || path.isAbsolute(v) || v.includes(",")) throw new Error(`${name} 必须是能力目录内相对路径（禁止空串/..、绝对路径、逗号）`);
		return v;
	};
	if (Array.isArray(entry.scripts)) {
		if (entry.scripts.length > 20) throw new Error("scripts 最多 20 项");
		entry.scripts.forEach((s) => rel(s, "scripts 项"));
	} else if (entry.scripts !== void 0) throw new Error("scripts 必须是字符串数组");
	if (entry.docs !== void 0 && entry.docs !== null) rel(entry.docs, "docs");
	if (entry.entry !== void 0 && entry.entry !== null) {
		rel(entry.entry, "entry");
		if (kind === "skill") throw new Error("skill 型不需要 entry（entry 仅 mcp 型使用）");
	}
	if (entry.when !== void 0 && entry.when !== null && (typeof entry.when !== "string" || oneLine(entry.when).length > 200)) throw new Error("when 需为 ≤200 字符的一句话");
	if (entry.ref !== void 0 && entry.ref !== null && (typeof entry.ref !== "string" || !/^[\w./-]{1,60}$/.test(entry.ref))) throw new Error("ref 需为 ≤60 字符的分支/标签名");
	const lines = [`  - id: ${entry.id}`, `    from: ${entry.from}`, `    kind: ${kind}`];
	if (entry.ref) lines.push(`    ref: ${entry.ref}`);
	if (entry.entry) lines.push(`    entry: ${entry.entry}`);
	if (entry.docs) lines.push(`    docs: ${entry.docs}`);
	if (Array.isArray(entry.scripts) && entry.scripts.length > 0) lines.push(`    scripts: [${entry.scripts.join(", ")}]`);
	if (typeof entry.when === "string" && oneLine(entry.when) !== "") lines.push(`    when: ${oneLine(entry.when)}`);
	if (entry.enabled === false) lines.push("    enabled: false");
	return lines.join("\n") + "\n";
}
/* 把条目追加到清单文本末尾并【守卫式重解析】：旧条目必须全部保留、新条目必须可解析、无重复 id。
 * 追加失败（如清单末尾不是 capabilities 列表）一律抛错，绝不写坏用户清单。 */
function appendCapabilityEntry(yamlText, entry, oldIds) {
	const base = yamlText === "" ? "capabilities:\n" : (/\n$/.test(yamlText) ? yamlText : yamlText + "\n");
	const candidate = base + serializeCapabilityEntry(entry);
	const parsed = parseCapsYaml(candidate);
	const ids = parsed.caps.map((c) => c.id);
	if (new Set(ids).size !== ids.length) throw new Error(`追加后出现重复 id（${ids.join(", ")}）`);
	if (!ids.includes(entry.id)) throw new Error("追加后未检测到新条目——清单末尾可能不是 capabilities 列表，请手动编辑");
	for (const old of oldIds) if (!ids.includes(old)) throw new Error(`追加后丢失既有条目 ${old}，放弃写入`);
	return { text: candidate, parsed };
}
/* npm registry 探测：包是否存在、最新版本、repository 指向。离线/失败一律 hit:false。 */
async function npmProbe(pkgName, opts = {}) {
	const r = await run("npm", ["view", pkgName, "--json"], { env: opts.env ?? process.env, timeoutMs: opts.timeoutMs ?? 45000 });
	if (r.code !== 0) return { hit: false };
	try {
		const meta = JSON.parse(r.out);
		return { hit: true, version: typeof meta?.version === "string" ? meta.version : null, repoUrl: typeof meta?.repository === "object" ? String(meta.repository?.url ?? "") : String(meta?.repository ?? "") };
	} catch { return { hit: false }; }
}
/* [local.48] 来源解析（npm registry 优先）：真实接入会话的 25 分钟网络试探教训——GitHub 链接
 * 往往已发布为 npm 包，registry 命中就走 npm:（免 GitHub 网络）；未命中才回退 git: clone。 */
async function resolveFrom(rawInput, opts = {}) {
	const input = String(rawInput ?? "").trim();
	if (input === "") throw new Error("from 不能为空");
	if (/^(npm|git):/.test(input)) return { from: input, resolvedVia: "显式指定" };
	let owner = null, repo = null;
	const gh = input.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/);
	if (gh) { owner = gh[1]; repo = gh[2].replace(/\.git$/, ""); }
	else if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input)) { owner = input.split("/")[0]; repo = input.split("/")[1].replace(/\.git$/, ""); }
	if (owner !== null) {
		const probe = await npmProbe(repo, opts);
		if (probe.hit && (!probe.repoUrl || probe.repoUrl.toLowerCase().includes(`${owner}/${repo}`.toLowerCase())))
			return { from: `npm:${repo}${probe.version ? `@${probe.version}` : ""}`, resolvedVia: `npm registry 命中（${owner}/${repo} 已发布为 npm 包${probe.version ? `，最新 ${probe.version}` : ""}——registry 可达性通常好于 GitHub，且安装/更新更快）` };
		const why = probe.hit ? `npm 存在同名包「${repo}」但 repository 不指向 ${owner}/${repo}，防误接改走源码` : "npm registry 未命中（离线或未发布），回退源码 clone";
		return { from: `git:https://github.com/${owner}/${repo}`, resolvedVia: why };
	}
	if (/^@[\w.-]+\/[\w.-]+(@[\w.-]+)?$/.test(input) || /^[A-Za-z][\w.-]*$/.test(input)) return { from: `npm:${input}`, resolvedVia: "npm 包名" };
	if (/^git@[\w.-]+:/i.test(input) || /\.git$/.test(input)) return { from: `git:${input}`, resolvedVia: "git url" };
	throw new Error(`无法识别的 from「${input.slice(0, 120)}」——支持 npm:<pkg>[@ver]、git:<url>、https://github.com/o/r、owner/repo 或 npm 包名`);
}
/* 从来源推导能力 id（npm 取包名尾段去 scope/版本；git 取仓库名）。推导不出合法 id 返回 ""。 */
function deriveCapId(from) {
	const f = String(from ?? "");
	let base = "";
	if (f.startsWith("npm:")) {
		const s = f.slice(4);
		const at = s.lastIndexOf("@");
		const name = at > 0 ? s.slice(0, at) : s;
		base = name.includes("/") ? name.split("/").pop() ?? "" : name;
	} else if (f.startsWith("git:")) base = f.slice(4).replace(/\/+$/, "").replace(/\.git$/, "").split("/").pop() ?? "";
	base = base.toLowerCase();
	return CAP_ID_RE.test(base) ? base : "";
}
//#endregion
//#endregion

//#region 主流程
async function main() {

// ── ⓪ 确保 Burp 自愈桥就位（包 patch 默认启用 mcp-burp，桥缺失时该块静默跳过）────
try {
	const bridgeSrc = path.join(import.meta.dirname, "..", "tools", "burp-mcp-bridge.mjs");
	if (await pathExists(bridgeSrc)) {
		const bridgeDest = path.join(DSH_HOME, "tools", "burp-mcp-bridge.mjs");
		const srcBuf = await readFile(bridgeSrc);
		let needCopy = true;
		if (await pathExists(bridgeDest)) needCopy = !srcBuf.equals(await readFile(bridgeDest));
		if (needCopy) {
			await mkdir(path.join(DSH_HOME, "tools"), { recursive: true });
			await writeFile(bridgeDest, srcBuf);
			log(`✓ 已安装 Burp 自愈桥 → ${bridgeDest}`);
		}
	}
} catch { /* 桥安装失败不阻塞能力 sync */ }

// ── ⓪½ 确保 profile patch 里有 mcp-burp 接线（已有则不动，绝不重复写）──────────
try {
	const patchPath0 = path.join(profileDir, "cordis.patch.yml");
	if (await pathExists(patchPath0)) {
		const ptxt = await readFile(patchPath0, "utf8");
		const hasBurp = /^[^#\n]*- id: mcp-burp\b/m.test(ptxt);
		if (!hasBurp) {
			const burpBlock = [
				"# ── dsh-src burp:8< 自动生成（caps-sync 幂等维护；想自定义请整段替换并去掉本标记）──",
				"- insert:",
				"    - id: mcp-burp",
				"      name: '@deepseek-ai/dsh-mcp-client'",
				"      config:",
				"        serverName: burp          # 必须叫 burp —— 工具名才是 mcp__burp__*",
				"        transport: stdio",
				"        command: bash             # bash -c 展开 $HOME；桥未装时提示后静默退出",
				"        args:",
				"          - '-c'",
				"          - 'B=\"$HOME/.dsh/tools/burp-mcp-bridge.mjs\"; if [ -f \"$B\" ]; then exec node \"$B\"; else echo \"[burp-bridge] bridge not installed; run caps-sync\" >&2; fi'",
				"        failOnStartupError: false # Burp 未开时不阻塞其它功能",
				"        toolCallTimeoutMs: 120000",
				"# ── dsh-src burp:>8 自动生成区段结束 ──",
				"",
			].join(EOL);
			await writeFile(patchPath0, ptxt.endsWith(EOL) ? ptxt + EOL + burpBlock : ptxt + EOL + burpBlock);
			log(`✓ 已写入 Burp MCP 接线 → ${patchPath0}`);
		}
	}
} catch { /* 接线写入失败不阻塞能力 sync */ }

if (!existsSync(yamlPath)) {
	/* [local.19] 只为 Burp 跑 sync 的用户（无外部能力清单）到此已全部就绪，正常退出而非报错。 */
	log(`✓ Burp 自愈桥与 MCP 接线已就绪。`);
	log(`ℹ 未找到 ${yamlPath}——跳过外部能力同步。仅当要接入 JS 逆向/二进制等外部 MCP 能力时才需要它；届时执行：cp ~/.dsh/capabilities.yaml.example ~/.dsh/capabilities.yaml`);
	process.exit(0);
}
const parsed = parseCapsYaml(await readFile(yamlPath, "utf8"));
const caps = parsed.caps;
const settingsProxy = typeof parsed.settings.proxy === "string" ? parsed.settings.proxy.trim() : "";
if (settingsProxy && !/^https?:\/\/[A-Za-z0-9.\-_]+:\d{1,5}$/.test(settingsProxy))
	die(`settings.proxy「${settingsProxy}」不是合法 http(s)://host:port 形式`);
/* 代理优先级：settings.proxy 显式声明 > 环境变量既有值。仅影响 sync 内部的 git 操作，不改写用户 shell。 */
const proxyEnv = settingsProxy
	? { ...process.env, HTTPS_PROXY: settingsProxy, HTTP_PROXY: settingsProxy, https_proxy: settingsProxy, http_proxy: settingsProxy }
	: process.env;
if (settingsProxy) log(`使用 settings.proxy=${settingsProxy} 进行 git clone/fetch`);
log(`读取 ${yamlPath}：${caps.length} 个能力声明`);
/* [local.48] npm 统一走 ~/.dsh/.npm-cache（先建目录），clone/npm 全带超时。 */
const npmEnv = { ...proxyEnv, ...npmCacheEnv(DSH_HOME) };
try { await mkdir(path.join(DSH_HOME, ".npm-cache"), { recursive: true }); } catch {}


const seen = new Set();
for (const c of caps) {
	if (!c.id || !c.from) die(`条目缺 id 或 from：${JSON.stringify(c)}`);
	if (seen.has(c.id)) die(`id 重复：${c.id}`);
	seen.add(c.id);
	if (!/^[a-z][a-z0-9-]{1,30}$/.test(c.id)) die(`id「${c.id}」不合法（小写字母开头，仅小写字母/数字/连字符，≤31 字符）`);
	if (!/^(npm|git):/.test(c.from)) die(`${c.id}: from 必须以 npm: 或 git: 开头`);
	/* [local.41] kind: mcp（默认）= 接 MCP 工具面；skill = 文档+白名单脚本（审批后本地执行）。 */
	if (!["mcp", "skill"].includes(c.kind ?? "mcp")) die(`${c.id}: kind 必须是 mcp 或 skill（省略默认 mcp）`);
	if ((c.kind ?? "mcp") === "skill") {
		if (c.scripts !== void 0 && !Array.isArray(c.scripts)) die(`${c.id}: scripts 必须是内联数组，如 scripts: [scripts/a.sh, scripts/b.py]`);
		if (Array.isArray(c.scripts) && c.scripts.some((s) => typeof s !== "string" || s === "" || s.includes("..") || path.isAbsolute(s))) die(`${c.id}: scripts 每项必须是能力目录内的相对路径（禁止空串/../绝对路径）`);
		if (c.entry !== void 0) die(`${c.id}: skill 型不需要 entry（entry 仅 mcp 型使用）`);
		if (c.docs !== void 0 && (typeof c.docs !== "string" || c.docs === "" || c.docs.includes("..") || path.isAbsolute(c.docs))) die(`${c.id}: docs 必须是能力目录内的相对路径`);
	}
}

// ── ① 安装 git 型到统一目录 ─────────────────────────────────────────────
const notReady = new Set();   // 安装/构建失败的 id：不进 patch，末尾警告
for (const c of caps.filter((x) => x.enabled !== false && x.from.startsWith("git:"))) {
	const dest = path.join(capsDir, c.id);
	const marker = path.join(dest, ".caps-src");
	const wantFrom = c.from;
	const already = existsSync(marker) ? JSON.parse(await readFile(marker, "utf8")) : null;
	if (already?.from === wantFrom && existsSync(path.join(dest, ".git"))) {
		log(`= ${c.id}: 已安装在 ${dest}（来源一致，跳过 clone；更新请删目录重跑）`);
	} else {
		if (dryRun) { log(`[dry] ${c.id}: 将 clone ${wantFrom} → ${dest}`); continue; }
		log(`→ ${c.id}: clone ${wantFrom} → ${dest}`);
		await mkdir(capsDir, { recursive: true });
		await rm(dest, { recursive: true, force: true });
		const cloneArgs = ["clone", "--depth", "1"];
		if (c.ref) cloneArgs.push("--branch", String(c.ref));
		cloneArgs.push(wantFrom.slice(4), dest);
		const r = await run("git", cloneArgs, { env: proxyEnv, timeoutMs: 180000 });
		if (r.code !== 0) {
			/* [local.48] 真实接入会话：GitHub 经代理仍不可达拖了 25 分钟。超时/网络类失败时给出 npm 备选路线。 */
			const netHint = r.timedOut || /timed out|Could not resolve|Failed to connect|Connection|SSL|RPC failed|early EOF/i.test(`${r.err}${r.out}`)
				? "（提示：GitHub 直连/代理不可达——确认 settings.proxy 生效；若该项目已发布 npm 包，把 from 改成 npm:<包名> 常可绕开 GitHub 网络）" : "";
			log(`✗ ${c.id}: git clone 失败（该能力本轮不接线）${netHint}：${(r.err || r.out).slice(-300)}`); notReady.add(c.id); continue;
		}
		await writeFile(marker, JSON.stringify({ from: wantFrom, ref: c.ref ?? null, installedAt: new Date().toISOString() }, null, 2) + EOL);
	}
	if (c.build) {
		if (dryRun) { log(`[dry] ${c.id}: 将在 ${dest} 执行构建`); continue; }
		log(`→ ${c.id}: 构建…`);
		const r = await run("bash", ["-lc", c.build], { cwd: dest, env: proxyEnv, timeoutMs: 300000 });
		if (r.code !== 0) { log(`✗ ${c.id}: 构建失败（该能力本轮不接线）：${(r.err || r.out).slice(-300)}`); notReady.add(c.id); continue; }
		log(`✓ ${c.id}: 构建完成`);
	}
}

// ── ①½ 安装 npm 型 skill（npm install 到能力目录，node_modules/<pkg> 即能力目录）────
for (const c of caps.filter((x) => x.enabled !== false && (x.kind ?? "mcp") === "skill" && x.from.startsWith("npm:"))) {
	const dest = path.join(capsDir, c.id);
	const marker = path.join(dest, ".caps-src");
	const pkg = npmPkgName(c.from);
	const already = existsSync(marker) ? JSON.parse(await readFile(marker, "utf8")) : null;
	if (already?.from === c.from && existsSync(path.join(dest, "node_modules", pkg))) {
		log(`= ${c.id}: 已安装在 ${dest}（来源一致，跳过；更新请删目录重跑）`);
	} else {
		if (dryRun) { log(`[dry] ${c.id}: 将 npm install ${c.from.slice(4)} → ${dest}`); continue; }
		log(`→ ${c.id}: npm install ${c.from.slice(4)} → ${dest}（最长 600s）`);
		await mkdir(dest, { recursive: true });
		const r = await run("npm", ["install", "--prefix", dest, c.from.slice(4)], { env: npmEnv, timeoutMs: 600000 });
		if (r.code !== 0) {
			const hint2 = r.timedOut || /network|ECONN|timeout|ETIMEDOUT|EAI_AGAIN/i.test(`${r.err}${r.out}`) ? "（提示：确认 settings.proxy / 网络；registry 不可达时稍后重跑 sync）" : "";
			log(`✗ ${c.id}: npm install 失败（该能力本轮不就绪）${hint2}：${(r.err || r.out).slice(-300)}`); notReady.add(c.id); continue;
		}
		await writeFile(marker, JSON.stringify({ from: c.from, ref: c.ref ?? null, installedAt: new Date().toISOString() }, null, 2) + EOL);
	}
}

// ── ①¾ [local.48] npm 型 mcp 预热：先把包拉进 ~/.dsh/.npm-cache，避免接线后首次 npx 启动现场拉包
//      卡慢（真实接入会话靠 agent 手工预热才解决；预热失败只警告，绝不阻塞接线——闸只放宽不收紧）。
if (!noPrewarm && !dryRun) {
	for (const c of caps.filter((x) => x.enabled !== false && (x.kind ?? "mcp") === "mcp" && x.from.startsWith("npm:"))) {
		const pkg = npmPkgName(c.from);
		const prewarmDest = path.join(capsDir, c.id);
		if (existsSync(path.join(prewarmDest, "node_modules", pkg))) continue;
		log(`→ ${c.id}: 预热 ${c.from.slice(4)}（加速首次 npx 启动，最长 600s）`);
		await mkdir(prewarmDest, { recursive: true });
		const r = await run("npm", ["install", "--prefix", prewarmDest, c.from.slice(4)], { env: npmEnv, timeoutMs: 600000 });
		if (r.code === 0) log(`✓ ${c.id}: 预热完成`);
		else log(`⚠ ${c.id}: 预热失败（不阻塞接线；首次 npx 启动会现场拉包，可能较慢）：${(r.err || r.out).slice(-200)}`);
	}
}

// ── ② 生成接线片段并写入 profile patch ─────────────────────────────────
const active = caps.filter((c) => c.enabled !== false && !notReady.has(c.id) && (c.kind ?? "mcp") === "mcp");
const blockLines = [];
blockLines.push(MARK_BEGIN);
blockLines.push("# 由 scripts/caps-sync.mjs 生成。新增/停用能力请改 ~/.dsh/capabilities.yaml 后重跑 sync。");
if (active.length === 0) blockLines.push("# （当前没有启用的能力）");
for (const c of active) {
	blockLines.push("- insert:");
	blockLines.push(`    - id: mcp-${c.id}`);
	blockLines.push("      name: '@deepseek-ai/dsh-mcp-client'");
	blockLines.push("      config:");
	blockLines.push(`        serverName: ${c.id}`);
	if (c.from.startsWith("npm:")) {
		blockLines.push("        transport: stdio");
		blockLines.push("        command: npx");
		blockLines.push(`        args: ['-y', '${c.from.slice(4)}']`);
	} else {
		const entry = c.entry ?? "dist/index.js";
		const abs = path.join(capsDir, c.id, entry);
		blockLines.push("        transport: stdio");
		blockLines.push("        command: node");
		blockLines.push(`        args: ['${abs.replaceAll("'", "\\'")}']`);
		blockLines.push(`        cwd: ${path.join(capsDir, c.id)}`);
	}
	if (c.env && Object.keys(c.env).length > 0) {
		blockLines.push("        env:");
		for (const [k, v] of Object.entries(c.env)) blockLines.push(`          ${k}: ${JSON.stringify(String(v))}`);
	}
	blockLines.push("        failOnStartupError: false");
	blockLines.push("        toolCallTimeoutMs: 120000");
}
blockLines.push(MARK_END);
const blockText = blockLines.join(EOL);

// ── ②½ 生成能力索引（全部 kind；skill 型带 dir/docs/scripts，供插件 src_read/run_capability 使用）──
if (!dryRun && caps.length > 0) {
	const indexItems = [];
	for (const c of caps) {
		const kind = c.kind ?? "mcp";
		const enabled = c.enabled !== false;
		const base = { id: c.id, kind, from: c.from, ref: c.ref ?? null, enabled, when: typeof c.when === "string" ? c.when : "", docs: kind === "skill" ? (typeof c.docs === "string" && c.docs !== "" ? c.docs : null) : null, scripts: kind === "skill" ? (Array.isArray(c.scripts) ? c.scripts : []) : [], env: c.env && Object.keys(c.env).length > 0 ? c.env : null };
		if (!enabled) { indexItems.push({ ...base, status: "disabled" }); continue; }
		if (notReady.has(c.id)) { indexItems.push({ ...base, status: "failed" }); continue; }
		if (kind === "skill") {
			const dir = skillCapDir(c);
			const installed = existsSync(dir) && (existsSync(path.join(dir, ".caps-src")) || existsSync(path.join(dir, "package.json")));
			indexItems.push({ ...base, status: installed ? "installed" : "failed", ...(installed ? { dir } : {}) });
		} else {
			indexItems.push({ ...base, status: "installed" });
		}
	}
	await mkdir(capsDir, { recursive: true });
	const indexPath = path.join(capsDir, "index.json");
	await writeFile(indexPath, JSON.stringify({ generatedAt: new Date().toISOString(), capabilities: indexItems }, null, 2) + EOL);
	log(`✓ 能力索引已更新 → ${indexPath}`);
}

const patchPath = path.join(profileDir, "cordis.patch.yml");
if (!existsSync(patchPath)) die(`未找到 ${patchPath}（可加 --profile-dir 指定其它 profile）`);
const oldPatch = await readFile(patchPath, "utf8");
const re = new RegExp(`${MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${EOL}?`);
let newPatch;
if (re.test(oldPatch)) {
	newPatch = oldPatch.replace(re, blockText + EOL);
	log(`↻ 已替换 ${patchPath} 中既有能力区段`);
} else {
	newPatch = oldPatch.endsWith(EOL) ? oldPatch + EOL + blockText + EOL : oldPatch + EOL + blockText + EOL;
	log(`↻ 已在 ${patchPath} 尾部追加能力区段`);
}

if (dryRun) {
	log("[dry] 将写入的区段预览：");
	log(blockText.split(EOL).map((l) => "    " + l).join(EOL));
} else {
	await writeFile(patchPath, newPatch);
	log(`✓ 完成。启用的能力：${active.map((c) => c.id).join(", ") || "（无）"}`);
	if (notReady.size > 0) log(`⚠ 未就绪（未接线，修好来源/网络后重跑 sync）：${[...notReady].join(", ")}`);
	log("  下一步：重启 dsh web 生效；验证方式见 docs/CAPABILITIES.md 第三节。");
}
}
//#endregion

/* 仅直接执行时运行主流程；被导入（测试 / src_add_capability）时只暴露纯函数。 */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await main().catch((e) => { console.error(`✗ ${String(e?.message ?? e)}`); process.exit(1); });
}
export { parseCapsYaml, run, pathExists, npmPkgName, npmCacheEnv, serializeCapabilityEntry, appendCapabilityEntry, resolveFrom, deriveCapId, npmProbe };
