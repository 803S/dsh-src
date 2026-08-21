// 真实会话全量重放测试：模拟客户端打开会话时 fold + view 的每一步
import { readFileSync } from "node:fs";
import { applySrcEvent, viewSrcState, srcInitialState } from "/Users/lihua-dis/Software/dsh-src/lib/src.js";

const lines = readFileSync("/tmp/src-session.jsonl", "utf-8").split("\n").filter(Boolean);
console.log("事件总数:", lines.length);
let state = JSON.parse(JSON.stringify(srcInitialState));
let foldErrors = 0;
for (let i = 0; i < lines.length; i++) {
	let e;
	try { e = JSON.parse(lines[i]); } catch { continue; }
	try {
		const next = applySrcEvent(state, e);
		if (next !== undefined && next !== null) state = next;
	} catch (err) {
		foldErrors++;
		if (foldErrors <= 5) console.log(`fold error @${i} (${e.type}):`, err?.message ?? err);
	}
}
console.log("fold 错误数:", foldErrors);
try {
	const view = viewSrcState(state);
	console.log("✓ view 构建成功 | observations:", view.observations.length, "| userTodos:", view.userTodos.length, "| counts:", JSON.stringify(view.counts));
	const obs0 = view.observations[0];
	if (obs0) console.log("obs[0] keys:", Object.keys(obs0).join(","));
	console.log("infra resolved:", JSON.stringify(view.infra));
} catch (err) {
	console.log("✗ viewSrcState CRASH:", err?.message ?? err);
	console.log(err?.stack?.split("\n").slice(0, 8).join("\n"));
}
