// Phase 7 测绘种子闭环（optimization handbook 2026-09-12 §11 Phase 7，local.81）。
// 纯函数层：不 import 组合根（lib/src.js），不读写时钟以外的全局——与 event-store.js 同一纪律。
// 种子纪律（一种子闭环、401 判存活、锁面禁 FOFA）由服务端闸与工具返回引导语落实，不进协议常驻文本。

import { srcSurveyFlag } from "./flags.js";

/** 种子表 key：sessionId:survey-seed-<n>（与 recordKey 同款）。 */
export function surveySeedKey(sessionId, id) {
	return `${sessionId}:${id}`;
}

/** host 提取（与 tools/index.js local.79 的 hostOf 同逻辑，这里成为唯一实现）。 */
export function hostOf(value) {
	try { return new URL(/^https?:\/\//.test(value) ? value : `https://${value}`).hostname; } catch { return String(value).toLowerCase(); }
}

/** 子域判定：h 等于 base 或为其点分子域。 */
function isHostUnder(h, base) {
	return h === base || h.endsWith(`.${base}`);
}

/**
 * [闭环判定] active 种子是否已处置完毕。该种子 value 的 host（及其子域）下每个已登记资产
 * 满足以下之一即算处置——有 coverage 行绑定 / fact·finding 文本提及（hostOf 弱关联，口径同 local.79 闸二A）/
 * status=excluded。未登记任何资产也算处置（种子里没长出东西=挖完了）。
 * 返回 { closed, remaining[] }（remaining 为未处置资产的 id/host 列表）。
 */
export function seedClosureStatus(seed, { assets = [], coverage = [], facts = [], findings = [] } = {}) {
	const base = hostOf(seed.value);
	const seedAssets = assets.filter((a) => a.status !== "excluded" && isHostUnder(hostOf(a.value), base));
	const coveredAssetIds = new Set(coverage.filter((row) => row.assetId !== void 0).map((row) => row.assetId));
	const mentioned = (asset) => {
		const h = hostOf(asset.value);
		return facts.some((f) => hostOf(f.target ?? "") === h || String(f.detail ?? "").includes(h)) || findings.some((f) => String(f.detail ?? "").includes(h));
	};
	const remaining = seedAssets.filter((asset) => !coveredAssetIds.has(asset.id) && !mentioned(asset)).map((asset) => ({ id: asset.id, host: hostOf(asset.value) }));
	return { closed: remaining.length === 0, remaining };
}

/** 停放页关键词（parked 判定；大小写不敏感）。 */
const PARKED_PATTERNS = /停放|出售|parking|buy this domain|默认站点|domain for sale|this domain is for sale/i;

/**
 * [存活判定] 响应分类：'alive' | 'parked' | 'dead'。
 * dead=超时/连接失败/DNS 不解析；parked=200 但命中停放页关键词；
 * 其余一律 alive——401/403/登录页/挑战页/WAF 拦截页都是 alive（硬性口径：存活≠在登录表单上耗）。
 */
export function classifyProbeResponse({ ok = true, status = 0, bodySnippet = "" } = {}) {
	if (ok !== true) return "dead";
	if (status === 0) return "dead";
	if (status === 200 && PARKED_PATTERNS.test(String(bodySnippet))) return "parked";
	return "alive";
}

/**
 * 锁面/自由跳模式判定：goal.target 是具体 host（含 scheme 或点分域名）→ locked；
 * 含「集团|公司|全体|所有」或纯品牌词 → free。返回 { mode, guidance }，
 * guidance 是返回给模型的引导语（不进协议常驻）。
 */
export function surveyModeOf(goalTarget) {
	const raw = String(goalTarget ?? "").trim();
	const hasScheme = /^https?:\/\//.test(raw);
	const isHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(raw) && !/集团|公司|全体|所有/.test(raw);
	if (hasScheme || isHost) return {
		mode: "locked",
		guidance: "锁面模式：种子仅用于组织归属确认与范围决策，禁止 FOFA 自由跳；只在已授权 host 内穷尽端点。"
	};
	return {
		mode: "free",
		guidance: "自由跳模式：目标是模糊主体（集团/品牌），可经 FOFA provider 发现关联域名；入队前按股权闸确认归属，参股/拿不准的交用户在待办确认，默认不挖。"
	};
}

/** FOFA key 惰性读取（无 key 时全功能降级，不报错）。 */
export function fofaKey() {
	return String(process.env.DSH_SRC_FOFA_KEY ?? "").trim();
}

/** 默认 FOFA query 端点（可被 env 覆盖，惰性）。 */
function fofaBase() {
	return String(process.env.DSH_SRC_FOFA_BASE ?? "https://api.fofa.info/api/v1/domains").trim();
}

/** 从 FOFA 响应体里提取 host 列表（宽松：匹配裸域名字符串）。 */
function extractHosts(body) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	const found = new Set();
	for (const match of text.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? []) {
		const host = match.toLowerCase();
		if (host.includes(".") && !/^\d+\.\d+$/.test(host) && host.length > 3) found.add(host);
	}
	return [...found];
}

/**
 * FOFA provider（可选，无 key 全降级）：围绕单个种子查询关联域名。
 * key/bas/maxPages/fetchImpl/sleep 全部注入以便测试；纯异步函数，不写库不写日志。
 * 返回 { ok, degraded, hosts[], note }。key 值绝不进返回。
 */
export async function fofaSearch(seed, { key = fofaKey(), base = fofaBase(), maxPages = 3, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
	if (key === "") return { ok: false, degraded: true, hosts: [], note: "未配置 DSH_SRC_FOFA_KEY，跳过 FOFA provider；种子闭环不依赖它" };
	if (typeof fetchImpl !== "function") return { ok: false, degraded: true, hosts: [], note: "FOFA fetch 未注入（测试/宿主未提供 http），跳过；种子闭环不依赖它" };
	const pages = Math.max(1, Math.min(Number(maxPages) || 3, 10));
	const hosts = new Set();
	let retries = 0;
	for (let page = 1; page <= pages; page++) {
		let response;
		try {
			response = await fetchImpl(`${base}?domain=${encodeURIComponent(hostOf(seed.value))}&page=${page}`, { method: "GET", headers: { "x-fofa-key": key } });
		} catch {
			return { ok: false, degraded: false, hosts: [...hosts], note: `FOFA 请求失败（page ${page}），返回已得 ${hosts.size} host` };
		}
		if (response.status === 429) {
			if (retries >= 3) return { ok: false, degraded: false, hosts: [...hosts], note: `FOFA 429 退避 3 次仍被限流，返回部分结果 ${hosts.size} host` };
			await sleep(1000 * 2 ** retries);
			retries += 1;
			page -= 1;
			continue;
		}
		if (response.status !== 200) return { ok: false, degraded: false, hosts: [...hosts], note: `FOFA 返回 ${response.status}，返回已得 ${hosts.size} host` };
		const body = await response.text();
		for (const host of extractHosts(body)) hosts.add(host);
	}
	return { ok: true, degraded: false, hosts: [...hosts], note: `provider=fofa, ${hosts.size} hosts` };
}

/** 测试辅助：探测 FOFA 是否开启（惰性）。 */
export const fofaEnabled = () => srcSurveyFlag() !== "off";
