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
function buildDelegatePrompt({ method, url, estimatedSteps, requiresIsolation, contextDependency }) {
  const u = new URL(url || "http://example");
  return `目标：${method} ${u.pathname}
协议：${u.protocol.slice(0,-1)}
估计步骤：${estimatedSteps ?? 3}
是否需要独立环境：${requiresIsolation ? "是" : "否"}
上下文依赖度：${contextDependency ?? "medium"}
问题：
  1. 这个子任务应该交给子代理还是主代理自己做？（choice：delegate / self）
     criteria: ["delegate","self"]
      判断标准：需要长时间运行/爆破穷举/独立环境 → delegate；需要主上下文决策/快速操作/写操作 → self`;
}

function buildSkillPrompt({ context, candidates, lastSkillUsed }) {
  const lines = (candidates || []).map((c) => `  ${c.id}（${c.kind}）：${c.title}${c.matchedBy?.length ? `，匹配信号=${c.matchedBy.join("/")}` : ""}${c.score ? `，分数=${c.score}` : ""}`).join("\n");
  return `当前请求上下文：${context?.method ?? "GET"} ${context?.path ?? ""}${context?.query ? " " + context.query : ""}
目标域：${context?.goalTarget ?? "(未知)"}
候选技能（${(candidates || []).length} 个，已按分数降序）：
${lines}
最近用过：${lastSkillUsed ?? "无"}
问题：
  1. 本次测试/委派最值得参考哪个技能？（choice：${(candidates || []).map((c) => c.id).join("/")}/skip）
     criteria: ["skip", ...${(candidates || []).map((c) => c.id)}]
  2. 置信度？（score：0-1）`;
}

/** 响应体语义分类 prompt（src_http 放行后对响应体调一次 choice 分类）。 */
export function buildResponsePrompt({ status, contentType, bodySnippet }) {
  return `响应状态：${status}
Content-Type：${contentType ?? "(无)"}
响应体（前 1KB）：
${String(bodySnippet ?? "").slice(0, 1024)}

问题：
  1. 这个响应属于哪类？（choice）
     criteria: ["normal", "waf-block", "auth-boundary", "error-leak", "rate-limit"]
  2. 是否含敏感信息泄露？（noul）`;
}

/**
 * Parse the daemon's actual `{ answers: {...} }` response without relying on
 * `type`. Older/local daemon responses may omit it; the semantic fields are
 * the stable contract (`choice`, `score`, `probabilities`, `confidence`).
 */
export function parseLayaAnswers(raw, fallback = {}) {
  const answers = raw?.answers && typeof raw.answers === "object" ? raw.answers : (raw ?? {});
  const entries = Object.entries(answers).filter(([, value]) => value && typeof value === "object");
  const choiceEntry = entries.find(([, value]) => typeof value.choice === "string" || value.type === "choice");
  const scoreEntry = entries.find(([, value]) => Number.isFinite(Number(value.score)) || value.type === "score");
  const choiceAnswer = choiceEntry?.[1];
  const scoreAnswer = scoreEntry?.[1];
  const action = typeof choiceAnswer?.choice === "string" ? choiceAnswer.choice : (fallback.action ?? "pending");
  const score = Number(scoreAnswer?.score);
  const confidence = Number(choiceAnswer?.confidence ?? scoreAnswer?.confidence ?? fallback.confidence ?? 0);
  const probabilities = choiceAnswer?.probabilities && typeof choiceAnswer.probabilities === "object"
    ? choiceAnswer.probabilities
    : (fallback.probabilities ?? {});
  return {
    answers,
    action,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    score: Number.isFinite(score) ? score : Number(fallback.score ?? 0),
    probabilities,
    choiceKey: choiceEntry?.[0] ?? "",
    scoreKey: scoreEntry?.[0] ?? ""
  };
}

