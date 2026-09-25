import test from 'node:test';
import assert from 'node:assert/strict';
import { keylessSearchProvider } from '../lib/src/web-search-provider.js';

test('local.100 keyless search provider parses public result pages without API key', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /duckduckgo|google/);
      return new Response('<a class="result__a" href="https://example.test/advisory">LiteLLM advisory</a>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const result = await keylessSearchProvider.search({ query: 'LiteLLM CVE', maxResults: 8 });
    assert.equal(result.sources[0].url, 'https://example.test/advisory');
    assert.match(result.sources[0].title, /advisory/i);
  } finally { globalThis.fetch = previous; }
});

test('local.100 Laya next-action consumes indexed answers', async () => {
  const previous = globalThis.fetch, previousUrl = process.env.DSH_SRC_LAYA_URL;
  try {
    process.env.DSH_SRC_LAYA_URL = 'http://laya.test';
    globalThis.fetch = async () => new Response(JSON.stringify({ answers: { action: { choice: 'inspect-state', probabilities: { 'inspect-state': 0.98 }, confidence: 0.98 } } }), { status: 200 });
    const { layaDecide } = await import('../lib/src/decision/laya-client.js');
    const result = await layaDecide({ taskType: 'next-action', stateSummary: 'pending', candidates: [{ id: 'inspect-state', label: 'inspect' }] }, { agent: { session: { id: 'laya-test' } } });
    assert.equal(result.action, 'inspect-state');
    assert.equal(result.fallback, false);
  } finally { globalThis.fetch = previous; if (previousUrl === undefined) delete process.env.DSH_SRC_LAYA_URL; else process.env.DSH_SRC_LAYA_URL = previousUrl; }
});

test('local.100 keyless search provider fails over from blocked engine', async () => {
  const previous = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (url) => {
      calls++;
      if (String(url).includes('duckduckgo')) return new Response('blocked', { status: 403 });
      return new Response('<a href="https://example.test/result">Result</a>', { status: 200 });
    };
    const result = await keylessSearchProvider.search({ query: 'fallback', maxResults: 3 });
    assert.ok(calls >= 2);
    assert.equal(result.sources[0].url, 'https://example.test/result');
  } finally { globalThis.fetch = previous; }
});
