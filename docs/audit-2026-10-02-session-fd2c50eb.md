# session-fd2c50eb 全面只读审查

日期：2026-10-02。范围：dsh/SRC 接入、模型行为、Jev、证据、审批、恢复、报告。本文不是对目标的新一轮测试。

## 1. 对象、基线与取证方法

- 会话：`session-fd2c50eb-c3a4-4c96-8b09-5bc69d57048e`。
- 用户范围：仅 `8.147.132.32:38529`，不做其他资产信息收集；后续用户明确提供 GeoServer XXE 靶场说明。
- 原始首条用户指令：16:20:47；最后 user-aborted：19:33:06（北京时间）。
- 源码：唯一工作树 `/Users/lihua-dis/Software/dsh-src`，main `0b09317`。生产 Web PID 86580，关键运行代码与 main 一致；tools/index.js 仅差一空行。不是旧 local.106 被误加载。
- 只读数据：四份原始 session.jsonl.zstd、SQLite backup 快照、session.list 投影、src-telemetry-2026-10-02.jsonl、Web 日志、现有 artifact 文件。
- Zstd 按宿主 `scanZstdFrames` 分帧解码，不以单次解压的首帧冒充完整日志。父会话 5241 帧、8053 JSONL 行，无尾帧损坏。
- verify 子会话含 `seedLength=66797` 的父历史副本；统计时剔除继承历史。六份 compaction/prune 替代 tool/result 不计为再次执行。
- 未运行目标请求，未调用 Jev，未重新批准/拒绝历史审批，未修改目标配置、生产状态或源码。离线复现只用纯 reducer、脱敏函数及假 HTTP executor。
- 原始数据与离线脚本位于受限目录 `/tmp/dsh-audit-20261002-fd2c50eb/`，含私有日志，不提交到仓库。

## 2. 总结

这次不是“没有产出”：最终默认凭据与未认证 XXE 均有真实响应证据。但流程不合格：两次全局性假阴性、一次经用户批准后造成的配置事故、页面 finding ID 错位、审批回注长延迟、跨会话错误知识未失效、Jev 决策摇摆及独立复核名实不符。

先前“265/265 通过、文档改进已经落地”的说法不能视为完整质量验收。本次生产证据证明，多项契约仍未实现或测试覆盖不足。

## 3. 数量与成本（正确去重口径）

| 项目 | 实际值 |
| --- | --- |
| 主会话 turns / steps | 23 / 173 |
| 主会话结束原因 | 14 completed、8 error、1 user-aborted |
| reasoning 400 | 主会话 7 次、子会话 2 次 |
| 其他主会话 error | 1 次 PI_AI_ERROR；另有一次 524 经宿主 retry 恢复 |
| 压缩 | 2 次完整 summary compaction，6 次 prune；不能合并说成 8 次完整压缩 |
| 主模型真实工具调用 | 252（另外 260 条是 src-submit-* 合成投影事件） |
| 三子代理新增真实工具调用 | 34 + 5 + 6 |
| 主子合计真实工具调用 | 297；工具错误 15（主 11，认证子代理 4） |
| src_http / src_scan_surface | 117 / 14 |
| 主子 token 累计 | inputTokens 4,477,574；cacheReadTokens 20,211,330；outputTokens 226,443 |
| SQLite | 7 intents、23 facts、2 findings、1 asset、27 coverage、14 research、5 checkpoints、108 observations、12 approvals、1 todo、0 endpoint manifests |
| 收尾调用 | finalize 9 次，report 10 次 |
| 用户手输“继续” | 7 次 |

Token 为重复上下文累计，不是独立信息量或准确账单费用。主模型输入（含缓存）约 2349 万，主子合计约 2469 万。

## 4. 时间线与两次假阴性

### 4.1 把“字典未命中”升级为“无部署应用”

