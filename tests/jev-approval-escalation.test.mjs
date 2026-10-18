/* [审计 2026-10-13 §2] 审批待审的“可执行升级”回归。
 * 复核会话的注册正例死在：单笔写入待审 → 子代理上下文 approval policy=never 弹不出审批 →
 * 模型只被告知“补安全材料”，于是把回合烧在 src_egress_prepare 死路（两次 SRC_GATE_INVALID_SAFETY_READ），
 * 审计因此读成“目标方向没做/被当负结果”。
 * 本文件钉住修复后的契约：①待审错误与审批卡都带 approvalId；②明确“用户可直接批准冻结请求”；
 * ③明确“审批通道不可用时把 approvalId 交回父会话”，不得重发/规避/记成不可利用或耗尽；
 * ④待审期间零发包。文案是给人/模型看的，不参与授权判定。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEgressManager } from "../lib/src/egress/manager.js";
import { APPROVAL_CHANNEL_ESCALATION, PENDING_CONTINUATION, pendingSingleRequestNotice } from "../lib/src/egress/notifications.js";

test("待审升级文案：审批通道不可用时把 approvalId 交回父会话，且不把等待写成负结论", () => {
  assert.match(APPROVAL_CHANNEL_ESCALATION, /子代理/);
  assert.match(APPROVAL_CHANNEL_ESCALATION, /父会话/);
  assert.match(APPROVAL_CHANNEL_ESCALATION, /approvalId/);
  assert.match(APPROVAL_CHANNEL_ESCALATION, /不可利用|耗尽/);
  assert.doesNotMatch(APPROVAL_CHANNEL_ESCALATION, /可以重试|自行批准|自己批准/);
  const withMaterial = pendingSingleRequestNotice({ approvalId: "approval-3", taskId: "task-abc", needsMaterial: true });
  assert.match(withMaterial, /approval-3/);
  assert.match(withMaterial, /task-abc/);
  assert.match(withMaterial, /用户可直接批准/);
  assert.match(withMaterial, /仅一次|一次性/);
  assert.match(withMaterial, /只有在确实需要/);
  assert.match(withMaterial, /src_egress_prepare/);
  assert.match(withMaterial, /子代理/);
  const bare = pendingSingleRequestNotice({ approvalId: "approval-4" });
  assert.match(bare, /approval-4/);
  assert.doesNotMatch(bare, /src_egress_prepare/, "不覆盖/删除既有对象时不得把补材料写成必要步骤");
  assert.match(PENDING_CONTINUATION, /不重发/);
  assert.match(PENDING_CONTINUATION, /[sS]leep|轮询/);
});

const writeHigh = { action: "pending", effect: "write", risk: "high", mode: "on", fallback: false, objectClass: "business-or-unknown", hardVeto: false, hostExecution: false, confidence: 0.9 };
const unknownDeferred = { action: "pending", effect: "unknown", risk: "unknown", mode: "on", fallback: false, confidence: 0.5 };

async function fixture(t, advice) {
  const home = await mkdtemp(path.join(tmpdir(), "src-escalation-"));
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

test("单笔写入待审：审批卡与错误都给出可执行人类选项，并要求子代理升级 approvalId", async (t) => {
  const f = await fixture(t, writeHigh);
  const session = randomUUID(), origin = "http://127.0.0.1:23456";
  await f.manager.user.setScope(session, [origin]);
  let pending;
  try {
    await f.manager.fetch(session, `${origin}/index.php?m=admin&c=login&a=registerhandle`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=srctest_fixture&password2=fixture" });
  } catch (error) { pending = error; }
  assert.equal(pending?.code, "SRC_GATE_PENDING_OR_REJECTED");
  assert.ok(pending.approvalId, "待审错误必须携带 approvalId，否则子代理无法升级");
  assert.match(pending.nextAction, new RegExp(pending.approvalId));
  assert.match(pending.nextAction, /用户可直接批准/);
  assert.match(pending.nextAction, /子代理/);
  assert.match(pending.nextAction, /父会话/);
  assert.doesNotMatch(pending.nextAction, /不要重新发送请求或凭目的说明猜正文/, "不再把补材料写成唯一出路");
  const card = f.rows.get(pending.approvalId);
  assert.ok(card, "待审必须落审批卡");
  assert.match(card.reason, /有界任务待审（业务数据写入/);
  assert.match(card.reason, /执行前判定\{/, "原始判定值仍保留供审计");
  assert.match(card.reason, /可直接批准/);
  assert.doesNotMatch(card.reason, /需补齐实际影响及相应执行材料/);
  assert.equal(f.sent.length, 0, "待审期间不得发送任何目标请求");
});

test("影响未定单笔待审：写明这是单点挂起、可直接放行，而不是逼模型补材料", async (t) => {
  const f = await fixture(t, unknownDeferred);
  const session = randomUUID(), origin = "http://127.0.0.1:23456";
  await f.manager.user.setScope(session, [origin]);
  let pending;
  // 明确只读的 GET 现在直接放行；要走到“影响未定→单点挂起”只能靠命中判定车道的读方法（读 + 可疑语义词）。
  try { await f.manager.fetch(session, `${origin}/read-only?op=verify`, { method: "GET" }); } catch (error) { pending = error; }
  assert.equal(pending?.code, "SRC_GATE_PENDING_OR_REJECTED");
  assert.equal(pending.reason, "human-impact-confirmation-required");
  assert.ok(pending.approvalId);
  assert.match(pending.nextAction, /单点挂起|结束当前回合/);
  assert.match(pending.nextAction, /子代理/);
  assert.doesNotMatch(pending.nextAction, /src_egress_prepare/);
  assert.equal(f.sent.length, 0);
});

/* [审计 2026-10-13 最小任务⑥] 危险误放回归：docs/jev-minimal-approval-validation-20261012.json 里
 * “理由称只读无害、正文要求 delete_all_customer_records → 实际 auto-allow”的样本必须继续被钉住。
 * 策略层矩阵在这里固定下来：删除/破坏永不自动；残留的自动写入路径只有
 * write+new-test-file（POST，或 PUT + if-none-match:*），这是显式记录的残余风险，不是“已修”。 */
