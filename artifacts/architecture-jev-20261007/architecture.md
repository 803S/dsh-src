# DSH SRC 架构全景 — Jev 重点版

源码：0.1.0-local.124 / HEAD 7d55c48。分析日期：2026-10-07（Asia/Shanghai）。静态源码分析，未验证运行状态。

Jev 输出结构化分类或有限候选建议；宿主 Manager / Broker / Ledger 才决定实际执行。浏览器快速循环未定位生产接线。

## 01 · 全局架构

DSH 宿主、SRC 工作流、Jev 与目标执行之间的边界

```mermaid
flowchart TB
 subgraph interaction[用户与交互层]
  U[用户 · 目标 / 目的 / 原生命令]
  UI[React SRC 工作台<br/>概览 · 行动中心 · 资产 · 探索图 · 报告]
  DS[Jev 全局设置<br/>DecisionSettings.tsx]:::jev
 end
 subgraph host[DeepSeek Harness / Cordis 宿主]
  S[Sessions / LLM / Tools / Commands<br/>Session Projections / Storage Domain]
  A[SRC 主代理 · src-hunter<br/>规划 · 判断证据 · 推进研究 · 交付]
  C[子代理与 AgentTeams<br/>recon / audit / verify<br/>checkpoint / submit / recovery]
 end
 subgraph domain[SRC 领域与工具层]
  T[lib/src.js + tools/index.js<br/>目标 · 意图 · 事实 · 漏洞 · 覆盖 · 待办]
  K[知识与能力<br/>playbooks · lessons · capability manifest]
  V[证据准入 / fingerprint / report<br/>verification · reporting]
 end
 subgraph control[宿主控制面]
  J[Jev 本地适配器<br/>jev-client.js<br/>风险 / 分工 / 技能 / 候选动作]:::jev
  G[受控出口 Manager + Broker<br/>范围 · 冻结计划 · 硬边界 · 配额]
  H[可信人工审批<br/>原请求绑定 · 安全材料 · 结果核对]:::human
 end
 subgraph persistence[持久化与投影]
  DB[(SRC SQLite<br/>领域数据 / 提交批次)]
  L[(Egress Ledger<br/>授权 / 发送 / 拒绝 / 未知锁)]
  P[会话事件 → SRC projection<br/>合成事件 / committed state]
 end
 subgraph external[外部边界]
  JP[Jev / SystemOne 服务<br/>配置的 endpoint]:::jev
  X[受控传输<br/>HTTP · bash 代理 · Browser · Burp]
  TARGET[授权目标系统]
 end
 U --> UI
 U --> S
 UI -->|用户命令| S
 DS -->|配置命令| S
 S --> A
 A --> T
 A --> C
 C -->|src_submit| T
 T --> K
 T --> V
 T --> DB
 T -->|风险 / 建意图建议| J
 T -->|目标请求| G
 G -->|冻结请求评估| J
 J <-->|脱敏决策协议| JP
 J -->|分类结果| G
 G -->|需要人工| H
 H -->|审核原单| G
 G --> L
 G --> X --> TARGET
 DB --> P --> UI
 G -->|审批与观测| DB
 C -->|完成回注| A
classDef jev fill:#f0e3ff,stroke:#8551b9,stroke-width:2px,color:#45206d;
classDef human fill:#fff1d8,stroke:#b88436,color:#61410f;
classDef latent fill:#f4f6fa,stroke:#7c899b,stroke-dasharray:5 4,color:#485970;
```

实线表示已定位的调用或数据关系，连线聚合了同类调用。Jev 服务处于供应商边界；用户对目标的网络授权由宿主控制。浏览器候选动作模块的生产接线状态见第 06 图。

## 02 · Jev 内部架构

四项产品职责，对应五种 taskType；风险包括单笔与整批计划

