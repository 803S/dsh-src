import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SrcStore,srcDomainSpec,__resetSharedDomainOpensForTests,applySrcEvent,srcInitialState,srcProjectionSchema,viewSrcState} from '../lib/src.js';
import {stateFromStore} from '../lib/src/store-projection.js';
import {saveResponseSnapshot,readResponseSnapshot,validateWritePlan} from '../lib/src/write-safety.js';
import {makeManifest,computeCoverage,endpointKey} from '../lib/src/endpoint-manifest.js';
import {findingFingerprint,verificationOf} from '../lib/src/verification.js';
import {publishReportArtifact,checkArtifactRecords,markReportArtifactsStale} from '../lib/src/artifact-manifest.js';
import { executeWithWriteSafety } from '../lib/src/write-executor.js';
import {relevantSearchResults} from '../lib/src/web-search-provider.js';
import {validatePublicSourceUrl,boundPublicText} from '../lib/src/public-source.js';
import {buildResearchBenchmarkCase,compareVersions,evaluateVersionRange} from '../lib/src/research-benchmark.js';

test('public source guard separates trusted HTTPS research from target scope',async()=>{
 const resolve=async(host)=>[{address:'93.184.216.34'}];
 assert.deepEqual((await validatePublicSourceUrl('https://nvd.nist.gov/vuln/detail/CVE-2025-58360',{resolve})).host,'nvd.nist.gov');
 await assert.rejects(()=>validatePublicSourceUrl('http://nvd.nist.gov/x',{resolve}),/HTTPS/);
 await assert.rejects(()=>validatePublicSourceUrl('https://example.invalid/x',{resolve}),/可信来源/);
 const privateAddress=[0xc0,0xa8,1,2].join('.');
 await assert.rejects(()=>validatePublicSourceUrl('https://nvd.nist.gov/x',{resolve:async()=>[{address:privateAddress}]}),/私有/);
 const bounded=boundPublicText('<script>x()</script><h1>CVE</h1>'+('x'.repeat(600)),500);assert.equal(bounded.text.length,500);assert.equal(bounded.truncated,true);assert.equal(bounded.sourceChars,604);
});

test('research benchmark requires sourced advisory, version positive/negative controls, and never creates finding',async()=>{
 assert.equal(compareVersions('2.25.5','2.25.6'),-1);assert.equal(evaluateVersionRange('2.25.5',{fixed:'2.25.6'}).affected,true);assert.equal(evaluateVersionRange('2.25.6',{fixed:'2.25.6'}).affected,false);
 const sample=buildResearchBenchmarkCase({sourceUrl:'https://nvd.nist.gov/vuln/detail/CVE-2025-58360',advisoryId:'CVE-2025-58360',product:'GeoServer',affectedVersion:'2.25.5',fixedVersion:'2.25.6',negativeVersion:'2.25.6',preconditions:['POST body SLD parser path']});
 assert.equal(sample.positive.affected,true);assert.equal(sample.negative.affected,false);assert.equal(sample.createsFinding,false);assert.equal(sample.networkRequests,0);assert.match(sample.preconditions[0],/POST/);
});

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
 const view=await h.store.view(sid);
 assert.equal(new Set(view.facts.map(r=>r.id)).size,12);
 /* [local.105] 投影数据源 = store 权威快照（stateFromStore），不再是日志合成事件：
    断言投影状态与 store 视图逐字段一致，同时确认日志里零自造行。 */
 const state=stateFromStore(view,srcInitialState,0);
 assert.deepEqual(state.coverage.map(r=>r.id).sort(),view.coverage.map(r=>r.id).sort());
 assert.equal(state.nodes.filter(r=>r.kind==='fact').length,12);
 assert.equal(srcProjectionSchema.safeParse(viewSrcState(state)).success,true);
 assert.equal(h.events.length,0,'store 直写不得往会话日志合成行');
 /* 权威快照折叠幂等：同一 drive 载荷重复折叠不改变状态（0.1 的 drive 不去重，重放靠状态自洽） */
 /* [local.105] poke 用专用事件类型（不是 tool/call）：宿主自己的投影会忽略它，不会留下幽灵 pendingCalls。 */
 const poke={type:'src_authoritative_state',seq:0,data:{view,eventSeq:0}};
 const folded=applySrcEvent(srcInitialState,poke);
 assert.deepEqual(applySrcEvent(folded,poke),folded);
 assert.deepEqual(folded.nodes.map(r=>r.id).sort(),state.nodes.map(r=>r.id).sort());
 const duplicate=applySrcEvent(folded,poke);assert.deepEqual(duplicate,folded);
 /* 旧日志里的历史合成行（tool/call + src_authoritative_state 工具名）仍必须可 fold。 */
 const legacy={type:'tool/call',data:{callId:'src-live-legacy',name:'src_authoritative_state',arguments:JSON.stringify({view,eventSeq:0})}};
 const legacyFolded=applySrcEvent(srcInitialState,legacy);
 assert.deepEqual(legacyFolded.nodes.map(r=>r.id).sort(),state.nodes.map(r=>r.id).sort());
 const commits=[...h.domain.table('src_commits').entries()].map(([,r])=>r);assert.equal(new Set(commits.map(r=>r.eventSeq)).size,commits.length);
});

