# local.108：会话质量修复、验证与边界

日期：2026-10-03。唯一源码：`/Users/lihua-dis/Software/dsh-src`，main。审计基线：`0b09317`。
依据：`audit-2026-10-02-session-fd2c50eb.md`。本文件替代此前逐步实施的临时进度描述，不代表上游模型服务已修复。

## 1. 用户要求与不变边界

- 审批卡应先用简短自然语言说明做什么、影响什么、可能后果、恢复条件。长报文折叠供复核；模型自称“无副作用/可逆”不是安全保证。
- Jev 保持启用（risk/skill/delegate/browser=on），不靠关功能止血、不自动换供应商、不用路径白名单修补。
- 只在唯一 main 工作树开发；不修改宿主压缩、通用 retry 或 new-api reasoning 协议实现。
- 不重放任何历史真实目标请求，不替用户处理旧会话审批；原始 finding/research/observation 不改写。历史页面从权威数据库只读重建。

## 2. 已实现的代码

### 2.1 权威状态与 ID

- `committed-state.js`：每个 domain/engagement 的可重入写入串行锁，避免多个 store 实例并发分配相同ID。这是数据写入互斥，不是第二套任务调度器。
- Store 成功写入后追加 `src_commits` 变更账本，记录实际 row/key/id、单调 eventSeq、首次 baseline；部分批次已接受的结果同样记录，不凭模型调用猜测写入成功。
- `store-projection.js` 从成功提交构造节点、边、coverage、观察、审批、manifest；失败不消耗finding编号，重复事件幂等。
- 旧日志 finding 按成功 tool/result 的ID回放，修复 failed→retry 的编号偏移；旧无成功提交事件的coverage不强行猜测。
- `src-authoritative-state` 全局用户命令，从数据库返回权威页面状态、提交序号和finding指纹。UI加载失败时显示原因并禁用操作；不会静默依赖错误旧投影。
- `src-reject-checked` 以ID+内容指纹再次核验，store锁内复检；过期页面拒绝修改。
- projection stateVersion=17；domain version=16。旧schema缺少的finding证据、checkpoint artifact、approval生命周期字段已补齐。
- 旧 `src_events` 键加入session，补充 appended reducer类型；它继续是兼容旁账，不宣称旧缺失事件已被补齐。新的提交账本才是新写入的完整变更来源。

### 2.2 审批与写前安全

- `ApprovalExplanationCard` 在按钮前显示：动作、对象、目的（注明模型来源）、可能后果、恢复条件、需确认原因；细节与原报文折叠。
- method/存储URL/body/Jev effect 联合解释，不按端点名称加白名单。PUT显示可能整体替换、DELETE显示丢失/不可用、实体声明显示文件读取/外发风险。
- `userDecision/decisionAt` 与 `executionState` 分开：queued、executing、executed/rejected、failed-before-send、unknown、cancelled。
- Web用户命令具备真实ToolRuntime时，用户点击后直接执行这一条已经批准的请求，再通知主模型结果；不再必须等主模型规划下一步才执行。
- 成功/失败/取消均落执行状态；不确定或中途取消的写操作禁止自动再发。没有自动扫描旧审批、自动恢复或启动重放队列。
- DELETE不能被Jev read/low/allow覆盖；PUT/PATCH与read/compute矛盾转人工。普通GET、纯计算POST保持联合条件放行。
- `write-safety.js` 保存受限原始响应备份（目录0700、文件0600、hash校验、session+精确URL绑定、2MB上限）。脱敏显示不充当回滚原件；备份失败不丢已完成HTTP观察。
- 配置JSON PUT/PATCH要求safetyPlan；JSON PUT拒绝遗漏原件字段的部分文档。写前回读确认与备份一致，写后回读只核验资源，不把HTTP200说成业务完全正常。
- `restoreFromSnapshot` 只在另行获批后恢复受校验原件；存储与Jev中保留引用标记，不把备份机密明文塞入审批/远程。恢复仍需当前备份和恢复计划，不自动补偿。
- `writeOutcome` 记录回读是否成功、资源是否变化、是否匹配提交、写后快照及告警。任意服务是否业务健康仍需主模型/用户明确检查，未实现通用业务健康判别器。
- 脱敏URL正则不跨JSON结构吞字段；Basic认证明文组合也加入已知secret掩码，原始备份与模型输出分离。

### 2.3 扫描、接口清单、证据