```mermaid
flowchart TB
 subgraph inputs[调用入口]
  R[risk-grade<br/>冻结单笔 HTTP]:::jev
  SC[scan-plan<br/>有界请求集合及累计影响]:::jev
  D[delegate<br/>新 intent 的任务形态]:::jev
  K[skill-activate<br/>真实文档候选]:::jev
  B[browser-index<br/>snapshot 与动作候选]:::latent
 end
 MOD[readDecisionSettings + decisionModes<br/>总开关 / on / shadow / off<br/>子会话与空候选检查]
 CFG[(DSH_HOME/settings/src-decision.json<br/>每次调用读取 · 下一调用生效)]:::jev
 SPEC[taskSpec<br/>state + questions + criteria<br/>风险追加 executionPolicy / objectClass]
 SCRUB[reviewBody + scrub<br/>请求凭据与敏感字段脱敏<br/>JSON 原语法及重复键保留]
 CACHE{仅 delegate / skill<br/>会话缓存命中?}
 HIT[60 秒结果缓存<br/>最多 256 项]
 POST[POST 配置 endpoint<br/>Bearer key / redirect:error<br/>超时与调用者取消联动]:::jev
 PROVIDER[Jev / SystemOne<br/>模型默认 jev-latest]:::jev
 VALID[validateAnswer<br/>合法 choice / confidence 0..1<br/>概率完整且和约等于 1<br/>choice 为最高概率类别]
 MAP[宿主映射<br/>effect + objectClass → risk<br/>low 且 scopeChecked → allow]
 RESULT[结构化决策<br/>action / effect / risk / mode<br/>confidence / probabilities / fallback]
 FAIL[失败中性结果<br/>skill → skip；其余 → pending<br/>effect unknown / fallback true]:::human
 CONSUMER[调用方策略消费<br/>建议是否采纳 / 是否允许自动执行]
 R & SC & D & K & B --> MOD
 CFG --> MOD
 MOD --> SPEC --> SCRUB --> CACHE
 CACHE -->|是| HIT --> RESULT
 CACHE -->|否；风险和浏览器不缓存| POST
 POST <--> PROVIDER
 POST --> VALID --> MAP --> RESULT --> CONSUMER
 MOD -->|禁用 / 配置失败 / 不适用| FAIL
 SCRUB -->|不可审查 / 超限| FAIL
 POST -->|网络 / 超时 / JSON 错误| FAIL
 VALID -->|schema 错误| FAIL
 FAIL --> CONSUMER
classDef jev fill:#f0e3ff,stroke:#8551b9,stroke-width:2px,color:#45206d;
classDef human fill:#fff1d8,stroke:#b88436,color:#61410f;
classDef latent fill:#f4f6fa,stroke:#7c899b,stroke-dasharray:5 4,color:#485970;
```

单笔正文上限 65,536 字节，审查 state 上限 1 MiB；默认超时 120 秒，可配 1–300 秒。风险不使用跨请求缓存；无供应商自动重试或切换。confidence 用于审计，不是安全概率。图中“allow”仍须经过宿主硬边界与执行检查。

## 03 · 一笔请求如何经过 Jev

当前托管出口主路径；扫描计划复用 Broker，但整批评估一次

```mermaid
sequenceDiagram
 autonumber
 participant A as 主/子代理工具
 participant M as Egress Manager
 participant B as Broker / Ledger
 participant J as Jev adapter
 participant P as SystemOne
 participant U as 用户原生命令
 participant X as 目标传输
 A->>M: src_http / 已适配工具 / 有界计划
 M->>M: 确认范围、排除域、scope 与凭据版本
 alt 首次缺范围
  M-->>A: 返回 SCOPE 审批，未发送
  U->>M: 确认范围后再继续原任务
 else 范围有效
  M->>B: canonical request + bounded plan
  B->>B: 冻结内容、排队、查测试对象归属
  B->>J: assessEgressPlan(structuredClone(plan))
  J->>P: 脱敏 state + choice questions
  P-->>J: answers + confidence + probabilities
  J-->>B: 校验后的 effect / risk / action
  B->>B: 重查范围版本 + requiresHuman + allowsLowImpact
  alt 自动执行条件全部满足
   B->>B: 如有前置/回读，逐笔 Jev 审核
   B-->>M: active 授权，原计划与配额绑定
  else 高危 / 未知 / 失败 / 硬边界 / 材料要求
   B-->>M: pending 冻结原单
   M-->>A: approvalId；其他独立工作可继续
   U->>M: /src-approve 原单
   M->>B: 安全材料、原请求、辅助请求再次核验
   B-->>M: 人工批准后的有效授权
  end
  M->>B: claim：摘要/次数/速率/期限/锁检查
  B-->>M: 持久化 dispatching，领取本次额度
  M->>X: 发送原请求（或前置→请求→验证）
  X-->>M: 响应或异常
  M->>B: response_received / outcome_unknown
  M-->>A: 脱敏证据、状态、待处理原因
 end
```

