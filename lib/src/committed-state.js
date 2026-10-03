// One re-entrant per-domain/per-engagement mutation lock, not a task scheduler.
import { AsyncLocalStorage } from 'node:async_hooks';
const active = new AsyncLocalStorage();
const queues = new WeakMap();
export function inMutation(domain, sessionId) { return active.getStore()?.domain === domain && active.getStore()?.sessionId === sessionId; }
export async function serializeMutation(domain, sessionId, operation) {
  if (active.getStore()?.domain === domain && active.getStore()?.sessionId === sessionId) return operation();
  let bySession = queues.get(domain);
  if (!bySession) queues.set(domain, bySession = new Map());
  const previous = bySession.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => active.run({ domain, sessionId }, operation));
  bySession.set(sessionId, next);
  try { return await next; } finally { if (bySession.get(sessionId) === next) bySession.delete(sessionId); }
}

export const projectionTables = ['goals','intents','facts','findings','assets','edges','coverage','research','checkpoints','observations','pending_approvals','user_todos','endpoint_manifests','knowledge_revisions'];
export function captureRows(domain, sessionId) {
  const rows = new Map();
  for (const table of projectionTables) for (const [key, row] of domain.table(table).entries()) {
    if (row.sessionId === sessionId) rows.set(`${table}:${key}`, { table, key, row });
  }
  return rows;
}
export function changedRows(before, after) {
  const puts = [], deletes = [];
  for (const [key, value] of after) if (JSON.stringify(before.get(key)?.row) !== JSON.stringify(value.row)) puts.push(value);
  for (const [key, value] of before) if (!after.has(key)) deletes.push({table:value.table,key:value.key,id:value.row.id});
  return { puts, deletes };
}