test('manifest canonical IDs, evidence binding and cross-method negatives',()=>{
 const endpoints=[{method:'POST',path:'https://fixture.invalid/a',sourceRef:'observation-1'},{method:'GET',path:'https://fixture.invalid/a',sourceRef:'observation-1'}];
 const m=makeManifest('s','schema',endpoints),rev=makeManifest('s','schema',endpoints.toReversed());assert.equal(m.id,rev.id);assert.equal(m.endpoints.length,2);
 const ep=m.endpoints.find(e=>e.method==='POST');
 assert.throws(()=>computeCoverage(m,{[ep.endpointId]:'tested'},['missing'],[]),/不存在/);
 assert.throws(()=>computeCoverage(m,{[ep.endpointId]:'tested'},['obs'],[{id:'obs',method:'GET',path:ep.path,httpStatus:200}]),/相同方法/);
 const c=computeCoverage(m,{[ep.endpointId]:'tested'},['obs'],[{id:'obs',method:'POST',path:ep.path,httpStatus:200}]);assert.equal(c.endpointsTotal,2);assert.equal(c.endpointsTested,1);
 /* [2026-10-14 现场修复] 端点身份 = 方法 + origin + pathname，不带 query：
  * 现场报「tested endpoint 缺少相同方法和路径的真实 observation: ep-2a6a…」就是因为扫描器/agent
  * 记录的观测 path 带查询串、端点 path 不带（或反之），被当成两个端点。 */
 assert.equal(endpointKey('GET','https://fixture.invalid/a?x=1'),endpointKey('GET','https://fixture.invalid/a'));
 assert.equal(endpointKey('GET','https://fixture.invalid/a#frag'),endpointKey('GET','https://fixture.invalid/a'));
 const q=computeCoverage(m,{[ep.endpointId]:'tested'},['obs'],[{id:'obs',method:'POST',path:ep.path+'?returnUrl=%2Fadmin',httpStatus:200}]);assert.equal(q.endpointsTested,1);
 assert.throws(()=>computeCoverage(m,{[ep.endpointId]:'tested'},['obs'],[{id:'obs',method:'POST',path:'https://fixture.invalid/other',httpStatus:200}]),/src_record_observation/,'错误必须给出可行动原因');
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
 const root=(await import('../lib/src/artifacts.js')).artifactsRoot('session-fixture',{target:'fixture.invalid'});assert.equal(await markReportArtifactsStale('session-fixture','fixture.invalid','finding changed'),1);const manifest=JSON.parse(await fs.readFile(path.join(root,row.path+'.manifest.json'),'utf8'));assert.equal(manifest.stale,true);assert.equal(manifest.staleReason,'finding changed');
 const {artifactsRoot}=await import('../lib/src/artifacts.js');await fs.writeFile(path.join(artifactsRoot('session-fixture',{target:'fixture.invalid'}),row.path),'changed');await assert.rejects(()=>checkArtifactRecords('session-fixture','fixture.invalid',[row]),/已变更/);
});

