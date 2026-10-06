import { requestSecrets, sanitizeEvidence, safeRequestBody } from '../evidence-output.js';
import {reviewBody} from '../decision/review-input.js';

// Every nested request uses this projection; host execution cannot leak a second
// raw/base64 copy of a credential-bearing body into command or approval events.
export function presentPlan(plan, {review=false}={}) {
  const requests=plan.entries.map(entry=>entry.request);
  const execution=plan.hostExecution;
  if(execution){requests.push(execution.request);if(execution.safety?.precondition)requests.push(execution.safety.precondition.request);if(execution.safety?.verification)requests.push(execution.safety.verification.request);}
  const secrets=requests.flatMap(request=>requestSecrets(Object.fromEntries(request.headers??[])));
  function presentRequest(request){return {
    method:request.method,url:sanitizeEvidence(request.url,secrets),
    headers:Object.fromEntries((request.headers??[]).map(([name,value])=>[name,/authorization|cookie|token|key|secret/i.test(name)?'<stored>':sanitizeEvidence(value,secrets)])),
    body:review?reviewBody(Buffer.from(request.bodyBase64??'','base64'),secrets):safeRequestBody(Buffer.from(request.bodyBase64??'','base64').toString('utf8'),secrets),
  };}
  const result={...plan,purpose:sanitizeEvidence(plan.purpose,secrets),entries:plan.entries.map(({request,maxRequests})=>({maxRequests,request:presentRequest(request)}))};
  if(execution){
    const safety=execution.safety;
    result.hostExecution={request:presentRequest(execution.request),safety:safety?{
      ...safety,object:sanitizeEvidence(safety.object,secrets),recovery:sanitizeEvidence(safety.recovery,secrets),
      ...(safety.precondition?{precondition:{...safety.precondition,request:presentRequest(safety.precondition.request)}}:{}),
      ...(safety.verification?{verification:{...safety.verification,request:presentRequest(safety.verification.request)}}:{}),
    }:null};
  }
  return result;
}
