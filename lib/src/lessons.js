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
