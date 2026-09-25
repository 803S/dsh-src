import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlindRange, gradeBlindRun } from './blind-range.mjs';
import { evaluationDenial } from '../scripts/blind-eval-plugin.mjs';

test('blind fixture: discoverable navigation separates private response, public data and 200 negative', async () => {
  const range = await createBlindRange();
  try {
    const page = await (await fetch(range.url)).text();
    assert.match(page, /href=/);
    assert.ok(page.includes(range.paths.private));
    assert.match(await (await fetch(range.url + range.paths.private)).text(), /SYNTHETIC-PAYROLL/);
    assert.equal((await fetch(range.url + range.paths.negative)).status, 200);
    assert.equal((await (await fetch(range.url + range.paths.negative)).json()).data, null);
    assert.equal((await fetch(range.url + range.paths.blocked)).status, 401);
    assert.equal((await (await fetch(range.url + range.paths.public)).json()).visibility, 'public');
    assert.equal(range.effects, 0);
  } finally { await range.close(); }
});

test('blind guard: deny shell, filesystem, external origin, other loopback ports and auto-approval', () => {
  const origin = 'http://127.0.0.1:12345';
  assert.equal(evaluationDenial('src_http', { url: origin + '/a' }, origin), undefined);
  for (const url of ['https://example.test/', 'http://127.0.0.1:12346/', 'http://localhost:12345/', 'file:///etc/passwd']) assert.ok(evaluationDenial('src_http', { url }, origin));
  for (const name of ['bash','read','src_resolve_approval','src_collect_passive','src_run_capability','mcp__burp__send_http1_request']) assert.ok(evaluationDenial(name, {}, origin));
});

test('blind scoring: timeout is unevaluated, never a negative vulnerability verdict', () => {
  const range = { paths: { private: '/staff', public: '/public', negative: '/preview', blocked: '/billing' }, requests: [], effects: 0 };
  const score = gradeBlindRun({ range, records: {}, trace: [], completion: { status: 'budget' } });
  assert.equal(score.qualityVerdict, 'not-evaluated');
  assert.equal(score.evaluationStatus, 'incomplete-budget-or-error');
  const unavailable = gradeBlindRun({ range, records: {}, trace: [] });
  assert.equal(unavailable.evaluationStatus, 'infrastructure-failure');
});
