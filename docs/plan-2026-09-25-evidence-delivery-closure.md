# local.99：先修证据交付链，再优化决策

日期：2026-09-25；基线：21e0358（local.98）；实施状态：代码完成，自动化验收通过；部署与运行生效见末节。

## 1. 目标与边界

本版只解决三条基础链：**模型看见结果 → 请求自动留证 → 父子代理交付/读取/复核同一份证据**。同步修复 Pattern 接线及 Laya 越过规则审批，不新增扫描器、调度器、持久化队列或自动攻击策略。不扩大授权范围，不删除审批，不修改真实目标历史数据。

审计基线：216/216 测试通过，但现有 harness 主要直调 execute。真实会话 src_http 成功结果仅状态行；state v2 隐藏阻塞/索引；submit 只返计数；child 读取自己的空库。必须同时测试 execute 的 value 和 output.render 的模型 content。

## 2. 实施批次

### A. 模型可见输出

- src_http：状态、审批状态、完整脱敏 URL、关键响应头、响应体摘要、evidenceId、截断/去重及读取指引。默认响应仍约 2KB，完整证据读取最多 32KB；不把 credential/header 明文送回模型。
- src_scan_surface：展示逐路径 status/content-type/hints/error，保留预检/停止原因；限制行数和单行长度并明确遗漏数量。
- src_test_bypass：baseline/variant 的方法、路径、状态、差分/保护信号，不输出原认证头。
- src_add_intent：输出实际 playbook.docs/checks，不再只说创建成功。
- state v2：输出 nextActions 的理由/优先级、blockedReasons、runningWork、证据索引、finding 摘要；evidence/orchestration 分视图保留各自必需内容。单字段/数组有界，不直接输出含请求凭据的对象。

### B. HTTP 自动证据

- 复用 observations 表；src_http 成功执行后自动写一条 observation，返回 evidenceId。pending/rejected 不得生成已执行证据。
- observation 保存完整脱敏 URL（含 host/query，防跨 host 同 path 混淆）、请求头/请求体摘要、响应头、最多 32KB 脱敏响应体、可选 intent/asset 关联。新增字段 optional，旧库兼容，无新表。
- 模型响应去重不影响证据保存；每次实际请求都有独立证据。截断必须显式注明，不声称保存了无限长原文。
- 注入凭据和 Set-Cookie 脱敏；保留未作为测试凭据注入的漏洞证据内容。请求体中的密码/token 类字段需脱敏。自动证据落库失败返回 evidenceError，说明请求已经执行、不可盲目重放写操作。
- src_resolve_approval 的 HTTP 重放也走同一捕获逻辑；RUN/ASSET 不伪造 HTTP observation。
- 父 store、父 synthetic projection 和 evidenceId 一致；修 upsertObservation 丢 intentId/assetId 的问题；无 intent 的开局请求允许记录。

### C. 子代理证据链

- src_submit 增加 factIds/assetIds/findingIds，按输入顺序返回真实 ID（包括重复项），渲染显示映射；保留原计数语义。
- 分批写入如中途失败，已成功部分立即同步父投影，错误文本带已持久化 ID，避免“数据库有、投影无”。不承诺跨表事务。
- src_get_evidence 与只读 src_state 沿真实 session parent 链解析 engagement，不接收任意 sessionId，不允许跳到无关会话。
- verify 的 src_record_research 沿父 engagement 写；子代理必须已对该 intent 提交 checkpoint，验证 evidence/finding 引用归属；向父追加研究投影。此约束是已有 checkpoint 关联，不冒充宿主尚未提供的不可伪造 intent 授权令牌。
- 子代理开放只读 src_state/src_read_capability，仍禁止管理能力、执行审批脚本、建 goal、改基础设施、审批与 finalize。更新 persona 和一致性检查。

### D. 相关确定性修复

- Pattern 函数在组合根正确 import/注入，增加工具调用层命中测试，不能只测纯函数。
- Laya allow 不得覆盖 classifyHttpRequest.require；所有放行请求复用同一 headers/credentialRef/Content-Type/脱敏/证据路径。Laya 不可用仍回落既有规则审批，不扩大自动执行权限。
- 被 blocked 的历史研究从 falsifiedHypotheses 分离为受阻历史，避免把未验证误当证伪。

## 3. 验收矩阵

1. 本地 HTTP fixture 唯一 body marker 在真实 render 内容中出现；关键 CORS 头可见；注入凭据和 Set-Cookie 值不可见。
2. 同一路径重复请求：展示可去重，但每条 observation 都可按 evidenceId 读取实际响应摘要；跨会话不互相吞首个响应。
3. pending/reject 零网络请求、零 observation；批准仅发一次，有证据 ID；Laya 高置信 allow 不能绕过规则审批。
4. child 发请求/提交事实 → 父库落证据 → 返回 ID → child 读回 → verify 关联 research → 父 projection 可重放；无关会话不可读。
5. 提交重复批次 ID 稳定；部分失败已写内容的 ID 与父 projection 一致。
6. state 三视图渲染包含标题/阻塞/索引；scan/bypass 包含逐项结果；playbook checks 真正送达模型。
7. Pattern 在 src_add_intent 的模型内容中命中。
8. 旧测试、browser-loop、preset consistency、schema 往返、lossless 与 git diff --check 全绿；新增模型可见内容契约测试纳入 npm test。

