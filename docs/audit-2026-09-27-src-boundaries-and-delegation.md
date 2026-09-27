# 2026-09-27：dsh-src 自有缺陷审查与宿主边界

状态：只做分析/记录，未改运行代码、未重启、未重放目标请求、未删除业务数据。
代码基线：`d14ef77` / local.103。

## 1. 用户确认的范围

保留 Laya **风险审批评估、主/子代理分工、Skill 推荐**三条既定职责。Browser 的 browser-index 使用 laya-browser-agent；不复制 Playwright runtime。

本次不处理 dsh Harness 的自动压缩实现、摘要模型预算/失败策略、宿主通用重试和第三方 LLM 429/502。用户不希望扩展项目去修宿主。

不能把“重复操作”一概判为宿主 bug：日志中的压缩替换副本不是再次执行；但主模型确实多次重新生成相同 bash，SRC 的任务分工、建议可见性和状态消费仍属于本项目。

## 2. 证据范围与前次统计勘误

使用已有完整日志快照 `/tmp/dsh-latest-history.json`，会话 `session-3596edbf-8fea-4ab9-a32c-3a2f72d363de`，截止 seq **32153**；不是此刻运行状态的实时统计。

- 原始 `tool/result` 579 条，包含 7 条 `surfaceOp=replace` 的剪枝替换；实际追加结果 **572** 条。
- 实际 bash **397** 次、src_http **123** 次、src_add_goal **1** 次、src_report **1** 次。
- seq13039 是 seq65 的 `tool/result` 剪枝副本，不是再次调用 src_add_goal、更不是再次清空任务。
- web_search **9 次：3 成功、6 失败**。前次“全部失败”错误。
- 两类源码下载命令各 **61 次**、四类 MCP 测试命令各 **34 次**的重复仍然真实存在（排除替换副本后不变）。
- 3 次 compaction，首轮摘要 token cap 截断、后两轮成功；session ID 不变。`turn/end max-tokens` 是输出上限原因，不能直接解释为输入上下文爆窗。

## 3. Delegation：不是已证实 Laya 一直选 self，而是输入/输出接线坏了

### D1：任务内容没有传给 Laya（已离线复现）

`lib/src/tools/index.js:2139-2140` 只发送 `method=TASK,url=http://task.local/` 和三个粗特征；没有发送 title/detail、验证目标、预期证据、任务类型等正文。

`estimatedSteps` 按 `detail.split(/\s+/).length / 20` 计算。中文长段没有英文词间空格，通常被压为 1 步。隔离关键词只有 `scan|batch|enumerat|爆破|批量`，漏掉当前任务的“扫描/侦察/全面测试”。

从实际会话取两个 src_add_intent 参数、复用生产公式和 laya-client、仅 mock fetch 捕获出站 prompt，结果完全相同：

```text
目标：TASK /
协议：http
估计步骤：1
是否需要独立环境：否
上下文依赖度：medium
```

不是 Laya 看完整任务后作出的可靠判断；当前输入系统性把长任务描述为小任务。离线 mock 返回 self 仅用来捕获协议，**不能当历史 Laya 实际决策**。

### D2：decision 返回 value，但 render 丢失（确定）

`src_add_intent.output.render`（同文件 :2084 附近）仅展示 playbook 和 lessonHints，不展示 delegationAdvice。实际两次工具输出也没有 delegate/self。

所以即便 Laya 返回 delegate，主模型仍看不到。`value` 含字段不等于 Native 模型内容包含字段。

### D3：无法审计历史决策，触发点不覆盖任务演化（确定）

- delegate 调用没有 `emitLayaDecision`，未记录实际 action/confidence/source/fallback；0 条 delegate telemetry **不证明没有调用**，也不证明全选 self。
- 只在 src_add_intent 调用。此会话只有 2 个宽泛 intent；之后任务变为深挖 RCE 却未创建/细化新 intent，因此没有新的分工评估。
- shadow/on 都向 value 返回建议，当前 render 漏字段掩盖了模式区分不足；修复可见性时须一并区分。

### D4：子代理工具存在，self 路径的收尾契约反而矛盾（确定）

实际 `request/header.header.tools` 137 个工具内包含 src_recon/src_audit/src_verify。无这些工具的真实调用，也无 child/checkpoint 事件；不是“子代理启动报错”。

`src_finalize_engagement`（:2920-2921）对所有 completed intent 要 completed child checkpoint，不区分实际 self/delegate，并向 commander 提示 src_submit。即使关闭 next-action，这条错误指导仍在。self 正常执行也会被当作缺子代理结果。

**修复方向**：真实任务特征 → Laya delegate/self → 有界模型可见建议 → 实际执行方式/证据 → 对应 self 或 child 的完成判据。保留建议机制，不自动 spawn，不禁止主代理自测，不增加第二套调度器。

## 4. Skill：不只是模型不愿读，漏斗存在实现断点

证据：24 次 skill telemetry，20 次 skip、4 次 authentication、**0 次 reminded**；仅 1 次 ai-abuse 读取，recommendationId 为空。

