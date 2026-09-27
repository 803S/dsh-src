import test from "node:test";
import assert from "node:assert/strict";
import { issueApprovalGrant, consumeApprovalGrant } from "../lib/src/approval-grants.js";
import { beforeRepeat, afterRepeat, resetRepeatGuardForTests } from "../lib/src/repeat-guard.js";
import { applySrcEvent, srcInitialState } from "../lib/src.js";
import { classifyHttpRequest } from "../lib/src/security.js";
import { keylessSearchProvider } from "../lib/src/web-search-provider.js";
import { patternShapeError } from "../lib/src/lessons.js";
import { layaDecide } from "../lib/src/decision/laya-client.js";

test("project defect guard: read-only POST shapes do not create approval debt", () => {
  assert.equal(classifyHttpRequest({ method: "POST", path: "/mcp/", headers: { authorization: "Bearer x" }, body: '{"method":"tools/list"}' }).require, false);
  assert.equal(classifyHttpRequest({ method: "POST", path: "/utils/transform_request", headers: {}, body: '{"model":"x"}' }).require, false);
});

test("project defect guard: search parser rejects generic Google feedback navigation", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => String(url).includes("duckduckgo")
      ? new Response("<html>blocked</html>", { status: 200 })
      : new Response('<a href="https://support.google.com/websearch">意見</a>', { status: 200 });
    await assert.rejects(() => keylessSearchProvider.search({ query: "fixture", engine: "google" }), /no parseable results|unavailable/);
  } finally { globalThis.fetch = previous; }
});

test("project defect guard: pattern shape permits abstract terms but rejects target paths", () => {
  assert.equal(patternShapeError("ASGI request URL parsing and host-derived route shape"), "");
  assert.match(patternShapeError("request.url.path /api/admin"), /不能枚举/);
  assert.match(patternShapeError("https://example.com"), /域名\/URL/);
});

test("project defect guard: Laya risk prompt sees actual api-key auth headers", async () => {
  const previous = globalThis.fetch;
  try {
    let prompt = "";
    globalThis.fetch = async (_url, init) => { const body = JSON.parse(init.body); prompt = body.text; return new Response(JSON.stringify(body.schema?.action ? { answers: { action: { choice: "allow", probabilities: { allow: 1 }, confidence: 1 }, risk: { score: 0, confidence: 1 } } } : { answers: { action: { choice: "inspect-state", probabilities: { "inspect-state": 0.98 }, confidence: 0.98 } } }), { status: 200 }); };
    const result = await layaDecide({ taskType: "risk-grade", url: "http://example.test/x", method: "GET", headers: { "api-key": "secret" }, body: "{}" }, { agent: { session: { id: "laya-risk-test" } } });
    assert.equal(result.action, "allow");
    assert.match(prompt, /是否有认证头：是/);
  } finally { globalThis.fetch = previous; }
});

test("project defect guard: failed approval resolution restores pending projection", () => {
  const call = { type: "tool/call", data: { callId: "approval-call", name: "src_resolve_approval", arguments: JSON.stringify({ id: "approval-1", action: "allow", approvalSource: "human-command" }) } };
  let state = applySrcEvent(srcInitialState, { type: "tool/call", data: { name: "src_add_goal", arguments: JSON.stringify({ target: "example.test", objective: "approval" }) } });
  state = applySrcEvent(state, { type: "tool/call", data: { name: "src_record_pending_approval", arguments: JSON.stringify({ id: "approval-1", method: "POST", url: "https://example.test/read", path: "/read", category: "test", reason: "test", justification: "test" }) } });
  state = applySrcEvent(state, call);
  assert.equal(state.pendingApprovals[0].status, "approved");
  state = applySrcEvent(state, { type: "tool/result", data: { message: { content: [{ toolCallId: "approval-call", isError: true }] } } });
  assert.equal(state.pendingApprovals[0].status, "pending");
});

test("project defect guard: human approval grant is scoped and one-shot", () => {
  const token = issueApprovalGrant("session-a", "approval-1", "allow");
  assert.equal(consumeApprovalGrant(token, "session-b", "approval-1", "allow"), false);
  assert.equal(consumeApprovalGrant(token, "session-a", "approval-1", "reject"), false);
  assert.equal(consumeApprovalGrant(token, "session-a", "approval-1", "allow"), true);
  assert.equal(consumeApprovalGrant(token, "session-a", "approval-1", "allow"), false);
});

test("project defect guard: identical unchanged tool calls stop after bounded retries", () => {
  resetRepeatGuardForTests();
  const exec = { name: "src_http", arguments: { url: "http://example.test/a", method: "GET" }, agent: { session: { id: "repeat-test" } } };
  for (let i = 0; i < 4; i += 1) {
    const decision = beforeRepeat(exec);
    assert.equal(decision.allowed, true);
    afterRepeat(exec, decision.fingerprint, { status: 200, body: "same" });
  }
  assert.equal(beforeRepeat(exec).allowed, false);
  const changed = { ...exec, arguments: { ...exec.arguments, url: "http://example.test/b" } };
  assert.equal(beforeRepeat(changed).allowed, true);
});

test("project defect guard: failed finding tool result rolls back only this call's finding", () => {
  const call = (callId, title) => ({ type: "tool/call", data: { callId, name: "src_add_finding", arguments: JSON.stringify({ intentId: "intent-1", title, severity: "low", impact: "impact", affectedScope: "scope", remediation: "fix", pocEvidence: ["e"], reproducibleSteps: ["step"] }) } });
  let state = applySrcEvent(srcInitialState, { type: "tool/call", data: { name: "src_add_goal", arguments: JSON.stringify({ target: "example.test", objective: "test" }) } });
  state = applySrcEvent(state, { type: "tool/call", data: { name: "src_add_intent", arguments: JSON.stringify({ goalId: "goal-1", title: "intent" }) } });
  state = applySrcEvent(state, call("call-1", "old finding"));
  state = applySrcEvent(state, call("call-2", "new finding"));
  assert.equal(state.nodes.filter((node) => node.kind === "finding").length, 2);
  state = applySrcEvent(state, { type: "tool/result", data: { message: { content: [{ toolCallId: "call-2", isError: true }] } } });
  assert.deepEqual(state.nodes.filter((node) => node.kind === "finding").map((node) => node.title), ["old finding"]);
});
