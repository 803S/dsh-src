// Bounded repeat guard for dsh-src-owned tool execution.
// It does not limit a tool globally: only identical calls in one engagement with
// no result change are blocked, and the model receives a concrete change-assumption hint.
import { createHash } from "node:crypto";
const bySession = new Map();
const MAX_IDENTICAL = 3;
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
}
function digest(value) { return createHash("sha256").update(stable(value)).digest("hex").slice(0, 16); }
function sessionRows(sessionId) { let rows = bySession.get(sessionId); if (!rows) bySession.set(sessionId, rows = new Map()); return rows; }
export function repeatFingerprint(exec) {
  const name = String(exec?.name ?? "");
  if (!(name === "bash" || name === "src_http" || name === "web_search" || name.startsWith("mcp__"))) return "";
  return `${name}:${digest(exec?.arguments ?? {})}`;
}
export function beforeRepeat(exec) {
  const fp = repeatFingerprint(exec); if (!fp) return { allowed: true, fingerprint: "" };
  const rows = sessionRows(exec?.agent?.session?.id ?? ""); const row = rows.get(fp) ?? { calls: 0, lastResult: "", unchanged: 0 };
  row.calls += 1; rows.set(fp, row);
  if (row.unchanged >= MAX_IDENTICAL) return { allowed: false, fingerprint: fp, reason: `同一 ${String(exec.name)} 已重复 ${row.unchanged} 次且结果无变化；请换假设、换输入、记录 blocked/research，或停止该方向。` };
  return { allowed: true, fingerprint: fp };
}
export function afterRepeat(exec, fingerprint, result) {
  if (!fingerprint) return;
  const row = sessionRows(exec?.agent?.session?.id ?? "").get(fingerprint); if (!row) return;
  const value = result?.value ?? result?.content ?? result?.error ?? result?.isError ?? result;
  const current = digest(value);
  if (row.lastResult !== "" && row.lastResult === current) row.unchanged += 1; else row.unchanged = 0;
  row.lastResult = current;
}
export function resetRepeatGuardForTests() { bySession.clear(); }