- 当前候选为 **17 route + 5 个硬编码 capability 条目**，不是逐条从现存 **49 篇知识库 Markdown**召回；route 仅带首个 doc。文档里的三源覆盖没有完整落地。
- `laya-client.js:219` 用 `r.conf.confidence` 替代选项 confidence/评分值。离线响应 `skill.confidence=.21,conf.score=.1,conf.confidence=.98` 被返回成 `confidence=.98`，会错误通过 .6 提醒阈值。
- skill 分支重建返回值时丢失 source/fallback/latency/probabilities，使失败和模型决策不可区分。
- 推荐以 `authorization` 等 route ID 登记；读取 `src_read_capability(id=clown-src-playbook,file=.../idor-test.md)` 只按 capability ID 回写；读 lesson 又按文件 ID。离线 registry 测试两种读取都关联不到 recommendationId。
- markNextAction 的生产调用点随 tool-advisory 删除而丢失：只剩函数定义和单测，没有运行调用者。
- 高风险 pending 返回分支不带 skillHint，但提前 markReminded；可能“记录已提醒，模型却没看见”。
- 当前 outcome 只在自动 HTTP observation 写入时消费，并不能覆盖宣称的 research/finding 完整链路。
- Pattern 命中按泛特征/文件顺序取前几个，不按相关度排序，实际把多个不相关形态推到同一 LiteLLM intent。

## 5. 风险与审批：保留职责，修正接线与可信来源

### R1：风险遥测退化（确定）

`src_http` :1789 返回完整 Laya 结果，但 :1826 只从 action:confidence 字符串发射事件。source/fallback/latency/probabilities/riskScore 丢失，被 emitter 默认成 unknown/false/0。因此本会话 123 次 risk-grade 的“fallback=false”不能证明后端没有超时。删除日志不是修好可靠性。

risk prompt 的 hasAuth 仅看 Cookie/Authorization/ref，遗漏内联 api-key 等；Content-Type 自动补全后仍把 rawHeaders 交 Laya。须对齐真实执行特征，不能删除风险评估。

### R2：人工批准来源未由服务器校验（代码确定；会话没有逐项人工确认记录）

HTTP/RUN 的 src_resolve_approval 接受模型 action=allow 即重放；只有 ASSET 显式禁止模型自批。`userDecision=action` 直接把模型参数记为“用户决定”。本快照未见逐项 /src-approve 命令或相应人工回注，却有 11 次 allow。

只能确认当前代码**没有硬校验逐项人工批准凭据**，不能根据 userDecision 字段推断用户点击过。应验证可信用户批准来源并保持原审批规则，不移除 Laya。

### R3：批准后自动创建假的“等用户待办”（确定）

`store.js:536-540` allow 后创建“推进 approval-X 审批结果” userTodo。SQLite 只读核对该会话 11 条均 pending；src_state 因而输出 ask-user，而 UI 历史投影显示 userTodos=0。自动插入没有对应投影事件，也没有消费完成路径。

内部模型后续工作不应伪装成人工输入待办。

## 6. 搜索：session proxy 接错宿主钩子（已离线复现）

`lib/src.js` 用 tools/pre-execute 的 next 包裹 withKeylessSearchInfra。

宿主 `ToolRuntime.prepareExecution` 先 await pre-execute 的 allow/deny，退出该上下文后才调用 dispatch continuation；provider 执行时 ALS 已不在。

离线调用真实 `ToolRuntime.prototype.prepareExecution`，两个 mock fetch 分别标记 session/global，实际命中 **global-fetch**。无外网请求。

因此应修项目的 dispatch 范围接线（如 tools/execute around-dispatch），不修改宿主。不能把全部搜索失败归咎于网络；但也不能仅凭此复现断言每次失败的网络原因。

补充：engine 支持目前只在 provider 内部，原生 web_search queries schema 没有 engine；fetchImpl 参数存在但未使用。不得宣称模型已经可选引擎。

## 7. 证据/报告/投影：存在比“模型摘要写错”更直接的根因

### E1：失败的 finding 调用污染投影（已离线复现）

`applySrcEvent` 只消费 tool/call，不检查随后 isError；src_add_finding 在 :865 附近直接入投影。

重放旧会话 d0c481fc：seq1830 high 调用进入 finding-4；seq1831 工具因缺 attackPrerequisites 拒绝，但投影 high 不撤销；seq2223 再提同名 low 成功，投影按标题去重仍保留 high。

当前旧会话 DB 行已不在，本结论基于保存的原始日志重放，不声称当前 DB 仍保留 high。

修复应以成功 mutation/权威 ID 驱动投影，而不是强迫最终总结服从错误的 high 面板。coverage 自动 ID 同样有漂移风险。

### E2：HTTP intent 归属与“最近证据”选择不可靠（确定）

该快照 123 observations、39 无 intent；当前以唯一最高优先级推断关联，优先级不是证据归属依据，仍可能误挂。应优先显式任务/实际子任务绑定，歧义透明返回。