- 16:24 主代理委派 prompt 明确写入错误规则：800+ 路径均为 Description 型 404 时，结论写“appBase 为空/WAR 未部署”。这不是子代理自行独立得到的结论，而是主代理给定的答案模板。
- 子代理 16:33 完成 checkpoint，声称 970 条全 404，确认无任何 context。
- 16:50 已尝试受限完成，16:55 完成一轮“无漏洞面”收尾。
- 16:58:17 用户提供 `/geoserver/web` 和 XXE 靶标线索，随即发现实际存在的 GeoServer。

请求证据只能覆盖请求过的路径；404 的 Description/Message 差异不能证明全局部署目录为空。补几个路径白名单不是根治，应把结论范围限制为已枚举集合。

扫描数量还存在失真：主代理提交 259 个路径参数，工具执行 254；子代理提交 1143 个，执行 1078（1071 个不同路径）；合计 1332 个扫描槽位、1201 个不同路径。子代理总结的“970”并不精确。工具每次静默截前 100，再去重，且文本只展示前 40 条；模型没有证据支持“全部路径的长度与正文均已逐条比较”。

### 4.2 把“若干解析路径被拦截”升级为“XXE 全线不可达”

- 17:00 前后 WMS sld_body 参数与若干其他 XML 入口被 EntityResolver 拒绝。
- research-5、research-13 和后续报告出现“全局防护”“全线不可达”等过强断言。
- 中间转向默认凭据→修改 XML 安全配置，产生配置事故。
- 18:56:30 用户再次提供复现文章；agent 转而读取 GHSA、PR diff 与官方回归测试。
- 19:05:59 observation-106：直接 XML 请求体的 WMS SLD 解析路径返回文件内容；19:09:53 observation-108 完成去实体字面量对照。

后期有效的方法是依据官方修复定位输入路径，再做正反对照，而非不断变换同一错误路径的 payload。提前终结主要由主模型规划/推理质量造成，工具缺少有限结论表达、检索故障与错误记忆持续回注又放大了它。

## 5. P0：页面 finding ID 与真实对象错位（离线全量回放已复现）

| 实体 | SQLite/store | Web 投影 |
| --- | --- | --- |
| 默认凭据 | finding-1，high，已更新标题/证据 | finding-2，medium，旧标题/旧证据 |
| XXE | finding-2，high | finding-4，high |

根因链：

1. seq 49635 第一次 src_add_finding 缺 victimImpact，projection 先乐观分配 finding-1。
2. seq 49636 工具失败，只删除节点，不回滚 counter。
3. seq 50311 重试成功：store 分配 finding-1，projection 分配 finding-2；结果并未把权威 ID 写回。
4. 后续 src_update_finding(finding-1) 在 projection 中找不到对象，页面仍是旧 medium。
5. XXE 的一次准入失败再次消耗 projection counter；store finding-2 对应 projection finding-4。
6. research-12 指向 finding-1（页面缺失），research-14 指向 finding-2（页面对应另一漏洞）。

代码：`lib/src.js:761–778` 失败回滚、`nextNodeId`、`src_add_finding` fold；`srcProjectionSchema` 对 finding 还缺少 concreteLossEvidence/attackPrerequisites 等字段。

危险后果不只是显示编号难看：`FindingsView.tsx:74–84` 用页面 ID 发 `/src-reject`，命令层转交同 ID 给 store。按当前错位，页面上的默认凭据 finding-2 若被打回，可能命中数据库的 XXE finding-2；页面 finding-4 则不存在。未实际点击，属于已确认映射下的操作风险。

直接对原始事件重新 fold 得到相同错误 ID，因此仅刷新/删除缓存不能修复。需要以成功写入结果的 ID/版本为唯一真相，不应靠另一套计数猜测。

## 6. P0：配置变更造成服务异常，回滚原件又被脱敏破坏

