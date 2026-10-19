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
    listTaskApprovals: async (s) => [...rows.values()].filter((row) => row.sessionId === s && row.method === "TASK"),
    sessionsWithPendingTaskApprovals: async () => [...new Set([...rows.values()].filter((row) => row.method === "TASK" && row.status === "pending").map((row) => row.sessionId))],
    updateApprovalExecution: async (s, id, patch) => Object.assign(rows.get(id), patch)
  };
  const manager = await createEgressManager({ home, allowLoopbackFixtures: true, storeFor: async () => store, assess: async () => advice, directFetch: async (url, init) => { sent.push({ url, method: init.method }); return new Response("ok"); } });
  t.after(async () => { await manager.close(); await rm(home, { recursive: true, force: true }); });
  return { manager, rows, sent, store };
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
  assert.match(card.reason, /^有界任务待审：业务数据写入/);
  assert.match(card.reason, /执行前判定\{/, "原始判定值仍保留供审计");
  // [local.146] 同一批字段不得写两遍：中文散文侧只留“这是什么操作 + 谁做的判定”，
  // 字段值一律看 `执行前判定{...}`（UI 说明卡与阻断原因都在解析它），且不再回显系统默认用途空话。
  assert.doesNotMatch(card.reason, /判定依据：影响=/, "不得重复 JSON 里的字段");
  assert.doesNotMatch(card.reason, /需审核实际语义/, "不得把闸对自己的默认串当用途说明");
  assert.match(card.reason, /用途：模型未申报/);
  assert.match(card.reason, /可直接批准/);
  assert.doesNotMatch(card.reason, /需补齐实际影响及相应执行材料/);
  assert.equal(f.sent.length, 0, "待审期间不得发送任何目标请求");
});

/* [local.146 用户拍板 2026-10-18] 审批卡给用户看原始冻结报文，不再打码。
 * 取证依据（现场 session-c8341c79）：卡里 `cookie: <stored>` 的值就在会话 cookie jar 里
 * （模型 `-b jar.txt` 本来就能用，且 `cat jar.txt` 是只读操作、本就不拦），
 * 而 `password=<stored>&confirm=Test@12345` 里那个值是模型自己编的测试密码、同一行隔壁就是明文——
 * 打码既不保护用户也不阻挡模型，只让卡看起来没头没尾。发给**外部判定服务**的那份仍打码。 */
test("审批卡展示原始冻结报文（凭据不打码），发给外部判定服务的那份仍打码", async (t) => {
  const f = await fixture(t, writeHigh);
  const session = randomUUID(), origin = "http://127.0.0.1:23456";
  await f.manager.user.setScope(session, [origin]);
  let pending;
  try {
    await f.manager.fetch(session, `${origin}/users/reset/1`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: "jorani_session=fixture-session-value", authorization: "Bearer fixture-token" },
      body: "password=chosen-by-model&confirm=chosen-by-model"
    });
  } catch (error) { pending = error; }
  const card = f.rows.get(pending?.approvalId);
  assert.ok(card, "待审必须落审批卡");
  const stored = JSON.parse(card.body);
  const request = (stored.entries ?? stored)[0].request;
  assert.equal(request.headers.cookie, "jorani_session=fixture-session-value", "卡上必须是真实 cookie 值");
  assert.equal(request.headers.authorization, "Bearer fixture-token", "卡上必须是真实认证头");
  assert.equal(request.body, "password=chosen-by-model&confirm=chosen-by-model", "卡上必须是真实表单正文（不得只打码 password 而留下 confirm 明文）");
  assert.doesNotMatch(card.body, /<stored>/, "审批卡不再出现 <stored>");
  // 通道隔离：发给外部判定服务的投影仍打码（review=true），事件/工具结果的默认投影也仍打码。
  const { presentPlan } = await import("../lib/src/egress/plan-presentation.js");
  const plan = { entries: [{ maxRequests: 1, request: { method: "POST", url: "https://fixture.invalid/users/reset/1", headers: [["cookie", "jorani_session=fixture-session-value"], ["authorization", "Bearer fixture-token"]], bodyBase64: Buffer.from("password=chosen-by-model", "utf8").toString("base64") } }] };
  const raw = presentPlan(plan, { raw: true }).entries[0].request;
  assert.equal(raw.headers.cookie, "jorani_session=fixture-session-value");
  assert.equal(raw.headers.authorization, "Bearer fixture-token");
  assert.equal(raw.body, "password=chosen-by-model");
  for (const options of [{}, { review: true }]) {
    const masked = presentPlan(plan, options).entries[0].request;
    assert.equal(masked.headers.cookie, "<stored>", JSON.stringify(options));
    assert.equal(masked.headers.authorization, "<stored>", JSON.stringify(options));
    assert.match(masked.body, /<stored>/, JSON.stringify(options));
  }
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

/* [local.150 用户拍板 2026-10-19] 人工卡不是永久债务：未裁决的卡超过 TTL（默认 24h）自动过期。
 * 现场事实：host 车道人工卡的 manifest.expiresAt=null，10-18 22:4x 的 6 张卡挂了一整夜收不掉，
 * 用户看到的「待审核」里全是没人能决定的历史条目。过期只改状态 + 撤销账本任务，**从不自动发送**。 */