test('unrelated search snippets are not accepted as successful CVE retrieval',()=>{
 const sources=[{title:'Optical 88',url:'https://fixture.invalid/optical',snippet:'glasses'},{title:'CVE-2025-12345 advisory',url:'https://fixture.invalid/advisory',snippet:'security'}];
 assert.deepEqual(relevantSearchResults(sources,'GeoServer CVE-2025-12345'),[sources[1]]);
});

test('[local.106] 判定计量纯逻辑：折叠有界、延迟四元组、采纳去重、标签内容无关',async()=>{
 const {emptyDecisionStats,normalizeDecisionStats,publicDecisionStats,publicDecisionEntry,foldDecisionStats,decisionEntryFromAdvice,decisionOfferEntry,decisionAdoptEntry,isDuplicateAdoption,decisionSubjectOf,decisionTaskOf}=await import('../lib/src/decision/stats.js');
 /* 旧行/缺字段的行归一化后必须是完整形状（fold 永远拿到全套键，不留 undefined） */
 assert.deepEqual(normalizeDecisionStats(undefined,'s',0),emptyDecisionStats('s',0));
 assert.equal(Object.values(emptyDecisionStats('s',0)).includes(undefined),false);
 const row=(over={})=>({seq:1,kind:'decision',at:1e3,taskType:'risk-grade',action:'allow',effect:'read',source:'jev',provider:'systemone',model:'m',fallback:false,mode:'on',subject:'GET x.test/y',latency:10,...over});
 let stats=foldDecisionStats(emptyDecisionStats('s',0),row());
 assert.equal(stats.total,1);assert.deepEqual(stats.byTask,{'risk-grade':1});assert.deepEqual(stats.latency,{count:1,sum:10,max:10,last:10});
 assert.equal(stats.last.subject,'GET x.test/y');assert.equal(stats.decisionSeq,1);
 /* 纯函数：折叠不改入参 */
 assert.equal(emptyDecisionStats('s',0).total,0);
 /* 回退/错误行照计（服务故障是真实工作量），但绝不猜 fallback */
 const failed=foldDecisionStats(stats,row({seq:2,fallback:true,errorType:'http-503',action:'pending',effect:'unknown',latency:20}));
 assert.equal(failed.fallback,1);assert.deepEqual(failed.errors,{'http-503':1});assert.equal(failed.total,2);assert.equal(failed.latency.last,20);
 assert.equal(foldDecisionStats(stats,row({seq:2,fallback:'yes',errorType:''})).fallback,0,'非布尔 fallback 不得计回退');
 /* 没有 latency 的行不进延迟统计（冷读/短路行不得把平均值拉低） */
 assert.equal(foldDecisionStats(failed,row({seq:3,latency:void 0})).latency.count,2);
 assert.equal(foldDecisionStats(failed,row({seq:3,latency:Number.NaN})).latency.count,2,'NaN 延迟不得进统计');
 /* offer/adopt 不计入 total，也不覆盖 last（last 只跟「一次判定」走） */
 const offered=foldDecisionStats(failed,decisionOfferEntry({taskType:'skill-activate',skillId:'lesson:a@b',label:'T',recommendationId:'skillrec-1',seq:3,at:1e3}));
 assert.equal(offered.total,2);assert.equal(offered.offered,1);assert.deepEqual(offered.offeredByTask,{'skill-activate':1});assert.equal(offered.last.subject,failed.last.subject);
 const adopted=foldDecisionStats(offered,decisionAdoptEntry({taskType:'skill-activate',skillId:'lesson:a@b',label:'a',recommendationId:'skillrec-1',seq:4,at:1e3}));
 assert.equal(adopted.adopted,1);assert.deepEqual(adopted.adoptedIds,['skillrec-1']);
 assert.equal(isDuplicateAdoption(adopted,'skillrec-1'),true);
 assert.equal(isDuplicateAdoption(adopted,''),true,'空 recommendationId 无法关联，不得计采纳');
 assert.equal(isDuplicateAdoption(adopted,'skillrec-2'),false);
 /* 键有界：25 个不同模型 → 12 个具名 + other，聚合行不随流量无界增长 */
 let wide=emptyDecisionStats('s',0);
 for(let i=0;i<25;i++) wide=foldDecisionStats(wide,row({seq:i+1,model:`m-${i}`}));
 assert.equal(Object.keys(wide.byModel).length,13,'12 个具名键 + other 兜底');assert.equal(Object.values(wide.byModel).reduce((a,b)=>a+b,0),25);
 /* 不可信输入不得撑爆行：subject 截断、控制字符归一 */
 assert.equal(decisionEntryFromAdvice({action:'allow'},{taskType:'risk-grade',subject:'a'.repeat(500)}).subject.length,120);
 assert.equal(decisionEntryFromAdvice({action:'allow'},{taskType:'risk-grade',subject:'x\u0000y\nz'}).subject,'x y z');
 assert.equal(decisionTaskOf('bogus'),'unsupported','未知职责不得被误算进真实职责');
 assert.equal(decisionTaskOf(42),'unsupported');
 /* wire 形状不泄露存储侧字段，脏明细行读出来必须合法 */
 assert.equal(publicDecisionStats(null),null);
 assert.equal(publicDecisionStats(adopted).adoptedIds,undefined);
 const dirty=publicDecisionEntry({seq:1,kind:'decision',taskType:7,action:null,latency:Number.NaN,fallback:'yes',errorType:{deep:true},subject:'s'});
 assert.equal(dirty.taskType,'unsupported');assert.equal(dirty.action,'');assert.equal(dirty.fallback,false);assert.equal(dirty.latency,void 0);assert.equal(dirty.errorType,void 0);
 /* subject 内容无关：URL 查询串/请求体/页面文本都不落盘，只留 host/path、标题、候选数量 */
 assert.equal(decisionSubjectOf({method:'get',url:'https://a.test/p/q?token=SECRET#frag'},'risk-grade'),'GET a.test/p/q');
 assert.equal(decisionSubjectOf({method:'POST'},'scan-plan'),'','没有计划条目的 scan-plan 不编造主题');
 assert.equal(decisionSubjectOf({taskType:'browser-index',candidates:[1,2,3],goal:'页面里有 SECRET',observation:'<html>SECRET</html>'},'browser-index'),'3 个候选');
 assert.equal(decisionSubjectOf({title:'短信轰炸',taskType:'delegate'},'delegate'),'短信轰炸');
 assert.equal(decisionSubjectOf({},'unknown-task'),'GET');
 const scanPlan=decisionSubjectOf({plan:{entries:[{request:{url:'https://a.test/x?k=v'}}]}},'scan-plan');
 assert.equal(scanPlan,'1 个请求 · a.test/x');assert.equal(scanPlan.includes('k=v'),false);
});

