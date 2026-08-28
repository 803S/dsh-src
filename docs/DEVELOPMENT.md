> **开发/迭代历史文档**（原仓库根 README）。面向使用者的项目介绍见根目录 [README](../README.md)。

> ⚠️ 历史章节说明：本文前半部分（目录结构、安装方式）反映的是早期仓库布局；当前真实结构以仓库根目录为准，安装方式以根 [README](../README.md) 为准。后半部分版本日志按时间顺序保留，供了解设计决策脉络。

# dsh-src — DSH SRC 漏洞挖掘模式

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的SRC 漏洞挖掘模式：
在授权范围内记录目标、探索线索、验证结果、资产与漏洞，并在 Web 中以探索链路、漏洞和资产视图展示。

本目录是自包含 bundle 包（`@lihua_dis/dsh-src`）：宿主插件、Web 界面和 sqlite 后端通过包内 `exports`
一同分发。Release 资产可直接由 `dsh plugin add` 安装。

## 安装

### 从 Release URL 安装

```bash
dsh plugin --profile web add https://github.com/803S/dsh-src/releases/latest/download/lihua_dis-dsh-src-<版本>.tgz
```

### 或下载后从本地文件安装

```bash
dsh plugin --profile web add file:/path/to/lihua_dis-dsh-src-<版本>.tgz
```

重启 dsh 后，在新会话中选择自动注册的「SRC 专业模式」。

## 接入你自己的 Burp MCP（可选）

接线已随包内置（包内 `cordis.patch.yml` 默认启用 `mcp-burp` 块）：装好扩展、面板填端口即完事，
无需手改任何配置文件。不接 Burp 时插件照常工作：agent 会走 HAR/raw 文件导入兑底
（`src_import_traffic mode=har/raw`），并在需要时创建「启用 Burp」用户待办提醒你。

### 接入步骤（一次性）

1. 跑一次 caps-sync 装自愈桥（或手动拷贝，见 README「接入 Burp MCP」节）：

```bash
node ~/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src/scripts/caps-sync.mjs
```

2. Burp Suite Pro 安装 "MCP Server" BApp 扩展并点 Start（默认监听 `127.0.0.1:9876`）。
3. 重启 dsh，面板「基础设施」页核对端口 + 点「测试 Burp MCP 连接」验证；agent 工具面多出
   `mcp__burp__get_proxy_history` / `mcp__burp__send_to_repeater` 等，配合 `src_import_traffic(mode=mcp)` 把真实浏览流量落库。

### 自愈桥 vs 官方 mcp-proxy.jar

包内置的是自研桥 `tools/burp-mcp-bridge.mjs`：官方 jar 内 Kotlin SDK 长连 SSE 断掉后进程存活但传输已死，
后续调用全报 -32603 "SseClientTransport is not initialized!" 且无法自愈；桥在任何请求失败后丢弃会话、
下次调用自动开全新 SSE 会话重试一次，对上层透明。扩展 SSE 端点在根路径 `/` 且仅支持 HTTP
（桥默认连 `http://localhost:9876/`，可用环境变量 `BURP_SSE_URL` 覆盖）。

### 不同端口 / 主机

- **换端口**：面板「基础设施」页改 `burpMcpPort` 即可（桥与测试按钮都读它）；扩展侧同步修改监听端口。
- **远端主机**：设环境变量 `BURP_SSE_URL=http://192.0.2.50:9876/`（在 profile patch 的 mcp-burp 块加 `env:` 字段）。

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

## 测试约束（硬性红线）

本仓库的测试一律遵守以下红线——**不遵守 = 危害真实厂商资产/用户，等于线上事故**：

1. **绝不用真实漏洞目标做测试**。`src_http`/`src_test_bypass`/`src_scan_surface` 等触及真实网络的集成测试，
   全部走**本地 mock HTTP 服务器**（`127.0.0.1` + 随机端口 + `node:http`），不向任何外部域名发包。
   目标设为 `127.0.0.1`（IP → 合理公共主机校验通过），URL 指向本地服务器端口。
2. **绝不用任何厂商域名资产做测试**。测试中出现的 `example.test`/`127.0.0.1` 等均为占位/本地地址；
   不在测试里出现 `meituan.com`/`oppo.com` 等真实厂商域名，不构造对真实厂商接口的请求报文。
   会话日志取证（如 `session-65695562`）只查不改、不复现，仅作审计参考。