test("[local.150] 陈旧人工卡超时自动过期：只改状态、绝不出网、行仍留库供审计", async (t) => {
  process.env.DSH_SRC_PENDING_APPROVAL_TTL_MS = "3600000";
  t.after(() => { delete process.env.DSH_SRC_PENDING_APPROVAL_TTL_MS; });
  const f = await fixture(t, unknownDeferred);
  const session = randomUUID(), origin = "http://127.0.0.1:23457";
  await f.manager.user.setScope(session, [origin]);
  const cardFor = async (path) => {
    try { await f.manager.fetch(session, `${origin}${path}`, { method: "GET" }); }
    catch (error) { return error.approvalId; }
    throw new Error("预期挂起：判定服务未定 + 带查询串的读取不得自动放行");
  };
  const stale = await cardFor("/catalog?op=verify");
  const fresh = await cardFor("/report?op=verify");
  assert.ok(stale && fresh && stale !== fresh);
  assert.equal(f.sent.length, 0, "待审期间零发包");
  f.rows.get(stale).createdAt = Date.now() - 2 * 3600000;
  assert.deepEqual(await f.manager.expireStaleApprovals(session), [stale]);
  assert.equal(f.rows.get(stale).status, "expired");
  assert.equal(f.rows.get(fresh).status, "pending", "未超时的卡不动");
  assert.match(f.rows.get(stale).note, /自动过期/);
  assert.match(f.rows.get(stale).note, /从未发出/);
  assert.equal(f.sent.length, 0, "过期绝不自动发送");
  // 审计留痕：行不删除，仍可按会话列出（“从未发出的证据”）。
  assert.ok((await f.store.listTaskApprovals(session)).some((row) => row.id === stale));
  // 启动清扫（reapStaleApprovals）走同一套判据：GUI/网关重启后待办列表里不留过期卡。
  f.rows.get(fresh).createdAt = Date.now() - 3 * 3600000;
  assert.deepEqual(await f.manager.reapStaleApprovals(), [{ session, ids: [fresh] }]);
  assert.equal(f.rows.get(fresh).status, "expired");
  assert.equal(f.sent.length, 0);
  // TTL 关掉（<=0）时不清扫：现场可临时停用而无需改代码。
  process.env.DSH_SRC_PENDING_APPROVAL_TTL_MS = "0";
  const another = await cardFor("/history?op=verify");
  f.rows.get(another).createdAt = Date.now() - 30 * 3600000;
  assert.deepEqual(await f.manager.expireStaleApprovals(session), []);
  assert.equal(f.rows.get(another).status, "pending");
});

/* [local.150 用户拍板 2026-10-19] 卡片去重是**安全网**：账本里那笔任务已经不在（进程重启、
 * 任务被撤销、库被清），但卡还挂在待办列表里时，同一笔请求再次提案必须复用那张卡 ——
 * 否则每重试一次就多一张永远没人能决定的卡（现场 32 张僵尸卡、10-18 的 6 张就是这么来的）。 */
test('[local.150] 孤儿待审卡（任务已不在账本）被同身份提案回收复用：同一 approvalId、重指到新任务', async (t) => {
  const f = await fixture(t, unknownDeferred);
  const session = randomUUID(), origin = "http://127.0.0.1:23458";
  await f.manager.user.setScope(session, [origin]);
  // 造一张“卡还在、任务已没”的孤儿卡：url 指向一个账本里不存在的任务。
  const ghost = `src-egress://${randomUUID()}`;
  f.rows.set("approval-orphan", {
    id: "approval-orphan", sessionId: session, method: "TASK", url: ghost, path: "/", headers: "",
    body: JSON.stringify([{ maxRequests: 1, request: { method: "GET", url: `${origin}/catalog?op=verify`, headers: {}, body: "" } }]),
    category: "egress/task", reason: "旧卡的说明", status: "pending", createdAt: Date.now(),
  });
  let held;
  try { await f.manager.fetch(session, `${origin}/catalog?op=verify`, { method: "GET" }); }
  catch (error) { held = error; }
  assert.equal(held?.approvalId, "approval-orphan", "同身份提案必须复用那张孤儿卡，而不是再挂一张");
  assert.equal([...f.rows.values()].filter((row) => row.method === "TASK").length, 1);
  const row = f.rows.get("approval-orphan");
  assert.notEqual(row.url, ghost, "复用卡要重指到本次真实任务，否则用户批准的是一笔不存在的任务");
  assert.notEqual(row.reason, "旧卡的说明", "显示内容要刷新成本次提案");
  assert.equal(row.status, "pending");
  assert.equal(f.sent.length, 0);
});

/* [local.150 用户拍板 2026-10-19] 「卡已经没了」的账本任务不能继续挡路：
 * 陈旧卡被 TTL 收掉（或卡被拒/库被重置）之后，那笔 pending 任务永远等不到人（批准入口只认 pending 卡），
 * 模型却会一直被告知“去等某个已经不存在的审批号”。撤销它并按新提案重新判定 —— 但绝不发送。 */
test('[local.150] 卡已过期的账本任务不再挡路：撤销它、重新提案挂新卡、零发包', async (t) => {
  const f = await fixture(t, writeHigh);
  const session = randomUUID(), origin = "http://127.0.0.1:23457";
  await f.manager.user.setScope(session, [origin]);
  const url = `${origin}/index.php?m=admin&c=login&a=registerhandle`;
  const args = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=srctest_fixture&password2=fixture" };
  let first; try { await f.manager.fetch(session, url, args); } catch (error) { first = error; }
  assert.ok(first?.approvalId);
  // 模拟“卡被 TTL 收掉、账本任务还没来得及撤”（进程在清扫中途退出）。
  await f.store.updateApprovalExecution(session, first.approvalId, { status: "expired" });
  let second; try { await f.manager.fetch(session, url, args); } catch (error) { second = error; }
  assert.equal(second?.code, "SRC_GATE_PENDING_OR_REJECTED");
  assert.notEqual(second.approvalId, first.approvalId, "不得把模型指回一张已过期的卡");
  assert.equal(f.rows.get(second.approvalId)?.status, "pending", "重新提案要挂一张真正可裁决的新卡");
  assert.equal(f.sent.length, 0, "撤销旧任务不是放行：一个字节都不发");
});
