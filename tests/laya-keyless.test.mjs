import test from 'node:test';
import assert from 'node:assert/strict';
import { keylessSearchProvider } from '../lib/src/web-search-provider.js';
import { extractOpenApiIndex, renderOpenApiIndex } from '../lib/src/openapi-index.js';

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

test('local.101 Laya next-action remains a direct client compatibility path only', async () => {
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

test('local.100 browser-index uses laya-browser-agent System One endpoint shape', async () => {
  const previous = globalThis.fetch, previousUrl = process.env.DSH_SRC_BROWSER_DECIDER_URL;
  try {
    process.env.DSH_SRC_BROWSER_DECIDER_URL = 'http://browser-decider.test/v1/systemone';
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'http://browser-decider.test/v1/systemone');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'browser');
      assert.ok(body.questions.operation);
      return new Response(JSON.stringify({ latency_ms: 12, answers: { operation: { choice: 'CLICK', confidence: .99, probabilities: { CLICK: 1, WAIT: 0 } }, click_target: { choice: '0', confidence: 1, probabilities: { '0': 1 } } } }), { status: 200 });
    };
    const { layaDecide } = await import('../lib/src/decision/laya-client.js');
    const result = await layaDecide({ taskType: 'browser-index', goal: 'click Continue', observation: 'button Continue [ref=e1]', candidates: [{ index: 0, operation: 'click', targetRef: 'e1', label: 'Continue' }] }, { agent: { session: { id: 'browser-test' } } });
    assert.equal(result.index, 0);
    assert.equal(result.source, 'laya-browser-agent');
    assert.equal(result.fallback, false);
  } finally { globalThis.fetch = previous; if (previousUrl === undefined) delete process.env.DSH_SRC_BROWSER_DECIDER_URL; else process.env.DSH_SRC_BROWSER_DECIDER_URL = previousUrl; }
});

test('local.100 keyless search provider supports Bing and Baidu parser shapes', async () => {
  const previous = globalThis.fetch; const seen = [];
  try {
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('bing.com')) return new Response('<li class="b_algo"><h2><a href="https://bing.example/result">Bing result</a></h2></li>', { status: 200 });
      if (String(url).includes('baidu.com')) return new Response('<h3><a href="https://baidu.example/result">Baidu result</a></h3>', { status: 200 });
      return new Response('<html>no parseable results</html>', { status: 200 });
    };
    const result = await keylessSearchProvider.search({ query: 'engine fallback', maxResults: 8 });
    assert.ok(seen.some((url) => url.includes('bing.com')));
    assert.equal(result.sources[0].url, 'https://bing.example/result');
  } finally { globalThis.fetch = previous; }
});

test('local.101 keyless search provider honors an explicit engine without fallback', async () => {
  const previous = globalThis.fetch; const seen = [];
  try {
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response('<li class="b_algo"><h2><a href="https://bing.example/only">Only Bing</a></h2></li>', { status: 200 });
    };
    const result = await keylessSearchProvider.search({ query: 'explicit', engine: 'bing', maxResults: 3 });
    assert.equal(result.engine, 'bing');
    assert.equal(result.requestedEngine, 'bing');
    assert.equal(seen.length, 1);
    assert.match(seen[0], /bing\.com/);
  } finally { globalThis.fetch = previous; }
});

test('local.101 keyless search reports per-engine diagnostics', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => new Response('blocked', { status: String(url).includes('duckduckgo') ? 403 : 429 });
    await assert.rejects(() => keylessSearchProvider.search({ query: 'diagnostics', engine: 'duckduckgo' }), /duckduckgo: 403/);
  } finally { globalThis.fetch = previous; }
});

test('local.101 OpenAPI index extracts bounded routes without exposing the full document', () => {
  const raw = JSON.stringify({ openapi: '3.0.0', info: { title: 'Large API', version: '1.2' }, paths: {
    '/api/users/{id}': { get: { operationId: 'getUser', tags: ['users'], parameters: [{ name: 'id' }] }, patch: { operationId: 'patchUser', parameters: [{ name: 'body' }] } },
    '/api/admin/reset': { post: { operationId: 'resetAdmin' } }
  }, components: { schemas: { Huge: { description: 'x'.repeat(200000) } } } });
  const index = extractOpenApiIndex(raw);
  assert.equal(index.valid, true);
  assert.equal(index.paths.length, 2);
  assert.deepEqual(index.paths[0].methods, ['GET', 'PATCH']);
  assert.ok(index.parameters.includes('id'));
  const rendered = renderOpenApiIndex(index);
  assert.match(rendered, /GET,PATCH \/api\/users/);
  assert.ok(rendered.length < 5000);
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