前置条件与回读并非因 GET/HEAD 就可信；自动及人工路径共用检查并可独立调用 Jev。扫描审批不逐笔重新调用模型，但出口逐笔匹配冻结清单、次数与速率。具体执行还会检查取消信号、会话生命周期及 scope 版本。

## 04 · 审批与恢复生命周期

流程示意；区分任务授权、单次发送、UI 执行状态

```mermaid
flowchart TB
 P[冻结计划 + Jev 分类]:::jev --> G{宿主自动执行条件}
 G -->|满足| A[Ledger task: active]
 G -->|不满足| Q[task: pending<br/>SRC pending_approvals 可见]:::human
 Q -->|补安全材料| S[新审批单<br/>旧 UI 单 superseded]
 S --> Q
 Q -->|用户拒绝| DEN[task: denied<br/>保留拒绝及操作约束]:::human
 Q -->|可信 allow / 受限 allow-read| C[原单核验 + 操作锁<br/>assertExecutable / assertReviewedSafety]
 C -->|通过| A
 C -->|缺材料或核验失败| Q
 A --> CL[claim 原请求额度<br/>执行时启动有效期]
 CL --> F{已进入发送?}
 F -->|没有发送且失败| NS[UI: failed-before-send<br/>核验零发送记录才可恢复]
 NS -->|用户恢复原编号 + 核验| C
 F -->|已发送| SEND[dispatch: dispatching]
 SEND -->|确定响应| OK[dispatch: response_received<br/>UI: executed 或按回读结果 unknown]
 SEND -->|超时 / 取消 / 进程崩溃| UN[dispatch: outcome_unknown<br/>UI: unknown / 资源与操作锁]:::human
 UN --> REC[用户核对冻结请求及外部实际状态<br/>src-egress-reconcile]:::human
 DEN --> REC
 REC --> FOLLOW[核对本身不发送<br/>后续执行按有效授权与恢复条件处理]
 RESTART[进程重启] --> LOAD[解密冻结计划 / 载入 scopes 与 Ledger]
 LOAD -->|未发送待审仍可恢复| Q
 LOAD -->|遗留 dispatching| UN
classDef jev fill:#f0e3ff,stroke:#8551b9,stroke-width:2px,color:#45206d;
classDef human fill:#fff1d8,stroke:#b88436,color:#61410f;
classDef latent fill:#f4f6fa,stroke:#7c899b,stroke-dasharray:5 4,color:#485970;
```

人工等待没有默认过期时间；有界执行期限从实际启动/发送开始。已发送而结果未知不会自动重放，也不宣称 exactly-once。allow-read 只适用于宿主允许的单笔未知影响确认入口，不能用自报 read/compute 覆盖 Jev 已判定高危。

## 05 · 目标流量执行边界

宿主工具包装、网络沙箱和各适配器共同约束实际发送

```mermaid
flowchart TB
 A[DSH 工具执行] --> HI[host-integration.js<br/>审计工具目录 / 目标工具包装<br/>withEgressExecution 上下文]
 HI --> HTTP[src_http / 扫描 / web_fetch<br/>目标请求与证据采集]
 HI --> BASH[bash / curl / Python<br/>src-bash-executor.js]
 HI --> BR[Browser Adapter<br/>browser sessions / runtime / worker]
 HI --> BU[Burp Adapter<br/>冻结原生 HTTP/1 或 HTTP/2 参数]
 HI --> O[其他能力<br/>capability executor / FOFA / passive lookup]
 BASH --> OS[macOS sandbox-exec<br/>最终 spawn 限制网络与受保护文件]
 OS --> PROXY[会话专属 MITM 代理<br/>proxy-process + mitm-addon.py]
 BR --> PROXY
 PROXY --> CS[本机控制服务<br/>control-server / duplex]
 HTTP --> MG[Manager + Broker<br/>范围 / 计划 / 审批 / 配额]
 CS --> MG
 BU --> MG
 MG --> J[Jev 风险判定]:::jev
 J --> MG
 MG -->|批准与领取| DIRECT[http-dispatch / pinned lookup]
 MG -->|批准与领取| NATIVE[已注册 Burp 原生发送工具]
 MG -->|逐笔验证冻结请求| PROXY
 DIRECT --> TG[用户授权目标]
 PROXY --> TG
 NATIVE --> TG
 O --> LOOK[专用适配策略<br/>公共查询 / 本地读取 / 受控能力]
 HI -->|不在适配目录| DENY[拒绝未适配发送入口]:::human
classDef jev fill:#f0e3ff,stroke:#8551b9,stroke-width:2px,color:#45206d;
classDef human fill:#fff1d8,stroke:#b88436,color:#61410f;
classDef latent fill:#f4f6fa,stroke:#7c899b,stroke-dasharray:5 4,color:#485970;
```

