// Test-only: prove an old background descendant cannot acquire a later command's
// unplanned proxy. All requests are to the runner-owned loopback fixture.
export async function shellChildProbe({call,manager,agent,ctx,origin,log}){
 const normal=await manager.sessionProxy(agent.session.id);
 const before=ctx.srcEgress.assessments;
 const plan=await call('src_egress_plan',{entries:['/child/a','/child/b'].map(path=>({request:{url:origin+path,method:'GET',headers:[['user-agent','child-scan/1'],['accept','*/*']],bodyBase64:''},maxRequests:1})),maxRequests:2,minIntervalMs:250,lifetimeMs:300000,purpose:'Two exact local-fixture GETs, second issued by a background child'});
 if(plan.state==='pending'){
  const decision=await ctx.commands.execute(agent,`/src-approve ${plan.approvalId} allow Confirm the exact two fixture requests`,[],AbortSignal.timeout(15000));
  if(decision?.result.kind!=='success')throw new Error('Child plan approval failed');
 }else if(plan.state!=='active')throw new Error('Unexpected child plan state');
 const parent=await call('bash',{description:'Start bounded plan child; preserve old OS network confinement',command:`curl --max-time 20 -sS -A child-scan/1 '${origin}/child/a'; (
 for i in $(seq 1 150); do test -f child-probe.ready && break; sleep 0.1; done
 curl --max-time 3 -sS -A child-scan/1 '${origin}/child/outside'; printf '\\n'
 curl --max-time 3 -sS --proxy '${normal.url}' --cacert '${normal.publicCA}' '${origin}/child/escape'; printf 'new-exit=%s\\n' "$?"
 curl --max-time 20 -sS -A child-scan/1 '${origin}/child/b'; printf '\\n'
 touch child-probe.done
 ) > child-probe.out 2>child-probe.err &`});
 if(parent.stdout?.text!=='synthetic')throw new Error('Parent planned read failed');
 const followup=await call('bash',{description:'Independent read while original scan child is still alive',command:`curl --max-time 20 -sS '${origin}/robots.txt?phase=child'; touch child-probe.ready`});
 if(followup.stdout?.text!=='synthetic')throw new Error('Independent child-era read failed');
 const collected=await call('bash',{description:'Collect bounded background fixture result',command:'for i in $(seq 1 200); do test -f child-probe.done && break; sleep 0.1; done; test -f child-probe.done && cat child-probe.out'});
 const output=collected.stdout?.text??'';
 if(output!=='SRC_GATE_BLOCKED_NOT_SENT\nnew-exit=7\nsynthetic\n')throw new Error('Child confinement or remaining budget regression '+JSON.stringify(collected));
 // One whole-plan assessment plus one independent normal read; neither escape
 // attempt nor the second planned request may get a new model decision.
 if(ctx.srcEgress.assessments-before!==2)throw new Error('Unexpected child reassessment');
 // Only the reusable ordinary-read worker may remain after both finite plans.
 const deadline=Date.now()+5000;
 while(manager.user.status().activeWorkerSlots>1&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
 const workers=manager.user.status();
 if(workers.activeWorkerSlots!==1)throw new Error('Completed child plan retained a worker slot '+JSON.stringify(workers));
 log({type:'shell-child-isolation',output,assessments:2,planId:plan.id,workers});
}
