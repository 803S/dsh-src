// Versioned final-spawn provider. Original bash remains the exposed tool.
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import { currentEgressExecution } from './src/egress/runtime.js';
import { constrainSpawnSpec } from './src/egress/executor.js';
import { gateError } from './src/egress/plan.js';
export default class SrcBashExecutor extends SandboxBashExecutor {
  get srcEgressPolicyVersion(){return 1;}
  static inject = [...SandboxBashExecutor.inject,'srcEgress'];
  spawnSpec(spec,argv,...rest) {
    const result=super.spawnSpec(spec,argv,...rest);
    const execution=currentEgressExecution();
    const owner=spec.sandboxPolicy?.sessionId;
    if(!execution){
      if(owner&&this.ctx.srcEgress.owns(owner))throw gateError('MISSING_EXECUTION_CONTEXT');
      return result;
    }
    if(owner&&owner!==execution.exec.agent.session.id)throw gateError('EXECUTION_IDENTITY_MISMATCH');
    const proxy=execution.proxy;
    if(!proxy?.alive())throw gateError('PROXY_UNAVAILABLE');
    const protectedPaths=[...proxy.protectedPaths,...(execution.protectedPaths??[])];
    const guarded=constrainSpawnSpec(result,{proxyPort:proxy.port,denyNetwork:proxy.denyNetwork===true,protectedPaths,readablePaths:execution.readablePaths,readOnlyPaths:[...(proxy.readOnlyPaths??[]),...(execution.readOnlyPaths??[])]});
    if(proxy.denyNetwork)return guarded;
    // Convenience, not the security boundary: removing these variables still
    // leaves the OS-level final-spawn network denial in force.
    return {...guarded,env:{...guarded.env,HTTP_PROXY:proxy.url,HTTPS_PROXY:proxy.url,http_proxy:proxy.url,https_proxy:proxy.url,
      ALL_PROXY:proxy.url,all_proxy:proxy.url,NO_PROXY:'',no_proxy:'',SSL_CERT_FILE:proxy.publicCA,REQUESTS_CA_BUNDLE:proxy.publicCA,CURL_CA_BUNDLE:proxy.publicCA,NODE_EXTRA_CA_CERTS:proxy.publicCA}};
  }
}
