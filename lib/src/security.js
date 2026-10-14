// Pure safety classification for outbound SRC HTTP requests.
// No network, storage, runtime context, or tool registration belongs here.
//
// 分工（2026-10-14 用户指令「先是规则挂卡，然后命中的 jev 决策……决策无危害则自动放行」）：
// 本地规则只做两件确定性判断，判不准的一律向上转交，绝不就地挂卡：
//   ① hard-boundary   确定危害 —— 终审挂人工，Jev 无权覆盖（DELETE、强删改语义词、请求方法改写头）
//   ② read-clear      明确只读 —— 读方法且无任何可疑语义词：直接放行，不调用 Jev（零远程延迟、
//                     不受判定服务可用性影响）
//   ③ needs-judgement 其余 —— 写方法，或读方法命中可疑语义词：交 Jev 判语义。
//                      低风险正常测试（read/compute/auth/新建测试对象）自动放行；
//                      写业务数据/他人对象/真实外发/破坏，以及判不了（unknown、返回不合法、
//                      服务不可用）→ 挂人工审批。
// 词表只用于「确定危害」的拒绝与「明确只读」的放行，不再充当语义近似表去否决（R5）。
// 请求体全文交 Jev 阅读；本地不按 body 散文猜语义（避免把搜索关键词里的 "delete" 当删库）。

const READ_PATH_WORDS = /^(query|get|list|detail|check|status|info|read|fetch|search|view|lookup|menu|config|option)$/i;
// 强删改动词：命中即硬边界，无论 HTTP 方法（GET /deleteUser 同样是删库请求）。
const CORE_DESTROY_WORDS = new Set(["delete", "del", "remove", "drop", "truncate", "purge", "wipe", "destroy", "erase", "reset", "unregister", "deregister", "cancel", "close"]);
// 可疑语义词：读方法命中即不再豁免（转交 Jev 判定）；写方法本来就要判。
// 三类来源 —— 状态变更动作、认证/校验动作、主动外发/费用类动作。
// [2026-10-14 现场修正] 剔除「静态路径里常见、但不含动作语义」的名词（share/upload/import/sync/enroll）：
// 现场 32 张卡里的 /Public/share/img/logo.png、/Upload/ 全由这类名词触发，判定服务一抖就变成
// 一堆无意义待办。真正带副作用的动作词（create/update/delete/send/verify/lock…）一个不动。
const SUSPICIOUS_WORDS = new Set([
	"deactivate", "terminate", "offboard", "kick", "disable", "enable", "logout", "signout", "revoke", "suspend", "lock", "unlock",
	"verify", "confirm", "activate", "unsubscribe", "bind", "unbind", "approve", "submit", "create", "update", "edit", "modify", "save", "generate",
	"send", "sendsms", "sms", "mms", "mail", "email", "webhook", "notify", "notification", "callback", "invite", "subscribe", "recharge", "withdraw", "pay", "payment", "prepay", "purchase", "transfer", "refund", "publish", "push", "broadcast",
]);
// 静态资源扩展名快速通道：读方法 + 末段路径是静态文件扩展名 + 查询串没有任何可疑/强删改词
// → 明确只读（静态资源没有副作用）。避免把目录名/文件名里的名词拿来当语义证据（R5）。
const STATIC_ASSET = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|eot|otf|json|txt|xml|csv|pdf|lock|md|html?)$/i;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// 请求方法覆写/转发头会改变实际执行的方法与来源，属确定危害（x-forwarded-for / x-real-ip 是常规代理头，排除）。
const METHOD_OVERRIDE_HEADER = /method|rewrite|forward|original/i;
const LEGIT_PROXY_HEADER = /^(?:x-forwarded-for|x-real-ip)$/i;
// 常规代理头的值只允许 IP/端口列表（含 ::1、IPv6、逗号分隔链）；值里出现主机名、`host=`、`;` 等路由语法
// 视为改写/来源伪造，按确定危害处理。
const IP_LIST_VALUE = /^[\s0-9a-f:.,\[\]]+$/i;
// 残留转义：解码到最后一层仍留 %xx（≥5 层嵌套）说明本地看不到真实路径，交判定服务而不是本地豁免。
const ESCAPE_SEQUENCE = /%[0-9a-fA-F]{2}/;

