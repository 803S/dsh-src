// Evaluation-only composition: permits loopback fixtures, never installed in production.
import {createEgressManager} from '../../lib/src/egress/manager.js';
import {dispatchHttp} from '../../lib/src/egress/http-dispatch.js';
import {createEgressEvidenceRecorder} from '../../lib/src/egress/evidence.js';
import {registerEgressCommands} from '../../lib/src/egress/user-commands.js';
import {jevDecide} from '../../lib/src/decision/jev-client.js';
import {SrcStore} from '../../lib/src.js';
export const inject=['storageDomain'];
export function apply(ctx){
 const store=new SrcStore(ctx),owners=new Set();let manager,assessments=0;const decisions=[];
 const service={decisions,own(id){owners.add(id);},owns:id=>owners.has(id),get assessments(){return assessments;},ready(){return manager??=createEgressManager({home:process.env.DSH_HOME,allowLoopbackFixtures:true,proxyExecutable:process.env.DSH_EVAL_PROXY_EXECUTABLE,storeFor:async()=>store,directFetch:dispatchHttp,recordEvidence:createEgressEvidenceRecorder({home:process.env.DSH_HOME,store}),assess:async(plan,exec)=>{assessments++;if(process.env.DSH_EVAL_REAL_JEV==='1'){const result=await jevDecide({taskType:'scan-plan',plan,scopeChecked:true},exec);decisions.push(result);return result;}return {fallback:false,mode:'on',risk:'low',effect:'read',action:'allow',confidence:.99};}});}};
 ctx.provide('srcEgress',service);ctx.inject(['commands'],c=>registerEgressCommands(c,service));
 ctx.effect(()=>async()=>{if(manager)await(await manager).close();await store.dispose();});
}
