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
      baseURL: String(process.env.DSH_SRC_LAYA_URL ?? DEFAULT_URL),
      async post(path, body) {
        this.baseURL = String(process.env.DSH_SRC_LAYA_URL ?? DEFAULT_URL);
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
function buildToolAdvisoryPrompt({ tool, body }) {
  return `模型准备调用工具：${tool}\n调用参数摘要：${String(body ?? "").slice(0, 5000)}\n只判断是否需要提示：continue=允许原工具继续；src-http=如果这是网络请求且能用src_http替代则提醒；pending=可能有副作用，交给既有审批/规则处理。Laya不拥有阻断权限。`;
}

function buildDelegatePrompt({ method, url, estimatedSteps, requiresIsolation, contextDependency }) {
  const u = new URL(url || "http://example");
  return `目标：${method} ${u.pathname}\n协议：${u.protocol.slice(0,-1)}\n估计步骤：${estimatedSteps ?? 3}\n是否需要独立环境：${requiresIsolation ? "是" : "否"}\n上下文依赖度：${contextDependency ?? "medium"}\n问题：\n  1. 这个子任务应该交给子代理还是主代理自己做？（choice：delegate / self）\n     criteria: ["delegate","self"]\n      判断标准：需要长时间运行/爆破穷举/独立环境 → delegate；需要主上下文决策/快速操作/写操作 → self`;
}

function buildBrowserPrompt({ goal, observation, fingerprint, candidates }) {
  const lines = (candidates || []).map((c) => `  ${c.index}: ${c.operation}${c.targetRef ? ` target=${c.targetRef}` : ""} label=${c.label ?? ""}`).join("\n");
  return `目标：${String(goal ?? "完成当前页面动作")}
observation fingerprint：${String(fingerprint ?? "")}
页面 observation（只读）：
${String(observation ?? "").slice(0, 12000)}
代码生成候选（只能选择 index）：
${lines}
规则：只选择一个候选 index；如果存在与目标直接匹配的 click 候选，必须优先选择 click，不要选择 wait；wait 仅用于没有可执行目标或页面需要稳定等待；不要生成 selector、URL、坐标、JavaScript、工具名或任意参数；没有 done 候选。`;
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
  const { url, method, body, headers, credentialRef, taskType = "risk-grade" } = args;
  // 只对 commander 生效（子会话直接走原有流程）；browser-index 仍是薄层的
  // 本地候选选择，不改变子代理的 SRC 工具权限或生命周期。
  if (exec?.agent?.session?.header?.parentSession !== void 0 && taskType !== "browser-index") {
    return { action: "pending", confidence: 0, riskScore: 0 };
  }
  const sessionId = exec?.agent?.session?.id ?? "";
  const engagementId = "";

  /* [local.94] 兄弟问题修复：此前 layaDecide 完全忽略 args.taskType，delegate/skill-activate
     也走 risk-grade 的 prompt+schema，导致三种决策语义混同、telemetry 全是同一路结果。
     现按 taskType 分派：risk-grade=风险审批；delegate=主/子代理分工；skill-activate=技能排序。 */
  if (taskType === "tool-advisory") {
    const prompt = buildToolAdvisoryPrompt({ tool: args.tool ?? url, body });
    const schema = { action: { type: "choice", instructions: "选择工具旁路建议，不执行阻断", criteria: ["continue", "src-http", "pending"] } };
    const r = await layaRequest(prompt, schema, { action: "continue", confidence: 0 });
    return { ...r, action: r.action?.choice ?? r.action };
  }

  if (taskType === "next-action") {
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    if (candidates.length === 0) return { action: "continue", confidence: 0, probabilities: {}, source: "rules", fallback: true, latency: 0 };
    const lines = candidates.map((c) => `  ${c.id}: ${c.label}`).join("\n");
    const prompt = `当前SRC决策状态：\n${String(args.stateSummary ?? "").slice(0, 8000)}\n候选下一动作：\n${lines}\n只选择一个候选id。优先选择能消费已有证据/解除阻塞/推进未完成intent的动作，不要重复已完成工作。`;
    const schema = { action: { type: "choice", instructions: "选择下一动作候选id", criteria: candidates.map((c) => c.id) } };
    const r = await layaRequest(prompt, schema, { action: candidates[0].id, confidence: 0 });
    return { ...r, action: r.action?.choice ?? r.action };
  }

  if (taskType === "delegate") {
    const prompt = buildDelegatePrompt({ method, url, estimatedSteps: args.estimatedSteps, requiresIsolation: args.requiresIsolation, contextDependency: args.contextDependency });
    const schema = { choice: { type: "choice", instructions: "子任务应交给子代理还是主代理自己做", criteria: ["delegate", "self"] } };
    return await layaRequest(prompt, schema, { action: "pending", confidence: 0, riskScore: 0 });
  }
  if (taskType === "browser-index") {
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    if (candidates.length === 0) return { action: "-1", confidence: 0, probabilities: {}, source: "rules", fallback: true, latency: 0 };
    const prompt = buildBrowserPrompt({ goal: args.goal, observation: args.observation, fingerprint: args.fingerprint, candidates });
    const schema = {
      index: { type: "choice", instructions: "只选择代码提供的一个候选 index", criteria: candidates.map((c) => String(c.index)) }
    };
    const r = await layaRequest(prompt, schema, { action: "-1", confidence: 0 });
    return { ...r, action: r.index?.choice ?? r.action };
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