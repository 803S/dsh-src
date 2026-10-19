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
/* [local.150 用户拍板 2026-10-19] 「页面构造类」语义词（SUSPICIOUS_WORDS 的子集）：
 * 这些词描述的是**表单页/构造动作**的路径。它们只在请求携带输入（正文、查询串、路径资源 id）时才可能
 * 落到「状态变更端点」那一侧；不带任何输入时，`GET /users/create` 与浏览器加载「新建用户」表单页
 * 在字节上完全相同，把它们钉成人工审批等于把「模型没申报用途」的成本转给人。
 * 其余可疑语义词（认证/校验、状态审批、主动外发/费用类）不参与这个豁免：即使无输入也仍按可能影响处理。 */
const CONSTRUCTION_WORDS = new Set(["create", "update", "edit", "modify", "save", "generate"]);
// 静态资源扩展名快速通道：读方法 + 末段路径是静态文件扩展名 + 查询串没有任何可疑/强删改词
// → 明确只读（静态资源没有副作用）。避免把目录名/文件名里的名词拿来当语义证据（R5）。
const STATIC_ASSET = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|eot|otf|json|txt|xml|csv|pdf|lock|md|html?)$/i;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// 请求方法覆写/转发头会改变实际执行的方法与来源，属确定危害（x-forwarded-for / x-real-ip 是常规代理头，排除）。
// [local.146] 但 CORS 预检协议头必须排除：`access-control-request-method` 只是浏览器在问“我能不能用这个方法”，
// 它不改写任何东西。旧正则 /method/ 把它一并抓了，于是每个 CORS 预检探测都被钉成“请求方法改写”确定危害、
// 判定服务无权覆盖（现场：OPTIONS /users + Origin: evil.example.com + Access-Control-Request-Method: GET，
// 判定服务判 read/low/allow，本地却挂人工）。
const METHOD_OVERRIDE_HEADER = /method|rewrite|forward|original/i;
const CORS_PREFLIGHT_HEADER = /^access-control-request-(?:method|headers)$/i;
const LEGIT_PROXY_HEADER = /^(?:x-forwarded-for|x-real-ip)$/i;
// 常规代理头的值只允许 IP/端口列表（含 ::1、IPv6、逗号分隔链）；值里出现主机名、`host=`、`;` 等路由语法
// 视为改写/来源伪造，按确定危害处理。
const IP_LIST_VALUE = /^[\s0-9a-f:.,\[\]]+$/i;
// 残留转义：解码到最后一层仍留 %xx（≥5 层嵌套）说明本地看不到真实路径，交判定服务而不是本地豁免。
const ESCAPE_SEQUENCE = /%[0-9a-fA-F]{2}/;

const tokensOf = (value) => String(value ?? "").split(/[^a-zA-Z0-9]+/).flatMap((seg) => seg.split(/(?=[A-Z])/)).map((t) => t.toLowerCase()).filter((t) => t !== "");
const pathSegmentsOf = (value) => String(value ?? "").split("/").filter((seg) => seg !== "");
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
 *
 * [local.138] `require:false` 只允许出现在「明确只读」这一种情形（read-clear，以及
 * http-policy 的只读分支）。**任何写方法都不再有本地自动放行**：
 * 旧实现在最后一条写方法分支上给了 `require:false`，本意是「判定服务启用时交它判定实际影响」，
 * 但该字段的消费方是 legacy 分支（mode!=="on" 时 `{...rule,authority:'legacy-rules'}`），
 * 于是判定服务关掉时它退化成「没有 Jev 结论也自动外发」。实测后果：
 * `PUT /bucket/key` + `Authorization: SigV4…`（或任一 token 头）不带小整数资源 id 时
 * 既不命中 :104「越权删改」（只认 userId/uid/orderId 这类数字 id 的小整数枚举），
 * 也不命中下面那条「无认证头」分支，直接掉到最后一条 → 判定服务未启用即自动放行。
 * 存储桶写入与「覆盖已有对象」在本地无法区分（本地没有「该 key 已存在」的知识，
 * 两者分类完全相同，覆盖也没有数字 id、没有删改语义词），所以这类请求不存在保守豁免。
 * 现在：写类一律 needs-judgement + require:true —— 判定服务启用时行为不变（仍由 Jev 判定），
 * 未启用时改挂人工审批。只读快通道（:90-:91）不受影响。
 */
