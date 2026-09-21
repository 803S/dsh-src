// lib/src/decision/laya-client.js
// Laya 决策引擎客户端封装：把 dsh 的 http 请求特征转换成 Laya 可识别的问题格式，
// 调用守护进程的 /decide 接口，并解析结果。
// 纪律：惰性加载单例、250ms 超时、fail-open（守护进程不可达时返回中性值让原有流程继续）。

const DEFAULT_URL = "http://127.0.0.1:3166";
const TIMEOUT_MS = 250;

let _client = null;

function getClient() {
  if (!_client) {
    _client = {
      baseURL: process.env.DSH_SRC_LAYA_URL ?? DEFAULT_URL,
      async post(path, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch(`${this.baseURL}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal
          });
          const txt = await res.text();
          clearTimeout(timeout);
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt}`);
          return JSON.parse(txt);
        } catch (e) {
          clearTimeout(timeout);
          throw e;
        }
      }
    };
  }
  return _client;
}

/**
 * 把 http 请求特征压成 Laya 能理解的文本（单行，≤1024 tokens）
 */
function buildLayaPrompt({ method, url, body, headers, credentialRef, sessionId, engagementId }) {
  const u = new URL(url);
  const hasAuth = !!credentialRef || /(cookie|authorization)/i.test(Object.keys(headers).join(" "));
  const ct = headers["content-type"] ?? headers["Content-Type"] ?? "";
  const isJsonBody = body && typeof body === "string" && /^[{[]/.test(body.trim());
  const lenBody = Buffer.from(body ?? "", "utf8").length;
  const pathDepth = u.pathname.split("/").filter(Boolean).length;
  const hasSensitive = /(pass|pwd|token|secret|key|sql|shell|exec|eval)/i.test(
    (u.pathname + " " + (body ?? "")).toLowerCase()
  );

  return `目标：${method} ${u.pathname}${u.search}
协议：${u.protocol.slice(0, -1)}
是否有认证头：${hasAuth ? "是" : "否"}
Content-Type：${ct || "(无)"}
请求体长度：${lenBody} 字节
路径深度：${pathDepth}
请求体是否像 JSON：${isJsonBody ? "是" : "否"}
是否含敏感关键词：${hasSensitive ? "是" : "否"}
最近 1 分钟该 host 请求率：0
问题：
  1. 这笔流量的危害等级是什么？（score：0-5 分，0 无害，5 必须拦截）
      criteria: ["0","1","2","3","4","5"]
  2. 建议动作是什么？（choice：allow / pending / reject）
      criteria: ["allow","pending","reject"]`;
}

/**
 * 调用 Laya 决策（供 commander 使用）
 * @returns {Promise<{action:string, confidence:number, riskScore:number}>}
 *          action ∈ {"allow","pending","reject"}
 *          confidence ∈ [0,1]（取 action 与 riskScore 两者置信度的最小值）
 *          riskScore ∈ [0,5]（来自 score 问题的期望值）
 */
export async function layaDecide(args, exec) {
  // 只对 commander 生效（子会话直接走原有流程）
  if (exec?.agent?.session?.header?.parentSession !== void 0) {
    return { action: "pending", confidence: 0, riskScore: 0 };
  }
  const { url, method, body, headers, credentialRef } = args;
  const sessionId = exec?.agent?.session?.id ?? "";
  const engagementId = "";

  const prompt = buildLayaPrompt({ method, url, body, headers, credentialRef, sessionId, engagementId });
  const schema = {
    risk: {
      type: "score",
      instructions: "危害等级 0-5 分，0 完全无害，5 必须拦截",
      criteria: ["0", "1", "2", "3", "4", "5"]
    },
    action: {
      type: "choice",
      instructions: "建议的处置动作",
      criteria: ["allow", "pending", "reject"]
    }
  };
  try {
    const raw = await getClient().post("/decide", { text: prompt.trim(), schema });
    const riskScore = parseFloat(raw.risk?.score ?? "0");
    const action = raw.action?.choice ?? "pending";
    const confidence = Math.min(
      parseFloat(raw.risk?.confidence ?? "0"),
      parseFloat(raw.action?.confidence ?? "0")
    );
    return { action, confidence, riskScore };
  } catch (e) {
    // 若 Laya 不可达，fail-open：返回中性值，让后续走 classifyHttpRequest
    console.warn("[laya-client] Laya 决策不可达，fail-open:", e.message);
    return { action: "pending", confidence: 0, riskScore: 0 };
  }
}