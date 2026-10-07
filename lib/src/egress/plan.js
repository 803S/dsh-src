// Exact, bounded task authorization. Never infer permission from a command name.
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

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
export function normalizePlan(input, scope) {
  exactKeys(input, ['entries', 'maxRequests', 'minIntervalMs', 'lifetimeMs', 'purpose', 'hostExecution']);
  requireThat(scope && typeof scope.revision === 'string' && scope.revision.length > 0 && typeof scope.credentialRevision === 'string' && scope.credentialRevision.length > 0, 'UNTRUSTED_SCOPE');
  requireThat(Array.isArray(scope.origins) && scope.origins.length > 0, 'UNTRUSTED_SCOPE');
  const origins = [...new Set(scope.origins)].sort();
  for (const origin of origins) {
    let u; try { u = new URL(origin); } catch { throw gateError('UNTRUSTED_SCOPE'); }
    requireThat(['http:', 'https:'].includes(u.protocol) && u.origin === origin, 'UNTRUSTED_SCOPE');
  }
  requireThat(Array.isArray(input.entries) && input.entries.length > 0 && input.entries.length <= LIMITS.entries, 'ENTRY_LIMIT');
  const seen = new Set();
  const entries = input.entries.map(entry => {
    exactKeys(entry, ['request', 'maxRequests']);
    const request = canonicalRequest(entry.request);
    requireThat(origins.includes(new URL(request.url).origin), 'OUT_OF_SCOPE');
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
export function requiresHuman(plan) {
  return plan.entries.some(({ request }) => {
    // 路径词不是副作用证据。实际语义交Jev；编码歧义与方法覆写仍不得自动放行。
    const url = new URL(request.url);
    let decoded = url.pathname + url.search;
    try { for (let i = 0; i < 4; i++) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } }
    catch { return true; }
    return /%[a-f0-9]{2}/i.test(decoded)
      || request.headers.some(([name,value]) => {
        // 仅来源IP头可交给Jev判断；Host/URL/方法改写仍保留硬闸。
        if (/^(?:x-forwarded-for|x-real-ip)$/i.test(name) && value.split(',').every(ip=>isIP(ip.trim()))) return false;
        return /method|rewrite|forward|original/i.test(name);
      });
  });
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
  requireThat(!requiresHuman({entries:plan.entries.map(({request})=>({request:{...request,headers:[]}}))}), 'WRITE_EXECUTOR_REQUIRED');
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
