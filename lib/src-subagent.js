// SRC adapter to the existing host subagent service. No scheduler or child runtime.
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'src-subagent';
export const inject = ['tools', 'subagents'];
export function effectiveParentRoute(parent) {
  const logged = parent?.session?.requestHeader?.()?.config;
  const route = logged ?? parent?.options ?? {};
  return Object.fromEntries(['provider', 'model', 'maxTokens', 'reasoningEffort'].filter((key) => route[key] !== undefined).map((key) => [key, route[key]]));
}
export function apply(ctx, config) {
  if (!['src_recon', 'src_audit', 'src_verify'].includes(config?.toolName) || !['spawn', 'fork'].includes(config?.provider)) throw new Error('SRC subagent adapter requires a configured SRC tool and spawn/fork provider');
  ctx.tools.register(defineTool({
    name: config.toolName,
    description: 'Delegate a bounded SRC intent through the host subagent service. Inherits the parent’s actual current model unless the preset explicitly specifies a child model. Background by default; the host sends completion/failure notices. Record the real intentId, scope, checks and checkpoint requirements.',
    parameters: {
      intentId: { type: 'string', required: true, description: 'Existing parent intent id from src_add_intent.' },
      description: { type: 'string', required: true, description: 'Short task label.' },
      prompt: { type: 'string', required: true, description: 'Bounded task, authorized scope, expected evidence and stop conditions. Child must submit checkpoints.' },
      run_in_background: { type: 'boolean', description: 'Defaults true. False waits for this result.' }
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: `${value.kind === 'continuable' ? 'Queued' : value.status === 'completed' ? 'Completed' : 'Failed'} child ${value.childSessionId} for ${value.intentId}; model=${value.model || 'provider-default'} (${value.modelSource}). Queue acceptance is not a checkpoint or successful recovery.${value.diagnostic ? '\nDiagnostic: ' + value.diagnostic : ''}${value.output ? '\n' + value.output.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : ''}` }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('SRC delegation requires a parent agent');
      const parent = exec.agent;
      let selected = effectiveParentRoute(parent);
      if (config.agentOptions?.model || config.agentOptions?.provider) { const { reasoningEffort: _inherited, ...base } = selected; selected = base; }
      const agentOptions = { ...selected, ...config.agentOptions };
      const request = { parent, label: args.description, prompt: [{ type: 'text', text: `父 intentId=${args.intentId}\n${args.prompt}\n完成首阶段立即 src_submit；无法开始提交 blocked/failed。` }], agentOptions, persona: config.persona, toolFilter: config.toolFilter, maxDepth: config.maxDepth ?? 1 };
      const route = { intentId: args.intentId, provider: agentOptions.provider ?? '', model: agentOptions.model ?? '', modelSource: config.agentOptions?.model ? 'explicit-child' : 'parent-effective' };
      if (args.run_in_background !== false) {
        const started = await ctx.subagents.startContinuable({ provider: config.provider, label: args.description, request, signal: exec.signal });
        return { ...route, kind: 'continuable', childSessionId: started.childId, subagentId: started.childId, messageId: started.messageId, status: 'queued' };
      }
      const run = await ctx.subagents.start(config.provider, { ...request, signal: exec.signal });
      try {
        const result = await run.result;
        return { ...route, kind: 'foreground', childSessionId: run.id, runId: run.id, status: result.stopReason, output: result.output, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) };
      } finally { await run.dispose(); }
    }
  }));
}
