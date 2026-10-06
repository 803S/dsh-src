import { AsyncLocalStorage } from 'node:async_hooks';
import { gateError } from './plan.js';

// Scoped to actual tool dispatch, not pre-execute: survives async operations and
// does not accidentally attach the next concurrent tool's identity to a request.
const dispatch = new AsyncLocalStorage();
export function withEgressExecution(value, next) { return dispatch.run(value, next); }
export function withEgressTask(taskId, next) {
  const context=dispatch.getStore();
  if(!context)throw gateError('MISSING_EXECUTION_CONTEXT');
  return dispatch.run({...context,taskId},next);
}
export function currentEgressExecution() { return dispatch.getStore(); }
export function targetTransport(direct, url, init) {
  const context = dispatch.getStore();
  if (!context) {init?.onSend?.();return direct(url, init);}
  if (!context.manager || !context.sessionId) throw gateError('MISSING_EXECUTION_CONTEXT');
  return context.manager.fetch(context.sessionId, url, init, {...context.exec,egressTaskId:context.taskId});
}
