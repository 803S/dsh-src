import test from "node:test";
import assert from "node:assert/strict";
import { issueApprovalGrant, consumeApprovalGrant } from "../lib/src/approval-grants.js";
import { beforeRepeat, afterRepeat, resetRepeatGuardForTests } from "../lib/src/repeat-guard.js";
import { applySrcEvent, srcInitialState } from "../lib/src.js";
import { classifyHttpRequest } from "../lib/src/security.js";
import { keylessSearchProvider } from "../lib/src/web-search-provider.js";
import { patternShapeError } from "../lib/src/lessons.js";
import { layaDecide } from "../lib/src/decision/laya-client.js";
import { sanitizeEvidence, renderScan } from "../lib/src/evidence-output.js";

test("scan output exposes all accepted rows and distinguishes omitted inputs", () => {
 const rows = Array.from({length:100}, (_,i)=>({path:`/row-${i}`,status:404,length:682,sampleBytes:682,bodySampleSha256:'abc',title:'Not Found'}));
 const text = renderScan({}, {requested:100,responses:100,hints:0,results:rows,scanInput:{supplied:103,invalid:1,duplicates:1,accepted:100,omittedPaths:['/not-executed']}})[0].text;
 assert.match(text,/\/row-99 → 404/);
 assert.match(text,/length=682 evidence=none sampleBytes=682 sampleHash=abc/);
 assert.match(text,/未执行路径.*\/not-executed/);
 assert.match(text,/未命中字典不证明目标没有部署应用/);
 assert.doesNotMatch(text,/缩小 paths 批次读取/);
});
import { reserveRequestStart } from "../lib/src/request-rate.js";
import { applyCommittedCoverage } from "../lib/src/coverage-projection.js";
import { approvalTarget, approvalBlockReason } from "../src/dsh-client-ui-src/src/client/approval-explanation.ts";

test('审批卡只解释实际阻断判定，不编造方法后果或背书模型安全承诺',()=>{
 const input={method:'PUT',url:'https://fixture.invalid/settings',justification:'无任何副作用，立即可逆',reason:'执行前判定'+JSON.stringify({risk:'high',effect:'write',action:'pending'})};
 assert.match(approvalBlockReason(input),/写入或覆盖/);assert.doesNotMatch(approvalBlockReason(input),/立即可逆|清空其他配置/);
 assert.match(approvalBlockReason({...input,reason:'执行前判定'+JSON.stringify({risk:'low',effect:'unknown',action:'allow'})}),/已判低风险并放行/);
 assert.match(approvalBlockReason({...input,reason:'执行前判定'+JSON.stringify({fallback:true})}),/未返回有效判定/);
 assert.match(approvalTarget({method:'GET',url:'bad'}),/无法解析/);
 assert.equal(approvalTarget({method:'ASSET',url:'partner.test'}),'*.partner.test');
});

test("committed coverage replaces provisional IDs and restores calculated counts", () => {
 const provisional = {id:'coverage-1',phase:'api',category:'read',status:'running'};
 const colliding = {id:'coverage-7',phase:'recon',category:'legacy',status:'completed'};
 const authoritative = {id:'coverage-7',sessionId:'fixture',phase:'api',category:'read',status:'completed',evidence:['observation-1'],limitation:'',endpointsTotal:20,endpointsTested:1,endpointsSkipped:[],updatedAt:123};
 const expected = [authoritative];
 assert.deepEqual(applyCommittedCoverage([provisional,colliding],authoritative),expected);
 assert.deepEqual(applyCommittedCoverage(expected,authoritative),expected);
 const event={type:'tool/call',data:{name:'src_coverage_committed',arguments:JSON.stringify(authoritative)}};
 const state=applySrcEvent({...srcInitialState,coverage:[provisional,colliding]},event);
 assert.deepEqual(state.coverage,expected);
 assert.deepEqual(applySrcEvent(state,event).coverage,expected);
});

test("rate limiter shares start slots across concurrent callers", async () => {
  const starts = [];
  await Promise.all(Array.from({ length: 8 }, () => reserveRequestStart('parallel-fixture', 25).then(() => starts.push(Date.now()))));
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 24, 'starts must be spaced, not burst by worker count');
  const controller = new AbortController();
  await reserveRequestStart('abort-fixture', 50);
  const waiting = reserveRequestStart('abort-fixture', 50, controller.signal);
  controller.abort(new Error('cancelled fixture'));
  await assert.rejects(waiting, /cancelled fixture/);
  await reserveRequestStart('abort-fixture', 50);
});

