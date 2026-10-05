import {currentEgressExecution} from './runtime.js';
import {gateError} from './plan.js';

// Host-only duplex seam; native file policy and final-spawn guard are mandatory.
export function startGuardedTransport(request) {
    const execution=currentEgressExecution();
    if(!execution?.exec?.agent?.session)throw gateError('MISSING_EXECUTION_CONTEXT');
    if(execution.shellTaskId)throw gateError('TRANSPORT_SCAN_PLAN_FORBIDDEN');
    const sandboxPolicy=this.ctx.sandboxPolicy.resolve({session:execution.exec.agent.session});
    const spec=this.resolve({...request,sandboxPolicy});
    const argv=sandboxPolicy.mode==='danger-full-access'
      ? ['bash','-c',spec.command]
      : this.confine(spec.command,sandboxPolicy).argv;
    const guarded=this.spawnSpec(spec,argv,spec.stdoutMaxBytes,spec.signal);
    // Only stdio changes. Preserve final-spawn OS constraints, scrubbed native
    // environment, cancellation and subprocess-owned process-tree cleanup.
    return this.ctx.subprocess.spawn({...guarded,stdio:{...guarded.stdio,stdin:'pipe',stdout:'pipe'}});
}
