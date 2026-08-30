#!/usr/bin/env node
// dsh-src 外部能力 sync：capabilities.yaml → 安装(git/npm 型) → 生成 profile patch 能力区段（mcp 型）
// 与能力索引 index.json（全部 kind，skill 型带 dir/docs/scripts 供插件 src_read/run_capability 用）。
// 规范见 docs/CAPABILITIES.md。零依赖（node:24 内置模块 + 手写受限 yaml 子集解析）。
//
// 用法：node scripts/caps-sync.mjs [--yaml <路径>] [--profile-dir <路径>] [--dry-run]
//   --yaml          默认 $DSH_HOME/capabilities.yaml（DSH_HOME 缺省 ~/.dsh）
//   --profile-dir   默认 $DSH_HOME/profiles/web
//   --dry-run       只打印将要做的变更，不写盘、不安装
import { readFile, writeFile, mkdir, access, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, EOL } from "node:os";
import path from "node:path";

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
const capsDir = path.join(DSH_HOME, "capabilities");
//#endregion

//#region 工具函数
async function run(cmd, args, opts = {}) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
		let out = "", err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
		child.on("error", (e) => resolve({ code: -1, out: "", err: String(e) }));
	});
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
//#endregion

//#region 主流程

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
		const r = await run("git", cloneArgs, { env: proxyEnv });
		if (r.code !== 0) { log(`✗ ${c.id}: git clone 失败（该能力本轮不接线）：${(r.err || r.out).slice(-300)}`); notReady.add(c.id); continue; }
		await writeFile(marker, JSON.stringify({ from: wantFrom, ref: c.ref ?? null, installedAt: new Date().toISOString() }, null, 2) + EOL);
	}
	if (c.build) {
		if (dryRun) { log(`[dry] ${c.id}: 将在 ${dest} 执行构建`); continue; }
		log(`→ ${c.id}: 构建…`);
		const r = await run("bash", ["-lc", c.build], { cwd: dest, env: proxyEnv });
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
		log(`→ ${c.id}: npm install ${c.from.slice(4)} → ${dest}`);
		await mkdir(dest, { recursive: true });
		const r = await run("npm", ["install", "--prefix", dest, c.from.slice(4)], { env: proxyEnv });
		if (r.code !== 0) { log(`✗ ${c.id}: npm install 失败（该能力本轮不就绪）：${(r.err || r.out).slice(-300)}`); notReady.add(c.id); continue; }
		await writeFile(marker, JSON.stringify({ from: c.from, ref: c.ref ?? null, installedAt: new Date().toISOString() }, null, 2) + EOL);
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
//#endregion
