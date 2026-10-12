/* [jev-approval-simplification 2026-10-12 §9 第一步验收] 最终 payload 线缆断言：
 * ①正文投影（文本/JSON重复键/multipart/二进制/空body）不丢不假装为空；②credential 保护
 * （headers 对象形状 → requestSecrets 可提取 → reviewBody/sanitize 脱敏）；③read/delete
 * 对照的最终 payload 不同（不会只改 expected 掩盖丢输入）；④scopeChecked 是显式可信位，
 * 不由 scopeOrigin/goalTarget 字符串推导；⑤operationId 保留真实 callId，无 callId 时稳定
 * 摘要标识（不再用 Date.now）。 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildOperationContext, operationContextToJev, projectRequestForReview } from "../lib/src/decision/operation-context.js";
import { assessEgressPlan } from "../lib/src/egress/advisor.js";
import { jevDecide } from "../lib/src/decision/jev-client.js";
import { requestSecrets } from "../lib/src/evidence-output.js";
import { saveDecisionSettings } from "../lib/src/decision/service-settings.js";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

test("projection: json duplicate keys, text, empty body, binary, multipart are preserved for review", () => {
  const json = projectRequestForReview({ method: "POST", url: "https://fixture.test/api", headers: [["content-type", "application/json"]], bodyBase64: b64('{"op":"read","op":"delete","note":"delete_all_customer_records"}') });
  assert.match(json.body, /"op":\s*"read"/);
  assert.match(json.body, /"op":\s*"delete"/);
  assert.match(json.body, /delete_all_customer_records/);

  const text = projectRequestForReview({ method: "PUT", url: "https://fixture.test/x", headers: [["content-type", "text/plain"]], bodyBase64: b64("上传测试标记 marker-123") });
  assert.equal(text.body, "上传测试标记 marker-123");

  const empty = projectRequestForReview({ method: "GET", url: "https://fixture.test/", headers: [], bodyBase64: "" });
  assert.equal(empty.body, "");

  const binary = projectRequestForReview({ method: "POST", url: "https://fixture.test/bin", headers: [["content-type", "application/octet-stream"]], bodyBase64: Buffer.from([0, 159, 146, 150]).toString("base64") });
  assert.match(binary.body, /二进制 application\/octet-stream/);
  assert.match(binary.body, /sha256=[0-9a-f]{32}/);
  assert.ok(binary.body.length > 40, "二进制不能被丢或当空字符串");

  const boundary = "----fixture-boundary";
  const multipartBody = [`--${boundary}`, 'Content-Disposition: form-data; name="description"', "", "上传标记文件", `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="marker.txt"', "Content-Type: text/plain", "", "marker-content-1", `--${boundary}--`, ""].join("\r\n");
  const multipart = projectRequestForReview({ method: "POST", url: "https://fixture.test/upload", headers: [["content-type", `multipart/form-data; boundary=${boundary}`]], bodyBase64: b64(multipartBody) });
  assert.match(multipart.body, /multipart\/form-data/);
  assert.match(multipart.body, /name="description"/);
  assert.match(multipart.body, /filename="marker\.txt"/);
  assert.match(multipart.body, /marker-content-1/);
});

test("projection: duplicate headers join into object; credential headers stay extractable for scrubbing", () => {
  const projected = projectRequestForReview({ method: "GET", url: "https://fixture.test/", headers: [["accept", "*/*"], ["cookie", "session=secret-cookie-value"], ["authorization", "Bearer sk-abc"]], bodyBase64: "" });
  assert.equal(projected.headers.accept, "*/*");
  assert.equal(projected.headers.cookie, "session=secret-cookie-value");
  const secrets = requestSecrets(projected.headers);
  assert.ok(secrets.includes("session=secret-cookie-value"), "旧 pairs 形状下 Object.entries 提取不到 cookie；对象形状必须能提取");
  assert.ok(secrets.includes("sk-abc"));
  assert.ok(secrets.includes("secret-cookie-value"));
});

