// Restricted, content-addressed original response backups. Never sent to Jev or the UI.
import {mkdir,writeFile,readFile,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const digest = x => createHash('sha256').update(x).digest('hex');
const refPattern = /^snapshot:\/\/([a-f0-9]{64})$/;
export async function saveResponseSnapshot(home,sessionId,url,body,contentType) {
  if (Buffer.byteLength(body)>2*1024*1024) return undefined;
  const row={version:1,sessionId,url,body,contentType,createdAt:Date.now(),sha256:digest(body)};
  const raw=JSON.stringify(row),id=digest(raw),dir=path.join(home,'storages','src-snapshots');
  await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
  await writeFile(path.join(dir,id+'.json'),raw,{mode:0o600,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  return `snapshot://${id}`;
}
export async function readResponseSnapshot(home,sessionId,ref,url) {
  const id=refPattern.exec(String(ref))?.[1];if(!id)throw new Error('写前快照引用非法');
  const raw=await readFile(path.join(home,'storages','src-snapshots',id+'.json'),'utf8');
  if(digest(raw)!==id)throw new Error('写前快照校验失败');
  const row=JSON.parse(raw);
  if(row.sessionId!==sessionId || row.url!==url || row.sha256!==digest(row.body))throw new Error('写前快照不属于本任务和资源');
  return row;
}
export async function validateWritePlan(home,sessionId,request) {
  if (!['PUT','PATCH'].includes(request.method) || !request.body) return;
  const plan=request.safetyPlan;
  if(!plan?.backupRef || !plan?.recovery || !plan?.semantics)throw new Error('写入缺少受校验原始快照、接口更新语义和恢复步骤；请先GET原资源留证，再携带safetyPlan重新准备请求。没有发出写请求。');
  if(!['replace'].includes(plan.semantics))throw new Error('必须使用已声明的完整replace方案；未验证的合并语义不允许执行');
  const before=await readResponseSnapshot(home,sessionId,plan.backupRef,request.url);
  // JSON PUT replaces a resource. Do not send a partial document that drops existing fields.
  if(request.method==='PUT' && /json/i.test(before.contentType) && request.restoreVerified !== true) {
    let a,b;try{a=JSON.parse(before.body);b=JSON.parse(request.body)}catch{throw new Error('JSON配置或备份无法解析，拒绝写入');}
    const missing=[];
    const walk=(x,y,p='')=>{if(x&&typeof x==='object'&&!Array.isArray(x)) for(const k of Object.keys(x)){if(!y||!Object.hasOwn(y,k))missing.push(p+k);else walk(x[k],y[k],p+k+'.');}};
    walk(a,b);if(missing.length)throw new Error(`部分PUT会遗漏原配置字段（${missing.slice(0,8).join(', ')}），未发送；请基于完整原件修改，不要猜测回滚数据。`);
  }
  return before;
}
export function compareSnapshot(before, body) {
  try {return JSON.stringify(JSON.parse(before.body))===JSON.stringify(JSON.parse(body));}catch{return before.body===body;}
}
