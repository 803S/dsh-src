import test from "node:test";
import assert from "node:assert/strict";
import { issueApprovalGrant, consumeApprovalGrant } from "../lib/src/approval-grants.js";
import { beforeRepeat, afterRepeat, resetRepeatGuardForTests } from "../lib/src/repeat-guard.js";
import { applySrcEvent, srcInitialState } from "../lib/src.js";

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
