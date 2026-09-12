# 优化实施基线记录（2026-09-12）

对应 [优化实现手册](optimization-implementation-handbook-2026-09-12.md) Phase 0。
本文件是改动前的可验证基线：任何阶段完成后，下表数字应可复现或可解释差异。

## 命令基线（2026-09-12，local.69 @ e4d5082）

- `npm test`：**168/168 通过**（约 23s）。
- `node scripts/check-preset-consistency.mjs`：通过；工具级 description 合计 **13,106**（≤15,000），
  协议（SRC_INSTRUCTIONS）**7,929**（≤8,000），内置 lessons 合计 **14,081**（≤20,000）。

## 特性开关默认值（lib/src/flags.js，全部惰性求值）

| 开关 | 默认 | 取值 | 说明 |
|---|---|---|---|
| `DSH_SRC_TELEMETRY` | `shadow` | off/shadow/on | 只写独立 JSONL sink，永不进 prompt/工具返回 |
| `DSH_SRC_STATE_VERSION` | `1` | 1/2 | 1=legacy 输出（现状）；2=v2 决策视图 |
| `DSH_SRC_ORCHESTRATOR` | `off` | off/shadow/on | 本轮仅 shadow（纯函数建议）；on 未实施 |
| `DSH_SRC_ROUTE_V2` | `off` | off/shadow/on | off=substring 召回；shadow=仅记录候选；on=v2 接管选择 |

非法值一律回落默认；关闭全部开关时行为与 local.69 完全一致。

## 只读备份（用户数据）

位置 `~/.dsh/backups/src-optimization-baseline-2026-09-12/`：

- `src-lessons.tar.gz`（用户沉淀 lessons，26KB）
- `capabilities.yaml`（2,656B）
- `src.json`（durable store 快照副本，76KB；原件 sha256 前 16 位 `ee0df06915c241cd`）

代码回滚不依赖该备份（git 逐 phase revert）；备份仅覆盖 `~/.dsh` 下的用户数据。

## 回滚方式

- 每个 Phase 独立中文 commit，`git revert <commit>` 即完整回滚该阶段。
- 行为开关回滚：设对应 env 为默认值即可，无需回代码。
- 新增 lib/src 子模块全部已登记 `scripts/deploy.mjs` files 清单（local.67 事故纪律）。

## 明确不做 / 阻塞项（与手册的差异）

1. orchestrator **on 模式**（持久 job 队列 + lease 调度 + 自动恢复）：preset 无 host 级后台 tick
   钩子，调度循环无宿主入口；需 dsh host 提供生命周期回调后另立项目。
2. telemetry 的 model/promptTokens 字段：工具 exec 无该上下文，字段保留但为空；
   token 分享率需 host 支持后才能计算。
3. 顺丰会话 replay fixture：仅限离线回放（结构化字段），独立任务，不阻塞各 Phase。
4. 投影（applySrcEvent/wire schema）模块拆分：fold 关键路径机械搬家零行为收益，本轮不做。
5. evidence_links / route_candidates 持久表：shadow 阶段以 telemetry 事件承载，存表推迟到 on 灰度。