export async function layaDecide(args, exec) {
  // 只对 commander 生效（子会话直接走原有流程）
  if (exec?.agent?.session?.header?.parentSession !== void 0) {
    return { action: "pending", confidence: 0, riskScore: 0 };
  }
  const { url, method, body, headers, credentialRef, taskType = "risk-grade" } = args;
  const sessionId = exec?.agent?.session?.id ?? "";
  const engagementId = "";

  /* [local.94] 兄弟问题修复：此前 layaDecide 完全忽略 args.taskType，delegate/skill-activate
     也走 risk-grade 的 prompt+schema，导致三种决策语义混同、telemetry 全是同一路结果。
     现按 taskType 分派：risk-grade=风险审批；delegate=主/子代理分工；skill-activate=技能排序。 */
  if (taskType === "delegate") {
    const prompt = buildDelegatePrompt({ method, url, estimatedSteps: args.estimatedSteps, requiresIsolation: args.requiresIsolation, contextDependency: args.contextDependency });
    const schema = { choice: { type: "choice", instructions: "子任务应交给子代理还是主代理自己做", criteria: ["delegate", "self"] } };
    return await layaRequest(prompt, schema, { action: "pending", confidence: 0, riskScore: 0 });
  }
  if (taskType === "skill-activate") {
    const candidates = args.candidates || [];
    if (candidates.length === 0) {
      // 规则层无正分候选 → 静默，不调 Laya（零模型开销）
      return { action: "skip", confidence: 0, riskScore: 0, matchedBy: [] };
    }
    const prompt = buildSkillPrompt({ context: { method: args.method, path: args.path, query: args.query, goalTarget: args.goalTarget }, candidates, lastSkillUsed: args.lastSkillUsed });
    const schema = { skill: { type: "choice", instructions: "本次测试/委派最值得参考哪个技能", criteria: ["skip", ...candidates.map((c) => c.id)] }, conf: { type: "score", instructions: "置信度 0-1", criteria: ["0", "1"] } };
    const r = await layaRequest(prompt, schema, { action: "skip", confidence: 0, riskScore: 0 });
    const picked = r.skill?.choice ?? "skip";
    const chosen = candidates.find((c) => c.id === picked);
    return { action: picked, confidence: r.conf?.confidence ?? r.confidence, riskScore: 0, matchedBy: chosen?.matchedBy ?? [], doc: chosen?.doc ?? "", title: chosen?.title ?? picked };
  }

  if (taskType === "response-classify") {
    const prompt = buildResponsePrompt({ status: args.status, contentType: args.contentType, bodySnippet: args.bodySnippet });
    const schema = {
      class: { type: "choice", instructions: "响应分类", criteria: ["normal", "waf-block", "auth-boundary", "error-leak", "rate-limit"] },
      leak: { type: "noul", instructions: "是否含敏感信息泄露", criteria: { "false": "无泄露", "true": "有泄露" } },
    };
    return await layaRequest(prompt, schema, { action: "normal", confidence: 0, riskScore: 0 });
  }

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
  const started = Date.now();
  try {
    const raw = await getClient().post("/decide", { text: prompt.trim(), schema });
    const parsed = parseLayaAnswers(raw, { action: "pending" });
    const answers = parsed.answers;
    const action = answers.action?.choice ?? parsed.action;
    const actionProb = Number(answers.action?.probabilities?.[action] ?? parsed.probabilities?.[action] ?? 0);
    const riskScore = Number(answers.risk?.score ?? parsed.score ?? 0);
    const riskProb = answers.risk?.probabilities ?? {};
    return {
      action,
      confidence: Number.isFinite(actionProb) ? Math.max(0, Math.min(1, actionProb)) : 0,
      riskScore: Number.isFinite(riskScore) ? Math.max(0, Math.min(5, riskScore)) : 0,
      probabilities: { ...riskProb, ...parsed.probabilities },
      source: "laya",
      fallback: false,
      latency: Date.now() - started
    };
  } catch (e) {
    // 若 Laya 不可达，fail-open：返回中性值，让后续走 classifyHttpRequest
    console.warn("[laya-client] Laya 决策不可达，fail-open:", e.message);
    return { action: "pending", confidence: 0, riskScore: 0, source: "fallback", fallback: true, latency: Date.now() - started };
  }
}

/** 通用 /decide 调用：解析 answers 层，失败 fail-open 返回 fallback。 */
async function layaRequest(prompt, schema, fallback) {
  const started = Date.now();
  try {
    const raw = await getClient().post("/decide", { text: String(prompt).trim(), schema });
    const parsed = parseLayaAnswers(raw, fallback);
    return {
      ...parsed.answers,
      action: parsed.action,
      confidence: parsed.confidence,
      probabilities: parsed.probabilities,
      source: "laya",
      fallback: false,
      latency: Date.now() - started
    };
  } catch (e) {
    console.warn("[laya-client] Laya 决策不可达，fail-open:", e.message);
    return { ...fallback, source: "fallback", fallback: true, latency: Date.now() - started };
  }
}