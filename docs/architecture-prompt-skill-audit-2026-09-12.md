# dsh-src 架构、提示词与 Skill 路由审计报告

审计日期：2026-09-12  
审计范围：运行时编排、持久化与会话投影、主提示词、playbook/skill 路由、能力清单、测试与可观测性。  
审计方法：静态阅读核心实现、规则与能力文档，检查最近提交与回归测试，并运行仓库现有检查。

## 执行摘要

当前系统已经具备比较完整的 SRC 业务协议：goal、intent、fact、finding、审批、待办、资产、覆盖度、报告和恢复路径都有明确的数据结构与门禁。问题不在于“没有规则”，而在于规则、编排和反馈的分工不清。

结论排序如下：

1. **首要问题是编排架构**。大量异步状态机仍由模型通过提示词手动推进：创建 intent、委派、等待 completion、checkpoint、发现 orphan、恢复、收官前补缺都依赖模型正确调用工具。服务端只保存和校验状态，没有一个独立的 planner/scheduler/event consumer 把状态自动推进起来。
2. **主提示词过载，但不是唯一根因**。`SRC_INSTRUCTIONS` 当前约 7,931 个 Unicode 字符、111 行；长度本身并非灾难性问题，真正的问题是它把授权政策、状态机、能力路由、故障恢复、报告格式、语言纪律和安全边界全部塞进每轮决策上下文。约束密度高、顺序要求多、同一语义在多处重复，容易导致工具参数错误、遗漏和规则冲突。
3. **Skill 激活率目前无法被证明或诊断**。playbook 是 17 个方向的静态 substring 匹配，能力清单的 `when` 只是自然语言提示；系统没有记录“被推荐→被读取→被执行→改变了哪次行动→结果如何”的漏斗。因此低产出不能直接归因于模型没有激活 skill。
4. **Durable store 与 session projection 形成双语义系统**。同一业务语义分别由 storage domain 和 projection reducer 实现，并通过 synthetic events、委派投影补写和自愈逻辑保持一致。这种设计可工作，但一致性成本和回归风险已经很高。
5. **规则来源过多且重复**。`SRC_INSTRUCTIONS`、工具 description、`store` 门禁、playbook、`SKILL.md`、rules 和知识库都在描述 finding 准入、授权、报告和推进纪律。实际强制法律主要在服务端，其他层应更多承担解释和建议，否则会出现语义漂移。
因此，当前最合理的判断是：**架构/编排问题是主因，提示词过载是放大器，所谓 skill 激活率低只是尚未观测清楚的表象**。

## 证据与问题分级

### P0：状态机由模型承担，缺少自动编排闭环

主提示词要求模型同时负责：先建 goal 和 intent、读取 playbook、委派子 agent、结束当前回合、等待 completion event、补 checkpoint、检查 orphan、定向恢复、处理 pending approval、推导新 intent、补 coverage，最后执行 finalize。相关规则集中在 [lib/src.js:43-146](../lib/src.js:43)。

服务端虽然有 intent 生命周期、去重、待办和恢复接口，但 `src_add_intent` 只写记录，`src_update_intent` 主要接受模型传来的状态，`src_recover_child` 需要模型识别并手动调用；`src_finalize_engagement` 只做检查，不能把缺失的待办或后续 intent 自动放入队列。结果是模型必须维护一个跨轮、跨子会话、带依赖关系的异步状态机。

直接后果包括：

- 子代理没有 checkpoint 时，系统知道“缺失”，但不会自动安排补救动作。
- `running`、`orphan`、`blocked` 和待办之间可能出现长尾状态，模型容易重复查看或重复委派。
- 低 completion、重复调用和收官阻塞很容易被误判为 skill 没激活，实际上可能是编排断点。

建议建立独立的 engagement orchestrator：由事件驱动的 planner 根据状态生成可执行队列，负责依赖、超时、重试预算、恢复和幂等；模型只做优先级和研究判断。`src_state` 应输出下一步动作队列和阻塞原因，而不是要求模型从大段文本自行推理全部状态。

### P1：持久化图与会话投影存在一致性风险

