#!/usr/bin/env node
// Read-only quiescence check before touching a running Web service.
//
// 两层探测（0.1 → 0.2 迁移后 0.2 网关不再有单方法 RPC，见
// docs/web-profile-0.2-upgrade-sandbox-20261016.md §4 与 §7）：
//   第一层 0.1：POST /api/session.list（0.1 才有；0.2 返回 404/401 ⇒ 落到第二层）
//   第二层 0.2：读 $DSH_HOME/storages/session_projcache/sessions/*.json 的
//               turnBoundary.openTurnStartSeq 判断有无进行中的轮次
// 两层都不可用时刻意 fail-closed（exit 2/3），由 start-dsh-web.sh 决定是否 DSH_WEB_FORCE=1 强推。
//
// ⚠️ 只用 `turnBoundary.openTurnStartSeq`，**不要**用 `sessionStats.openStep`：
// 真实 486 份投影里 openTurnStartSeq 非空的有 0 份，而 openStep 非空的有 70 份——
// 后者是崩溃/中断会话留下的陈旧值（文件 mtime 已是数天前），拿它判忙会永远拒绝重启。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';

/** 第一层：0.1 单方法 RPC。识别不了返回 null（而不是抛错）。 */
export async function probeLegacyRpc(url = base) {
  const method = 'session.list';
  let response;
  try {
    response = await fetch(`${url}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {} }),
      signal: AbortSignal.timeout(15000),
    });
  } catch { return null; }
  if (!response.ok) return null;                      // 0.2: 404 / 401
  let data;
  try { data = await response.json(); } catch { return null; }
  if (!data.result?.ok) return null;                  // 不是 0.1 的成功信封，别当成证据
  const value = data.result.value;
  const items = Array.isArray(value) ? value : value.items ?? value.sessions;
  if (!Array.isArray(items)) return null;
  const counts = {};
  const statusOf = row => typeof row.running === 'boolean' ? row.running ? 'running' : 'idle' : row.status ?? row.activity ?? 'unknown';
  for (const row of items) { const status = statusOf(row); counts[status] = (counts[status] ?? 0) + 1; }
  const busy = items.filter(row => ['running', 'waiting'].includes(statusOf(row)));
  return {
    tier: 'legacy-rpc',
    api: `/api/${method}`,
    count: items.length,
    statusCounts: counts,
    busy: busy.map(row => ({ id: row.sessionId ?? row.id, status: statusOf(row) })),
    unknown: counts.unknown ?? 0,
  };
}

/**
 * 纯函数：从投影缓存记录列表算出忙闲。`openStep` 只作为「陈旧残留」诊断，不算忙。
 * @param {{id:string,openTurnStartSeq:number|null,openStep:object|null,ageMs:number|null}[]} entries
 */
export function summarizeProjection(entries) {
  const busy = entries.filter(entry => entry.openTurnStartSeq !== null);
  const staleOpenSteps = entries.filter(entry => entry.openTurnStartSeq === null && entry.openStep !== null);
  const oldestBusyAgeMs = busy.reduce((max, entry) => entry.ageMs === null ? max : Math.max(max ?? 0, entry.ageMs), null);
  return { busy, staleOpenSteps, oldestBusyAgeMs };
}

/** 第二层：host 侧投影缓存。读不到目录返回 null（= 探测不可用，调用方 fail-closed）。 */
export function probeProjectionCache(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  const dir = join(home, 'storages/session_projcache/sessions');
  let files;
  try { files = readdirSync(dir).filter(name => name.endsWith('.json')); } catch { return null; }
  if (!files.length) return null;
  const entries = [];
  for (const name of files) {
    const path = join(dir, name);
    let record;
    try { record = JSON.parse(readFileSync(path, 'utf8')).record; } catch { continue; }
    const rows = record?.rows ?? {};
    let ageMs = null;
    try { ageMs = Date.now() - statSync(path).mtimeMs; } catch { /* keep null */ }
    entries.push({
      id: record?.identity?.id ?? name.replace(/\.json$/, ''),
      openTurnStartSeq: rows.turnBoundary?.val?.openTurnStartSeq ?? null,
      openStep: rows.sessionStats?.val?.openStep ?? null,
      ageMs,
    });
  }
  const { busy, staleOpenSteps, oldestBusyAgeMs } = summarizeProjection(entries);
  return { tier: 'projection-cache', dir, count: files.length, busy, staleOpenSteps: staleOpenSteps.length, oldestBusyAgeMs };
}

async function main() {
  const legacy = await probeLegacyRpc();
  if (legacy) {
    console.log(JSON.stringify(legacy));
    if (legacy.busy.length || legacy.unknown) process.exitCode = 2;
    return;
  }
  const projection = probeProjectionCache();
  if (!projection) {
    console.error('check-web-idle: 既拿不到 0.1 的 session.list，也读不到 0.2 的投影缓存；拒绝断言空闲（可用 DSH_WEB_FORCE=1 强推）。');
    process.exitCode = 3;
    return;
  }
  console.log(JSON.stringify(projection));
  if (!projection.busy.length) return;
  process.exitCode = 2;
  // 忙的行如果全是「很久没动过的投影文件」，那多半是崩溃残留，给出可操作的提示。
  if (projection.oldestBusyAgeMs !== null && projection.oldestBusyAgeMs > 3600_000) {
    console.error(`check-web-idle: 这些 busy 会话的投影文件最久已 ${Math.round(projection.oldestBusyAgeMs / 3600_000)} 小时未更新，可能是崩溃残留；确认无任务可用 DSH_WEB_FORCE=1。`);
  }
}

// 被测试 import 时不要跑探测（argv[1] 是测试文件）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
