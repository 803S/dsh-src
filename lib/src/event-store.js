// §10 Store/事件/Projection 收敛（optimization handbook 2026-09-12 §10，local.77）。
// 事件落盘 + 幂等 + 新 reducer 双折叠校验。红线：不重写现有 projection（applySrcEvent 保持不变），
// 事件表只是 append-only 旁账；divergence 永不阻塞工具路径（telemetry 红线）。
// 本模块不 import lib/src.js（组合根），只依赖 flags + 自身纯函数。
import { randomUUID } from "node:crypto";
import { srcEventStoreFlag } from "./flags.js";

/** §10.1 步骤 2 事件幂等键：aggregateId:aggregateVersion:eventType。 */
export function srcEventKey(aggregateId, aggregateVersion, eventType) {
	return `${aggregateId}:${aggregateVersion}:${eventType}`;
}

/**
 * [§10.2] 纯 reducer：同一事件序列重复 fold 得到相同结果（不做 IO、不读时钟、
 * 不依赖 Map 迭代顺序以外的可变全局）。与 applySrcEvent（现有 projection，红线不动）平行：
 * 本 reducer 只覆盖事件落盘所需的领域动作，输出「新投影快照」供双折叠校验比对。
 * state 形状：{ intents, facts, findings, checkpoints, approvals, edges, ids }（键均为 Map）。
 */
export function createEmptyReducerState() {
	return { intents: new Map(), facts: new Map(), findings: new Map(), checkpoints: new Map(), approvals: new Map(), edges: new Map(), seenEventKeys: new Map() };
}

/** [§10.2] 重放遇已有 eventId 返 duplicate，不再次追加。返回 { state, duplicate }。 */
export function foldSrcEvent(state, event) {
	const key = srcEventKey(event.aggregateId, event.aggregateVersion, event.eventType);
	if (state.seenEventKeys.has(key)) return { state, duplicate: true };
	const next = { intents: new Map(state.intents), facts: new Map(state.facts), findings: new Map(state.findings), checkpoints: new Map(state.checkpoints), approvals: new Map(state.approvals), edges: new Map(state.edges), seenEventKeys: new Map(state.seenEventKeys) };
	next.seenEventKeys.set(key, event.eventId);
	const put = (map, row) => map.set(row.id, row);
	switch (event.eventType) {
		case "intent.upserted": put(next.intents, event.payload); break;
		case "fact.appended": put(next.facts, event.payload); break;
		case "finding.upserted": put(next.findings, event.payload); break;
		case "checkpoint.appended": put(next.checkpoints, event.payload); break;
		case "approval.resolved": put(next.approvals, event.payload); break;
		case "edge.appended": put(next.edges, event.payload); break;
		/* 未知事件类型：幂等登记但不动领域状态（前向兼容，旧 reducer 读新事件不炸）。 */
		default: break;
	}
	return { state: next, duplicate: false };
}

/** [§10.2] 全序列重放。 */
export function replaySrcEvents(state, events) {
	let duplicates = 0;
	for (const event of events) {
		const r = foldSrcEvent(state, event);
		if (r.duplicate) duplicates += 1;
		state = r.state;
	}
	return { state, duplicates };
}

/** [§10.2] 同一事件序列重复 fold 得到相同 hash（FNV-1a over 稳定序列化）。 */
export function reducerStateHash(state) {
	const stable = (rows) => [...rows.keys()].sort().map((k) => JSON.stringify(rows.get(k))).join("|");
	const text = [state.intents, state.facts, state.findings, state.checkpoints, state.approvals, state.edges].map(stable).join("§");
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
	return h.toString(16);
}

/**
 * [§10.1 步骤 3 正式版] 五条一致性断言（§10.3），全部纯函数、供测试与 src_state 观测点共用：
 * 返回 divergence 行数组（空数组=一致）。
 */
