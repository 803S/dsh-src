# Laya 接入修复实施记录（2026-09-29）

版本：local.105。基线：7bf6c95/local.104。代码与隔离测试已完成，部署结果见文末。

## 已确认边界
- 本地 Laya 接收实际任务、请求头、请求体，不默认脱敏或压成布尔值；永久遥测不复制这些输入和凭据。
- 保留风险提示、简单任务的 delegate/self/pending 提示、直接相关文档推荐及外部 browser-index。复杂规划、漏洞真假、利用链、最终审批和实际分工采纳不交给 Laya。
- 默认120秒等待，DSH_SRC_LAYA_TIMEOUT_MS 惰性可配置；无短时熔断、无按错误追加端点白名单。
- 用户指出验证成本失控后，本次收尾不再运行付费模型测试。

## 已落实

### A 子代理模型与恢复
- 新增 `lib/src-subagent.js`，三个 SRC 委派工具仍使用宿主 start/startContinuable，不复制调度器、运行时或权限体系。保留 persona/toolFilter/maxDepth。
- 默认使用父会话已记录请求中的实际 provider/model，不再只用创建时 parent.options；显式 agentOptions 优先。
- 委派参数增加真实 intentId，宿主 pre-execute 校验存在性；结果显示模型来源及 queued/completed/error。
- src_recover_child 默认保留子模型；显式 inheritParentModel=true 才用父当前配置。配置错误不能靠盲目唤醒修复。模型切换经过 agent/request 与 prompt assembly 钩子，下一次请求由宿主正常落日志。
- 恢复只记 recovery-queued；失败入队恢复原次数，不清空已有次数；保留原四次预算。子代理运行/结束及 checkpoint 分开观测。
- 覆盖：真实 ToolRuntime fixture 验证父有效模型/显式子模型/失败入队/跨父隔离/请求与提示词模型一致；上一轮本地授权靶场的真实子模型已经完成1次GET、1条fact、1个completed checkpoint。

### B 建议、执行与投影
- 删除 rules-fallback 和按正文长度猜步骤数的代判；失败/复杂不明为 pending，不伪装 self/delegate。
- shadow 只写遥测，不将建议写入 store 或模型输出；on 提示明确不是派发事实。
- 建intent缺省 unknown；host-spawn/child-checkpoint/commander 区分执行来源；显式接管由 src_update_intent 写回。
- 新增 src_intent_runtime 合成事件同步投影。保留带callId的旧更新事件回放，失败更新恢复原intent，避免升级后历史状态丢失。
- 时间线展示实际执行来源及建议，两者分开；终止通知不覆盖completed/blocked/failed checkpoint。收尾不再仅凭Laya self建议豁免checkpoint。

### C Skill
- 模块显式导入文件系统依赖，修复原作用域引用错误被吞掉的问题。
- 安装知识库与lessons合并召回；任务标题/正文/目的为主要信号，中文分词支持两字术语，无API/model端点停用词补丁。文件读取失败有遥测，不缓存空内容。
- 文档身份=安装根/文件/内容版本；读取过或提醒过的同版本文档在推理前排除。更新文件可重新推荐，失效安装不伪造可读指针。
- Laya只选doc-N短候选编号，代码映射回真实文档，拒绝越界返回。
- 推荐→读取→实际工具结果→HTTP证据的recommendationId可联通；动作在成功结果后统计，不统计被repeat guard拒绝的调用。后续证据仅是时间关联，不声称因果收益。
- 正分候选及直接文档匹配仍是轻量召回，不声称已经实现全语义检索或复杂Skill规划。

### D 风险与审批
- 实际请求及当前intent/justification进入本地输入；未知请求率不再伪造为0。正常响应也展示低层风险提示；shadow不展示。
- 严格校验选择、分数和置信度；保存统计不复制请求秘密。Laya仍不改变classifyHttpRequest/human approval的执行权限。
- 撤销body含query/schema等字串即只读的特例及重复分支；认证识别支持API-key。
- 删除生产DSH_SRC_ALLOW_LEGACY_MODEL_APPROVAL测试后门；fixture改为显式签发一次性grant。
- token重启后失效，错误明确要求用户重新批准；没有实现跨进程持久化grant。
- **没有宣称降低了实际误审批率**。未知POST仍可能按保守规则挂起；本轮用户明确禁止Laya承担最终审批，不能借“减少审批”扩大它的权限。

### E 等待与观测
- timeout/cancelled/network/http-N/json/schema分开记录；无熔断。取消后不再发目标HTTP。
- 只缓存完全相同的成功分工/文档建议（60秒、256项），键包含输入、会话、DSH_HOME、端点、身份与mode；HTTP风险不缓存，不跨身份沿用。
- daemon保持单线程推理，新增inferenceMs/handlerMs/preHandlerMs。preHandlerMs包含传输和内核排队，**不是纯排队时长**；客户端取消不代表服务端推理被取消。
- aggregate输出调用/缓存/错误/耗时，以及恢复入队/实际运行/检查点；不把allow率当正确率。

### F 收尾、构建与发布
- finalize新增completionStatus=complete/limited/blocked；受限完成保留阻断项，不说“已解决”。
- 新增check-web-idle.mjs，验证session.list JSON中的running字段，不以SPA HTTP200推断健康；启动脚本不能确认空闲就拒绝重启。
- 补齐部署文件、package exports及UI类型；构建使用项目自身tsc/tsdown，避免shell PATH错误。

## 验证记录与限制
- 最终全量回归：252项，251通过；唯一失败为受限完成旧文案断言，已更新并单独复验（结果见发布记录）。不是忽略业务失败。
- UI typecheck、preset一致性、语法/diff检查通过。UI构建成功，原tsdown/rolldown版本组合仍有define/import.meta警告；未为此次修改升级构建依赖。
- 上一轮真实模型隔离验证：`/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-blind-eval-WXUAGc`。子代理deepseek-v4-flash确实完成首页读取与checkpoint，父会话达到180秒预算，**整次评测不是完成验收，也不是漏洞质量提升证据**。
- 更早首轮因routeForChild对空override解引用失败，已修复并补普通父会话assembly负例。评测器零步退出不再标completed。
- 本地Laya接口此前已返回合法risk/delegate/skill结果，置信度偏低；不据单个样本宣称准确率。
- 本轮未重放真实目标、批准遗留请求、修改历史finding/审批或重启browser后端。
- 长期A/B、误审批率/文档推荐准确率需真实运行样本；不在本轮继续消耗付费调用追求数字。

## 发布记录
待写入：提交、备份路径、部署哈希核对及启动API检查。代码完成不等于这栏已完成。
