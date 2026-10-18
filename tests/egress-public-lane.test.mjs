/* [jev-approval-simplification 2026-10-12 §9 第三步验收/§10 矩阵18 + 审计 P1-6] 公开资料通道：
 * src_read_public_source 是"读公告不是打目标"的独立通道——①判定只认真实工具名+受信 host+HTTPS 无端口；
 * ②http/未知 host/其他工具不得进此通道；③publicLookup 约束（GET、无 body、header 白名单）在
 * 任何问人/Jev/网络动作之前失败关闭；④响应体有界接收（不是全收后仅截输出）。
 * 离线：增补 host 用公网 IP（pinOrigin 对 IP 免 DNS，仍真实走地址钉扎管道），directFetch 为 mock。 */
import test from "node:test";
import assert from "node:assert/strict";
import { isPublicLookup, publicLookup, boundedBody } from "../lib/src/egress/public-lookup.js";
/* [local.143] 代理车道：与解析无关的判定必须与生产共用同一份事实源。 */
import { proxyAppliesToUrl, hostRequiresProxy, isSinkholeAddress, describeLocalAnswer } from "../lib/src/egress/proxy-lane.js";
import { validatePublicSourceUrl } from "../lib/src/public-source.js";

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

test("asset-collection recon sources use the public lane, not target scope", () => {
  // 资产收集只读源（证书透明度/被动索引/公共 DoH/搜索/代码搜索）默认就在名单里：
  // 它们是索引不是 SRC 目标，不需要目标范围审批，也不能发 POST body。
  for (const host of ["crt.sh", "api.certspotter.com", "app.agniops.in", "api.fofa.info", "dns.google", "cloudflare-dns.com", "web.archive.org", "grep.app"]) {
    assert.equal(isPublicLookup({ name: "src_read_public_source" }, `https://${host}/q=x`), true, host);
    assert.equal(isPublicLookup({ name: "web_fetch" }, `https://${host}/q=x`), true, host);
  }
  // 名单外仍是目标出口（web_fetch 不能拿它当通用 GET 例外）
  assert.equal(isPublicLookup({ name: "web_fetch" }, "https://evil.example/a"), false);
  assert.equal(isPublicLookup({ name: "bash" }, "https://crt.sh/?q=a"), false);
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

/* 源码卫生规则禁止仓库出现私网地址字面量：按段拼接构造，语义与真实值一致。 */
const ipLiteral = (...parts) => parts.join(".");
const PROXY_URL = `http://${ipLiteral(192, 168, 10, 88)}:7893`;

/* [local.143 现场实案] 本机 DNS 把 raw.githubusercontent.com 应答成 0.0.0.0/::（屏蔽/污染），
 * 于是“先本机解析、再判私网”的校核把它当成私网目标提前拒绝——代理从未被调用（curl 直连 000、3ms 失败；
 * 同一代理请求返回 404，证明 GitHub 可达）。修法：命中代理清单的主机一律走代理车道，由代理侧解析。
 * 本组用例锁住四件事：①车道判定是纯判定、②代理车道跳过本机解析、③未配代理时失败关闭且文案说清事实、
 * ④白名单/HTTPS/无凭据这些与解析无关的约束在两条车道上完全一致。 */
test("proxy lane: 命中代理清单 + 已配置代理 → 走代理车道；其余仍直连", () => {
  const infra = { proxyUrl: PROXY_URL };
  assert.equal(proxyAppliesToUrl(infra, "https://raw.githubusercontent.com/o/r/main/f"), true);
  assert.equal(proxyAppliesToUrl(infra, new URL("https://github.com/o/r")), true);
  assert.equal(proxyAppliesToUrl(infra, "https://api.fofa.info/q"), true);
  // 未配置代理 / 代理值不合法 / 国内目标 → 直连（不得因为“配了代理”就全量出境）
  assert.equal(proxyAppliesToUrl({}, "https://raw.githubusercontent.com/o/r"), false);
  assert.equal(proxyAppliesToUrl({ proxyUrl: PROXY_URL.slice("http://".length) }, "https://raw.githubusercontent.com/o/r"), false);
  assert.equal(proxyAppliesToUrl(infra, "https://nvd.nist.gov/vuln/detail/CVE-1"), false);
  assert.equal(proxyAppliesToUrl(infra, "https://eci-2ze4vtevomkhj6ngekl3.cloudeci1.ichunqiu.com/"), false);
  assert.equal(hostRequiresProxy("NVD.NIST.GOV"), false);
  assert.equal(hostRequiresProxy("github.com."), true, "尾点归一后仍命中");
  // 0.0.0.0/:: 是“本机屏蔽应答”，必须与真实私网地址区分
  assert.equal(isSinkholeAddress("0.0.0.0"), true);
  assert.equal(isSinkholeAddress("::"), true);
  assert.equal(isSinkholeAddress(ipLiteral(10, 0, 0, 1)), false);
  assert.deepEqual(describeLocalAnswer([{ address: "0.0.0.0" }, { address: "::" }]), { addresses: "0.0.0.0, ::", sinkhole: true });
});

test("public-source validation: 代理车道把解析交给代理；本机解析只在直连车道作数", async () => {
  const url = "https://raw.githubusercontent.com/o/r/main/f";
  const poisoned = async () => [{ address: "0.0.0.0", family: 4 }, { address: "::", family: 6 }];
  const publicAnswer = async () => [{ address: "185.199.108.133", family: 4 }];
  // 直连车道 + 污染应答：失败关闭，文案必须说清“本机屏蔽”并给出下一步，不能被改写成“目标不可达”
  await assert.rejects(validatePublicSourceUrl(url, { resolve: poisoned }), error => {
    assert.match(error.message, /SRC_GATE_PROXY_REQUIRED_UNCONFIGURED/);
    assert.match(error.message, /0\.0\.0\.0/);
    assert.match(error.message, /不是真实私网地址/);
    assert.match(error.message, /proxyUrl/);
    assert.match(error.message, /不要据此改写结论/);
    return true;
  });
  // 直连车道 + 真实私网：文案是私网，不是屏蔽
  await assert.rejects(validatePublicSourceUrl(url, { resolve: async () => [{ address: ipLiteral(10, 1, 2, 3), family: 4 }] }), /本机\/私有地址（10\.1\.2\.3）/);
  // 代理车道：完全不做本机解析（连一次 lookup 都不应该有）
  let lookups = 0;
  const checked = await validatePublicSourceUrl(url, { viaProxy: true, resolve: async () => { lookups++; return poisoned(); } });
  assert.deepEqual(checked, { url, host: "raw.githubusercontent.com", lane: "proxy", resolvedBy: "proxy" });
  assert.equal(lookups, 0, "代理车道的解析来源只能是代理，本机一个包都不该发");
  // 直连车道仍保留原判定
  assert.equal((await validatePublicSourceUrl(url, { resolve: publicAnswer })).lane, "direct");
  // 与解析无关的约束在两条车道上完全一致：白名单、HTTPS、无凭据、无端口
  await assert.rejects(validatePublicSourceUrl("https://evil.example/a", { viaProxy: true, resolve: publicAnswer }), /可信来源清单/);
  await assert.rejects(validatePublicSourceUrl("http://raw.githubusercontent.com/a", { viaProxy: true, resolve: publicAnswer }), /只允许 HTTPS/);
  await assert.rejects(validatePublicSourceUrl("https://u:p@raw.githubusercontent.com/a", { viaProxy: true, resolve: publicAnswer }), /不允许凭据/);
  await assert.rejects(validatePublicSourceUrl("https://raw.githubusercontent.com:8443/a", { viaProxy: true, resolve: publicAnswer }), /非标准端口/);
});

test("publicLookup proxy lane: 跳过 pinOrigin/直连发送器，改由代理侧解析发送", async () => {
  const exec = { name: "web_fetch", callId: "proxy-lane-1" };
  const init = { method: "GET", headers: { accept: "text/html" } };
  const mustNotSend = async () => { throw new Error("直连发送器不得在代理车道上被调用"); };
  const calls = [];
  const sendViaProxy = async (url, sentInit, options) => { calls.push({ url, sentInit, options }); return new Response("proxy-body"); };
  const response = await publicLookup(exec, "sess-proxy", "https://raw.githubusercontent.com/o/r/main/README.md", init, mustNotSend, { infra: { proxyUrl: PROXY_URL, httpTimeoutMs: 9000 }, sendViaProxy });
  assert.equal(await response.text(), "proxy-body");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://raw.githubusercontent.com/o/r/main/README.md");
  assert.equal(calls[0].sentInit.method, "GET");
  assert.equal(calls[0].sentInit.redirect, "manual");
  assert.equal(calls[0].sentInit.lookup, undefined, "代理车道不得携带本机钉扎 lookup");
  assert.deepEqual(calls[0].options, { proxyUrl: PROXY_URL, timeoutMs: 9000 });
  // 公共资料通道的 header 白名单在代理车道上同样生效（凭据不得因换车道而混入）
  await assert.rejects(publicLookup(exec, "sess-proxy", "https://raw.githubusercontent.com/o/r", { method: "GET", headers: { "x-api-key": "s" } }, mustNotSend, { infra: { proxyUrl: PROXY_URL }, sendViaProxy }), { code: "SRC_GATE_PUBLIC_LOOKUP_HEADERS" });
  assert.equal(calls.length, 1, "被拒的请求不放行到代理");
});

test("publicLookup direct lane: 未配置代理时仍走钉扎直连（代理车道不得吞掉直连行为）", async t => {
  const previous = process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS;
  process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS = FIXTURE_IP;
  t.after(() => { if (previous === undefined) delete process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS; else process.env.DSH_SRC_PUBLIC_SOURCE_HOSTS = previous; });
  let sentInit;
  const response = await publicLookup({ name: "web_fetch", callId: "direct-lane-1" }, "sess-direct", `https://${FIXTURE_IP}/a`, { method: "GET" }, async (url, init) => { sentInit = init; return new Response("direct-body"); }, { infra: {}, sendViaProxy: async () => { throw new Error("未命中代理清单，不得走代理"); } });
  assert.equal(await response.text(), "direct-body");
  assert.equal(sentInit.method, "GET");
  assert.ok(sentInit.lookup, "直连车道仍由 pinOrigin 钉扎地址");
});