`lib/src.js` 同时包含 projection wire schema、`applySrcEvent` reducer、synthetic event 登记和 session projection 注册（见 [lib/src.js:148-155](../lib/src.js:148)、[lib/src.js:951](../lib/src.js:951)、[lib/src.js:1763-1825](../lib/src.js:1763)）。`lib/src/store.js` 则维护 durable domain 和实际门禁。两套实现通过事件镜像保持相同的 intent、fact、finding、todo 和 approval 视图。

这种双写/双 fold 设计的风险不是理论上的：代码中已经有防止 undefined 字段、投影缺 intent/fact/finding、委派结果过期、schema strip 和 synthetic event 白名单的修补逻辑。任何新增工具或状态字段都需要同时更新 store、projection schema、reducer、工具输出和测试，遗漏一处就会出现“持久化有记录、模型看不到”或反过来的分歧。

建议逐步收敛为单一事件模型：持久化领域事件作为事实来源，projection 只做纯渲染；新增状态只能通过领域命令产生事件，禁止在多个层分别拼接同一语义。补充 property-based replay 测试，长期比较 store snapshot 与 projection fold 的关键字段。

### P1：规则法律重复，导致提示词和文档语义漂移

finding 准入至少同时出现在：主提示词的“漏洞质量标准”段落、工具 schema/description、`store.addFinding` 的实际校验（[lib/src/store.js:228-286](../lib/src/store.js:228)），以及 clown skill 的 `SKILL.md`、rules 和知识库。授权、Burp、待办、报告字段和能力使用也有类似重复。

重复的短期效果是提醒更多，长期效果是修改困难：一条规则改了服务端但忘记同步 prompt，或 skill 文档仍保留旧门槛，模型就会收到多个版本。应明确优先级：

1. store/schema 是可执行法律；
2. 工具 description 只解释参数和失败原因；
3. 主 prompt 只保留不可编码的决策原则和少量流程骨架；
4. skill 文档只提供某一专题的打法、证据和边界，不复制通用协议。

### P2：Skill 路由是关键词匹配，不是可观测的语义路由

[lib/src/playbooks.js:10-136](../lib/src/playbooks.js:10) 定义 17 个方向。`routePlaybook` 把 title/detail 归一化后做 `input.includes(term)`；多方向可以同时命中，零命中时默认回退到 `recon`。这里没有置信度、优先级、冲突消解、负例或“未选择某 route 的原因”。

这会产生三类误差：中文同义表达漏匹配；普通词（例如“上传”“业务”“接口”）触发过宽；多个 route 同时命中导致文档和 checks 变多。它能告诉系统“标题里出现了词”，不能告诉系统“该 skill 对当前目标有用”。

能力清单中的 `when` 也只是展示字段。[capabilities.yaml:12-31](../capabilities.yaml:12) 没有自动选择器；skill 型能力还要经过 `src_list_capabilities`、`src_read_capability`、审批后的 `src_run_capability`，每一步都靠模型主动完成。当前没有 activation telemetry，所以不能给出真实激活率。

建议引入结构化 skill manifest：输入契约、适用资产、前置条件、禁止场景、输出 schema、成本和风险等级；路由返回候选及分数，并把选择理由写入 intent。对每个能力记录 offered、read、run、approval、outcome 和 outcome-linked evidence，保留人工 override。

### P2：主运行时与工具注册文件边界过宽

[lib/src.js](../lib/src.js) 约 2,095 行，混合 prompt、projection、目标解析、能力 YAML、脚本执行、网络请求、Burp 探测、配置加载、store composition 和工具接线。[lib/src/tools/index.js](../lib/src/tools/index.js) 约 3,017 行，一次注册约 44 个 SRC 工具。文件大小不是单独的故障，但它使领域模型、网络执行、安全策略、编排和提示词层互相引用，修改协议的影响面难以评估。

建议按边界拆分：`domain/`（schema、commands、events）、`projection/`、`orchestrator/`、`capabilities/`、`transport/`、`tools/` 和 `prompt/`。先抽出 orchestrator 和 capability registry，再拆网络与报告模块，避免一次性重写。

### P2：`src_state` 是多用途长文本，而不是决策接口

`lib/src/tools/index.js:2267` 起的 `src_state` 同时输出 playbook、facts、todo、approval、orphan、delegation、scope、asset gap、覆盖率和收官提示，并在约 `2452` 行进行事实预算截断。已有预算是正确方向，但状态仍混合了调试、恢复、进度、建议和报告前置检查。

