import { createHash } from 'node:crypto';

/**
 * 统一构造操作上下文（Operation Context），贯穿执行入口与出口。
 * 遵循 docs/jev-approval-simplification-plan-20261012.md §4A/§6：
 * - 携带 operationId / sessionId / intentId（无 callId 时用内容摘要，不用 Date.now 猜稳定 ID）
 * - 明确主模型操作理由（标记为模型解释，不是授权证明）
 * - 工具名、原始参数、命令、cwd
 * - 脚本/文件或载荷指纹
 * - 预期/冻结请求及目标
 * digest 是诊断摘要；授权身份始终以出口 broker 的 requestDigest/HMAC 为准，二者不混用。
 */

function headerObject(pairs) {
  const headers = {};
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const [name, value] = Array.isArray(pair) ? pair : [pair, ''];
    const key = String(name ?? '');
    if (key === '') continue;
    headers[key] = Object.hasOwn(headers, key) ? `${headers[key]}, ${String(value ?? '')}` : String(value ?? '');
  }
  return headers;
}

/** 有界 UTF-8 解码：失败返回 null（由调用方走类型感知表示，不丢也不假装为空）。 */
function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return null; }
}

function binaryRepresentation(bytes, contentType, hash) {
  const previewBytes = bytes.subarray(0, 512);
  return `[二进制 ${contentType || '未声明类型'} 共 ${bytes.length} 字节 sha256=${hash}；不可按文本审阅，前 ${previewBytes.length} 字节 base64：${previewBytes.toString('base64')}${bytes.length > previewBytes.length ? '（仅摘要预览，完整字节不送审）' : ''}]`;
}

/** multipart 解析：字段名/文件名/type/size/hash 与有界内容；不丢字段也不把二进制当空串。 */
function multipartRepresentation(bytes, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(String(contentType ?? ''));
  const summary = [];
  const textPieces = [];
  if (boundaryMatch) {
    const boundary = `--${boundaryMatch[1] ?? boundaryMatch[2]}`;
    const raw = bytes.toString('latin1');
    const sections = raw.split(boundary).slice(1, -1);
    let index = 0;
    for (const section of sections) {
      index++;
      const split = /\r\n\r\n/.exec(section);
      if (!split) continue;
      const head = section.slice(0, split.index);
      const content = section.slice(split.index + 4, section.endsWith('\r\n') ? section.length - 2 : section.length);
      const name = /name="([^"]*)"/i.exec(head)?.[1] ?? '';
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      const partType = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? '';
      const partBytes = Buffer.from(content, 'latin1');
      const partHash = createHash('sha256').update(partBytes).digest('hex').slice(0, 32);
      if (filename !== undefined) {
        const decoded = decodeUtf8(partBytes.subarray(0, 2049));
        const preview = decoded === null ? ''
          : `[文本预览] ${decoded.slice(0, 2048)}${partBytes.length > 2048 || decoded.length > 2048 ? '（截断）' : ''}`;
        summary.push(`part${index}: 文件 name="${name}" filename="${filename}" type=${partType || '未声明'} ${partBytes.length}B sha256=${partHash}${preview ? `\n${preview}` : ''}`);
      } else {
        const decoded = decodeUtf8(partBytes.subarray(0, 8193));
        const value = decoded === null ? `[二进制 ${partBytes.length}B sha256=${partHash}]` : decoded.slice(0, 8192) + (partBytes.length > 8192 || decoded.length > 8192 ? '（截断）' : '');
        summary.push(`part${index}: 字段 name="${name}" ${Buffer.byteLength(value)}B：${value}`);
      }
    }
  } else {
    summary.push(`[multipart boundary 未解析，按原文保留 ${bytes.length} 字节]`);
    textPieces.push(decodeUtf8(bytes) ?? binaryRepresentation(bytes, contentType, createHash('sha256').update(bytes).digest('hex').slice(0, 32)));
  }
  return `[multipart/form-data 共 ${bytes.length} 字节，${summary.length} 个部分；字段与文件以类型感知表示送审，文件正文只含有界预览]\n${summary.join('\n')}${textPieces.length ? `\n${textPieces.join('\n')}` : ''}`;
}

/**
 * 冻结请求（{method,url,headers:[pairs],bodyBase64}）→ 送审规范投影：
 * headers 对象；bodyBase64 按 content-type 显式解码；multipart/二进制用类型感知表示。
 * 这是 jev-client reviewBody 消费的唯一入口，不重建第二份请求结构。
 */