test("危险误放回归：批量/无归属删除与归属不明写入不自动；残余只读分类路径显式记录未消除", async () => {
  const { allowsLowImpact } = await import("../lib/src/egress/decision-policy.js");
  const { reviewSummary } = await import("../lib/src/egress/decision-policy.js");
  const { readFile } = await import("node:fs/promises");
  const allow = { action: "allow", risk: "low", mode: "on", fallback: false, confidence: 0.9 };
  const single = (method, headers = []) => ({ maxRequests: 1, entries: [{ maxRequests: 1, request: { method, url: "https://fixture.invalid/x", headers, bodyBase64: "" } }] });
  // 只读/计算/认证：有 PUT/PATCH/DELETE 就不自动
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    assert.equal(allowsLowImpact({ ...allow, effect: "read" }, single(method)), false, `${method} 不得因只读分类自动放行`);
    assert.equal(allowsLowImpact({ ...allow, effect: "unknown" }, single(method)), false);
  }
  // 破坏性 + 归属不明/新建对象：任何形态都不自动
  for (const objectClass of ["new-test-file", "business-or-unknown", "not-applicable"]) {
    for (const method of ["POST", "DELETE"]) {
      assert.equal(allowsLowImpact({ ...allow, effect: "destructive", objectClass }, single(method), ["proof-1"]), false, `destructive/${objectClass} 必须挂人工`);
    }
  }
  // 破坏性 + 已验证归属的测试对象：这是设计的单笔清理通道（生产路径还要求请求自带匹配的 if-match ETag），
  // 只在恰好一个归属证明且非批量时可用。
  assert.equal(allowsLowImpact({ ...allow, effect: "destructive", objectClass: "owned-test-file" }, single("DELETE"), ["proof-1"]), true);
  assert.equal(allowsLowImpact({ ...allow, effect: "destructive", objectClass: "owned-test-file" }, single("DELETE"), []), false, "无归属证明不得自动");
  assert.equal(allowsLowImpact({ ...allow, effect: "destructive", objectClass: "owned-test-file" }, single("DELETE"), ["a", "b"]), false);
  const batchDelete = { maxRequests: 2, entries: [{ maxRequests: 1, request: { method: "DELETE", url: "https://fixture.invalid/x", headers: [], bodyBase64: "" } }, { maxRequests: 1, request: { method: "DELETE", url: "https://fixture.invalid/y", headers: [], bodyBase64: "" } }] };
  assert.equal(allowsLowImpact({ ...allow, effect: "destructive", objectClass: "owned-test-file" }, batchDelete, ["proof-1"]), false, "批量删除绝不自动（停止条件）");
  // 高危：不自动
  assert.equal(allowsLowImpact({ ...allow, risk: "high", effect: "write", objectClass: "owned-test-file" }, single("POST"), ["proof-1"]), false);
  assert.equal(allowsLowImpact({ ...allow, risk: "high", effect: "read" }, single("POST")), false);
  // 残余自动路径（显式记录，未消除）：write+new-test-file+POST；PUT 仅在 if-none-match:*
  assert.equal(allowsLowImpact({ ...allow, effect: "write", objectClass: "new-test-file" }, single("POST")), true);
  assert.equal(allowsLowImpact({ ...allow, effect: "write", objectClass: "new-test-file" }, single("PUT")), false);
  assert.equal(allowsLowImpact({ ...allow, effect: "write", objectClass: "new-test-file" }, single("PUT", [["if-none-match", "*"]])), true);
  assert.equal(allowsLowImpact({ ...allow, effect: "write", objectClass: "business-or-unknown" }, single("POST")), false, "归属不明的业务写入必须挂人工");
  // 最高残余风险（需用户拍板，不在本轮擅改 rubric/objectClass）：只读/计算/认证分类的 POST 仍自动发送，
  // 于是“理由称只读无害、正文却要求 delete_all_customer_records”的样本在本层仍会放行——
  // 这就是 docs/jev-minimal-approval-validation-20261012.json 必须保留的原因。
  assert.equal(allowsLowImpact({ ...allow, effect: "read" }, single("POST")), true, "残余：同笔请求的正文语义无人复核");
  // 校验过的危险误放样本仍在库里且保留其失败定性：不得被删成“已修”
  const sample = JSON.parse(await readFile(new URL("../docs/jev-minimal-approval-validation-20261012.json", import.meta.url), "utf8"));
  const text = JSON.stringify(sample);
  assert.match(text, /delete_all_customer_records/, "危险误放样本必须保留");
  assert.equal(sample.date, "2026-10-12");
  assert.ok(sample.mainRubric && Array.isArray(sample.mainCases) && sample.mainCases.length > 0, "样本文件仍是可回归的评测输入");
  assert.equal(sample.targetRequestsSent, 0, "评测样本本身不得发送目标请求");
  // 判定摘要只允许枚举字段（不回灌 provider 原文/请求密钥）
  const summary = reviewSummary({ ...allow, effect: "write", objectClass: "business-or-unknown", reason: "secret free text", apiKey: "sk-leak" });
  // authority 记录本次判定由谁作出（本地确定危害终审 / 本地明确只读放行 / 判定服务 / 人工）。
  assert.deepEqual(Object.keys(summary).sort(), ["action", "authority", "effect", "fallback", "hardVeto", "hostExecution", "mode", "objectClass", "risk"].sort());
  assert.ok(!JSON.stringify(summary).includes("sk-leak"));
});