建议提供结构化视图：`nextActions`、`blockedReasons`、`runningWork`、`evidenceIndex`、`skillHints`、`finalizeBlockers` 分开返回；文本摘要只用于人类面板。模型默认读取最小决策视图，需要证据时按 ID 取详情。

## 对三个核心疑问的直接回答

### 提示词是不是太长、太烂？

不是单纯“太长”，而是**职责过多、规则密度过高、法律重复**。约 7.9k 字符在现代上下文窗口内并不夸张，但它让每轮模型都携带 45 个左右的规则段落和大量顺序约束。更严重的是，很多内容已经由工具 schema 和 store 强制执行，继续把同一规则写入主 prompt 只会增加冲突面。

建议把主 prompt 压到三个区块：当前角色与授权原则、四步主循环、失败时的最小恢复原则。字段细则、审批、报告模板、Burp 说明和专题打法移到工具错误、结构化状态和按需 skill 文档。目标不是追求最短字符数，而是减少模型需要同时记住的状态变量。

### 是不是 Skill 激活率低？

目前不能下这个结论。系统只记录 route 的关键词命中和能力是否存在，没有记录 skill 是否被读取、读取后是否被执行、执行是否产生证据。因此“激活率”没有定义，也没有分母。

可以先定义漏斗：

`candidate offered → route selected → skill read → capability run → approval resolved → evidence produced → finding/research linked`。

按 intent、route、资产类型和模型版本计算每一段的转化率，才能区分路由漏命中、模型不遵循、审批摩擦、能力失败和结果不相关。

### 主要应该先改什么？

先改可观测性和编排边界，再改 prompt 和路由。盲目继续压缩文字，或重新加入没有反馈的机械触发器，都可能把问题藏起来而没有改善完成率。

## 测试与验证评估

现有 [tests/src.integration.test.mjs](../tests/src.integration.test.mjs) 约 4,624 行，覆盖协议回归、store 门禁、projection replay、审批、能力安装、lesson 触发、playbook 路由、输出预算、orphan/delegation、靶场端到端和报告。它适合证明工具协议没有明显回归，但不能衡量真实 agent 质量。

缺失的评估包括：真实模型下的 route precision/recall、skill read 后的行为变化、多轮工具选择准确率、上下文膨胀、委派完成率、恢复成功率、重复调用率、projection/store 长期一致性，以及规则冲突时的优先级行为。

本次运行结果：

- `node scripts/check-preset-consistency.mjs` 通过：工具级 description 合计 13,106，协议预算和 lessons 预算均通过。
- `npm test` 在允许本地 mock HTTP server 的环境中通过：168 个测试全部通过，0 个失败，耗时约 23.8 秒。此前沙箱运行时出现的 `listen EPERM` 属于环境限制，不计为项目回归。

## 建议的修复路线

### 第一阶段：建立 trace 和指标

为每个 intent、route、capability 和 tool call 记录 correlation id、父子关系、模型版本、prompt token 数、候选 route、最终选择、skill read/run、审批等待、checkpoint、完成、失败和恢复。先得到真实漏斗，再决定是路由问题还是模型遵循问题。

### 第二阶段：把硬状态机移出 prompt

增加 orchestrator/scheduler：

- intent 建立后生成待执行项和依赖；
- completion、checkpoint、approval、todo、child failure 作为事件驱动状态迁移；
- 为每个 child 设置超时、重试预算和幂等键；
- 自动把 orphan 转为可恢复队列；
- finalize 只检查队列和证据，不让模型手工扫描所有状态。

### 第三阶段：统一规则来源并缩短主 prompt

将 store/schema 定为唯一可执行法律，工具 description 只保留参数、前置条件和错误修复信息。主 prompt 仅保留角色、授权、目标循环、委派原则和最小恢复原则。专题规则按 route 按需加载，禁止在 SKILL.md、rules、知识库和 prompt 中复制通用协议。

### 第四阶段：改造 Skill registry 和路由