export function projectRequestForReview(request = {}) {
  const headers = headerObject(request.headers);
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
  const bytes = Buffer.from(String(request.bodyBase64 ?? ''), 'base64');
  let body = '';
  if (bytes.length > 0) {
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    if (/multipart\/form-data/i.test(String(contentType))) body = multipartRepresentation(bytes, contentType);
    else {
      // UTF-8 可解码即按文本送审（含未声明/错标 content-type 的纯文本）；不可解码才走类型感知二进制表示。
      const decoded = decodeUtf8(bytes);
      body = decoded !== null ? decoded : binaryRepresentation(bytes, contentType, hash);
    }
  }
  return { method: String(request.method ?? ''), url: String(request.url ?? ''), headers, body };
}

export function buildOperationContext({
  sessionId = '',
  intentId = '',
  /* [local.143] 现场审计：Jev 载荷里的 title/detail 一直恒为空串（本函数从未接收它们），
   * 于是判定服务拿不到“用户声明的意图”，只能看到一笔请求 + 一句系统默认用途。 */
  intentTitle = '',
  intentDetail = '',
  callId = '',
  tool = '',
  command = '',
  cwd = '',
  args = {},
  justification = '',
  objective = '',
  authorization = '',
  scopeOrigin = '',
  goalTarget = '',
  expectedEvidence = '',
  request = null,
  plan = null,
  signals = []
} = {}) {
  const normSessionId = String(sessionId ?? '');
  const normCallId = String(callId ?? '');
  const payloadString = JSON.stringify({
    tool,
    command,
    args,
    request: request ? { method: request.method, url: request.url, headers: request.headers, bodyBase64: request.bodyBase64 } : null,
    plan: plan ? { maxRequests: plan.maxRequests, entriesCount: plan.entries?.length } : null
  });
  const digest = createHash('sha256').update(payloadString).digest('hex').slice(0, 16);
  // 无 callId 的出口捕获请求：用内容摘要做稳定诊断标识（授权身份仍由 broker requestDigest 绑定）。
  const operationId = normCallId
    ? `${normSessionId}:${tool || 'op'}:${normCallId}`
    : `${normSessionId}:${tool || 'op'}:req-${digest}`;

  return {
    operationId,
    sessionId: normSessionId,
    intentId: String(intentId ?? ''),
    intentTitle: String(intentTitle ?? ''),
    intentDetail: String(intentDetail ?? ''),
    tool: String(tool ?? ''),
    command: String(command ?? ''),
    cwd: String(cwd ?? ''),
    arguments: args,
    digest,
    justification: String(justification ?? ''),
    objective: String(objective ?? ''),
    authorization: String(authorization ?? ''),
    scopeOrigin: String(scopeOrigin ?? ''),
    goalTarget: String(goalTarget ?? ''),
    expectedEvidence: String(expectedEvidence ?? ''),
    request,
    plan,
    signals: Array.isArray(signals) ? signals : [],
    // 标记为模型解释，不直接作为安全保证
    modelInterpretation: Boolean(justification)
  };
}

/**
 * 将统一 Operation Context 投影为 Jev 评估参数。
 * - request 走 projectRequestForReview：headers 对象、正文按类型解码，不再丢 bodyBase64。
 * - scopeChecked 必须来自可信范围验证结果（如 broker.propose 已 assertScopeCurrent），
 *   由调用方显式传入；本函数绝不从 scopeOrigin/goalTarget 字符串推断"已验证授权"。
 * - 不透传 arguments 到 Jev：出口路径的请求投影已覆盖实际语义，避免全文多处重复（§11 减重）。
 */
export function operationContextToJev(context, { taskType = 'risk-grade', scopeChecked = false, verifiedTestObjects = [] } = {}) {
  return {
    taskType,
    operationId: context.operationId,
    tool: context.tool,
    command: context.command,
    cwd: context.cwd,
    title: context.intentTitle ?? '',
    detail: context.intentDetail ?? '',
    justification: context.justification,
    objective: context.objective,
    authorization: context.authorization,
    expectedEvidence: context.expectedEvidence,
    scopeOrigin: context.scopeOrigin,
    goalTarget: context.goalTarget,
    scopeChecked: scopeChecked === true,
    verifiedTestObjects,
    ...(context.request ? projectRequestForReview(context.request) : {}),
    ...(context.plan ? { plan: context.plan } : {})
  };
}
