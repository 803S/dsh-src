// Extract a bounded, model-friendly index from an OpenAPI/Swagger document.
// The full document stays out of model context; endpoint assets/facts remain the durable source.
const METHODS = new Set(["get", "head", "post", "put", "patch", "delete", "options", "trace"]);

function stringValue(value, max = 160) {
	return typeof value === "string" ? value.slice(0, max) : "";
}

export function extractOpenApiIndex(raw, { maxPaths = 500, maxParameters = 800 } = {}) {
	let document;
	try { document = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return { valid: false, format: "unknown", title: "", version: "", paths: [], parameters: [], tags: [] }; }
	if (document === null || typeof document !== "object" || Array.isArray(document) || document.paths === null || typeof document.paths !== "object") {
		return { valid: false, format: "unknown", title: "", version: "", paths: [], parameters: [], tags: [] };
	}
	const format = typeof document.openapi === "string" ? "openapi" : typeof document.swagger === "string" ? "swagger" : "unknown";
	const paths = [];
	const parameters = new Set();
	const tags = new Set();
	for (const [path, item] of Object.entries(document.paths)) {
		if (paths.length >= maxPaths || typeof path !== "string" || !path.startsWith("/")) continue;
		const methods = [];
		const operationIds = [];
		const pathParameters = [];
		if (item && typeof item === "object") {
			for (const [method, operation] of Object.entries(item)) {
				if (!METHODS.has(method.toLowerCase())) continue;
				methods.push(method.toUpperCase());
				if (operation && typeof operation === "object") {
					const operationId = stringValue(operation.operationId, 120);
					if (operationId) operationIds.push(operationId);
					if (Array.isArray(operation.tags)) for (const tag of operation.tags) if (typeof tag === "string" && tag.length < 100) tags.add(tag);
					if (Array.isArray(operation.parameters)) for (const parameter of operation.parameters) {
						const name = stringValue(parameter?.name, 100);
						if (name) { pathParameters.push(name); if (parameters.size < maxParameters) parameters.add(name); }
					}
				}
			}
		}
		paths.push({ path: path.slice(0, 500), methods: [...new Set(methods)].slice(0, 12), operationIds: [...new Set(operationIds)].slice(0, 8), parameters: [...new Set(pathParameters)].slice(0, 20) });
	}
	return {
		valid: format !== "unknown",
		format,
		title: stringValue(document.info?.title, 200),
		version: stringValue(document.info?.version, 80),
		paths,
		parameters: [...parameters],
		tags: [...tags].slice(0, 100)
	};
}

export function renderOpenApiIndex(index) {
	if (!index?.valid) return "";
	const head = `OpenAPI ${index.format}${index.title ? ` ${index.title}` : ""}${index.version ? ` v${index.version}` : ""}：${index.paths.length} 条路径`;
	const rows = index.paths.slice(0, 120).map((row) => `- ${row.methods.join(",") || "?"} ${row.path}${row.operationIds.length ? ` [${row.operationIds.join(",")}]` : ""}${row.parameters.length ? ` params=${row.parameters.join(",")}` : ""}`);
	return [head, ...rows, index.paths.length > 120 ? `（其余 ${index.paths.length - 120} 条路径已省略，继续按 endpoint asset/coverage 逐项验证）` : ""].filter(Boolean).join("\n");
}
