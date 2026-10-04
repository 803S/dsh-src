# 项目审查：local.108、Jev 与跨通道审批

日期：2026-10-04（北京时间）。审查基线：`d7828e8` / `0.1.0-local.108`。

## 总结

**已有优化有价值，但不能据此认定整体安全闭环成立。bash 绕开 SRC 审批不是猜测，而是最新会话已经发生的执行路径。** Jev 并未错误批准这些请求：它根本没有收到风险判定请求。当前最值得做的不是继续微调风险提示词，而是统一外发执行边界、修正跨会话审批锁、让报告发布真正消费验收结果。

本次只做审查、回归与无害离线复现；未向目标发送请求，未调用付费 Jev，未修改生产配置、审批历史或业务源码。以下安全修复建议会有意收紧行为；文末 Clean Code 建议则保持既有行为。

## 范围与证据口径

- 项目范围：执行与审批、Jev 四职责、父子协调、状态/存储/投影、coverage/证据/报告、部署与测试配置；重点逐行核查安全关键路径。不是声称逐行审完所有 UI 和依赖包，也未进行本轮浏览器视觉验收。
- 当前 Web/headless 部署版本均为 local.108；两部署中的 `lib/src.js`、`lib/src/tools/index.js`、`lib/src/approval-locks.js` 与仓库 SHA-256 相同。此次不能归因于部署旧包。
- 最新主要样本：`session-75097e62-812a-4e61-92aa-9e95e71a8e81`，日志末时间 2026-10-04 19:27:02。原始日志：`/Users/lihua-dis/.dsh/sessions/--Users-lihua-dis-Software-Src-Pedestal-src-domain-ready--/session-75097e62-812a-4e61-92aa-9e95e71a8e81/session.jsonl.zstd`。
- 读取 Zstd 解压后的全部 8,197 JSONL 记录；409 条 tool/call 中剔除 100 条 `src-submit-*` 合成事件，得到 309 条真实调用。压缩替代 tool/result 不作为重复执行计数。下文 seq 指原始日志事件序号，不是文件行号。
- 最新样本：bash 219 次，src_http 0 次；src_recon/src_audit/src_verify 0 次。bash 次数不等于 HTTP 请求数，一条 shell 可执行大量请求。
- SQLite 当前样本：5 intents、6 facts、3 findings、34 observations、11 coverage、1 endpoint manifest、0 pending approvals、0 submissions。observations 不能都算作受控 src_http 证据。
- 当前日遥测 45 条，均属于上述 engagement；11 次 Jev 调用。10 月 2/3 日当前遥测文件为空，不能据此推断历史当日没有活动。前轮历史评估参照项目已保存的 10 月 2 日审查，不冒充重新统计其全量原始日志。
- 产物核对：`/Users/lihua-dis/.dsh/artifacts/132.32/session-75097e62/报告/report-1791102060900-5a20a2fb.md` 及对应 manifest。

## 高优先级问题

### P1 / 高：bash 外发不受 SRC 审批、范围和速率约束

**位置**：`lib/src.js:2099–2117`；`preset/src-hunter/agent.cordis.yml:50–56`；`tools/burp-mcp-bridge.mjs:69–80`；不准确的承诺见 `lib/src/tools/index.js:1802`。

SRC 的 pre-execute 只拦域清理；execute 处理重复调用与 web_search 上下文。bash 是正常注册的宿主工具，没有接入 Jev、pending 审批锁、scopeOrigin 或共享请求限速器。Burp 的锁检查仅处理两个 send_http 工具，并非任意进程网络出口。

**真实证据**：
- seq 916→917：bash 循环发送 OPTIONS/TRACE/PUT/DELETE/PATCH/HEAD；结果明确返回各方法 404，而非审批挂起。404 只能说明请求结果，不能证明发出前安全。
- seq 11613→11614：创建测试存储返回 201、清理返回 200。
- seq 14779→14780：测试文件回读 200，上传 JSP 返回 201、清理返回 200；并非所有写操作都只是失败探针。
- seq 874、2019：在用户只指定单端口目标时，shell 探测同 IP 的其他端口；没有经过 src_http 的 origin 检查。
- 当前样本 0 src_http、0 risk-grade、0 SRC 审批记录。它是“未进入 SRC 审批链”，不是“Jev 批准后出事”，也不是已经证明某个 pending 单被重新发送。

会话宿主策略记录为 workspace-write / ask；这不等于远端 HTTP 高风险策略。泛化文件沙箱审批不能替代对目标删改行为的审批。

