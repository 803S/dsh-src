import {createBurpRestorer} from '../../lib/src/egress/burp-request.js';
import {browserLifecycle} from '../../lib/src/egress/browser-lifecycle.js';
import {installDelegationGuard} from '../../lib/src/egress/delegation.js';
import {createFofaLookup} from '../../lib/src/egress/fofa.js';
// Evaluation-only composition: permits loopback fixtures, never installed in production.
import {createEgressManager} from '../../lib/src/egress/manager.js';
import {dispatchHttp} from '../../lib/src/egress/http-dispatch.js';
import {createEgressEvidenceRecorder} from '../../lib/src/egress/evidence.js';
import {registerEgressCommands} from '../../lib/src/egress/user-commands.js';
import {assessEgressPlan} from '../../lib/src/egress/advisor.js';
import {SrcStore} from '../../lib/src.js';
export const inject=['storageDomain','sessions'];
export function apply(ctx){
 const store=new SrcStore(ctx),owners=new Set();let manager,assessments=0,activeAssessments=0,assessmentPeak=0;const decisions=[];
 const fofaLookup=createFofaLookup({home:process.env.DSH_HOME,...(process.env.DSH_EVAL_FOFA==='1'?{
   pin:async origin=>{if(origin!=='https://fofa.info')throw new Error('Unexpected FOFA origin');return [{address:'127.0.0.1',family:4}];},
   send:(url,init)=>{const target=new URL(url);if(target.origin+target.pathname!=='https://fofa.info/api/v1/search/all')throw new Error('Unexpected FOFA endpoint');return dispatchHttp(process.env.DSH_EVAL_FOFA_ORIGIN+'/fofa-index'+target.search,init);},
 }: {})});
 const restoreBurp=createBurpRestorer(ctx,store);
 const service={fofaLookup,decisions,own(id){owners.add(id);},owns:id=>owners.has(id),get assessments(){return assessments;},get assessmentPeak(){return assessmentPeak;},ready(){return manager??=createEgressManager({now:()=>Date.now()+Number(process.env.DSH_EVAL_CLOCK_OFFSET_MS??0),restoreBurp,lifecycle:store.domain().then(browserLifecycle),home:process.env.DSH_HOME,allowLoopbackFixtures:true,proxyExecutable:process.env.DSH_EVAL_PROXY_EXECUTABLE,storeFor:async()=>store,directFetch:dispatchHttp,recordEvidence:createEgressEvidenceRecorder({home:process.env.DSH_HOME,store}),assess:async(plan,exec)=>{assessments++;activeAssessments++;assessmentPeak=Math.max(assessmentPeak,activeAssessments);try{if(process.env.DSH_EVAL_CANCEL_REVIEW==='1'&&plan.entries.some(e=>new URL(e.request.url).pathname==='/cancelled-read'))await new Promise(resolve=>setTimeout(resolve,2000));if(process.env.DSH_EVAL_SLOW_REVIEW==='1'&&plan.entries.some(e=>new URL(e.request.url).pathname==='/curl-normal'))await new Promise(resolve=>setTimeout(resolve,31000));if(process.env.DSH_EVAL_ASSESSMENT_BURST==='1'&&process.env.DSH_EVAL_REAL_JEV!=='1')await new Promise(resolve=>setTimeout(resolve,150));if(process.env.DSH_EVAL_REAL_JEV==='1'){const result=await assessEgressPlan(plan,exec);decisions.push({...result,requestUrls:plan.entries.map(entry=>entry.request.url)});return result;}if(process.env.DSH_EVAL_MOCK_UNKNOWN_POST==='1'&&plan.entries.some(entry=>entry.request.method==='POST'))return {fallback:false,mode:'on',risk:'unknown',effect:'unknown',action:'pending',confidence:.99};return {fallback:false,mode:'on',risk:'low',effect:'read',action:'allow',confidence:.99};}finally{activeAssessments--;}}});}};
 ctx.provide('srcEgress',service);ctx.inject(['commands'],c=>registerEgressCommands(c,service));
 ctx.inject(['subagents'],c=>installDelegationGuard(c,service));
 ctx.effect(()=>async()=>{if(manager)await(await manager).close();await store.dispose();});
}