/**
 * [local.150 用户拍板 2026-10-19] 「无输入只读」判据 —— 本地事实，不是判定服务结论：
 *   读方法 ∧ 无正文 ∧ 无查询串 ∧ 路径无资源 id ∧ 无强删改词（非 hard-boundary）∧ 无影响类语义词。
 * 语义：这一发**携带不了任何输入**，因此不可能对线上运行环境、业务数据或真实用户产生影响。
 * 若它偏偏真是状态变更端点，说明该端点每次被浏览都改状态 —— 那种情况下人工审批也定不出结论：
 * 用户看到的报文与一次表单页加载逐字节相同，批与不批发出去的字节序列一模一样。
 * 消费方（单笔车道 http-policy / 计划车道 broker）只能用它**豁免人工卡**，
 * 不得覆盖判定服务与本地硬边界的否定结论。
 * @returns {{impactFree:boolean, reason:string, verdict?:string}}
 */
export function impactFreeRead({ method, url, headers, body, bodyBase64 } = {}) {
	const m = String(method ?? "GET").toUpperCase();
	if (!READ_METHODS.has(m)) return { impactFree: false, reason: `方法 ${m} 不是读方法` };
	const hasBody = String(body ?? "").length > 0 || Buffer.from(String(bodyBase64 ?? ""), "base64").length > 0;
	if (hasBody) return { impactFree: false, reason: "带请求正文：正文本身是输入，可能触发状态变更" };
	let parsed;
	try { parsed = new URL(String(url)); } catch { return { impactFree: false, reason: "URL 无法解析" }; }
	const query = parsed.search ?? "";
	if (query.length > 1) return { impactFree: false, reason: `带查询串（${query.slice(0, 80)}）：查询串是输入，可能是状态变更端点` };
	if (/(?:^|\/)\d{1,12}(?=\/|$)/.test(parsed.pathname)) return { impactFree: false, reason: "路径含资源 id：可能是针对具体对象的动作端点" };
	const headerMap = {};
	if (Array.isArray(headers)) for (const [k, v] of headers) headerMap[String(k).toLowerCase()] = String(v ?? "");
	else for (const [k, v] of Object.entries(headers ?? {})) headerMap[String(k).toLowerCase()] = String(v ?? "");
	const verdict = classifyHttpRequest({ method: m, path: parsed.pathname, query, headers: headerMap, body: "" });
	if (verdict.hardBoundary === true) return { impactFree: false, verdict: verdict.verdict, reason: `本地确定危害（${verdict.category}）：不适用无输入只读豁免` };
	const tokens = [...new Set(decodeLayers(parsed.pathname).layers.flatMap(tokensOf))];
	const impactToken = tokens.find((t) => SUSPICIOUS_WORDS.has(t) && !CONSTRUCTION_WORDS.has(t));
	if (impactToken) return { impactFree: false, verdict: verdict.verdict, reason: `路径含影响类语义词（${impactToken}）：即使无输入也可能影响真实用户或业务状态` };
	return { impactFree: true, verdict: verdict.verdict, reason: `${m} ${parsed.pathname}：读方法 + 无正文 + 无查询串 + 无资源 id + 无强删改词 + 无影响类语义词 —— 与浏览器加载一个表单页逐字节相同，本地判为无输入只读` };
}

