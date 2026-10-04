// Private proxy-to-broker API. Deliberately contains NO approval endpoint.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { gateError, LIMITS } from './plan.js';

export function createProxyControlServer({ dataPlane, sessionId, taskId, token }) {
  if (typeof sessionId !== 'string' || !sessionId || typeof taskId !== 'string' || !taskId || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw gateError('INVALID_CONTROL_CONFIG');
  const expected = Buffer.from(`Bearer ${token}`);
  const dispatches = new Map();
  const server=http.createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 4096 }, async (req, res) => {
    const controller=new AbortController();
    res.once('close',()=>controller.abort());
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(value)); };
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { send(403, { error: 'SRC_GATE_UNAUTHENTICATED' }); return; }
    if (req.method !== 'POST' || !['/claim', '/finish'].includes(req.url)) { send(404, { error: 'SRC_GATE_NO_ENDPOINT' }); return; }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMITS.planBytes) throw gateError('CONTROL_BODY_LIMIT');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/claim') {
        controller.signal.throwIfAborted();
        const result = await dataPlane.claim(sessionId, taskId, input,{signal:controller.signal});
        dispatches.set(result.dispatchId,{request:input,grant:result});
        if(controller.signal.aborted){await dataPlane.finish(sessionId,result.dispatchId,'outcome_unknown');dispatches.delete(result.dispatchId);return;}
        send(200, result);
      } else {
        if (!input || Object.keys(input).some(k => !['dispatchId', 'outcome', 'response'].includes(k)) || !dispatches.has(input.dispatchId)) throw gateError('UNKNOWN_DISPATCH');
        await dataPlane.finish(sessionId, input.dispatchId, input.outcome,input.response,dispatches.get(input.dispatchId));
        dispatches.delete(input.dispatchId);
        send(200, { ok: true });
      }
    } catch (error) { send(403, { error: /^SRC_GATE_[A-Z_]+$/.test(error?.code) ? error.code : 'SRC_GATE_CONTROL_FAILURE' }); }
  });
  server.maxConnections=32;
  server.timeout=5000;
  return server;
}