把每个 skill 改为 manifest + 文档 + 白名单能力：资产类型、关键词仅作召回，结构化前置条件和输出 schema 作重排；返回 top-k 候选、分数、冲突和理由。将 `read` 结果摘要绑定到后续 intent 或 capability call，避免“读过但没有改变行为”。

### 第五阶段：拆分运行时边界

优先从 `lib/src.js` 抽出 orchestrator、capability loader 和 projection，再拆 transport/network 与 report builder。每次拆分后运行现有协议回归和 replay property test，避免大规模重写。

## 建议长期跟踪的指标

| 指标 | 定义 | 用途 |
|---|---|---|
| route precision/recall | 人工标注的适用 route 与系统 top-k 的重合 | 判断关键词路由质量 |
| skill funnel | offered/read/run/outcome 各阶段转化 | 区分激活、审批和执行问题 |
| intent funnel | created/delegated/checkpoint/completed | 判断编排断点 |
| orphan/recovery rate | orphan 数、恢复成功率、平均恢复次数 | 判断异步可靠性 |
| duplicate tool call rate | 同 intent、同参数的重复调用比例 | 判断状态可见性和幂等性 |
| prompt token share | system、tool description、state、skill 各占比 | 找出上下文膨胀来源 |
| state truncation rate | facts/observations 被预算截断的比例 | 判断模型是否看不到关键证据 |
| projection divergence | store 与 replay projection 的字段差异 | 监控双语义一致性 |
| finding acceptance rate | 提交 finding 后通过/打回比例 | 判断证据质量和 skill 价值 |

## 不建议当前立即做的事情

- 继续以“字符数更少”为唯一目标压缩主 prompt。
- 再增加更多规则文件或把同一门禁复制到更多文档。
- 用关键词命中次数直接代表 skill 激活率。
- 在没有 trace 和人工 override 的情况下重新引入机械触发器。
- 把本地能力配置当作业务编排逻辑使用，导致配置加载和调度边界继续耦合。

## 最终判断

系统的问题呈现为 skill 没有被充分使用，但根因更接近：**模型被要求承担过多编排责任，规则存在多个真相来源，路由和能力执行没有结果反馈，状态还要在 durable store 与 projection 之间保持双份一致**。先补 telemetry 和 orchestrator，随后收敛规则来源并把 prompt 改成薄薄的决策协议，最后再用数据优化 skill 路由，收益和可验证性最高。

## 重点复盘：顺丰考勤系统会话

### 会话范围与统计口径

本节只引用本机保存的 dsh 会话记录，不重新访问顺丰目标。主会话是 `session-77038149-c955-408b-b65b-377766d82e21`，标题为“顺丰考勤系统渗透测试”，原始记录在 [/Users/lihua-dis/.dsh/sessions/--Users-lihua-dis-Software-Src-Pedestal-src-domain-ready--/session-77038149-c955-408b-b65b-377766d82e21/session.jsonl.zstd](/Users/lihua-dis/.dsh/sessions/--Users-lihua-dis-Software-Src-Pedestal-src-domain-ready--/session-77038149-c955-408b-b65b-377766d82e21/session.jsonl.zstd)。主会话包含 42 个 turn、138 个 step、290 次结构化 `tool/call`，发生 6 次 `compaction/prune`，记录中出现 8 次 provider unavailable。主会话最终状态约为 11 个 intent、97 个 fact、11 个 asset、1 个 finding；`src_report` 成功调用 4 次，`src_finalize_engagement` 成功调用 1 次，`src_add_finding` 只有 1 次。

顺丰会话家族由主会话和 8 个子会话组成。家族合计 1000 次结构化工具调用，其中主会话 290 次、子会话 710 次；`src_http` 103 次、`src_resolve_approval` 72 次、`src_record_pending_approval` 51 次、`src_submit` 26 次、`src_read_lesson` 9 次。72 次是审批解析调用总数，其中 13 次进入实际 HTTP 重放路径；两类调用在历史记录中都没有把响应体完整交给模型。家族中 `src_list_capabilities`、`src_read_capability`、`src_run_capability` 均为 0 次。这里的“0 次”是能力工具闭环的真实调用次数，不等于没有 playbook 文档命中，也不等于模型没有手写脚本或直接使用普通 HTTP/浏览器工具。

### 交付为什么被约束阻断

