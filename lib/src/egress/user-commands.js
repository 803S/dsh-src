import { currentEgressExecution } from './runtime.js';
import { gateError } from './plan.js';

// DSH rc.8 does not put source on invocation. Verify its actual command/run
// event, instead of treating an absent source as either approval or rejection.
export function assertUserCommand(invocation, name) {
  if(currentEgressExecution())throw gateError('MODEL_CANNOT_APPROVE');
  const event=invocation.agent?.session?.events?.find(event=>event.type==='command/run'
    && event.data?.commandId===invocation.commandId && event.data?.name===name);
  if(!event||event.data.source?.kind!=='user')throw gateError('USER_COMMAND_REQUIRED');
  invocation.signal?.throwIfAborted();
}
export function registerEgressCommands(ctx, service) {
  ctx.commands.register({name:'src-egress-status',description:'只读查看目标出口范围及代理状态，不发目标请求。',recordInput:false,handler:async invocation=>{
    assertUserCommand(invocation,'src-egress-status');
    const manager=await service.ready();
    return {kind:'success',text:JSON.stringify({scope:manager.user.getScope(invocation.agent.session.id)??null,proxy:manager.user.status()})};
  }});
  ctx.commands.register({name:'src-egress-scope',description:'用户确认目标出口的精确 origins；替换范围并撤销旧授权版本。',recordInput:false,input:{hint:'["https://example.com"]'},handler:async invocation=>{
    assertUserCommand(invocation,'src-egress-scope');
    const origins=JSON.parse(invocation.rawInput);
    const manager=await service.ready();
    const scope=await manager.user.setScope(invocation.agent.session.id,origins);
    return {kind:'success',text:`目标出口范围已确认：${scope.origins.join(', ')}。旧任务授权已失效。`};
  }});
  ctx.commands.register({name:'src-egress-review',description:'查看任务审批的精确范围和请求摘要，不发请求。',recordInput:false,input:{hint:'approval-N'},handler:async invocation=>{
    assertUserCommand(invocation,'src-egress-review');
    const manager=await service.ready();
    const row=await manager.user.inspect(invocation.agent.session.id,invocation.rawInput.trim());
    // UI plan inspection is sanitized in manager before it leaves the host.
    return {kind:'success',text:JSON.stringify(row)};
  }});
  ctx.commands.register({name:'src-egress-reconcile',description:'用户核对不确定/拒绝/过期请求；只解除旧锁，不发送，后续仍须重新人工审批。',recordInput:false,input:{hint:'<approval-N> <cancel-never-sent|confirmed-not-applied|confirmed-applied|withdraw-rejection> <至少20字核对依据>'},handler:async invocation=>{
    assertUserCommand(invocation,'src-egress-reconcile');
    const [approvalId,disposition,...note]=invocation.rawInput.trim().split(/\s+/);
    const manager=await service.ready();
    return {kind:'success',text:JSON.stringify(await manager.user.reconcile(invocation.agent.session.id,approvalId,disposition,note.join(' ')))};
  }});

}
