import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBrowserCandidates,
  browserFingerprint,
  browserActionArguments,
  guardBrowserCandidate,
  extractSnapshotText,
  MCP_TOOL_NAMES,
  runBrowserLoop,
  createBrowserTelemetry
} from "../lib/src/decision/browser-loop.js";

test("browser adapter creates conservative indexed candidates from snapshot", () => {
  const snapshot = 'button "Continue" [ref=e2]\ntextbox "Name" [ref=e3]';
  const candidates = buildBrowserCandidates(snapshot);
  assert.deepEqual(candidates, [
    { index: 0, operation: "click", targetRef: "e2", label: 'button "Continue"', allowed: true, guard: { page: "same-fingerprint" } }
  ]);
  assert.equal(candidates.some((candidate) => candidate.operation === "done"), false);
});

test("browser adapter extracts MCP content and keeps fingerprints stable", () => {
  const result = { content: [{ type: "text", text: 'button "Continue" [ref=e2]' }] };
  assert.equal(extractSnapshotText(result), 'button "Continue" [ref=e2]');
  assert.equal(browserFingerprint("abc"), browserFingerprint("abc"));
  assert.notEqual(browserFingerprint("abc"), browserFingerprint("abd"));
});

test("browser hard guard rejects stale and illegal actions", () => {
  const candidates = buildBrowserCandidates('button "Continue" [ref=e2]');
  const candidate = candidates[0];
  assert.deepEqual(guardBrowserCandidate({ candidate, candidates, observationFingerprint: "old", currentObservationFingerprint: "new", allowedUrl: true }), { allowed: false, code: "stale_observation" });
  assert.deepEqual(guardBrowserCandidate({ candidate: { ...candidate, operation: "evaluate" }, candidates: [...candidates, { ...candidate, operation: "evaluate" }], observationFingerprint: "same", currentObservationFingerprint: "same", allowedUrl: true }), { allowed: false, code: "operation_not_allowed" });
  assert.deepEqual(guardBrowserCandidate({ candidate, candidates, observationFingerprint: "same", currentObservationFingerprint: "same", currentObservation: 'button "Continue" [ref=e2]', allowedUrl: true }), { allowed: true, code: "" });
  assert.deepEqual(guardBrowserCandidate({ candidate: { index: 1, operation: "wait", targetRef: null, label: "等待页面稳定", allowed: true }, candidates, observationFingerprint: "same", currentObservationFingerprint: "same", allowedUrl: true }), { allowed: true, code: "" });
  assert.deepEqual(browserActionArguments(candidate), { target: "e2", element: 'button "Continue"' });
});

test("browser adapter uses the existing Playwright MCP names", () => {
  assert.equal(MCP_TOOL_NAMES.snapshot, "mcp__playwright__browser_snapshot");
  assert.equal(MCP_TOOL_NAMES.click, "mcp__playwright__browser_click");
  assert.equal(MCP_TOOL_NAMES.wait, "mcp__playwright__browser_wait_for");
});

test("browser telemetry is lossless enough and sink failures do not block", () => {
  const rows = [];
  const emit = createBrowserTelemetry({ agent: { session: { id: "session-test" } } }, {
    engagementId: "engagement-test",
    telemetry: (event, payload) => rows.push({ event, payload })
  });
  emit("browser.action", { operation: "wait", executed: true, success: true });
  assert.equal(rows[0].payload.sessionId, "session-test");
  assert.equal(rows[0].payload.engagementId, "engagement-test");
  assert.equal(rows[0].payload.taskType, "browser");
  assert.equal(rows[0].payload.adopted, false);
  assert.doesNotThrow(() => createBrowserTelemetry({}, { telemetry: () => { throw new Error("sink down"); } })("browser.action", {}));
});

test("browser loop delegates every action to the host executor and falls back safely", async () => {
  const calls = [];
  const events = [];
  const owner = { agent: { session: { header: { parentSession: null } } } };
  const snapshots = [
    'button "Continue" [ref=e2]',
    'button "Continue" [ref=e2]',
    'button "Continue" [ref=e2]'
  ];
  const result = await runBrowserLoop({
    goal: "继续本地 fixture",
    allowedUrl: true,
    decide: async () => ({ index: -1, confidence: 0, fallback: true, source: "timeout", latency: 250 }),
    executeTool: async (name, args, exec) => {
      calls.push({ name, args, exec });
      if (name === MCP_TOOL_NAMES.snapshot) return { content: [{ type: "text", text: snapshots.shift() }] };
      return { isError: false, value: { ok: true } };
    },
    telemetry: (event, payload) => events.push({ event, payload })
  }, owner);
  assert.equal(result.executed, true);
  assert.equal(result.success, true);
  assert.equal(calls[0].name, MCP_TOOL_NAMES.snapshot);
  assert.equal(calls[1].name, MCP_TOOL_NAMES.snapshot);
  assert.equal(calls[2].name, MCP_TOOL_NAMES.wait);
  assert.deepEqual(calls[2].args, { time: 0.05 });
  assert.equal(calls.every((call) => call.exec === owner), true);
  assert.deepEqual(events.map((item) => item.event), ["browser.observation", "browser.decision", "browser.guard", "browser.action"]);
  assert.equal(events[1].payload.adopted, false);
  assert.equal(events[3].payload.adopted, false);
});

test("browser loop reports action errors without pretending success", async () => {
  const events = [];
  const result = await runBrowserLoop({
    allowedUrl: true,
    decide: async () => ({ index: 0, confidence: 1, fallback: false, source: "test", latency: 1 }),
    telemetry: (event, payload) => events.push({ event, payload }),
    executeTool: async (name) => name === MCP_TOOL_NAMES.snapshot
      ? { content: [{ type: "text", text: 'button "Continue" [ref=e2]' }] }
      : { isError: true, content: [{ type: "text", text: "click failed" }] }
  }, {});
  assert.equal(result.executed, true);
  assert.equal(result.success, false);
  assert.equal(events.at(-1).payload.failureCode, "tool_error");
});

test("browser loop stops on snapshot errors without executing an action", async () => {
  const events = [];
  await assert.rejects(() => runBrowserLoop({
    allowedUrl: true,
    telemetry: (event, payload) => events.push({ event, payload }),
    executeTool: async () => ({ isError: true, content: [{ type: "text", text: "closed" }] })
  }, {}), /browser snapshot failed/);
  assert.deepEqual(events.map((item) => item.event), ["browser.observation"]);
  assert.equal(events[0].payload.success, false);
  assert.equal(events[0].payload.failureCode, "snapshot_error");
});
