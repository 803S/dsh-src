export async function surfaceToolProbe({call,ctx,agent,origin,log}){
 const before=ctx.srcEgress.assessments;
 const args={baseUrl:origin,paths:['/robots.txt','/favicon.ico'],concurrency:1,rps:2,timeoutMs:10000};
 let result=await call('src_scan_surface',args),approvalId;
 if(result.pendingApprovalId){
  approvalId=result.pendingApprovalId;
  const decision=await ctx.commands.execute(agent,`/src-approve ${approvalId} allow Confirm exact bounded fixture surface scan`,[],AbortSignal.timeout(15000));
  if(decision?.result.kind!=='success')throw new Error('Surface tool approval failed');
  const review=await ctx.commands.execute(agent,`/src-egress-review ${approvalId}`,[],AbortSignal.timeout(15000));
  if(review?.result.kind!=='success'||JSON.parse(review.result.text).state!=='active')throw new Error('Approved native plan is falsely displayed as stale');
  log({type:'native-surface-review-active',state:JSON.parse(review.result.text).state});
  result=await call('src_scan_surface',{...args,taskId:result.taskId});
  const completed=await ctx.commands.execute(agent,`/src-egress-review ${approvalId}`,[],AbortSignal.timeout(15000));
  const view=JSON.parse(completed.result.text);
  if(view.state!=='completed_tool'||view.used!==3||view.executable!==false||view.sendsRequest!==false)throw new Error('Completed native plan review is misleading');
  log({type:'native-surface-review-completed',state:view.state,used:view.used,sendsRequest:view.sendsRequest});
 }
 if(ctx.srcEgress.assessments-before!==1)throw new Error('Native scan resume performed a new assessment');
 log({type:'native-surface-result',approvalId:approvalId??null,assessments:1,result});
 if(result.responses!==2||result.pendingApprovalId||result.results.some(row=>row.status!==200))throw new Error('Native surface tool cannot execute approved scan '+JSON.stringify(result));
 // Match a pre-approved but unused optional UA branch exactly. It must now be
 // a new actual request with its own assessment, not spend the finished scan.
 const followup=await call('bash',{command:`curl --max-time 30 -sS -A 'curl/8.4.0' -H 'Accept: text/html,application/xhtml+xml' '${origin}/'`,description:'Ordinary read cannot inherit an unused native-scan branch'});
 if(followup.stdout?.text!=='synthetic'||ctx.srcEgress.assessments-before!==2)throw new Error('Finished scan budget leaked or ordinary read failed '+JSON.stringify(followup));
 log({type:'native-surface-unused-branch-retired',freshAssessments:1,output:followup.stdout.text});
}
