#!/usr/bin/env node
// [local.23] 预设一致性检查：扫描 preset/src-hunter/agent.cordis.yml，对每个 persona 校验——
// ① prompt 文本里点名的 src_* 工具，若出现在该 persona 的 deny 列表里 = 提示词与工具面矛盾（子代理按提示词行事会被 deny 拦死）
// ② 所有 persona 都应 deny 指挥官专用工具（src_add_goal/src_add_intent/src_add_test_account/src_finalize_engagement/src_set_infra/src_fetch_policy）防越权改会话状态
// 行扫描器（不依赖 js-yaml，因 preset 含 !!js 自定义标签标准解析器会拒），按 - id: 行切块，逐块读 persona 块标量与 deny 流式序列。
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(join(root, "preset/src-hunter/agent.cordis.yml"), "utf8");
const lines = text.split("\n");

const TOOL_RE = /\b(src_[a-z_]+)\b/g;
/* [local.43] src_add_asset 移出指挥官专用清单：授权模型「资产清单即许可」——recon/audit 子代理
 * 自查归属后可登记资产（沿父链写入同一份清单，闸按「goal 主域内或资产清单内」放行）；verify 仍 deny。 */
const COMMANDER_TOOLS = ["src_add_capability", "src_add_goal", "src_add_intent", "src_add_test_account", "src_finalize_engagement", "src_set_infra", "src_fetch_policy", "src_set_goal_target", "src_add_fact", "src_add_finding", "src_update_intent", "src_update_finding", "src_record_lesson", "src_record_domain_note", "src_reject_finding", "src_resolve_approval", "src_request_asset_confirm", "src_run_capability"];

// 切块：每个 - id: ... 开始一个 entry，直到下一个同级 - id 或文件末尾。
const entries = [];
let cur = null;
for (let i = 0; i < lines.length; i++) {
  const m = /^(- id: )(\S+)/.exec(lines[i]);
  if (m) {
    cur = { id: m[2], lines: [] };
    entries.push(cur);
  } else if (cur) cur.lines.push(lines[i]);
}

