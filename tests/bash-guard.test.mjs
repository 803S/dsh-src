import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBashCommand, explainBashGate, findHttpWriteOps, findDangerousLocal, findScanners } from "../lib/src/bash-guard.js";

test("bash 闸：对 scope 目标的 curl 写动词在 shadow/ask 下都被识别", () => {
	const cmd = 'T=http://8.147.132.32:40590; curl -s -X PUT --data-binary "TESTPUT123" $T/puttest.txt; curl -X DELETE $T/rest/workspaces/topp';
	const shadow = classifyBashCommand(cmd, { scopeHosts: ["8.147.132.32"], mode: "shadow" });
	assert.equal(shadow.verdict, "shadow");
	assert.ok(shadow.signals.some((s) => s.kind === "http-write" && s.method === "PUT"));
	assert.ok(shadow.signals.some((s) => s.kind === "http-write" && s.method === "DELETE"));
	assert.equal(shadow.scopeTarget, true);
	const ask = classifyBashCommand(cmd, { scopeHosts: ["8.147.132.32"], mode: "ask" });
	assert.equal(ask.verdict, "ask");
});

test("bash 闸：只读 GET/OPTIONS/TRACE 探测不触发", () => {
	const cmd = 'curl -s -i http://8.147.132.32:40590/ ; curl -s -I --max-time 10 http://8.147.132.32:40590/; curl -X OPTIONS $T/; curl -X TRACE $T/';
	const r = classifyBashCommand(cmd, { scopeHosts: ["8.147.132.32"], mode: "ask" });
	assert.equal(r.verdict, "allow");
});

test("bash 闸：本机破坏性命令（rm -rf 根、drop database、dd、mkfs、shutdown）触发", () => {
	for (const c of ["rm -rf / ", "sudo rm -rf /*", "psql -c 'DROP DATABASE prod'", "mysql -e 'truncate table users'", "dd if=x of=/dev/sda", "mkfs.ext4 /dev/sdb1", "shutdown -h now", "kubectl delete namespace prod"]) {
		const r = classifyBashCommand(c, { mode: "ask" });
		assert.ok(r.signals.some((s) => s.kind === "local-dangerous"), c);
	}
});

test("bash 闸：工作区/临时目录内的常规 rm 和非破坏性命令不误报", () => {
	for (const c of ["rm /tmp/t.dtd", "rm -f /tmp/out.txt", "cat > /tmp/sld.xml <<'EOF'", "curl -s https://dpaste.com/api/v2/ -F content=@/tmp/t.dtd", "ls -la /tmp"]) {
		const r = classifyBashCommand(c, { mode: "ask" });
		// curl -F 表单上传按设计应触发（外发表单）——本例目标不在 scope，但 -F 属上传面，接受 shadow 级信号。
		if (c.includes("curl -s https://dpaste.com")) assert.ok(r.signals.some((s) => s.kind === "http-write"));
		else assert.equal(r.verdict, "allow", c);
	}
});

test("bash 闸：扫描器识别与自然语言解释", () => {
	const r = classifyBashCommand("nohup ffuf -u http://x/FUZZ -w /tmp/wl.txt -t 60 & sqlmap -u http://x/?a=1", { mode: "ask" });
	assert.ok(r.signals.some((s) => s.kind === "scanner" && s.tool === "ffuf"));
	assert.ok(r.signals.some((s) => s.kind === "scanner" && s.tool === "sqlmap"));
	const text = explainBashGate(r.signals);
	assert.match(text, /扫描器/);
	assert.match(text, /不是安全保证/);
});

test("bash 闸：findHttpWriteOps 对 -T/--upload-file 触发且 scope 判定不误报外站", () => {
	const a = findHttpWriteOps('curl -T /tmp/a.json http://8.147.132.32:40590/x', ["8.147.132.32"]);
	assert.ok(a.hits.some((h) => h.method === "PUT/UPLOAD") && a.hasScopeUrl === true);
	const b = findHttpWriteOps('curl -X POST https://paste.rs/xxetest.dtd', ["8.147.132.32"]);
	assert.ok(b.hits.length > 0 && b.hasScopeUrl === false);
});
