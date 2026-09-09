// [local.67 #17] src_http / src_resolve_approval 响应体透传的统一防护层（截断/去重/掩码）。
// 顺丰实证（§1.5）：两处放行点只回状态码，103 次 src_http + 13 次重放无一见到响应体，
// 415×5 盲发 + Content-Type 假阴性 + 错误归因入图都是「看不到 body」的直接代价。
// 四件防护（论证文档 #17 拍板终版）：
//   ① 截断：默认 2KB，仅 text/json 类响应体；二进制/图片只回长度（full:true 可放宽为 latin1 前 2KB）
//   ② 去重：同 host+method+path 的响应哈希（status+body）重复时只回 hash+长度；full:true 强制完整。
//      键必须用响应哈希——同路径前后两次响应不同正是越权写入验证的关键信号，用请求 body-hash 做键会误吞。
//   ③ 掩码：注入凭证原文（≥8 字符）+ Bearer/Basic + query token 参数；头形态凭证在响应体里按行掩码。
//   ④ Content-Type 自动补全硬闸在调用点实现（tools/index.js / store.js）——本模块只管响应侧。
import { createHash } from "node:crypto";

const TEXT_BODY_RE = /(?:^text\/)|(?:json)|(?:xml)|(?:html)|(?:javascript)|(?:x-www-form-urlencoded)/i;
const BODY_LIMIT_CHARS = 2048;
const DEDUP_MAX_KEYS = 256;

/** 创建一个响应体描述器实例（进程内共享去重表；每个 plugin 实例一个）。
 * 返回 describeHttpBody({ url, method, status, contentType, rawBody, secrets, full }) →
 * { body, truncated, deduped, hash }。body 永远是给 agent 看的文本（透传内容或诊断说明）。 */
export function createHttpBodyDescriber() {
	const seen = /* @__PURE__ */ new Map();
	return function describeHttpBody({ url, method = "", status = 0, contentType = "", rawBody = "", secrets = [], full = false }) {
		const ct = String(contentType ?? "");
		const raw = String(rawBody ?? "");
		const totalBytes = Buffer.byteLength(raw, "utf8");
		let host = "";
		try { const u = new URL(String(url ?? "")); host = `${u.host}${u.pathname}`; } catch { host = String(url ?? "?").slice(0, 120); }
		const hash12 = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
		const dedupKey = `${String(method).toUpperCase()} ${host} #${status} ${hash12}`;
		/* ② 去重：完全相同的响应（status+body 哈希、同 host+method+path）不再重复注入。 */
		if (seen.has(dedupKey) && full !== true) {
			const count = (seen.get(dedupKey) ?? 0) + 1;
			seen.set(dedupKey, count);
			return { body: `[响应体去重] 该响应（status=${status}，sha256 前 12 位 ${hash12}，共 ${totalBytes} 字节）在同 host+method+path 下已第 ${count} 次完全相同，不重复注入。若前后两次响应本应不同（写入后回读、越权前后对比），加 full:true 强制返回完整响应体再下结论。`, truncated: false, deduped: true, hash: hash12 };
		}
		seen.set(dedupKey, (seen.get(dedupKey) ?? 0) + 1);
		if (seen.size > DEDUP_MAX_KEYS) seen.delete(seen.keys().next().value);
		/* ③ 掩码：先按凭证原文精确替换（注入了什么就掩什么，最可靠），再兜通用 token 形态。 */
		let text = raw;
		for (const secret of Array.isArray(secrets) ? secrets : []) {
			if (typeof secret === "string" && secret.trim().length >= 8) text = text.split(secret.trim()).join("<stored>");
		}
		text = text
			.replace(/(Bearer\s+|Basic\s+)[^\s"'`,;\\)\]}]+/gi, "$1<stored>")
			.replace(/([?&](?:token|key|secret|password|authorization|access_?token|api_?key)="?)([^&"'\s,;\\)}]+)/gi, "$1<stored>");
		/* ① 非 text/json 类：只回长度，不透传内容（二进制灌进上下文只会烧 token）。 */
		if (!TEXT_BODY_RE.test(ct)) {
			if (full === true) return { body: `${Buffer.from(raw, "utf8").toString("latin1").slice(0, BODY_LIMIT_CHARS)}${totalBytes > BODY_LIMIT_CHARS ? `\n…[截断] 二进制按 latin1 只解前 ${BODY_LIMIT_CHARS} 字节（共 ${totalBytes} 字节），仅用于魔数/结构判别` : ""}`, truncated: totalBytes > BODY_LIMIT_CHARS, deduped: false, hash: hash12 };
			return { body: `[响应体未透传] Content-Type「${ct === "" ? "（缺失）" : ct}」非 text/json 类，共 ${totalBytes} 字节（sha256 前 12 位 ${hash12}）。如需内容（魔数/结构判别）加 full:true 强制透传。`, truncated: false, deduped: false, hash: hash12 };
		}
		let truncated = false;
		if (full !== true && text.length > BODY_LIMIT_CHARS) {
			text = `${text.slice(0, BODY_LIMIT_CHARS)}\n…[截断] 响应体共 ${totalBytes} 字节，默认只注入前 ${BODY_LIMIT_CHARS} 字符；需要完整原文时加 full:true。`;
			truncated = true;
		}
		return { body: text, truncated, deduped: false, hash: hash12 };
	};
}
