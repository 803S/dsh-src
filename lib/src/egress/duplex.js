import {currentEgressExecution} from './runtime.js';
import {gateError} from './plan.js';

// Host-only duplex seam; native file policy and final-spawn guard are mandatory.
// Async on purpose: the 0.2 confinement provider resolves argv from a promise
// (`ctx.sandbox.confine` became async), while 0.1 returned it synchronously.
// Awaiting a plain value keeps both dialects working; a synchronous read of the
// 0.2 promise yields `undefined` and the final-spawn guard then fails closed
// with SRC_GATE_UNKNOWN_EXECUTOR, which silently killed every capability probe
// and confined browser launch on 0.2 hosts.
export async function startGuardedTransport(request) {
    const execution=currentEgressExecution();
    if(!execution?.exec?.agent?.session)throw gateError('MISSING_EXECUTION_CONTEXT');
    if(execution.shellTaskId)throw gateError('TRANSPORT_SCAN_PLAN_FORBIDDEN');
    const sandboxPolicy=this.ctx.sandboxPolicy.resolve({session:execution.exec.agent.session});
    const spec=this.resolve({...request,sandboxPolicy});
    const argv=sandboxPolicy.mode==='danger-full-access'
      ? ['bash','-c',spec.command]
      : (await Promise.resolve(this.confine(spec.command,sandboxPolicy,spec.signal))).argv;
    const guarded=this.spawnSpec(spec,argv,spec.stdoutMaxBytes,spec.signal);
    // Only stdio changes. Preserve final-spawn OS constraints, scrubbed native
    // environment, cancellation and subprocess-owned process-tree cleanup.
    return this.ctx.subprocess.spawn({...guarded,stdio:{...guarded.stdio,stdin:'pipe',stdout:'pipe'}});
}
