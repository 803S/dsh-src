// Pure safety classification for outbound SRC HTTP requests.
// No network, storage, runtime context, or tool registration belongs here.

const READ_PATH_WORDS = /^(query|get|list|detail|check|status|info|read|fetch|search|view|lookup|menu|config|option)$/i;
const DESTROY_PATH_WORDS = /^(close|cancel|remove|delete|unregister|drop|reset|destroy|purge|wipe|deactivate|terminate|offboard|disable|kick|logout|signout)$/i;
const SIDE_EFFECT_WORDS = /^(send|sms|verify|code|email|enroll|notify|login|register|password|resetpwd|captcha|otp)$/i;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Decide whether one real outbound request must be suspended for approval.
 * This classifier is deliberately conservative and performs no I/O.
 */
export function classifyHttpRequest({ method, path, headers, body, query }) {
	const m = String(method ?? "GET").toUpperCase();
	const pathStr = String(path ?? "");
	const headerMap = {};
	for (const [k, v] of Object.entries(headers ?? {})) headerMap[String(k).toLowerCase()] = String(v ?? "");
	const hasToken = headerMap.authorization !== void 0 || headerMap.cookie !== void 0 || headerMap["x-auth-token"] !== void 0 || /token/i.test(Object.keys(headers ?? {}).join(" "));
	const idSources = `${pathStr} ${query ?? ""} ${typeof body === "string" ? body : JSON.stringify(body ?? {})}`;
	const idMatches = [];
	for (const match of idSources.matchAll(/"?(\w*Id|userId|uid)"?[:=]\s*"?([0-9]{1,6})"?/gi)) idMatches.push(Number(match[2]));
	for (const hk of ["userid", "uid", "x-userid", "memberid"]) if (headerMap[hk] !== void 0 && /^\d{1,6}$/.test(headerMap[hk])) idMatches.push(Number(headerMap[hk]));
	const hasOtherId = idMatches.some((n) => Number.isFinite(n) && n > 0 && n <= 100);
	const tokens = pathStr.split(/[^a-zA-Z0-9]+/).flatMap((seg) => seg.split(/(?=[A-Z])/)).map((t) => t.toLowerCase()).filter((t) => t !== "");
	const destroy = tokens.some((t) => DESTROY_PATH_WORDS.test(t));
	const sideEffect = tokens.some((t) => SIDE_EFFECT_WORDS.test(t));
	const readPath = tokens.some((t) => READ_PATH_WORDS.test(t));
	const writeMethod = WRITE_METHODS.has(m);
	const destroyToken = tokens.find((t) => DESTROY_PATH_WORDS.test(t));
	if (destroy) return { require: true, category: "破坏性写入", reason: `path 含强删改语义词（${destroyToken}），即使方法为 ${m} 也按破坏性写入挂起审批。` };
	if (hasToken && writeMethod && hasOtherId) return { require: true, category: "越权删改", reason: `带认证头 + 写方法 ${m} + 资源 id 命中小整数枚举（${idMatches.filter((n) => n <= 100).join(",")}），疑似越权删改，挂起审批。`, victimIds: idMatches.filter((n) => n <= 100) };
	if (!hasToken && writeMethod && !readPath) return { require: true, category: "未授权删改", reason: `无认证头 + 写方法 ${m} + path 非读语义（信任接口命名规则），疑似未授权对真实目标写，挂起审批。增类接口（register/enroll）也会挂——为删改零漏代价，批准即可执行。` };
	return { require: false, category: "放行", reason: `${m} ${pathStr}：写=${writeMethod} token=${hasToken} 读语义=${readPath} 删改词=${destroy} 副作用词=${sideEffect}，未命中挂起判据。` };
}
