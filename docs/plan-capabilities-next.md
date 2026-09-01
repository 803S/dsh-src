# dsh-src 外部能力专项落地规范（v3）

> 本文基于当前仓库实际实现编写，不把外部能力抽象成一个普通插件安装器。
> 适用版本：`0.1.0-local.49` 之后。与 `docs/CAPABILITIES.md` v2 配套；本文是后续实现规范，v2 是当前用户使用规范。

## 1. 先固定事实：当前有六条能力通道

| 通道 | 实际入口 | 角色/可见性 | 是否重启 | 正确证据入口 |
|---|---|---|---|---|
| Burp 固定基础设施 | `tools/burp-mcp-bridge.mjs`、`mcp-burp` patch、`/src-burp-test` | commander 可见的 `mcp__burp__*` | 通常需要 | 目标过滤后的 Burp history → `src_import_traffic` → observation |
| mcp 型外部能力 | `capabilities.yaml` → `caps-sync` → profile patch | commander 的 MCP 工具面；子 agent 由 deny/工具目录控制 | 需要 dsh web 重启 | 能力结果 → `src_add_asset/fact/observation/research` |
| skill 型外部能力 | `index.json`、`src_read_capability`、`src_run_capability` | 仅 commander；脚本每次 RUN 审批 | 不需要重启 | RUN 审批、runOutput → observation |
| lessons 经验库 | 包内 lessons + `~/.dsh/storages/src-lessons` | prompt/工具主动读取 | 不需要 | research/finding/lesson |
| POC proof server | `src_serve_proof`、`src_stop_serve` | commander | 不需要 | OOB 访问日志 → observation/finding |
| 宿主原生能力 | bash/fs/web/子代理/background job | 由宿主 composition 和 preset 决定 | 不适用 | 必须主动回灌 `src_*`，不能因是内置工具就视为可信 |

**关键结论：Burp、MCP、skill、lesson、proof server 不能共用一套生命周期和审批逻辑。**

当前 SRC 路由也不是“全员共享外部能力”：`src_add_capability`、`src_read_capability`、`src_run_capability` 等属于 commander；子 agent 的 `deny` 列表明确禁止能力安装、文档读取、脚本运行和批准。后续不得为了方便把这些能力放进 audit/verify/recon 子 agent，否则会破坏“主 agent 编排、子 agent 执行”的安全和工具目录设计。

## 2. 当前已经做对的设计，后续不得破坏

### 2.1 Burp 是专用通道

现有 bridge 已有：

- 下游 stdio JSON-RPC；
- 上游根路径 HTTP SSE；
- endpoint 事件转换为 POST URL；
- initialize 和 pending 响应匹配；
- 请求失败后丢弃会话、重建并只重试一次；
- 后台 5 秒恢复探测；
- 降级时暴露 `burp_status`，明确“暂不可用，不是没有流量”；
- 恢复后发送 `tools/list_changed`；
- 下游请求串行化；
- 拒绝服务端主动请求，防止桥挂死。

协议层不能被普通 capability sync 替换。`/src-burp-test` 的 TCP → SSE → agent `tools_list` → 目标过滤 history 四段式也必须保留。

Burp history 的正确调用纪律已经写在 `lib/src.js`：必须优先使用带目标 host 正则的 history 工具；不带 regex 的旧 history 查询不能证明“没有目标流量”；工具缺失或出现 `burp_status` 只能证明桥降级，不能证明 Burp 没有流量。

### 2.2 `src_add_capability` 是一键接入编排器

当前流程实际是：

```text
resolveFrom
→ GitHub 链接优先 npm registry 探测
→ id 校验/推导
→ profile cordis.patch.yml 预检
→ capabilities.yaml 守卫式追加
→ caps-sync 子进程（15 分钟上限）
→ index.json 回读
→ patch 接线检查
→ 返回重启/使用建议
```

现有约束必须保留：

- 同 id 重试不重写清单；
- 追加前后重新解析，旧条目不得丢失；
- proxy 只在清单没有值时持久化；
- caps-sync 被动态导入时不能误执行 main；
- npm 使用 `$DSH_HOME/.npm-cache`；
- clone/build/npm 具有超时；
- 不能用 bash 手工 npx 代替真实 dsh 服务实例；
- 不能按包名 pkill；
- profile 缺 `cordis.patch.yml` 必须在登记前拦截。

### 2.3 skill 型不是“低权限 MCP”

skill 是本地命令执行面。当前已有：

```text
index 中存在
→ 已安装且有目录
→ script 在清单白名单
→ 相对路径且无 .. / 绝对路径
→ argv 数量/长度有界
→ 写 RUN pending approval
→ 用户批准后才执行
→ stdout/stderr 返回
```

