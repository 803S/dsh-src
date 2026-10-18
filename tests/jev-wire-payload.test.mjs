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
/* [local.143] 用途归属：系统默认说明 ≠ 模型自述。 */
import { isSystemDefaultPurpose, purposeAttribution, declaredPurpose, PURPOSE_SINGLE_CAPTURED, PURPOSE_NO_SAFETY_MATERIAL } from "../lib/src/egress/purpose.js";
import { pickWorkIntent, workContextFrom } from "../lib/src/egress/session-work-context.js";

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
    return new Response(JSON.stringify({ model: "jev-fixture", answers: { decision: { choice: "unknown", confidence: .9, probabilities: { read: 0, compute: 0, write: 0, external: 0, 'external-probe': 0, auth: 0, destructive: 0, unknown: 1 } } } }), { status: 200, headers: { "content-type": "application/json" } });
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
    return new Response(JSON.stringify({ model: "jev-fixture", answers: { decision: { choice: "read", confidence: .9, probabilities: { read: 1, compute: 0, write: 0, external: 0, 'external-probe': 0, auth: 0, destructive: 0, unknown: 0 } } } }), { status: 200, headers: { "content-type": "application/json" } });
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

/* [审计 2026-10-13 §1/最小任务④] 出口闸（broker→advisor）的 risk-grade/scan-plan 判定以前完全不进 telemetry：
 * 复核会话内层确实调用了 Jev（fallback:false, mode:"on"），但当天 JSONL 只有 delegate/skill、risk-grade=0，
 * 审计据此误判“没有 Jev 风险调用证据”。这里钉住旁路发射：判定的关键字段与会话可归因，
 * 且绝不携带请求正文/凭据。 */
test("broker 出口判定补 telemetry：risk-grade/scan-plan 可归因、无正文泄露、失败不影响判定", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "src-jev-telemetry-"));
  const env = { ...process.env };
  process.env.DSH_HOME = home;
  process.env.DSH_SRC_LAYA_DECISION = "on";
  t.after(async () => { for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env); await fs.rm(home, { force: true, recursive: true }); });
  const { flushDefaultTelemetry } = await import("../lib/src/telemetry/events.js");
  const request = { method: "POST", url: "https://fixture.test/index.php?m=admin&c=login&a=registerhandle", headers: [["content-type", "application/x-www-form-urlencoded"]], bodyBase64: b64("username=srctest_fixture&password=telemetry-secret-in-body") };
  const plan = { maxRequests: 1, scopeRevision: 1, purpose: "单笔注册写入审核", entries: [{ maxRequests: 1, request }] };
  const exec = { agent: { session: { id: "telemetry-fixture" } }, callId: "call-risk-1", name: "src_http", verifiedTestObjects: ["testobj-1"] };
  const decided = await assessEgressPlan(plan, exec, async () => ({ action: "pending", effect: "write", risk: "high", mode: "on", fallback: false, objectClass: "business-or-unknown", source: "jev", probabilities: { write: 0.8 } }));
  assert.equal(decided.effect, "write", "telemetry 旁路必须原样透传判定结果（不得变成 Promise 包装差异）");
  const scanRequest = { ...request, method: "GET", bodyBase64: "" };
  const batch = { maxRequests: 2, scopeRevision: 1, purpose: "有界目录探测", entries: [{ maxRequests: 1, request: scanRequest }, { maxRequests: 1, request: { ...scanRequest, url: "https://fixture.test/index.php?m=home&c=archive&a=search" } }] };
  await assessEgressPlan(batch, { ...exec, callId: "call-risk-2" }, async () => ({ action: "pending", effect: "unknown", risk: "unknown", mode: "on", fallback: true, errorType: "SERVICE_DOWN" }));
  await flushDefaultTelemetry();
  const dir = path.join(home, "storages", "src-telemetry");
  const rows = (await Promise.all((await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => fs.readFile(path.join(dir, f), "utf8"))))
    .flatMap((text) => text.split("\n").filter(Boolean)).map((line) => JSON.parse(line));
  const decisions = rows.filter((row) => row.event === "laya.decision");
  assert.equal(decisions.length, 2, "每笔出口判定都要落一条可核验事件");
  const graded = decisions.find((row) => row.payload.callId === undefined && row.payload.taskType === "risk-grade" && row.payload.effect === "write");
  assert.ok(graded, "risk-grade 判定必须进 telemetry");
  assert.equal(graded.sessionId, "telemetry-fixture", "事件可按会话归因");
  assert.equal(graded.payload.risk, "high");
  assert.equal(graded.payload.objectClass, "business-or-unknown");
  assert.equal(graded.payload.verifiedTestObjectCount, 1, "受控测试对象数量随判定旁路记账");
  const scan = decisions.find((row) => row.payload.taskType === "scan-plan");
  assert.ok(scan, "scan-plan 判定同样进 telemetry");
  assert.equal(scan.payload.fallback, true);
  assert.equal(scan.payload.errorType, "SERVICE_DOWN");
  assert.ok(!JSON.stringify(rows).includes("telemetry-secret-in-body"), "telemetry 旁路不得携带请求正文");
});