**建议**：以宿主工具/执行出口为强制边界；SRC 模式中任意脚本的外网访问默认不可用，受控 HTTP/扫描/能力执行器承接外发，显式审批后才开放有界能力。需要支持脚本时，用可执行的网络隔离或出口代理，而不是匹配 `curl` 字符串。普通本地计算可保留；无法可靠分类的脚本应拒绝或人工审批。pending 是纵深防御，不应是首次请求唯一的风险入口。

### P1 / 高：审批锁使用会话内 ID 作为全局唯一键

**位置**：`lib/src/approval-locks.js:15–24,45–64`。

审批记录在会话内使用 `approval-1` 等编号，锁文件却是整个 DSH_HOME 共用，normalize 丢弃 sessionId；add 按裸 id 去重，remove 按裸 id 删除。

**无网络复现已通过**：先为 session A 的 a.invalid 写入 approval-1，再为 session B 的 b.invalid 写入 approval-1，文件只剩 a.invalid 一条。处理 B 的裸 approval-1 又能清掉 A 的锁。无需并发即可发生。

此外，read-modify-write 没有互斥，临时文件只带 PID；同进程并发写存在覆盖/rename 冲突风险；读取损坏文件直接返回空数组。这是额外风险，本轮未用真实生产锁复现竞争。

**建议**：主键使用 engagement/session + approvalId；保留每个待审单，不按 URL 删除其他所有者的锁。权威状态放数据库，桥查询一致性快照；序列化更新。不可用/损坏时不得把待审状态当作零条放行。

### P1 / 高：写前安全契约只覆盖 JSON 外观的 PUT/PATCH

**位置**：`lib/src/write-executor.js:3–4`，`lib/src/write-safety.js:23–35`。

executor 在 body 不以 `{` 或 `[` 开头时直接调用 transport。XML 配置、文本资源、空体操作和 POST 创建均不经过这里的快照/漂移/回读检查。对 GeoServer 这种同时支持 XML/JSON 的管理接口，这不是少见边界。

**无网络复现已通过**：给 `executeWithWriteSafety` 一个合成 XML PUT、不提供 safetyPlan、注入只记录方法的假 transport；结果直接记录 `PUT`，没有 GET 原件或校验报错。

这与 P1-1 相互独立：即使以后全部请求收归 src_http，XML 写入仍缺少同等保护。它不表示 XML 绕过了所有人工审批，而是即使获准执行，也没有承诺的写安全闭环。

**建议**：按操作语义制定备份/验证契约，不以 JSON 首字符决定是否安全；未知写入格式不能直接降级成无保护。新建资源可用“不存在性基线 + 精确资源标识 + 经批准清理计划”，不强求不存在资源的 GET 快照；删除/执行代码应使用独立高危契约。

### P1 / 高：finalize 阻断不能阻止发布“最终报告”

**位置**：`lib/src/tools/index.js:3216–3229,3233–3260`。

finalize 计算 ready/completionStatus 并返回、发遥测；src_report 直接 buildReport + publishReportArtifact，不校验最新验收，也不要求显式 limited 理由。带 hash 的文件证明文件存在，不证明验收通过。

**真实证据**：seq 16057→16070 的 finalize 明确返回 report blockers：5 个 completed intent 无 completed checkpoint、finding-1/2 无独立验证等。随后 seq 16079 仍成功发布报告；没有重新通过验收，也没有 allowIncomplete 声明。

**建议**：允许导出草稿，但要显式标 draft/blocked；最终发布要求同一状态 revision 的验收记录。受限交付需明确理由并把 blockers/未验证边界写入正文。状态变化后旧验收失效，不用模型“先 finalize 再 report”的纪律代替硬约束。

### P2 / 中：有端点清单但不绑定 coverage 时，对账退化为 warning

**位置**：`lib/src/tools/index.js:3145–3151`；`lib/src/store.js:231–257`。

computeCoverage 对已绑定清单的 tested 有实证校验，是正确改进；但完全不创建 manifest-linked coverage 时，finalize 只警告。intent 标 completed 还会自动生成 evidence=[intentId] 的 completed coverage，生命周期声明容易被读成实测覆盖。

**真实证据**：1 个 33 端点 manifest 没有覆盖对账；5 条 intent 自动 coverage 都 completed；其余手填维度引用 fact，并不能解释 33 个端点的状态。当前 finalize 被别的条件拦住，因此不声称本次已经“全量验收成功”，但 manifest 缺口自身没有形成完整验收的阻断。

**建议**：保留生命周期覆盖与 HTTP 覆盖两种口径并明确区分。完整验收必须说明每个 manifest 端点去向；不要求盲目测试全部端点，允许有理由的 skipped/blocked/limited。

