/* [local.150 用户拍板 2026-10-19] 「一笔请求的身份」的判据自证。
 * 身份同时被三处用：判定服务/账本 operation（broker.js）、审批卡去重（egress/manager.js）、审计文案。
 * 判据只有一条：**客户端口味头不参与，其余全参与**（凭据不同不合并）。
 * 现场教训：step25 的 25 字节 403 就是报文身份里混进了 curl 自动加的 User-Agent。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NON_IDENTITY_HEADERS, cardIdentity, planIdentity, requestHasCredential, requestIdentity } from '../lib/src/egress/approval-identity.js';

const request = (patch = {}) => ({ method: 'POST', url: 'https://fixture.invalid/index.php?m=admin', headers: { host: 'fixture.invalid', 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1', ...patch });
const identity = (patch) => requestIdentity(request(patch));

test('[local.150] 客户端口味头不进身份；方法/URL/正文/语义头/凭据进身份', () => {
  const base = identity();
  for (const name of NON_IDENTITY_HEADERS) {
    assert.equal(identity({ headers: { ...request().headers, [name]: 'x' } }), base, name);
    assert.equal(identity({ headers: { ...request().headers, [name.toUpperCase()]: 'x' } }), base, `${name} 大小写不敏感`);
  }
  assert.notEqual(identity({ method: 'GET' }), base, '方法');
  assert.notEqual(identity({ url: 'https://fixture.invalid/index.php?m=admin&c=login' }), base, 'URL/查询串');
  assert.notEqual(identity({ body: 'a=2' }), base, '正文');
  assert.notEqual(identity({ headers: { ...request().headers, 'x-csrf-token': 't' } }), base, '语义头（CSRF）参与身份');
  assert.notEqual(identity({ headers: { ...request().headers, cookie: 'sid=a' } }), base, '凭据存在与否参与身份');
  assert.notEqual(identity({ headers: { ...request().headers, cookie: 'sid=b' } }), base, '凭据值不同＝不同身份（同 URL 不同账号不合并）');
  assert.equal(identity({ headers: { ...request().headers, cookie: 'sid=a' } }), identity({ headers: { ...request().headers, cookie: 'sid=a' } }), '同身份可复现');
  assert.equal(requestIdentity({ url: 'https://fixture.invalid/' }), requestIdentity({ url: 'https://fixture.invalid/', bodyBase64: '' }), '空正文两种写法等价');
  assert.equal(requestIdentity({ method: 'GET' }), null, '没有 URL 就不是可识别的身份');
  assert.equal(planIdentity([]), null);
  assert.equal(planIdentity([{ request: {} }]), null);
  assert.equal(planIdentity([{ request: request() }, { request: request() }]), planIdentity([{ request: request() }, { request: request() }]), '多笔计划顺序敏感且可复现');
  assert.notEqual(planIdentity([{ request: request() }, { request: request() }]), planIdentity([{ request: request() }]), '笔数不同＝不同计划');
  assert.equal(requestHasCredential(request({ headers: { cookie: 'sid=a' } })), true);
  assert.equal(requestHasCredential(request()), false);
});

test('[local.150] 卡片正文可反算身份；解析失败一律返回 null（宁可不合并）', () => {
  const card = JSON.stringify([{ maxRequests: 1, request: { method: 'GET', url: 'https://fixture.invalid/extra/create', headers: {}, body: '' } }]);
  assert.equal(cardIdentity(card), planIdentity([{ request: { method: 'GET', url: 'https://fixture.invalid/extra/create', headers: {}, body: '' } }]));
  assert.equal(cardIdentity(JSON.stringify({ entries: [{ maxRequests: 1, request: { method: 'GET', url: 'https://fixture.invalid/x', headers: {}, body: '' } }] })) !== null, true, '带 safety/transport 的卡片正文也认');
  for (const broken of ['', 'not json', 'null', '{}', '[]']) assert.equal(cardIdentity(broken), null, broken);
});