test("purpose attribution [local.143]: 未申报用途不得被当成模型自述，也不得喂给判定服务", () => {
  assert.equal(isSystemDefaultPurpose(PURPOSE_SINGLE_CAPTURED), true);
  assert.equal(isSystemDefaultPurpose(PURPOSE_NO_SAFETY_MATERIAL), true);
  assert.equal(isSystemDefaultPurpose("Burp 原生单次发送 login；调用摘要 abc；信任已配置的 Burp 执行冻结参数。"), true);
  assert.equal(isSystemDefaultPurpose("上传独立测试标记文件"), false);
  assert.equal(isSystemDefaultPurpose(""), true, "空 = 未申报");
  assert.match(purposeAttribution(PURPOSE_SINGLE_CAPTURED), /系统默认说明（模型未申报用途，不是模型自述）/);
  assert.match(purposeAttribution("上传独立测试标记文件"), /模型自述/);
  assert.equal(declaredPurpose(PURPOSE_SINGLE_CAPTURED), "");
  assert.equal(declaredPurpose("上传独立测试标记文件"), "上传独立测试标记文件");
});

test("advisor wire [local.143]: Jev 拿到完整冻结报文 + 用户声明的意图/目标；系统默认用途不冒充模型自述", async () => {
  const calls = [];
  const decide = async (a) => { calls.push(a); return { action: "pending", effect: "unknown", risk: "unknown", fallback: false }; };
  // 现场原样：bash+curl 发往 /api/users/ 的空 body POST，无凭据、模型没申报用途
  const frozen = { method: "POST", url: "https://fixture.test/api/users/", headers: [["accept", "*/*"], ["user-agent", "curl/8.7.1"]], bodyBase64: "" };
  const work = { intentId: "intent-7", intentTitle: "Jorani 认证面与未授权接口测绘", intentDetail: "确认 /api/users/ 在无凭据下的可达性与返回语义", goalTarget: "fixture.test", goalObjective: "评估授权范围内的 Jorani 目标面" };
  const exec = { agent: { session: { id: "wire-143" } }, callId: "call-143", name: "bash", srcWorkContext: async () => work };
  await assessEgressPlan({ maxRequests: 1, scopeRevision: 1, purpose: PURPOSE_SINGLE_CAPTURED, entries: [{ maxRequests: 1, request: frozen }] }, exec, decide);
  assert.equal(calls.length, 1);
  const wire = calls[0];
  /* ① 报文完整性：“Jev 只看到 URL”不成立——方法/URL/全量请求头/正文都在载荷里。 */
  assert.equal(wire.method, "POST");
  assert.equal(wire.url, "https://fixture.test/api/users/");
  assert.deepEqual(wire.headers, { accept: "*/*", "user-agent": "curl/8.7.1" });
  assert.equal(wire.body, "");
  /* ② 意图/目标进载荷：此前 buildOperationContext 从不接收它们 → title/detail 恒为空串。 */
  assert.equal(wire.title, "Jorani 认证面与未授权接口测绘");
  assert.equal(wire.detail, "确认 /api/users/ 在无凭据下的可达性与返回语义");
  assert.equal(wire.goalTarget, "fixture.test");
  assert.equal(wire.objective, "评估授权范围内的 Jorani 目标面");
  /* ③ 系统默认串不是模型自述：不得作为 justification 送进判定服务（那等于喂假线索→只能判 unknown）。 */
  assert.equal(wire.justification, "");
  /* ④ 真实申报用途仍原样送。 */
  calls.length = 0;
  await assessEgressPlan({ maxRequests: 1, scopeRevision: 1, purpose: "上传独立测试标记文件", entries: [{ maxRequests: 1, request: frozen }] }, { ...exec, callId: "call-143b" }, decide);
  assert.equal(calls[0].justification, "上传独立测试标记文件");
  /* ⑤ 会话事实取不到 → 上下文退化为空，但判定调用与失败关闭语义不受影响。 */
  calls.length = 0;
  await assessEgressPlan({ maxRequests: 1, scopeRevision: 1, purpose: PURPOSE_SINGLE_CAPTURED, entries: [{ maxRequests: 1, request: frozen }] }, { agent: { session: { id: "wire-143" } }, callId: "call-143c", name: "bash", srcWorkContext: async () => { throw new Error("store down"); } }, decide);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, "");
  assert.equal(calls[0].justification, "");
  assert.equal(calls[0].method, "POST", "会话事实缺失不得削掉真实报文");
});

