// Invoked inside an actual agent/pre-step, never by spoofing driver identity.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function goalToolsProbe(ctx,agent,{child=false}={}){
 const calls=[];
 const call=async(name,args)=>{
  const result=await ctx.tools.execute({name,arguments:args,agent,signal:AbortSignal.timeout(10000),callId:randomUUID()});
  calls.push({name,args,result});return result;
 };
 const get=await call('get_goal',{});
 assert.ok(!get.isError,JSON.stringify(get));assert.equal(get.value.goal,null);
 const created=await call('create_goal',{objective:'Synthetic local goal lifecycle only; no target permission',max_goal_rounds:1});
 if(child){assert.equal(created.isError,true);assert.match(JSON.stringify(created),/DELEGATED_GOAL_MUTATION/);return calls;}
 assert.ok(!created.isError,JSON.stringify(created));
 let goal=created.value.goal;
 const stale=await call('update_goal',{goal_id:goal.id,revision:goal.revision+1,action:'pause'});
 assert.equal(stale.isError,true,JSON.stringify(stale));
 for(const action of ['edit','pause','resume','complete']){
  const result=await call('update_goal',{goal_id:goal.id,revision:goal.revision,action,...(action==='edit'?{objective:'Synthetic revised local goal only'}:{})});
  assert.ok(!result.isError,JSON.stringify(result));goal=result.value.goal;
  assert.equal(goal.phase,action==='edit'||action==='resume'?'active':action==='pause'?'paused':'complete');
 }
 const final=await call('get_goal',{});assert.equal(final.value.goal.phase,'complete');
 return calls;
}