这次会话的关键失败不是“没有找到事实”。模型已经完成了报告生成和收官校验，图中也有大量请求、响应和覆盖记录，但唯一入库 finding 是 low。旧版协议把“报告停止前必须确认 medium 及以上 finding”放在收官纪律里，导致 agent 在 `finalize` 成功、报告多次成功生成之后仍不愿交付。它继续追击第二个 finding，约 13 个 turn 后才因 provider unavailable 和 oversized prompt 终止。用户视角得到的不是“一个低危报告加覆盖限制”，而是没有明确收尾的结果。

这说明两条规则之间发生了产品层面的冲突：finding 质量门禁保护了中高危定级，但被错误地扩展成了报告交付门槛；收官流程又要求模型自行判断是否还有方向、是否要补证、是否可以停。当前代码已经删除 medium+ 报告门槛，并允许“未授权可达 + 可复现 PoC”以 low 入库；这修复了协议设计，但旧会话的 1 个 finding 不会因为代码更新而自动变成 16 个，也不能替代对授权目标的复测。

### 状态和上下文的实际代价

97 个 fact 被反复放入状态上下文，叠加 11 个 asset、intent/checkpoint、lesson 提示和工具描述，触发了 6 次压缩。压缩不是单纯的模型偏好问题：`src_state` 同时承担进度面板、证据浏览器、恢复队列、覆盖检查和收官提示，模型每轮都必须从混合长文本中重新推导下一动作。它还继续输出与当前阶段无关的 submission-quality 提醒，使已成功 finalize 的会话重新回到“还要证明更高危”的心理路径。

因此，`src_state` 输出预算和事实分级是必要修复，但它们只是止血措施。长期应返回结构化的 `nextActions`、`blockedReasons`、`runningWork`、`evidenceIndex` 和 `finalizeBlockers`；证据正文按 id 拉取，而不是每轮将事实图做成一段新的长文本。

### Skill 闭环的真实情况

主会话没有 `src_list_capabilities`、`src_read_capability`、`src_run_capability`；整个 9 会话家族也都是 0。主 prompt 虽然要求“建 goal 先看能力牌面”“命中 skill 先读取再运行”，但这些是模型遵循的文本规则，不是服务端状态机。能力调用至少需要“发现候选、读取文档、发起运行、等待审批、解析结果”多个步骤，而普通 `src_http`、浏览器或自写脚本往往一步就能继续，于是模型在时间和上下文压力下绕开 skill。

这可以解释“skill 激活率低”的表象，但还不能说明 skill 本身是否有用。Cairn 对照报告也没有使用 dsh 的 capability 闭环，主要通过 Playwright、curl 和前端逆向完成测试，却交付了 16 条 low finding。差异首先在交付姿态、证据组织和覆盖另一个后端前缀，而不是工具数量。要判断 skill 是否带来增益，必须有 A/B 记录：同一 intent 下候选是否被提供、是否被读取、是否执行、是否产出 evidence，以及证据是否进入 finding/research。

### 历史工具层造成的假阴性

顺丰家族中的 103 次 `src_http` 和 72 次审批解析调用，历史返回主要只有 method/path/status/approval/reason，没有可供模型分析的响应体。`src_resolve_approval` 的重放路径同样只保留状态码。模型于是无法确认业务错误、响应字段、真实写入结果或服务端错误类型，只能根据状态码盲目变更请求。

会话中有连续 415 请求变体，最终把“请求形态不正确”归因为“端点有上传白名单”。其中一次 JSON body 没有 `Content-Type: application/json`；对 Spring 服务而言，字符串 body 不会由 fetch 自动补这个头，415 很可能来自客户端请求构造，而不是目标拒绝该业务。Cairn 后续用正确 JSON 头得到成功响应，证明这个阴性结论至少需要重新验证。当前代码已统一透传响应体、做 2KB 截断、响应哈希去重，并在直连和审批重放两条路径补 Content-Type；`src_record_research` 的 negative/blocked 返回还增加了“是否换过请求形态、是否为本机通道失败”的回炉清单。

这些修复能防止新的假阴性，但不能 retroactively 补足旧会话证据。顺丰授权环境仍需在合法窗口内重跑相关端点，确认请求头、响应体、写入结果和清理状态；报告不得把本地靶场通过写成顺丰已经复测。