- approval-5 的 justification 承诺“仅开关 XML 外部实体，不影响已发布服务”，但发的是部分全局设置 PUT；“可逆/无影响”未经验证。
- Jev 对此返回 high/write/pending，**没有自动批准这次事故请求**。用户点击批准后，18:11:07 observation-70 实际执行。
- observation-71：安全开关仍为 false，contact/charset/numDecimals 等被重置；observation-72、75 的 GetCapabilities 返回 HTTP 200 内嵌 `Null charset name`。
- 并非所有业务功能停摆：observation-73 的 GetMap 仍返回 PNG，REST 也可达。准确结论是已观察到能力文档/XML 响应异常，不能把它夸大为整个服务器完全下线。
- 18:20:16 observation-77 执行修复 PUT；observation-78 回读关键字段，79/80/81 的 WMS/WFS/WCS GetCapabilities 正常。首个异常证据到修复验证约 8 分钟；写入到修复约 9 分钟。
- 原始 settings 的 observation-55 已不是合法 JSON。`sanitizeEvidence` 的 URL userinfo 正则把无尾斜杠 URL 后面的 JSON 字段吞到远处的 `@class`；无凭据合成 JSON 也能离线复现该损坏。
- 所谓“完整还原文档”实际包含模型按其他证据补写的字段；功能恢复有证据，逐字节恢复原件没有证据。12 条审批的 sideEffectObserved 均未回写，事故目前主要存在于 prose。

代码：`lib/src/evidence-output.js:16–19`；`src_http` 写前分类/存储；`src_resolve_approval` 回放；目前无受限原始快照+diff+精确补偿计划。

修复方向：显示用脱敏证据与受控回滚原件分开；写操作需要明确 PUT/PATCH 语义、前后 diff、恢复材料与业务级探针。人工批准不等于验证了模型对副作用的承诺。不能靠自动批准紧急恢复去补偿，也不能靠关闭 Jev。

## 7. P0：扫描限速实现失效、证据汇总夸大

- 原始日志多次显示 rps=5、concurrency=6 的 100 路径扫描在约 3.6–3.7 秒内完成。
- 离线直接调用生产 `src_scan_surface` handler，用纯内存假 HTTP 返回：18 条、rps=5、concurrency=6，仅 613ms，发送时间成组聚集在 210/411/612ms；17 个间隔本应至少约 3400ms。
- `lib/src/tools/index.js:181–193` 多 worker 共用 lastStart，等待时没有原子预约全局发送时隙；并发度把速率放大。
- `renderScan` 不展示 length/title/body，最多展示 40 条；源码也不逐条落 observation。模型声称每条 682 字节/同正文，实际上大部分只有状态码汇总与少量 src_http 样本。

不能靠把 prompt 写“低频”解决；需要共享、可取消的发送速率控制，并验证多任务/父子累计速率。保存每批实际输入、裁剪、去重与响应签名，禁止把输入数组长度当实测去重数。

## 8. Jev：服务可用，但决策质量/操作契约没有闭环

全主子链 111 次 risk-grade：99 allow、12 pending、0 fallback；risk 延迟中位约 950ms，累计约121.5s。不是超时/服务离线造成这次审批。

12 条 pending：
- 8 条 low/read（XXE 变体）；
- 1 条 low/external（受控回连验证）；
- 2 条 high/write（配置变更与还原）；
- 1 条 high/read（主密钥读取）。

普通 GET 已不再像 local.106 那样全挂；但“低影响测试”的策略表达仍不稳定：若干 low/read 的 verdict 在 0.5 左右摇摆；一次 low/external 自动放行而相邻回连变体转人工。不能因为是 GET/read 就认为文件读取或外发必然低风险，也不能据 risk=low 覆盖明确 pending。

