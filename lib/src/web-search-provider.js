// Keyless search provider for the SRC profile.
// Uses fixed public search-engine HTML endpoints; it never accepts a model-supplied URL.

const ENGINES = [
	"https://html.duckduckgo.com/html/?q=",
	"https://www.google.com/search?q="
];
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36";

function cleanHtml(value) {
	return String(value ?? "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/\s+/g, " ").trim();
}

function parseResults(html, engine, maxResults) {
	const text = String(html ?? "");
	const found = [];
	const seen = new Set();
	const patterns = engine.includes("google")
		? [/<a[^>]+href="\/url\?q=([^&"]+)[^>]*>([\s\S]*?)<\/a>/gi, /<a[^>]+href="(https?:\/\/[^"?#]+)[^>]*>([\s\S]*?)<\/a>/gi]
		: [/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi];
	for (const re of patterns) {
		for (const match of text.matchAll(re)) {
			let url = match[1];
			try { url = decodeURIComponent(url); } catch {}
			if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
			seen.add(url);
			const title = cleanHtml(match[2]);
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
	async search(request, signal) {
		const query = String(request?.query ?? "").trim();
		if (query === "") return { sources: [], truncated: false };
		const maxResults = Math.max(1, Math.min(Number(request?.maxResults) || 8, 20));
		let lastError;
		for (const engine of ENGINES) {
			try {
				const response = await fetch(engine + encodeURIComponent(query), {
					method: "GET", redirect: "error", signal,
					headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" }
				});
				if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
				const sources = parseResults(await response.text(), engine, maxResults);
				if (sources.length > 0) return { sources, truncated: false };
				lastError = new Error("search page returned no parseable results");
			} catch (error) {
				if (signal?.aborted) throw error;
				lastError = error;
			}
		}
		throw new Error(`keyless search unavailable: ${lastError?.message ?? "no results"}`);
	}
});

export const name = "src-keyless-search";
export const inject = ["web"];
export function apply(ctx) {
	ctx.web.registerSearchProvider(keylessSearchProvider);
}
