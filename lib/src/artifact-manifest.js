import {realpath,stat,readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {artifactsRoot,ensureArtifactsScaffold} from './artifacts.js';
export async function verifyArtifacts(sessionId,target,paths) {
  await ensureArtifactsScaffold(sessionId,{target});
  const root=await realpath(artifactsRoot(sessionId,{target}));
  const owner=await readFile(path.join(root,'README.md'),'utf8');
  if(!owner.split('\n').includes(`- 会话：${sessionId}`))throw new Error('artifact目录归属不匹配，拒绝短会话ID碰撞');
  const rows=[];
  for(const supplied of paths ?? []) {
    if(typeof supplied!=='string'||!supplied||path.isAbsolute(supplied))throw new Error('artifact必须是当前engagement产物目录下的相对文件路径');
    const full=await realpath(path.resolve(root,supplied));
    if(!full.startsWith(root+path.sep))throw new Error('artifact越出当前任务目录');
    const st=await stat(full);if(!st.isFile()||st.size>10*1024*1024)throw new Error('artifact不是有界普通文件');
    const bytes=await readFile(full);rows.push({path:path.relative(root,full),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sessionId});
  }
  return rows;
}
export async function checkArtifactRecords(sessionId,target,rows) {
  const actual=await verifyArtifacts(sessionId,target,rows.map(r=>r.path));
  if(actual.some((r,i)=>r.sha256!==rows[i].sha256||r.bytes!==rows[i].bytes||rows[i].sessionId!==sessionId))throw new Error('artifact已变更或不属于当前任务；需重新登记和复核');
  return actual;
}
export async function publishReportArtifact(sessionId,target,markdown) {
  await ensureArtifactsScaffold(sessionId,{target});
  await verifyArtifacts(sessionId,target,[]);
  const root=artifactsRoot(sessionId,{target}), dir=path.join(root,'报告');await mkdir(dir,{recursive:true});
  const name=`report-${Date.now()}-${randomUUID().slice(0,8)}.md`,full=path.join(dir,name);
  await writeFile(full,markdown,{mode:0o600,flag:'wx'});
  const entries=await verifyArtifacts(sessionId,target,[`报告/${name}`]);
  const manifest={sessionId,target,createdAt:Date.now(),artifacts:entries};
  const temp=full+'.manifest.tmp';await writeFile(temp,JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});await rename(temp,full+'.manifest.json');
  return entries[0];
}