test('[local.106] 判定计量落入权威域：脏行不污染 wire、随目标归零、不进会话日志',async t=>{
 await sandbox(t);const h=harness(),sid='quality-jev';
 await h.store.initGoal(sid,{target:'fixture.invalid',objective:'test',authorization:'fixture'});
 /* 域版本 17 且两张计量表已声明（迁移依赖 defineDomain 的新增表语义） */
 assert.equal(srcDomainSpec.version,17);
 assert.equal(Object.keys(srcDomainSpec.tables).includes('decision_stats'),true);
 assert.equal(Object.keys(srcDomainSpec.tables).includes('decision_recent'),true);
 assert.deepEqual((await h.store.view(sid)).jev,{stats:null,recent:[]},'新目标必须是零值空态');
 /* 脏入参：全部只告警、不抛错、不写坏行 */
 await h.store.recordDecision(sid,{kind:'decision',taskType:'nope',action:null,subject:'x'.repeat(500),latency:Number.NaN,fallback:'yes',errorType:{},seq:1});
 await h.store.recordDecision('',{kind:'decision',taskType:'risk-grade'});
 await h.store.recordRecommendation(sid,{taskType:'skill-activate',skillId:'lesson:a@b',label:'T',recommendationId:'skillrec-1'});
 await h.store.adoptRecommendation(sid,{taskType:'skill-activate',skillId:'lesson:a@b',label:'a',recommendationId:'skillrec-1'});
 await h.store.adoptRecommendation(sid,{taskType:'skill-activate',skillId:'lesson:a@b',label:'a',recommendationId:'skillrec-1'});
 const panel=(await h.store.view(sid)).jev;
 assert.equal(panel.stats.total,1);assert.equal(panel.stats.byTask.unsupported,1);assert.equal(panel.stats.byTask['risk-grade'],undefined);
 assert.equal(panel.stats.byAction.unreported,1);assert.equal(panel.stats.latency.count,0);assert.equal(panel.stats.fallback,0);
 assert.equal(panel.stats.offered,1);assert.equal(panel.stats.adopted,1);assert.equal(panel.stats.decisionSeq,3);
 assert.equal(panel.recent.length,3);assert.equal(panel.recent[0].seq,3,'面板明细最新在前（最新一条在首行）');
 assert.deepEqual(panel.recent.map(r=>r.seq),[3,2,1],'面板明细严格最新在前');
 const dirtyRow=panel.recent.find(r=>r.kind==='decision');assert.equal(dirtyRow.subject.length,120);assert.equal(dirtyRow.action,'');assert.equal(dirtyRow.fallback,false);
 assert.equal(panel.recent.filter(r=>r.kind==='adopt').length,1,'重复采纳只留一行');
 /* 面板 wire 必须过投影 schema（脏明细行不得把面板打成非法 payload） */
 const state=stateFromStore(await h.store.view(sid),srcInitialState,0);
 assert.equal(srcProjectionSchema.safeParse(viewSrcState(state)).success,true);
 assert.equal(viewSrcState(state).jev.stats.adopted,1);
 /* 权威域写入不碰会话日志：面板数据源不是日志（历史合成行曾导致 0.2 加载失败） */
 assert.equal(h.events.length,0);
 /* 计量归当前目标所有：新目标从零开始（否则历史工作量会被当成本轮成果） */
 await h.store.initGoal(sid,{target:'fixture.invalid',objective:'second',authorization:'fixture'});
 assert.deepEqual((await h.store.view(sid)).jev,{stats:null,recent:[]});
 assert.equal([...h.domain.table('decision_recent').entries()].length,0);
});

