// Exact, bounded task authorization. Never infer permission from a command name.
import { createHmac } from 'node:crypto';
import { classifyHttpRequest } from '../security.js';
import { isLocalServeOrigin } from './local-serve.js';

export const POLICY_VERSION = 'src-egress-exact-v2';
export const LIMITS = Object.freeze({ entries: 256, bodyBytes: 65536, planBytes: 262144, requests: 1000, lifetimeMs: 900000, minIntervalMs: 250 });
const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FORBIDDEN_HEADERS = /^(?:proxy-.*|connection|upgrade|transfer-encoding|trailer|te|expect|keep-alive)$/;

export function gateError(code) {
  return Object.assign(new Error(`SRC_GATE_${code}`), { code: `SRC_GATE_${code}`, safeNotSent: true });
}
function requireThat(value, code) { if (!value) throw gateError(code); }
function integer(value, min, max, code) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, code);
  return value;
}
function exactKeys(value, allowed) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT');
  requireThat(Object.keys(value).every(key => allowed.includes(key)), 'UNKNOWN_FIELD');
}
export function canonicalRequest(input) {
  exactKeys(input, ['url', 'method', 'headers', 'bodyBase64']);
  requireThat(typeof input.url === 'string' && input.url.length <= 8192, 'INVALID_URL');
  let url;
  try { url = new URL(input.url); } catch { throw gateError('INVALID_URL'); }
  // Reject normalization ambiguity instead of approving one URL and emitting another.
  requireThat(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash && url.href === input.url, 'NONCANONICAL_URL');
  const method = input.method ?? 'GET';
  requireThat(METHODS.has(method), 'UNSUPPORTED_METHOD');
  const encoded = input.bodyBase64 ?? '';
  requireThat(typeof encoded === 'string' && encoded.length <= Math.ceil(LIMITS.bodyBytes / 3) * 4, 'BODY_LIMIT');
  const body = Buffer.from(encoded, 'base64');
  requireThat(body.toString('base64') === encoded && body.length <= LIMITS.bodyBytes, 'INVALID_BODY');
  requireThat(!['GET', 'HEAD'].includes(method) || body.length === 0, 'READ_BODY');
  const headers = input.headers ?? [];
  requireThat(Array.isArray(headers) && headers.length <= 64, 'INVALID_HEADERS');
  const seen = new Set();
  const normalized = [];
  let bytes = 0;
  for (const pair of headers) {
    requireThat(Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === 'string'), 'INVALID_HEADERS');
    const [rawName, value] = pair;
    const name = rawName.toLowerCase();
    requireThat(/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) && !/[\x00-\x1f\x7f-\uffff]/.test(value), 'INVALID_HEADERS');
    requireThat(!seen.has(name) && !FORBIDDEN_HEADERS.test(name), 'UNSUPPORTED_HEADERS');
    seen.add(name);
    bytes += name.length + value.length;
    requireThat(bytes <= 16384, 'HEADER_LIMIT');
    if (name === 'host') { requireThat(value === url.host, 'HOST_MISMATCH'); continue; }
    if (name === 'content-length') { requireThat(value === String(body.length), 'LENGTH_MISMATCH'); continue; }
    normalized.push([name, value]);
  }
  normalized.sort(([a], [b]) => a.localeCompare(b, 'en'));
  return { url: url.href, method, headers: normalized, bodyBase64: encoded };
}
export function requestDigest(key, request) {
  return createHmac('sha256', key).update(JSON.stringify(canonicalRequest(request))).digest('hex');
}
/* 只写方法：读取/枚举/探测不受范围限制（范围只约束写/影响类请求）。
 * 写入仍要求人工声明或整域确认，见 target-context/manager 的范围闸。 */