`sessionData` :786 按 ID 字符串排序；后续 slice(-N) 把 observation-99 放在 observation-123 后，“最近证据”不是按时间。

### E3：OpenAPI 索引只接在未被调用的路径（确定）

extractOpenApiIndex 只在 src_collect_passive 使用；此会话用 src_http/bash 拉 schema，没有调用 src_collect_passive，所以大响应结构化优化没覆盖真实入口。不能宣称此会话已受益。

### E4：CORS 过滤不等于语义修复，finding 准入只验证字段（确定）

buildReport 用 CORS + “通配符/不可利用”等关键词静默过滤；store 仍 active，UI ReportView 另有渲染逻辑。可能隐去真实漏洞，也不能完成 research/false-positive 状态迁移。

medium+ gate 检查文本长度和引用 ID 存在，不证明引用内容确为实际危害。当前 critical/high 的“不连 DB”错误不能单独证明成功认证或 RCE；OAuth 动态注册返回 client 凭据也不自动等于权限提升。应按真实影响复核，不新增 RCE 专属模式。

## 8. 不纳入本轮项目修复

- dsh-compaction-basic 的自动触发、summary 8192 输出 cap、截断拒绝和失败后保留 surface。
- 压缩替换记录在历史中显示、同 session 多 turn、指令重新注入。
- 上游 LLM 的 429/502/传输失败与宿主通用 retry 参数。
- 目标自身 400/401/404/405、DB 未配置等响应。
- 本次 0 browser 调用，不能评价 laya-browser-agent 准确率；不在本轮接管普通浏览器规划。

重复行为分两类：压缩替换副本不属于重复执行；397 次真实 bash 中相同命令大量重生成，不能仅凭现象认定是宿主。先修项目分工/结果消费，不强制禁用 bash、不加第二套压缩或全局调度循环。

## 9. 验收与文档自身的问题

此前“238/238”不足以覆盖生产接线：
- delegate 无真实 render/模型上下文断言。
- 搜索没有宿主 prepare→dispatch 的 session proxy 集成断言。
- 域删除测试名声称运行闸/文件删除/失败重试，但当前正文调用 SrcStore，甚至在 running=true 时直接删表；没有测实际全局 admin command。全局 admin 又复制了一份 catalog/delete store，并传 closeProofServers 空函数。属于独立管理功能缺口，非当前会话循环根因。

需要恢复以实际调用层为中心的集成测试；不能靠改断言或“字段还在”宣称完成。

## 10. 推荐处理顺序（尚未实施）

1. Delegation 真实输入、模型可见输出、遥测、self/delegate 完成判据；保留三类 Laya 职责。
2. 失败 mutation 不污染投影；审批可信来源与内部待办/投影一致性。
3. 修复搜索 session proxy 的 dispatch 接线。
4. 修复 Skill 真文档候选、score/confidence 解析、读取 ID 关联与后续动作漏斗；恢复完整风险遥测。
5. 修复证据归属/最近证据排序、实际 HTTP 入口的 OpenAPI 索引、CORS/research/report 一致性。
6. 单独补域删除真实 command 集成测试，消除复制实现。

## 11. 复核后最终状态（local.104）

本审查中列出的 **dsh-src 自有缺陷均已处理**，并在后续全量复核中再次检查了实际接线：

- Delegation 正文输入、中文步数、可见 render、持久化 mode、delegate telemetry、self/delegate finalize 判据已闭环。
- Skill 候选已覆盖安装知识库全文，confidence/source/fallback/latency、读取 ID、pending hint、next-action、evidence outcome 已接通。
- 审批已改为一次性人工 approvalToken；批准结果不再伪造 userTodo；ASSET/HTTP/RUN 均记录 approvalSource。
- 搜索代理已在 `tools/execute` dispatch 阶段注入；不是只包 pre-execute。
- 失败 finding 投影按 call 产生的精确 ID 回滚；OpenAPI 结构化索引覆盖 `src_http` 并写入 intent fact；多 intent 证据不再按 priority 猜归属；时间序列按 createdAt 排序。
- CORS 弱信号不再由报告关键词静默过滤；新增正式 reclassify→research(false-positive/blocked) 路径，预检头反射无实际敏感响应证据时准入拒绝。
- 域管理全局插件已复用正式 `SrcStore`/`domain-data`，真实 command registry、运行闸、proof-server 关闭和文件清理均有集成覆盖。
- 重复调用 guard、project-defects 回归测试、deployment 清单和 local.104 双 profile 同步已完成。

最终验收：

```text
npm test：241/241
preset consistency：通过
node --check：通过
git diff --check：通过
npm pack --dry-run：通过
Web：HTTP 200（/healthz、/management.html）
Web/headless：均为 0.1.0-local.104
```

仍明确不属于本项目本轮范围：dsh Harness compaction、摘要模型 cap、宿主通用 retry、上游 429/502，以及普通 Playwright planning takeover seam；这些不是 dsh-src 接线缺陷，未伪装成已修复。