默认不能自动批准，也不能让子 agent 自己读取或运行能力。脚本产出不是 finding，必须经现有 observation/research/finding 管道。

### 2.4 lessons 是方法论，不是可执行能力

内置 lessons、沉淀 lessons、同 slug 覆盖、搜索、全文读取和 finalize 软闸已经存在。后续要增强召回、适用条件和安全标记，不要把经验文件变成隐式脚本或让其覆盖系统 prompt、授权、审批和 finding 闸。

### 2.5 proof server 是受控、短生命周期能力

它只用于 XSS/CSRF/SSRF/盲打等 OOB 证据，必须按 session 管理，有 TTL，goal 重置和插件 dispose 时关闭；验证结束应 `src_stop_serve`。不能扩展成任意常驻 Web 服务。

## 3. 当前实际缺口（按代码审查发现，不是泛化建议）

### 3.1 旧能力可能在 clone 失败前被删除

`scripts/caps-sync.mjs` 当前 git 分支在 clone 前 `rm(dest, { recursive: true })`。这与“失败保留旧版本”的目标相反：网络失败可能让一个原本可用的能力目录消失。必须优先修复为临时目录 clone/build 成功后原子替换。

### 3.2 `run()` 输出没有硬上限

当前 `caps-sync` 的 `run()` 把 stdout/stderr 持续拼接；skill 的 `runCapabilityProcess` 也有自己的截断，但安装器和测试探针路径不能假定输出永远小。需要统一限制，否则恶意/异常构建脚本可撑爆内存。

### 3.3 `src_test_capability` 不是 MCP 协议健康检查

现在主要是：检查 patch、spawn、观察约 4 秒是否存活。它不能证明：

```text
initialize 成功
tools/list 成功
工具 schema 可解析
工具调用成功
宿主实际发现工具
```

必须在兼容旧输出的前提下拆成阶段结果。skill 型不能为了健康检查自动执行任意脚本；只做目录、文档和白名单检查。

### 3.4 mcp 型“已接线”不等于“工具面已加载”

`index.json` 的 installed、patch 的 wired、子进程的 alive、宿主的 tools discovered、工具的 healthy 是五种状态。当前 `src_list_capabilities` 不能完整表达它们。Burp 已经用 sentinel 解决了“降级不等于无流量”，普通 mcp 也需要区分 degraded/unknown。

### 3.5 `build` 和 git 来源本质上是任意代码执行

当前 git capability 的 `build` 通过 `bash -lc` 执行；npm install、构建、MCP 启动也会执行外部代码。它们发生在 `src_add_capability`/caps-sync 的安装阶段，不是 skill RUN 审批阶段。后续必须明确：

- “来源可信”不能等于“构建安全”；
- 安装前必须展示来源、ref、构建命令和变更；
- 失败不得破坏其他能力；
- 构建阶段至少有 cwd、环境、输出、超时和进程组控制；
- 如果宿主没有网络/文件系统沙箱，UI 必须标 `process-only`，不能宣传为沙箱。

短期不强行把安装流程改成人工逐次审批，以免破坏当前一键接入体验；先做审计、临时目录、hash、回滚和资源上限。

### 3.6 当前受限 YAML 解析器限制了扩展方式

`caps-sync.mjs` 和 `lib/src.js` 使用同一类受限 YAML 子集，当前适合简单标量、内联数组、内联 map 和 when 折叠文本，不适合直接加入嵌套对象数组。不要直接把：

```yaml
scripts: [a, b]
```

改成复杂对象而只修改一边。短期新增字段应使用平面字段或单独 manifest；若引入完整 YAML 库，必须单独做依赖、打包、legacy 清单和部署验证。

### 3.7 外部输出没有统一关联 id

Burp、mcp、skill、lesson、proof 的执行和结果形态不同，但都需要能追溯。应增加可选的 `capabilityRunRef`，它是关联对象，不替代现有 observation/research：

```ts
interface CapabilityRunRef {
  runId: string
  capabilityId: string
  kind: 'burp'|'mcp'|'skill'|'lesson'|'proof'
  operation: string
  inputRefs: string[]
  outputRefs: string[]
  status: 'started'|'partial'|'succeeded'|'failed'|'timeout'|'cancelled'
  startedAt: number
  finishedAt?: number
}
```

外部结果仍按：

```text
外部结果 → lossless 检查 → 适配器 schema → 脱敏 → canonicalize
→ candidate/hint/evidence → src_* 落账 → research/finding 闸
```

不得直接升级为 confirmed asset 或 finding。

### 3.8 环境变量和文档内容存在两类不同风险