test("operation context: scopeChecked is an explicit trusted bit, never derived from strings; id is stable and callId-bearing", () => {
  const derived = buildOperationContext({ sessionId: "s", tool: "bash", justification: "j", scopeOrigin: "https://fixture.test", goalTarget: "fixture.test" });
  assert.equal(operationContextToJev(derived).scopeChecked, false, "不得由 scopeOrigin/goalTarget 推导出已验证授权");
  assert.equal(operationContextToJev(derived, { scopeChecked: true }).scopeChecked, true);

  const noCall = buildOperationContext({ sessionId: "s", tool: "src_http", request: { method: "GET", url: "https://fixture.test/", headers: [], bodyBase64: "" } });
  const noCallAgain = buildOperationContext({ sessionId: "s", tool: "src_http", request: { method: "GET", url: "https://fixture.test/", headers: [], bodyBase64: "" } });
  assert.equal(noCall.operationId, noCallAgain.operationId, "无 callId 时用内容摘要，不用 Date.now");
  assert.match(noCall.operationId, /^s:src_http:req-[0-9a-f]{16}$/);
  const withCall = buildOperationContext({ sessionId: "s", tool: "src_http", callId: "call-42" });
  assert.equal(withCall.operationId, "s:src_http:call-42");

  const read = buildOperationContext({ sessionId: "s", tool: "src_http", request: { method: "POST", url: "https://fixture.test/f", headers: [], bodyBase64: b64('{"op":"read"}') } });
  const del = buildOperationContext({ sessionId: "s", tool: "src_http", request: { method: "POST", url: "https://fixture.test/f", headers: [], bodyBase64: b64('{"op":"delete"}') } });
  assert.notEqual(read.digest, del.digest, "诊断摘要必须覆盖正文差异");
  const payload = operationContextToJev(read, { scopeChecked: true });
  assert.equal(payload.method, "POST");
  assert.equal(payload.url, "https://fixture.test/f");
  assert.equal(payload.body, '{"op":"read"}');
  assert.equal(payload.arguments, undefined, "出口路径不透传 arguments：请求投影已覆盖语义，避免全文多处重复");
});

test("advisor wire: final jev payload carries decoded frozen body, object headers, real tool identity and trusted scopeChecked", async () => {
  const calls = [];
  const decide = async (args) => { calls.push(args); return { action: "pending", effect: "unknown", risk: "unknown", fallback: false }; };
  const request = { method: "POST", url: "https://fixture.test/api/files", headers: [["accept", "*/*"], ["content-type", "application/json"], ["authorization", "Bearer sk-secret"]], bodyBase64: b64('{"filename":"marker.txt","content":"delete_all_customer_records"}') };
  const plan = { maxRequests: 1, scopeRevision: 1, entries: [{ maxRequests: 1, request }], purpose: "上传独立测试标记文件" };
  await assessEgressPlan(plan, { agent: { session: { id: "wire-fixture" } }, callId: "call-wire-1", name: "src_http" }, decide);
  assert.equal(calls.length, 1);
  const wire = calls[0];
  assert.equal(wire.taskType, "risk-grade");
  assert.equal(wire.tool, "src_http", "保留真实工具名，不再硬编码 egress_http");
  assert.equal(wire.operationId, "wire-fixture:src_http:call-wire-1", "保留真实 callId");
  assert.equal(wire.justification, "上传独立测试标记文件", "保留原始理由作为模型解释");
  assert.equal(wire.scopeChecked, true, "broker.propose 已 assertScopeCurrent：显式可信事实");
  assert.equal(wire.method, "POST");
  assert.equal(wire.url, "https://fixture.test/api/files");
  assert.equal(wire.headers["content-type"], "application/json");
  assert.equal(wire.body, '{"filename":"marker.txt","content":"delete_all_customer_records"}', "正文必须出现在最终 payload，不得丢 bodyBase64");

  const readCalls = [], deleteCalls = [];
  const readRequest = { ...request, bodyBase64: b64('{"op":"read"}') };
  const deleteRequest = { ...request, bodyBase64: b64('{"op":"delete_all_customer_records"}') };
  await assessEgressPlan({ ...plan, entries: [{ maxRequests: 1, request: readRequest }] }, { agent: { session: { id: "wire-fixture" } }, callId: "call-read", name: "src_http" }, async (a) => { readCalls.push(a); return { action: "pending", effect: "unknown", risk: "unknown", fallback: false }; });
  await assessEgressPlan({ ...plan, entries: [{ maxRequests: 1, request: deleteRequest }] }, { agent: { session: { id: "wire-fixture" } }, callId: "call-delete", name: "src_http" }, async (a) => { deleteCalls.push(a); return { action: "pending", effect: "unknown", risk: "unknown", fallback: false }; });
  assert.notEqual(readCalls[0].body, deleteCalls[0].body, "read/delete 的最终 payload 必须不同");
  assert.notEqual(readCalls[0].operationId, deleteCalls[0].operationId);

  const batchCalls = [];
  const batch = { maxRequests: 2, scopeRevision: 1, purpose: "有界目录探测", entries: [{ maxRequests: 1, request: { ...request, method: "GET", bodyBase64: "" } }, { maxRequests: 1, request: { ...request, url: "https://fixture.test/api/2", bodyBase64: "" } }] };
  await assessEgressPlan(batch, { agent: { session: { id: "wire-fixture" } }, callId: "call-scan", name: "src_scan_surface" }, async (a) => { batchCalls.push(a); return { action: "pending", effect: "unknown", risk: "unknown", fallback: false }; });
  assert.equal(batchCalls.length, 1);
  assert.equal(batchCalls[0].taskType, "scan-plan");
  assert.deepEqual(batchCalls[0].plan, batch);
  assert.equal(batchCalls[0].tool, "src_scan_surface");
});

