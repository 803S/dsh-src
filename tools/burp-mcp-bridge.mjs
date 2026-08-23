#!/usr/bin/env node
/**
 * burp-mcp-bridge.mjs — 自愈式 MCP stdio↔SSE 桥（替换 PortSwigger mcp-proxy.jar）
 *
 * 背景：jar 内 Kotlin SDK 的 SseClientTransport 与 Burp 扩展之间的长连 SSE 断掉后
 * （空闲超时/睡眠唤醒/Burp GC），jar 进程存活但传输已死，后续调用全部报
 * "MCP error -32603: SseClientTransport is not initialized!"，且宿主监督器只在
 * 子进程退出时重连，僵尸状态无法自愈。
 *
 * 本桥策略：持久会话 + 懒自愈。任何请求失败（流断/POST 失败/超时/会话过期）→
 * 丢弃当前会话 → 下次调用自动开全新 SSE 会话（重新 initialize）并重试一次。
 * 对上层完全透明；服务端通知（如 tools/list_changed）照常转发下游。
 *
 * 协议：stdin/stdout 换行分隔 JSON-RPC（MCP StdioClientTransport 约定）；
 * 上游 GET <base> 收 text/event-stream（首事件 endpoint 给出 POST 地址），
 * JSON-RPC 响应经 event:message 异步回传（POST 通常仅 202 Accepted）。
 *
 * 环境变量：
 *   BURP_SSE_URL           上游基址，默认 http://localhost:9876/
 *   BURP_BRIDGE_TIMEOUT_MS 单请求超时，默认 90000（宿主 toolCallTimeoutMs=120000）
 *   BURP_BRIDGE_LOG        debug|info|warn|error，默认 info
 *
 * 零依赖（node ≥18 全局 fetch）。诊断一律走 stderr。
 */
import { createInterface } from "node:readline";

const BASE_URL = (process.env.BURP_SSE_URL ?? "http://localhost:9876/").trim() || "http://localhost:9876/";
const TIMEOUT_MS = Number(process.env.BURP_BRIDGE_TIMEOUT_MS ?? 90000) || 90000;
const LOG_LEVEL = process.env.BURP_BRIDGE_LOG ?? "info";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const log = (level, msg) => {
	if ((LEVELS[level] ?? 20) >= (LEVELS[LOG_LEVEL] ?? 20)) process.stderr.write(`[burp-bridge] ${new Date().toISOString()} ${level}: ${msg}\n`);
};

//#region 上游 SSE 会话
/** 一个到 Burp 扩展的 MCP 会话：SSE 读流 + endpoint POST + 待决响应表。 */
class UpstreamSession {
	constructor() {
		this.postUrl = null;
		this.pending = new Map(); // id -> {resolve, reject, timer}
		this.serverRequests = new Set(); // 服务端→客户端请求 id（回 -32601 防挂）
		this.closed = false;
		this.controller = new AbortController();
		this.nextId = 1;
	}

	async open() {
		const res = await fetch(BASE_URL, {
			headers: { Accept: "text/event-stream" },
			signal: this.controller.signal
		});
		if (!res.ok || !res.body) throw new Error(`SSE handshake failed: HTTP ${res.status}`);
		log("debug", `SSE stream opened (${res.status})`);
		void this.pump(res.body);
		// 等 endpoint 事件给出 POST 地址
		const deadline = Date.now() + 10000;
		while (this.postUrl === null) {
			if (this.closed) throw new Error("SSE stream closed before endpoint event");
			if (Date.now() > deadline) { this.close(); throw new Error("timed out waiting for SSE endpoint event"); }
			await new Promise((r) => setTimeout(r, 25));
		}
		return this;
	}

	/** 解析 SSE 流：空行分块，event/data 行；JSON-RPC 消息路由到 pending。 */
	async pump(body) {
		const decoder = new TextDecoder();
		let buf = "";
		try {
			for await (const chunk of body) {
				buf += decoder.decode(chunk, { stream: true });
				let idx;
				while ((idx = buf.indexOf("\n\n")) !== -1 || (idx = buf.indexOf("\r\n\r\n")) !== -1) {
					const block = buf.slice(0, idx);
					buf = buf.slice(idx + (buf[idx] === "\r" ? 4 : 2));
					this.handleEventBlock(block);
				}
			}
			log("info", "SSE stream ended");
		} catch (error) {
			if (!this.closed) log("warn", `SSE stream error: ${error?.message ?? error}`);
		} finally {
			this.finish();
		}
	}

	handleEventBlock(block) {
		let event = "message";
		const dataLines = [];
		for (const line of block.split("\n").map((l) => l.replace(/\r$/, ""))) {
			if (line.startsWith(":")) continue; // 注释/心跳
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
		}
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n");
		if (event === "endpoint") {
			try { this.postUrl = new URL(data, BASE_URL).toString(); } catch { this.postUrl = BASE_URL.replace(/\/$/, "/") + data; }
			log("debug", `endpoint: ${this.postUrl}`);
			return;
		}
		let message;
		try { message = JSON.parse(data); } catch { log("debug", `non-JSON event "${event}": ${data.slice(0, 80)}`); return; }
		this.routeMessage(message);
	}