const tokensOf = (value) => String(value ?? "").split(/[^a-zA-Z0-9]+/).flatMap((seg) => seg.split(/(?=[A-Z])/)).map((t) => t.toLowerCase()).filter((t) => t !== "");
// 编码层：HTTP 栈会解码一次，服务器可能再解一次；扫原始 + 逐层解码后的 token，
// 避免 /%64elete 这类编码绕过。`malformed` 只在第一层就解码失败时置位（如裸 `%`、`info=1%`）。
function decodeLayers(value) {
	const raw = String(value ?? "");
	const layers = [raw];
	let current = raw;
	for (let i = 0; i < 4; i++) {
		let next;
		try { next = decodeURIComponent(current); } catch { return { layers, malformed: i === 0 }; }
		if (next === current) break;
		layers.push(next);
		current = next;
	}
	return { layers, malformed: false };
}

/**
 * Decide the local verdict for one real outbound request (no I/O).
 * @returns {{verdict:'hard-boundary'|'read-clear'|'needs-judgement', hardBoundary:boolean, delegate:boolean,
 *            require:boolean, category:string, reason:string, victimIds?:number[]}}
 * `require` 保留旧语义 = 「本地规则要求人工审批」，仅供判定服务未启用（mode!=="on"）时沿用；
 * 判定服务启用时只看 `hardBoundary`（终审挂起）与 `verdict`（read-clear 直接放行 / needs-judgement 交 Jev）。
 */
