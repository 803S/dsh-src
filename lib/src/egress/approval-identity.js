/* [local.150 用户拍板 2026-10-19] 「一笔请求的身份」——三处判据共用的唯一定义：
 * 判定服务、账本 operation 身份（broker.js）、审批卡去重（egress/manager.js）。
 *
 * 身份 = 方法 + URL + 正文 + 请求头（去掉 NON_IDENTITY_HEADERS）。
 *   - NON_IDENTITY_HEADERS 是「客户端口味/追踪」类头（User-Agent / Accept / Origin / traceparent…）：
 *     它们不是请求身份。step25 的 403 就是同一类原因 —— HMAC requestDigest 把 curl 自动加的
 *     User-Agent 也算进了报文身份，用户冻结的那一份与 curl 发出去的那一份对不上，25 字节 403。
 *   - 其余头（含凭据 Authorization/Cookie/CSRF、内容类型）都要参与：凭据不同**不合并** ——
 *     带 cookie 与不带 cookie 是两笔影响面不同的请求。凭据因此天然包含在身份里，不再另造一份“指纹”，
 *     免得两处键漂移（卡上合并了、账本上却是两笔任务，就会出现“卡片显示 A、实际执行 B”）。
 *
 * 身份只在内存里现算用于比较，不落库：卡片正文仍按用户要求展示原始冻结报文。
 * 形状取「卡片里那份呈现」（headers 为对象、body 为文本），这样对**新提案**（presentPlan raw）与
 * **既有卡行**（row.body 里存的就是同一份呈现）用同一套判据。
 */
import { createHash } from 'node:crypto';

/** 不参与请求身份的头（客户端口味/追踪）。改这份名单等于改身份语义：账本 operation 与审批卡去重同时生效。 */
export const NON_IDENTITY_HEADERS = Object.freeze([
  'x-trace-id', 'x-request-id', 'traceparent', 'tracestate', 'user-agent', 'accept', 'accept-encoding', 'referer', 'origin',
]);

function headerPairs(headers) {
  return (Array.isArray(headers) ? headers : Object.entries(headers ?? {}))
    .map(([name, value]) => [String(name).toLowerCase(), String(value ?? '')])
    .filter(([name]) => !NON_IDENTITY_HEADERS.includes(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/* 凭据类头的名字：只用于报告身份里的“凭据维度”是否参与（诊断/文案），不改变比较结果。
 * 与 plan-presentation.js 里判定“这头要不要打码”用的是同一组名字。 */
const CREDENTIAL_NAME = /authorization|cookie|token|key|secret/i;

function bodyText(request) {
  if (typeof request.body === 'string') return request.body;
  return Buffer.from(request.bodyBase64 ?? '', 'base64').toString('utf8');
}

/** 单笔请求的身份；形状不可识别时返回 null（宁可不去重，也不把两笔不同请求合并成一张卡）。 */
export function requestIdentity(request) {
  if (!request || typeof request !== 'object' || typeof request.url !== 'string' || request.url === '') return null;
  const headers = headerPairs(request.headers);
  /* 头值不进身份字符串：同样一组头逐字节相同才算同一笔请求，所以比较的是“名=值摘要”。
   * 摘要是本地内存里的一次性比较量，不落库、不外发（卡片正文仍是原始报文）。 */
  const print = headers.map(([name, value]) => `${name}=${createHash('sha256').update(value).digest('hex').slice(0, 12)}`);
  return JSON.stringify([String(request.method ?? '').toUpperCase(), request.url, bodyText(request), print]);
}

/** 身份里是否带凭据（诊断/文案用：让人知道“这一步区分了凭据”）。 */
export function requestHasCredential(request) {
  if (!request) return false;
  return headerPairs(request.headers).some(([name]) => CREDENTIAL_NAME.test(name));
}

/** 一组冻结请求的身份（顺序敏感：多笔计划的顺序就是发出去的顺序）。 */
export function planIdentity(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const identities = entries.map((entry) => requestIdentity(entry?.request ?? entry));
  if (identities.some((identity) => identity === null)) return null;
  return JSON.stringify(identities);
}

/** 从已落库卡片的 body 反算身份；解析失败返回 null（旧格式/损坏行一律不去重）。 */
export function cardIdentity(bodyText) {
  try {
    const body = JSON.parse(String(bodyText ?? ''));
    return planIdentity(Array.isArray(body) ? body : body?.entries);
  } catch {
    return null;
  }
}
