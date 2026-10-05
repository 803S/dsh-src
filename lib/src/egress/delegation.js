import {gateError} from './plan.js';
import {validateTeamMetadata} from './team-metadata.js';

const guardKey=Symbol('src-delegation-guard');
function methodOf(runtime,name){
 for(let object=runtime;object;object=Object.getPrototypeOf(object)){
  const descriptor=Object.getOwnPropertyDescriptor(object,name);
  if(descriptor)return descriptor.value;
 }
}
const providers=new Map([['spawn','SpawnInProcessProvider'],['fork','ForkInProcessProvider']]);
const teamTools=new Set(['create','edit_plan','approve','add_member','remove_member','create_task','reassign_task','claim_task','update_task','send_message','status','resume','delete'].map(name=>'agent_teams_'+name));
export const isTeamTool=name=>teamTools.has(name);
const controls=new Set(['send_message','interrupt_agent','list_agents','report']);
export const isDelegationControl=name=>controls.has(name);
// Optional selectors have an explicit "not selected" meaning. Some tool
// clients encode that as an empty string instead of omitting the property.
// Never normalize approval, identities/attempt tokens or task transitions.
const optionalSelectors={agent_teams_create:['profile'],agent_teams_add_member:['provider','model','reasoning_effort'],agent_teams_create_task:['objective','reviewedTaskId','sourceTaskId']};
export function normalizeTeamArguments(name,args){
 validateTeamMetadata(name,args);
 const keys=optionalSelectors[name]??[];
 const empty=keys.filter(key=>Object.hasOwn(args,key)&&(args[key]===null||typeof args[key]==='string'&&args[key].trim()===''));
 if(!empty.length)return args;
 const normalized={...args};for(const key of empty)delete normalized[key];
 return Object.freeze(normalized);
}
export function delegationGuardReady(runtime){
 const guard=runtime?.[guardKey];
 return !!guard&&methodOf(runtime,'start')===guard.start&&methodOf(runtime,'prepareContinuable')===guard.prepare;
}
// Trusted installed host plugins are the code boundary; provider names/classes
// here reject unsupported external transports, not malicious host JavaScript.
export function installDelegationGuard(ctx,service){
 const runtime=ctx.subagents;
 if(runtime[guardKey])throw gateError('DUPLICATE_DELEGATION_GUARD');
 const originalStart=methodOf(runtime,'start'),originalPrepare=methodOf(runtime,'prepareContinuable');
 const check=(name,request)=>{
  const parent=request?.parent;
  if(!parent)return;
  const preset=parent.ctx?.get('agentPresets')?.composedPreset(parent.ctx)??parent.session?.header?.agentPreset;
  if(!service.owns(parent.session?.id)&&preset!=='src-hunter')return;
  service.own(parent.session.id);
  const provider=runtime.getProvider(name);
  if(!providers.has(name)||provider?.constructor?.name!==providers.get(name))throw gateError('UNSUPPORTED_DELEGATION_PROVIDER');
  if(preset!=='src-hunter')throw gateError('DELEGATION_PRESET_CHANGED');
 };
 const start=function(name,request){check(name,request);return originalStart.call(this,name,request);};
 const prepare=function(name,request){check(name,request);return originalPrepare.call(this,name,request);};
 runtime.start=start;runtime.prepareContinuable=prepare;runtime[guardKey]={start,prepare};
 // Cordis exposes context-specific service proxies. Read readiness using the
 // installing context. Descriptor reads avoid newly-created method proxies.
 const ready=()=>delegationGuardReady(runtime);
 service.delegationReady=ready;
 ctx.effect(()=>()=>{
  if(methodOf(runtime,'start')===start)runtime.start=originalStart;
  if(methodOf(runtime,'prepareContinuable')===prepare)runtime.prepareContinuable=originalPrepare;
  delete runtime[guardKey];
  if(service.delegationReady===ready)delete service.delegationReady;
 });
}