- 共享发送时隙 limiter 支持取消和定时器提前唤醒复检，scan预检/防护探测/主扫描与src_http、审批重放按engagement协调；专用bypass/credential/passive也接发送边界。
- 扫描输入先过滤/去重再取前100，返回supplied/invalid/duplicates/accepted/omittedPaths。只计实际受理集合，不用模型输入长度宣称实测。
- 展示最多100条受理结果，包含length、title、有界样本hash、evidenceId；不要求重发请求才能看后60条。
- scan生成manifest并写真实observations；HTTP拿到OpenAPI时也生成manifest。稳定方法+origin+path身份、同内容重复导入幂等；未知方法标UNKNOWN而不是全部伪造GET。
- manifest coverage绑定时按endpoint状态计算total/tested/skipped/blocked/notApplicable。tested必须引用同方法同路径的真实HTTP观察，不能给任意非空字符串冒充证据；后续遗漏manifestId也不能绕开已绑定计算。
- 不允许替换同coverage已绑定的manifest来缩小分母。旧无manifest的计数继续兼容展示，但不能被解释为新契约已验证的全量覆盖。
- 子代理 bypass/导入/passive/coverage 写入归engagement；委派前校验凭据引用格式与可解析性，避免父prompt改坏引用后让子代理盲跑。

### 2.4 知识、复核与交付

- `src_supersede_knowledge` 要求同目标、真实新证据与原因，以独立revision标记fact/research/note被取代，保留原件；新会话召回过滤失效研究/笔记。不会自动判定或改写历史错误结论。
- research证据正文返回id、intent、finding、前提、停止原因及失效信息，主模型不需要猜测归属。
- 独立验证记录带verifierSessionId和finding内容fingerprint；必须有该子代理completed checkpoint，主模型自填verified不等于独立复核；finding内容/等级改动后需要重新复核。
- src_verify实际派发角色标记，verify子代理不能借src_submit新增finding。
- Skill在建intent时提前推荐，保留读取/下一动作/证据关联；效果仍由主模型真实采纳决定，不承诺读取率或准确率。
- 搜索解析解码Bing目标URL，拒绝与查询/CVE完全无关的可解析链接；这是可观测质量筛查，不是完整语义搜索引擎。
- src_report生成真实报告文件及hash manifest；checkpoint显式artifactPaths须存在、在当前engagement目录且hash匹配，finalize再次校验。目录短ID碰撞验证README归属。
- 报告/UI共同增加“证据与未验证边界”，标出自验证/独立来源；潜在RCE/SSRF/DoS与“无告警”不能当作实证。模型叙事是否过强仍需报告审核，不能以新警告文本宣称问题被自动全检出。
- 域数据清理覆盖新增原始快照，避免以后清理域时遗漏机密原件。

## 3. 自动化验收

- 最近全量：281/281（最终收尾变更后再次执行，见最终提交/部署记录）。
- `quality-contracts.test.mjs`：并发ID、失败回放、提交序号、manifest方法证据绑定、受限原件与部分PUT、审批单次执行与unknown重放拒绝、知识失效、独立验证版本失效、artifact篡改检测、偏题搜索拒绝。
- 真实ToolRuntime/命令测试：页面批准直接派发、仅一次到达、重复审批拒绝；既有父子回流与失败保留测试继续通过。
- UI类型检查、构建、语法和diff检查通过。UI构建仍有既有tsdown define/import.meta警告，不将其说成无warning。
- 旧SQLite快照13,549行全schema验证无错误；权威只读视图返回正确finding-1/2 high、27条coverage。没有写旧数据库。

## 4. 真实dsh新会话与请求日志

测试资料目录：`/tmp/dsh-local108-20261003-180030`，仅本机fixture `127.0.0.1:55917`，不代理真实目标。Jev配置保持on，使用真实供应商；因此不是“零网络”。

### A. session-66392fca-ad52-4ead-b117-919c9aeaef4d

真实模型调用：goal→intent→OpenAPI→manifest读取→六条并发扫描→compute POST→read GET→finding缺字段失败→重试。

结果：
- manifest 5个方法/路径项，GET与PUT不混同。
- 扫描 `/a..f` 的实际到达间隔为202/203/203/202/202ms，符合5RPS；全部404但不宣称无应用。
- `/compute` POST和`/read` GET实际到达。
- 第一次finding准入失败，第二次成功为finding-1；页面显示一致。
- 上游reasoning400中断后半程，不能称原prompt完整跑完。
- 后续单独要求src_report，真实生成报告文件，返回1126bytes和sha256；模型额外用bash检查本机文件（不是目标请求，但超出只调用一次src_report的prompt约束），此偏离如实记录。

### B. session-88e6e6d0-5363-42a6-84c1-58b1506aeeb0

