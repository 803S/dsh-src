// Shared execution context helpers for SRC tool groups.
// This module must stay dependency-free and import no tool group.

export function sessionIdOf(exec) {
	if (!exec.agent) throw new Error("src_* tools require an owning agent session");
	return exec.agent.session.id;
}

export function parentSessionIdOf(exec) {
	const parentSessionId = exec.agent?.session.header?.parentSession;
	if (parentSessionId === void 0 || parentSessionId === "") throw new Error("src_submit is only available to a delegated subagent with a parent session");
	return parentSessionId;
}

export function visibleSessionIds(ctx, exec) {
	const ids = [sessionIdOf(exec)];
	let header = exec.agent?.session?.header;
	for (let depth = 0; depth < 8; depth += 1) {
		const parent = header?.parentSession;
		if (parent === void 0 || parent === "" || ids.includes(parent)) break;
		ids.push(parent);
		header = ctx.sessions?.get?.(parent)?.header;
	}
	return ids;
}

export async function resolveEngagementSession(store, ctx, exec) {
	for (const id of visibleSessionIds(ctx, exec)) {
		if (await store.getGoal(id) !== void 0) return id;
	}
	return void 0;
}