export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// 人类写下的 URL 与其同主机 web 默认端口形态视为同一授权：https://h:80 ≡ https://h。
// 现场原因（2026-10-14 会话实证）：用户在正文里写 https://host:80/…，我们记录的是精确 origin，
// 而 agent 后续常用无端口写法（https://host ⇒ 443）→ 明明同一台主机却被 OUT_OF_SCOPE 拦住，
// 用户只能重打域名绕行。范围闸的语义是「主机归属」（写下的域名给整域、任意端口），
// 不是端口级隔离；同主机且两端都在 {80,443,默认} 之内按同一主机放行。
export function originGranted(origins, origin) {
  if (!Array.isArray(origins) || origins.includes(origin)) return true;
  let target;
  try { target = new URL(origin); } catch { return false; }
  if (!['', '80', '443'].includes(target.port)) return false;
  return origins.some((candidate) => {
    let known;
    try { known = new URL(candidate); } catch { return false; }
    return known.hostname === target.hostname && ['', '80', '443'].includes(known.port);
  });
}
export function normalizePlan(input, scope) {
  exactKeys(input, ['entries', 'maxRequests', 'minIntervalMs', 'lifetimeMs', 'purpose', 'hostExecution']);
  requireThat(scope && typeof scope.revision === 'string' && scope.revision.length > 0 && typeof scope.credentialRevision === 'string' && scope.credentialRevision.length > 0, 'UNTRUSTED_SCOPE');
  // 只读通道（readOrigins）是自动记录的已访问 origin：它授权读，不授权写。
  const readOrigins = new Set(Array.isArray(scope.readOrigins) ? scope.readOrigins : []);
  requireThat(Array.isArray(scope.origins) && (scope.origins.length > 0 || readOrigins.size > 0), 'UNTRUSTED_SCOPE');
  const origins = [...new Set(scope.origins)].sort();
  for (const origin of [...origins, ...readOrigins]) {
    let u; try { u = new URL(origin); } catch { throw gateError('UNTRUSTED_SCOPE'); }
    requireThat(['http:', 'https:'].includes(u.protocol) && u.origin === origin, 'UNTRUSTED_SCOPE');
  }
  requireThat(Array.isArray(input.entries) && input.entries.length > 0 && input.entries.length <= LIMITS.entries, 'ENTRY_LIMIT');
  const seen = new Set();
  const entries = input.entries.map(entry => {
    exactKeys(entry, ['request', 'maxRequests']);
    const request = canonicalRequest(entry.request);
    const origin = new URL(request.url).origin;
    requireThat(originGranted(origins, origin) || (READ_METHODS.has(request.method) && readOrigins.has(origin)) || isLocalServeOrigin(origin), 'OUT_OF_SCOPE');
    const identity = JSON.stringify(request);
    requireThat(!seen.has(identity), 'DUPLICATE_ENTRY');
    seen.add(identity);
    return { request, maxRequests: integer(entry.maxRequests, 1, LIMITS.requests, 'ENTRY_BUDGET') };
  });
  const maxRequests = integer(input.maxRequests, 1, LIMITS.requests, 'TASK_BUDGET');
  requireThat(maxRequests <= entries.reduce((n, e) => n + e.maxRequests, 0), 'TASK_BUDGET');
  const lifetimeMs = integer(input.lifetimeMs, 1, LIMITS.lifetimeMs, 'LIFETIME');
  const minIntervalMs = integer(input.minIntervalMs, LIMITS.minIntervalMs, 60000, 'RATE');
  requireThat(typeof input.purpose === 'string' && input.purpose.trim().length > 0 && input.purpose.length <= 2048, 'PURPOSE');
  const plan = { ...(input.hostExecution?{hostExecution:structuredClone(input.hostExecution)}:{}), policyVersion: POLICY_VERSION, scopeRevision: scope.revision, credentialRevision: scope.credentialRevision, origins, entries, maxRequests, minIntervalMs, lifetimeMs, purpose: input.purpose };
  requireThat(Buffer.byteLength(JSON.stringify(plan)) <= LIMITS.planBytes, 'PLAN_LIMIT');
  return plan;
}
// This is a veto only, NOT proof that an unlisted endpoint is safe.
// 本地硬边界 = 确定危害（用户指令 2026-10-14）：DELETE、强删改语义词、请求方法改写头。
// 编码歧义（裸 % / 二次编码）此前对可写方法是无条件硬闸；现改为交判定服务（其失败一律挂人工），
// 本地不再用近似判据否决。
export function hardForbid(request) {
  const verdict = classifyPlanRequest(request);
  return verdict.hardBoundary ? { category: verdict.category, reason: verdict.reason } : null;
}
// 明确只读：读方法且无任何可疑语义词。这类请求直接放行，不调用判定服务。
export function readClearRequest(request) {
  return classifyPlanRequest(request).verdict === 'read-clear';
}
function classifyPlanRequest(request) {
  const url = new URL(request.url);
  const headers = {};
  for (const [name, value] of request.headers ?? []) headers[String(name).toLowerCase()] = String(value ?? '');
  return classifyHttpRequest({ method: request.method, path: url.pathname, query: url.search, headers, body: Buffer.from(request.bodyBase64 ?? '', 'base64').toString('utf8') });
}
export function requiresHuman(plan) {
  return plan.entries.some(({ request }) => hardForbid(request) !== null);
}
export function assertScopeCurrent(plan, scope) {
  requireThat(plan.policyVersion === POLICY_VERSION, 'POLICY_CHANGED');
  requireThat(scope?.revision === plan.scopeRevision && scope?.credentialRevision === plan.credentialRevision, 'SCOPE_CHANGED');
  requireThat(Array.isArray(scope.origins) && plan.origins.every(origin => scope.origins.includes(origin)), 'SCOPE_CHANGED');
}

// Mutation approval additionally needs backup/precondition/recovery execution. The
// scan gate must not turn a human click into a bypass of that missing integration.
export function assertScanExecutable(plan) {
  requireThat(plan.entries.every(({request}) => ['GET', 'HEAD', 'OPTIONS'].includes(request.method)), 'WRITE_EXECUTOR_REQUIRED');
}

// Veto identity, deliberately broader than request identity. Encoding/case/query
// changes may not turn a pending destructive operation into an automatic read.
export function resourceDigest(key, request) {
  const url = new URL(canonicalRequest(request).url);
  let pathname = url.pathname;
  try {
    for (let i = 0; i < 8; i++) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
  } catch { throw gateError('AMBIGUOUS_RESOURCE'); }
  if (/%[a-f0-9]{2}/i.test(pathname)) throw gateError('AMBIGUOUS_RESOURCE');
  const normalized = new URL(pathname.replace(/\\/g, '/').replace(/\/{2,}/g, '/'), url.origin).pathname.toLowerCase();
  return createHmac('sha256', key).update(JSON.stringify([url.origin, normalized])).digest('hex');
}