export function classifyHttpRequest({ method, path, headers, body, query }) {
	const m = String(method ?? "GET").toUpperCase();
	const pathStr = String(path ?? "");
	const queryStr = String(query ?? "");
	const headerMap = {};
	for (const [k, v] of Object.entries(headers ?? {})) headerMap[String(k).toLowerCase()] = String(v ?? "");
	const hasToken = Object.keys(headerMap).some((key) => /^(?:authorization|cookie|x-auth-token|api[-_]?key|x-api[-_]?key)$/i.test(key) || /token/i.test(key));
	const overrideHeader = Object.keys(headerMap).find((key) => METHOD_OVERRIDE_HEADER.test(key) && !CORS_PREFLIGHT_HEADER.test(key) && !(LEGIT_PROXY_HEADER.test(key) && IP_LIST_VALUE.test(headerMap[key])));
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
	/* [local.146 用户拍板「交给 Jev 判断，能删数据的限制死一点」] 读方法命中强删改语义词时怎么分档：
	 * 动词**收在路径末尾**（/delete、/users/1/delete、/admin/purge）或**出现在查询串**（?action=delete）
	 * 是状态变更端点的常规写法 → 维持本地终审（Jev 无权覆盖）；
	 * 动词后面还跟着别的段（/users/reset/1 这类）刚是「表单页路径」的形态（现场 Jorani 把自己的改密码弹窗
	 * 表单体写成 load('/users/reset/1')）→ 交判定服务判实际影响，它看得到方法与 body，本地词看表不到。
	 * 写方法命中强删改词一律不变（仍终审）。 */
	const destroyInQuery = queryTokens.some((t) => CORE_DESTROY_WORDS.has(t));
	/* 「动词是不是这个 URL 的端点」只看**最后一段路径**（含 camelCase 拆分，/deleteUser 算）：
	 * /delete、/users/1/delete、/admin/purge、/deleteUser、/%64elete → 端点，终审；
	 * /users/reset/1 → 最后一段是 id，动词在中段 → 表单页形态，交判定服务。 */
	const destroyIsEndpoint = tokensOf(pathSegmentsOf(lastLayer(pathLayers)).at(-1) ?? "").some((t) => CORE_DESTROY_WORDS.has(t));
	const suspiciousToken = tokens.find((t) => SUSPICIOUS_WORDS.has(t));
	const readPath = tokens.some((t) => READ_PATH_WORDS.test(t));
	const writeMethod = WRITE_METHODS.has(m);
	const readMethod = READ_METHODS.has(m);
	const staticAsset = STATIC_ASSET.test(lastLayer(pathLayers)) && !queryTokens.some((t) => SUSPICIOUS_WORDS.has(t) || CORE_DESTROY_WORDS.has(t));
	// ① 确定危害：终审，不允许判定服务覆盖。
	if (overrideHeader) return { verdict: "hard-boundary", hardBoundary: true, delegate: false, require: true, category: "请求方法改写", reason: `请求头 ${overrideHeader} 会改写实际执行的请求方法/来源，属确定危害，挂起审批（终审，判定服务无权覆盖）。` };
	if (destroyToken && readMethod && !destroyInQuery && !destroyIsEndpoint) return { verdict: "needs-judgement", hardBoundary: false, delegate: true, require: true, category: "破坏性操作疑义", reason: `${m} ${pathStr}：读方法在路径中段命中强删改语义词（${destroyToken}）——可能是表单页，也可能是状态变更端点，交判定服务判定实际影响。` };
	if (destroyToken) return { verdict: "hard-boundary", hardBoundary: true, delegate: false, require: true, category: "破坏性写入", reason: destroyInQuery ? `查询串含强删改语义词（${destroyToken}）：?action=… 类写法就是状态变更端点，属确定危害（终审，判定服务无权覆盖）。` : `路径末段含强删改语义词（${destroyToken}）：该 URL 本身就是删改端点，属确定危害（终审，判定服务无权覆盖）。` };
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
	if (writeMethod) return { verdict: "needs-judgement", hardBoundary: false, delegate: true, require: true, category: "写类无本地豁免", reason: `${m} ${pathStr}：写方法（token=${hasToken} 读语义=${readLike}）但未命中本地挂起判据；写类在本地无法区分「新建」与「覆盖已有资源」，不设自动放行。判定服务启用时交其判定实际影响，未启用时挂人工审批。（[local.138]）` };
	if (!readMethod) return { verdict: "needs-judgement", hardBoundary: false, delegate: true, require: true, category: "非标准方法", reason: `非 GET/HEAD/OPTIONS 亦非 POST/PUT/PATCH/DELETE 的方法 ${m}：本地不做确定性判定，交判定服务。` };
	return { verdict: "needs-judgement", hardBoundary: false, delegate: true, require: true, category: "只读疑义", reason: `${m} ${pathStr}：读方法${suspiciousToken ? `命中可疑语义词（${suspiciousToken}）` : "含未解开的百分号转义（编码嵌套或歧义）"}，不按明确只读豁免，交判定服务判定。` };
}