### P2 / 中：损失证据只验 ID 存在，报告仍能把公开示例数据写成业务损失

**位置**：`lib/src/store.js:301–314`；`lib/src/reporting.js:19–31`。

medium+ 校验前提/影响文本长度与引用存在性，不能证明被引用内容真的支持敏感性、访问控制要求或不可察觉性。它允许 finding 引用作为 loss ref，范围还比错误消息声称的 fact/observation/research 更宽。

**真实证据**：finding-2 把 `topp:states` 的 Illinois 人口等记录，以及 ne/tiger/sf/topp 图层，写作“全部地理业务数据未授权导出”。这些具有 GeoServer 常见示例数据特征；未证明数据私密或本应鉴权。匿名 OGC 读取本身不等于越权。当前 finding-2 的 medium 评级应人工复核，而不是直接算有效中危。

早期磁盘报告 finding-1 还写“全程无感知”，没有告警/审计侧证据。通用免责声明不能消除正文中的无依据承诺。

**建议**：证据应区分实际响应、模型归纳、数据性质/权限基线及独立复核状态；没有敏感性/授权差分证明时保持研究或明确待确认。不要为了堵一个案例硬编码 GeoServer 图层名单。

## Jev 实际发挥

| 职责 | 本次可观察事实 | 评价 |
|---|---|---|
| 风险 | 0 risk-grade；219 bash；0 src_http | 完全未覆盖外发，不能评估本次风险准确率，更不能称自动审批有效 |
| 委派 | 6 次 delegate 建议；0 recon/audit/verify 实际调用；5 intents 的 delegationMode 都 unknown | 建议与实际动作断开，收益没有落地；不应强制服从 Jev，但应记录 self/delegate 的选择与原因 |
| Skill | 5 次判断：3 skip；info-leak 选择置信度 0.50 未提醒；XXE 选择 0.98 成功提醒且命中读取 | 一次可证实的推荐→阅读，属于正向价值 |
| Browser | 0 browser-index；3 条宿主 browser result | 本次没有证明 Jev browser 候选选择在实际使用 |

- 11 次均未 fallback；模型遥测为 jev-1.13.0；总延迟 17.849 秒，中位 1.159 秒，最长 6.533 秒。可用性良好，但样本不足以估计正确率。
- XXE 推荐后的 skill.next-action 是 `src_list_capabilities`，attribution 明确为 temporal-only；没有 skill.outcome。不能将此自动计为“推荐导致漏洞发现”。后续走 bash，也让 src_http 的 outcome 归因链没有机会记录。
- 先前 10 月 2 日保存审查记录的 111 次 risk / 99 allow / 12 pending / 0 fallback，是旧样本，不与今天 11 次混成一个分母。那次配置事故请求被 Jev 判 high/pending，用户批准后执行；今天是风险层被旁路。两者根因不同。
- 当前 on 模式 HTTP policy 已加 DELETE 硬边界和 PUT/PATCH 与 read/compute 矛盾检查，不能继续把前轮 DELETE 误放问题原样列为“尚未修复”。但这些边界都只在其调用路径上有效。

**结论：Jev 服务可用、方法推荐有局部效果；整体接入效果不合格，瓶颈主要在执行边界与建议落地，而不是先换模型或调置信度。**

## 真实产出与任务质量

1. 默认管理员口令有无认证对照与管理员响应，证据成立。不要把持默认凭据访问称作“认证绕过”。
2. XXE 后来已有文件内容回显的日志与 fact-6，明显强于仅文件存在性错误/OOB DNS；可以认可真实产出。此处不复写敏感文件内容。
3. 匿名地理数据导出暂不能仅据示例记录确认为真实敏感业务泄露，见上文。
4. 第一次 finalize 仍称 XXE 在五个入口被拦、不可利用；后续用户在 seq 16242、20277、24392、25418 提供文章/请求/靶场线索持续纠正，最终才完成。这是“在用户推动下取得成果”，不是自动穷尽成功。
5. 唯一落盘报告来自 seq 16079，当时只有前两个 finding；随后 finding-3 新增、修订，未再调用 src_report。当前数据库/UI 与已交付文件不是同一内容版本。用户后续转向手工流程说明，因此不能断言必须自动重发报告，但 UI/产物应明确显示过期，避免把旧文件当最新交付。
6. 五个 intent 均 unknown 模式且没有子代理，独立核验没有发生。finalize 已正确指出这一点，但发布路径没有执行这条结果。