export function assertStoreProjectionConsistency(storeRows, projectionRows) {
	const problems = [];
	/* §10.3-① store 中存在的 active finding 必须在 projection 中存在。 */
	const projFindings = new Set((projectionRows.findings ?? []).map((r) => r.id));
	for (const f of storeRows.findings ?? []) {
		if ((f.status ?? "active") === "active" && !projFindings.has(f.id)) problems.push({ rule: "active-finding-in-projection", detail: `${f.id} active in store but missing from projection` });
	}
	/* §10.3-② pending approval 必须出现在 blockedReasons。 */
	const blocked = new Set((projectionRows.blockedReasons ?? []));
	for (const a of storeRows.pendingApprovals ?? []) {
		if (a.status === "pending" && ![...blocked].some((b) => typeof b === "string" && b.includes(a.id))) problems.push({ rule: "pending-approval-in-blockedReasons", detail: `${a.id} pending but not in blockedReasons` });
	}
	/* §10.3-③ completed intent 必须有 completed checkpoint（系统迁移产生的除外）。 */
	const doneCheckpoints = new Set((storeRows.checkpoints ?? []).filter((c) => c.stage === "completed").map((c) => c.intentId));
	for (const i of storeRows.intents ?? []) {
		if (i.status === "completed" && !doneCheckpoints.has(i.id) && i.systemMigration !== true) problems.push({ rule: "completed-intent-has-completed-checkpoint", detail: `${i.id} completed without completed checkpoint` });
	}
	/* §10.3-④ evidence link 的 source/target 必须属于同一 engagement（跨会话须显式边界标记）。 */
	for (const link of projectionRows.evidenceLinks ?? []) {
		const src = (storeRows.allRows ?? []).find((r) => r.id === link.sourceId);
		const tgt = (storeRows.allRows ?? []).find((r) => r.id === link.targetId);
		if (src !== void 0 && tgt !== void 0 && src.sessionId !== tgt.sessionId && link.crossSession !== true) problems.push({ rule: "evidence-link-same-engagement", detail: `${link.sourceId}→${link.targetId} crosses sessions without crossSession marker` });
	}
	/* §10.3-⑤ projection 不得生成 store 不存在的 id。 */
	const storeIds = new Set((storeRows.allRows ?? []).map((r) => r.id));
	for (const row of projectionRows.allRows ?? []) {
		if (!storeIds.has(row.id)) problems.push({ rule: "projection-id-exists-in-store", detail: `${row.id} in projection but not in store` });
	}
	return problems;
}

/**
 * [§10.1 步骤 1+2] 事件记录器：领域写入先 append 事件（幂等键去重），再由既有路径更新快照。
 * flag=off 时 appendEvent 是 no-op（零新增表写入，行为与当前完全一致）。
 * flag=shadow|on 时 append；on 模式另跑双折叠（shadow 只落事件不校验）。
 */
export function createSrcEventRecorder(domainPromise, { flag = srcEventStoreFlag, clock = { now: () => Date.now() }, randomId = randomUUID } = {}) {
	const enabled = typeof flag === "function" ? flag : () => flag;
	return {
		/** 先 append 后快照的唯一入口。幂等：同 (aggregateId, aggregateVersion, eventType) 只落一次。 */
		async appendEvent(domainOrPromise, { aggregateId, aggregateVersion, eventType, payload }) {
			if (enabled() === "off") return { appended: false, duplicate: false };
			const domain = await domainOrPromise;
			const table = domain.table("src_events");
			const key = srcEventKey(aggregateId, aggregateVersion, eventType);
			if (table.get(key) !== void 0) return { appended: false, duplicate: true };
			/* sessionId：payload 内（领域记录自带）。 */
			await table.put(key, { eventId: randomId(), aggregateId, aggregateVersion, eventType, payload, createdAt: clock.now() });
			return { appended: true, duplicate: false };
		},
		/** 读全序列（按 createdAt 再按 eventId 稳定排序）。 */
		async readAll(domainOrPromise) {
			const domain = await domainOrPromise;
			return [...domain.table("src_events").entries()].map(([, row]) => row).sort((a, b) => (a.createdAt - b.createdAt) || String(a.eventId).localeCompare(String(b.eventId)));
		},
		/** [§10.1 步骤 3] 双折叠：全序列重放两遍 → hash 相等断言；返回 { hash1, hash2, duplicates }。 */
		async doubleFold(domainOrPromise) {
			const events = await this.readAll(domainOrPromise);
			const first = replaySrcEvents(createEmptyReducerState(), events);
			const second = replaySrcEvents(createEmptyReducerState(), events);
			return { hash1: reducerStateHash(first.state), hash2: reducerStateHash(second.state), duplicates: first.duplicates, identical: reducerStateHash(first.state) === reducerStateHash(second.state) };
		}
	};
}

/** [§10.2] store 已天然返回 { value, events } 的约定校验器（mutations.js 约定的守护）。 */
export function assertMutationResult(result, label) {
	if (result !== void 0 && (typeof result !== "object" || (!("value" in result) && !("nodeId" in result) && !("duplicate" in result) && !("updated" in result) && !Array.isArray(result?.events) && result?.id === void 0))) {
		throw new TypeError(`${label}: mutation result does not follow the { value, events } / record convention`);
	}
}