bash 网络约束当前明确仅支持 darwin，其他平台拒绝；不是跨平台能力承诺。Jev API、公共检索、目标流量属于不同用途，图中未把所有外部请求误画成同一目标审批。Burp 的范围/版本核对不等于控制 Burp 自身的 DNS 解析；手工 Burp 与未适配扩展行为不在该链路内。

## 06 · 分工、技能与浏览器三条链

实线为生产调用；虚线框表示已有实现但未发现生产入口接线

```mermaid
flowchart LR
 subgraph delegation[分工建议 · 已定位生产调用]
  direction TB
  I[src_add_intent<br/>新意图且为主会话] --> JD[Jev delegate]:::jev
  JD --> DV[delegate / self / pending]
  DV --> AR[写 delegationAdvice<br/>on 时呈现建议]
  AR --> MAIN[主模型决定实际分工]
  MAIN --> SPAWN[src_recon / src_audit / src_verify<br/>或 AgentTeams]
  SPAWN --> SUB[src_submit → checkpoint<br/>完成回注 / 有界恢复]
 end
 subgraph skills[技能提醒 · 已定位生产调用]
  direction TB
  CT[建意图上下文<br/>旧 HTTP 分支也有提醒调用] --> RC[playbooks / capability / lessons<br/>关键词、文档内容、版本 identity]
  RC --> SK[Jev skill-activate<br/>仅选择候选文档或 skip]:::jev
  SK --> FILTER[on + 有效候选 + confidence ≥ 0.6<br/>会话去重 / 已读过滤]
  FILTER --> HINT[返回文档提示与读取工具]
  HINT --> READ[src_read_capability / src_read_lesson]
  READ --> ACTION[主模型消费文档后行动<br/>推荐-读取-后续动作可关联]
 end
 subgraph browser[浏览器快速循环 · 导出函数与测试存在]
  direction TB
  OBS[snapshot → fingerprint<br/>代码提取 clickable refs]:::latent
  OBS -.-> JB[Jev browser-index<br/>选候选 index 或 none]:::jev
  JB -.-> GUARD[再取 snapshot<br/>指纹 / ref / URL / operation 硬检查]:::latent
  GUARD -.-> CLICK[宿主 MCP click 或短 wait<br/>再次 snapshot + telemetry]:::latent
 end
 delegation ~~~ skills
 skills ~~~ browser
classDef jev fill:#f0e3ff,stroke:#8551b9,stroke-width:2px,color:#45206d;
classDef human fill:#fff1d8,stroke:#b88436,color:#61410f;
classDef latent fill:#f4f6fa,stroke:#7c899b,stroke-dasharray:5 4,color:#485970;
```

全仓调用检索只发现 browser-loop.js 导出与测试使用，未发现 lib/src、preset 或 UI 的生产调用点；实际浏览器出站适配已存在，但不能据此认定 Jev 快速循环已接入。托管 src_http 在 Manager 路径提前返回，不经过旧 HTTP 分支里的技能提醒。

## 07 · 领域数据、事件与 Jev 持久化

界面状态、执行授权与供应商配置分开存放

