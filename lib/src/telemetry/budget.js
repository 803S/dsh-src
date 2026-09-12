// Telemetry event budgeting (optimization handbook Phase 1).
// Pure functions only: a telemetry row must stay bounded so the sink and any
// future aggregation never inflates context or disk unboundedly.

export const TELEMETRY_MAX_EVENT_BYTES = 4096;
export const TELEMETRY_MAX_STRING = 300;

function clampString(value, max = TELEMETRY_MAX_STRING) {
	const s = String(value);
	return s.length <= max ? s : s.slice(0, max) + "…[truncated]";
}

/** Deep-copy a payload with bounded strings and dropped functions/undefined. */
function budgetValue(value, depth = 0) {
	if (value === void 0 || typeof value === "function") return undefined;
	if (value === null || typeof value !== "object") return typeof value === "string" ? clampString(value) : value;
	if (depth > 4) return clampString(JSON.stringify(value));
	const out = Array.isArray(value) ? [] : {};
	for (const [key, item] of Object.entries(value)) {
		if (item === void 0) continue;
		out[key] = budgetValue(item, depth + 1);
	}
	return out;
}

/**
 * Normalize a telemetry row: bounded strings, bounded payload, stable size.
 * Returns the row as-is when within budget; otherwise progressively truncates
 * the payload and marks `truncated: true`. Always ≤ maxBytes when serialized.
 */
export function budgetEvent(row, maxBytes = TELEMETRY_MAX_EVENT_BYTES) {
	const bounded = { ...row, payload: budgetValue(row.payload ?? {}) };
	let json = JSON.stringify(bounded);
	if (json.length <= maxBytes) return bounded;
	bounded.payload = { truncated: true, head: clampString(json, maxBytes - 160) };
	json = JSON.stringify(bounded);
	if (json.length <= maxBytes) return bounded;
	/* 极端情况（超长 sessionId 等上下文字段）：硬截断整行。 */
	return { id: bounded.id, event: bounded.event, occurredAt: bounded.occurredAt, schemaVersion: 1, payload: { truncated: true, head: json.slice(0, maxBytes - 80) } };
}
