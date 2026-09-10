import { promises as fsPromises } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

/** Built-in methodology ships with the plugin; distilled lessons live outside deployments. */
const LESSONS_BUILTIN_DIR = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "..", "preset", "src-hunter", "lessons");
export const lessonsDataDir = () => (process.env.DSH_SRC_LESSONS_DIR ?? "") !== "" ? process.env.DSH_SRC_LESSONS_DIR : nodePath.join(nodeOs.homedir(), ".dsh", "storages", "src-lessons");

async function listLessonDir(dir) {
	let names;
	try { names = await fsPromises.readdir(dir); } catch { return []; }
	const out = [];
	for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
		const full = nodePath.join(dir, name);
		try {
			const stat = await fsPromises.stat(full);
			const head = await fsPromises.readFile(full, "utf8");
			const titleMatch = /^#\s+(.+)$/m.exec(head);
			out.push({ file: name.replace(/\.md$/, ""), title: titleMatch?.[1]?.trim() ?? name, dir, mtime: stat.mtimeMs });
		} catch {}
	}
	return out;
}

export async function listAllLessons() {
	const builtin = await listLessonDir(LESSONS_BUILTIN_DIR);
	const distilled = await listLessonDir(lessonsDataDir());
	const bySlug = new Map();
	for (const row of builtin) bySlug.set(row.file, { ...row, source: "builtin" });
	for (const row of distilled) bySlug.set(row.file, { ...row, source: "distilled", overrides: bySlug.has(row.file) });
	return [...bySlug.values()];
}

export async function lessonIndexLines() {
	const rows = await listAllLessons();
	if (rows.length === 0) return [];
	return rows.map((row) => `- ${row.title}（src_read_lesson id=${JSON.stringify(row.file)}${row.source === "distilled" ? "，沉淀" : ""}${row.overrides === true ? "，覆盖内置" : ""}）`);
}

export async function readLessonFile(slug) {
	const safe = nodePath.basename(String(slug ?? ""));
	if (safe === "" || safe === ".") throw new Error("lesson id 非法（不含路径分隔符）");
	for (const dir of [lessonsDataDir(), LESSONS_BUILTIN_DIR]) {
		try { return { text: await fsPromises.readFile(nodePath.join(dir, `${safe}.md`), "utf8"), source: dir === lessonsDataDir() ? "distilled" : "builtin" }; } catch {}
	}
	throw new Error(`找不到经验文件 ${safe}；用 src_search_lessons 查看现有列表`);
}

const LESSON_META_RE = /^<!--\s*lesson-meta:\s*(\{.*?\})\s*-->$/m;
function parseLessonMeta(text) {
	try { const match = LESSON_META_RE.exec(text); return match === null ? {} : JSON.parse(match[1]); } catch { return {}; }
}

export async function sessionLessons(sessionId) {
	const rows = await listLessonDir(lessonsDataDir());
	const out = [];
	for (const row of rows) {
		try {
			const text = await fsPromises.readFile(nodePath.join(row.dir, `${row.file}.md`), "utf8");
			const meta = parseLessonMeta(text);
			if (meta.sessionId === sessionId) out.push({ file: row.file, title: row.title, vulnType: String(meta.vulnType ?? ""), createdAt: Number(meta.createdAt ?? row.mtime) });
		} catch {}
	}
	return out.sort((a, b) => b.createdAt - a.createdAt);
}

/* [local.62] 决策点注入：经验文件在 lesson-meta 里声明结构化触发器（tools/keywords/categories，
 * 命中即 OR），工具执行时代码机械匹配并推送提示行——经验复用从「模型自觉去搜」（pull）升级为
 * 「命中即推送」（push），与能力触发器同一编排思想。没有 triggers 元数据的经验不参与匹配。 */
export async function lessonsForContext(ctx = {}) {
	const tool = typeof ctx.tool === "string" ? ctx.tool : "";
	const hay = `${typeof ctx.category === "string" ? ctx.category : ""} ${typeof ctx.text === "string" ? ctx.text : ""}`.trim().toLowerCase();
	if (tool === "" && hay === "") return [];
	const hits = [];
	for (const row of await listAllLessons()) {
		try {
			const text = await fsPromises.readFile(nodePath.join(row.dir, `${row.file}.md`), "utf8");
			const meta = parseLessonMeta(text);
			const t = meta.triggers;
			if (t === null || typeof t !== "object") continue;
			const matchedOn = [];
			if (tool !== "" && Array.isArray(t.tools) && t.tools.includes(tool)) matchedOn.push(`tool=${tool}`);
			if (hay !== "") {
				for (const kw of [...(Array.isArray(t.keywords) ? t.keywords : []), ...(Array.isArray(t.categories) ? t.categories : [])]) {
					if (typeof kw === "string" && kw !== "" && hay.includes(kw.toLowerCase())) { matchedOn.push(`命中「${kw}」`); break; }
				}
			}
			if (matchedOn.length > 0) hits.push({ file: row.file, title: row.title, source: row.source, hook: typeof meta.hook === "string" && meta.hook !== "" ? meta.hook : void 0, reason: matchedOn.join("+") });
			if (hits.length >= 3) return hits;
		} catch {}
	}
	return hits;
}

export function lessonHintLines(hits) {
	if (!Array.isArray(hits) || hits.length === 0) return [];
	return hits.map((h) => {
		/* [local.68 #2/#16] 打法钩子：有 hook 的经验推送一句话打法而非能力名（牌面送达 0 调用即反例）；
		 * id+reason 结构保持不变，沉淀经验（无 hook）仍走原格式。 */
		const head = typeof h.hook === "string" && h.hook !== "" ? `【打法钩子】${h.hook}` : `【经验库命中】${h.title}`;
		return `${head}（src_read_lesson id=${JSON.stringify(h.file)}${h.source === "distilled" ? "，沉淀" : ""}；${h.reason}）——先读全文再定方案，别凭记忆重走弯路`;
	});
}
