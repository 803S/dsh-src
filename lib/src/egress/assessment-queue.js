import {gateError} from './plan.js';
export const ASSESSMENT_PARALLEL=4, ASSESSMENT_MAX_QUEUED=32;
export const ASSESSMENT_PENDING_LIMIT=ASSESSMENT_PARALLEL+ASSESSMENT_MAX_QUEUED;

// Bound load without turning a small legitimate burst into a blanket refusal.
// A slot is capacity only: callers must recheck scope/expiry after acquisition.
export function createAssessmentQueue({parallel=ASSESSMENT_PARALLEL,maxQueued=ASSESSMENT_MAX_QUEUED}={}){
 if(!Number.isSafeInteger(parallel)||parallel<1||!Number.isSafeInteger(maxQueued)||maxQueued<0)throw gateError('INVALID_ASSESSMENT_QUEUE_CONFIG');
 let active=0,closed=false;
 const waiting=[];
 function grant(){
  active++;let released=false;
  return ()=>{
   if(released)return;released=true;active--;
   while(!closed&&active<parallel&&waiting.length){
    const item=waiting.shift();item.cleanup();item.resolve(grant());
   }
  };
 }
 return {
  acquire(signal){
   if(closed)return Promise.reject(gateError('CLOSED'));
   if(signal?.aborted)return Promise.reject(signal.reason);
   if(active<parallel)return Promise.resolve(grant());
   if(waiting.length>=maxQueued)return Promise.reject(gateError('ASSESSMENT_CAPACITY'));
   return new Promise((resolve,reject)=>{
    const item={resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)};
    const abort=()=>{const i=waiting.indexOf(item);if(i>=0){waiting.splice(i,1);item.cleanup();reject(signal.reason);}};
    waiting.push(item);signal?.addEventListener('abort',abort,{once:true});
   });
  },
  close(){if(closed)return;closed=true;for(const item of waiting.splice(0)){item.cleanup();item.reject(gateError('CLOSED'));}},
  status:()=>({active,queued:waiting.length,closed}),
 };
}
