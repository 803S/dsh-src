# dsh-src — DSH SRC 漏洞挖掘模式

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的SRC 漏洞挖掘模式：
在授权范围内记录目标、探索线索、验证结果、资产与漏洞，并在 Web 中以探索链路、漏洞和资产视图展示。

本目录是自包含 bundle 包（`@howmp/dsh-src`）：宿主插件、Web 界面和 sqlite 后端通过包内 `exports`
一同分发。Release 资产可直接由 `dsh plugin add` 安装。

## 安装

### 从 Release URL 安装

```powershell
dsh plugin --profile web add https://github.com/howmp/dsh-src/releases/latest/download/dsh-src.tar.gz
```

### 或下载后从本地文件安装

```powershell
dsh plugin --profile web add file:C:\path\to\dsh-src.tar.gz
```

重启 dsh 后，在新会话中选择自动注册的「SRC 专业模式」。

## 界面预览

### 模式选择

![SRC 专业模式选择](images/mode.png)

### 对话与执行

![对话与执行](images/chat.png)

### 探索链路

![探索链路](images/flow.png)

### 漏洞视图

![漏洞视图](images/vuln.png)

### 资产视图

![资产视图](images/asset.png)

### 测试报告

![测试报告](images/report.png)

## 架构速览

- **领域模型**（`lib/src.js`）：storage domain `src`（version 6）——`goals` / `intents` / `facts` / `findings` / `assets` / `coverage` / `research` /
  `checkpoints` / `submissions` / `edges` 八张表。Intent 有 `planned` / `running` / `completed` / `blocked` / `failed` 生命周期；子 agent 每次 `src_submit` 都写入 durable checkpoint。边即链路词汇：`spawns`(goal→intent)、`yields`(intent→fact)、
  `derived_from`(fact→intent)、`proves`(intent→finding)，资产关系用 `parent`(asset→asset)。finding 必填
  `reproducibleSteps`（至少一条）。
- **确定性 id**（`store.ts`）：节点/边 id 为 `<kind>-<n>`（按会话计数，goal 重置后归零）——工具返回 id 供模型
  跨调用引用，会话投影从日志纯重放同一张图。
- **工具**（`lib/src.js`）：`src_submit`（子 agent 直写指定父 intent，并创建 checkpoint）/ `src_add_goal`（重置整图）/ `src_add_intent`（恰好一个锚点）/
  `src_update_intent` / `src_add_fact` / `src_add_finding`（步骤、危害、范围、修复和 POC 必填）/ `src_add_asset`（可选 parentId，
  空字符串视为根资产）/ `src_record_recon` / `src_record_asset_observation` / `src_collect_passive` / `src_scan_surface` / `src_test_bypass` /
  `src_record_research` / `src_record_coverage` / `src_recover_child` / `src_finalize_engagement` /
  `src_record_submission` / `src_state` / `src_graph` / `src_report`。
- **会话投影**：折叠已日志化的 `src_*` 调用为 `{ goal, nodes, assets, coverage, research, checkpoints, submissions, edges, counts }`，
  镜像 store 的引用拒绝和语义去重；checkpoint 上限 200。`src_state` 还会额外汇总 `apiDiscovery` 摘要（API endpoint 总数、schema / GraphQL / hint 数量、尚未推进数量和示例），让指挥官快速看到被动发现后还有哪些接口工作未推进。
