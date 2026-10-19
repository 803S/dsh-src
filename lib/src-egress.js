import {createBurpRestorer} from './src/egress/burp-request.js';
import {browserLifecycle} from './src/egress/browser-lifecycle.js';
import {installDelegationGuard} from './src/egress/delegation.js';
import {createFofaLookup} from './src/egress/fofa.js';
import { createEgressManager } from './src/egress/manager.js';
import { dispatchHttp, dispatchHttpViaProxy } from './src/egress/http-dispatch.js';
import { createEgressEvidenceRecorder } from './src/egress/evidence.js';
import { SrcStore, appendSessionToolEvent } from './src.js';
import { registerEgressCommands } from './src/egress/user-commands.js';
import { dshHomeOf } from './src/capability-loader.js';

export const name = 'src-egress';
export const inject = ['storageDomain','sessions'];
export function apply(ctx, config = {}) {
  const owned = new Set();
  const store = new SrcStore(ctx);
  // Start lazily so a standard non-SRC session incurs no proxy or ledger cost.
  let manager;
  const restoreBurp=createBurpRestorer(ctx,store);
  const service = {
    fofaLookup:createFofaLookup({home:dshHomeOf()}),
    own(session) { owned.add(String(session)); },
    owns(session) { return owned.has(String(session)); },
    ready() {
      manager ??= createEgressManager({restoreBurp,lifecycle:store.domain().then(browserLifecycle),home:dshHomeOf(),storeFor:async()=>store,directFetch:dispatchHttp,proxyFetch:dispatchHttpViaProxy,proxyExecutable:config.proxyExecutable,recordEvidence:createEgressEvidenceRecorder({home:dshHomeOf(),store,append:(session,row)=>{const live=ctx.get('sessions')?.get(session);if(live)appendSessionToolEvent(live,'src_record_observation',row);}}),appendApproval:(session,row)=>{const live=ctx.get('sessions')?.get(session);if(live)appendSessionToolEvent(live,'src_record_pending_approval',row);}});
      /* [local.150 用户拍板 2026-10-19] 陈旧人工卡（超过 TTL 未裁决）在进程启动时收掉：
       * 待办列表里只该留「永远不能发出去的」或「必须人工测试的」现存条目，而不是挂了一整夜的旧卡。
       * 清扫只改状态 + 撤销 ledger 任务，从不自动发送；失败只记日志、不阻断启动。 */
      manager.then(instance=>instance.reapStaleApprovals?.().then(reaped=>{for(const {session,ids} of reaped)ctx.logger?.info?.(`src: 陈旧审批卡已过期 ${ids.join(',')}（会话 ${session}）`);}).catch(()=>{})).catch(()=>{});
      return manager;
    },
  };
  ctx.provide('srcEgress',service);
  ctx.inject(['subagents'],childCtx=>installDelegationGuard(childCtx,service));
  ctx.inject(['commands'],commandCtx=>registerEgressCommands(commandCtx,service));
  ctx.effect(()=>async()=>{
    if(manager)await (await manager).close();
    await store.dispose();
  },'src.egressClose');
}