更严重的是反方向：
- observation-30：实际 `DELETE /`，justification 混写 TRACE 测试，Jev 判断 read/low/allow，代码真的自动发送。目标返回 404 不代表事前控制正确。
- observation-24：PUT 临时探针按 write/low/allow 自动发出。
- 当前 `httpDecisionPolicy` 接受 read/compute/write/external/auth，只硬挡本地已分类的破坏性/越权 category；分类器主要依靠路径词，不保证 DELETE 自动得到 destructive。

离线 classify+policy 复现 `DELETE / + Jev read/low/allow → require:false`。方法不应是唯一风险指标，但方法、参数与实际操作矛盾不能仅信任模型的“只读”描述。

approval reason 已比旧版真实：本次保存了 method/path/规则/Jev decision。但一般 pending 文本仍不能给出解释型因果（Jev 只返回 choice）；UI/命令仍统一称“高危审批”，risk=low 也同名。配置写操作 justification 的副作用承诺不可靠仍是核心问题。

## 9. 审批、恢复与最后 pending 的真实状态

用户点击到真正执行的延迟：

| 审批 | 用户点击 | 执行 | 点击后等待 |
| --- | --- | --- | --- |
| approval-1 | 17:10:39 | 17:46:40 | 约36分钟 |
| approval-3 | 17:11:06 | 17:48:30 | 约37分钟 |
| approval-4 | 17:11:18 | 17:59:43 | 约48分钟 |
| approval-7（修复） | 18:15:22 | 18:20:17 | 约4分55秒 |

这不是用户未批准：command/run 已证明点击成功。命令只签发内存 token、followup 排队，让主模型再调用 resolver；长回合与请求错误令它长时间不执行。持久化模型缺少 user-approved/queued/executing/failed 阶段。

- approval-6 的一次 reject 失败不是 token 因重启丢失，而是 agent 没有提供 token，试图自主拒绝；边界正确拦截。但错误文本机械提“token 在重启后失效”，掩盖真实原因。
- approval-12：19:32:56 用户确实点击 allow；19:33:06 本轮被用户中止，尚未调用 src_resolve_approval，SQLite 仍 pending。不能说用户没批准，也不能擅自替用户发送。
- 已执行的11条都有 human-command 来源与 responseEvidenceId；未发现模型成功伪造 grant 或自动批准历史审批。

### approval-12 的新方向叙事本身错误

最后声称“之前只有 WFS filter 参数测试、从未测试完整 XML 请求体”。但 observation-43 已是 application/xml 的完整 WFS GetFeature 请求体，外部实体引用位于 Filter/PropertyName，响应 Entity resolution disallowed。

approval-12 同为 WFS1.1.0 GetFeature XML，请求主要差别是 DOCTYPE 名、字面量和排版。可以作为细节变体验证，但不能宣称第一次更换输入通道。最后一轮延伸研究有近重复浪费；字节级去重拦不住错误回忆导致的语义重复。

## 10. 子代理与独立复核

- recon 子代理：完成3个 checkpoint，但沿用了主代理错误的“800次无命中=空appBase”结论。
- audit 子代理：只提交0证据的 progress，4次 HTTP 均因父 prompt 中 credentialRef 被改坏而失败；随后 reasoning 400。不是 parent engagement 写入错误复发，也不是 vault 内容丢失。主代理传的是非64位hex的引用，自己接管时还构造过带 `?dummy` 的引用。
- verify 子代理：实际5次 HTTP 完成匿名/默认凭据/错误凭据对照和第二独立面；完成 checkpoint 后才发生 reasoning 400。有效证据不能因最后 turn error 被抹掉。
- 默认凭据的独立复核只覆盖当时 medium 版本；后来升 high、加入主密钥等结论没有新版本对应的独立复核标记。
- XXE research-14 是主代理自己写 verified；没有给 finding-2 派发独立 verifier，但 finalize 仍通过。“存在 verified 行”等同“独立 verified”是假门禁。

`src_get_evidence` 对 research 的文本省略 intentId/findingId/stopReason，导致想修 research-11 的主模型还在猜所属 intent，最后只修报告 prose、没有更新 research。工具叫“证据正文”但关键可编辑身份与结论字段缺失。