## Clean Code 七维检查

此节建议仅做行为保留重构，不与上文安全策略变更混为一批。

| 维度 | 结论 / 级别 | 位置与建议 |
|---|---|---|
| 命名 | 中：兼容 Laya 名称与 Jev 现实并存 | jev-client / tools 仍使用 layaAdvice、emitLayaDecision；保留历史 wire 名称，在内部统一 decision 类型，并记录兼容边界，勿全库机械替换 |
| 函数/SRP | 高：核心工具注册承担过多职责 | tools/index.js 3,810 行、src.js 2,175 行、store.js 1,017 行；按 HTTP 执行、审批、验收、证据注册组抽取，先固定契约测试 |
| DRY | 中：安全事实分散且已经漂移 | approval-locks / Burp bridge / prompt 分别解释审批；将目标正规化、锁标识与状态查询抽成共享契约，保留调用者职责 |
| YAGNI | 未发现足以单列的高价值问题 | 本轮不因兼容代码看起来旧就建议删除；不新增第二套调度/风控状态机 |
| 魔法数字 | 中：阈值缺少一致策略表达 | tools/index.js:2270 附近推荐置信度策略与 HTTP 后技能提示各自处理；提取命名策略常量并保留当前值与行为 |
| 结构清晰度 | 中：压缩成单行的状态/安全逻辑难审 | write-executor、http-policy 及 store 中关键转换；展开 guard 与异常分支，保留单元测试 |
| 项目规范 | 有正向实践，也存在规模压力 | 纯 leaf 模块、preset 一致性检查可保留；工具注册单体继续扩张会使边界修复难以覆盖所有入口 |

## 应保留的改进

- scoped、一次性 human approval grant 与 Jev advisory 的权限分离。
- Jev 错误转人工、供应商重定向拒绝、密钥配置不直接进入模型事件。
- JSON 写前原件快照、漂移检测与写后回读，不自动重复写或擅自补偿。
- 共享请求发送时隙、显式单 origin 检查（受控通道内）。
- 独立验证的 finding fingerprint 与 checkpoint 关联，而非只相信 verified 字符串。
- manifest 端点 tested 与真实 method/path observation 绑定。
- 产物 realpath 边界、会话归属、大小和 SHA-256 校验。

## 验证结果与测试缺口

**已执行**：
- `npm test`：281/281 通过，0 fail，约 62.3 秒。最初沙箱阻止绑定 127.0.0.1；经批准在沙箱外重跑成功。日志 `/tmp/dsh-review-tests-20261004-approved.log`。
- `npm run ui-src:typecheck`：通过，日志 `/tmp/dsh-review-typecheck.log`。
- `node scripts/check-preset-consistency.mjs`：通过。
- 全离线调用生产函数复现：跨会话同号锁丢失/误清；XML PUT 无快照仍调用假 transport。仅使用临时目录和 `.invalid` 字符串，没有网络。
- 未运行真实目标回放、生产锁竞争、额外付费模型会话或新部署。

**必须补的回归**：
1. 真实 ToolRuntime 下，主/子 bash、Python、PowerShell、MCP 的无害网络请求都遵守同一 scope/审批/速率边界；首次高风险请求也必须受控，不只测 pending 重放。
2. A/B 两个会话都创建 approval-1，批准/拒绝其中一个不会影响另一个；覆盖并发写、损坏文件、重启重建。
3. XML/文本/JSON、PUT/PATCH/POST/DELETE 逐类验证“不支持安全契约→不发送”，并覆盖人工批准后的执行路径。
4. finalize blocked 后最终发布应被拒或只能生成醒目标记的草稿；显式 limited、状态修订后旧验收失效；更新 finding 后旧报告显示 stale。
5. manifest 没有 linked coverage 时不能完整验收；示例数据/纯叙述 fact 不应自动支撑 medium+ 损失确认。
6. Jev 指标采用分母：受控请求/全部外发、风险判定覆盖率、建议→实际选择→执行→证据；不能只计成功返回与时间相邻工具。

## 修复顺序

1. **先收紧任意脚本网络出口**，纠正“全通道硬闸”文案；暂时做不到统一出口就明确禁用 SRC 模式下不受控外发。
2. 修审批锁复合主键/一致性，以及跨格式写安全契约。
3. 让验收控制最终发布，保留草稿/受限交付能力；补过期产物标记。
4. 再修 coverage、证据语义和 Jev 采用率闭环；最后做保持行为的模块拆分。

不要先以新的 prompt、更多端点白名单、关闭 Jev 或单纯调高置信度来替代上述执行边界。
