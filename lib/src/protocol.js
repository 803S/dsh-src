// Pure argument normalization and closed vocabularies shared by SRC tools.
// Keep this module free of runtime context, storage, and tool registration.

export function requiredString(value, name) {
	if (typeof value !== "string" || value === "") throw new Error(`src_submit requires ${name}`);
	return value;
}

/** Reject prompt variables before they are mistaken for a parent graph id. */
export function concreteIntentId(value) {
	const normalized = value.trim();
	if (/^(?:[<{[]\s*)?(?:delegation[-_])?intent[-_]?id(?:\s*[>}\]])?$/i.test(normalized)) throw new Error(`src_submit requires the concrete parent intent ID returned by src_add_intent; received placeholder ${JSON.stringify(value)}`);
	return normalized;
}

export function optionalString(value) {
	return typeof value === "string" ? value : "";
}

export function submissionList(value, name) {
	if (!Array.isArray(value) || !value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) throw new Error(`src_submit requires ${name} to be an array of objects`);
	return value;
}

export function stringList(value, name) {
	if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item !== "")) throw new Error(`src_submit ${name} must be a non-empty array of strings`);
	return value;
}

export function enumValue(value, allowed, fallback, name) {
	if (value === void 0) return fallback;
	if (typeof value === "string" && allowed.includes(value)) return value;
	throw new Error(`src_submit ${name} must be one of: ${allowed.join(", ")}`);
}

export function stableBatchKey(value) {
	return JSON.stringify(value, Object.keys(value).sort());
}

export function confidenceValue(value) {
	if (value === void 0) return .5;
	const text = typeof value === "string" ? value.trim() : void 0;
	const isPercent = text?.endsWith("%") === true;
	const parsed = typeof value === "number" ? value : text === void 0 || text === "" ? NaN : Number(isPercent ? text.slice(0, -1) : text);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error("src_submit confidence must be 0..1 or a percentage from 0 to 100");
	if (isPercent || parsed > 1) {
		if (parsed > 100) throw new Error("src_submit confidence must be 0..1 or a percentage from 0 to 100");
		return parsed / 100;
	}
	return parsed;
}

/** Completed generic card for the read-only projections. */
export function titledCard(title, result) {
	if (result.isError) return void 0;
	return { card: "generic", title, content: result.content };
}

export const FACT_KINDS = Object.freeze(["port", "service", "vuln", "finding", "http", "info"]);
export const SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);
export const ASSET_TYPES = Object.freeze([
	"root-domain", "subdomain", "ip", "service", "app", "endpoint", "mini-program", "client", "firmware", "ai-surface", "threat-intel"
]);
export const BYPASS_CATEGORIES = Object.freeze([
	"authentication-bypass", "authorization-bypass", "idor-bola", "tenant-isolation", "workflow-bypass", "method-bypass",
	"path-normalization", "parser-discrepancy", "rate-limit-bypass", "cache-auth-boundary", "waf-rule-gap", "oauth-flow-bypass"
]);
export const BYPASS_METHODS = Object.freeze(["GET", "HEAD", "OPTIONS", "POST"]);
