// Global user-owned settings, separate from per-target infra/projection/domain deletion.
import { readFile, writeFile, mkdir, chmod, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { srcLayaDecisionFlag, srcLayaSkillFlag, srcLayaDelegateFlag } from '../flags.js';
import { dshHomeOf } from '../capability-loader.js';
const defaults = { enabled: false, endpoint: '', model: 'jev-latest', timeoutMs: 120000, apiKey: '' };
export const decisionSettingsPath = () => path.join(dshHomeOf(), 'settings', 'src-decision.json');
export async function readDecisionSettings() {
  try { return validate({ ...defaults, ...JSON.parse(await readFile(decisionSettingsPath(), 'utf8')) }); }
  catch (error) { if (error.code === 'ENOENT') return { ...defaults }; throw new Error('决策服务配置无法读取，请在基础设施重新保存'); }
}
export function decisionModes(config) {
  const active = config.enabled;
  return { risk:active?(config.riskMode ?? srcLayaDecisionFlag()):'off', skill:active?(config.skillMode ?? srcLayaSkillFlag()):'off', delegate:active?(config.delegateMode ?? srcLayaDelegateFlag()):'off', browser:active?(config.browserMode ?? 'on'):'off' };
}
export async function getDecisionModes() {
  try { return decisionModes(await readDecisionSettings()); }
  catch { return {risk:'on',skill:'on',delegate:'on',browser:'on'}; } // broken config must not grant HTTP execution
}
export function publicDecisionSettings(config) {
  const modes=decisionModes({...config,enabled:true});
  return { enabled: config.enabled, endpoint: config.endpoint, model: config.model, timeoutMs: config.timeoutMs, hasKey: Boolean(config.apiKey),riskMode:modes.risk,skillMode:modes.skill,delegateMode:modes.delegate,browserMode:modes.browser };
}
function validate(c) {
  if (typeof c.enabled !== 'boolean') throw new Error('enabled必须是布尔值');
  if (typeof c.endpoint !== 'string') throw new Error('接口必须是完整URL');
  if (c.endpoint) {
    let u; try { u = new URL(c.endpoint); } catch { throw new Error('接口必须是完整URL'); }
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) || u.username || u.password || u.search || u.hash) throw new Error('接口须用HTTPS（本机允许HTTP），不允许URL凭据/查询参数/片段');
    c.endpoint = u.toString();
  }
  if (typeof c.model !== 'string' || !/^[a-zA-Z0-9][\w./:@-]{0,127}$/.test(c.model)) throw new Error('模型名称格式非法');
  if (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 300000) throw new Error('超时须为1000～300000毫秒');
  if (typeof c.apiKey !== 'string' || c.apiKey.length > 8192 || /\s/.test(c.apiKey)) throw new Error('API key格式非法');
  if (c.enabled && !c.endpoint) throw new Error('启用前请填写接口地址');
  const modes={};
  for(const key of ['riskMode','skillMode','delegateMode','browserMode']) {
    if(c[key]!==undefined) {if(!['on','shadow','off'].includes(c[key]))throw new Error('职责开关须为on/shadow/off');modes[key]=c[key];}
  }
  return { enabled:c.enabled, endpoint:c.endpoint, model:c.model, timeoutMs:c.timeoutMs, apiKey:c.apiKey,...modes };
}
const writes = new Map();
export async function saveDecisionSettings(input) {
  const file = decisionSettingsPath();
  const prior = writes.get(file) ?? Promise.resolve();
  const work = prior.catch(() => {}).then(async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置必须为对象');
    for (const key of Object.keys(input)) if (!['enabled','endpoint','model','timeoutMs','apiKey','clearKey','riskMode','skillMode','delegateMode','browserMode'].includes(key)) throw new Error('未知设置字段');
    let current;
    try { current = await readDecisionSettings(); }
    catch { current = { ...defaults }; } // explicit user save can repair malformed config; never grants through a bad read
    const candidate = validate({ ...current, ...input, apiKey: input.clearKey === true ? '' : input.apiKey || current.apiKey });
    if (current.apiKey && candidate.endpoint && current.endpoint && new URL(candidate.endpoint).origin !== new URL(current.endpoint).origin && !input.apiKey && input.clearKey !== true) throw new Error('供应商origin已更换，请同时输入新key或明确清除旧key');
    const dir = path.dirname(file); await mkdir(dir,{recursive:true,mode:0o700}); await chmod(dir,0o700);
    const temp = file+'.'+randomUUID()+'.tmp';
    try { await writeFile(temp,JSON.stringify(candidate)+'\n',{mode:0o600}); await rename(temp,file); await chmod(file,0o600); }
    finally { await rm(temp,{force:true}); }
    return publicDecisionSettings(candidate);
  });
  writes.set(file,work);
  try { return await work; } finally { if(writes.get(file)===work) writes.delete(file); }
}
