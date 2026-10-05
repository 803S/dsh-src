// Host-only, shared by store instances opening the same domain. No scope or
// approval data is changed here. Domain deletion also fences egress authority.
import {gateError} from './plan.js';
const domains=new WeakMap();
export function browserLifecycle(domain){
 let lifecycle=domains.get(domain);
 if(lifecycle)return lifecycle;
 const states=new Map(),authorizationStates=new Map(),listeners=new Set();
 const state=(id,authorization=false)=>{const map=authorization?authorizationStates:states;if(!map.has(id))map.set(id,{epoch:0,busy:0});return map.get(id);};
 lifecycle={
  subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
  ticket(id,authorization=false){const current=state(id,authorization),epoch=current.epoch;
   const check=()=>{if(current.busy||current.epoch!==epoch)throw gateError('BROWSER_SESSION_RESET');};
   check();return check;
  },
  async reset(ids,operation,{deleteAuthorization=false}={}){
   const unique=[...new Set(ids)],owned=unique.map(id=>state(id));
   if(deleteAuthorization)owned.push(...unique.map(id=>state(id,true)));
   for(const current of owned){current.busy++;current.epoch++;}
   try{
    // All callbacks must settle even if one cleanup fails. Never perform the
    // store mutation on partial cleanup or admit new browser work meanwhile.
    const results=await Promise.allSettled([...listeners].map(fn=>Promise.resolve().then(()=>fn(unique,{deleteAuthorization}))));
    const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
    return await operation();
   }finally{for(const current of owned)current.busy--;}
  },
 };
 domains.set(domain,lifecycle);return lifecycle;
}
