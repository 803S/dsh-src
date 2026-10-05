import {gateError} from './plan.js';
import {startConfinedBrowser} from './browser-process.js';

// Session ownership and bounded serialization for host-owned browser workers.
// The caller derives policyKey from native policy, paths and installed runtime.
export function createBrowserSessions({start=startConfinedBrowser,maxWorkers=2,maxQueued=8,idleMs=120000}={}){
 const entries=new Map();let disposed=false;
 const failure=code=>Object.assign(gateError(code),{safeNotSent:false});
 async function retire(entry){
  if(entry.closing)return entry.closing;
  entry.retired=true;clearTimeout(entry.timer);entry.controller.abort();
  entry.closing=(async()=>{await entry.tail.catch(()=>{});await entry.client?.close();if(entries.get(entry.id)===entry)entries.delete(entry.id);})();
  return entry.closing;
 }
 async function run({sessionId,authorizationSessionId=sessionId,policyKey,options,signal},operation){
  if(disposed)throw failure('BROWSER_POOL_CLOSED');
  if(typeof sessionId!=='string'||!sessionId||typeof policyKey!=='string'||!policyKey)throw failure('INVALID_BROWSER_SESSION');
  if(signal?.aborted)throw failure('BROWSER_ABORTED');
  let entry=entries.get(sessionId);
  if(entry&&(entry.policyKey!==policyKey||entry.retired||entry.client?.closed)){await retire(entry);entry=undefined;}
  // Recheck after awaiting retirement: another caller may have claimed the slot.
  if(disposed)throw failure('BROWSER_POOL_CLOSED');
  entry=entries.get(sessionId)??entry;
  if(entry&&entry.policyKey!==policyKey)throw failure('BROWSER_POLICY_CHANGED');
  if(!entry){
   if(entries.size>=maxWorkers)throw failure('BROWSER_CAPACITY');
   entry={id:sessionId,authorizationSessionId,policyKey,controller:new AbortController(),tail:Promise.resolve(),queued:0,retired:false};entries.set(sessionId,entry);
  }
  if(entry.queued>=maxQueued)throw failure('BROWSER_QUEUE_LIMIT');
  entry.queued++;clearTimeout(entry.timer);
  const job=entry.tail.then(async()=>{
   if(disposed||entry.retired)throw failure('BROWSER_SESSION_CLOSED');
   if(signal?.aborted)throw failure('BROWSER_ABORTED');
   const abort=()=>entry.controller.abort();signal?.addEventListener('abort',abort,{once:true});
   try{
    if(!entry.client){
     entry.client=await start({...options,signal:entry.controller.signal});
     if(entry.retired||entry.controller.signal.aborted||entry.client.closed)throw failure('BROWSER_SESSION_CLOSED');
     await entry.client.initialize({signal});
    }
    if(entry.retired||entry.controller.signal.aborted||entry.client.closed)throw failure('BROWSER_SESSION_CLOSED');
    return await operation(entry.client);
   }catch(error){entry.retired=true;entry.controller.abort();await entry.client?.close();throw error;}
   finally{signal?.removeEventListener('abort',abort);}
  });
  entry.tail=job.catch(()=>{});
  try{return await job;}
  finally{
   entry.queued--;
   if(entry.queued===0){
    if(entry.retired)await retire(entry);
    else{entry.timer=setTimeout(()=>{void retire(entry).catch(()=>{});},idleMs);entry.timer.unref?.();}
   }
  }
 }
 return {run,invalidate:sessionId=>{const entry=entries.get(sessionId);return entry?retire(entry):Promise.resolve();},
  async invalidateRelated(ids){const targets=new Set(ids);await Promise.all([...entries.values()].filter(entry=>targets.has(entry.id)||targets.has(entry.authorizationSessionId)).map(retire));},
  async close(){disposed=true;await Promise.all([...entries.values()].map(retire));},
  status:()=>({workers:entries.size,queued:[...entries.values()].reduce((n,e)=>n+e.queued,0)}),
 };
}