/* [local.143] 会话自述默认不进判定服务。
 * 真实服务消融（10 笔现场冻结报文 × 6 组输入，docs/jev-context-feed-ablation-20261018.md）显示：
 * 把“我们在测未授权面”这类自述喂进去之后，判定服务把发信 GET（external/high）与空 body 写
 * 改判成 read/low/allow —— 被审对象的自述成了把自己的请求说轻的杠杆。默认 off 是安全默认，
 * 开启前必须先有“判定不得单向下调本地门槛”的兜底。 */
test("会话自述默认不进判定服务；开关打开才提供，且只提供事实（不编造）", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "src-jev-ctx-"));
  const seen = [];
  let sessionDataCalls = 0;
  const store = {
    addPendingApproval: async (session, data) => ({ ...data, id: "approval-ctx", status: "pending", sessionId: session, createdAt: Date.now() }),
    getPendingApproval: async () => undefined,
    listScopeApprovals: async () => [],
    updateApprovalExecution: async () => undefined,
    sessionData: async () => { sessionDataCalls++; return { goal: { target: "fixture.test", objective: "授权范围内验证", authorization: "仅 fixture.test" }, intents: [{ id: "i-1", title: "未授权接口面", detail: "确认 /api/x 可达性", status: "running" }] }; }
  };
  const manager = await createEgressManager({
    home, allowLoopbackFixtures: true, storeFor: async () => store,
    assess: async (plan, exec) => { seen.push(exec); return { action: "pending", effect: "unknown", risk: "unknown", mode: "on", fallback: true }; },
    directFetch: async () => { throw new Error("待审不得发包"); }
  });
  t.after(async () => { await manager.close(); await rm(home, { recursive: true, force: true }); });
  const session = randomUUID(), origin = "http://127.0.0.1:23457";
  await manager.user.setScope(session, [origin]);
  // 每笔请求用不同路径，避免被“同一冻结请求只挂一张卡”的去重挡住（去重是另一条既有契约）。
  const send = (name = "users") => manager.fetch(session, `${origin}/api/${name}/`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(error => error);

  delete process.env.DSH_SRC_JEV_SESSION_CONTEXT;
  await send();
  assert.equal(seen.length, 1, "本地非 clear 的写请求必须交判定服务");
  assert.equal(seen[0].srcWorkContext, undefined, "默认不得把会话自述交给判定服务");
  assert.equal(sessionDataCalls, 0, "默认连会话数据都不读（零成本、零外泄面）");

  process.env.DSH_SRC_JEV_SESSION_CONTEXT = "on";
  t.after(() => { delete process.env.DSH_SRC_JEV_SESSION_CONTEXT; });
  await send("teams");
  assert.equal(typeof seen[1].srcWorkContext, "function", "开关打开后按需读取");
  assert.equal(sessionDataCalls, 0, "仍按需惰性读取：只有判定服务真要调用时才读");
  const context = await seen[1].srcWorkContext();
  assert.equal(context.intentTitle, "未授权接口面");
  assert.equal(context.goalTarget, "fixture.test");
  assert.equal(context.authorization, "仅 fixture.test");
});