- **Web 标签页**：按会话注册（当前会话或列表祖先链含 `src` 预设即显示，非 SRC 会话隐藏）；六个子标签——探索链路、漏洞、资产、子 Agent 进度、提交记录和报告。进度页展示 durable checkpoint 摘要、阶段、子会话 id 与新增计数；会话头部现在直接展示 API discovery 摘要，报告页也会把 `api:*` 资产元数据渲染成更可读的 `API/openapi-schema` / `API/graphql-endpoint` / `API/schema-path` / `API/html-js-hint` 形式。
- **资产采集层**：所有资产观察记录来源、采集方法、置信度和 candidate/confirmed/excluded 状态；`src_record_asset_observation` 是统一入口，`src_record_recon` 和 `src_submit` 也携带 provenance。新增 `src_collect_passive`：对授权目标执行有界被动采集（homepage / robots.txt / sitemap.xml / 同 host HTML/JS hint + 限量 DNS A/CNAME + 常见 OpenAPI/Swagger/GraphQL 路径），自动把结果折叠为 candidate 资产与 fact，并写入 passive-collection 覆盖率；命中的 API schema / GraphQL / JS 接口 hint 会提升为 endpoint 资产。对于带查询串的 JS 接口 hint，还会额外归一化出 family 级 endpoint（如 `/api/profile?id=1` → `/api/profile`），便于后续 coverage / research 聚合。
- **漏洞研究矩阵层**：`src_record_research` 记录 category、hypothesis、preconditions、验证状态、证据和停止原因。
- **覆盖率层**：`src_record_coverage` 按资产、阶段和漏洞类别记录 planned/running/completed/blocked/not-applicable，报告列出已测和限制项。`src_collect_passive` 对命中的 endpoint 资产会自动生成 coverage skeleton（如 authentication / authorization / idor-bola / graphql / schema-review）；JS hint 与 family 级 endpoint 也会进入这套 skeleton 流程，把发现结果直接推进到后续研究队列。
- **bypass 研究**：broken-access-control/bypass 是 SRC 高分漏洞类别——authentication/authorization bypass、idor-bola、tenant-isolation、workflow/method bypass、path-normalization、parser-discrepancy、rate-limit bypass、cache-auth-boundary、waf-rule-gap、oauth-flow bypass。`src_test_bypass` 做有界 baseline→variant 差分验证：只允许在目标 host/subdomain 内，仅 GET/HEAD/OPTIONS 和显式 allowBody 的 POST，低 RPS，遇到 403/429/WAF/challenge 即停并返回 requiresDecision；绝不自动绕过，不自动建 finding。仅凭 403→200 不算漏洞，必须附授权/影响证明并独立复核后才算 verified。禁止代理池轮换、captcha 破解、无限重试和隐蔽大规模扫描。
- **协议**（`instructions.ts`）：系统提示词段 `src:protocol`（order 50），沿链路推进、子 agent 通过
  `src_submit` 直写父 intent、资产先父后子、与用户交互一律中文。

## 流程边界与决策

- SRC 借鉴 pentest 的 commander 流程：先检查状态和去重 intent，再按事实拆分阶段、并发委派独立任务、等待完成事件、由新事实推导下一轮 intent，最后通过 `src_finalize_engagement` 做报告前验收并调用 `src_report`。若 passive discovery 命中了 API/schema/GraphQL endpoint，但后续没有进入 research 或 coverage 推进，`src_finalize_engagement` 会明确发出缺口警告；若这些接口仍然只停留在自动生成的 coverage/research skeleton，也会单独发出“仍停留在自动生成骨架”的提示，防止“发现了接口但没真正测”。
- 公司名/品牌名不能直接变成授权目标。先使用现有 web/browsing 能力做被动候选收集，在候选域名/子域收敛后用 `src_add_goal` 直接记录用户确认的正式域名与授权说明；确认前不得主动请求候选主机。
- 漏洞研究沿 pentest 的事实→假设→验证循环推进，finding 必须包含可复现步骤、影响、受影响范围、修复建议和 POC 证据；未复现内容只能作为 fact/hypothesis。

## 已知边界

- **数据库**：渗透记录写入 `$DSH_HOME/storages/src-sessions.db`（sqlite，经 bundle 补丁路由）。
  宿主其它域的存储不受影响（仍为宿主默认 json 后端）。
