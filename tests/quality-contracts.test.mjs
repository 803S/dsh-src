import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SrcStore,srcDomainSpec,__resetSharedDomainOpensForTests,applySrcEvent,srcInitialState,srcProjectionSchema,viewSrcState} from '../lib/src.js';
import {stateFromStore} from '../lib/src/store-projection.js';
import {saveResponseSnapshot,readResponseSnapshot,validateWritePlan} from '../lib/src/write-safety.js';
import {makeManifest,computeCoverage} from '../lib/src/endpoint-manifest.js';
import {findingFingerprint,verificationOf} from '../lib/src/verification.js';
import {publishReportArtifact,checkArtifactRecords} from '../lib/src/artifact-manifest.js';
import { executeWithWriteSafety } from '../lib/src/write-executor.js';
import {relevantSearchResults} from '../lib/src/web-search-provider.js';

test('guarded JSON write validates freshness, reads back once and never retries on readback failure',async t=>{
 const home=await sandbox(t),url='http://fixture.invalid/settings';const before='{"charset":"UTF-8","enabled":false}';
 const backupRef=await saveResponseSnapshot(home,'s',url,before,'application/json');
 let current=before,hits=[];
 const transport=async(_u,init)=>{hits.push(init.method);if(init.method==='PUT'){current=init.body;return new Response('',{status:200});}return new Response(current,{headers:{'content-type':'application/json'}});};
 const args={home,sessionId:'s',url,safetyPlan:{backupRef,semantics:'replace',recovery:'request explicit restoration approval'},transport,init:{method:'PUT',body:'{"charset":"UTF-8","enabled":true}'}};
 const result=await executeWithWriteSafety(args);assert.equal(result.writeOutcome.matchesRequested,true);assert.deepEqual(hits,['GET','PUT','GET']);
 await assert.rejects(()=>executeWithWriteSafety(args),/自快照后已变化/);assert.equal(hits.filter(x=>x==='PUT').length,1);
});

function harness(){
 __resetSharedDomainOpensForTests();const tables=new Map(),events=[];
 const domain={table(name){if(!tables.has(name))tables.set(name,new Map());const t=tables.get(name);return{get:k=>t.get(k),entries:()=>t.entries(),put:async(k,v)=>{t.set(k,v)},delete:async k=>t.delete(k)}},close:async()=>{}};
 const store=new SrcStore({storageDomain:{open:async()=>domain},sessions:{get:()=>({append:(type,data)=>events.push({type,data})})}});
 return {store,domain,events};
}
async function sandbox(t){const old=process.env.DSH_HOME;const dir=await fs.mkdtemp(path.join(os.tmpdir(),'quality-contract-'));process.env.DSH_HOME=dir;t.after(async()=>{if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;await fs.rm(dir,{recursive:true,force:true});});return dir;}

test('committed store IDs survive concurrent facts, coverage, failures and cold replay',async t=>{
 await sandbox(t);const h=harness(),sid='quality-parent';await h.store.initGoal(sid,{target:'fixture.invalid',objective:'test',authorization:'fixture'});
 const intent=await h.store.addIntent(sid,{goalId:'goal-1',title:'i',detail:'d'});
 await Promise.all(Array.from({length:12},(_,i)=>h.store.addFact(sid,{intentId:intent.nodeId,kind:'info',detail:`fact-${i}`,target:'fixture.invalid',confidence:.9})));
 await Promise.all(Array.from({length:6},(_,i)=>h.store.upsertCoverage(sid,{phase:'api',category:`c-${i}`,status:'completed',evidence:[],limitation:''})));
 await assert.rejects(()=>h.store.addFinding(sid,{intentId:intent.nodeId,title:'bad',severity:'high',impact:'',reproducibleSteps:[]}),/requires/);
 const view=await h.store.view(sid),state=h.events.reduce(applySrcEvent,srcInitialState);
 assert.equal(new Set(view.facts.map(r=>r.id)).size,12);
 assert.deepEqual(state.coverage.map(r=>r.id).sort(),view.coverage.map(r=>r.id).sort());
 assert.equal(state.nodes.filter(r=>r.kind==='fact').length,12);
 assert.equal(srcProjectionSchema.safeParse(viewSrcState(state)).success,true);
 const cold=stateFromStore(view,srcInitialState,state.lastAppliedEventSeq);assert.equal(cold.nodes.length,state.nodes.length);
 const duplicate=h.events.reduce(applySrcEvent,state);assert.deepEqual(duplicate,state);
 const commits=[...h.domain.table('src_commits').entries()].map(([,r])=>r);assert.equal(new Set(commits.map(r=>r.eventSeq)).size,commits.length);
});

test('manifest canonical IDs, evidence binding and cross-method negatives',()=>{
 const endpoints=[{method:'POST',path:'https://fixture.invalid/a',sourceRef:'observation-1'},{method:'GET',path:'https://fixture.invalid/a',sourceRef:'observation-1'}];
 const m=makeManifest('s','schema',endpoints),rev=makeManifest('s','schema',endpoints.toReversed());assert.equal(m.id,rev.id);assert.equal(m.endpoints.length,2);
 const ep=m.endpoints.find(e=>e.method==='POST');
 assert.throws(()=>computeCoverage(m,{[ep.endpointId]:'tested'},['missing'],[]),/不存在/);
 assert.throws(()=>computeCoverage(m,{[ep.endpointId]:'tested'},['obs'],[{id:'obs',method:'GET',path:ep.path,httpStatus:200}]),/相同方法/);
 const c=computeCoverage(m,{[ep.endpointId]:'tested'},['obs'],[{id:'obs',method:'POST',path:ep.path,httpStatus:200}]);assert.equal(c.endpointsTotal,2);assert.equal(c.endpointsTested,1);
});

