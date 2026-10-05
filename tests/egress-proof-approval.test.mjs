import test from 'node:test';
import assert from 'node:assert/strict';
import {createProofApproval} from '../lib/src/egress/proof-approval.js';
import {browserLifecycle} from '../lib/src/egress/browser-lifecycle.js';
import {withEgressExecution} from '../lib/src/egress/runtime.js';
function setup(request){
 const domain={},events=new Map(),effects=[],closed=[];
 const ctx={get:()=>request?{request}:undefined,on:(name,fn)=>events.set(name,fn),effect:fn=>effects.push(fn())};
 const authorize=createProofApproval(ctx,{domain:async()=>domain},async id=>{closed.push(id);});
 const exec={name:'src_serve_proof',callId:'fixture',agent:{session:{id:'child'}}};
 const run=publication=>withEgressExecution({exec,sessionId:'parent'},()=>authorize(exec,publication));
 return {domain,events,effects,closed,exec,run};
}
const publication={payload:'<p>fixture</p>',filename:'poc.html',contentType:'text/html; charset=utf-8',ttlSeconds:10};
test('proof requires native allowed-once, never general truthiness or absence of an answerer',async()=>{
 for(const outcome of ['rejected','cancelled','unavailable',undefined,true,'allowed']){
  const f=setup(async()=>outcome);await assert.rejects(f.run(publication),/SRC_GATE_PROOF_APPROVAL/);
 }
 await assert.rejects(setup().run(publication),{code:'SRC_GATE_PROOF_APPROVAL_UNAVAILABLE'});
});
test('proof asks about exact immutable publication, binds call identity, and never expands network scope',async()=>{
 let asked;const f=setup(async request=>{asked=request;return 'allowed-once';});const allowed=await f.run(publication);
 assert.equal(asked.toolName,'src_serve_proof');assert.equal(asked.callId,'fixture');assert.equal(asked.agent,f.exec.agent);
 assert.ok(asked.reason.endsWith(JSON.stringify(publication)));assert.match(asked.reason,/SHA256=[a-f0-9]{64}/);assert.equal(allowed.authorizationSessionId,'parent');allowed.check();
 await browserLifecycle(f.domain).reset(['parent'],async()=>{});assert.throws(allowed.check,/SESSION_RESET/);assert.deepEqual(f.closed,['parent']);
});
test('late proof approval after reset, session disposal, cancellation or plugin disposal cannot activate',async()=>{
 for(const action of ['reset','session','parent','cancel','plugin']){
  let release,ready;const started=new Promise(resolve=>{ready=resolve;});
  const f=setup(()=>{ready();return new Promise(resolve=>{release=resolve;});});const controller=new AbortController();f.exec.signal=controller.signal;
  const pending=f.run(publication);await started;
  if(action==='reset')await browserLifecycle(f.domain).reset(['parent'],async()=>{});
  if(action==='session')await f.events.get('session/disposed')(f.exec.agent.session);
  if(action==='parent')await f.events.get('session/disposed')({id:'parent'});
  if(action==='cancel')controller.abort();
  if(action==='plugin')await f.effects[0]();
  release('allowed-once');await assert.rejects(pending);
 }
});