test("jev-client wire: full body reaches remote review state; credentials scrubbed; execution policy reflects trusted scope", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "src-jev-wire-"));
  const env = { ...process.env };
  process.env.DSH_HOME = home;
  process.env.DSH_SRC_LAYA_DECISION = "on";
  const previousFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, payload: JSON.parse(init.body), headers: init.headers };
    return new Response(JSON.stringify({ model: "jev-fixture", answers: { decision: { choice: "unknown", confidence: .9, probabilities: { read: 0, compute: 0, write: 0, external: 0, auth: 0, destructive: 0, unknown: 1 } } } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(async () => { globalThis.fetch = previousFetch; for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env); await fs.rm(home, { force: true, recursive: true }); });
  await saveDecisionSettings({ enabled: true, endpoint: "https://jev.fixture/decide", apiKey: "sk-fixture-api-key" });
  const args = operationContextToJev(buildOperationContext({
    sessionId: "wire-fixture", callId: "call-jev-1", tool: "src_http",
    request: { method: "POST", url: "https://fixture.test/api/files", headers: [["accept", "*/*"], ["content-type", "application/json"], ["authorization", "Bearer sk-abc"]], bodyBase64: b64('{"filename":"marker.txt","password":"hunter2","content":"delete_all_customer_records"}') },
    justification: "上传独立测试标记文件"
  }), { taskType: "risk-grade", scopeChecked: true, verifiedTestObjects: [] });
  const advice = await jevDecide(args, { agent: { session: { id: "wire-fixture" } } });
  assert.equal(advice.fallback, false, "线缆应成功往返而非静默降级");
  assert.equal(advice.action, "pending");
  const state = captured.payload.state;
  assert.equal(state.request.method, "POST");
  assert.equal(state.request.body, '{"filename":"marker.txt","password":"<stored>","content":"delete_all_customer_records"}', "完整正文送审；敏感字段值脱敏但结构保留");
  assert.ok(!captured.payload.state.request.body.includes("hunter2"));
  assert.equal(state.executionPolicy.targetScopeChecked, true, "scopeChecked 以可信执行事实到达远端");
  const flattened = JSON.stringify(captured.payload);
  assert.ok(!flattened.includes("sk-abc"), "authorization 值必须脱敏");
  assert.ok(!flattened.includes("sk-fixture-api-key"), "服务密钥不得外发");
  assert.ok(state.task.purpose === "上传独立测试标记文件", "task 上下文（工具/原理由/operationId）随请求同送");
  assert.equal(state.task.tool, "src_http");
});

test("jev-client wire: scan-plan taskSpec carries task context beside the presented plan", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "src-jev-wire-scan-"));
  const env = { ...process.env };
  process.env.DSH_HOME = home;
  process.env.DSH_SRC_LAYA_DECISION = "on";
  const previousFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: "jev-fixture", answers: { decision: { choice: "read", confidence: .9, probabilities: { read: 1, compute: 0, write: 0, external: 0, auth: 0, destructive: 0, unknown: 0 } } } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(async () => { globalThis.fetch = previousFetch; for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env); await fs.rm(home, { force: true, recursive: true }); });
  await saveDecisionSettings({ enabled: true, endpoint: "https://jev.fixture/decide" });
  const batch = { maxRequests: 1, scopeRevision: 1, purpose: "有界目录探测", entries: [{ maxRequests: 1, request: { method: "GET", url: "https://fixture.test/a", headers: [], bodyBase64: "" } }] };
  const advice = await jevDecide({ taskType: "scan-plan", tool: "src_scan_surface", justification: "有界目录探测", plan: batch, scopeChecked: true }, { agent: { session: { id: "wire-fixture" } } });
  assert.equal(advice.fallback, false);
  assert.equal(advice.effect, "read");
  assert.equal(captured.state.task?.purpose, "有界目录探测", "task 上下文与 plan 同送，计划不再与动机脱节");
  assert.match(JSON.stringify(captured.state.plan), /fixture\.test\/a/, "展示形态的 plan 仍含每个请求");
});
