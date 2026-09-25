// Evaluation-only host plugin. Never deployed into production profiles.
import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
export const name = 'src-blind-eval';
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'tools'];
const ALLOWED = new Set(['src_add_goal','src_add_intent','src_update_intent','src_add_fact','src_add_asset','src_add_finding','src_update_finding','src_record_research','src_record_coverage','src_record_observation','src_state','src_get_evidence','src_graph','src_report','src_finalize_engagement','src_submit','src_recon','src_audit','src_verify','src_recover_child','src_http','src_user_todo','src_read_lesson','src_search_lessons','src_get_infra','src_list_capabilities','src_read_capability','report','structured_output','list_agents','send_message']);
export function evaluationDenial(name, args, origin) {
  if (!ALLOWED.has(name)) return `盲测隔离：${name} 不可用；仅允许SRC记录、委派和本地src_http。`;
  if (name === 'src_http') {
    try { if (new URL(args.url).origin !== origin) return '盲测隔离：只允许指定本地靶场origin'; }
    catch { return '需要完整本地HTTP URL'; }
  }
}
export function apply(ctx, config) {
  const log = (row) => appendFileSync(config.trace, JSON.stringify({ at: Date.now(), ...row }) + '\n');
  const agents = ctx.agents;
  let steps = 0, calls = 0, tokens = 0, stopped = '', finished = false;
  const stop = (reason) => {
    if (stopped) return;
    stopped = reason;
    log({ type: 'budget-stop', reason });
    for (const a of agents.list()) a.cancel(new Error(reason));
  };
  ctx.tools.guard((exec) => {
    if (stopped) return stopped;
    if (++calls > config.maxCalls) { stop('tool-call-budget'); return stopped; }
    return evaluationDenial(exec.name, exec.arguments, config.origin);
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
    if (event.type === 'turn/end') log({ type: 'turn-end', sessionId: String(subject?.id ?? subject), reason: event.data.reason });
  });
  const finish = async (status, error) => {
    if (finished) return;
    finished = true;
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
    agent.followup(createUserMessage({ content: [{ type: 'text', text: config.task }], source: { kind: 'user' } }));
    // Do not exit when commander first yields: background child completion can wake it again.
    let quiet = 0;
    while (!finished) {
      await new Promise((r) => setTimeout(r, 250));
      if (agents.list().some((a) => a.status === 'running')) quiet = 0; else quiet++;
      if (stopped || quiet >= 12) { await finish(stopped ? 'budget' : 'completed'); break; }
    }
  })().catch((error) => finish('error', error));
}
