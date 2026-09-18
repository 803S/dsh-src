/**
 * artifacts.js — [local.87] 文件类产物按 engagement 收敛的目录约定。
 *
 * 背景：真实项目目录（Src-Pedestal-src-domain-ready）96 个条目乱放——按 host 散落的临时目录、
 * 根目录躺 app.js/req1.txt/下载 html、同名近名任务目录成对出现。结构化数据（facts/assets/
 * findings/coverage）在 src-sessions.db 不动；文件类产物（下载 JS、测绘导出、探测输出、APK、
 * 报告副本）按本约定收敛到每 engagement 一个目录，人阅读体验对齐 clown-src-6k-skill 的
 * desktop-task-folder 模板（README + 资产 + js + 报告 + dig）。
 *
 * 约定目录（对应一个 engagement ≈ 一个会话目标）：
 *   $DSH_HOME/artifacts/{dirName}/
 *     js/        提取/下载的前端 JS、bundle
 *     recon/     测绘导出、证书透明日志、子域清单、curl 输出
 *     probe/     一次性探测输出（半截文件、临时缓存）
 *     apks/      下载的 APK / 反编译产物
 *     报告/      报告类 md（报告本体走 buildReport，这里放副本/附件）
 *     README.md  起手自动生成：目标、会话 id、目录说明
 *
 * 设计原则：给默认路径而非强制（散落都是因为现在没有默认）；零新表零工具名；
 * README 是文件不是上下文（不进状态预算）；DSH_HOME 惰性求值。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** DSH_HOME 惰性求值（模块级 const 会在 import 时固化，测试/运行时后续设置 env 无效）。 */
export function artifactsHome() {
	const home = (process.env.DSH_HOME ?? "").trim() !== "" ? path.resolve(process.env.DSH_HOME.trim()) : path.join(homedir(), ".dsh");
	return path.join(home, "artifacts");
}

/** engagement 短目录名：session-<uuid> → session-<前8位>；异常输入兜底原串清洗。 */
export function engagementDirName(sessionId) {
	const raw = String(sessionId ?? "");
	const m = /^session-([0-9a-f]{8})/i.exec(raw);
	if (m !== null) return `session-${m[1].toLowerCase()}`;
	const cleaned = raw.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 40);
	return cleaned !== "" ? cleaned : "unknown";
}

/** 某 engagement 的 artifacts 根目录（不创建）。 */
export function artifactsRoot(sessionId) {
	return path.join(artifactsHome(), engagementDirName(sessionId));
}

const SUBDIRS = ["js", "recon", "probe", "apks", "报告"];

/** 子目录说明表（README 生成用）。 */
export const SUBDIR_GUIDE = [
	["js/", "提取/下载的前端 JS、bundle（供逆向接口用）"],
	["recon/", "测绘导出、证书透明日志、子域清单、curl 输出"],
	["probe/", "一次性探测输出（半截文件、临时缓存）"],
	["apks/", "下载的 APK / 反编译产物"],
	["报告/", "报告类 md（副本/附件；报告本体走 buildReport）"]
];

/** 起手建齐五子夹 + README（幂等：已存在跳过不覆盖）。返回创建的目录数组（全已存在时返回空数组）。 */
export async function ensureArtifactsScaffold(sessionId, { target = "", goalId = "" } = {}) {
	const root = artifactsRoot(sessionId);
	const created = [];
	if (!existsSync(root)) {
		await mkdir(root, { recursive: true });
		created.push(root);
	}
	for (const sub of SUBDIRS) {
		const dir = path.join(root, sub);
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
			created.push(dir);
		}
	}
	const readme = path.join(root, "README.md");
	if (!existsSync(readme)) {
		const lines = [
			`# SRC engagement 产物目录`,
			"",
			`- 目标：${target || "（未记录）"}`,
			`- 会话：${sessionId}`,
			...(goalId !== "" ? [`- Goal：${goalId}`] : []),
			"",
			"## 目录",
			"",
			...SUBDIR_GUIDE.map(([dir, desc]) => `- \`${dir}\` ${desc}`),
			"",
			"结构化数据（facts/assets/findings/coverage/域笔记）在 src-sessions.db，本目录只放文件类产物。"
		];
		await writeFile(readme, lines.join("\n") + "\n", "utf8");
		created.push(readme);
	}
	return created;
}