## 4. 明确后置

finding 生命周期、finalize/报告质量语义拆分、survey 闭环/模式、请求风险分类器重做、宿主可信的子任务 capability token、真正模型盲测与收益 A/B 不混进这版。当前不通过放松 finding 门槛制造数量。自动留证首批覆盖 src_http 与审批重放；scan/bypass 的逐请求持久化另行评估，本版先恢复其结果可见性。

## 5. 发布、回滚与实战验收

- 版本统一 0.1.0-local.99，源码/部署清单一起更新；不变更用户开关、凭据、目标数据。
- 全量测试通过后可同步双 profile；运行进程重启需确认没有正在执行的任务，不能为了生效中断真实会话。无法确认则仅交付代码/部署状态并明确待重启。
- 回滚恢复本版修改前的文件/提交并重新同步 profile；可选 observation 字段旧代码可忽略，不做删库迁移。
- 集成测试通过不等于有效产出提高。后续仅在授权本地靶场做模型盲测：同模型/预算/账号条件，分别含真漏洞、200 阴性、公开数据、缺凭据和需审批操作，统计真阳性/误报/有效验证回合/证据回流，不预告漏洞路径。

## 6. 实施与验证记录

### 已实现

- 新增薄模块 `lib/src/evidence-output.js`：有界渲染、注入凭据/Set-Cookie/请求体敏感字段脱敏，不新增服务或状态表。
- HTTP 与审批重放自动写 observations，返回 evidenceId/evidenceError；复用父会话 projection；observe 写入按 domain+session 串行分配 ID，避免并发覆盖。
- schema 仅增加可选 reqHeaders/reqBodySnippet，保留 intentId/assetId；projection stateVersion=14，真实 ID 幂等，同毫秒不同 ID 不去重，无 intent 开局可留证。
- src_state 三视图、scan/bypass、playbook 渲染恢复决策信息；HTTP evidence 索引可见。
- src_get_evidence 增加 offset/nextOffset；正文总量默认16,000字符/full 64,000字符，单项4,000/32,000字符；超过保存上限的数据明确截断。
- src_submit 返回含去重项的真实 ID 映射；已写部分立即同步父投影；局部失败返回已落盘 ID。child 只读解析父链；verify 研究写回要求已有同 intent checkpoint 和有效证据引用。
- 三角色开放只读 state/capability 文档，其余管理/审批/目标修改限制不变。Pattern import/注入修复；blocked 与 falsified 历史分开；删除 Laya 独立自动执行分支，allow 不再越过规则审批。
- package 与 lock 根版本统一 local.99；npm test 包含 browser-loop；部署清单包含新模块。

### 自动化验收

- 全量 **224/224**：旧216 + 新8组回归，日志 `/tmp/dsh-local99-final-tests.log`；新增测试通过宿主 ToolRuntime.createSuccessResult 的真实 snapshot/schema/render/materialize 路径检查模型 content，而不是仅断言内部 value。
- 新增用例包括：响应marker/关键头/脱敏、父子读取隔离、重复请求留证、审批零发送与重放、Laya高置信allow不能越权、提交ID映射与局部失败、受限研究回流、视图内容、并发20条证据、分页预算、Pattern工具接线与blocked历史。
- preset consistency 与 git diff --check 通过；工具description合计14,047字符，未越15,000预算。
- UI 类型检查：本地 `node_modules/.bin/tsc` 悬空，npm run ui-src:typecheck 首次失败（command not found）；改用本机已安装 TypeScript **5.9.3** 检查同一 tsconfig 成功，没有下载依赖/重写UI产物。

### 尚未宣称完成

- 本地真实模型盲测已启动，但各组在时间预算内未完成有效验证，不能宣称有效漏洞产出提升。过程与限制见 [首轮评测记录](evaluation-2026-09-25-local99-blind.md)。
- 子任务权限仍是宿主父链与既有 checkpoint 关联，不是不可伪造的 intent capability token；同 engagement 内只读证据共享，不是按 intent 的保密隔离。
- 现有 fact/finding/checkpoint 的跨表写入不是事务；本版解决局部失败已写内容可见，不承诺全局事务或所有类型并发 ID 分配已修复。
- scan/bypass 自动留证、finding/报告语义、survey 真闭环仍后置。
### 打包与部署（2026-09-25）

- 最终 `npm test` **224/224**，日志 `/tmp/dsh-local99-release-tests.log`。
- npm pack 成功：`/tmp/dsh-local99-pack/lihua_dis-dsh-src-0.1.0-local.99.tgz`，已核对新模块和本方案入包。
- 双 profile 文件同步完成，部署脚本 MD5 全通过；web/headless 副本均 local.99，独立进程 import `lib/src.js` 成功。部署日志 `/tmp/dsh-local99-deploy.log`。
- 同步前包备份：`/tmp/dsh-before-local99-20260925-190013/{web-src,headless-src}.tgz`。
- 首次文件同步时保留PID37320。随后经只读API两次确认413会话均无running，按原参数安全重启为 **PID43172**，HTTP200；日志 `/tmp/dsh-web-local99.log`。未修改feature flags、网络范围或真实目标数据。
- UI 仅添加可选类型字段，没有修改 UI 显示组件或重建 bundle；新增请求报文可通过 src_get_evidence 读取，UI请求报文专用展示不在本版范围。
