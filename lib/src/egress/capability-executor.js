import { currentEgressExecution, withEgressExecution } from './runtime.js';
import { gateError } from './plan.js';
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export async function runConfinedCapability(command,args,cwd,env,timeoutMs) {
  const context=currentEgressExecution();if(!context)throw gateError('MISSING_EXECUTION_CONTEXT');
  const proxy=context.proxy??await context.manager.sessionProxy(context.sessionId);
  const policy=context.ctx.get('sandboxPolicy').resolve({session:context.exec.agent.session});
  return withEgressExecution({...context,proxy},async()=>{
    const spec=context.ctx.shell.resolve({command:[command,...args].map(quote).join(' '),workdir:cwd,env,timeoutMs,signal:context.exec.signal,sandboxPolicy:policy});
    const result=await context.ctx.shell.run(spec);
    return {exitCode:result.exitCode??-1,output:((result.stdout?.text??'')+(result.stderr?.text?'\n[stderr]\n'+result.stderr.text:'')).slice(0,12000)};
  });
}
export async function readConfinedCapability(filename) {
  const context=currentEgressExecution();if(!context)throw gateError('MISSING_EXECUTION_CONTEXT');
  const proxy={denyNetwork:true,alive:()=>true,protectedPaths:[],readOnlyPaths:[]};
  const result=await withEgressExecution({...context,proxy},()=>runConfinedCapability('/usr/bin/head',['-c','12000',filename],undefined,undefined,10000));
  if(result.exitCode!==0)throw gateError('CAPABILITY_DOCUMENT_DENIED');
  return result.output;
}
