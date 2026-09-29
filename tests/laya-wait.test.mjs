import test from 'node:test';
import assert from 'node:assert/strict';
import { layaDecide, layaTimeoutMs, resetLayaCacheForTests } from '../lib/src/decision/laya-client.js';

const exec = { agent: { session: { id: 'laya-wait-regression' } } };
const args = { taskType: 'delegate', method: 'TASK', url: 'http://task.local/', title: '等待真实分工判断', detail: '本地测试，无目标请求' };
const response = () => new Response(JSON.stringify({ answers: { choice: { choice: 'delegate', confidence: .9 } } }));

test('Laya waits past the former 800ms cap and does not skip requests after failures', async () => {
  const fetch = globalThis.fetch;
  const previous = process.env.DSH_SRC_LAYA_TIMEOUT_MS;
  try {
    delete process.env.DSH_SRC_LAYA_TIMEOUT_MS;
    assert.equal(layaTimeoutMs(), 120000);
    process.env.DSH_SRC_LAYA_TIMEOUT_MS = '180000';
    assert.equal(layaTimeoutMs(), 180000);
    process.env.DSH_SRC_LAYA_TIMEOUT_MS = 'invalid';
    assert.equal(layaTimeoutMs(), 120000);
    delete process.env.DSH_SRC_LAYA_TIMEOUT_MS;
    let calls = 0;
    globalThis.fetch = async (_url, { signal }) => {
      calls++;
      if (calls <= 3) throw new Error('fixture connection failure');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1100);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return response();
    };
    for (let i = 0; i < 3; i++) assert.equal((await layaDecide(args, exec)).fallback, true);
    const result = await layaDecide(args, exec);
    assert.equal(calls, 4);
    assert.equal(result.fallback, false);
    assert.equal(result.action, 'delegate');
    resetLayaCacheForTests();
    process.env.DSH_SRC_LAYA_TIMEOUT_MS = '20';
    assert.equal((await layaDecide(args, exec)).fallback, true);
  } finally {
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.DSH_SRC_LAYA_TIMEOUT_MS;
    else process.env.DSH_SRC_LAYA_TIMEOUT_MS = previous;
  }
});
