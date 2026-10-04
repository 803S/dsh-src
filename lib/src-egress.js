import { createEgressManager } from './src/egress/manager.js';
import { dispatchHttp } from './src/egress/http-dispatch.js';
import { createEgressEvidenceRecorder } from './src/egress/evidence.js';
import { SrcStore, appendSessionToolEvent } from './src.js';
import { registerEgressCommands } from './src/egress/user-commands.js';
import { dshHomeOf } from './src/capability-loader.js';

export const name = 'src-egress';
export const inject = ['storageDomain'];
export function apply(ctx, config = {}) {
  const owned = new Set();
  const store = new SrcStore(ctx);
  // Start lazily so a standard non-SRC session incurs no proxy or ledger cost.
  let manager;
  const service = {
    own(session) { owned.add(String(session)); },
    owns(session) { return owned.has(String(session)); },
    ready() {
      manager ??= createEgressManager({home:dshHomeOf(),storeFor:async()=>store,directFetch:dispatchHttp,proxyExecutable:config.proxyExecutable,recordEvidence:createEgressEvidenceRecorder({home:dshHomeOf(),store,append:(session,row)=>{const live=ctx.get('sessions')?.get(session);if(live)appendSessionToolEvent(live,'src_record_observation',row);}})});
      return manager;
    },
  };
  ctx.provide('srcEgress',service);
  ctx.inject(['commands'],commandCtx=>registerEgressCommands(commandCtx,service));
  ctx.effect(()=>async()=>{
    if(manager)await (await manager).close();
    await store.dispose();
  },'src.egressClose');
}
