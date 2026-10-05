// Evaluation-only passive observation of the outgoing model payload. No URLs,
// headers, credentials, prompt text or tool output are persisted. Never rewrite.
import {createHash} from 'node:crypto';
export function modelPayloadSummary(body){
 if(typeof body!=='string')return null;
 let payload;try{payload=JSON.parse(body);}catch{return null;}
 if(!Array.isArray(payload.messages))return null;
 const names=new Map();
 for(const msg of payload.messages)for(const call of msg.tool_calls??[]){
  const name=call?.function?.name;
  if(typeof call?.id==='string'&&typeof name==='string'&&/^[a-zA-Z0-9_]{1,128}$/.test(name))names.set(call.id,name);
 }
 return {type:'model-wire-observation',messages:payload.messages.map(msg=>{
  const content=typeof msg.content==='string'?msg.content:JSON.stringify(msg.content??null);
  return {role:['system','developer','user','assistant','tool'].includes(msg.role)?msg.role:'unknown',
   ...(msg.role==='tool'?{tool:names.get(msg.tool_call_id)??'unknown'}:{}),
   bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex'),
   containsGenericSentence:content.includes('You are a helpful AI assistant that helps with software engineering tasks'),
   containsFixtureTask:content.includes('/teams-model')&&content.includes('/teams-model-delete'),
   containsAssignment:content.includes('AgentTeams automatic task assignment')&&/Task: [^\s]+/.test(content),
   containsClaimGuidance:content.includes('领取回执仅包含任务状态'),
  };
 })};
}
export function installModelWireObserver(log){
 const original=globalThis.fetch;
 const observed=function(input,init){
  try{const summary=modelPayloadSummary(init?.body);if(summary)log(summary);}catch{}
  return original.call(this,input,init);
 };
 globalThis.fetch=observed;
 return ()=>{if(globalThis.fetch===observed)globalThis.fetch=original;};
}