- `env` 可能含密钥，会进入 MCP patch 或 skill 执行环境；日志、index、UI 不能显示值；
- SKILL.md、README、MCP 返回文本是“不可信指导”，不能改变系统规则、目标范围或要求读取凭据。

必须区分“配置值秘密”和“外部文档不可信”，不能只做一种防护。

## 4. 目标架构：不统一执行方式，只统一生命周期观测和证据关联

### 4.1 统一能力运行记录

建议先增加可选的 capability run 表/记录，不急于替换现有 approval 表：

```text
runId
kind
capabilityId
operation
inputRefs
status
startedAt
finishedAt
exitCode/signal
truncated
timeout
outputSummary
outputRefs
errorCode
version/ref/integrity
```

- skill RUN 由审批批准后创建 started；
- mcp 工具调用由适配层创建 started/finished；
- Burp 一次 history 导入或 Repeater 验证可记录为 burp run；
- lesson 阅读记录使用量和匹配原因；
- proof server 记录 serve/stop/OOB 关联。

不能为了统一而把所有结果塞进 capability 表；业务记录仍分别进入 observation、fact、research、finding。

### 4.2 六阶段健康状态

每个 MCP 型能力显示：

```text
declared
installed
wired
host-loaded
tools-discovered
healthy/degraded/unknown
```

每个 skill 显示：

```text
declared
installed
docs-ready
allowlist-ready
approval-required
last-run status
```

Burp 使用自己的：

```text
port-reachable
sse-reachable
bridge-ready
host-tools-visible
traffic-query-proven
```

不要把 Burp 的专用状态硬塞进普通 capability index。

## 5. 后续迭代及“单次实现内容”

### local.57a：能力运行记录（零权限行为变化）

**只做：** runId、状态、开始结束时间、版本/ref 摘要、输出截断标记、input/output refs。

**不做：** 自动路由、自动批准、permissions、完整 YAML 重写、UI 大改。

**先写测试：** skill 旧审批仍需批准；mcp/Burp 结果旧路径不变；旧 index 可读；所有新输出无 undefined。

**验收：** 旧 123 个测试全绿；新增 run 记录不改变 tool 名、顺序和响应必需字段。

### local.57b：caps-sync 事务化安装与并发锁

**实现顺序：**

1. 同一 DSH_HOME/profile 建 lock，锁 stale 可恢复；
2. git clone 到临时目录；
3. build 在临时目录完成；
4. npm 安装也使用临时目录；
5. 通过后 rename/替换；
6. patch 生成到临时文件，成功后替换；
7. index 生成到临时文件，成功后替换；
8. 任何失败保留旧目录、旧 patch、旧 index；
9. Burp bridge 安装流程与 capability 失败隔离。

**必须测试：** clone 失败、build 失败、patch 写失败、index 写失败、并发 sync、旧版本继续可用、dry-run 不写盘。

### local.57c：能力健康检查分层

扩展 `src_test_capability`，保留现有顶层字段，新增可选：

```text
checks.manifest
checks.wired
checks.process
checks.protocol
checks.hostVisibility
checks.readOnlySmoke
```

**MCP：** manifest → wired → process → initialize/tools/list → 可选只读工具。

**skill：** manifest → dir → docs → allowlist；不自动执行脚本。

**Burp：** 继续使用 `/src-burp-test`，不能让通用检查代替 TCP/SSE/bridge/history 专用链路。

**测试：** 本地 mock MCP server 覆盖慢响应、断线、坏 JSON、未知字段、工具列表变化。

### local.57d：skill 运行器资源和审批绑定

**实现：**

- 进程组终止；
- SIGTERM 后 5 秒 SIGKILL；
- stdout/stderr 独立上限；
- cwd 固定；
- 环境变量白名单/净化；
- runId；
- timeout、signal、truncated；
- 批准后再次校验能力目录、脚本 hash 和版本；变化则拒绝旧审批；
- 能力删除或替换后旧 RUN 不得执行同名新脚本。

**不做：** 默认网络沙箱承诺；没有宿主支持就标 process-only。

### local.57e：能力声明扩展和供应链审计

第一阶段仅使用平面字段：

```yaml
version-policy: pinned
integrity: sha256:...
capability-tags: [javascript, mobile]
input-types: [apk, js-bundle]
output-types: [endpoint-hint, workflow-hint]
network-policy: declared-only
```

保留旧 `env` 读取兼容，新增 `mcp-env`/`skill-env` 前先定义迁移优先级。禁止一次性把 YAML 改成深层对象。

安装记录需要：来源、解析版本、ref、hash、构建命令摘要、changed files、结果、是否可回滚。