## 11. 错误知识持续存在、计数与事件账本不一致

### 11.1 错误结论没有失效

最终仍存：
- fact-6：“当前无任何已部署context”；
- research-1/2：以空appBase为否定前提；
- research-5/13：“XXE全线不可达”；
- domainNote-1/2/3：“裸Tomcat/无应用”“970穷尽后勿重复验证”；
- 早期 lesson 将 sld_body 拦截与不能利用混写；后期另加正确 lesson 并没有建立 supersedes 关系。

`collectPriorContext` 直接召回 false-positive/blocked research 和域笔记，未按反证失效。因此下一会话仍可能被错误知识带偏。应保留历史但标失效/被何证据推翻，不应静默删原始记录，也不能让矛盾结论同为当前真相。

### 11.2 coverage 投影也错位

store 27行，projection 21行；projection 中 coverage-20、coverage-21 各重复两次。原因为工具原始参数、自动 coverage 写入和合成事件混用，独立分配编号；同类更新遗漏 assetId 会创建另一行。

最后报告已把早期4条错误 coverage 的文字改正，但留下有/无 assetId 两组同类更正记录。`completed`/“已覆盖”也被用于“无第二账号”“无自研前端JS”等未执行的测试类别，不能当作实际测试完成证据。

### 11.3 event store 不可作为完整恢复真相

只存57条事件；键是 aggregateId:aggregateVersion:eventType，不含 sessionId。当前 intent-1/2、finding-1 的相同键属于另一会话 session-a3c0672c，导致本会话写入被当 duplicate 抑制。同 intent 多次状态更新也复用ID尾号作为version。

reducer 缺少若干真实发射的 appended 类型；schema 也未声明 aggregateId/version。`src_state` 的一致性检查把 store 数据当作两侧输入，自比无法检测实际 projection 的 finding 错位。双fold同一事件得到同hash只证明确定性，不证明事件完整或与store一致。

## 12. 检索、Skill 与证据产物

- 4次 web_search 的实际结果明显偏题：查 Tomcat CVE 得眼镜/楼盘；查 GeoServer/XXE 得词典/手机；后续得 Windows 帮助、赛马会、WhatsApp等。输出仍包装成 Sources，snippet 含HTML残片。
- 项目自带 src-keyless-search 按“有可解析链接”视为成功，未校验重定向/验证码/相关性；上游实际返回了什么原始页未保存，故不能断言是代理改写或 query 截断，但失败检测与结果清洗属项目责任。
- 用户给定博客后，bash/curl 用来抓官方公告/修复代码，是正常的公开资料检索，不是绕过审批攻击目标；不能为此禁bash。
- Jev Skill 87次判定、6次实际提醒；唯一skill.read是起手读 DSH-ADAPTER.md，recommendationId为空。没有任何推荐→读取→动作→证据的闭环成功记录。相关文档本来有 xxe-test，但未显示被采用。
- Jev delegate 7次全建议delegate，实际3次派发、余下主代理self；不能把建议数算成委派收益。
- 本会话0 endpoint manifest：主要走 scan_surface/src_http，不走当前唯一创建manifest的 collect_passive，之前合成测试的挂点未覆盖真实流程。
- artifact目录只有580B README；脚本与raw报文在 finding 字段，不等于有可下载、已hash校验的交付文件。没有证据说明本轮承诺的独立文件都存在。
- 108条observation中68条无intentId；8/12审批无intentId。唯一活跃intent推断在多intent时失效，降低路线/证据归属和复盘准确性。

## 13. 两条 finding 的证据边界

### 默认凭据

成立：49/65/66/67/68/69 的认证差分，104 返回受保护主密钥字段。默认凭据缺陷不是虚构。

