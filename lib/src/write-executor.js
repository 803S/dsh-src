import {validateWritePlan, compareSnapshot, saveResponseSnapshot} from './write-safety.js';
// Write only after validating a current original; post-check never replays the write.
export async function executeWithWriteSafety({home,sessionId,url,init,safetyPlan,transport,restoreVerified=false}) {
  if (!['PUT','PATCH'].includes(init.method) || !/^[{[]/.test(init.body?.trim() ?? '')) return {response:await transport(url,init)};
  let before;
  try {before=await validateWritePlan(home,sessionId,{url:String(url),...init,safetyPlan,restoreVerified});}
  catch(error){error.safeNotSent=true;throw error;}

  const readInit={method:'GET',headers:init.headers,redirect:'manual',signal:init.signal};
  let current,currentBody;
  try {current=await transport(url,readInit);currentBody=await current.text();}
  catch(error){error.safeNotSent=true;throw error;}
  if(current.status<200||current.status>=300||!compareSnapshot(before,currentBody))throw Object.assign(new Error('资源自快照后已变化或无法回读；未发送写请求，请重新准备备份和审批。'),{safeNotSent:true});
  const response=await transport(url,init);
  let writeOutcome={checked:false,recovery:'原始快照已保留；任何还原都需要另行明确批准，不自动补偿。'};
  try {
    const after=await transport(url,readInit),body=await after.text();
    const snapshotRef=await saveResponseSnapshot(home,sessionId,String(url),body,after.headers?.get?.('content-type')??'');
    const matchesRequested=after.status>=200 && after.status<300 && (()=>{try{return JSON.stringify(JSON.parse(body))===JSON.stringify(JSON.parse(init.body));}catch{return body===init.body;}})();
    writeOutcome={...writeOutcome,checked:true,readbackStatus:after.status,changed:!compareSnapshot(before,body),matchesRequested,afterSnapshotRef:snapshotRef ?? '',warning:matchesRequested?'资源回读匹配，但尚未证明业务服务完全正常。':'回读与提交内容不一致；不能凭写请求HTTP成功宣称变更生效，需核对业务并考虑经批准的恢复。'};
  } catch {writeOutcome={...writeOutcome,warning:'写请求已发出，但回读失败，执行影响不确定；不要重复写入。'};}
  return {response,writeOutcome};
}