test('restricted original snapshots survive redaction and reject partial PUT/cross-session reuse',async t=>{
 const home=await sandbox(t);const url='https://fixture.invalid/settings';const original='{"charset":"UTF-8","contact":{"name":"fixture"},"enabled":false}';
 const ref=await saveResponseSnapshot(home,'s',url,original,'application/json');assert.equal((await readResponseSnapshot(home,'s',ref,url)).body,original);
 const request={method:'PUT',url,body:'{"enabled":true}',safetyPlan:{backupRef:ref,semantics:'replace',recovery:'restore original'}};
 await assert.rejects(()=>validateWritePlan(home,'s',request),/部分PUT/);
 await assert.rejects(()=>validateWritePlan(home,'other',request),/不属于/);
  await validateWritePlan(home,'s',{...request,body:original});
 const after=JSON.stringify({...JSON.parse(original),extra:'server-default'});
 const currentRef=await saveResponseSnapshot(home,'s',url,after,'application/json');
 await assert.rejects(()=>validateWritePlan(home,'s',{...request,body:original,safetyPlan:{backupRef:currentRef,semantics:'replace',recovery:'restore'}}),/部分PUT/);
 await validateWritePlan(home,'s',{...request,body:original,restoreVerified:true,safetyPlan:{backupRef:currentRef,semantics:'replace',recovery:'restore'}});
 const file=path.join(home,'storages','src-snapshots',ref.slice('snapshot://'.length)+'.json');assert.equal((await fs.stat(file)).mode&0o777,0o600);
});

test('approval decision is durable, actual execution once, uncertain failure never blind-replays',async t=>{
 await sandbox(t);const h=harness(),sid='approval-parent';await h.store.initGoal(sid,{target:'fixture.invalid',objective:'test',authorization:'fixture'});
 const row=await h.store.addPendingApproval(sid,{method:'POST',url:'http://fixture.invalid/a',path:'/a',headers:'',body:'{}',category:'fixture',reason:'fixture',justification:'fixture'});
 await h.store.recordApprovalDecision(sid,row.id,'allow');assert.equal((await h.store.getPendingApproval(sid,row.id)).executionState,'queued');
 let hits=0;const http=async()=>{hits++;throw new Error('response lost');};
 await assert.rejects(()=>h.store.resolvePendingApproval(sid,row.id,'allow','',http),/response lost/);
 assert.equal((await h.store.getPendingApproval(sid,row.id)).executionState,'unknown');
 await assert.rejects(()=>h.store.resolvePendingApproval(sid,row.id,'allow','',http),/不确定/); assert.equal(hits,1);
 await h.store.updateApprovalExecution(sid,row.id,{executionState:'cancelled'});
 await assert.rejects(()=>h.store.recordApprovalDecision(sid,row.id,'allow'),/不确定/);
});

test('knowledge supersession keeps original evidence but removes false current recall',async t=>{
 await sandbox(t);const h=harness(),sid='knowledge-parent';await h.store.initGoal(sid,{target:'fixture.invalid',objective:'test',authorization:'fixture'});const i=await h.store.addIntent(sid,{goalId:'goal-1',title:'i',detail:''});
 const r=await h.store.upsertResearch(sid,{intentId:i.nodeId,category:'app',hypothesis:'no application',status:'false-positive',preconditions:[],stopReason:'wrong premise',evidence:[]});
 const o=await h.store.upsertObservation(sid,{method:'GET',path:'http://fixture.invalid/app',httpStatus:200});
 await h.store.reviseKnowledge(sid,{kind:'research',recordId:r.id,reason:'application exists',evidenceIds:[o.id]});
 const recalled=await h.store.collectPriorContext('fixture.invalid','new-session');assert.equal(recalled.falsifiedHypotheses,undefined);assert.equal((await h.store.sessionData(sid)).research.length,1);
});

test('independent review invalidates when a finding changes',()=>{
 const finding={id:'finding-1',sessionId:'parent',title:'original',severity:'low'};
 const data={research:[{findingId:finding.id,status:'verified',intentId:'verify-intent',verifierSessionId:'child',findingFingerprint:findingFingerprint(finding)}],checkpoints:[{intentId:'verify-intent',childSessionId:'child',stage:'completed'}]};
 assert.equal(verificationOf(data,finding).independent,true);assert.equal(verificationOf(data,{...finding,severity:'high'}).independent,false);
 assert.equal(verificationOf({research:[{findingId:finding.id,status:'verified'}]},finding).independent,false);
});

test('artifact verification hashes actual files and detects later corruption',async t=>{
 const home=await sandbox(t);const row=await publishReportArtifact('session-fixture','fixture.invalid','# Test report');await checkArtifactRecords('session-fixture','fixture.invalid',[row]);
 const {artifactsRoot}=await import('../lib/src/artifacts.js');await fs.writeFile(path.join(artifactsRoot('session-fixture',{target:'fixture.invalid'}),row.path),'changed');await assert.rejects(()=>checkArtifactRecords('session-fixture','fixture.invalid',[row]),/已变更/);
});

test('unrelated search snippets are not accepted as successful CVE retrieval',()=>{
 const sources=[{title:'Optical 88',url:'https://fixture.invalid/optical',snippet:'glasses'},{title:'CVE-2025-12345 advisory',url:'https://fixture.invalid/advisory',snippet:'security'}];
 assert.deepEqual(relevantSearchResults(sources,'GeoServer CVE-2025-12345'),[sources[1]]);
});