test('[local.106] 投影 wire 必带 jev：空态零值、权威视图不丢（漂移闸）',()=>{
 const empty=viewSrcState(srcInitialState);
 assert.deepEqual(empty.jev,{stats:null,recent:[]});
 assert.equal(srcProjectionSchema.safeParse(empty).success,true);
 assert.deepEqual(srcProjectionSchema.parse(empty).jev,{stats:null,recent:[]},'wire 不得剥掉 jev（剥掉就是面板永远空的静默缺陷）');
 const legacy={...srcInitialState};delete legacy.jev;
 assert.deepEqual(viewSrcState(legacy).jev,{stats:null,recent:[]},'旧 checkpoint 缺 jev 必须容错');
 assert.equal(stateFromStore({goal:null},srcInitialState,0).jev.stats,null,'旧视图没有 jev 时补零值空态');
 const stats={total:1,byTask:{'risk-grade':1},byAction:{allow:1},byEffect:{read:1},bySource:{jev:1},byModel:{m:1},byMode:{on:1},fallback:0,errors:{},latency:{count:1,sum:3,max:3,last:3},offered:0,adopted:0,offeredByTask:{},adoptedByTask:{},startedAt:1,updatedAt:2,lastAt:2,decisionSeq:1,last:null};
 const withJev=stateFromStore({goal:null,jev:{stats,recent:[]}},srcInitialState,0);
 assert.deepEqual(withJev.jev,{stats,recent:[]},'权威视图带 jev 时必须落进投影 state');
 const wire=viewSrcState(withJev);
 assert.equal(srcProjectionSchema.safeParse(wire).success,true);
 assert.equal(srcProjectionSchema.parse(wire).jev.stats.total,1);
});