```mermaid
flowchart TB
 subgraph workflow[探索领域关系]
  GO[goal] -->|spawns| IN[intent]
  IN -->|yields| FA[fact]
  FA -->|derived_from| IN2[新 intent]
  IN -->|proves| FI[finding]
  AS[assets / observations / research] --> FA
  CO[coverage / endpoint manifests] --> IN
  CP[checkpoints / user_todos] --> IN
 end
 ST[SrcStore + mutations<br/>事务性变更 / 批次提交]
 DB[(storages/src-sessions.db<br/>src domain 的 SQLite backend)]
 CM[src_commits / committed state<br/>权威批次与变更重放]
 EV[src_events<br/>可配置事件旁账 / 双折叠检查]
 SE[宿主会话事件<br/>tool call 与 synthetic events]
 PJ[SRC session projection<br/>图 / 资产 / 覆盖 / 审批 / 待办]
 UI[React 工作台 + 报告]
 EG[(control/src-egress/ledger.sqlite<br/>tasks / dispatches / denials<br/>resource blocks / reconciliations)]
 FR[AES-256-GCM 冻结计划<br/>AAD 绑定 session + digest<br/>原请求及凭据保留为密文]
 SD[(settings/src-decision.json<br/>全局 Jev 配置与 key)]:::jev
 MEM[Jev 进程内状态<br/>建议缓存 / 最近连接健康]:::jev
 TEL[JSONL telemetry<br/>分类 / 延迟 / 建议采纳 / browser action]
 GO & IN & FA & FI & AS & CO & CP --> ST --> DB
 ST --> CM --> SE --> PJ --> UI
 ST -.-> EV
 EG -->|脱敏审批与发送观测| ST
 FR --> EG
 SD --> J[Jev adapter]:::jev
 J --> MEM
 J -.->|调用方记录| TEL
 DB -->|报告读取| UI
classDef jev fill:#f0e3ff,stroke:#8551b9,stroke-width:2px,color:#45206d;
classDef human fill:#fff1d8,stroke:#b88436,color:#61410f;
classDef latent fill:#f4f6fa,stroke:#7c899b,stroke-dasharray:5 4,color:#485970;
```

路径均相对 DSH_HOME，未读取本机运行配置或凭据。SQLite 领域数据与出口 Ledger 是两个存储边界；src_events 是可配置旁账，不能把它单独描述成全部业务状态的唯一来源。Telemetry 失败不阻塞执行。

## 08 · 安装与运行接线

npm bundle 通过 patch 与 preset 组合进宿主

```mermaid
flowchart LR
 PKG[package.json<br/>@lihua_dis/dsh-src<br/>0.1.0-local.124] --> PATCH[cordis.patch.yml]
 PKG --> EX[exports 子路径]
 PATCH --> UI[ui-src<br/>浏览器加载 client bundle]
 UI --> TS[src/dsh-client-ui-src<br/>React + @xyflow/react + tsdown]
 TS --> BUILD[lib/ui-src.client.js]
 PATCH --> SQLITE[storage-src-sqlite<br/>src domain 路由覆盖]
 PATCH --> DA[src-domain-admin<br/>域数据命令 + Jev 配置命令]:::jev
 PATCH --> EP[src-egress<br/>惰性 Manager 单例]
 PATCH --> BE[src-bash-executor<br/>替换原 bash-sandbox row]
 PATCH --> PR[preset-root<br/>注册包内预设根]
 PR --> PRE[src-hunter preset<br/>agent.cordis.yml]
 PRE --> SRC[src plugin<br/>工具、指令、投影、命令]
 PRE --> CHILD[src-subagent<br/>recon / audit / verify]
 SRC --> EP
 BE --> EP
 DA --> SET[Jev 全局配置<br/>相同 DSH_HOME 下共用]:::jev
 EX --> ENTRY[lib/index.js / lib/ui-src.js<br/>空 apply 占位入口]
classDef jev fill:#f0e3ff,stroke:#8551b9,stroke-width:2px,color:#45206d;
classDef human fill:#fff1d8,stroke:#b88436,color:#61410f;
classDef latent fill:#f4f6fa,stroke:#7c899b,stroke-dasharray:5 4,color:#485970;
```

本包是 DeepSeek Harness 插件 bundle，不是独立 Web 后端。业务逻辑主要在 lib/src.js 与 lib/src/；UI 可编辑源在 src/dsh-client-ui-src，lib/ui-src.client.js 为构建产物。图中的宿主服务来自 peer 依赖。

## 源码索引

