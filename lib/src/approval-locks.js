// [local.60] 高危审批锁（approval bypass guard 的插件侧）。
// 纪律：src_http/src_run_capability 挂起的高危审批，挂起期间禁止经任何其他通道（Burp MCP 桥、curl 等）
// 绕行发送同目标请求——中通会话 approval-6 实测：子代理等不到批准直接用 Burp 直发补测，审批通道与实际执行脱节。
// 机制：插件在挂起时把 {id, method, url, host, path, category} 原子写入 ~/.dsh/storages/src-approval-locks.json，
// resolve（allow/reject 均算）时按 id 清除；burp-mcp-bridge.mjs 每次发送前读锁，host+path 命中即拒绝转发。
// 本模块零依赖（node:fs/promises + node:path）；损坏/缺失的锁文件一律视为空（fail-open：
// 锁只是纵深防御的一层，写锁失败不阻塞 src_http 主流程——审批行本身仍然落库）。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function approvalLocksPath(dshHome) {
	return path.join(dshHome, "storages", "src-approval-locks.json");
}

function normalizeEntry(entry) {
	return {
		id: String(entry?.id ?? ""),
		method: String(entry?.method ?? ""),
		url: String(entry?.url ?? ""),
		host: String(entry?.host ?? "").toLowerCase(),
		path: String(entry?.path ?? ""),
		category: String(entry?.category ?? ""),
		createdAt: Number(entry?.createdAt) || 0
	};
}

async function readLocks(dshHome) {
	try {
		const parsed = JSON.parse(await readFile(approvalLocksPath(dshHome), "utf8"));
		return Array.isArray(parsed) ? parsed.map(normalizeEntry).filter((entry) => entry.id !== "") : [];
	} catch {
		return [];
	}
}

async function writeLocks(dshHome, locks) {
	const file = approvalLocksPath(dshHome);
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(locks, null, 2), "utf8");
	await rename(tmp, file);
}

/** 挂起审批时加锁。url 非 http(s)（如 capability://id/script）只记账不解析 host/path——桥只比对 http(s) 锁。 */
export async function addApprovalLock(dshHome, entry) {
	const next = normalizeEntry(entry);
	if (next.id === "" || next.url === "") return;
	try {
		const u = new URL(next.url);
		if (u.protocol === "http:" || u.protocol === "https:") {
			next.host = u.hostname.toLowerCase();
			next.path = u.pathname;
		}
	} catch {}
	const locks = await readLocks(dshHome);
	if (locks.some((lock) => lock.id === next.id)) return;
	await writeLocks(dshHome, [...locks.filter((lock) => !(lock.url === next.url && lock.method === next.method)), next]);
}

/** 审批解决（allow 或 reject 都算）时清锁。id 不存在时安全 no-op。 */
export async function removeApprovalLock(dshHome, id) {
	const locks = await readLocks(dshHome);
	const next = locks.filter((lock) => lock.id !== String(id ?? ""));
	if (next.length !== locks.length) await writeLocks(dshHome, next);
}