真实模型完成goal→GET settings→DELETE pending→部分JSON PUT pending。
- GET真实到达，生成snapshotRef。
- DELETE和PUT均未到达fixture。
- UI审批卡真实展示整体替换/清空其他字段/中断服务、缺少已验证恢复方案，页面无pageerror。
- 通过实际页面按钮批准本机会话approval-2（明确用于负例验收）；直接返回安全计划缺失错误，持久化userDecision=allow与executionState=failed-before-send，PUT/DELETE到达仍为0。没有操作旧会话审批。

### C. session-9d3e0966-5419-4b5b-bb22-5dd690a65058

父子回流新会话首次建goal后reasoning400，一次有界续跑建intent后又reasoning400。随后单工具派发成功：子代理 `3639b015-ab35-485a-80ec-3d20d2b2594b` 只GET /read一次，提交父intent-1下fact-1/observation-1与completed checkpoint-1；父代理由完成事件唤醒并生成报告，没有轮询等待。独立文件核验218bytes及hash匹配。准确结论是有界分步触发后通过，原始单prompt前两次被上游中断，不能称无故障一遍通过。

### D. session-11556888-3bc0-4c17-b5f4-fa34c7252980

完整配置写入→独立批准→只执行一次→原件恢复的真实Web验证：
- 模型先GET /settings拿原始snapshot，再完整保留charset/contact提交enabled=true的PUT与safetyPlan，Jev返回low/write/pending。
- 页面批准approval-1后直接执行一次PUT，记录executionState=executed；写后GET回读matchesRequested=true，明确未证明所有业务健康。
- 模型再GET当前状态获得新的快照，并用restoreFromSnapshot引用最初原件（不传body、不复制秘密正文到审批），生成approval-2。
- 页面另行批准恢复后，服务端从原件取回enabled=false的完整JSON，第二次PUT执行一次，写后回读匹配。
- fixture请求日志中仅有两次获批PUT，0次DELETE；最终charset=UTF-8、contact不丢失、enabled=false。旧真实目标无请求。
- 实测发现恢复卡snapshotVerified显示不同步，已修正准备和执行后两处状态；历史“未发出”的reason改标“执行前分类记录”，避免与executed当前状态冲突。

## 5. 实测发现并修正的接入缺陷

- 新权威状态命令起初只挂session层，Web看不到；提升到全局src-domain-admin层后实测页面正常，失联时仍禁用操作。
- ToolRuntime schema漏snapshotRef导致resolver输出校验失败，已同步声明。
- 新报告节未同步UI/locales导致双渲染回归失败，已补。
- 专用低层工具的parent/session写入未全收归，已同步bypass/import/passive/coverage。
- cancelled不应恢复为可盲目重发的pending，allow被阻止，须先核对目标。

## 6. 不能宣称已解决的范围

- new-api/上游reasoning字段协议400：未改且真实测试仍复现；不伪造thinking、不自动切供应商。
- 任意endpoint业务副作用、任意配置格式自动回滚、所有模型错误结论的自动纠正，都不具备通用保证。当前JSON配置保护与实际备份校验必须如实标注覆盖范围。
- 历史错误research/note未自动改写；提供可审计失效通道，不代表已替用户批量修订历史事实。
- Jev/Skill长期准确率和模型是否采纳建议不是一次回归能证明。
- src_commits是新写入提交账本；旧session没有的事件不凭空补造，历史视图直接读取SQLite权威记录。跨进程崩溃原子性仍依赖现有storage后端，新表不等于引入完整数据库事务引擎。

## 7. 复现方式

```bash
npm test
npm run ui-src:typecheck
npm run ui-src:build
node scripts/check-preset-consistency.mjs
# 在新建私有临时目录启动本机fixture：
node scripts/quality-fixture.mjs <验收目录>/fixture
# fixture启动后，创建真实dsh会话发送主动触发prompt：
node scripts/quality-session-test.mjs <验收目录>
```

`quality-session-test.mjs` 会调用当前dsh Web和已配置主模型/Jev，产生真实模型费用；fixture只有本机合成数据。执行前明确预算与范围；不能对真实目标套用该prompt。

## 8. 部署与回滚

- local.108，schema16，projection17。部署只从main，保留双profile产物。
- 首次升级前备份：`/tmp/dsh-local108-20261003-180030/{web-src,headless-src,src-before.db,src-decision.json}`。
- 回滚代码不覆盖后续SQLite、日志、artifact和快照。旧代码可能不识别新字段；任何数据回滚需另行确认，不能覆盖新会话数据。
- 最终commit、Web PID、实测完成项和阻断项在最终回复与后续追加记录中标明，不用部署HTTP200冒称端到端全通过。
