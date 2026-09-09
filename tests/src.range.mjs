import http from "node:http";
import crypto from "node:crypto";

/* [local.67 #19] 本地渗透靶场（mock target range）。
 * 目的：把「155 测试全绿、实战产出为零」的盲区补上——现有测试验证代码不坏，靶场验证产出。
 * 断言产出而非不崩：
 *   ① 未授权可达端点（#11b：未授权可达+PoC 即入库 low 起评）
 *   ② 缺 Content-Type 即 415 的写入端点（锁 §1.5 假阴性事故：fetch 对字符串 body 不自动加
 *      application/json，agent 拿到 415 盲发 5 发变体+错误归因「上传白名单」）
 *   ③ 未授权写入→落库回读→删除零残留三步链（Cairn 打法模板）
 *   ④ 敏感数据返回端点（#17 响应体透传 + 凭证掩码验证）
 * 靶场是纯 node:http 内存实现，无外部依赖；状态（写入的数据）在服务器实例内，测试间互不影响。
 */

/** 创建一个靶场实例。返回 { server, port, url, db, close }。
 * db 是内存存储（Map），测试可直接检查「零残留」断言。 */
export function createRange() {
	const db = { records: new Map(), nextId: 1, contentTypesSeen: [] };
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
			const url = new URL(req.url ?? "/", `http://127.0.0.1`);
			const path = url.pathname;
			const json = (status, payload) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			/* ② 缺 Content-Type 即 415：模拟 Spring @RequestBody 行为——POST JSON 端点
			   在 body 非空但 Content-Type 不是 application/json 时拒绝（415）。
			   正确带头的请求返回 200 + succ:ok（对照 Cairn PoC 的实锤行为）。 */
			if (req.method === "POST" && path === "/api/v1/schedule/upload") {
				if (contentType !== "application/json" && !contentType.startsWith("application/json;")) {
					db.contentTypesSeen.push({ contentType, body: body.slice(0, 200) });
					return json(415, { code: "SYS004", message: "Unsupported Media Type" });
				}
				try {
					const parsed = JSON.parse(body);
					const id = `rec-${db.nextId++}`;
					db.records.set(id, parsed);
					return json(200, { succ: "ok", id });
				} catch {
					return json(400, { code: "SYS002", message: "bad json" });
				}
			}
			/* ③ 写入→回读→删除链：
			   - POST /api/v1/notes 未授权写入（无 token 也收）→ 201 {id}
			   - GET /api/v1/notes/<id> 回读 → 200（内容含写入数据）
			   - DELETE /api/v1/notes/<id> 删除 → 204；之后再 GET → 404（零残留可在 db 断言） */
			if (req.method === "POST" && path === "/api/v1/notes") {
				if (contentType !== "application/json" && !contentType.startsWith("application/json;")) {
					return json(415, { code: "SYS004", message: "Unsupported Media Type" });
				}
				try {
					const parsed = JSON.parse(body);
					const id = `rec-${db.nextId++}`;
					db.records.set(id, parsed);
					return json(201, { succ: "ok", id });
				} catch {
					return json(400, { code: "SYS002", message: "bad json" });
				}
			}
			const noteMatch = /^\/api\/v1\/notes\/([a-z0-9-]+)$/.exec(path);
			if (noteMatch !== null) {
				const id = noteMatch[1];
				if (req.method === "GET") {
					const record = db.records.get(id);
					if (record === void 0) return json(404, { code: "SYS001", message: "not found" });
					return json(200, { succ: "ok", data: record });
				}
				if (req.method === "DELETE") {
					const existed = db.records.delete(id);
					return existed ? (res.writeHead(204), res.end()) : json(404, { code: "SYS001", message: "not found" });
				}
			}
			/* ① 未授权可达：公开诊断端点（无任何认证即返回环境信息）——#11b 的「未授权可达即 low」素材 */
			if (req.method === "GET" && path === "/api/v1/health/config") {
				return json(200, { succ: "ok", data: { env: "prod", dbHost: "10.0.3.21:3306", secretKey: "sk-live-0123456789abcdef", version: "2.4.1" } });
			}
			if (req.method === "GET" && path === "/api/v1/users/query") {
				/* 强读语义（users/query 在 src_http 放行白名单内），返回敏感字段——#17 掩码验证用 */
				return json(200, { succ: "ok", data: { userId: 3, phone: "13800001111", idCard: "110101199001011234", sessionToken: "tok-live-abc123def456", email: "victim@example.test" } });
			}
			/* ④ 带敏感头的回显端点：验证掩码把凭证形态打掉 */
			if (req.method === "GET" && path === "/api/v1/echo/headers") {
				return json(200, { succ: "ok", headers: { cookie: req.headers.cookie ?? "", authorization: req.headers.authorization ?? "" } });
			}
			/* 大响应端点：#17 截断验证（默认 2KB） */
			if (req.method === "GET" && path === "/api/v1/export/big") {
				return json(200, { succ: "ok", data: "x".repeat(20 * 1024) });
			}
			/* 二进制端点：#17 只回长度不回内容 */
			if (req.method === "GET" && path === "/api/v1/export/image") {
				res.writeHead(200, { "content-type": "image/png" });
				res.end(Buffer.alloc(4096, 7));
				return;
			}
			/* 重复内容端点：#17 去重验证（同 path 两次相同响应 → 第二次 hash+长度） */
			if (req.method === "GET" && path === "/api/v1/status") {
				return json(200, { succ: "ok", ts: 1700000000 });
			}
			json(404, { code: "SYS001", message: "not found" });
		});
	});
	const listen = new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return listen.then(() => ({
		server,
		port: server.address().port,
		url: `http://127.0.0.1:${server.address().port}`,
		db,
		close: () => new Promise((resolve) => server.close(resolve))
	}));
}
