import {createBurpRestorer} from './src/egress/burp-request.js';
import {browserLifecycle} from './src/egress/browser-lifecycle.js';
import {installDelegationGuard} from './src/egress/delegation.js';
import {createFofaLookup} from './src/egress/fofa.js';
import { createEgressManager, staleApprovalIds, staleApprovalTtl } from './src/egress/manager.js';
import { dispatchHttp, dispatchHttpViaProxy } from './src/egress/http-dispatch.js';
import { createEgressEvidenceRecorder } from './src/egress/evidence.js';
import { SrcStore, appendSessionToolEvent } from './src.js';
import { registerEgressCommands } from './src/egress/user-commands.js';
import { dshHomeOf } from './src/capability-loader.js';

export const name = 'src-egress';
export const inject = ['storageDomain','sessions'];
export function apply(ctx, config = {}) {
  const owned = new Set();
  /* [local.150] 每个会话每进程只做一次陈旧卡清扫（own() 每次工具调用都会进来）。 */
  const reapedSessions = new Set();
  /* 自动改状态要有可见的审计痕迹（这个 profile 里 ctx.logger 不一定存在，退回 console）。 */
  const reportReaped = (reaped) => { for (const {session,ids} of reaped ?? []) for (const line of [`src: 陈旧审批卡已过期 ${ids.join(',')}（会话 ${session}）`]) if (ctx.logger?.info) ctx.logger.info(line); else console.info(`[dsh-src] ${line}`); };
  const store = new SrcStore(ctx);
  // Start lazily so a standard non-SRC session incurs no proxy or ledger cost.
  let manager;
  const restoreBurp=createBurpRestorer(ctx,store);
  const service = {
    fofaLookup:createFofaLookup({home:dshHomeOf()}),
    own(session) {
      const id=String(session);owned.add(id);
      /* [local.150 用户拍板 2026-10-19] SRC 会话被接管时清扫本会话的陈旧人工卡（只改状态 + 撤销账本任务，
       * 从不自动发送）：GUI/网关重启后待办列表里不该留着过期未裁决的卡。每会话每进程只跑一次，
       * 失败只记日志、不阻断工具执行。 */
      if(reapedSessions.has(id))return;
      reapedSessions.add(id);
      void (async()=>{try{const ids=await (await service.ready()).expireStaleApprovals(id);if(ids.length)reportReaped([{session:id,ids}]);}catch{}})();
    },
    owns(session) { return owned.has(String(session)); },
    ready() {
      manager ??= createEgressManager({restoreBurp,lifecycle:store.domain().then(browserLifecycle),home:dshHomeOf(),storeFor:async()=>store,directFetch:dispatchHttp,proxyFetch:dispatchHttpViaProxy,proxyExecutable:config.proxyExecutable,recordEvidence:createEgressEvidenceRecorder({home:dshHomeOf(),store,append:(session,row)=>{const live=ctx.get('sessions')?.get(session);if(live)appendSessionToolEvent(live,'src_record_observation',row);}}),appendApproval:(session,row)=>{const live=ctx.get('sessions')?.get(session);if(live)appendSessionToolEvent(live,'src_record_pending_approval',row);}});
      return manager;
    },
  };
  ctx.provide('srcEgress',service);
  /* [local.150 用户拍板 2026-10-19] 进程启动即收掉陈旧人工卡（超过 TTL 未裁决）：待办列表里只该留
   * 「永远不能发出去的」或「必须人工测试的」现存条目，而不是挂了一整夜的旧卡。
   * 先只读问「有没有陈旧卡」，没有就完全不动出口账本/代理（保持本插件的惰性）；有才起 manager，
   * 由它统一改状态 + 撤销 ledger 任务 —— 从不自动发送，失败只记日志、不阻断启动。 */
  void (async()=>{try{
    const rows=await store.allTaskApprovals?.();
    if(!staleApprovalIds(rows,{ttl:staleApprovalTtl()}).length)return;
    reportReaped(await (await service.ready()).reapStaleApprovals());
  }catch{}})();

  ctx.inject(['subagents'],childCtx=>installDelegationGuard(childCtx,service));
  ctx.inject(['commands'],commandCtx=>registerEgressCommands(commandCtx,service));
  ctx.effect(()=>async()=>{
    if(manager)await (await manager).close();
    await store.dispose();
  },'src.egressClose');
}