	routeMessage(message) {
		if (message === null || typeof message !== "object") return;
		const hasId = message.id !== void 0 && message.id !== null;
		if (!hasId && message.method !== void 0) {
			// 服务端通知：转发给下游（dsh-mcp-client 靠它感知 tools/list 变更）
			writeDownstream(message);
			return;
		}
		if (hasId && message.method !== void 0 && message.result === void 0) {
			// 服务端→客户端请求（sampling/roots 等）：拒绝，防服务端挂等
			this.serverRequests.add(message.id);
			this.post({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "bridge does not support server-initiated requests" } }).catch(() => {});
			return;
		}
		if (hasId) {
			const entry = this.pending.get(message.id);
			if (entry !== void 0) {
				this.pending.delete(message.id);
				clearTimeout(entry.timer);
				entry.resolve(message);
			}
		}
	}

	/** POST 一条消息；部分实现会在响应体里直接带 JSON-RPC 结果（兼容两种回传方式）。 */
	async post(message) {
		const res = await fetch(this.postUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify(message),
			signal: this.controller.signal
		});
		if (!res.ok) throw new Error(`upstream POST ${message.method ?? "response"} -> HTTP ${res.status}`);
		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			const text = await res.text();
			if (text.trim() !== "") {
				try { this.routeMessage(JSON.parse(text)); } catch { /* 忽略非 JSON-RPC 体 */ }
			}
		}
	}

	/** 发送请求并等待流上回来的同 id 响应。 */
	request(method, params) {
		const id = this.nextId++;
		const payload = { jsonrpc: "2.0", id, method, ...(params !== void 0 ? { params } : {}) };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${TIMEOUT_MS}ms`));
			}, TIMEOUT_MS);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			this.post(payload).catch((error) => {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	finish() {
		if (this.closed) return;
		this.closed = true;
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error("upstream session closed"));
		}
		this.pending.clear();
		try { this.controller.abort(); } catch {}
	}

	close() { this.finish(); }
}

let session = null;

async function openSession() {
	const fresh = await new UpstreamSession().open();
	await fresh.request("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "burp-mcp-bridge", version: "1.0.0" }
	});
	await fresh.post({ jsonrpc: "2.0", method: "notifications/initialized" });
	session = fresh;
	log("info", "upstream session established");
	return fresh;
}

function dropSession(reason) {
	if (session === null) return;
	log("info", `dropping upstream session: ${reason}`);
	session.close();
	session = null;
}

/** 转发一个请求；失败时关会话换新会话重试一次（自愈核心）。 */
async function forwardWithHeal(method, params) {
	for (let attempt = 1; attempt <= 2; attempt++) {
		if (session === null || session.closed) {
			try { await openSession(); } catch (error) {
				dropSession(error?.message ?? "open failed");
				throw new Error(`Burp MCP unavailable: ${error?.message ?? error}`);
			}
		}
		try {
			return await session.request(method, params);
		} catch (error) {
			dropSession(error?.message ?? "request failed");
			if (attempt === 2) throw error;
			log("info", `retrying ${method} on a fresh session`);
		}
	}
}
//#endregion

//#region 恢复探测：上游不可用被降级后，后台周期性试连；恢复即发 tools/list_changed
let probeTimer = null;

function scheduleRecoveryProbe() {
	if (probeTimer !== null) return;
	const tick = async () => {
		probeTimer = null;
		try {
			const fresh = await openSession();
			await fresh.request("tools/list", {});
			writeDownstream({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			log("info", "upstream recovered; notified host via tools/list_changed");
		} catch {
			dropSession("recovery probe failed");
			probeTimer = setTimeout(tick, 15000);
			probeTimer.unref?.();
		}
	};
	probeTimer = setTimeout(tick, 5000);
	probeTimer.unref?.();
}
//#endregion

//#region 下游 stdio（换行分隔 JSON-RPC）
const writeDownstream = (message) => {
	process.stdout.write(JSON.stringify(message) + "\n");
};

const replyError = (id, code, message) => {
	writeDownstream({ jsonrpc: "2.0", id, error: { code, message } });
};

async function handleRequest(id, method, params) {
	switch (method) {
		case "initialize": {
			// 下游握手不依赖上游在线——真正转发推迟到首次工具调用，避免 Burp 未开时 dsh 反复重建进程。
			return {
				protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "burp-mcp-bridge", version: "1.0.0" }
			};
		}
		case "tools/list": {
			/* 上游不可用时回空列表而非报错：宿主把 tools/list 失败当连接失败触发重连循环；
			 * 回空列表则连接保持健康，watchdog 探测到 Burp 恢复后发 list_changed 让宿主重新同步。 */
			try {
				const result = await forwardWithHeal(method, params);
				return result.result;
			} catch (error) {
					log("warn", `tools/list degraded to empty (upstream unavailable): ${error?.message ?? error}`);
				scheduleRecoveryProbe();
				return { tools: [] };
			}
		}
		case "tools/call":
		case "ping": {
			const result = await forwardWithHeal(method, params);
			return result.result;
		}
		default:
			throw Object.assign(new Error(`method not supported by bridge: ${method}`), { code: -32601 });
	}
}
//#endregion

//#region 主循环
log("info", `starting (base=${BASE_URL}, timeout=${TIMEOUT_MS}ms)`);

// 串行处理请求，避免并发打爆扩展的单会话
let chain = Promise.resolve();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (trimmed === "") return;
	let message;
	try { message = JSON.parse(trimmed); } catch { log("warn", `unparseable downstream line: ${trimmed.slice(0, 80)}`); return; }
	if (message === null || typeof message !== "object") return;
	if (message.method !== void 0 && message.id !== void 0 && message.id !== null) {
		chain = chain.then(() => handleRequest(message.id, message.method, message.params)).then(
			(result) => writeDownstream({ jsonrpc: "2.0", id: message.id, result }),
			(error) => replyError(message.id, error?.code ?? -32603, error?.message ?? String(error))
		);
	} else {
		// 通知（notifications/initialized、cancelled 等）：忽略
		log("debug", `ignoring notification: ${message.method}`);
	}
});

const shutdown = (signal) => {
	log("info", `${signal} received; shutting down`);
	dropSession("shutdown");
	process.exit(0);
};
process.stdin.on("end", () => shutdown("stdin-end"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
//#endregion