- **侦察策略**：优先被动、后低影响主动。`src_collect_passive` 先做授权范围内的被动采集：homepage / robots.txt / sitemap.xml / HTML/JS 接口 hint / 限量 DNS 解析 / 常见 OpenAPI/Swagger/GraphQL 元数据路径，并把结果归一化为 candidate 资产与事实；命中的 schema、GraphQL 和 JS hint 会提升为 endpoint 资产，并自动生成后续 coverage skeleton。`src_scan_surface` 再做低影响 HTTP surface discovery：先执行预检识别 WAF/CDN/挑战页、认证边界和限速；默认不会自动绕过。即使指挥官明确继续，也限制为最多 32 并发、10 RPS、500 路径，并在保护信号出现时停止。bypass 类验证交给独立的 `src_test_bypass`（recon 不可用，audit/verify 可用），它沿用同一套保护检测和停止规则，但允许在已有 research 假设下进行显式、低并发、逐变体的授权差分测试。
- **授权**：只测试有授权的目标。`src_add_goal` 的 `authorization` 参数可填写授权说明（授权对象 /
  书面许可引用），会写入状态与最终报告留痕；它只是审计事实，不是门禁——扫描/利用动作仍受部署沙箱与
  审批约束。
- **记录按单会话作用域**，无跨会话/项目续跑；重新开始一次 engagement 需新的 `src_add_goal`。子 agent 不读取原始父 transcript，主 agent 通过 `src_state`/Web 进度页观察 durable checkpoint。
- **图布局为静态分层**（可平移缩放，节点不可拖拽）。

## 目录结构

```
dsh-src/                   # 项目根 = bundle 包 @howmp/dsh-src（零依赖，自包含）
├── package.json               # bundle manifest：dsh.bundle.patch + dsh.client + exports 子路径
├── cordis.patch.yml           # 补丁层：UI、sqlite 后端与 storage-domain 路由
├── lib/                       # 构建产物（npm pack 的内容）
│   ├── index.js               #   包入口：空 apply
│   ├── src.js             #   宿主渗透插件：8 个 src_* 工具 + 协议注入 + 会话投影
│   ├── preset-root.js          #   注册包内只读「SRC 专业模式」预设目录（兼容 DSH rc.6）
│   ├── storage-sqlite.js      #   渗透记录专用的 sqlite 后端（node:sqlite）
│   ├── ui-src.js          #   Web 插件宿主半：空 apply
│   ├── ui-src.client.js   #   Web 插件浏览器半：渗透视图标签页（3 个子标签，@xyflow/react 内联）
│   └── invariant.js           #   探索图不变量伴生（与官方各包同构，生产环境不加载）
├── src/                       # 源码快照（继续开发/重新构建用）
│   ├── index.ts / invariant.ts
│   ├── dsh-src/               # host 包源码：src/ + tests/ + tsconfig + tsdown + README
│   └── dsh-client-ui-src/     # client 包源码：src/client/（视图/图布局/注册）+ tests/
├── tests/bundle.spec.ts       # bundle 补丁层测试
├── packages/                  # 三个构建好的子包（仅作构建源保留；bundle 不再依赖它们）
│   ├── dsh-src/               # host 插件源码构建产物
│   ├── dsh-client-ui-src/     # Web 界面插件源码构建产物
│   └── dsh-storage-sqlite/        # sqlite 后端构建产物（来自 dsh 仓库，无独立源码）
├── preset/src/            # 「SRC 专业模式」agent 预设（由 bundle 自动注册）
├── images/                    # README 界面预览截图
└── README.md
```

## 参考项目

