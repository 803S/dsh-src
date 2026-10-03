// Keyless search provider for the SRC profile.
// Uses fixed public search-engine HTML endpoints; it never accepts a model-supplied URL.
import { AsyncLocalStorage } from "node:async_hooks";

const infraFetchContext = new AsyncLocalStorage();
let infraFetchResolver = null;
export function configureKeylessSearchInfra(resolver) { infraFetchResolver = typeof resolver === "function" ? resolver : null; }
export function withKeylessSearchInfra(fetcher, operation) { return infraFetchContext.run({ fetcher }, operation); }
const ENGINES = [
	{ id: "duckduckgo", prefix: "https://html.duckduckgo.com/html/?q=" },
	{ id: "google", prefix: "https://www.google.com/search?q=" },
	{ id: "bing", prefix: "https://www.bing.com/search?q=" },
	{ id: "baidu", prefix: "https://www.baidu.com/s?wd=" }
];
const ENGINE_BY_ID = new Map(ENGINES.map((engine) => [engine.id, engine]));

function requestedEngine(request) {
	const value = String(request?.engine ?? request?.provider ?? "auto").trim().toLowerCase();
	return value === "" ? "auto" : value;
}

function enginePlan(request) {
	const requested = requestedEngine(request);
	if (requested === "auto") return { requested, engines: ENGINES };
	const selected = ENGINE_BY_ID.get(requested);
	if (selected === void 0) throw new Error(`unsupported search engine: ${requested} (use auto|duckduckgo|google|bing|baidu)`);
	return { requested, engines: [selected] };
}
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36";

function cleanHtml(value) {
	return String(value ?? "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/\s+/g, " ").trim();
}

export function relevantSearchResults(sources, query) {
 const terms=[...new Set(String(query).toLowerCase().match(/cve-\d{4}-\d+|[a-z][a-z0-9_-]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [])].filter(t=>!['vulnerability','vulnerabilities','search','with','this','that','from','known','versions'].includes(t));
 const identifiers=terms.filter(t=>/^cve-/.test(t));
 return sources.filter(s=>{const text=`${s.title??''} ${s.url} ${s.snippet??''}`.toLowerCase();return identifiers.length?identifiers.some(t=>text.includes(t)):terms.length===0||terms.some(t=>text.includes(t));});
}
function parseResults(html, engine, maxResults) {
	const text = String(html ?? "");
	const found = [];
	const seen = new Set();
	const patterns = engine.id === "google"
		? [/<a[^>]+href="\/url\?q=([^&"]+)[^>]*>([\s\S]*?)<\/a>/gi, /<a[^>]+href="(https?:\/\/[^"?#]+)[^>]*>([\s\S]*?)<\/a>/gi]
		: engine.id === "bing"
			? [/<li[^>]+class="[^"]*b_algo[^"]*"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi]
			: engine.id === "baidu"
				? [/<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi]
				: [/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi];
	for (const re of patterns) {
		for (const match of text.matchAll(re)) {
			let url = match[1].replace(/&amp;/g,'&');
			try {const u=new URL(url);if(u.hostname.endsWith('bing.com')&&u.pathname==='/ck/a'){const dest=u.searchParams.get('u');if(dest?.startsWith('a1'))url=Buffer.from(dest.slice(2),'base64').toString('utf8');}}catch{}
			try { url = decodeURIComponent(url); } catch {}
			if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
			seen.add(url);
			const title = cleanHtml(match[2]);
			if (engine.id === "google" && (/support\.google\.com\/websearch/i.test(url) || /^(?:意見|feedback|help)$/i.test(title))) continue;
			const around = text.slice(Math.max(0, match.index - 50), Math.min(text.length, match.index + 900));
			found.push({ url, ...(title ? { title } : {}), snippet: cleanHtml(around).slice(0, 500) });
			if (found.length >= maxResults) return found;
		}
	}
	return found;
}

export const keylessSearchProvider = Object.freeze({
	id: "src-keyless-search",
	available: () => true,
	async search(request, signal, fetchImpl = globalThis.fetch) {
		const query = String(request?.query ?? "").trim();
		if (query === "") return { sources: [], truncated: false };
		const maxResults = Math.max(1, Math.min(Number(request?.maxResults) || 8, 20));
		const plan = enginePlan(request);
		const fetcher = infraFetchContext.getStore()?.fetcher ?? (infraFetchResolver !== null ? await infraFetchResolver() : globalThis.fetch);
		const failures = [];
		for (const engine of plan.engines) {
			try {
				const response = await fetcher(engine.prefix + encodeURIComponent(query), {
					method: "GET", redirect: "error", signal,
					headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" }
				});
				if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
				const sources = relevantSearchResults(parseResults(await response.text(), engine, maxResults),query);
				if (sources.length > 0) return { engine: engine.id, requestedEngine: plan.requested, sources, truncated: false, ...(failures.length > 0 ? { failures } : {}) };
				failures.push({ engine: engine.id, reason: "search page returned no parseable results relevant to query (may be blocked or unrelated content)" });
			} catch (error) {
				if (signal?.aborted) throw error;
				failures.push({ engine: engine.id, reason: String(error?.message ?? error).slice(0, 200) });
			}
		}
		const detail = failures.map((item) => `${item.engine}: ${item.reason}`).join("; ");
		throw new Error(`keyless search unavailable (${plan.requested}): ${detail || "no results"}`);
	}
});

export const name = "src-keyless-search";
export const inject = ["web"];
export function apply(ctx) {
	ctx.web.registerSearchProvider(keylessSearchProvider);
}
