// Shared route overrides for explicitly requested SRC recovery. Process-local;
// next request is durably logged by the host, and that logged route survives resume.
import { effectiveParentRoute } from '../src-subagent.js';
const overrides = new Map();
export function setRecoveryRoute(childId, parent) {
  const route = effectiveParentRoute(parent);
  if (!route.provider || !route.model) throw new Error('父会话没有可用的实际模型配置，不能继承');
  const previous = overrides.get(childId);
  overrides.set(childId, { parentId: parent.session.id, route });
  return { route, undo: () => { if (previous) overrides.set(childId, previous); else overrides.delete(childId); } };
}
export function routeForChild(agent) {
  const override = overrides.get(agent.session.id);
  return override && override.parentId === agent.session.header?.parentSession ? override.route : undefined;
}
export function resetChildRoutesForTests() { overrides.clear(); }
export function installChildRouting(ctx, telemetry) {
  if (typeof ctx.on !== 'function') return;
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next();
    const override = routeForChild(agent);
    const { reasoningEffort: _oldEffort, ...base } = config;
    const result = override ? { ...base, ...override } : config;
    if (agent.session.header?.parentSession) telemetry.emit('child.model-request', { sessionId: agent.session.id, engagementId: agent.session.header.parentSession }, { provider: result.provider ?? '', model: result.model ?? '', source: override ? 'explicit-recovery-parent' : 'host' });
    return result;
  });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    const agent = context?.agent;
    const route = agent ? routeForChild(agent) : undefined;
    return route ? { ...assembled, variables: { ...assembled.variables, provider: route.provider, model: route.model } } : assembled;
  });
  ctx.on('agent/request-error', async ({ agent, failure }, next) => {
    if (agent.session.header?.parentSession) telemetry.emit('child.request-error', { sessionId: agent.session.id, engagementId: agent.session.header.parentSession }, { code: String(failure?.code ?? failure?.kind ?? 'unknown'), status: failure?.status ?? failure?.statusCode ?? 0 });
    return next(); // observe only; never retry or replace host recovery
  });
}
