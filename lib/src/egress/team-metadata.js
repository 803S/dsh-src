import {gateError} from './plan.js';
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const optional=(value,key,test)=>value[key]===undefined||test(value[key]);
const status=value=>['passed','failed'].includes(value);
const evidence=value=>optional(value,'evidence',v=>typeof v==='string');
const finding=value=>record(value)&&['low','medium','high','blocker'].includes(value.severity)
 &&['id','problem','requiredFix'].every(key=>nonempty(value[key]))
 &&optional(value,'file',nonempty)&&optional(value,'line',v=>Number.isSafeInteger(v)&&v>=0)
 &&optional(value,'resolved',v=>typeof v==='boolean');
const acceptance=value=>record(value)&&nonempty(value.criterion)&&status(value.status)&&evidence(value);
const command=value=>record(value)&&nonempty(value.command)&&status(value.status)&&evidence(value)&&optional(value,'exitCode',Number.isSafeInteger);
function invalid(key){throw Object.assign(gateError('INVALID_TEAM_TASK_METADATA'),{message:`SRC_GATE_INVALID_TEAM_TASK_METADATA: ${key} contains invalid task metadata; omit unused fields or use empty lists.`});}
// Match the durable task-field contract before invoking installed writers.
// A tool returning an error after saving is too late to protect team state.
export function validateTeamMetadata(name,args){
 if(!['agent_teams_create_task','agent_teams_update_task'].includes(name))return;
 if(args.round!==undefined&&(!Number.isSafeInteger(args.round)||args.round<1))throw Object.assign(gateError('INVALID_TEAM_ROUND'),{message:'SRC_GATE_INVALID_TEAM_ROUND: round must be a safe integer >= 1; omit it when unused.'});
 for(const key of ['inScope','outOfScope','acceptance','verify','deliverables','nonGoals','sourceFindingIds','coverageOf','changedPaths']){
  if(args[key]!==undefined&&(!Array.isArray(args[key])||!args[key].every(nonempty)))invalid(key);
 }
 for(const [key,validate] of [['findings',finding],['acceptanceResults',acceptance],['commandsRun',command]]){
  if(args[key]!==undefined&&(!Array.isArray(args[key])||!args[key].every(validate)))invalid(key);
 }
 if(args.findings&&new Set(args.findings.map(value=>value.id)).size!==args.findings.length)invalid('duplicate finding ids');
}
