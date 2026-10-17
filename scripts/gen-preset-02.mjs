#!/usr/bin/env node
/* [local.137] 0.2 行表视图生成器。
 *
 * 根因（2026-10-17 桌面 App 会话塌缩为 2~11 个兜底工具）：
 * 0.2 的插件策略闸对 `cordis:include` 是「**整份丢弃**」——被指文件不在可重写层里
 * （「a native Include that reaches a denied plugin is omitted whole, because its file
 * is never rewritten」），所以 include 文件图里只要**有一条**引用落在当前运行时不可用的
 * 插件名上，整份行表连坐消失：`preset-src-hunter-rows` 被丢 ⇒ src-hunter 预设 0 行 ⇒
 * 会话只剩基础 agent 的兜底工具。0.1 专有的 `@deepseek-ai/dsh-workflow-worker-thread`
 * 正是这样一条：0.2 已移除该引擎（改用 `dsh-workflow-ptc`）。
 *
 * 因此行表分两份、单一真源：
 *   - `preset/src-hunter/agent.cordis.yml`      —— 真源，两个运行时的行都在（0.1 直接读它）；
 *   - `preset/src-hunter/agent-02.cordis.yml`   —— 本脚本生成的 **0.2 视图**，删掉标了
 *     `@drop-0.2-view` 的行（0.2 的 bundle patch 用 `cordis:include` 指向它）。
 * 行带运行时 `!!js` 闸互斥启用是**不够**的：策略闸看的是 include 文件图里出现的插件名
 * （求值后的行，注释与 `disabled` 都不豁免——实测 `disabled: true` 的行照样被拒并连坐父 include），
 * 而 `!!js` 动态 `name` 不被加载器解析（`name.startsWith is not a function`）。分视图是
 * 唯一不动 0.1 能力、也不放宽策略闸的做法。
 *
 * 用法：
 *   node scripts/gen-preset-02.mjs           # 重新生成视图
 *   node scripts/gen-preset-02.mjs --check   # 只校验视图是最新的（CI/npm test 用，不写盘）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_FILE = "preset/src-hunter/agent.cordis.yml";
export const VIEW_FILE = "preset/src-hunter/agent-02.cordis.yml";
/** 行上方的注释块里出现它 ⇒ 该行不进 0.2 视图。 */
export const DROP_MARKER = "@drop-0.2-view";

const BANNER = [
	"# ⚠️ 本文件由 `node scripts/gen-preset-02.mjs` 生成，请勿手改。",
	"# 它是 preset/src-hunter/agent.cordis.yml 的 **0.2 视图**：删掉了标 `" + DROP_MARKER + "` 的",
	"# 0.1 专有行。为什么要分视图：0.2 的插件策略闸会把「引用到不可用插件的 include」**整份**丢掉",
	"# （include 文件不在可重写层里，只能整体放弃），留一条 0.1 专有行就会让 0.2 上整份 SRC 行表消失",
	"# （预设 0 行 ⇒ 会话只剩兜底工具）。改行表后跑 `npm run preset:02:build`；`npm test` 校验本文件最新。",
].join("\n");

/** 删掉所有「上方注释块标了 DROP_MARKER」的 YAML 列表项（含其注释块）。 */
export function stripDroppedRows(text) {
	const lines = text.split("\n");
	const drop = new Array(lines.length).fill(false);
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s*-\s/.test(lines[i])) continue;
		let comment = i;
		while (comment - 1 >= 0 && /^\s*#/.test(lines[comment - 1])) comment -= 1;
		if (!lines.slice(comment, i).some((line) => line.includes(DROP_MARKER))) continue;
		const indent = (/^(\s*)/.exec(lines[i])?.[1] ?? "").length;
		for (let k = comment; k < i; k += 1) drop[k] = true;
		let end = i;
		for (; end < lines.length; end += 1) {
			if (end === i) continue;
			if (lines[end].trim() === "") continue;
			if (((/^(\s*)/.exec(lines[end])?.[1] ?? "").length) <= indent) break;
		}
		for (let k = i; k < end; k += 1) drop[k] = true;
	}
	const kept = lines.filter((_, i) => !drop[i]);
	/* 删行留下的连续空行收成至多一行，保持视图 diff 稳定。 */
	const out = [];
	for (const line of kept) {
		if (line.trim() === "" && out.length > 0 && out[out.length - 1].trim() === "") continue;
		out.push(line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** 真源 → 0.2 视图全文。 */
export function renderView(sourceText) {
	return `${BANNER}\n${stripDroppedRows(sourceText)}`;
}

/** 视图现状 vs 期望；无差异返回 ""。 */
export function viewDiff(target = ROOT) {
	const expected = renderView(readFileSync(join(target, SOURCE_FILE), "utf8"));
	let actual = "";
	try {
		actual = readFileSync(join(target, VIEW_FILE), "utf8");
	} catch {
		return `视图不存在：${VIEW_FILE}`;
	}
	if (actual === expected) return "";
	const a = actual.split("\n");
	const b = expected.split("\n");
	for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
		if (a[i] !== b[i]) return `${VIEW_FILE} 第 ${i + 1} 行起与真源不同步（视图 ${JSON.stringify(a[i] ?? "<EOF>")} ≠ 生成 ${JSON.stringify(b[i] ?? "<EOF>")}）`;
	}
	return "";
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	if (process.argv.includes("--check")) {
		const diff = viewDiff(ROOT);
		if (diff) {
			console.error(`::error file=${VIEW_FILE}::0.2 行表视图不是最新的（${diff}）——改过 ${SOURCE_FILE} 后跑 ` + "`npm run preset:02:build`");
			process.exit(1);
		}
		console.log(`gen-preset-02: ${VIEW_FILE} 与真源同步 OK`);
	} else {
		const rendered = renderView(readFileSync(join(ROOT, SOURCE_FILE), "utf8"));
		writeFileSync(join(ROOT, VIEW_FILE), rendered);
		const dropped = rendered.split("\n").length;
		console.log(`gen-preset-02: 已写出 ${VIEW_FILE}（${dropped} 行，已删 ${DROP_MARKER} 行）`);
	}
}
