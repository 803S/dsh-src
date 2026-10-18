/* [审批语义修正 2026-10-18] 分类判据从“有没有出网”改成“是否对线上环境/业务/真实用户产生真实影响”。
 * 现场问题：用 dnslog 平台测 SSRF、或做 OOB 外带探测，这类只读/有界外发探测结构化上永远被判 external/high/pending，
 * 100% 被拦。判定服务现在把“出网”拆成两类：
 *   external-probe = 有界外发探测：只让目标对【我方控制端】（dnslog/Collaborator/自建回连）发起有限回调，
 *                    不经过目标业务通道送达消息、不产生费用、不写业务状态；
 *   external       = 真实外发：经业务通道向任意地址送达短信/邮件/通知/支付/下单，或使目标访问内部管理/破坏性接口。
 * 本文件钉住两件事：①external-probe 低影响即自动发送（不再无条件挂人工）；②真实外发、删除、内部管理接口一律仍挂人工，
 * 且不得借“本地也有人工卡”把 external 也放行。这些用例不向真实目标发任何流量，只打本地回环夹具。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { createEgressManager } from "../lib/src/egress/manager.js";
import { allowsLowImpact, reviewSummary } from "../lib/src/egress/decision-policy.js";
import { reviewedReadSafety } from "../lib/src/egress/safety-plan.js";
import { httpDecisionPolicy } from "../lib/src/decision/http-policy.js";

const probeLow = { action: "allow", effect: "external-probe", risk: "low", mode: "on", fallback: false, objectClass: "business-or-unknown", hardVeto: false, hostExecution: false, confidence: 0.9 };
const egressHigh = { action: "pending", effect: "external", risk: "high", mode: "on", fallback: false, objectClass: "business-or-unknown", hardVeto: false, hostExecution: false, confidence: 0.9 };
// 蓄意伪造：把真实外发报成低风险，用来证明放行条件是“分类 + 低风险”而不是“分类”一项。
const egressLow = { action: "allow", effect: "external", risk: "low", mode: "on", fallback: false, objectClass: "business-or-unknown", hardVeto: false, hostExecution: false, confidence: 0.9 };

async function fixture(t, advice) {
  const home = await mkdtemp(path.join(tmpdir(), "src-probe-"));
  const rows = new Map(), sent = [];
  const store = {
    addPendingApproval: async (session, data) => { const row = { ...data, id: `approval-${rows.size + 1}`, status: "pending", sessionId: session, createdAt: Date.now() }; rows.set(row.id, row); return row; },
    getPendingApproval: async (s, id) => rows.get(id)?.sessionId === s ? rows.get(id) : undefined,
    listScopeApprovals: async (s) => [...rows.values()].filter((row) => row.sessionId === s && row.category === "egress/scope"),
    updateApprovalExecution: async (s, id, patch) => Object.assign(rows.get(id), patch)
  };
  const manager = await createEgressManager({ home, allowLoopbackFixtures: true, storeFor: async () => store, assess: async () => advice, directFetch: async (url, init) => { sent.push({ url, method: init.method }); return new Response("ok"); } });
  t.after(async () => { await manager.close(); await rm(home, { recursive: true, force: true }); });
  return { manager, rows, sent };
}

const probeRequest = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "url=http://probe-fixture.dnslog.cn/cb&format=json" };

test("有界外发探测（SSRF 回调我方 dnslog）：低影响即自动发送，不挂审批卡", async (t) => {
  const f = await fixture(t, probeLow);
  const session = randomUUID(), origin = "http://127.0.0.1:23457";
  await f.manager.user.setScope(session, [origin]);
  const response = await f.manager.fetch(session, `${origin}/api/fetch-url`, probeRequest);
  assert.equal(response.status, 200);
  assert.equal(f.sent.length, 1, "有界外发探测应直接发送一次");
  assert.equal(f.rows.size, 0, "有界外发探测不得挂审批卡");
});

test("真实外发（业务通道送达短信/邮件）：即便目标是我方地址也仍挂人工，零发包", async (t) => {
  const f = await fixture(t, egressHigh);
  const session = randomUUID(), origin = "http://127.0.0.1:23457";
  await f.manager.user.setScope(session, [origin]);
  let pending;
  try { await f.manager.fetch(session, `${origin}/testmail.php`, probeRequest); } catch (error) { pending = error; }
  assert.equal(pending?.code, "SRC_GATE_PENDING_OR_REJECTED");
  assert.ok(pending.approvalId);
  assert.equal(f.sent.length, 0, "真实外发不得自动发送");
  assert.equal(f.rows.size, 1, "真实外发必须落审批卡");
});

test("伪造低风险的真实外发：分类本身即代价，不被“risk=low/allow”绕过", async (t) => {
  const f = await fixture(t, egressLow);
  const session = randomUUID(), origin = "http://127.0.0.1:23457";
  await f.manager.user.setScope(session, [origin]);
  let pending;
  try { await f.manager.fetch(session, `${origin}/testmail.php`, probeRequest); } catch (error) { pending = error; }
  assert.equal(pending?.code, "SRC_GATE_PENDING_OR_REJECTED");
  assert.equal(f.sent.length, 0);
});

test("策略层：external-probe 单笔放行，多笔/写方法/真实外发不放行", () => {
  const req = { method: "POST", url: "http://127.0.0.1:23457/api/fetch-url", headers: [], bodyBase64: "" };
  const put = { method: "PUT", url: "http://127.0.0.1:23457/api/fetch-url", headers: [], bodyBase64: "" };
  const plan = (request) => ({ maxRequests: 1, entries: [{ request }] });
  const low = (effect) => ({ fallback: false, mode: "on", action: "allow", risk: "low", effect, confidence: 0.9 });
  assert.equal(allowsLowImpact(low("external-probe"), plan(req)), true);
  assert.equal(allowsLowImpact(low("external-probe"), plan(put)), false, "写方法的探测请求仍不得自动");
  assert.equal(allowsLowImpact(low("read"), plan(put)), false);
  assert.equal(allowsLowImpact(low("external"), plan(req)), false, "真实外发永不自动放行");
  assert.equal(allowsLowImpact({ ...low("external-probe"), risk: "high" }, plan(req)), false);
  assert.equal(allowsLowImpact({ ...low("external-probe"), fallback: true }, plan(req)), false);
  // 多笔计划：整计划分类为 external-probe 时与 read/compute 同级放行（scan-plan 语义就是“整计划仅含我方回调探测”），
  // 但只要计划里出现写方法，仍然一律不放行。
  const multi = { maxRequests: 2, entries: [{ request: req }, { request: req }] };
  assert.equal(allowsLowImpact(low("external-probe"), multi), true);
  assert.equal(allowsLowImpact(low("external-probe"), { maxRequests: 2, entries: [{ request: req }, { request: put }] }), false);
});

test("执行材料：external-probe 与只读同为单笔，但文案必须如实写出“确实回调出网”", () => {
  const request = { method: "POST", url: "http://127.0.0.1:23457/api/fetch-url", headers: [["content-type", "application/x-www-form-urlencoded"]], bodyBase64: Buffer.from("url=http://probe-fixture.dnslog.cn/cb").toString("base64") };
  const safety = reviewedReadSafety(request, { fallback: false, mode: "on", action: "allow", risk: "low", effect: "external-probe" });
  assert.ok(safety, "external-probe 低影响单笔应有执行材料，否则会被 SAFETY_PLAN_REQUIRED 拦成人工");
  assert.equal(safety.effect, "external-probe");
  assert.match(safety.recovery, /回调/);
  assert.doesNotMatch(safety.recovery, /只读单笔请求/, "不得冒充只读，否则审批记录丢掉“目标发起过回调”这一事实");
  assert.equal(reviewedReadSafety(request, { fallback: false, mode: "on", action: "allow", risk: "low", effect: "external" }), null, "真实外发不得凭只读材料放行");
  assert.equal(reviewedReadSafety(request, { fallback: false, mode: "on", action: "allow", risk: "high", effect: "external-probe" }), null);
});

test("审批记录：external-probe 不得被折叠成 read，也不得被折叠成 unknown（审计要能看见它出过网）", () => {
  const summary = reviewSummary({ effect: "external-probe", risk: "low", action: "allow", mode: "on", fallback: false }, { authority: "jev-low-risk" });
  assert.equal(summary.effect, "external-probe");
  assert.equal(summary.risk, "low");
  assert.equal(summary.authority, "jev-low-risk");
  assert.equal(reviewSummary({ effect: "external-probe", risk: "low", action: "allow" }, {}).effect, "external-probe");
});

test("curl 单笔车道：external-probe 低风险放行，真实外发与破坏仍要求人工", () => {
  const rule = { effect: "read", reason: "本地规则" };
  const probe = httpDecisionPolicy(rule, { fallback: false, action: "allow", risk: "low", effect: "external-probe" }, "on", { method: "POST", path: "/api/fetch-url" });
  assert.equal(probe.require, false);
  assert.match(probe.reason, /external-probe/);
  const egress = httpDecisionPolicy(rule, { fallback: false, action: "allow", risk: "low", effect: "external" }, "on", { method: "POST", path: "/testmail.php" });
  assert.equal(egress.require, true, "真实外发即便报低风险仍要求人工");
  const del = httpDecisionPolicy(rule, { fallback: false, action: "allow", risk: "low", effect: "external-probe" }, "on", { method: "DELETE", path: "/api/users/1" });
  assert.equal(del.require, true, "删除的本地终审优先于任何分类");
  const veto = httpDecisionPolicy({ hardBoundary: true, category: "方法改写头", reason: "命中本地硬边界" }, { fallback: false, action: "allow", risk: "low", effect: "external-probe" }, "on", { method: "POST", path: "/api/fetch-url" });
  assert.equal(veto.require, true, "本地硬边界优先");
});
