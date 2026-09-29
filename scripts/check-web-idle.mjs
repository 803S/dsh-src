#!/usr/bin/env node
// Read-only quiescence check before touching a running Web service.
const base = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
const method = 'session.list';
const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {} }), signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`session.list HTTP ${response.status}`);
const data = await response.json();
if (!data.result?.ok) throw new Error('session.list did not return a valid success envelope');
const value = data.result.value;
const items = Array.isArray(value) ? value : value.items ?? value.sessions;
if (!Array.isArray(items)) throw new Error('unknown session.list schema; refusing to assert idle');
const counts = {};
const statusOf = row => typeof row.running === 'boolean' ? row.running ? 'running' : 'idle' : row.status ?? row.activity ?? 'unknown';
for (const row of items) { const status = statusOf(row); counts[status] = (counts[status] ?? 0) + 1; }
const busy = items.filter(row => ['running', 'waiting'].includes(statusOf(row)));
console.log(JSON.stringify({ api: method, count: items.length, statusCounts: counts, busy: busy.map(row => ({ id: row.sessionId ?? row.id, status: statusOf(row) })) }));
if (busy.length || counts.unknown) process.exitCode = 2;
