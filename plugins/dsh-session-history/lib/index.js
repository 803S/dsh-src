// session-history (host half): a private loopback RPC channel that deletes
// persisted session directories. The browser sends the exact session ids it
// wants gone (its own history rows minus the current/running sessions); this
// side re-validates every id against the safe path-segment grammar, scans the
// `<DSH_HOME>/sessions` project layout for matching `session-<id>` dirs,
// refuses live host sessions, and removes the directories.

import { readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const name = "session-history";
const inject = ["connection"];

/** Persisted session ids are `session-<segment>`; safe path chars survive encoding unchanged. */
const SESSION_ID_RE = /^session-[A-Za-z0-9._-]+$/;

/** Sessions root: `<DSH_HOME>/sessions`, resolved the same way the persistence backend does. */
function sessionsRoot() {
	const home = process.env.DSH_HOME !== void 0 && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "sessions");
}

/**
 * Delete persisted session directories for the requested ids.
 * @returns { deleted, evicted, refused, agentStatus }
 */
async function deletePersistedSessions(ctx, ids, signal) {
	const requested = new Set(ids.filter((id) => typeof id === "string" && SESSION_ID_RE.test(id)));
	if (requested.size === 0) return { deleted: [], evicted: [], refused: [], agentStatus: {} };
	const root = resolve(sessionsRoot());
	const agents = ctx.get("agents");
	const prefix = root.endsWith(sep) ? root : root + sep;
	let projects = [];
	try {
		projects = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return { deleted: [], evicted: [], refused: [], agentStatus: {} };
	}
	const deleted = [];
	const evicted = [];
	const refused = [];
	const agentStatus = {};
	// 磁盘上实际存在的会话 id（避免重复处理同一个幽灵）。
	const seen = /* @__PURE__ */ new Set();
	for (const project of projects) {
		if (signal?.aborted === true) break;
		const projectPath = join(root, project);
		let names = [];
		try {
			names = (await readdir(projectPath, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const id of names) {
			if (!requested.has(id) || seen.has(id)) continue;
			seen.add(id);
			const agent = agents?.get(id);
			agentStatus[id] = agent === void 0 ? "no-agent" : agent.status;
			// Only a RUNNING agent is protected: an idle agent (session finished
			// its turn) is torn down and deleted. This is what makes deleting a
			// freshly created or just-finished session work — those keep a live
			// but idle agent in memory.
			if (agent !== void 0 && agent.status === "running") {
				refused.push(id);
				continue;
			}
			const dir = resolve(projectPath, id);
			if (!dir.startsWith(prefix)) continue;
			// 1. Tear down the idle agent (removes it from the agent registry and
			//    emits agent/disposed so the loop's cleanup runs).
			const agentEvicted = await evictLiveAgent(ctx, id);
			// 2. Evict the session from the host live store. Its disposal drains
			//    pending writes (flush) into the still-present directory, so the
			//    retire path has a valid target and cannot resurrect the session
			//    by recreating its folder after we delete it.
			const sessionEvicted = await evictLiveSession(ctx, id);
			// 3. Now remove the persisted directory.
			await rm(dir, { recursive: true, force: true });
			// 4. Clear the archived marker if set. We deliberately do NOT detach
			//    the session from any workspace's sessionIds: a deleted session
			//    must disappear everywhere, and touching workspace accounting
			//    while the session might still be listed would reclassify it as
			//    an "ungrouped" orphan.
			await clearArchivedMarker(ctx, id);
			deleted.push(id);
			if (agentEvicted || sessionEvicted) evicted.push(id);
		}
	}
	// 幽灵会话：请求删除但磁盘上已无目录（目录之前被删过或从未落盘）。
	// 直接清掉归档标记并拆除任何残留的内存状态，使其从列表彻底消失。
	for (const id of requested) {
		if (signal?.aborted === true) break;
		if (seen.has(id)) continue;
		const agent = agents?.get(id);
		agentStatus[id] = agent === void 0 ? "no-agent" : agent.status;
		if (agent !== void 0 && agent.status === "running") {
			refused.push(id);
			continue;
		}
		await evictLiveAgent(ctx, id);
		await evictLiveSession(ctx, id);
		await clearArchivedMarker(ctx, id);
		deleted.push(id);
	}
	return { deleted, evicted, refused, agentStatus };
}

/**
 * Remove one idle agent from the host agent registry via the registry's public
 * single-entry disposer. Emits agent/disposed (the agent-loop's listener then
 * runs its normal teardown) and drops the registry entry so the agent no
 * longer counts as live.
 * @returns true when the agent entry was evicted.
 */
async function evictLiveAgent(ctx, sessionId) {
	const agents = ctx.get("agents");
	if (agents === void 0) return false;
	try {
		const entry = agents.store?.get(sessionId);
		if (entry === void 0) return false;
		if (entry.agent?.status === "running") return false;
		agents.detachEntered(entry);
		return true;
	} catch (error) {
		ctx.logger?.warn?.(`session-history: live agent eviction failed for ${sessionId}: ${String(error)}`);
		return false;
	}
}

/**
 * Remove one idle session from the host live session store so it stops
 * appearing in session.list. The store's single-shot entry disposer removes
 * the entry and emits session/disposed, which the persistence layer observes
 * to retire (flush + release) the session against the still-present directory.
 * Sessions with a running agent are refused by the caller before this runs.
 * @returns true when the session entry was evicted.
 */
async function evictLiveSession(ctx, sessionId) {
	const sessions = ctx.get("sessions");
	const agents = ctx.get("agents");
	if (sessions === void 0) return false;
	try {
		const entry = sessions.store?.get(sessionId);
		// Double-guard: never evict a session whose agent is still running.
		if (entry === void 0 || agents?.get(sessionId)?.status === "running") return false;
		entry.detach();
		// Give the dispose/retire path a tick to start its flush against the
		// existing directory before we delete it (flush is fire-and-forget).
		await sleep(150);
		return true;
	} catch (error) {
		ctx.logger?.warn?.(`session-history: live store eviction failed for ${sessionId}: ${String(error)}`);
		return false;
	}
}

/**
 * Clear the archived marker for a deleted session, if any. This is the ONLY
 * workspace accounting change a delete makes — the session's membership in
 * workspace sessionIds is deliberately left untouched so the session can
 * never be reclassified as "ungrouped" while it is being removed.
 */
async function clearArchivedMarker(ctx, sessionId) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === void 0) return;
	try {
		if (registry.archivedSessionIds.includes(sessionId)) await registry.unarchiveSession(sessionId);
	} catch (error) {
		// Best-effort: the directory is already gone; a failing registry write
		// must not fail the delete report.
		ctx.logger?.warn?.(`session-history: archived marker cleanup failed for ${sessionId}: ${String(error)}`);
	}
}

/** Register the browser RPC channel. Without the host connection service (headless/TUI) the UI half simply has no delete path. */
function apply(ctx) {
	const connection = ctx.get("connection");
	if (connection === void 0) return;
	connection.rpc.handle("/session-history", async (endpoint, payload, signal) => {
		try {
			if (endpoint !== "delete-all") throw new Error(`unknown endpoint "${endpoint}"`);
			const sessionIds = Array.isArray(payload?.sessionIds) ? payload.sessionIds : [];
			const result = await deletePersistedSessions(ctx, sessionIds, signal);
			return { ok: true, value: result };
		} catch (error) {
			return {
				ok: false,
				error: {
					code: "internal",
					message: error instanceof Error ? error.message : String(error),
					details: {}
				}
			};
		}
	}, { authority: "loopback" });
}

export default { name, inject, apply };
export { name, inject, apply };