- [ARTEX](https://github.com/Autumn-27/ARTEX)

## 0.1.0-local.6（时间线 observation 详情 + 待办 UI 写回通道）

### 时间线 observation 请求详情（点击展开）
- 投影 observation 补 `respHeaders`/`respBodySnippet`/`assetId`：fold 时截断（响应头 ≤600 字符、响应体片段 ≤1200 字符），避免直接 tool/call 参数无上限把投影撑爆；store 仍保留完整 ≤2000 片段。
- 时间线中带响应数据的 observation 行显示「▸ 点击展开响应详情」，点击展开 响应头 / 响应体片段 pre 块（等宽字体、限高滚动、可收起）。无 snippet 的行不显示展开提示。

### 待办面板 UI 勾选写回通道（UI → agent）
- 新增人机命令 `/src-todo <todoId> <done|abandoned|pending> [备注]`（注册在 src 插件的 agent 作用域，仅 src 会话可见）。
- 命令不直接写状态，而是 `agent.followup(createUserMessage(...))` 把用户操作转成一条对话消息并**唤醒空闲 agent**——由 agent 自己调 `src_user_todo` 落库+投影，单一写路径，且 agent 明确知道待办状态变化、可继续解除阻塞的工作。
- Web 面板「待办」tab 的 pending 项新增「✓ 我已完成」「✗ 放弃此项」按钮：经 `ctx.remote.commands.execute(sessionId, line)` 调用命令，按钮态（发送中/已转达/失败原因)就地反馈；投影更新后列表自动刷新。
- package.json dsh.client.inject 增加 `@deepseek-ai/dsh-api-remotes`（客户端 remote 调用面）。

## 0.1.0-local.5（UI 数据面 + 展示审计修复）

### 投影数据层（此前 UI 拿不到这些数据）
- **[致命] asset type enum 缺 5 种新类型**：投影 schema 只认 6 种资产，出现 ai-surface/threat-intel/mini-program/client/firmware 时 `schema.parse` 直接抛错 → **整个 src 投影崩溃、UI 全挂**。已补全 10 种。
- **[严重] finding 7 字段被 zod strip**：entryPoint/discoveryPath/rawRequest/rawResponse 在投影 view 输出时被静默剥离，UI 与导出报告永远拿不到。schema 已补。
- intent/fact/finding 节点补 `createdAt`（fold 时写入），时间线按真实时间排序（此前全部 at:0 按 id 排，非时间序）。
- 投影 view 补 `apiDiscovery` 统计（API 发现/schema/GraphQL/未推进），header 的 API 发现行从死代码变为真实数据。

### UI 展示
- FindingsView：渲染 漏洞接口来源/前端功能点/原始请求/原始响应（=== Request === / === Response === pre 块）。
- report tab 导出报告补齐与服务端 buildReport 一致的 7 字段结构（数据包优先 raw 请求/响应，无则回退 pocEvidence）。
- AssetsView：显示 状态（待确认/已排除）/来源/方式(非 passive)/置信度%；AI 服务面/威胁情报资产行 🤖 高亮+橙色。
- 资产类型徽标与分组补全 10 种（小程序/客户端/固件/AI 服务面/威胁情报此前在列表和图模式直接消失）。
- tab 徽标：时间线计数含 observations；待办 tab 显示 `(n 待处理)`。
- header counts 行追加 探测次数/pending 待办数（zh/en 字典同步）。
- TodoListView：pending 排最前，done/abandoned 沉底（组内按创建时间倒序）。
- ExploreView 详情抽屉：fact 显示 目标/置信度；finding 追加 危害/修复建议/POC 证据。

## 0.1.0-local.4（全库审计修复）

### 存储
- **v6→v7 原地迁移**：`SqliteStorageBackend.materializeUnit` 对旧版本库自动升级版本戳（新表由 CREATE IF NOT EXISTS 确保旧行由 zod default 补齐字段），不再抛 version-mismatch；更新版本（降级）明确拒绝。
- **WAL 收缩**：backend close 时 `PRAGMA wal_checkpoint(TRUNCATE)`，不再残留膨胀 WAL 文件。

### 投影（UI 数据面修复）
- 投影 schema/view/fold 补齐 `observations`/`userTodos`（此前 UI 时间线 observation 事件与"待办"tab 恒为空）+ counts 两项；checkpoint 投影补 `decision` 字段；stateVersion 4→5。
- `src_submit` 合成投影事件透传 decision（此前时间线决策标签丢失）。
- `src_import_traffic` 每条 observation 落库后补合成 `src_record_observation` 投影事件（Burp MCP/HAR 导入流量�� UI 时间线可见）。
- `src_state` render 文本提示 pending 用户待办。

### preset filter
- 三个子 agent deny 列表补 `src_record_observation`；recon 子 agent 额外收窄 `src_collect_passive/src_collect_dorks/src_import_traffic/src_scan_surface`（被动收集与流量导入是主 agent 编排职责）。

