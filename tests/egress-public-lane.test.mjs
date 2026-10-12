/* [jev-approval-simplification 2026-10-12 §9 第三步验收/§10 矩阵18 + 审计 P1-6] 公开资料通道：
 * src_read_public_source 是"读公告不是打目标"的独立通道——①判定只认真实工具名+受信 host+HTTPS 无端口；
 * ②http/未知 host/其他工具不得进此通道；③publicLookup 约束（GET、无 body、header 白名单）在
 * 任何问人/Jev/网络动作之前失败关闭；④响应体有界接收（不是全收后仅截输出）。
 * 离线：增补 host 用公网 IP（pinOrigin 对 IP 免 DNS，仍真实走地址钉扎管道），directFetch 为 mock。 */
import test from "node:test";
import assert from "node:assert/strict";
import { isPublicLookup, publicLookup, boundedBody } from "../lib/src/egress/public-lookup.js";

const FIXTURE_IP = "93.184.216.34"; // 公网单播地址（example.com），非 TEST-NET/私有段

test("public lane admission: real tool name + trusted host + https no-port only", () => {
  process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS = FIXTURE_IP;
  try {
    // 工具名不匹配 → 永不进入（shell/proxy 请求不能自称走此通道）
    assert.equal(isPublicLookup({ name: "bash" }, `https://${FIXTURE_IP}/x`), false);
    assert.equal(isPublicLookup({ name: "egress_http" }, `https://${FIXTURE_IP}/x`), false);
    // 名单 host + https 无端口 → 进入
    assert.equal(isPublicLookup({ name: "src_read_public_source" }, "https://nvd.nist.gov/cve/detail"), true);
    assert.equal(isPublicLookup({ name: "src_read_public_source" }, `https://${FIXTURE_IP}/advisory/1`), true);
    // http、非标端口、未增补 host → 拒绝
    assert.equal(isPublicLookup({ name: "src_read_public_source" }, `http://${FIXTURE_IP}/a`), false);
    assert.equal(isPublicLookup({ name: "src_read_public_source" }, `https://${FIXTURE_IP}:8443/a`), false);
    assert.equal(isPublicLookup({ name: "src_read_public_source" }, "https://evil.example/a"), false);
    // 尾点归一后仍命中；无 exec → 拒绝
    assert.equal(isPublicLookup({ name: "src_read_public_source" }, "https://nvd.nist.gov./a"), true);
    assert.equal(isPublicLookup(undefined, `https://${FIXTURE_IP}/a`), false);
  } finally { delete process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS; }
});

test("public lookup constraints fail closed before any ask/network", async () => {
  const exec = { name: "src_read_public_source", callId: "c1" };
  // 非 GET / 带 body → INVALID_PUBLIC_LOOKUP（此检查在 pinOrigin/预算/发送之前）
  await assert.rejects(publicLookup(exec, "sess-1", "https://nvd.nist.gov/a", { method: "POST" }, async () => { throw new Error("must-not-send"); }), { code: "SRC_GATE_INVALID_PUBLIC_LOOKUP" });
  await assert.rejects(publicLookup(exec, "sess-1", "https://nvd.nist.gov/a", { method: "GET", body: "x=1" }, async () => { throw new Error("must-not-send"); }), { code: "SRC_GATE_INVALID_PUBLIC_LOOKUP" });
  // header 白名单之外（凭据/自定义头）→ PUBLIC_LOOKUP_HEADERS
  await assert.rejects(publicLookup(exec, "sess-1", "https://nvd.nist.gov/a", { method: "GET", headers: { accept: "*/*", "x-api-key": "secret" } }, async () => { throw new Error("must-not-send"); }), { code: "SRC_GATE_PUBLIC_LOOKUP_HEADERS" });
  // 通道判定不通过（未知工具）→ 拒绝且不发送
  await assert.rejects(publicLookup({ name: "bash" }, "sess-1", "https://nvd.nist.gov/a", {}, async () => { throw new Error("must-not-send"); }), { code: "SRC_GATE_INVALID_PUBLIC_LOOKUP" });
});

test("bounded receive: oversized public-source response body is capped at receive time; success path sends bounded GET via pin pipeline", async t => {
  const previous = process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS;
  process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS = FIXTURE_IP;
  t.after(() => { if (previous === undefined) delete process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS; else process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS = previous; });
  // 有界接收：读方拿到的流本身有界（审计 §6），不是收全后仅截输出
  const chunk = Buffer.alloc(1024 * 1024, 0x61); // 1MiB，pull 两次即超 2MiB cap
  const oversized = new Response(new ReadableStream({ pull(controller) { controller.enqueue(chunk); } }), { status: 200, headers: { "content-type": "text/html" } });
  const bounded = await boundedBody(oversized, 2 * 1024 * 1024);
  assert.equal((await bounded.text()).length, 2 * 1024 * 1024);
  assert.equal(bounded.status, 200);
  // 成功路径：受信 host + 白名单 header → mock send 收到钉扎后的有界 GET
  let sentInit;
  const response = await publicLookup({ name: "src_read_public_source", callId: "bounded-1" }, "sess-bounded", `https://${FIXTURE_IP}/advisory`, { method: "GET", headers: { "user-agent": "dsh-src-public-research/1", accept: "text/html" } }, async (url, init) => { sentInit = init; return new Response("advisory-body"); });
  assert.equal(sentInit.method, "GET");
  assert.equal(sentInit.redirect, "manual");
  assert.ok(sentInit.lookup, "pinOrigin 钉扎管道生效");
  assert.ok(!("cookie" in sentInit.headers), "目标凭据不进入公开资料通道");
  assert.equal(await response.text(), "advisory-body");
});
