// Real registered AgentTeams and child ToolRuntime compatibility probe.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {goalToolsProbe} from './goal-tools-probe.mjs';
export const teamsTurns=new Map();
const captainTurns=new Map();
export async function holdTeamsTurn({agent,signal},next){
 const turn=captainTurns.get(agent.session.id)??teamsTurns.get(agent.session.header.parentSession);
 if(turn?.before)return next(); // Goal authority requires committed user input.
 if(turn){
  turn.enter();await Promise.race([turn.done,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
 }
 return {kind:'reject'};
}
export async function holdTeamsRequest({agent,signal},next){
 const turn=captainTurns.get(agent.session.id)??teamsTurns.get(agent.session.header.parentSession);
 if(!turn?.before)return next();
 try{
  if(!turn.started){turn.started=true;await turn.before(agent);}
  turn.enter();await Promise.race([turn.done,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
 }catch(error){turn.fail(error);throw error;}
 throw new Error('Fixture held request released; no model call permitted');
}
export async function teamsInheritanceProbe(ctx,agent,origin){
 const signal=AbortSignal.timeout(40000),teamCalls=[],calls=[];
 let captainRelease,captainEnter,captainFail;
 const captainDone=new Promise(resolve=>captainRelease=resolve),captainEntered=new Promise((resolve,reject)=>{captainEnter=resolve;captainFail=reject;});
 captainTurns.set(agent.session.id,{done:captainDone,enter:captainEnter,fail:captainFail,before:async actual=>calls.push({goalCaptain:await goalToolsProbe(ctx,actual)})});
 try{
 // A takeover belongs to one active captain turn. Merely executing a command
 // against an idle Agent correctly makes the native scheduler return it to
 // the pool; hold a real turn rather than overriding the Agent's status.
 agent.followup(createUserMessage({content:[{type:'text',text:'Fixture-owned native captain task lifecycle validation.'}],source:{kind:'user'}}));
 await Promise.race([captainEntered,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);
 // Different Cordis realm from guard installation: verify the actual runtime
 // boundary, not merely that a readiness flag was set in the service.
 for(const method of ['start','prepareContinuable'])await assert.rejects(async()=>ctx.subagents[method]('fixture-external',{parent:agent}),{code:'SRC_GATE_UNSUPPORTED_DELEGATION_PROVIDER'});
 const teamCall=async(name,args)=>{
  const tool=ctx.tools.get(name,agent);assert.ok(tool,name+' missing');
  teamCalls.push(name);const result=await ctx.tools.execute({name,arguments:args,agent,signal,callId:randomUUID()});
  assert.ok(!result.isError,JSON.stringify(result));return result.value;
 };
 const todo=await teamCall('todo_write',{todos:[{content:'Synthetic local plan only',status:'in_progress'}]});
 assert.equal(todo.counts.inProgress,1);assert.equal(todo.todos[0].content,'Synthetic local plan only');
 const invalidTodo=await ctx.tools.execute({name:'todo_write',arguments:{todos:[{content:' ',status:'in_progress'}]},agent,signal,callId:randomUUID()});
 assert.equal(invalidTodo.isError,true,'Native todo validation bypassed');
 const create=await teamCall('agent_teams_create',{name:'synthetic-egress-team',description:'Local child confinement test',approval:'automatic',profile:''});
 let release,enter,fail;const done=new Promise(resolve=>release=resolve),entered=new Promise((resolve,reject)=>{enter=resolve;fail=reject;});
 teamsTurns.set(agent.session.id,{done,enter,fail,before:async actual=>calls.push({goalChild:await goalToolsProbe(ctx,actual,{child:true})})});
 try{
 const member=await teamCall('agent_teams_add_member',{name:'reader',role:'Synthetic local test',provider:'',model:'',reasoning_effort:''});
 let child=ctx.agents.list().find(a=>a.session.id===member.member_id);assert.ok(child,'Real teams child absent');
 // Keep the actual child activation alive while driving its ToolRuntime. A
 // rejected pre-step immediately disposes residency; retaining that stale Agent
 // and calling tools afterward is not a valid child-execution test.
 await Promise.race([entered,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);
 assert.equal(child.session.header.parentSession,agent.session.id);
 assert.equal(child.session.header.agentPreset,'src-hunter');
 const listed=await teamCall('list_agents',{scope:'children'});assert.ok(listed.some(row=>row.id===member.member_id),'Native discovery omitted real member');
 const foreignMessage=await ctx.tools.execute({name:'send_message',arguments:{subagent_id:agent.session.id,message:'Must not deliver to non-child'},agent,signal,callId:randomUUID()});assert.equal(foreignMessage.isError,true,'Native direct-child authority was bypassed');
 const call=async(name,args)=>{
  const result=await ctx.tools.execute({name,arguments:args,agent:child,signal,callId:randomUUID()});
  calls.push({name,args,result});return result;
 };
 const report=await call('report',{output:'Synthetic native child report, no target permission.'});
 assert.ok(!report.isError,JSON.stringify(report));assert.ok(report.value.messageId);
 assert.equal(!!ctx.tools.get('report',agent),false,'Child report leaked into root registry');
 const rootReport=await ctx.tools.execute({name:'report',arguments:{output:'Root must not report as a child'},agent,signal,callId:randomUUID()});
 assert.equal(rootReport.isError,true);
 const inherited=await call('src_state',{detail:'summary'});assert.ok(!inherited.isError);assert.ok(inherited.value.goal);
 for(const [name,args] of [['src_add_goal',{target:origin,objective:'Must not shadow parent scope'}],['src_set_goal_target',{target:'https://other.invalid'}]]){
  const denied=await call(name,args);assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/SRC_DELEGATED_ENGAGEMENT_OWNER_REQUIRED/);
 }
 const unchanged=await call('src_state',{detail:'summary'});assert.deepEqual(unchanged.value.goal,inherited.value.goal);
 const normal=await call('bash',{command:`curl --fail --max-time 10 -sS '${origin}/teams-read'`,description:'Ordinary child request'});
 assert.equal(normal.value?.exitCode,0,JSON.stringify(normal));assert.equal(normal.value.stdout.text,'web-fixture');
 const dangerous=await call('bash',{command:`curl --fail --max-time 10 -sS -X DELETE '${origin}/teams-delete'`,description:'Unapproved destructive child request must not arrive'});
 assert.equal(dangerous.value?.exitCode,22,JSON.stringify(dangerous));assert.match(dangerous.value.stderr.text,/403/);
 const direct=await call('bash',{command:`curl --max-time 3 -sS --noproxy '*' '${origin}/teams-direct'`,description:'Child direct-network bypass must fail'});
 assert.ok(direct.value?.exitCode>0,JSON.stringify(direct));
 const after=await call('bash',{command:`curl --fail --max-time 10 -sS '${origin}/teams-after'`,description:'Ordinary child read after refusals'});
 assert.equal(after.value?.exitCode,0,JSON.stringify(after));assert.equal(after.value.stdout.text,'web-fixture');
 const invalidTask=await ctx.tools.execute({name:'agent_teams_create_task',arguments:{subject:'Must not persist',kind:'work',assignee:'reader',round:0,objective:''},agent,signal,callId:randomUUID()});
 assert.equal(invalidTask.isError,true);assert.ok(JSON.stringify(invalidTask).includes('INVALID_TEAM_ROUND'));
 assert.equal((await teamCall('agent_teams_status',{})).tasks.length,0,'Rejected invalid task poisoned team state');
 const task=await teamCall('agent_teams_create_task',{subject:'Synthetic first task',description:'Fixture-owned local verification',kind:'work',assignee:'reader',round:1,objective:'',reviewedTaskId:'',sourceTaskId:''});
 const dependent=await teamCall('agent_teams_create_task',{subject:'Synthetic dependent task',description:'Must wait for first task',kind:'work',assignee:'reader',dependencies:[task.task_id]});
 const premature=await call('agent_teams_claim_task',{task_id:dependent.task_id});assert.equal(premature.isError,true,'Unfinished dependency was ignored');
 const claimed=await call('agent_teams_claim_task',{task_id:task.task_id});assert.ok(!claimed.isError,JSON.stringify(claimed));assert.ok(claimed.value.attempt_id);
 assert.match(claimed.content.map(block=>block.text??'').join('\n'),/领取回执仅包含任务状态/);
 const contract=await call('read',{file_path:create.state_dir+'/team.json'});
 assert.ok(!contract.isError,JSON.stringify(contract));
 assert.match(JSON.stringify(contract),/Fixture-owned local verification/);
 assert.ok(JSON.stringify(contract).includes(claimed.value.attempt_id));
 const progress=await call('agent_teams_update_task',{task_id:task.task_id,attempt_id:claimed.value.attempt_id,status:'in_progress'});assert.ok(!progress.isError,JSON.stringify(progress));
 const invalidUpdate=await call('agent_teams_update_task',{task_id:task.task_id,attempt_id:claimed.value.attempt_id,status:'in_progress',changedPaths:['']});
 assert.equal(invalidUpdate.isError,true,'Invalid update metadata must be rejected before state write');
 assert.equal((await teamCall('agent_teams_status',{})).tasks.length,2,'Invalid update poisoned team state');
 const stale=await call('agent_teams_update_task',{task_id:task.task_id,attempt_id:'wrong-attempt',status:'completed',output:'Must not commit'});assert.equal(stale.isError,true,'Stale attempt accepted');
 const completed=await call('agent_teams_update_task',{task_id:task.task_id,attempt_id:claimed.value.attempt_id,status:'completed',output:'Synthetic native task completed'});assert.ok(!completed.isError,JSON.stringify(completed));
 const second=await call('agent_teams_claim_task',{task_id:dependent.task_id});assert.ok(!second.isError,JSON.stringify(second));assert.ok(second.value.attempt_id);
 for(const status of ['in_progress','completed']){
  const result=await call('agent_teams_update_task',{task_id:dependent.task_id,attempt_id:second.value.attempt_id,status,output:'Synthetic dependent task completed'});assert.ok(!result.isError,JSON.stringify(result));
 }
 const status=await teamCall('agent_teams_status',{});
 assert.equal(status.tasks.filter(task=>task.status==='completed').length,2);
 release();await child.whenIdle();
 for(let i=0;i<100&&ctx.agents.list().some(a=>a.session.id===member.member_id);i++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok(!ctx.agents.list().some(a=>a.session.id===member.member_id),'Child did not leave residency');
 let resumeEnter;const resumeEntered=new Promise(resolve=>resumeEnter=resolve),resumeDone=new Promise(resolve=>release=resolve);
 teamsTurns.set(agent.session.id,{done:resumeDone,enter:resumeEnter});
 const queued=await teamCall('send_message',{subagent_id:member.member_id,message:'Fixture-owned cold-resume confinement check; no model request.'});
 assert.ok(queued.messageId);
 await Promise.race([resumeEntered,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);
 child=ctx.agents.list().find(a=>a.session.id===member.member_id);assert.ok(child,'Cold-resumed child absent');
 assert.equal(child.session.header.parentSession,agent.session.id);assert.equal(child.session.header.agentPreset,'src-hunter');
 const resumed=await call('bash',{command:`curl --fail --max-time 10 -sS '${origin}/teams-resume'`,description:'Cold-resumed child ordinary request'});
 assert.equal(resumed.value?.exitCode,0,JSON.stringify(resumed));assert.equal(resumed.value.stdout.text,'web-fixture');
 const resumedDanger=await call('bash',{command:`curl --fail --max-time 10 -sS -X DELETE '${origin}/teams-resume-delete'`,description:'Cold-resumed child destructive request must not arrive'});
 assert.equal(resumedDanger.value?.exitCode,22,JSON.stringify(resumedDanger));assert.match(resumedDanger.value.stderr.text,/403/);
 const takeoverTask=await teamCall('agent_teams_create_task',{subject:'Synthetic takeover',description:'Verify native ownership handoff',kind:'work',assignee:'reader'});
 const oldClaim=await call('agent_teams_claim_task',{task_id:takeoverTask.task_id});assert.ok(!oldClaim.isError,JSON.stringify(oldClaim));
 const illegalTakeover=await ctx.tools.execute({name:'agent_teams_update_task',arguments:{task_id:takeoverTask.task_id,status:'completed',output:'Must reject before ownership handoff'},agent,signal,callId:randomUUID()});
 assert.equal(illegalTakeover.isError,true,'Captain overwrote member task without handoff');
 release();await child.whenIdle();
 const takeover=await teamCall('agent_teams_reassign_task',{task_id:takeoverTask.task_id,assignee:'captain',reason:'Fixture-owned explicit handoff'});
 assert.equal(takeover.assignee,'captain');assert.notEqual(takeover.attempt_id,oldClaim.value.attempt_id);assert.ok(takeover.attempt>oldClaim.value.attempt);
 if(takeover.status!=='in_progress')await teamCall('agent_teams_update_task',{task_id:takeoverTask.task_id,status:'in_progress',attempt_id:takeover.attempt_id});
 await teamCall('agent_teams_update_task',{task_id:takeoverTask.task_id,status:'completed',attempt_id:takeover.attempt_id,output:'Captain completed explicit takeover'});
 const finalStatus=await teamCall('agent_teams_status',{});assert.equal(finalStatus.tasks.filter(task=>task.status==='completed').length,3);
 const resume=await teamCall('agent_teams_resume',{reason:'Verify running team remains running'});assert.equal(resume.status,'already_running');
 const removed=await teamCall('agent_teams_remove_member',{name:'reader'});assert.equal(removed.status,'removed');
 const deleted=await teamCall('agent_teams_delete',{});assert.equal(deleted.deleted,true);
 const afterDelete=await ctx.tools.execute({name:'agent_teams_status',arguments:{},agent,signal,callId:randomUUID()});assert.equal(afterDelete.isError,true,'Deleted team still active');
 const staged=await teamCall('agent_teams_create',{name:'synthetic-staged-team',approval:'required'});assert.equal(staged.phase,'staged');
 const roster=await teamCall('agent_teams_add_member',{name:'staged-reader',role:'Synthetic stage verification'});assert.equal(roster.member_id,'');
 const edited=await teamCall('agent_teams_edit_plan',{operations:[{action:'add_task',subject:'Staged synthetic task',description:'Synthetic local traffic verification',assignee:'staged-reader'}]});
 const stagedStatus=await teamCall('agent_teams_status',{});assert.equal(stagedStatus.tasks.length,1);assert.ok(!ctx.agents.list().some(a=>a.session.header.parentSession===agent.session.id),'Staging spawned a child');
 let stagedEnter;const stagedEntered=new Promise(resolve=>stagedEnter=resolve),stagedDone=new Promise(resolve=>release=resolve);
 teamsTurns.set(agent.session.id,{done:stagedDone,enter:stagedEnter});
 const approved=await teamCall('agent_teams_approve',{confirmation:'Fixture user approves this local synthetic team plan only, not destructive target requests'});assert.equal(approved.status,'running');
 await Promise.race([stagedEntered,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);
 child=ctx.agents.list().find(a=>a.session.header.parentSession===agent.session.id);assert.ok(child,'Approved staged member absent');
 const stagedRead=await call('bash',{command:`curl --fail --max-time 10 -sS '${origin}/teams-staged-read'`,description:'Approved team may make ordinary scoped reads'});assert.equal(stagedRead.value?.exitCode,0,JSON.stringify(stagedRead));assert.equal(stagedRead.value.stdout.text,'web-fixture');
 const stagedDanger=await call('bash',{command:`curl --fail --max-time 10 -sS -X DELETE '${origin}/teams-staged-delete'`,description:'Team plan approval must not authorize destructive target requests'});assert.equal(stagedDanger.value?.exitCode,22,JSON.stringify(stagedDanger));assert.match(stagedDanger.value.stderr.text,/403/);
 const stagedClaim=await call('agent_teams_claim_task',{task_id:stagedStatus.tasks[0].id});assert.ok(!stagedClaim.isError,JSON.stringify(stagedClaim));
 for(const status of ['in_progress','completed']){const result=await call('agent_teams_update_task',{task_id:stagedStatus.tasks[0].id,attempt_id:stagedClaim.value.attempt_id,status,output:'Staged team verified; destructive target operation remained blocked'});assert.ok(!result.isError,JSON.stringify(result));}
 assert.equal(child.status,'running','Interrupt fixture requires an active child turn');
 const interrupted=await teamCall('interrupt_agent',{agent_id:child.session.id});
 release();await child.whenIdle();
 const stagedDeleted=await teamCall('agent_teams_delete',{});assert.equal(stagedDeleted.deleted,true);
 return {boundary:'Parent and child calls use real registered ToolRuntime; native fixture approval, not a Web team-plan click test',coldResumed:true,create,member,childHeader:child.session.header,calls,status,illegalTakeover,takeover,finalStatus,resume,removed,deleted,afterDelete,controls:{listed,queued,foreignMessage,interrupted},staged:{staged,roster,edited,stagedStatus,approved,stagedDeleted},teamCalls};
 }finally{release();teamsTurns.delete(agent.session.id);}
 }finally{captainRelease();captainTurns.delete(agent.session.id);}
}