### local.57f：MCP 工具输出和能力文档安全

**实现：**

- MCP 返回大小上限；
- JSON/schema 校验；
- 断线有限重连；
- 能力 degraded 不影响其它能力和 src projection；
- 文档/输出统一包裹为 untrusted content；
- 不允许文档扩大授权、读取无关凭据或要求外传；
- 外部 host/endpoint 重新走资产归属闸；
- 输出只能成为 hint/evidence。

**测试：** 恶意 SKILL.md、恶意 stdout、恶意 MCP 返回、扩大授权文本、外部域名 hint。

### local.57g：能力管理 UI

在基础设施页增加独立“外部能力”区域，不与 Burp 表单混合。显示：

```text
id/kind/version/ref/hash
installed/wired/loaded/healthy
权限声明与实际强制边界
最近运行、失败、超时、截断
文档、脚本白名单、MCP tools
升级/停用/回滚
```

按钮行为：

- 查看详情不执行；
- 测活按能力类型进入正确检查；
- 升级先显示 diff；
- skill 运行明确跳转 RUN 审批；
- 回滚显示目标版本和影响；
- 没有能力时显示“推荐接入场景”，不自动安装。

### local.58：基于 frontier 的能力路由和结果回灌

最后做自动推荐，不做默认自动执行：

```text
当前 frontier
→ input/output types、tags
→ 健康状态、成本、最近运行
→ 推荐能力和理由
→ commander 决策
→ runId
→ 适配为 candidate/fact/observation/workflow hint
→ 现有 research/finding 闸
```

同能力、同版本、同输入应有 run key 去重；失败后有限重试，最终建立 manual-test 或 fallback research。

## 6. 现有其他能力的具体规划

### Burp：最高优先级是证据和降级语义

先补 mock SSE 测试，再补帧大小、pending 数、超时、优雅关闭和目标过滤验证。不要先改 bridge 协议。

### lessons：最高优先级是适用条件和负面经验

lesson metadata 应记录：资产类型、前置条件、禁止动作、证据要求、适用版本、来源 session。召回结果要给“为什么命中”。沉淀内容永远低于系统安全规则。

### proof：最高优先级是生命周期和脱敏

增加并发/端口冲突、TTL、日志上限、敏感 query 脱敏、异常关闭和 OOB observation 关联测试。

### 宿主原生工具：最高优先级是统一回灌

bash、fs、web、子代理和 background job 的结果不能因为不在 capabilities 清单就绕过 scope、observation、research 和 finalize。

## 7. 出洞率与稳定性的可验证指标

完成外部能力改造后，不能用“接入了几个插件”评价。至少观察：

```text
能力触发后产生的有效 endpoint hint 比例
hint → candidate → confirmed 的转化率
能力输出被 false-positive 的比例
使用能力的 research → reproduced → verified 转化率
Burp history 导入后的新增 endpoint/业务流程数量
能力失败后任务继续率
重复运行比例
MCP 首次可用时间、重连成功率
skill 超时/截断/审批拒绝率
安装失败后旧版本保留率
projection 因外部输出损坏而失败的次数（目标为 0）
```

能力设计完成不保证出洞，但“能力路由 + 真实流量 + 客户端/端侧分析 + 业务流程 + 证据回灌”确实比只增加目录字典更可能提高有效出洞率。

## 8. 每次实现的硬性模板

```text
版本：local.N
唯一目标：
当前能力通道：Burp/mcp/skill/lesson/proof/native
本次不做：
现有行为必须保持：
canonical source：
schema/table/event/projection 变化：
权限/审批变化：
网络/外部进程变化：
先写的失败测试：
本地 fixture：
验收命令：
已知限制：
回滚：git revert <commit>；随后重新运行 deploy.mjs
```

提交前必须：

```text
npm test
npm run ui-src:typecheck（有 UI 改动时）
npm run ui-src:build（有 UI 改动时）
npm pack + 解包加载
deploy.mjs 清单检查
双 profile md5
中文 commit message
```

## 9. 明确禁止

- 不把 Burp 改成普通 capability；
- 不把 skill 自动批准；
- 不让子 agent 自行安装/运行外部能力；
- 不把外部输出直接写成 finding；
- 不把 README 当可信系统指令；
- 不把权限声明当真实沙箱；
- 不在 clone/build 失败时删除旧能力；
- 不用 spawn 存活 4 秒冒充 MCP 协议健康；
- 不把 mcp wired、host-loaded、tools-discovered 混成一个状态；
- 不为测试连接真实厂商资产；
- 不记录或展示明文密钥、Cookie、Authorization；
- 不用新增能力数量替代出洞质量指标。