3. **高危动作分类（`classifyHttpRequest`）是纯函数**，不触网，单测覆盖各种请求形态即可，无需任何 mock 服务器。
4. **高危请求异步挂起队列**（local.31）：集成测试中高危请求挂到 `pending_approvals` 表（本地 `MemoryDomain`，不触网）；
   批准后 `src_resolve_approval` 原样重放到本地 mock 服务器（`127.0.0.1` 随机端口）；不调真实 `dsh-user-approval`，也不需开放交互轮次。
5. **fail-closed 验证**：必须验证挂起阶段 / 拒绝后**mock 服务器收不到任何请求**（`hitCount === 0`），这是模块一-路线A 的拦截红线。
6. **报告节完整性闸**（local.32）：任何新增/改名报告节的改动必须同时过 `[local.32]` 双渲染闸——
   UI `reportOf`（ReportView.tsx，节标题词条 `report.sec.*`，zh 值与服务端逐字一致）与服务端 `buildReport` 的
   `## ` 节标题集合必须相等；节顺序两侧也必须一致。

遵循以上红线的测试见 `tests/src.integration.test.mjs` 中 `[local.26]`/`[local.26/31]`/`[local.31]`/`[local.32]` 系列（22 个，全过；`classifyHttpRequest` 纯函数 + 异步挂起 + resolve + 去重 + fold + 幂等 + 报告节完整性闸 + 软速率帽 + 401 语义 + 基础设施默认沿用）。

## 目录结构

