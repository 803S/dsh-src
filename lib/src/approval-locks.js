// Compatibility bridge locks, NOT the egress authorization ledger. Identity is
// session+id. Corruption/concurrent writer failure never means an empty lock set.
import { mkdir, readFile, rename, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
export const approvalLocksPath=home=>path.join(home,'storages','src-approval-locks.json');
async function readLocks(home) {
  try {const rows=JSON.parse(await readFile(approvalLocksPath(home),'utf8'));if(!Array.isArray(rows))throw new Error('invalid approval locks');return rows;}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
}
async function mutate(home,change) {
  const file=approvalLocksPath(home),guard=file+'.writer';
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  let acquired=false;
  for(let i=0;i<50;i++){
    try{await mkdir(guard,{mode:0o700});acquired=true;break;}catch(error){if(error.code!=='EEXIST')throw error;await new Promise(r=>setTimeout(r,20));}
  }
  if(!acquired)throw new Error('approval lock writer unavailable; refusing unsafe update');
  const temp=file+'.'+randomUUID()+'.tmp';
  try{
    const next=change(await readLocks(home));
    const handle=await open(temp,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(next));await handle.sync();}finally{await handle.close();}
    await rename(temp,file);
  }finally{await rm(temp,{force:true});await rm(guard,{recursive:true,force:true});}
}
export async function addApprovalLock(home,input) {
  if(typeof input?.sessionId!=='string'||!input.sessionId||!input.id||!input.url)throw new Error('approval lock requires sessionId/id/url');
  const row={id:String(input.id),sessionId:input.sessionId,method:String(input.method??''),url:String(input.url),category:String(input.category??''),createdAt:Date.now(),host:'',path:''};
  try{const url=new URL(row.url);if(['http:','https:'].includes(url.protocol)){row.host=url.hostname.toLowerCase();row.path=url.pathname;}}catch{}
  return mutate(home,rows=>[...rows.filter(old=>!(old.sessionId===row.sessionId&&old.id===row.id)),row]);
}
export async function removeApprovalLock(home,id,sessionId) {
  if(typeof sessionId!=='string'||!sessionId)throw new Error('approval lock removal requires sessionId');
  // Legacy ownerless records are retained, never guessed to belong to this user.
  return mutate(home,rows=>rows.filter(row=>row.sessionId!==sessionId||row.id!==String(id)));
}
