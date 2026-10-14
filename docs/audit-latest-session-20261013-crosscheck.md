# 复核会话跨表核对（只读）— GreenCMS `session-0ecc2ae7`

对应 `docs/audit-latest-session-20261013.md`「最小任务」第 3、4 项。

- 性质：**只读**。未重放请求、未批准审批、未修改会话/域数据/目标。
- 数据源：`~/.dsh/storages/src-sessions.db`（`u_src_findings` / `u_src_research` / `u_src_facts` / `u_src_observations` / `u_src_pending_approvals` / `u_src_user_todos`）、`~/.dsh/sessions/--Users-lihua-dis-Software-Src-Pedestal-src-domain-ready--/1055d44b-…/session.jsonl.zstd`、`~/.dsh/storages/src-telemetry/src-telemetry-2026-*.jsonl`。
- 域会话：`session-0ecc2ae7-affc-44e3-82cb-69a1370385a8`（主会话 `1055d44b-c5bd-499e-a5c7-53e1a4725f55` 的 SRC 域投影）。

## 1. 最小任务③：findings ↔ research/evidence 核对

### 1.1 矩阵

| finding | 状态 | 级别 | intent | 关联 research（带 findingId） | 引用证据 | 证据是否存在 | 问题 |
|---|---|---|---|---|---|---|---|
| finding-1 ThinkPHP 调试模式泄露路径/堆栈 | **rejected** | medium | intent-1 | 无 | `observation-199` | ✅ 存在 | 与 finding-4 同一方向；打回 `reviewNote` **为空**，看不出打回原因 |
| finding-2 `.git/config` + `/api` 调试页 | **rejected** | low | intent-2 | 无 | `observation-43`、`observation-53` | ✅ 存在 | 与 finding-3 同一方向；打回无备注 |
| finding-3 `.git` 完整暴露（文件树/版本区间/运维信息） | active | low | intent-5 | research-21（info-leak）、research-25（insecure-scm） | `fact-24..27`、`observation-148/152/154/256` | ✅ 全部存在 | 同一 finding 有 2 条 findingId 研究行（重复）；`description` 为空只填 `impact`；与 finding-2 方向重复且级别一致（都是 low） |
| finding-4 ThinkPHP 异常页泄露绝对路径/源码行号/调用栈 | active | low | intent-5 | research-22（info-leak）、research-26（information-disclosure） | `observation-189/203/331/339` | ✅ 全部存在 | 与 finding-1（medium，已打回）方向重复且**级别矛盾**（1 条 medium 打回 vs 1 条 low 在用）；同样 2 条重复研究行 |
| finding-5 静态/运维文件未授权暴露 | active | low | intent-5 | research-23（info-leak） | `observation-258/444/446` | ✅ 全部存在 | 复核子代理明确**本轮未逐项重发**；不得写成「独立复核完成」 |
| finding-6 前台搜索参数反射型 XSS | active | medium | intent-5 | research-20、research-24、research-27（均 xss，3 条重复） | `observation-347` | ✅ 存在 | 证据性质是「原始 HTML + Node vm 等效执行性」，不是真实浏览器事件；3 条重复研究行 |

无孤证：**所有被 finding 引用的 fact/observation id 都真实存在**，没有悬空引用（这点是好的，属于数据一致性通过项）。

### 1.2 结论（建议，供人审，不在本轮改数据）

1. **finding-3 级别**：复核子代理建议「medium → low」，当前库内已经是 `low`，故**无需再降**；但必须同时记录定级依据：`.git` 对象库下载返回伪 404，**源码全文不可恢复**，危害止于元数据/目录结构。主 finding 与报告不得保留互相矛盾的描述（“完整源码泄露” vs “对象不可下载”）。
2. **finding-4 / finding-1 重复与矛盾**：同一方向（ThinkPHP 调试模式信息泄露）现存 1 条 `rejected(medium)` + 1 条 `active(low)`。应**合并为一条**并统一级别（建议 low，理由同 finding-3：仅信息泄露、无损失实证），或明确写“rejected 为早期重复提交”。当前状态会让面板同时展示两条互相矛盾的记录。
3. **finding-5**：报告与面板必须标注「本轮未独立复核，沿用既有证据」。
4. **finding-6**：证据描述改为「原始 HTML 解析 + Node vm 执行的**等效执行性证据**」，不得写成 Playwright/浏览器实测。
5. **打回无备注是流程缺口**：finding-1/finding-2 的 `reviewNote` 为空 → 用户看不到打回理由，模型也无法按备注补强（与 src.js「打回后按备注补强再提」的约定脱节）。建议：打回若不写备注则由闸拒绝，或至少落一条默认说明。
6. **重复研究行**：finding-3/4/6 各有 2–3 条 `verified` 研究行指向同一 finding（不同类别名），属于子代理重复登记，不影响结论但会让“研究数”虚高；面板统计应按 finding 去重。

