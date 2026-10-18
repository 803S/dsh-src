/* [local.143] 代理车道判定的唯一事实源。
 *
 * 背景（现场实测）：本机 DNS 会把部分境外域名解析成 0.0.0.0/::（污染或被运营商屏蔽）。
 * 只要本机解析结果是 0.0.0.0/::，任何“先在本机解析、再判断是否私网”的校验都会：
 *   ① 把域名判成“本机/私有地址” → 直接拒绝，代理根本没机会被调用；
 *   ② 或者 pin 到假地址 → 连接必然失败（curl 直连 000，3ms 失败）。
 * 命中代理清单的主机必须由代理侧解析；本机地址校验（pinOrigin/公网校验）在这条车道上
 * 没有事实意义，唯一正确的做法是判车道、然后把解析交给代理。
 *
 * 本模块只做纯判定，不做 I/O、不发请求，也不参与授权：它只回答
 * “这一笔该走代理还是直连”，供 proxiedFetch、公共资料车道和 web_fetch 共用。
 */

/** [local.15] 国内直连不稳/不可达的境外域名后缀。未命中的目标即使配了代理也直连，
 *  避免代理出境导致国内 SRC 目标变慢或触发地域风控。 */
export const PROXY_REQUIRED_HOST_SUFFIXES = [
	"google.com", "googleapis.com", "gstatic.com", "googleusercontent.com", "duckduckgo.com", "html.duckduckgo.com", "bing.com", "cn.bing.com", "baidu.com", "m.baidu.com",
	"youtube.com", "ytimg.com",
	"github.com", "githubusercontent.com", "githubassets.com", "github.io",
	"gitlab.com",
	"huggingface.co", "hf.co",
	"openai.com", "anthropic.com",
	/* [local.83] crt.sh 已实测 20s 超时不可用（用户 OPPO 实测），摘掉；agniops/certspotter 国内直连可用（<2s），不走代理。 */
	"shodan.io", "censys.io", "fofa.info", "zoomeye.org", "quake.360.net",
	"telegram.org", "t.me", "x.com", "twitter.com", "twimg.com",
	"facebook.com", "fbcdn.net", "instagram.com",
	"wikipedia.org", "wikimedia.org",
	"docker.io", "docker.com", "gcr.io", "ghcr.io", "quay.io",
	"cloudflare.com", "jsdelivr.net"
];

/** True when the host itself (or any parent domain) is on the proxy-required list. */
export function hostRequiresProxy(hostname) {
	const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
	return PROXY_REQUIRED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** True when the value looks like a usable http(s) proxy origin. */
export function isProxyUrl(value) {
	return /^https?:\/\/[A-Za-z0-9.\-_]+:\d{1,5}$/.test(String(value ?? "").trim());
}

/** True when infra has a usable proxy configured. */
export function hasProxy(infra) {
	return isProxyUrl(infra?.proxyUrl);
}

/**
 * 代理车道判定：只有“已配置可用代理”且“目标命中代理清单”时才走代理。
 * 传入 URL 字符串或 URL 对象；无法解析时返回 false（调用方按直连处理，不在这里抛错）。
 */
export function proxyAppliesToUrl(infra, url) {
	if (!hasProxy(infra)) return false;
	try {
		const host = (url instanceof URL ? url : new URL(String(url))).hostname;
		return hostRequiresProxy(host);
	} catch { return false; }
}

/** 本机 DNS 屏蔽/污染的特征值：0.0.0.0 / :: 常被用作“屏蔽这个域名”的应答。
 *  它与真实的私网地址（10./192.168./::1）不是同一件事，报错文案必须能区分。 */
export function isSinkholeAddress(address) {
	const value = String(address ?? "").trim().toLowerCase();
	if (value === "0.0.0.0" || value === "::" || value === "::0") return true;
	return value === "0:0:0:0:0:0:0:0" || value === "0000:0000:0000:0000:0000:0000:0000:0000";
}

/** 把一次本机解析结果说清楚：既有地址，也标记“是否全是被屏蔽应答（0.0.0.0/::）”。
 *  报错与审批文案都要靠它区分「本机屏蔽该域名」和「域名真的是私网地址」。 */
export function describeLocalAnswer(rows) {
	const list = (rows ?? []).map(row => String(row?.address ?? row)).filter(Boolean);
	return { addresses: list.join(', ') || '(解析无结果)', sinkhole: list.length > 0 && list.every(isSinkholeAddress) };
}

/** 命中代理清单、但会话没有可用代理时的统一指引：给出事实与下一步，禁止被改写成“目标不可达”。 */
export function proxyLaneUnconfiguredMessage(host, answer) {
	const reason = answer?.sinkhole
		? `本机 DNS 把它应答为 ${answer.addresses}（0.0.0.0/:: 是本机屏蔽/污染，不是真实私网地址）`
		: `本机解析为 ${answer?.addresses ?? '未知地址'}（私网/保留地址）`;
	return `SRC_GATE_PROXY_REQUIRED_UNCONFIGURED：${host} 命中代理车道，${reason}，当前会话未配置 proxyUrl，出口闸无法为它确定目的地。请让用户先 src_set_infra proxyUrl=<http(s)代理> 再重试本调用；这是本机网络配置问题，不是“目标不可达/目标拒绝/404”，不要据此改写结论。`;
}