## 约束减法方案状态矩阵

下表以 [docs/plan-2026-09-08-constraint-reduction.md](plan-2026-09-08-constraint-reduction.md) 的轮次结论和当前仓库代码为准。“本地测试”表示代码或本地靶场证据；“顺丰重跑”只有在授权环境再次执行后才能填为已验证。

| 措施 | 计划项 | 当前代码状态 | 本地测试 | 顺丰重跑 | 风险/备注 |
|---|---|---|---|---|---|
| 主 prompt 瘦身 | 轮 1，约 19,085→7,929 字符 | 已完成 | preset consistency 与回归覆盖 | 未完成 | 仍有授权、编排、路由、报告多职责，不能只看字符数 |
| 工具描述瘦身 | 轮 1，约 24.3k→13.1k | 已完成 | preset consistency | 未完成 | 工具 schema 仍是常驻上下文的一部分 |
| low-only 报告交付 | 删除 medium+ 才能报告 | 已完成 | 靶场可生成 low finding 并 finalize | 未完成 | 旧会话结果不追溯重写 |
| low finding 准入 | 未授权可达+可复现 PoC 即可 low 入库 | 已完成 | `src_add_finding` 与靶场 E2E | 未完成 | medium+ 仍需危害链三要素 |
| facts 输出预算 | `src_state`/`src_report` 分级输出 | 已完成 | 分级预算回归 | 未完成 | 预算截断需监控关键证据是否被隐藏 |
| 响应体透传 | `src_http` 与审批重放保留 body | 已完成 | body、截断、哈希、重放测试 | 未完成 | 历史会话 body 无法恢复 |
| Content-Type 自动补全 | JSON body 缺头时统一补全 | 已完成 | 415 靶场回归和重放回归 | 未完成 | 非 JSON body 不应被误补头 |
| negative 自查 | blocked/negative 返回请求形态与通道清单 | 已完成 | `src_record_research` 回归 | 未完成 | 清单是提醒，不是自动重试策略 |
| lessons 压缩 | 轮 2，六篇去重并设单篇/总量预算 | 已完成 | lesson budget 与重复标题检查 | 未完成 | lesson 读用率仍需 telemetry |
| intent hook | lesson-meta 增加 hook，命中时渲染一句打法 | 已完成 | hook 命中回归 | 未完成 | 命中不等于读取，更不等于改变行为 |
| 触发器引擎拆除 | 轮 3，capabilities.yaml 不再自动编排待办 | 已完成 | 旧触发器在场也不自动挂 todo | 未完成 | 能力清单仍是展示和自主选择入口 |
| remainingDirections | 非空降为逐条 warning | 已完成 | finalize 与 coverage 回归 | 未完成 | warning 不应被模型当成无限追击命令 |
| 同域多后端扫描 | URL 前缀分簇、chunk/Cookie 服务名提示 | 已完成 | 多簇与单簇噪声回归 | 未完成 | 只能扩大候选面，不能证明接口已授权测试 |
| 靶场 E2E | 探测→fact→finding→finalize→报告 | 已完成 | 168/168 回归中包含产出链 | 未完成 | 目标环境需另行授权和清理验证 |
| telemetry | skill funnel、intent funnel、prompt/state 成本 | 未实现 | 无真实漏斗测试 | 未完成 | 当前无法给出 skill activation rate |
| orchestrator/scheduler | 事件驱动依赖、超时、重试、orphan 恢复 | 未实现 | 只有工具协议回归 | 未完成 | 这是架构主因，不能靠继续加 prompt 解决 |
| 规则真相收敛 | store/schema 成为唯一可执行法律 | 部分完成 | store 门禁回归 | 未完成 | prompt、tool、skill、rules 仍有重复语义 |

轮 1、轮 2、轮 3 的“完成”表示代码和本地回归已经落地，不表示顺丰会话已获得新证据。计划文档本身也把顺丰重跑列为开放验证项，后续验收至少应记录 finding 数量、真实 Content-Type、响应体可见性和 `src_state` 输出预算。

## Cairn 对照报告的 16 条 finding

