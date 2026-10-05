// Synthetic scope/advisor/human fixture; real broker, ledger, addon and DSH shell.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEgressBroker } from '../../lib/src/egress/broker.js';
import { createProxyControlServer } from '../../lib/src/egress/control-server.js';
export async function configureTaskGate({ control, origin }) {
  let assessments = 0, claims = 0, finishes = 0;
  const sessionId = 'synthetic-gate-session';
  const broker = createEgressBroker({ filename: control + '/gate.sqlite', key: randomBytes(32),
    scopeFor: () => ({ origins: [origin], revision: 'fixture-scope', credentialRevision: 'anonymous' }),
    assess: async () => { assessments++; return { mode: 'on', fallback: false, effect: 'read', risk: 'low', action: 'allow', confidence: .99 }; } });
  const task = await broker.propose(sessionId, { entries: ['/read', '/redirect'].map(route => ({ request: { url: origin + route, method: 'GET', headers: [] }, maxRequests: route === '/read' ? 2 : 1 })), maxRequests: 3, minIntervalMs: 250, lifetimeMs: 120000, purpose: 'Synthetic bounded scan with redirect escape test' });
  if (task.state !== 'pending') throw new Error('Expected redirect safety veto');
  // Simulated trusted human decision, NOT real UI identity validation.
  broker.commandPlane.decide(sessionId, task.id, task.digest, 'allow');
  const dir = await mkdtemp(path.join(tmpdir(), 'src-gate-control-'));
  const socket = dir + '/control.sock', token = randomBytes(32).toString('hex');
  const events = [];
  const server = createProxyControlServer({ sessionId, taskId: task.id, token, dataPlane: {
    claim(...args) { try { const result = broker.dataPlane.claim(...args); claims++; events.push({ type: 'claim', url: args[2].url, dispatchId: result.dispatchId }); return result; } catch (error) { events.push({ type: 'deny', url: args[2]?.url, code: error.code }); throw error; } },
    finish(...args) { const result = broker.dataPlane.finish(...args); finishes++; events.push({ type: 'finish', outcome: args[2] }); return result; },
  } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  return { addon: fileURLToPath(new URL('../../lib/src/egress/mitm-addon.py', import.meta.url)),
    options: ['--set', 'rawtcp=false', '--set', 'body_size_limit=8m'],
    env: { PYTHONDONTWRITEBYTECODE: '1', SRC_GATE_CONTROL_SOCKET: socket, SRC_GATE_CONTROL_TOKEN: token }, protectedPaths: [dir],
    report: () => ({ assessments, claims, finishes, events, realJev: false, realHumanUI: false }),
    async close() { await new Promise(resolve => server.close(resolve)); broker.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