### 工程化
- `"test"` 脚本修正为 `node --test tests/src.integration.test.mjs`（原 vitest 未安装必失败）；移除未使用的 devDependencies。
- peerDependencies 放宽为 `>=0.1.0-rc.6`（钉死 rc.6 且镜像无此版本导致任何 install 失败）。

## 0.1.0-local.3（批次2-5 整改落地）

### 新工具
- `src_collect_dorks`：五类 Google dorks 被动收集（凭据/敏感文件/目录/历史/云端），尽力抓取 DuckDuckGo，受阻时落 fact 附 `web_search` 指令，只对授权域名执行。
- `src_import_traffic`：三模式流量导入 `mcp`（Burp MCP 预取流量）/`har`（HAR 文件）/`raw`（HTTP 文本）→ observations + 认证画像 fact（认证头完整入库）+ endpoint 资产。
- `src_test_credential`：泄露凭据复现（配额豁免：不受≤50/低RPS约束；红线：只测凭据对应账户自身越权面，不横向）。
- `src_record_observation`：时间线观察层（method/path/status/protectionSignal/wafBypassed/source/decision）。
- `src_user_todo`：用户待办清单（仅主 agent 可创建；pending/done/abandoned；用户完成后 agent 继续）。

### 报告 7 字段（批次4）
- finding 新增 `entryPoint`（前端功能点）/`discoveryPath`（漏洞接口来源）/`rawRequest`/`rawResponse`。
- `src_report` 输出：漏洞描述/危害描述/域名/完整URL/漏洞接口来源/前端功能点/数据包（=== Request === / === Response ===）/POC/影响范围/修复建议/影响资产/复现步骤。
- finalize 门禁：rawRequest 非空（Burp 格式数据包必填）。

### UI（批次3）
- 时间线新增 observation 事件（橙色：method/path/status/WAF/bypassed/decision）。
- 新增“待办”tab：用户待办面板（⚠pending/✅done/❌abandoned + kind + detail + 用户备注）。

### AI/威胁情报资产识别（批次5）
- `src_collect_passive` 自动识别 AI 站点（openai/deepseek/qwen/kimi/gemini 等）→ `ai-surface` 资产 + `ai-abuse` 研究骨架（manual-recommended）；威胁情报平台（fofa/shodan/censys/奇安信等）→ `threat-intel` 资产。
- 定级指南对齐小米 SRC 四档（严重/高/中/低），impact 需注明定级依据。

### Burp MCP 接入（已完成配置）
- 架构：`dsh-mcp-client(stdio) → mcp-proxy.jar → Burp Pro MCP 扩展(SSE 127.0.0.1:9876)`
- jar 已固定到 `~/.dsh/tools/mcp-proxy.jar`；profile patch 已写 `mcp-burp`（failOnStartupError:false，Burp 未开不影响其他工具）
- **用户侧一次性步骤**：Burp Pro → Extender/插件市场装 "MCP Server" 扩展 → Start
- agent 工具面多出 `mcp__burp__*`（get_proxy_history/send_to_repeater 等）；协议【Burp MCP 工具面】段已写明用法（proxy history→src_import_traffic 落库→认证画像→Repeater 回写）

### AI 面识别两层漏斗
- 第一层（代码粗筛）：22 个关键词 + 路径特征（/api/chat、/v1/completions、event-stream）+ 置信分档（0.5-0.9），命中才进漏斗
- 第二层（agent 语义复核）：audit 子 agent persona 要求拉页面判断"是否真 AI 服务"（对话入口/模型 API 调用/流式响应），排除营销文案误报；复核为假置 false-positive

### 剩余外部依赖
1. **wedecode**：小程序反编译工具，确认已装后迁移小程序 skill。
2. **App 下载方式**：应用商店 URL/二维码，落 asset meta。

### checkpoint 决策字段
- `src_submit` 新增 `decision` 参数：为何继续/停止/换向/绕过，进时间线。
