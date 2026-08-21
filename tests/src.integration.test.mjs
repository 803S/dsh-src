import assert from "node:assert/strict";
import test from "node:test";
import { apply, parseTodoFeedback, srcInitialState, applySrcEvent, viewSrcState } from "../lib/src.js";

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
  const ctx = {
    storageDomain: { open: async () => domain },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    sessions: { get(id) { return sessions.get(id); } },
    effect() {},
    inject(names, callback) {
      if (names.includes("sessionProjections")) callback({ sessionProjections: { register(spec) { projections.set(spec.key, spec); } } });
      if (names.includes("systemPrompt")) callback({ systemPrompt: { section(spec) { prompts.push(spec); } } });
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
  const run = (name, args, execution) => tools.get(name).execute(args, execution);
  return { domain, tools, sessions, projections, prompts, exec, run };
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
    findings: [{ title: "Public diagnostic endpoint", severity: "low", description: "Exposes build metadata", impact: "Leaks deployment information", affectedScope: "Unauthenticated visitors to the health endpoint", remediation: "Remove build metadata from the response", pocEvidence: ["GET /health -> 200 with build field"], reproducibleSteps: ["GET /health"] }]
  };
  const firstBatch = await h.run("src_submit", { ...batch, stage: "progress", summary: "initial evidence" }, child);
  assert.deepEqual({ facts: firstBatch.facts, assets: firstBatch.assets, findings: firstBatch.findings, stage: firstBatch.stage }, { facts: 1, assets: 1, findings: 1, stage: "progress" });
  const duplicateBatch = await h.run("src_submit", { ...batch, stage: "completed", summary: "verification complete" }, child);
  assert.deepEqual({ facts: duplicateBatch.facts, assets: duplicateBatch.assets, findings: duplicateBatch.findings, stage: duplicateBatch.stage }, { facts: 0, assets: 0, findings: 0, stage: "completed" });
  const repeated = await h.run("src_submit", { ...batch, stage: "completed", summary: "verification complete" }, child);
  assert.equal(repeated.duplicateCheckpoint, true);
  assert.equal(parentEvents.length, 5, "duplicate checkpoints must not append another projection event");

  const state = await h.run("src_state", {}, parent);
  assert.deepEqual(state.counts, { intents: 1, facts: 1, findings: 1, assets: 1, coverage: 0, research: 0, checkpoints: 2, observations: 0, userTodos: 0 });
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
  const blocked = await h.run("src_finalize_engagement", {}, parent);
  assert.equal(blocked.ready, false);
  assert.match(blocked.blockers[0], /未完成 intent/);
  const allowed = await h.run("src_finalize_engagement", { allowIncomplete: true }, parent);
  assert.equal(allowed.ready, true);
  assert.match(allowed.warnings.join(" "), /覆盖率/);
});

test("asset observations, research matrix, and coverage survive state and report", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "example.test", objective: "coverage", authorization: "ticket" }, parent);
  const intent = await h.run("src_add_intent", { title: "recon", goalId: "goal-1" }, parent);
  const asset = await h.run("src_record_asset_observation", { intentId: intent.id, type: "subdomain", value: "api.example.test", source: "crt.sh", method: "passive", confidence: 0.9, status: "candidate" }, parent);
  const research = await h.run("src_record_research", { intentId: intent.id, category: "authorization", hypothesis: "Object IDs may be cross-tenant accessible", preconditions: ["two test accounts"], status: "blocked", stopReason: "no approved second account", evidence: ["scope restriction"] }, parent);
  const coverage = await h.run("src_record_coverage", { assetId: asset.assetId, phase: "web", category: "authentication", status: "blocked", limitation: "WAF challenge", evidence: ["preflight 403"] }, parent);
  const state = await h.run("src_state", {}, parent);
  assert.equal(state.assets[0].source, "crt.sh");
  assert.equal(state.research[0].id, research.id);
  assert.equal(state.coverage[0].id, coverage.id);
  const report = await h.run("src_report", {}, parent);
  assert.match(report.markdown, /资产与测试覆盖率/);
  assert.match(report.markdown, /漏洞研究矩阵/);
  await h.run("src_record_asset_observation", { intentId: intent.id, type: "subdomain", value: "API.EXAMPLE.TEST", source: "DNS", method: "low-impact", confidence: 1, status: "confirmed" }, parent);
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
    findings: [{ title: "invalid reference", severity: "high", impact: "test impact", affectedScope: "test scope", remediation: "test remediation", pocEvidence: ["test evidence"], reproducibleSteps: ["step"], affectedAssetId: "asset-404" }]
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
    const result = await h.run("src_finalize_engagement", { allowIncomplete: true }, parent);
    assert.equal(result.ready, true);
    assert.match(result.warnings.join(" "), /API\/接口资产尚未进入研究或覆盖推进/);
    assert.match(result.warnings.join(" "), /仍停留在自动生成骨架/);
    assert.equal(result.blockers.some((b) => /未完成漏洞研究假设/.test(b)), true);
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
  assert.deepEqual(replayed.counts, { intents: 1, facts: 1, findings: 1, assets: 1, coverage: 3, research: 1, checkpoints: 0, observations: 0, userTodos: 0 });
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
    const finalize = await h.run("src_finalize_engagement", { allowIncomplete: true }, parent);
    assert.equal(finalize.ready, true);
    const report = await h.run("src_report", {}, parent);
    assert.match(report.markdown, /## API 发现摘要/);
    assert.match(report.markdown, /## 漏洞研究矩阵/);

    // 6) state summary reflects the whole engagement
    const state = await h.run("src_state", {}, parent);
    assert.equal(state.apiDiscovery.total >= 1, true);
    assert.equal(state.counts.intents, 1);
  } finally { globalThis.fetch = originalFetch; }
});