export function classifyHttpRequest({ method, path, headers, body, query }) {
	const m = String(method ?? "GET").toUpperCase();
	const pathStr = String(path ?? "");
	const queryStr = String(query ?? "");
	const headerMap = {};
	for (const [k, v] of Object.entries(headers ?? {})) headerMap[String(k).toLowerCase()] = String(v ?? "");
	const hasToken = Object.keys(headerMap).some((key) => /^(?:authorization|cookie|x-auth-token|api[-_]?key|x-api[-_]?key)$/i.test(key) || /token/i.test(key));
	const overrideHeader = Object.keys(headerMap).find((key) => METHOD_OVERRIDE_HEADER.test(key) && !(LEGIT_PROXY_HEADER.test(key) && IP_LIST_VALUE.test(headerMap[key])));
	const idSources = `${pathStr} ${queryStr} ${typeof body === "string" ? body : JSON.stringify(body ?? {})}`;
	const idMatches = [];
	for (const match of idSources.matchAll(/"?(userId|uid|memberId|recordId|accountId|orderId|resourceId)"?\s*[:=]\s*"?([0-9]{1,6})"?/gi)) idMatches.push(Number(match[2]));
	for (const hk of ["userid", "uid", "x-userid", "memberid"]) if (headerMap[hk] !== void 0 && /^\d{1,6}$/.test(headerMap[hk])) idMatches.push(Number(headerMap[hk]));
	const hasOtherId = idMatches.some((n) => Number.isFinite(n) && n > 0 && n <= 100);
	const victimIds = idMatches.filter((n) => n <= 100);
	// 扫 path + query（原始与逐层解码后）：query 属于资源标识的一部分，代价低、误报少；
	// body 散文不作本地语义证据（交 Jev 读全文）。
	const pathLayers = decodeLayers(pathStr), queryLayers = decodeLayers(queryStr);
	const lastLayer = (layers) => layers.layers[layers.layers.length - 1];
	const encodedAmbiguity = pathLayers.malformed || queryLayers.malformed || ESCAPE_SEQUENCE.test(lastLayer(pathLayers)) || ESCAPE_SEQUENCE.test(lastLayer(queryLayers));
	const tokens = [...new Set([...pathLayers.layers.flatMap(tokensOf), ...queryLayers.layers.flatMap(tokensOf)])];
	// 查询串单独取一遍：静态资源快速通道只在「查询串干净」时成立（?op=verify 仍须交判定服务）。
	const queryTokens = [...new Set(queryLayers.layers.flatMap(tokensOf))];
	const destroyToken = tokens.find((t) => CORE_DESTROY_WORDS.has(t));
	const suspiciousToken = tokens.find((t) => SUSPICIOUS_WORDS.has(t));
	const readPath = tokens.some((t) => READ_PATH_WORDS.test(t));
	const writeMethod = WRITE_METHODS.has(m);
	const readMethod = READ_METHODS.has(m);
	const staticAsset = STATIC_ASSET.test(lastLayer(pathLayers)) && !queryTokens.some((t) => SUSPICIOUS_WORDS.has(t) || CORE_DESTROY_WORDS.has(t));
	// ① 确定危害：终审，不允许判定服务覆盖。
	if (overrideHeader) return { verdict: "hard-boundary", hardBoundary: true, delegate: false, require: true, category: "请求方法改写", reason: `请求头 ${overrideHeader} 会改写实际执行的请求方法/来源，属确定危害，挂起审批（终审，判定服务无权覆盖）。` };
	if (destroyToken) return { verdict: "hard-boundary", hardBoundary: true, delegate: false, require: true, category: "破坏性写入", reason: `path/query 含强删改语义词（${destroyToken}），即使方法为 ${m} 也按确定危害挂起审批（终审，判定服务无权覆盖）。` };
	if (m === "DELETE") return { verdict: "hard-boundary", hardBoundary: true, delegate: false, require: true, category: "删除操作需人工确认", reason: `HTTP DELETE 属确定危害，挂起审批（终审，判定服务无权覆盖）。` };
	// ② 明确只读：读方法且 path/query（含解码后）无删改、状态变更、认证校验、外发语义词 —— 直接放行，
	// 不调用判定服务。静态资源（图片/脚本/字体/清单文件）按扩展名快速放行，不再因为目录名里的
	// 名词（share/upload…）而多送一次判定。编码解码失败（裸 %）不豁免：这种歧义交判定服务，而不是本地猜。
	if (readMethod && !suspiciousToken && !encodedAmbiguity) return { verdict: "read-clear", hardBoundary: false, delegate: false, require: false, category: "放行", reason: `${m} ${pathStr}：读方法且 path/query 无删改/状态变更/认证校验/外发语义词，本地判为明确只读，直接放行。` };
	if (readMethod && staticAsset && !encodedAmbiguity) return { verdict: "read-clear", hardBoundary: false, delegate: false, require: false, category: "放行", reason: `${m} ${pathStr}：读方法 + 静态资源扩展名且查询串无可疑语义词，本地判为明确只读，直接放行。` };
	// ③ 其余交判定服务；`require` 仅作为判定服务未启用时的本地兜底。
	if (hasToken && writeMethod && hasOtherId) return { verdict: "needs-judgement", hardBoundary: false, delegate: true, require: true, category: "越权删改", reason: `带认证头 + 写方法 ${m} + 资源 id 命中小整数枚举（${victimIds.join(",")}）：本地不再直接挂起，交判定服务判定实际影响（可能是查询或有界计算）。`, victimIds };
	const readLike = readPath;
	// Request-body keywords and target-specific endpoint names are not proof of
	// read-only semantics. Unknown POSTs retain the existing approval boundary
	// as the fallback when the decision service is disabled.
	if (!hasToken && writeMethod && !readLike) return { verdict: "needs-judgement", hardBoundary: false, delegate: true, require: true, category: "未授权删改", reason: `无认证头 + 写方法 ${m} + path 非明确只读/查询语义：本地不再直接挂起，交判定服务判定实际影响（空参数/类型探测多为有界计算）。` };
	if (writeMethod) return { verdict: "needs-judgement", hardBoundary: false, delegate: true, require: false, category: "放行", reason: `${m} ${pathStr}：写方法但未命中本地挂起判据（token=${hasToken} 读语义=${readLike}），交判定服务判定实际影响。` };
	if (!readMethod) return { verdict: "needs-judgement", hardBoundary: false, delegate: true, require: true, category: "非标准方法", reason: `非 GET/HEAD/OPTIONS 亦非 POST/PUT/PATCH/DELETE 的方法 ${m}：本地不做确定性判定，交判定服务。` };
	return { verdict: "needs-judgement", hardBoundary: false, delegate: true, require: true, category: "只读疑义", reason: `${m} ${pathStr}：读方法${suspiciousToken ? `命中可疑语义词（${suspiciousToken}）` : "含未解开的百分号转义（编码嵌套或歧义）"}，不按明确只读豁免，交判定服务判定。` };
}
