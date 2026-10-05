import test from 'node:test';
import assert from 'node:assert/strict';
import {installDelegationGuard,delegationGuardReady,isTeamTool,isDelegationControl,normalizeTeamArguments} from '../lib/src/egress/delegation.js';
import {verifyTeamsModel} from '../scripts/egress-feasibility/teams-model.mjs';
import {guardGoalTool} from '../lib/src/egress/goal-tools.js';
test('shared SRC protocol does not assign captain duties to a native worker persona',async()=>{
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('../lib/src.js',import.meta.url),'utf8');
 const protocol=source.split('const SRC_INSTRUCTIONS = `')[1].split('`;')[0];
 assert.doesNotMatch(protocol,/你是 SRC 漏洞挖掘指挥官/);
 assert.match(protocol,/委派会话以自身 persona 和任务为准/);
 assert.match(protocol,/【主循环（仅指挥官）】/);
 assert.match(protocol,/AgentTeams 成员更新已分配的团队任务，不自建目标/);
 assert.match(protocol,/仅用户原生命令可批准/);
});
test('native goal controls remain available to roots but delegated sessions cannot mutate goals',()=>{
 for(const name of ['create_goal','update_goal']){
  assert.doesNotThrow(()=>guardGoalTool(name,{header:{}}));
  assert.throws(()=>guardGoalTool(name,{header:{parentSession:'captain'}}),{code:'SRC_GATE_DELEGATED_GOAL_MUTATION'});
 }
 for(const name of ['get_goal','src_add_goal','todo_write'])assert.doesNotThrow(()=>guardGoalTool(name,{header:{parentSession:'captain'}}));
});
test('empty optional team selectors mean absent without changing authorization fields',()=>{
 const args=Object.freeze({name:'team',profile:' ',approval:'required',attempt_id:''});
 assert.deepEqual(normalizeTeamArguments('agent_teams_create',args),{name:'team',approval:'required',attempt_id:''});assert.equal(args.profile,' ');
 assert.deepEqual(normalizeTeamArguments('agent_teams_add_member',{name:'member',provider:null,model:'',reasoning_effort:''}),{name:'member'});
 const selected={profile:'configured',approval:''};assert.equal(normalizeTeamArguments('agent_teams_create',selected),selected);
 const update={attempt_id:'',status:''};assert.equal(normalizeTeamArguments('agent_teams_update_task',update),update);
});
test('task metadata cannot poison durable team state before native validation',()=>{
 for(const round of [0,-1,1.5,null,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>normalizeTeamArguments('agent_teams_create_task',{round}),{code:'SRC_GATE_INVALID_TEAM_ROUND'});
 assert.throws(()=>normalizeTeamArguments('agent_teams_create_task',{inScope:['']}),{code:'SRC_GATE_INVALID_TEAM_TASK_METADATA'});
 assert.deepEqual(normalizeTeamArguments('agent_teams_create_task',{kind:'work',round:1,objective:'',sourceTaskId:'',reviewedTaskId:'',acceptance:[]}),{kind:'work',round:1,acceptance:[]});
});
test('updates reject malformed durable evidence without treating error-after-save as safe',()=>{
 const validFinding={id:'f',severity:'low',problem:'p',requiredFix:'fix'};
 for(const args of [{changedPaths:['']},{commandsRun:[{command:'x',status:'passed',exitCode:0.5}]},{acceptanceResults:[{criterion:'',status:'passed'}]},{findings:[{...validFinding,line:-1}]},{findings:[validFinding,validFinding]}]){
  assert.throws(()=>normalizeTeamArguments('agent_teams_update_task',args),{code:'SRC_GATE_INVALID_TEAM_TASK_METADATA'});
 }
 const valid={changedPaths:['file.txt'],commandsRun:[{command:'test',status:'passed',exitCode:0}],acceptanceResults:[{criterion:'verified',status:'passed'}],findings:[validFinding]};
 assert.equal(normalizeTeamArguments('agent_teams_update_task',valid),valid);
});
test('SRC delegates only through audited native providers, including cold prepare and background calls',()=>{
 class SpawnInProcessProvider{}class ForkInProcessProvider{}class ExternalProvider{}
 const calls=[],owned=new Set(),p={spawn:new SpawnInProcessProvider(),fork:new ForkInProcessProvider(),external:new ExternalProvider()};
 const runtime={getProvider:name=>p[name],start:(...args)=>calls.push(['start',...args]),prepareContinuable:(...args)=>calls.push(['prepare',...args])};
 const original=runtime.start;let dispose;
 installDelegationGuard({subagents:runtime,effect:factory=>dispose=factory()},{owns:id=>owned.has(id),own:id=>owned.add(id)});
 assert.equal(delegationGuardReady(runtime),true);
 const parent={session:{id:'src',header:{agentPreset:'src-hunter'}}};
 runtime.start('spawn',{parent});runtime.prepareContinuable('fork',{parent});
 assert.equal(calls.length,2);assert.equal(owned.has('src'),true);
 assert.throws(()=>runtime.prepareContinuable('external',{parent}),{code:'SRC_GATE_UNSUPPORTED_DELEGATION_PROVIDER'});
 assert.throws(()=>runtime.start('external',{parent}),{code:'SRC_GATE_UNSUPPORTED_DELEGATION_PROVIDER'});
 p.spawn=new ExternalProvider();assert.throws(()=>runtime.start('spawn',{parent}),{code:'SRC_GATE_UNSUPPORTED_DELEGATION_PROVIDER'});
 runtime.start('external',{parent:{session:{id:'ordinary',header:{agentPreset:'default'}}}});assert.equal(calls.length,3);
 parent.session.header.agentPreset='default';assert.throws(()=>runtime.prepareContinuable('fork',{parent}),{code:'SRC_GATE_DELEGATION_PRESET_CHANGED'});
 dispose();assert.equal(runtime.start,original);assert.equal(delegationGuardReady(runtime),false);
});
test('team allowlist is exact and readiness detects overwritten boundaries',()=>{
 for(const name of ['send_message','interrupt_agent','list_agents','report'])assert.equal(isDelegationControl(name),true);
 assert.equal(isDelegationControl('send_message_http'),false);assert.equal(isDelegationControl('subagent_external'),false);
 assert.equal(isTeamTool('agent_teams_status'),true);assert.equal(isTeamTool('agent_teams_send_message'),true);assert.equal(isTeamTool('agent_teams_arbitrary_network'),false);
 const runtime={start(){},prepareContinuable(){}};let dispose;
 installDelegationGuard({subagents:runtime,effect:f=>dispose=f()},{owns:()=>false});
 runtime.prepareContinuable=()=>{};assert.equal(delegationGuardReady(runtime),false);dispose();
});
test('contextual service method proxies preserve readiness, enforcement and disposal',()=>{
 class SpawnInProcessProvider{}
 const target={getProvider:()=>new SpawnInProcessProvider(),start:()=>42,prepareContinuable:()=>43};
 const realm=()=>new Proxy(target,{get(t,key,receiver){const value=Reflect.get(t,key,receiver);return typeof key!=='symbol'&&typeof value==='function'?new Proxy(value,{apply(fn,self,args){return Reflect.apply(fn,self,args);}}):value;}});
 const a=realm(),b=realm(),service={owns:()=>true,own(){}};let dispose;
 installDelegationGuard({subagents:a,effect:f=>dispose=f()},service);
 assert.equal(service.delegationReady(),true);assert.equal(delegationGuardReady(b),true);
 const parent={session:{id:'src',header:{agentPreset:'src-hunter'}}};
 assert.equal(b.start('spawn',{parent}),42);
 assert.throws(()=>b.prepareContinuable('external',{parent}),{code:'SRC_GATE_UNSUPPORTED_DELEGATION_PROVIDER'});
 assert.throws(()=>installDelegationGuard({subagents:b},service),{code:'SRC_GATE_DUPLICATE_DELEGATION_GUARD'});
 dispose();assert.equal(delegationGuardReady(b),false);assert.equal(service.delegationReady,undefined);
});
test('model acceptance requires member-authored successful traffic and completed work, not just queue acceptance',()=>{
 const events=[];
 for(const name of ['agent_teams_create','agent_teams_add_member','agent_teams_create_task','agent_teams_status']){
  events.push({type:'assistant',sessionId:'captain',content:[{type:'tool-call',name}]});
  events.push({type:'tool-result',sessionId:'captain',name,isError:false,...(name==='agent_teams_create_task'?{arguments:{description:'bash curl https://fixture.invalid/teams-model; DELETE https://fixture.invalid/teams-model-delete; verify pending, never approve',acceptance:[]}}:{}),value:name==='agent_teams_add_member'?{member_id:'member'}:name==='agent_teams_create_task'?{task_id:'t1'}:{}});
 }
 events.push({type:'assistant',sessionId:'member',content:[{type:'tool-call',name:'bash'}]},
  {at:3,type:'tool-result',sessionId:'member',name:'bash',arguments:{command:'curl https://fixture.invalid/teams-model'},value:{exitCode:0,stdout:{text:'synthetic'}}},
  {at:4,type:'tool-result',sessionId:'member',name:'src_http',arguments:{method:'DELETE',url:'https://fixture.invalid/teams-model-delete'},value:{pendingApprovalId:'pending',reason:'safety-material-required'}},
  {at:1,type:'tool-result',sessionId:'member',name:'agent_teams_claim_task',value:{task_id:'t1',attempt_id:'a1'}},
  {at:2,type:'tool-result',sessionId:'member',name:'agent_teams_update_task',arguments:{task_id:'t1',attempt_id:'a1',status:'in_progress'}},
  {at:5,type:'tool-result',sessionId:'member',name:'agent_teams_update_task',arguments:{task_id:'t1',attempt_id:'a1',status:'completed',output:'done'},isError:false},
  {at:6,type:'tool-result',sessionId:'captain',name:'bash',arguments:{command:'curl https://fixture.invalid/curl-normal'},value:{exitCode:0}});
 const report={exit:0,completion:{status:'completed',stopped:''},teamState:{tasks:[{id:'t1',status:'completed',attemptId:'a1',output:'done'}]},events,arrivals:['/read','/teams-model','/curl-normal'].map(path=>({method:'GET',path}))};
 assert.doesNotThrow(()=>verifyTeamsModel(report));
 assert.throws(()=>verifyTeamsModel({...report,teamState:{tasks:[{...report.teamState.tasks[0],status:'in_progress'}]}}),/durable task/);
 assert.throws(()=>verifyTeamsModel({...report,teamState:{tasks:[{...report.teamState.tasks[0],attemptId:'stale'}]}}));
 assert.throws(()=>verifyTeamsModel({...report,events:events.map(e=>e.at===5?{...e,at:0}:e)}),/Completion must follow/);
 assert.throws(()=>verifyTeamsModel({...report,events:events.map(e=>e.name==='agent_teams_create_task'?{...e,arguments:{description:'bash curl /teams-model'}}:e)}),/Captain omitted/);
 assert.throws(()=>verifyTeamsModel({...report,events:events.filter(e=>e.name!=='agent_teams_update_task')}));
 assert.throws(()=>verifyTeamsModel({...report,events:events.map(e=>e.sessionId==='member'?{...e,sessionId:'captain'}:e)}));
 assert.throws(()=>verifyTeamsModel({...report,events:events.map(e=>e.name==='src_http'?{...e,arguments:{method:'DELETE',url:'https://fixture.invalid/teams-model'}}:e)}));
 assert.throws(()=>verifyTeamsModel({...report,arrivals:[...report.arrivals,{method:'DELETE',path:'/teams-model-delete'}]}));
});

test('member claim receipt explains missing task contract without replacing native value or policy',async()=>{
 const {teamClaimDecision}=await import('../lib/src/egress/team-workflow.js');
 const exec={name:'agent_teams_claim_task',agent:{session:{header:{parentSession:'captain'}}}};
 const result={value:{task_id:'t1',attempt_id:'a1'},content:[{type:'text',text:'Native receipt'}]};
 const accepted={kind:'accept'},output=teamClaimDecision(exec,result,accepted);
 assert.deepEqual(output.content[0],result.content[0]);assert.match(output.content[1].text,/team.json/);
 assert.equal(Object.hasOwn(output,'value'),false);assert.equal(result.content.length,1);
 for(const decision of [{kind:'reject'}, {kind:'accept',value:{}},{kind:'accept',content:[]}])assert.equal(teamClaimDecision(exec,result,decision),decision);
 assert.equal(teamClaimDecision(exec,{...result,isError:true},accepted),accepted);
 assert.equal(teamClaimDecision({...exec,signal:AbortSignal.abort()},result,accepted),accepted);
 assert.equal(teamClaimDecision({...exec,agent:{session:{header:{}}}},result,accepted),accepted);
});

test('evaluation wire observation preserves requests and records no prompt, URL or credentials',async()=>{
 const {modelPayloadSummary,installModelWireObserver}=await import('../scripts/egress-feasibility/model-wire-observer.mjs');
 const body=JSON.stringify({secret:'provider-secret',messages:[{role:'assistant',tool_calls:[{id:'c1',function:{name:'bash'}}]},{role:'tool',tool_call_id:'c1',content:'private-token /teams-model /teams-model-delete'},{role:'user',content:'AgentTeams automatic task assignment Task: t1 /teams-model'}]});
 const summary=modelPayloadSummary(body);assert.equal(summary.messages[1].tool,'bash');assert.equal(summary.messages[1].containsFixtureTask,true);assert.equal(summary.messages[2].containsAssignment,true);
 assert.ok(!JSON.stringify(summary).includes('private-token'));assert.ok(!JSON.stringify(summary).includes('provider-secret'));assert.equal(modelPayloadSummary('{}'),null);
 const original=globalThis.fetch,seen=[];let got;
 const response=Promise.resolve(new Response('unchanged'));
 globalThis.fetch=(...args)=>{got=args;return response;};const base=globalThis.fetch;
 const restore=installModelWireObserver(row=>seen.push(row));
 try{const init={body,headers:{authorization:'private-token'}};assert.equal(globalThis.fetch('https://private.invalid',init),response);assert.equal(got[1],init);assert.equal(seen.length,1);}
 finally{restore();assert.equal(globalThis.fetch,base);globalThis.fetch=original;}
});