test("finalize blocks info/low-only findings as insufficient real harm", async () => {
  const h = harness();
  const parent = h.exec("p");
  await h.run("src_add_goal", { target: "https://example.test", objective: "找到真实危害漏洞", authorization: "SRC" }, parent);
  await h.run("src_add_intent", { title: "audit", detail: "x", goalId: "goal-1" }, parent);
  await h.run("src_update_intent", { intentId: "intent-1", status: "completed" }, parent);
  await h.run("src_add_finding", { intentId: "intent-1", title: "版本指纹泄露", severity: "low", impact: "暴露版本号", affectedScope: "全站", remediation: "隐藏版本", pocEvidence: ["GET / => VAppServer/6.0.0"], reproducibleSteps: ["GET /"] }, parent);
  await h.run("src_record_research", { intentId: "intent-1", category: "info-leak", hypothesis: "版本泄露", status: "verified", findingId: "finding-1" }, parent);
  const blocked = await h.run("src_finalize_engagement", {}, parent);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers.some((b) => /真实危害/.test(b)), true);
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
  await h.run("src_add_finding", { intentId: "intent-1", title: "越权读取简历", severity: "high", impact: "泄露", affectedScope: "全站", remediation: "鉴权", pocEvidence: ["GET /resume?id=2 -> 200"], reproducibleSteps: ["GET /resume?id=2"] }, p1);
  await h.run("src_record_research", { intentId: "intent-1", category: "authorization-bypass", hypothesis: "id 越权", status: "verified", findingId: "finding-1" }, p1);
  const blocked = await h.run("src_finalize_engagement", {}, p1);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers.some((b) => /rawRequest/.test(b)), true);
  // 通过部分：独立 session，带全字段
  const p2 = h.exec("full");
  await h.run("src_add_goal", { target: "https://app.example.test", objective: "通过", authorization: "SRC" }, p2);
  await h.run("src_add_intent", { title: "越权", goalId: "goal-1" }, p2);
  await h.run("src_update_intent", { intentId: "intent-1", status: "completed" }, p2);
  await h.run("src_add_finding", { intentId: "intent-1", title: "越权读取他人简历", severity: "high", impact: "任意学生简历泄露", affectedScope: "全站学生", remediation: "后端鉴权", pocEvidence: ["GET /resume?id=2 -> 200"], reproducibleSteps: ["GET /resume?id=2"], entryPoint: "简历查看页-详情", discoveryPath: "Burp proxy history 导入 app.example.test/api/resume", rawRequest: "GET /resume?id=2 HTTP/1.1\r\nHost: app.example.test\r\nCookie: SESSION=x\r\n\r\n", rawResponse: "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"id\":2,\"name\":\"他人\"}" }, p2);
  await h.run("src_record_research", { intentId: "intent-1", category: "authorization-bypass", hypothesis: "id 越权", status: "verified", findingId: "finding-1" }, p2);
  const ok = await h.run("src_finalize_engagement", {}, p2);
  assert.equal(ok.ready, true);
  const report = await h.run("src_report", {}, p2);
  assert.match(report.markdown, /前端功能点: 简历查看页-详情/);
  assert.match(report.markdown, /漏洞接口来源: Burp proxy history/);
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