```
dsh-src/                   # 项目根 = bundle 包 @lihua_dis/dsh-src（零依赖，自包含）
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

## 0.1.0-local.12（真实测试第四轮 2 问题：scan_surface lossless JSON 报错 / 新会话无基础设施页）

- **[修复·关键] `tool "src_scan_surface" returned invalid output: value is not lossless JSON`**：工具返回值会经过 dsh-session 的 lossless JSON 快照校验，**任何值为 `undefined` 的自有属性都会让整体判失败**。src_scan_surface 正常完成路径的返回里写了 `stopped: stopped ? "protection-signal" : void 0`——未触发停机时 stopped 为 undefined，整个输出被拒。之前没暴露是因为真实目标多��� WAF 提前 return；扫无防护目标必炸。同款炸弹还有 src_test_bypass 错误路径 `{ ...req, status: void 0, ... }`（spread 覆盖产生 undefined 自有属性），一并修复：改为条件展开/解构剔除，绝不产出 undefined 值属性。
- **[修复] 新会话看不到基础设施页**：投影 view 在 `goal === null` 时整体返回 null，客户端只渲染空态文案——agent 建 goal 之前用户无法配置代理/Burp 端口等启动期就要用的参数。现在 viewSrcState 恒返回完整视图（goal 字段可为 null），投影 schema 同步放宽 goal 可空、stateVersion 6→7（自动重算）；UI 各处本就处理 goal===null（头部空名、报告显示未初始化）。新会话打开即可直接配置基础设施。
- 测试 40/40 绿（新增 viewSrcState 无 goal 断言 + isJsonValue 对两种旧炸弹形状的失败守卫）+ SSR 回归 23/23（新增新会话渲染用例）。

## 0.1.0-local.11（真实测试第三轮 3 问题修复：infra 表漏声明 / 面板直写不打扰 AI / 代理测活 / 备注换行）

- **[修复·关键] `domain 'src' declares no table 'infra'`**：local.9 引入 infra 设置时只改了 `SESSION_SCOPED_TABLES` 与迁移注释，**忘了在 `defineDomain` 的 spec 里声明 `infra` 表、也没把 domain version 提到 8**——storage-domain 是严格声明白名单，`domain.table("infra")` 直接抛错；面板保存经 agent 调 src_set_infra 时全部失败，值从未落库（这就是「填了再去看变成空」的原因）。已补 `srcInfraSchema` + spec.tables.infra + version 7→8，下次打开自动迁移并建表。单测没抓住是因为 harness 的 MemoryDomain 对任意表名自动建表（掩蔽 bug），真实环境是严格白名单。
- **[行为] `/src-infra` 改为面板直写**：不再 followup 打扰 agent——命令处理器直接调 SrcStore.setInfra 落库，并合成一条 `tool/call src_set_infra` 会话事件保持投影/时间线同步；返回文本带生效值，立即生效。协议同步改为「每次相关测试前必须重新 src_get_infra」。
- **[新功能] `/src-proxy-test` 代理测活**：服务端用现有 CONNECT 隧道直接经配置代理请求探针地址（gstatic generate_204），结果（HTTP 状态+耗时/失败原因）直接显示在基础设施页，全程不经过 agent。UI 新增「测试代理连通」按钮。
- **[改进] `/src-burp-test` 两段式**：先 host 侧 TCP 探测 burpMcpPort（3s 超时）——端口不通时直接给出中文诊断（扩展未装/未 Start/端口不符），完全不打扰 agent；端口可达才 wake agent 做 MCP 层验证。
- **[UI] 待办备注框改 textarea**：支持多行备注，Enter 发送、Shift+Enter 换行、Esc 取消。

## 0.1.0-local.10（真实测试第二轮 5 问题修复：remote.commands 注入 / 对照账号语义 / 多手机号 / Burp 测试按钮 / 待办备注框美化）

- **[修复·关键] `cannot get property "remote.commands" without inject`**：待办发送与基础设施保存全部报此错。根因：cordis 把每个 Remote 命名空间挂为字面量服务名 `"remote.<namespace>"`（`RemoteNamespaceService extends Service`，`super(ctx, "remote.commands")`），而 traceable 代理把 `ctx.remote.commands` 转成 `ctx["remote.commands"]` 查找——模块导出 inject 只写 `"remote"` 不够，必须同时声明 `"remote.commands"`（对照 dsh-client-ui-commands 的 CommandUiRuntime inject 列表确认）。ui-src.client.js 的 inject 数组已补上，待办与基础设施两条链路共用此修复。
- **[语义] 越权对照账号 testAccount**：明确为凭据格式 user:pass 或用户名。协议规定 agent 优先脚本登录构造低权会话做 A/B 对照；无法自动登录时创建用户待办请用户提供登录态，禁止臆造凭据。UI 标签/占位符同步。
- **[功能] testPhone 支持多个号码**：src_set_infra 校验放宽为逗号/顿号/分号/空白分隔的号码列表（逐个验证格式）；UI 占位符、工具描述、协议同步说明。
- **[UI] 基础设施页 Burp MCP 说明重写**：新增说明卡片——三步接线清单（装扩展并 Start → 核对 cordis.patch.yml 的 jar 路径 → 点「测试 Burp MCP 连接」按钮）、显示本机 patch 文件路径、明示端口/jar 两项仅是记录不改配置。新增 `/src-burp-test` 人机命令：转达 agent 立即调用 mcp__burp__get_proxy_history 实测连接并中文汇报结果。
- **[UI] 待办备注框美化**：改为卡片式容器（圆角+浅底色+边框，跟随深色模式），顶部灰色说明行（✓已完成/✗放弃 + 备注可选提示），全宽输入框，右对齐「发送/取消」按钮。

## 0.1.0-local.9（真实测试 7 问题修复：脏目标 / 待办异步化 / 基础设施页 / 时间线重设计 / 全程中文）

- **[修复] 脏目标解析**：`src_add_goal` 的 target 带中文说明（如 `mi.com（小米在线服务主域，含 *.mi.com 子域）`）时，六个出站工具（scan_surface/test_bypass/test_credential/import_traffic/collect_dorks/collect_passive）直接 `new URL()` 抛错。新增 `parseGoalHost()`：非 ASCII 输入跳过 URL 直解（防 IDNA punycode 出乱码主机名），依次尝试「带 scheme 直解 → 加 https:// 直解 → 正则提取首个域名 token」，全部失败给出中文可行动报错。新增 `src_set_goal_target` 工具让 agent 在目标带杂质时就地修正而不清空探��图。
- **[新工具] `src_get_infra` / `src_set_infra`**：会话级基础设施设置（proxyUrl/burpMcpPort/burpProxyJarPath/testAccount/testPhone/httpTimeoutMs），存 sqlite 新表 infra（domain version 7→8，旧库自动迁移）。出站请求统一走 `makeHttpFetch(infra)`：手写 CONNECT 隧道支持 HTTP(S) 代理（不引入 undici 依赖）、永不跟随重定向、超时与 4MB 上限可控；进程级代理用 Node 24 `--use-env-proxy` 文档化。
- **[UI] 待办按钮异步化 + 备注**：✓完成/✗放弃点击后先展开 inline 备注输入框（Enter 发送/Esc 取消），备注随 `/src-todo <id> <status> <note>` 转达给 agent；修复模块导出 inject 缺 `"remote"` 导致点击报错的问题（boot manifest inject 是包加载顺序，模块导出的 inject 才是 cordis 服务名——runCommand 依赖 ctx.remote.commands.execute）。
- **[UI] 新增「基础设施」tab**：表单读写六项设置（保存经 `/src-infra <key> <value>` 人机命令写回，value 为 `-` 表示恢复默认）；附 Burp MCP 接线示例与进程级代理说明。子代理 deny 列表追加 src_set_infra/src_set_goal_target（src_get_infra 允许读取）。
- **[UI] 时间线重设计为「时间轴 + 详情」双栏**：左列色点+时间+单行摘要+按类型过滤 chips（全部/意图/事实/漏洞/检查点/探测），右侧详情面板按类型渲染完整字段——observation 含响应头/响应体原文与决策理由，finding 含七字段+原始请求响应，checkpoint 含阶段小结与决策；顺带修复事实事件从未显示的潜伏 bug（facts 在 projection nodes 里而非顶层 facts 数组）。
- **[纪律] 协议新增【用户待办】【基础设施】两章**：待办标题≤30字含完整登录 URL、detail≤120字分步指引；auth-session 必须走 Burp 三步流程并用 mcp__burp__get_proxy_history 取包、禁索要 HAR 原始包；短信/越权测试前必须先 src_get_infra。全程中文纪律���化（禁 let me/I'll 等英文插入语）；ask_user_question 仅限开场唯一阻塞时机。

## 0.1.0-local.21（包名署名修正：@howmp → @lihua_dis）

- **[改名] 包标识从 `@howmp/dsh-src` 全面迁移到 `@lihua_dis/dsh-src`**：原 scope 系沿用 dsh-pentest 参考项目的命名约定，属错误署名。替换范围：package.json name/author、cordis 服务名×4（ui-src/storage-sqlite/preset-root/src）、invariant 注册名、UI 模块与 CSS 资源 id（构建产物内）、README/docs 全部命令路径、LICENSE 版权行。tgz 资产名相应变为 `lihua_dis-dsh-src-<版本>.tgz`。
- **[安装] 安装目录变化**：包现位于 `~/.dsh/profiles/<p>/node_modules/@lihua_dis/dsh-src/`；从旧版本升级需删除旧 `@howmp/dsh-src` 目录（新旧并存会被宿主识别为两个插件）。caps-sync 默认路径文档已同步。
- 对 dsh-pentest 参考项目的技术致谢保留于 README「致谢」节。

## 0.1.0-local.20（自主收官三闸 + 报告「等你的事」+ AI 面自动深挖）

- **[门禁] finalize 收官三闸**（背景：实战会话第一波即 finalize，blocked intent 不建待办、报告后无人唤醒）：①`remainingDirections` 必填参数——调用前逐项枚举还能推进的方向，非空直接拒绝并回显清单；②pending 用户待办从 warning 升级为 blocker；③存在 blocked intent 但从未创建任何用户待办 → blocker（有待办但无关联 → warning 提示补建 intentId 关联）。三闸均可 `allowIncomplete=true` + reason 越过（受限完成声明照旧写入报告）。
- **[提示词] 【终止】重写为收官前三问**（待办清了吗/blocked 都有待办吗/还有可推导方向吗），禁止用「收益递减」含糊替代枚举；新增「报告不是终点」语义；禁止以收敛报告为由 interrupt 仍在产出结果的子代理。【用户待办】新增配对铁律：因缺用户输入标 blocked 的同一回合必须建 src_user_todo（intentId 关联）。
- **[报告] 尾部固定「⏸ 等你的事」区块**：列出 pending 待办（kind+标题+操作指引）与无待办关联的 blocked intent；无等待事项时显示「已完整收敛」。用户打开报告即可分辨自己是旁观者还是需要动手。
- **[AI 面] 放开自动深挖**：撤回「ai-surface 只落资产标注 manual-recommended 不作为 finding」的一刀切——语义复核确认真实 AI 面后按新内置课程 lessons/ai-abuse 自主推进：优先越权面/key 暴露（硬通货），再间接注入与工具滥用（src_serve_proof OOB 取证）；系统提示词泄露只作注入链证据；纯越狱不构成独立 finding。测不了或不全面（需登录态 RAG 投毒、浏览器人工交互）一律建 manual-test 待办移交用户，不得静默跳过。audit persona 同步。
- **[课程] 新增内置经验 lessons/ai-abuse.md**：测试优先级、无害金丝雀纪律（绝不真实生成违规内容，用受限标记物证明能力）、收录标准、常见误判。
- **[修复] 经验索引标题污染**：lessonIndex 标题混入「## 触发场景」等正文行（原实现取前 3 行拼接后匹配 ^#），改为全文按行匹配第一个一级标题。

## 0.1.0-local.8（质量标准修正 + finalize 门禁收紧 + 冗余工具清理）

- **[政策] 漏洞质量标准修正**：撤回"信息泄露/指纹类只能作 fact 不得作 finding"的一刀切禁令——SRC 平台接受一切有实际危害的真实漏洞（如版本暴露可匹配已知 CVE 定向利用），关键改为如实论证危害、severity 如实定级、不夸大不虚构；finalize 里对应的「仅 info/low 不构成真实危害」从 blocker 降级为 warning。同步修正 audit/verify 子代理 persona 措辞。
- **[门禁] allowIncomplete 收紧**：`src_finalize_engagement` 带 `allowIncomplete=true` 时必须提供 `allowIncompleteReason`（为何带限制出报告：WAF 全程拦截/范围耗尽/用户指示停止等）；理由作为 coverage 声明行写入报告的「资产与测试覆盖率」一节，不再是无痕逃生门。
- **[门禁] unverified finding 阻断消息给出可执行路径**：明确要求先委派 src_verify 子代理独立复核并以 `src_record_research(status=verified, findingId=…)` 关联后再 finalize。
- **[清理] 删除冗余工具 `src_record_recon` / `src_record_asset_observation` 注册**：与 src_add_asset/src_add_fact 完全重叠且实测服从率为零；两者 fold case 保留，旧会话投影回放不受影响（顺带修复 legacy record_recon 回放的 ReferenceError——replay 助手误定义在 src/submit 分支内）。

## 0.1.0-local.7（修复：待办 tab 崩溃 + SRC 视图入口标签）

- **[严重] 修复点击「待办」tab 后整个 SRC 视图崩溃变空白**：local.6 的 SrcView JSX 引用了 `runCommand` 但函数签名漏了解构该 prop，渲染待办列表时抛 `ReferenceError: runCommand is not defined`，被 slot ErrorBoundary 接住后整个视图替换为空 div。已补上签名；新增完整 SrcView 渲染回归测试（含 todos tab + 有/无 runCommand 两分支）。
- **[UI] 头部视图标签错标修正**：zh 字典 `view.src` 从「渗透」改为「SRC」——此前 src-hunter 会话头部第三个 tab 显示为"渗透"，实际是 SRC 漏洞挖掘视图，用户无法辨认入口。

## dsh web 启动 / 停止（部署后的进程管理）

本机 + 局域网共用一个实例（绑 `*:3080`）：

```bash
# 停止：找到监听 3080 的进程并结束
kill $(lsof -ti TCP:3080 -sTCP:LISTEN)