test("session work context [local.143]: 取“当前工作线”而不是最后一条废弃意图；无事实即空串，不编造", () => {
  /* 现场形状：intents 里既有废弃的 "test/test"，也有已完成的真实工作线；按时间取最后一条会喂给判定服务一句 "test"。 */
  const intents = [
    { id: "intent-1", title: "Jorani 认证与未授权访问面测绘", detail: "验证 /session/login 与 /api/*", status: "completed" },
    { id: "intent-6", title: "test", detail: "test", status: "deprecated" },
    { id: "intent-5", title: "未授权调试脚本与信息泄露面验证", detail: "", status: "completed" }
  ];
  assert.equal(pickWorkIntent(intents).id, "intent-5", "废弃意图不得胜出；同分取更新的一条");
  assert.equal(pickWorkIntent([{ id: "a", title: "x", status: "planned" }, { id: "b", title: "y", status: "running" }]).id, "b", "在用 > 计划");
  assert.equal(pickWorkIntent([]), null);
  assert.equal(pickWorkIntent(undefined), null);

  const ctx = workContextFrom({ goal: { target: "target.test", objective: "授权范围内验证", authorization: "仅 target.test；无真实外发" }, intents });
  assert.equal(ctx.intentId, "intent-5");
  assert.equal(ctx.intentTitle, "未授权调试脚本与信息泄露面验证");
  assert.equal(ctx.goalTarget, "target.test");
  assert.equal(ctx.authorization, "仅 target.test；无真实外发");
  const empty = workContextFrom(null);
  assert.deepEqual(Object.values(empty), ["", "", "", "", "", ""], "无会话事实时全部留空，绝不编造意图或授权");
});

test("advisor wire [local.143]: 会话授权说明进载荷；缺失时不冒充（退回出口通用表述）", async () => {
  const calls = [];
  const decide = async (a) => { calls.push(a); return { action: "pending", effect: "unknown", risk: "unknown", fallback: false }; };
  const frozen = { method: "DELETE", url: "https://fixture.test/api/users/1", headers: [["accept", "*/*"]], bodyBase64: "" };
  const plan = { maxRequests: 1, scopeRevision: 1, purpose: PURPOSE_NO_SAFETY_MATERIAL, entries: [{ maxRequests: 1, request: frozen }] };
  const work = workContextFrom({ goal: { target: "fixture.test", objective: "授权范围内验证", authorization: "仅 fixture.test；写入仅限自建对象" }, intents: [{ id: "i", title: "未授权接口面", detail: "确认 /api/users/ 可达性", status: "running" }] });
  await assessEgressPlan(plan, { agent: { session: { id: "wire-a" } }, callId: "c1", name: "bash", srcWorkContext: async () => work }, decide);
  assert.equal(calls[0].authorization, "仅 fixture.test；写入仅限自建对象");
  assert.equal(calls[0].title, "未授权接口面");
  assert.equal(calls[0].objective, "授权范围内验证");
  assert.equal(calls[0].justification, "", "系统默认说明仍不冒充模型自述");
  calls.length = 0;
  await assessEgressPlan(plan, { agent: { session: { id: "wire-b" } }, callId: "c2", name: "bash" }, decide);
  assert.match(calls[0].authorization, /出口已由用户确认精确目标/, "无会话事实时退回出口通用表述，不编造授权内容");
});
