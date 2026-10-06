import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { gateError } from './plan.js';

// 复用控制面的绑定密钥；原请求/凭据只以认证密文保存在现有账本。
// AAD绑定会话和审批摘要，不能把另一单的密文移植为当前授权。
export function frozenPlanCodec(key) {
  const encryptionKey = createHmac('sha256', key).update('src-egress/frozen-plan/v1').digest();
  const aad = (session, digest) => Buffer.from(JSON.stringify(['v1', session, digest]));
  return {
    seal(session, digest, value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(aad(session, digest));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    open(session, digest, sealed) {
      try {
        if (sealed?.version !== 1) throw new Error('legacy');
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(sealed.iv, 'base64'));
        decipher.setAAD(aad(session, digest));
        decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'));
      } catch { throw gateError('FROZEN_PLAN_UNAVAILABLE'); }
    },
    close() { encryptionKey.fill(0); },
  };
}