test("fd2a audit: URL credential redaction never consumes adjacent JSON fields", () => {
  const value = { global: { settings: { onlineResource: "http://fixture.invalid" }, jai: { enabled: true, operations: { "@class": "sorted-set", values: ["one", "two"] } } } };
  const raw = JSON.stringify(value);
  assert.equal(sanitizeEvidence(raw), raw);
  assert.deepEqual(JSON.parse(sanitizeEvidence(raw)), value);
  const credentialUrl = JSON.stringify({ url: "https://fixture-user:fixture-password@example.invalid/path", next: { "@class": "retained" } });
  const sanitized = sanitizeEvidence(credentialUrl);
  assert.doesNotMatch(sanitized, /fixture-password/);
  assert.deepEqual(JSON.parse(sanitized), { url: "https://<stored>@example.invalid/path", next: { "@class": "retained" } });
});

test("project defect guard: body words and endpoint patches cannot waive approval", () => {
  assert.equal(classifyHttpRequest({ method: "POST", path: "/mcp/", headers: { authorization: "Bearer x" }, body: '{"method":"tools/list"}' }).require, false);
  assert.equal(classifyHttpRequest({ method: "POST", path: "/utils/transform_request", headers: {}, body: '{"model":"x"}' }).require, true);
  assert.equal(classifyHttpRequest({ method: "POST", path: "/payments", headers: {}, body: '{"note":"schema query tools/list"}' }).require, true);
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
  assert.equal(state.nodes.filter((node) => node.kind === "finding").length, 0, "in-flight calls are not findings");
  state = applySrcEvent(state, { type: "tool/result", data: { message: { content: [{ toolCallId: "call-1", isError: false, content: [{ type: "text", text: "Recorded finding finding-1 [low] old finding (edge edge-2)." }] }] } } });
  state = applySrcEvent(state, { type: "tool/result", data: { message: { content: [{ toolCallId: "call-2", isError: true }] } } });
  assert.deepEqual(state.nodes.filter((node) => node.kind === "finding").map((node) => node.title), ["old finding"]);
  state = applySrcEvent(state, call("call-3", "retry finding"));
  state = applySrcEvent(state, { type: "tool/result", data: { message: { content: [{ toolCallId: "call-3", isError: false, content: [{ type: "text", text: "Recorded finding finding-2 [low] retry finding (edge edge-3)." }] }] } } });
  assert.deepEqual(state.nodes.filter((node) => node.kind === "finding").map((node) => node.id), ["finding-1", "finding-2"]);
});

test('范围卡展示精确origin，不暗示已经发包',()=>{
 const input={method:'SCOPE',url:'https://fixture.invalid',body:JSON.stringify({origins:['https://fixture.invalid','https://api.fixture.invalid:8443']})};
 assert.match(approvalTarget(input),/api.fixture.invalid:8443/);assert.match(approvalBlockReason(input),/不发包/);
 assert.match(approvalTarget({...input,body:'bad'}),/不要批准/);
});
test('TASK卡展示冻结目标及方法，不展示内部任务URI或编造风险',()=>{
 const entry=(method,url)=>({request:{method,url,headers:{},body:''},maxRequests:1});
 const input={method:'TASK',url:'src-egress://task-id',body:JSON.stringify({entries:[entry('GET','https://fixture.invalid/settings'),entry('DELETE','https://fixture.invalid/settings')],safety:null})};
 assert.match(approvalTarget(input),/DELETE https:/);assert.doesNotMatch(approvalTarget(input),/src-egress|只读/);
 assert.match(approvalTarget({...input,body:'bad'}),/不要批准/);
});

import { approvalMissingSafety, approvalRequestText, approvalOperation } from '../src/dsh-client-ui-src/src/client/approval-explanation.ts';
test('审批展示冻结HTTP请求、脱敏凭据，空PUT没有可执行按钮',()=>{
 const review={risk:'low',effect:'read',action:'allow',mode:'on',fallback:false,hardVeto:true};
 const input={method:'TASK',url:'src-egress://fixture',reason:'执行前判定'+JSON.stringify(review),body:JSON.stringify({entries:[{request:{method:'GET',url:'http://127.0.0.1:23456/health?q=1',headers:{authorization:'secret','x-forwarded-for':'127.0.0.1'},body:''}}],safety:null})};
 assert.equal(approvalMissingSafety(input),false);
 assert.match(approvalRequestText(input),/^GET \/health\?q=1 HTTP\/1.1\r\nHost: 127.0.0.1:23456\r\n/);
 assert.match(approvalRequestText(input),/authorization: <stored>/);
 assert.doesNotMatch(approvalRequestText(input),/secret|src-egress/);
 assert.match(approvalOperation(input),/代理信任/);
 const put={...input,body:JSON.stringify({entries:[{request:{method:'PUT',url:'http://127.0.0.1/render',headers:{},body:''}}],safety:null})};
 assert.equal(approvalMissingSafety(put),true);assert.match(approvalOperation(put),/清空资源/);
});
