// Evaluation-only host plugin. Never deployed into production profiles.
import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { networkConstrained } from './network-probe.mjs';
import { constrainSpawnSpec } from '../../lib/src/egress/executor.js';
import { wrapEgressArgv } from './extended-probe.mjs';
export const name = 'src-egress-feasibility';
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'tools', 'sandbox', 'shell'];
export function apply(ctx, config) {
  const log = (row) => appendFileSync(config.trace, JSON.stringify({ at: Date.now(), ...row }) + '\n');
  if(config.spawnGuard) {
    const originalSpawnSpec=ctx.shell.spawnSpec.bind(ctx.shell);
    ctx.shell.spawnSpec=(spec,argv,...rest)=>{
      const result=originalSpawnSpec(spec,argv,...rest);
      const guarded=config.taskGate?constrainSpawnSpec(result,{proxyPort:config.proxyPort,protectedPaths:config.protectedPaths}).argv:wrapEgressArgv(result.argv,config.proxyPort,config.protectedPaths??[]);
      log({type:'actual-confine',mode:spec.sandboxPolicy?.mode,argv,runner:guarded[0],seam:'shell.spawnSpec'});
      return {...result,argv:guarded};
    };
  } else {
    const nativeConfine = ctx.sandbox.confine.bind(ctx.sandbox);
    if (ctx.shell.sandboxMode !== 'workspace-write') throw new Error('Probe requires actual workspace-write shell');
    ctx.sandbox.confine = (argv, policy) => {
      const wrapped = networkConstrained(nativeConfine(argv, policy), config.proxyPort);
      log({type:'actual-confine', sessionId:policy.sessionId, mode:policy.mode, argv:argv, runner:wrapped.argv[0]});
      return wrapped;
    };
  }
  const agents = ctx.agents;
  let steps = 0, calls = 0, tokens = 0, stopped = '', finished = false, turnError;
  const stop = (reason) => {
    if (stopped) return;
    stopped = reason;
    log({ type: 'budget-stop', reason });
    for (const a of agents.list()) a.cancel(new Error(reason));
  };
  ctx.tools.guard((exec) => {
    if (stopped) return stopped;
    if (++calls > config.maxCalls) { stop('tool-call-budget'); return stopped; }
    // This allowlist does not inspect commands or block target connections.
    // The network rule on the real DSH execution path must do that.
    if (exec.name !== 'bash') return 'This bounded feasibility session only measures the real bash tool.';
    if (exec.arguments?.sandbox_permissions) return 'Escalation is outside this workspace-write probe; not validated.';
  });
  ctx.on('agent/pre-step', async (_event, next) => {
    if (stopped || steps >= config.maxSteps || tokens >= config.maxTokens) { stop(stopped || (tokens >= config.maxTokens ? 'token-budget' : 'step-budget')); return { kind: 'reject' }; }
    steps++;
    return next();
  });
  ctx.on('tools/result', (exec, result) => log({ type: 'tool-result', sessionId: exec.agent?.session.id, name: exec.name, arguments: exec.arguments, isError: result.isError, text: result.content.map((c) => c.text ?? '').join('\n'), value: result.value ?? null }));
  ctx.on('session/event', (subject, event) => {
    if (event.type === 'assistant/message') {
      const usage = event.data.usage ?? {};
      tokens += Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0);
      log({ type: 'assistant', sessionId: String(subject?.id ?? subject), usage, content: event.data.message.content });
    }
    if (event.type === 'turn/end' && event.data.reason?.kind === 'error') turnError = event.data.reason.error?.message ?? 'DSH turn error';
    if (event.type === 'turn/end') log({ type: 'turn-end', sessionId: String(subject?.id ?? subject), reason: event.data.reason });
  });
  const finish = async (status, error) => {
    if (finished) return;
    finished = true;
    if (turnError) { status = 'error'; error = new Error(turnError); }
    clearTimeout(timer);
    const live = agents.list();
    for (const a of live) { if (a.status === 'running') a.cancel(new Error('evaluation finished')); }
    await Promise.all(live.map(async (a) => { await a.whenIdle(); await ctx.sessions.flush(a.session); }));
    writeFileSync(config.result, JSON.stringify({ status, stopped, steps, calls, tokens, model: ctx.agentDefaultModel.currentSelection(), sessions: live.map((a) => a.session.id), ...(error ? { error: String(error.message ?? error) } : {}) }, null, 2));
    ctx.get('appExit')(status === 'completed' ? 0 : 2);
  };
  const timer = setTimeout(() => { stop('wall-clock-budget'); finish('budget'); }, config.maxSeconds * 1000);
  (async () => {
    await ctx.get('loader')?.await();
    const [{ installModelSelection }, { createUserMessage }, { SessionId }] = await Promise.all(['dsh-agent','dsh-llm','dsh-session'].map((p) => import(`${config.aiRoot}/${p}/lib/index.js`)));
    const selection = ctx.agentDefaultModel.currentSelection();
    const { agent } = await agents.create({ sessionId: SessionId(`session-${randomUUID()}`), meta: { cwd: process.cwd() }, agentOptions: { provider: selection.provider, model: selection.model, maxTokens: 1800 }, setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'src-hunter');
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    } });
    // Fixture-only configured mode, not a forged user approval or production change.
    if(config.fileMode)agent.session.append('sandbox/mode',{mode:config.fileMode});
    if(config.directToolProbe) {
      for(const command of config.task.split('\n').filter(line=>/^\d+\. /.test(line)).map(line=>line.replace(/^\d+\. /,''))) {
        const result=await ctx.tools.execute({callId:`probe-${randomUUID()}`,name:'bash',arguments:{command,description:'Deterministic real ToolRuntime feasibility probe'},agent,signal:AbortSignal.timeout(15000)});
        log({type:'deterministic-dispatch',isError:result.isError});
      }
      await finish('completed');
      return;
    }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: config.task }], source: { kind: 'user' } }));
    // Do not exit when commander first yields: background child completion can wake it again.
    let quiet = 0;
    while (!finished) {
      await new Promise((r) => setTimeout(r, 250));
      if (agents.list().some((a) => a.status === 'running')) quiet = 0; else quiet++;
      if (stopped || quiet >= 12) { await finish(stopped ? 'budget' : steps === 0 ? 'error' : 'completed'); break; }
    }
  })().catch((error) => finish('error', error));
}