# 启动（后台常驻，日志落 /tmp/dsh-web-local9.log；必须用绝对路径——nohup 不继承 shell 的 export PATH；
# < /dev/null 不能省：stdin 挂在管道上时父进程退出会让 dsh 读到 EOF 静默退出）
nohup "$(pnpm bin)/dsh" web \   # 或 dsh 在 PATH 时直接用 nohup dsh web
  --host 0.0.0.0 --port 3080 \
  --trusted-host 192.0.2.7:3080 --no-open \
  > /tmp/dsh-web-local9.log 2>&1 < /dev/null &

# 验证
lsof -nP -iTCP:3080 -sTCP:LISTEN
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/
```

- 本机访问 http://127.0.0.1:3080 ；局域网访问 http://192.0.2.7:3080
- 日志里的 `Failed to connect to SSE server at https://localhost:9876` 是 Burp MCP 代理在等 Burp 的 MCP Server 扩展（Burp 未开时属正常噪音，不影响其他功能）。
- 注意不要同时跑两个实例指向同一 profile（会并发写同一个 sqlite）。

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

### Burp MCP 接入（已完成配置；后续已被自愈桥替代，见上文「接入你自己的 Burp MCP」节）
- 架构（历史）：`dsh-mcp-client(stdio) → mcp-proxy.jar → Burp Pro MCP 扩展(SSE 127.0.0.1:9876)`；
  现行为 `dsh-mcp-client(stdio) → burp-mcp-bridge.mjs（包 patch 默认启用）→ Burp Pro MCP 扩展`
- jar 已固定到 `~/.dsh/tools/mcp-proxy.jar`（已弃用）；profile patch 已写 `mcp-burp`（failOnStartupError:false，Burp 未开不影响其他工具）
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