let violations = 0;
for (const e of entries) {
  if (!e.lines.some((l) => /\bpersona:\s*\|-/.test(l) || /\bpersona:\s*\|/.test(l) || /\bpersona:\s*>-/.test(l))) continue;
  // persona 块标量：persona: |- 之后缩进更深的连续行（直到缩进回退到 persona 或更浅）
  const blockLines = [];
  let inBlock = false, baseIndent = 0;
  for (const l of e.lines) {
    if (!inBlock) {
      if (/^\s*persona:\s*\|/.test(l)) { inBlock = true; baseIndent = (/^(\s*)persona:/.exec(l)?.[1]?.length ?? 0) + 2; continue; }
    } else {
      const indent = /^(\s*)\S/.exec(l)?.[1]?.length ?? -1;
      if (l.trim() === "" ) { blockLines.push(l); continue; }
      if (indent >= baseIndent) blockLines.push(l);
      else if (/^\s*(name|config|provider|toolFilter|maxDepth|backgroundMode|toolName|group|isolate)\b/.test(l)) break;
      else break;
    }
  }
  const prompt = blockLines.join("\n");
  // deny 流式序列：deny: [a, b, c]
  const denyMatch = e.lines.find((l) => /^\s*deny:\s*\[/.test(l));
  if (!denyMatch) continue;
  const deny = new Set((denyMatch.match(/\[([^\]]*)\]/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean));

  const referenced = new Set();
  let m2;
  while ((m2 = TOOL_RE.exec(prompt)) !== null) referenced.add(m2[1]);
  const conflicts = [...referenced].filter((name) => deny.has(name));
  if (conflicts.length > 0) {
    console.error(`::error file=preset/src-hunter/agent.cordis.yml::persona ${e.id} 的 prompt 点名了工具 ${conflicts.join(", ")} 但同时 deny 了它们——提示词与工具面矛盾，子代理按提示词行事会被 deny 拦死`);
    violations += conflicts.length;
  }
  const missing = COMMANDER_TOOLS.filter((name) => !deny.has(name));
  if (missing.length > 0) {
    console.error(`::error file=preset/src-hunter/agent.cordis.yml::persona ${e.id} 未 deny 指挥官专用工具 ${missing.join(", ")}——子代理可能越权改写会话状态`);
    violations += missing.length;
  }
}

/* [local.67 #10] 防再膨胀硬闸（plan §11）：
 * ① SRC_INSTRUCTIONS 字符数 ≤8,000——超限即 fail（先做减法再加约束）；
 * ② 工具级 description 合计 ≤15,000；
 * ③ 协议小节名查重：同名【小节】出现两次即 fail（本轮三个重复小节就是靠这个拦住）。 */
const srcJs = readFileSync(join(root, "lib/src.js"), "utf8");
const protoStart = srcJs.indexOf("const SRC_INSTRUCTIONS = `\\");
if (protoStart < 0) { console.error("::error file=lib/src.js::找不到 SRC_INSTRUCTIONS"); violations += 1; }
else {
  const pStart = protoStart + "const SRC_INSTRUCTIONS = `\\".length;
  const pEnd = srcJs.indexOf("`;", pStart);
  const proto = srcJs.slice(pStart, pEnd);
  if (proto.length > 8000) {
    console.error(`::error file=lib/src.js::SRC_INSTRUCTIONS = ${proto.length} 字符，超过 8,000 预算（local.67 #10 防再膨胀硬闸）——先做减法再加约束`);
    violations += 1;
  }
  const sectionNames = [...proto.matchAll(/【([^】]+)】/g)].map((m) => m[1]);
  const seen = new Map();
  for (const name of sectionNames) seen.set(name, (seen.get(name) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([name, n]) => `${name}×${n}`);
  if (dupes.length > 0) {
    console.error(`::error file=lib/src.js::协议小节名重复（local.67 #10 查重）：${dupes.join(", ")}——同名小节合并后再提交`);
    violations += dupes.length;
  }
}
const toolsJs = readFileSync(join(root, "lib/src/tools/index.js"), "utf8");
let descTotal = 0;
const nameRe = /\n\t\tname: "([a-z_]+)",/g;
const nameStarts = [];
let nm;
while ((nm = nameRe.exec(toolsJs)) !== null) nameStarts.push(nm.index);
for (let i = 0; i < nameStarts.length; i++) {
  const block = toolsJs.slice(nameStarts[i], i + 1 < nameStarts.length ? nameStarts[i + 1] : toolsJs.length);
  const dm = block.match(/description: (`)([^`]*)`\1|description: "([^"]*)"/);
  if (dm) descTotal += (dm[2] ?? dm[3] ?? "").length;
}
if (descTotal > 15000) {
  console.error(`::error file=lib/src/tools/index.js::工具级 description 合计 ${descTotal} 字符，超过 15,000 预算（local.67 #10 防再膨胀硬闸）——先做减法再加约束`);
  violations += 1;
}

if (violations > 0) { console.error(`check-preset-consistency: ${violations} 处不一致`); process.exit(1); }
console.log(`check-preset-consistency: persona×toolFilter 一致性 OK；防再膨胀预算 OK（工具级 description 合计 ${descTotal} ≤ 15000，协议与小节名无超限）`);

/* [local.68 轮 2] lessons 防再膨胀：逐篇 ≤ 预算（plan §6.1 处置表）+ 内置合计 ≤ 20k（原 8 篇 ≤15k，
 * local.67/68 新增 burp-mcp/nday-framework/unauth-write-chain 三篇后按 1.9k/篇口径折算）。 */
const LESSON_BUDGETS = {
	"submission-quality": 2600, "token-lifecycle": 2000, "ai-abuse": 2500, "cors": 2000,
	"csrf": 1500, "sms-bomb": 1500, "channel-divergence": 3200, "scope-confirmation": 1600,
	"burp-mcp": 1800, "nday-framework": 1300, "unauth-write-chain": 1200,
	"signature-wall-audit": 2000
};
const lessonsDir = join(root, "preset/src-hunter/lessons");
let lessonsTotal = 0;
for (const [name, budget] of Object.entries(LESSON_BUDGETS)) {
	const size = readFileSync(join(lessonsDir, `${name}.md`), "utf8").length;
	lessonsTotal += size;
	if (size > budget) {
		console.error(`::error file=preset/src-hunter/lessons/${name}.md::${size} 字符超逐篇预算 ${budget}（local.68 轮 2 防再膨胀）——先做减法再加内容`);
		violations += 1;
	}
}
const extraLessons = readdirSync(lessonsDir).filter((f) => f.endsWith(".md") && !(f.replace(/\.md$/, "") in LESSON_BUDGETS));
for (const f of extraLessons) {
	lessonsTotal += readFileSync(join(lessonsDir, f), "utf8").length;
	console.error(`::warning file=preset/src-hunter/lessons/${f}::新增内置 lesson 未登记逐篇预算——请同步扩 LESSON_BUDGETS（一进一出纪律）`);
}
if (lessonsTotal > 20000) {
	console.error(`::error file=preset/src-hunter/lessons/::内置 lessons 合计 ${lessonsTotal} 字符超 20k 预算（local.68 轮 2 防再膨胀）——先做减法再加约束`);
	violations += 1;
}

/* [Phase 8] pattern lesson 校验：四列、敏感细节形态化、内置种子预算。 */
const patternMd = readFileSync(join(root, "lib/src/lessons.js"), "utf8");
for (const token of ["PATTERN_COLUMNS", "patternShapeError", "patternLessonsForContext"]) {
  if (!patternMd.includes(token)) { console.error(`::error file=lib/src/lessons.js::缺少 pattern 机制 ${token}`); violations += 1; }
}
const shortTable = join(process.env.DSH_SRC_SHORT_TABLE ?? "/Users/lihua-dis/Downloads/clown-src-6k-skill/skills/skill/知识库/打穿短表.md");
try {
  const seedRows = readFileSync(shortTable, "utf8").split("\n").filter((line) => /^\|/.test(line) && !/^\|[- ]+\|/.test(line) && !line.includes("认什么 |"));
  if (seedRows.length < 80 || seedRows.length > 100) { console.error(`::error file=${shortTable}::短表 pattern 行数 ${seedRows.length} 不在 80..100 预算`); violations += 1; }
  if (seedRows.some((line) => /https?:\/\//i.test(line) && /认什么/.test(line))) { console.error(`::error file=${shortTable}::短表认法包含 URL，禁止把实例写入通用 pattern`); violations += 1; }
} catch (error) {
  console.warn(`::warning::未找到短表种子 ${shortTable}，跳过 pattern seed 行数检查`);
}

/* [Phase 0.5] 参数对象重复键静态检查：JS 对象字面量后键覆盖前键（b410890 事故：src_add_finding
 * victimImpact 重复定义，模型看到的是旧描述）。字符串/注释感知的括号深度扫描，同一括号深度下
 * 重复属性键报 error。只扫工具 schema 对象（lib/src/tools/index.js）——其他文件的对象字面量
 * 大量模板插值，误报风险高，超出本检查的范围。 */
function findDuplicateKeys(source) {
	const lineOf = (pos) => source.slice(0, pos).split("\n").length;
	/* 预建行首偏移表，避免 O(n²) 切片 */
	const lineStarts = [0];
	for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
	const lineAt = (pos) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
	let depth = 0, inString = null, escaped = false;
	let lastCodeChar = ""; /* 正则字面量二义性判断用（除法 vs 正则）：取前一个非空白代码字符 */
	/* keyStack 每层一个 Map：key -> 首次出现行号 */
	const keyStack = [new Map()];
	const duplicates = [];
	/* pendingKey：刚扫到的标识符（潜在属性键），遇到 ':' 落锤 */
	let pendingKey = null, pendingPos = -1, pendingDepth = -1;
	const flushKey = () => { pendingKey = null; };
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (inString !== null) {
			if (escaped) { escaped = false; continue; }
			if (ch === "\\") { escaped = true; continue; }
			if (inString === "`" && ch === "$") { /* 模板插值：跳过 ${...} 内容（brace 初始 0，内层字符串跳过） */
				let brace = 0, j = i + 1;
				while (j < source.length && brace > 0) { const c = source[j]; if (c === "{") brace += 1; else if (c === "}") brace -= 1; else if (c === "\"" || c === "'" || c === "`") { const q = c; j += 1; while (j < source.length && source[j] !== q) { if (source[j] === "\\") j += 1; j += 1; } } j += 1; }
				j += 1;
				i = j; continue;
			}
			if (ch === inString) inString = null;
			continue;
		}
		if (ch === "\"" || ch === "'" || ch === "`") { inString = ch; escaped = false; flushKey(); lastCodeChar = ch; continue; }
		if (ch === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i += 1; continue; }
		if (ch === "/" && source[i + 1] === "*") { i += 2; while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1; i += 1; continue; }
		if (ch === "/") {
			/* 正则字面量（启发式）：前一个代码字符是表达式位置起始符时视为正则；否则是除法（当普通代码）。
			   字符类 [...] 内的 / 不收尾；正则内的 {} 不会失衡括号计数。误判代价=漏检（好过误报）。 */
			const exprStart = "(,=:[!&|?{;>+-*%^~".includes(lastCodeChar) || lastCodeChar === "" || lastCodeChar === "}" || lastCodeChar === "]" && false;
			if (exprStart) {
				let j = i + 1, inClass = false, e = false;
				while (j < source.length) {
					const c = source[j];
					if (e) { e = false; }
					else if (c === "\\") e = true;
					else if (c === "[") inClass = true;
					else if (c === "]") inClass = false;
					else if (c === "/" && !inClass) break;
					else if (c === "\n") { j = i; break; } /* 行内未闭合——回退当除法处理 */
					j += 1;
				}
				if (j > i && j < source.length) { i = j + 1; flushKey(); continue; } /* 跳过正则及 flags */
			}
			lastCodeChar = "/"; flushKey(); continue;
		}
		if (ch === "{" ) { depth += 1; keyStack.push(new Map()); flushKey(); lastCodeChar = ch; continue; }
		if (ch === "}") { if (depth > 0) { depth -= 1; keyStack.pop(); } flushKey(); lastCodeChar = ch; continue; }
		if (/[A-Za-z_$]/.test(ch) && pendingKey === null) {
			let j = i; while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
			pendingKey = source.slice(i, j); pendingPos = i; pendingDepth = depth; i = j - 1; continue;
		}
		if (ch === ":" && pendingKey !== null) {
			/* 属性键落锤：同一层重复即报（三元/函数体里的标签等场景在此文件 schema 区不出现） */
			if (pendingDepth === depth) {
				const map = keyStack[keyStack.length - 1];
				if (map.has(pendingKey)) duplicates.push({ key: pendingKey, firstLine: map.get(pendingKey), dupLine: lineAt(pendingPos) });
				else map.set(pendingKey, lineAt(pendingPos));
			}
			flushKey();
			lastCodeChar = ch;
			continue;
		}
		if (!/[A-Za-z0-9_$]/.test(ch) && ch !== ".") { flushKey(); if (!/\s/.test(ch)) lastCodeChar = ch; }
	}
	return duplicates;
}
{
	const toolsSource = readFileSync(join(root, "lib/src/tools/index.js"), "utf8");
	const dups = findDuplicateKeys(toolsSource);
	for (const d of dups.slice(0, 20)) {
		console.error(`::error file=lib/src/tools/index.js::L${d.dupLine} 属性键 "${d.key}" 重复定义（首次 L${d.firstLine}）——后键覆盖前键，删除旧键（Phase 0.5 防复发闸）`);
	}
	if (dups.length > 20) console.error(`::error file=lib/src/tools/index.js::另有 ${dups.length - 20} 处重复键未列出`);
	if (dups.length > 0) violations += dups.length;
}
/* [local.130] 运行时闸的意图↔实现一致性：行表里用 `!!js` 闸让 0.1/0.2 互斥启用行。闸的形态是
 * 「能从进程入口解析 @deepseek-ai/dsh-agent-preset = 0.2」，于是“0.2 上禁用”的行必须
 * resolve 成功时 `return true`（禁用），反之“0.1 上禁用”的行必须 resolve 成功时 `return false`。
 * 极性写反了两个运行时上会阴差阳错地加载错形态的行（例如 0.1 载入只认 config.prefix 的 persona），
 * 而两侧启动都不报错——所以这里强制：每个解析闸上方必须有意图注释，且极性与注释一致；
 * 两侧同极性（等于没闸）也报错。 */
{
	const presetLines = readFileSync(join(root, "preset/src-hunter/agent.cordis.yml"), "utf8").split("\n");
	let rowId = null;
	for (let i = 0; i < presetLines.length; i++) {
		const row = /^\s*-\s*id:\s*(\S+)\s*$/.exec(presetLines[i]);
		if (row) { rowId = row[1]; continue; }
		const gate = /^\s*disabled:\s*!!js\s*(.+)$/.exec(presetLines[i]);
		if (!gate || rowId === null) continue;
		rowId = null;
		const expr = gate[1];
		if (!expr.includes("createRequire")) continue;
		const onResolve = /;\s*return\s+(true|false)\s*\}\s*catch/.exec(expr)?.[1];
		const onThrow = /catch\s*\([^)]*\)\s*\{\s*return\s+(true|false)/.exec(expr)?.[1];
		const context = presetLines.slice(Math.max(0, i - 3), i).join("\n");
		const off02 = /0\.2 上禁用/.test(context), off01 = /0\.1 上禁用/.test(context);
		if (onResolve === undefined || onThrow === undefined) {
			console.error(`::error file=preset/src-hunter/agent.cordis.yml::第 ${i + 1} 行的运行时闸解析不出极性（形式应为 ...resolve(...);return <A>}catch(...){return <B>}）`);
			violations += 1;
		} else if (onResolve === onThrow) {
			console.error(`::error file=preset/src-hunter/agent.cordis.yml::第 ${i + 1} 行的运行时闸两侧同极性，等于未设闸`);
			violations += 1;
		} else if (!off02 && !off01) {
			console.error(`::error file=preset/src-hunter/agent.cordis.yml::第 ${i + 1} 行的运行时闸上方必须有意图注释（「0.2 上禁用」或「0.1 上禁用」）`);
			violations += 1;
		} else if (off02 && onResolve !== "true") {
			console.error(`::error file=preset/src-hunter/agent.cordis.yml::第 ${i + 1} 行的闸写成“0.2 上禁用”但极性是 0.1 的（resolve 成功时应 return true）——两个运行时上会加载错形态的行`);
			violations += 1;
		} else if (off01 && onResolve !== "false") {
			console.error(`::error file=preset/src-hunter/agent.cordis.yml::第 ${i + 1} 行的闸写成“0.1 上禁用”但极性是 0.2 的（resolve 成功时应 return false）——两个运行时上会加载错形态的行`);
			violations += 1;
		}
	}
}

/* [local.130] 0.2 preset 声明闸：0.1 走 `preset-root` 目录发现（resolvedRoots），0.2 的 preset 改由
 * 一条 `@deepseek-ai/dsh-agent-preset` 声明行携带行表，用 `cordis:include` 指向同一份
 * `preset/src-hunter/agent.cordis.yml`。这里校验：①声明行存在；②行级 `disabled` 闸自带
 * try/catch（0.1 的 `disabledOf` 不吞异常，闸抛异常 = 0.1 致命）且判据是「能否解析
 * @deepseek-ai/dsh-agent-preset」——少了它 0.1 会去 import 0.2 才有的包；③`config.name` /
 * `description` / `order` 与 preset.yml 逐字一致（声明行是 preset.yml 的唯一手工副本）；
 * ④include 的 `path` 是 profile 相对路径（include 的基址是 profile 目录，不是补丁文件目录），
 * 且它指回的那份行表在包内真实存在。CI 直接 node 跑本脚本（static-check.yml 不装
 * 依赖），所以继续用行扫描而不是 js-yaml。 */
{
	const patchLines = readFileSync(join(root, "cordis.patch.yml"), "utf8").split("\n");
	const rowAt = patchLines.findIndex((line) => /^\s*-\s*id:\s*preset-src-hunter\s*$/.test(line));
	if (rowAt < 0) {
		console.error("::error file=cordis.patch.yml::缺少 0.2 的 preset 声明行 preset-src-hunter——0.2（桌面 App）上 src-hunter 预设会静默缺失，用户选不到「SRC 专业模式」");
		violations += 1;
	} else {
		const rowIndent = (/^(\s*)/.exec(patchLines[rowAt])?.[1] ?? "").length;
		const block = [];
		for (let i = rowAt + 1; i < patchLines.length; i++) {
			const line = patchLines[i];
			if (line.trim() !== "" && ((/^(\s*)/.exec(line)?.[1] ?? "").length <= rowIndent)) break;
			block.push(line);
		}
		const blockText = block.join("\n");
		const rowName = /^\s*name:\s*(.+)$/m.exec(blockText)?.[1]?.trim() ?? "";
		if (rowName !== "'@deepseek-ai/dsh-agent-preset'") {
			console.error(`::error file=cordis.patch.yml::preset-src-hunter 的行级 name 应为 '@deepseek-ai/dsh-agent-preset'，实际 ${rowName || "(缺失)"}`);
			violations += 1;
		}
		const gate = /^\s*disabled:\s*!!js\s*(.+)$/m.exec(blockText)?.[1]?.trim() ?? "";
		if (gate === "") {
			console.error("::error file=cordis.patch.yml::preset-src-hunter 缺少行级 disabled 闸——0.1（不装 @deepseek-ai/dsh-agent-preset）会去 import 该包，启动直接失败");
			violations += 1;
		} else if (!gate.includes("createRequire(process.argv[1])") || !gate.includes("'@deepseek-ai/dsh-agent-preset/package.json'") || !gate.includes("try{") || !gate.includes("catch(")) {
			console.error("::error file=cordis.patch.yml::preset-src-hunter 的 disabled 闸形态不对——须自带 try/catch（0.1 的 disabledOf 不吞异常）且以「能否从进程入口解析 @deepseek-ai/dsh-agent-preset/package.json」为判据");
			violations += 1;
		}
		const configAt = blockText.search(/^\s*config:\s*$/m);
		const configText = configAt < 0 ? "" : blockText.slice(configAt);
		const configIndent = configAt < 0 ? -1 : (/^(\s*)/.exec(blockText.slice(configAt).split("\n")[0])?.[1] ?? "").length;
		const configField = (key) => {
			if (configIndent < 0) return "";
			const re = new RegExp(`^\\s{${configIndent + 2}}${key}:\\s*(.+)$`, "m");
			return re.exec(configText)?.[1]?.trim() ?? "";
		};
		if (configField("id") !== "src-hunter") {
			console.error(`::error file=cordis.patch.yml::preset-src-hunter 的 config.id 应为 src-hunter，实际 ${configField("id") || "(缺失)"}——客户端按 src-hunter 判定是否渲染 SRC 面板`);
			violations += 1;
		}
		const metaText = readFileSync(join(root, "preset/src-hunter/preset.yml"), "utf8");
		const metaField = (key) => (new RegExp(`^${key}:\\s*(.+)$`, "m").exec(metaText)?.[1]?.trim() ?? "");
		for (const key of ["name", "description", "order"]) {
			const expected = metaField(key), actual = configField(key);
			if (expected !== actual) {
				console.error(`::error file=cordis.patch.yml::preset-src-hunter 的 config.${key} 与 preset/src-hunter/preset.yml 不一致（声明行 ${actual || "(缺失)"} ≠ preset.yml ${expected}）——0.1/0.2 会显示不同的预设名`);
				violations += 1;
			}
		}
		const includePath = /^\s*path:\s*(.+)$/m.exec(configText)?.[1]?.trim().replace(/^'(.*)'$/, "$1") ?? "";
		const expectedInclude = "./node_modules/@lihua_dis/dsh-src/preset/src-hunter/agent.cordis.yml";
		if (includePath !== expectedInclude) {
			console.error(`::error file=cordis.patch.yml::preset-src-hunter 的 include path 应为 '${expectedInclude}'（include 相对 profile 目录解析，插件就装在 profile 的 node_modules 里），实际 ${includePath || "(缺失)"}`);
			violations += 1;
		} else {
			try { readFileSync(join(root, "preset/src-hunter/agent.cordis.yml"), "utf8"); }
			catch { console.error("::error file=cordis.patch.yml::preset-src-hunter 的 include path 指向的行表不存在——0.2 上预设声明会加载失败"); violations += 1; }
		}
		if (!/^\s*-\s*id:\s*src-preset-root\s*$/m.test(patchLines.join("\n"))) {
			console.error("::error file=cordis.patch.yml::缺少 src-preset-root 行——0.1 上 src-hunter 预设不再被发现");
			violations += 1;
		}
		if (violations === 0) console.log("check-preset-consistency: 0.2 preset 声明闸 OK（声明行 + 单一真源 include + 与 preset.yml 逐字一致）");
	}
}
if (violations > 0) { console.error(`check-preset-consistency: ${violations} 处不一致`); process.exit(1); }
console.log(`check-preset-consistency: lessons 预算 OK（内置 ${Object.keys(LESSON_BUDGETS).length + extraLessons.length} 篇合计 ${lessonsTotal} ≤ 20000）`);
