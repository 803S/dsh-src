import assert from "node:assert/strict";
import test from "node:test";
import { apply } from "../lib/src.js";

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
  const exec = (sessionId, parentSession) => ({ agent: { session: { id: sessionId, header: parentSession ? { parentSession } : {} } } });
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
  assert.deepEqual(state.counts, { intents: 1, facts: 1, findings: 1, assets: 1, coverage: 0, research: 0, checkpoints: 2 });
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
  assert.deepEqual(replayed.counts, { intents: 1, facts: 1, findings: 1, assets: 1, coverage: 3, research: 1, checkpoints: 0 });
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