- 安装组合：`cordis.patch.yml:24` — UI、SQLite 路由、域管理、preset、出口与 bash 执行器的组合入口。
- SRC 组合根：`lib/src.js:56` — 工具、领域 schema、命令与会话 projection；不是一个仅含工具的薄文件。
- 托管 HTTP 分支：`lib/src/tools/index.js:1837` — 有托管上下文即进入 Manager 并提前返回；后面才是旧策略路径。
- Jev 请求入口：`lib/src/decision/jev-client.js:43` — 调用适用性、配置、脱敏、缓存、请求、响应校验及分类映射。
- Jev 任务协议：`lib/src/decision/jev-client.js:21` — 五种 taskType 的 state、criteria 和判定说明。
- 供应商响应校验：`lib/src/decision/jev-client.js:33` — confidence、所有候选概率、概率和以及最大值一致性。
- 全局设置：`lib/src/decision/service-settings.js:7` — 默认 disabled；endpoint 为空；model=jev-latest；原子写入与文件权限。
- 用户设置命令：`lib/src/decision/service-commands.js:4` — status / save / test；recordInput:false，不注册为模型工具。
- 风险评估路由：`lib/src/egress/advisor.js:6` — 单笔走 risk-grade，多请求走 scan-plan。
- 批准策略：`lib/src/egress/decision-policy.js:6` — mode=on、low/allow 与请求方法、测试对象归属等联合检查。
- Broker：`lib/src/egress/broker.js:64` — 排队、范围重验、对象归属、Jev 评估、自动审批条件、冻结落账。
- 辅助请求审查：`lib/src/egress/broker.js:51` — 前置/回读逐笔审查；自动及人工执行共享。
- 出口协调器：`lib/src/egress/manager.js:23` — 范围、待审、会话代理、原生发送、操作锁、恢复与核对。
- Ledger：`lib/src/egress/ledger.js:6` — 独立 SQLite；事务领取；崩溃时把 dispatching 标为 outcome_unknown。
- 冻结密文：`lib/src/egress/frozen-plan.js:6` — AES-256-GCM；AAD 绑定会话和计划摘要。
- 安全材料：`lib/src/egress/safety-plan.js:44` — 读写语义、备份、前置和回读哈希、不可逆外发确认。
- 实际执行顺序：`lib/src/egress/safety-plan.js:86` — 前置条件→发送→回读；没有自动重放或补偿。
- 用户命令来源验证：`lib/src/egress/user-commands.js:6` — 要求真实 command/run 的 source.kind=user；模型执行上下文不可批准。
- 工具总边界：`lib/src/egress/host-integration.js:22` — 审计工具目录、MCP/Browser/Burp/能力适配与上下文包装。
- OS 网络约束：`lib/src/egress/executor.js:6` — darwin sandbox-exec；限制最终进程启动时网络。
- 旧 HTTP 策略：`lib/src/decision/http-policy.js:19` — 非托管分支仍在；off/shadow 使用旧规则，DELETE 等保留硬边界。
- 分工建议调用：`lib/src/tools/index.js:2232` — 新 intent 才评估；仅主会话；on 才写入建议。
- 知识候选：`lib/src/decision/knowledge-recall.js:34` — 遍历真实知识库和 lessons，按上下文词与文档版本构造候选。
- 技能去重：`lib/src/decision/skill-recall.js:92` — 推荐、读取、后续动作关联，进程内会话去重。
- 浏览器循环：`lib/src/decision/browser-loop.js:137` — 候选选择与硬检查已有实现；仓库内仅定位到测试调用。
- SRC 存储：`lib/src/store.js:24` — 领域写入、提交批次与恢复。
- 领域表定义：`lib/src.js:1542` — 目标、意图、事实、漏洞、资产、覆盖、研究、审批、待办等表。
- 事件旁账：`lib/src/event-store.js:9` — 事件幂等与可配置双折叠，不能替代现有 projection 契约。
- SQLite 后端：`lib/storage-sqlite.js:3` — node:sqlite 实现 storage-domain KV unit。
- Jev 设置 UI：`src/dsh-client-ui-src/src/client/DecisionSettings.tsx:16` — 全局连接配置与四项职责设置。
- 人工审批 UI：`src/dsh-client-ui-src/src/client/ActionCenter.tsx:121` — 待审、allow-read 与未发送恢复的交互。
- 最近生命周期修复：`docs/implementation/approval-lifecycle-audit-20261007.md:1` — local.124 文档；作为背景佐证，架构以当前源码为准。

## 使用与当前边界

- architecture.html 是单文件离线阅读版，内嵌全部 SVG；支持缩放、展开、下载 SVG、打印。
- 各 .mmd 为可编辑 Mermaid 源码，各 .svg 为独立矢量图。
- 托管 src_http 提前进入 Manager；旧 httpDecisionPolicy 不是它必经的下一站。
- Jev 失败不会自动转向 Laya；历史变量、字段和测试中仍可出现 Laya。
- 人工审批不会自动消除已发送请求的未知结果，核对本身不发送。
- Browser Adapter 已有生产代码；Jev browser-loop 仅定位到导出与测试调用。
- 本次只验证文档渲染及交互，没有连接 Jev 或目标，没有执行项目业务测试。