下表只保留主题和证据属性，不复制 HTML 中与架构判断无关的原始业务数据。证据成熟度分为：`动态实证`（有真实合法请求和结果）、`静态链`（代码/前端 sink 已证明但未完成动态触发）、`穿透证明`（进入业务层但未完成合法写入）、`聚合证据`（主要依赖相邻 finding 或枚举链）。

| 编号 | 主题 | 证据成熟度 | 是否真实写入 | 是否静态链 | 是否更正前次阴性 | 与其他 finding 关系 | 对 dsh 的启示 |
|---|---|---|---|---|---|---|---|
| 3.1 | 访问日志接口未授权可写 | 动态成功响应，日志内容影响未做破坏性验证 | 否，未构造持久化写入链 | 否 | 否 | 属于 `/public/**` 面 | low + 可复现 PoC 可以交付 |
| 3.2 | Cookie 泄露后端真实服务名 | 动态响应头/浏览器 Cookie | 否 | 否 | 否 | 为同域后端识别提供线索 | 响应头也应成为可索引 evidence |
| 3.3 | `/admin/public/**` 30+ 接口未授权访问 | 穿透证明，读接口有数据，写接口多为非法体 400 | 否 | 否 | 否 | 是 3.4、3.5、3.6、3.7 的聚合根 | 可按面拆分，但需标记证据层级 |
| 3.4 | 供应商、岗位布局、打卡人数泄露 | 动态读取 | 否 | 否 | 否 | 由 3.3 的白名单面产生 | 业务数据泄露不必等 medium 才入库 |
| 3.5 | 问卷配置未授权真实落库并可删除 | 动态完整闭环 | 是，写入→回读→删除且零残留 | 否 | 否 | 3.3 的写接口升级证据 | 三步写入打法应进入 skill hook |
| 3.6 | questionnaireUrl 存储型 XSS 静态链 | 静态 formatter/innerHTML 链 | 否 | 是 | 否 | 由 3.5 提供写入口 | 静态链和动态 XSS 不能混成一条证据 |
| 3.7 | 员工花名册可批量枚举 | 动态读取 | 否 | 否 | 否 | 与 3.3 的员工类接口相关 | 枚举类 low finding 可单独交付 |
| 3.8 | 存储型 XSS 动态实证 | 动态落库、渲染和属性/元素逃逸 | 是，测试载荷写入并清理 | 否 | 否 | 3.6 的动态补强 | 报告汇总 low，但正文严重度措辞需统一 |
| 3.9 | HKAA 管理接口匿名读取配置、日志、网点、服务和价格 | 动态读取 | 否 | 否 | 否 | 扩展到同域另一后端 | 单一目标应按 URL 前缀发现新 asset |
| 3.10 | HKAA 多组管理写接口穿透鉴权层 | 穿透证明，非法/边界请求达到 Controller | 否，未完成全部合法写入 | 否 | 否 | 由 3.9 扩大业务面 | 不能把“穿透”写成“真实修改成功” |
| 3.11 | districtList/getDistrictList 返回全量定价 | 动态读取 | 否 | 否 | 否 | 3.9 的价格配置增量证据 | 前端真实请求形态应进入研究记录 |
| 3.12 | order/query 返回全量订单 | 动态分页读取 | 否 | 否 | 是，补上真实排序参数后由阴性转阳性 | 为 3.14、3.15、3.16 提供 orderId 枚举 | 缺参数导致的 fail 必须进入 negative 回炉 |
| 3.13 | pay/query 返回支付记录 | 动态分页读取 | 否 | 否 | 否 | 与订单/递送数据面相邻 | 需要响应体才能判断敏感字段和规模 |
| 3.14 | 三个 delivery/query 返回递送记录 | 动态分页读取 | 否 | 否 | 是，补上前端默认 `column` 后出数 | 与 3.12、paymentdetails、3.16 串成枚举链 | 多后端扫描应输出跨前缀链路 |
| 3.15 | posPaymentInfoLog/query 真实 GET+orderId 出数 | 动态读取 | 否 | 否 | 是，POST 分页形态误判为阴性 | 由 3.12 的订单枚举驱动逐单查询 | 方法、参数和传输位置必须保存 |
| 3.16 | AA APP 三个订单详情接口返回完整对象/部分明文 PII | 动态读取 | 否 | 否 | 否 | 依赖 3.14 枚举 orderId，形成闭环 | 订单详情需要会话/签名边界，不能只看单接口 |