## 2. 最小任务④：当天 telemetry 的 risk-grade 统计

统计口径：`~/.dsh/storages/src-telemetry/src-telemetry-YYYY-MM-DD.jsonl`，事件 `laya.decision`，按 `payload.taskType` 分桶。

| 日期 | 文件行数 | `laya.decision` | taskType 分布 | 本组会话可归因 |
|---|---|---|---|---|
| 2026-10-08 | 108 | 6 | delegate 3 / skill 3 | 0 |
| **2026-10-09 … 10-12** | **无文件** | — | — | — |
| 2026-10-13 | 470 | 10 | delegate 5 / skill 5 | **10**（全部属于 `session-0ecc…`） |
| 2026-10-14 | 0（本轮清理后） | 0 | — | — |

10-13 的 10 条 `laya.decision`（全部 `source:"jev"`、`fallback:false`、`mode:"on"`）：

- `delegate` ×5，latency 427 / 1288 / 2946 / 3410 / 6586 ms；
- `skill` ×5，latency 454 / 533 / 1198 / 1198+ ms，action 为 playbook/lesson 选择；
- **`risk-grade` = 0，`scan-plan` = 0**。

**这 0 条不能读成“本会话没有用 Jev 做风险判定”**：

1. 会话 jsonl 内层实证：注册 POST 的判定确实由 Jev 返回——
   `{"effect":"write","risk":"high","action":"pending","mode":"on","fallback":false,"objectClass":"business-or-unknown","hardVeto":false,"hostExecution":false}`；
2. 根因是**观测缺口**：出口闸路径 `lib/src/egress/advisor.js → jevDecide` 以前**不写 telemetry**（`emitLayaDecision` 只存在于 `lib/src/tools/index.js`），所以 broker 路径的判定从来不会出现在 `laya.decision`；
3. 因此审计 §1「没有看到Jev风险调用证据」是**观测不可见**，不是「没有调用」。

**本轮修复**：`advisor.js` 已为 `risk-grade`/`scan-plan` 补同构旁路发射（见 `docs/jev-approval-simplification-implementation-20261013.md`），开关与语义沿用 `DSH_SRC_LAYA_DECISION`（off=静默，shadow/on=落行；web/headless 部署默认 on，测试进程默认 off）。部署后新会话才可从 telemetry 直接统计 `risk-grade`（含 fallback/延迟/受控测试对象数量）。

### 2.1 顺带发现并已处理的数据污染

`src-telemetry-2026-10-14.jsonl` 中曾有 4 条 `sessionId:""`、`latency:0`、`action:"allow"/effect:"read"` 的 `risk-grade`/`scan-plan` 行——这是**本轮修复引入前的测试进程**写入真实遥测目录的产物（单测未设 `DSH_HOME`）。已确认并清空该文件（备份留在 `/tmp/telemetry-2026-10-14.bak.jsonl`），并把发射开关收紧为上面的 flag 语义，复跑全量测试后真实目录零写入。

## 3. 未执行项（需要用户决策）

- **最小任务⑤**（隔离靶场 + 可用人工审批通道下实测一次账号注册正例）：属高影响操作，需要用户提供靶场与审批通道；AI 不得对真实目标自行执行。
- **最小任务③中的定级/去重修改**：属用户域数据的写操作，本文只给建议，未改。
- **最小任务⑥的代码/提示/rubric 新回归**：样本文件已保留并有测试钉住策略层行为，但“理由称只读、正文要求 `delete_all_customer_records` 的 POST 仍自动放行”这条**残余路径未消除**（见下）。

### 残余风险（明确记录，不声称已修）

`allowsLowImpact` 对 `effect ∈ read|compute|auth|unknown` 的请求，只要方法不是 PUT/PATCH/DELETE 就自动放行。因此“Jev 依理由判为只读、但正文携带破坏性内容”的 POST 仍会被自动发送——这正是 `docs/jev-minimal-approval-validation-20261012.json` 记录的危险误放样本。消除它需要改 rubric 或改 `objectClass` 分类（授权扩张/收窄），属需用户拍板的变更，本轮未擅动。