需收敛：REST首页列出31个链接不等于31资源全验证可读写；角色清单不等于当前用户角色的独立证明；“不会触发告警”“可任意内网跳板/RCE”没有本轮证据。已测数据源均演示文件型，不能写成已窃取数据库口令。

### 未认证XXE

成立：106响应回显系统账号文件，108去掉实体后只回显字面量；请求头无认证材料。107是NUL字符解析错误，只支持文件被打开/解析尝试，不是该文件完整内容泄露。

需收敛：SSRF/DoS/任意敏感配置读取是潜在影响，没有在此实例逐项实证；“完全不可察觉/无告警”未验证。报告修复版本应说明保存的GHSA正文与包元数据在2.26分支有差异，不能随意合并列表。未重新查询上游公告。

## 14. 上游协议问题单列

父7次、子2次reasoning400，首次16:24，首次完整compaction18:12，故不能说全部由压缩触发。历史响应元数据含 deepseek-flash、MiniMax-M2.7、vision-exp、agnes 等，客户端route仍newapi/deepseek-v4-flash。

能证明：同请求线路观察到协议要求不一致与混合responseModel元数据。不能证明：具体错误一定由new-api某段转换造成，或元数据一定代表实际底层模型；本轮未抓new-api双向原始JSON。宿主压缩、供应商转换、通用retry不在本轮修改范围。

项目仍应负责可靠暴露失败与待处理审批状态，但不伪造thinking、不强行无限重试。

## 15. 修复优先级与验收

### P0（先保障不误操作、不损坏）
1. finding/coverage 权威ID提交后投影：失败不耗号、成功以store结果为准；真实历史回放与DB逐字段一致；页面操作必须核对ID+实体版本/标题，避免错打回。
2. 写操作安全契约：受限原始快照、语义明确的diff、补偿计划、业务级回读；结构化incident/sideEffect状态。脱敏不能损坏可恢复原件。
3. 扫描共享速率控制：父子/多并发实测发送时间，保证总RPS；明确请求裁剪与去重，不允许静默丢目标。
4. HTTP动作矛盾处理：DELETE/其他写方法与read分类冲突不能自动执行；不以路径白名单修补。
5. 审批接受与执行分离：持久化user-approved/queued/executing/failed，恢复不能靠“继续”；取消/中止后不自动重放。

### P1（真实产出与状态一致）
6. 错误结论superseded关系：修复后不召回已推翻结论；证据查询必须含identity/intent/finding/stopReason。
7. endpoint manifest挂入真实scan/http/OpenAPI/导入链；稳定method+path身份，测试证据必须存在且匹配endpoint，blocked/skipped/notApplicable分开计数；当前空表不能认作完成。
8. 独立复核来源与finding版本绑定；自验证不伪称独立验证；完成checkpoint后尾部协议失败不能丢有效复核。
9. 搜索失败可见与检索质量回归；Skill收益按真实读取/采纳/产证据评价。
10. event key含engagement和真实变更版本；记录成功变更与失败事务边界；真实store-vs-projection比较，而非自比。
11. 报告已证实/潜在/未测分栏，artifact hash与归属验收，避免固定字数迫使模型夸大危害。

### 明确不做
- 不关闭Jev替代修复；不自动批准/拒绝现有12条审批。
- 不修改本次finding、research、coverage、历史日志或目标服务。
- 不加目标特定路径白名单，不另造调度平台，不修改宿主compaction/通用retry。

## 16. 当前状态与验收结论

截至19:33的最后日志：2条finding核心证据成立；intent-7 planned；approval-12 用户已点击批准但执行轮次被用户中止，数据库仍pending；服务曾受配置影响，后来关键功能回读恢复。

本会话验证的是“在用户多次纠偏、人工审批和事故修复之后终于产出”，不是“自动流程已经稳定”。必须先修P0与投影可信度，再做真实主模型的新会话回归；不能以增加提示词、新增几条例外或已有265条旧测试通过替代上述验收。