对照报告的“16 条”不能简单等同于 16 个完全独立、同等强度的漏洞。3.3/3.4 是聚合关系，3.6/3.8 是静态链和动态实证两层，3.10 尚未全部完成真实合法写入，3.12、3.14、3.15 则明确揭示了请求形态错误造成的假阴性。报告全部标为 low，但 3.8 的正文与汇总 badge 的严重度表述存在不一致，这也是 dsh 应在 schema/render 层统一而不能交给模型自由书写的地方。

## 历史结果与当前修复的边界

可以把现有证据分成三层：

1. **代码已修复**：prompt 和工具描述瘦身、响应体透传与截断去重、JSON Content-Type 自动补全、negative 自查、facts 输出预算、low finding 准入、lessons 压缩与 hook、触发器拆除、remainingDirections warning、同域多后端扫描、schema 压缩。
2. **本地已验证**：preset consistency、现有协议回归、响应体和重放测试、415 靶场、写入→回读→删除零残留、同域多后端分簇、完整 finalize/report 靶场链路。测试命令的最新结果以本报告末尾“验证记录”为准。
3. **顺丰仍需授权重跑**：原会话中被 body 黑洞或请求头错误影响的 415/写入判断；新的 `/public/**` 和同域 `/api/**` 覆盖；真实报告数量和证据质量；清理动作是否零残留。

尤其不能用 Cairn HTML 的 16 条结果证明 dsh 当前版本已经发现同样的 16 条，也不能用本地 mock 的 168 个测试证明顺丰目标已经修复或已经复测。正确的验收是：在明确授权窗口内，以当前代码重新执行，保存请求形态、响应体摘要、evidence id、finding 级别和清理结果，再与旧会话逐项比较。

## 修复优先级重排

现阶段建议按以下顺序投入，而不是继续向主 prompt 追加规则：

1. **先做 telemetry**：定义并落盘 `offered → selected → read → run → approval → outcome → evidence`，同时记录 intent、asset、route、模型版本、prompt/state token、失败原因和人工 override。没有分母就没有 activation rate。
2. **再做 orchestrator/scheduler**：把 intent 依赖、checkpoint、approval、todo、child completion、超时、重试预算和 orphan 恢复变成事件驱动队列。模型只选择优先级、解释研究假设和确认停止原因。
3. **收敛规则真相**：store/schema 是唯一可执行法律；工具 description 负责参数和失败修复；主 prompt 只留角色、授权、四步循环和最小恢复原则；skill 只描述专题打法，不复制通用门禁。
4. **继续瘦身主 prompt**：以重复率、强制措辞密度、每轮 token 占比和 A/B 任务完成率衡量，而不是以字符数作为唯一目标。
5. **改造 skill manifest 与语义路由**：关键词只做召回，结构化资产类型、前置条件、禁止场景、输出 schema、成本和风险等级负责重排；保留人工 override。
6. **最后拆 runtime 文件**：先拆 orchestrator、capability registry 和 projection，再拆 transport/network/report。每步用 replay 和 property-based 一致性测试守住 store/projection 边界。

这一路线能够区分“技能没选”“选了没读”“读了没执行”“执行被审批卡住”“执行成功但证据没进入报告”。在此之前，任何关于 skill 激活率的单一百分比都只是猜测。

## 本次验证记录

报告补写后已重新执行以下仓库检查：

```text
node scripts/check-preset-consistency.mjs
npm test
```

实际结果：

- `node scripts/check-preset-consistency.mjs` 通过；工具级 description 合计 13,106（≤15,000），协议/小节名检查通过，内置 lessons 合计 14,081（≤20,000）。
- `npm test` 通过：168 个测试全部通过，0 失败、0 取消、0 跳过，耗时约 23.0 秒。覆盖响应体透传、Content-Type 自动补全、negative 自查、low finding 准入、facts 分级预算、触发器拆除、同域多后端提示和靶场端到端产出链。

这些是当前代码和本地靶场的验证结果，不能替代顺丰授权环境重跑；后者仍需单独记录请求形态、响应体摘要、evidence id、finding 数量和清理结果。
