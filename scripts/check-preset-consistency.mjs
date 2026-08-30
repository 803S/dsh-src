#!/usr/bin/env node
// [local.23] 预设一致性检查：扫描 preset/src-hunter/agent.cordis.yml，对每个 persona 校验——
// ① prompt 文本里点名的 src_* 工具，若出现在该 persona 的 deny 列表里 = 提示词与工具面矛盾（子代理按提示词行事会被 deny 拦死）
// ② 所有 persona 都应 deny 指挥官专用工具（src_add_goal/src_add_intent/src_add_test_account/src_finalize_engagement/src_set_infra/src_fetch_policy）防越权改会话状态
// 行扫描器（不依赖 js-yaml，因 preset 含 !!js 自定义标签标准解析器会拒），按 - id: 行切块，逐块读 persona 块标量与 deny 流式序列。
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(join(root, "preset/src-hunter/agent.cordis.yml"), "utf8");
const lines = text.split("\n");

const TOOL_RE = /\b(src_[a-z_]+)\b/g;
/* [local.43] src_add_asset 移出指挥官专用清单：授权模型「资产清单即许可」——recon/audit 子代理
 * 自查归属后可登记资产（沿父链写入同一份清单，闸按「goal 主域内或资产清单内」放行）；verify 仍 deny。 */
const COMMANDER_TOOLS = ["src_add_goal", "src_add_intent", "src_add_test_account", "src_finalize_engagement", "src_set_infra", "src_fetch_policy", "src_set_goal_target", "src_add_fact", "src_add_finding", "src_update_intent", "src_update_finding", "src_record_lesson", "src_record_domain_note", "src_reject_finding", "src_resolve_approval", "src_read_capability", "src_run_capability"];

// 切块：每个 - id: ... 开始一个 entry，直到下一个同级 - id 或文件末尾。
const entries = [];
let cur = null;
for (let i = 0; i < lines.length; i++) {
  const m = /^(- id: )(\S+)/.exec(lines[i]);
  if (m) {
    cur = { id: m[2], lines: [] };
    entries.push(cur);
  } else if (cur) cur.lines.push(lines[i]);
}

let violations = 0;
for (const e of entries) {
  if (!e.lines.some((l) => /\bpersona:\s*\|-/.test(l) || /\bpersona:\s*\|/.test(l) || /\bpersona:\s*>-/.test(l))) continue;
  // persona 块标量：persona: |- 之后缩进更深的连续行（直到缩进回退到 persona 或更浅）
  const blockLines = [];
  let inBlock = false, baseIndent = 0;
  for (const l of e.lines) {
    if (!inBlock) {
      if (/^\s*persona:\s*\|/.test(l)) { inBlock = true; baseIndent = (/^(\s*)persona:/.exec(l)?.[1]?.length ?? 0) + 2; continue; }
    } else {
      const indent = /^(\s*)\S/.exec(l)?.[1]?.length ?? -1;
      if (l.trim() === "" ) { blockLines.push(l); continue; }
      if (indent >= baseIndent) blockLines.push(l);
      else if (/^\s*(name|config|provider|toolFilter|maxDepth|backgroundMode|toolName|group|isolate)\b/.test(l)) break;
      else break;
    }
  }
  const prompt = blockLines.join("\n");
  // deny 流式序列：deny: [a, b, c]
  const denyMatch = e.lines.find((l) => /^\s*deny:\s*\[/.test(l));
  if (!denyMatch) continue;
  const deny = new Set((denyMatch.match(/\[([^\]]*)\]/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean));

  const referenced = new Set();
  let m2;
  while ((m2 = TOOL_RE.exec(prompt)) !== null) referenced.add(m2[1]);
  const conflicts = [...referenced].filter((name) => deny.has(name));
  if (conflicts.length > 0) {
    console.error(`::error file=preset/src-hunter/agent.cordis.yml::persona ${e.id} 的 prompt 点名了工具 ${conflicts.join(", ")} 但同时 deny 了它们——提示词与工具面矛盾，子代理按提示词行事会被 deny 拦死`);
    violations += conflicts.length;
  }
  const missing = COMMANDER_TOOLS.filter((name) => !deny.has(name));
  if (missing.length > 0) {
    console.error(`::error file=preset/src-hunter/agent.cordis.yml::persona ${e.id} 未 deny 指挥官专用工具 ${missing.join(", ")}——子代理可能越权改写会话状态`);
    violations += missing.length;
  }
}

if (violations > 0) { console.error(`check-preset-consistency: ${violations} 处不一致`); process.exit(1); }
console.log("check-preset-consistency: persona×toolFilter 一致性 OK");
