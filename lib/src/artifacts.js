/**
 * artifacts.js — [local.87] 文件类产物按 engagement 收敛的目录约定；
 * [local.89] 目录结构升级为「主域/会话」两级：artifacts/{主域}/{session-<前8位>}/。
 *
 * 背景：真实项目目录（Src-Pedestal-src-domain-ready）96→187 个条目乱放——按 host 散落的
 * 临时目录、根目录躺 app.js/req1.txt/下载 html、同名近名任务目录成对出现（同是 oppo 有
 * oppo_recon/recon_oppo/oppo-src-engagement/oppo-surface-scan/id_oppo_recon/oppo.com 六个夹）。
 * local.87 只按会话建夹，同目标多会话在 artifacts/ 下彼此无关、翻 Finder 看不出哪个夹挖的
 * 哪个域——用户拍板：按「主域 → 会话」两级建夹，同域 engagement 归拢一域文件夹。
 *
 * 约定目录（一个 engagement ≈ 一次会话目标）：
 *   $DSH_HOME/artifacts/{主域}/{dirName}/
 *     js/        提取/下载的前端 JS、bundle
 *     recon/     测绘导出、证书透明日志、子域清单、curl 输出
 *     probe/     一次性探测输出（半截文件、临时缓存）
 *     apks/      下载的 APK / 反编译产物
 *     报告/      报告类 md（报告本体走 buildReport，这里放副本/附件）
 *     README.md  起手自动生成：目标、会话 id、目录说明
 *
 * 主域来源：src_add_goal 起手传入 goal.target 的 eTLD+1 近似（取 host 最后两段；
 * 单段 host 原样）。同域不同会话共享同一主域夹，旧 local.87 扁平会话夹不再新建。
 *
 * 设计原则：给默认路径而非强制（散落都是因为现在没有默认）；零新表零工具名；
 * README 是文件不是上下文（不进状态预算）；DSH_HOME 惰性求值。
 */
import { mkdir, writeFile, rename } from "node:fs/promises";
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

/** [local.89] 主域夹名：goal.target host 的 eTLD+1 近似（最后两段；单段原样）。脏输入清洗。 */
export function targetDomainDir(target) {
	let host = String(target ?? "").trim().toLowerCase();
	try {
		if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname;
		else if (host.includes("/")) host = host.split("/")[0];
		host = host.replace(/:\d+$/, "").replace(/\.$/, "");
	} catch { /* 保持原串走清洗 */ }
	const cleaned = host.replace(/[^0-9a-z.-]/g, "");
	if (cleaned === "") return "unknown";
	const parts = cleaned.split(".").filter((p) => p !== "");
	if (parts.length <= 2) return cleaned;
	/* eTLD+1 近似：多级后缀（co.uk/com.cn 等）取最后三段。 */
	const twoLevelTld = /^(com|org|net|gov|edu|ac|co|or)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
	const keep = twoLevelTld ? 3 : 2;
	return parts.slice(-keep).join(".");
}

/** 某 engagement 的 artifacts 根目录（不创建）。 */
export function artifactsRoot(sessionId, { target = "" } = {}) {
	const domain = targetDomainDir(target);
	if (domain !== "unknown") return path.join(artifactsHome(), domain, engagementDirName(sessionId));
	/* 无 target（纯测试/异常路径）：回退旧的扁平会话夹，不炸。 */
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

/**
 * 起手建齐五子夹 + README（幂等：已存在跳过不覆盖）。返回创建的目录数组（全已存在时返回空数组）。
 * [local.89] 优先主域夹；检测到旧的扁平会话夹（artifacts/session-xxx）时整体迁移到主域夹下
 * （目录 rename，非空也安全；迁移失败不阻塞 goal）。
 */
export async function ensureArtifactsScaffold(sessionId, { target = "", goalId = "" } = {}) {
	const domain = targetDomainDir(target);
	const root = artifactsRoot(sessionId, { target });
	const created = [];
	/* [local.89] 旧扁平会话夹一次性迁移（仅当新主域夹尚不存在时）。 */
	if (domain !== "unknown") {
		const legacy = path.join(artifactsHome(), engagementDirName(sessionId));
		if (existsSync(legacy) && !existsSync(root)) {
			try {
				await mkdir(path.dirname(root), { recursive: true });
				await rename(legacy, root);
				created.push(`${legacy} → ${root}`);
			} catch { /* 迁移失败不阻塞：新旧各自存在，README 不覆盖 */ }
		}
	}
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
