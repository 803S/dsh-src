// 宿主会话日志的唯一读取入口。
// 0.2 移除了 `Session.events` 读取器（改为 `snapshotEvents()/ownEvents()/eventAt()`），
// 而三处读取——谁签发了用户命令、人类原文声明了什么目标、子代理上一回合怎么结束——
// 在两条运行时上必须看到同一份日志，否则会静默降级：
//   · 用户命令守卫读不到日志 → 所有人工审批/范围命令恒失败（现场：审批点不动）；
//   · 人类目标派生读不到日志 → 用户自己写下的目标不再成为范围（现场：该放的被卡住）；
//   · 子代理失败探测读不到日志 → 失败回合显示为「未观测到失败」。
// 读不到日志一律返回空数组：守卫因此 fail-closed 拒绝，范围派生因此不授予任何目标，
// 失败探测因此退回未观测——任何一条都不会放宽安全结论。
export function sessionLogEvents(session) {
  if (session === null || typeof session !== 'object') return [];
  // 0.1（rc.8 及更早）：唯一入口，且是复用同一份冻结快照的读取器。
  if (Array.isArray(session.events)) return session.events;
  // 0.2：snapshotEvents 与 0.1 的 events 语义一致（全量、冻结、复用快照）；
  // ownEvents 只含本会话自有事件，仅在前者缺失时兜底。
  for (const read of ['snapshotEvents', 'ownEvents']) {
    if (typeof session[read] !== 'function') continue;
    try {
      const events = session[read]();
      if (Array.isArray(events)) return events;
    } catch {
      /* 宿主读取接口抛错：继续试下一个读取器；全部失败按空日志处理（调用方 fail-closed）。 */
    }
  }
  return [];
}
