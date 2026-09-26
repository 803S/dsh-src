# dsh-src 后续优化总方案：证据链收敛、Laya 辅助决策与浏览器接入边界

日期：2026-09-26
基线：`b4126bd`（local.100 搜索引擎扩展与 Laya next-action 去重）
前置基线：`c7bd0bf`（local.99 证据交付链）、`9b8f4d4`（隔离盲测工具）
状态：**方案评审稿；本文完成前不继续追加运行时功能。**

> 本文的目标不是继续增加一个 Agent 平台，而是给普通实现模型一份可以按批次执行、可回滚、不会引入隐性编排的施工说明。任何超出本文范围的改动先停止。

---

## 0. 最终结论先行

### 0.1 不把 Laya 变成第二个 Agent

Laya 适合做：

```text
已有结构化 observation/state
→ 快速候选排序或风险建议
→ 返回一个受限选择
→ 宿主硬闸/现有 executor 执行
```

Laya 不适合、也不应负责：

```text
生成任意 selector / URL / payload / tool name
拥有 scope / approval / credential / evidence 权限
创建自己的 browser/page/context 生命周期
直接替代 dsh agent loop
自动运行外部 Skill 脚本
决定 finding / finalize / report 是否成立
```

### 0.2 不新增 HTB/Lab 模式

HTB 只是一个真实授权目标类型，仍然使用 SRC 主流程。目标是增强通用能力：

- IP:port 目标可正常建 goal；
- API/OpenAPI 响应可结构化提取；
- 搜索能力可复用宿主 Web seam 与当前 session proxy；
- bash 保留，Laya 只做旁路观察；
- browser 只有在宿主提供真实 executor seam 后才接管候选动作。

不新建：

- `lab_*` 工具；
- 第二套 service/flag/state/report；
- HTB 专用 finding 语义；
- 另一套 job queue；
- 另一套 browser/page/context 管理器。

### 0.3 不把“有 telemetry”当成“有收益”

所有收益判断必须区分：

```text
decision_called
decision_used
execution_changed
new_evidence_created
finding/research_linked
human_quality_reviewed
```

仅有 `laya.decision` 或 `skill.read` 事件，不能称为 Laya/Skill 生效。

---

## 1. 当前状态与已知问题

### 1.1 已完成且应保留

local.99 已解决：

- `src_http` 模型可见响应体、关键响应头和 evidenceId；
- HTTP/审批重放自动写 observation；
- 父子提交返回真实 ID，子代理沿父链读取证据；
- state/scan/bypass/playbook 结果渲染恢复关键决策信息；
- evidence 分页、脱敏、并发 observation ID 防覆盖；
- Pattern 接线；blocked 与 falsified 历史分离；
- Laya 独立自动执行分支删除，风险硬闸优先；
- 230/230 确定性测试通过（当前基线以实际 `npm test` 为准，不把数字写死）。

### 1.2 local.100 系列已经暴露的问题

#### A. Web 搜索 provider 分叉

宿主原生已有：

```text
ctx.web
web_search
web_fetch
WebSearchProvider
```

默认 dsh bundle 选择 DeepSeek native search provider，该 provider 需要 DeepSeek search key。SRC 新增的 keyless provider 已经使用 `ctx.web`，但应遵守以下边界：

- 当前 session 的 `proxyUrl` 必须通过 `makeHttpFetch(infra)` 使用；
- provider 不能直接使用裸 `globalThis.fetch` 绕过基础设施；
- 引擎选择不能硬编码为固定业务政策；
- provider 只能把搜索结果返回给宿主 `web_search`，不能自行追加另一套模型搜索工具；
- 引擎失败要保留明确错误和实际 engine，不把网络失败伪装为“无结果”。

#### B. Laya 主决策

当前 `agent/pre-step → next-action → user message injection` 已经存在，但它不是独立 planner。风险：

- 相同 state 可能重复决策；
- 候选只有 `intent-1/intent-2/continue` 等粗粒度动作，缺少上次结果、evidence delta、重复计数；
- Laya 选择 `continue` 并不代表产生了收益；
- 注入一条 user message 会增加上下文，可能放大延迟；
- 主 agent 仍负责所有实际工具选择和执行。

后续只能把它收敛为**低频、可回滚的建议器**，不能再往完整 orchestrator 扩展。

#### C. Risk-grade

真实会话曾出现：

```text
Laya auto-reject 阻断普通 GET 和认证基线
```

这会直接让认证绕过测试无法形成：

```text
无认证 baseline
→ 任意 token variant
→ 响应差分
```

因此最终设计必须是：

```text
Laya risk-grade = advisory + telemetry
classifyHttpRequest = 唯一执行/审批法律
```

Laya 不得直接拒绝普通 GET，也不得替代确定性审批。

#### D. Skill

当前真实 skill 决策曾出现：

- `skip` 占多数；
- 历史版本曾把 `fofa/agniops` 错当 Skill；
- 现在候选语义已经修正，但 Skill 仍是提醒器；
- `skill.read` 不能证明读取后改变了行为；
- 自动运行脚本会破坏既有审批边界。

因此不自动激活脚本，只补齐漏斗观测和低噪声推荐。

#### E. Browser

`lib/src/decision/browser-loop.js` 已经可以独立完成：

```text
snapshot → code candidates → Laya index → hard guard → existing MCP executor → after snapshot
```

但它没有接入正常 dsh agent 的 Playwright MCP 调用主链。生产会话只有 `laya.tool-advisory`，不能称为 browser-loop 已加速。

---

## 2. 外部项目研究与可复用结论

研究对象：

- Browser Use：<https://github.com/browser-use/browser-use>
- Stagehand：<https://github.com/browserbase/stagehand>
- BrowserGym：<https://github.com/ServiceNow/BrowserGym>
- WebArena：<https://github.com/web-arena-x/webarena>
- SeeAct：<https://github.com/OSU-NLP-Group/SeeAct>
- OpenAI CUA sample：<https://github.com/openai/openai-cua-sample-app>

### 2.1 Browser Use

核心特点：完整持有 BrowserSession/BrowserState/Controller，agent loop 统一管理 observation、action、history 和 judge。

**不能直接复制到 dsh-src：**

- dsh MCP host 已持有 page/context 生命周期；
- 复制 BrowserSession 会产生第二套浏览器状态；
- dsh 的工具事件、审批和 session projection 不会自动接上。

**可借鉴：**

- `BrowserState` 作为动作前快照；
- action schema 只允许结构化操作；
- after-action history 作为下一次决策输入；
- 单一 Controller 负责执行，不让模型自由生成低层 selector。

### 2.2 Stagehand

核心特点：

```text
observe → act → extract
```

执行仍由 Playwright locator/worker 负责，模型只负责从页面语义产生受限动作或结构化结果。

**这是最适合 dsh-src 借鉴的模式：**

- 保留现有 Playwright MCP executor；
- 增加一个 host-owned before/after seam；
- Laya 只选择代码生成的 candidate index；
- selector/target/参数由代码侧生成并在 stale/scope/approval guard 中校验。

### 2.3 BrowserGym / WebArena

核心价值是 benchmark、task environment、trajectory/evaluator，不是生产 browser executor。

**可借鉴：**

- 每一步 observation/action/result 都有 trajectory；
- 任务成功必须有独立 evaluator；
- 失败、未完成和未测试不能混成成功。

**不引入：**

- BrowserGym 的完整环境层；
- WebArena 的站点编排；
- HTB 专用 benchmark 模式。

### 2.4 SeeAct

核心价值：把 web grounding 和 action execution 分开，并用候选/标注降低模型直接产生 selector 的风险。

**可借鉴：**

```text
页面 observation → grounding candidates → model choose → executor → observation
```

### 2.5 OpenAI CUA sample

README 明确采用：

```text
persistent runtime
→ model code/action
→ browser worker
→ feedback
```

**可借鉴：** persistent worker 和 feedback loop；
**不复制：** dsh 已有 MCP worker，不能再创建一个 page/context runtime。

### 2.6 外部研究结论

研究与本机验证后，`ChenneyZhuang/laya-browser-agent` v0.3.2 是本批唯一直接采用的 browser System 1 backend：已复制到 `/Users/lihua-dis/Software/laya-browser-agent`，通过 `localdecide serve /v1/systemone` 使用 browser-tuned checkpoint 返回真实 `CLICK + target index`，首轮模型加载后的协议决策约 111ms。dsh 只采用它的 System One 决策协议，不采用其 PlaywrightDriver/CDPDriver 生命周期。其他项目只作为架构参考，不进入生产依赖。可复用的是模式，不是代码：

```text
Stagehand 的 observe/act/extract 分层
+ Browser Use 的 state/action history
+ SeeAct 的候选 grounding
+ BrowserGym/WebArena 的独立 evaluator
+ dsh 自己的 MCP executor / session / approval / evidence
```

最终原则：**只新增一个最小宿主 seam，不引入完整 browser agent。**

---

## 3. 目标架构

### 3.1 搜索链

搜索仍使用 dsh 原生 `web_search`，不新增 `src_web_search` 工具：

```text
model web_search(queries)
  → dsh-tool-web
  → ctx.web provider
  → selected provider
  → session-scoped makeHttpFetch(infra)
  → search result sources
```

provider 选择原则：

1. 用户/部署明确配置的 provider 优先；
2. 无配置时选择唯一可用 provider；
3. 有多个 provider 时明确返回 ambiguous，不偷偷固定优先级；
4. 当前 session 的 `proxyUrl` 只影响网络执行，不变成模型决策；
5. DuckDuckGo/Google/Bing/百度是 provider 内部可选来源，不把它们注册成四个模型工具。

### 3.2 Laya 决策链

Laya 分为三类，职责不能混：

#### A. 主循环建议器

```text
src state snapshot
→ candidate generator
→ Laya choose candidate index/id
→ 主模型收到≤1条建议
→ 主模型决定是否执行
```

候选必须包含：

```js
{
  id,
  label,
  intentId,
  reason,
  priority,
  lastOutcome,
  repeatedCount,
  evidenceDelta,
  blocked,
  nextRequiredTool
}
```

相同 state fingerprint 不重复调用；连续无 evidence 增长的候选降权；Laya 不得创建 intent、执行 tool 或改变 approval。

#### B. 工具 advisory

```text
tools/pre-execute
→ 对 bash/MCP/browser 产生 advisory telemetry
→ next()
```

不阻断、不重写参数、不替换 executor。bash 仍由 dsh sandbox/approval 控制，SRC HTTP 仍由 `src_http` 规则控制。

#### C. Browser candidate adapter

只有宿主提供正式 seam 后启用：

```text
before browser action:
  host observation
  code candidates
  Laya index
  stale/scope/approval guard
  existing MCP executor
  after observation
```

没有 seam 时只能保留 `browser-loop.js` 独立实验，不允许在普通 `tools/pre-execute` 中递归调用 snapshot/action。

### 3.3 Skill 链

```text
rules recall candidates
→ Laya semantic rerank（可选）
→ ≤1行提醒
→ 模型自己 src_read_lesson/src_read_capability
→ skill.read telemetry
→ 后续 tool/research/evidence 关联 recommendationId
```

不自动运行外部脚本，不自动审批，不把 `fofa/agniops` 当 Skill。

---

## 4. 分批实施规格

## Phase 0：冻结现状与回滚点

### 目标

先让普通实现模型不能误解当前状态。

### 任务

1. 创建基线 tag/commit 记录；
2. 记录当前生产 Web PID、profile 副本 md5、flags；
3. 记录当前测试数和 `npm test`；
4. 将 local.100 的哪些代码为实验标注清楚：
   - `agent/pre-step next-action`；
   - `tools/pre-execute advisory`；
   - `browser-loop`；
   - keyless provider。
5. 不再在代码默认值里开启高风险 Laya；启动脚本负责显式设置。

### 验收

- clean tree；
- 可一条命令回滚到 local.99；
- 回滚不删除用户数据库、凭证或真实目标数据。

### 停止条件

- 实现模型无法说明“哪个进程加载哪个 profile 副本”；
- 回滚需要修改数据；
- 需要新增持久化表才能继续。

---

## Phase 1：搜索 provider 正确接入，不新增模型工具

### 目标

修复“规则能走代理、web_search 不走代理”，同时消除固定引擎顺序。

### 代码任务

1. `lib/src/web-search-provider.js`
   - 保留一个 `src-keyless-search` provider；
   - `search(request, signal)` 支持 `engine=auto|duckduckgo|google|bing|baidu` 的内部选项；
   - 默认 `auto` 才允许 fallback；
   - provider 不读取全局生产 proxy，不保留全局 session 状态；
   - 从调用上下文读取当前 session 的 fetcher；
   - 返回 `engine`、sources、truncated 和每个失败引擎的诊断摘要；
   - 不把搜索引擎做成四个模型工具。
2. `lib/src.js`
   - 保留 dsh `ctx.web` provider seam；
   - 通过 AsyncLocalStorage 或等价调用局部上下文传入 session fetcher；
   - 不用一个进程全局 resolver 覆盖并发 session；
   - proxy 目标名单只负责网络路径，不负责模型选择。
3. profile patch
   - provider selection 使用可用 provider；
   - 不强制 DeepSeek search provider；
   - 不自动写用户 search key；
   - 不改变宿主 `web_search` schema。
4. 搜索引擎偏好
   - 普通 query 使用 `auto`；
   - 如果未来允许模型选择，使用 query metadata/内部结构，不增加新工具；
   - 不在常驻 SRC prompt 写“必须使用 Bing/百度”。

### 测试

- mock fetch：每个 engine parser；
- DDG失败→Bing成功；
- Google失败→百度成功；
- 指定 engine 时只请求该 engine；
- 两个 session 并发使用不同 proxy，不互相覆盖；
- 无 proxy 时走直连；
- `web_search` 失败返回 provider/engine 原因，不伪装为“无结果”。

### 验收

```text
当前 proxy 可达时，web_search 至少有一个真实引擎返回 sources；
web_search 的请求使用当前 session 的 proxyUrl；
不会因为 DeepSeek search key 缺失而直接失败；
不会固定强制某一个搜索引擎。
```

### 停止条件

- 需要新增搜索模型工具；
- 需要新增搜索 state 表；
- provider 只能依赖全局 mutable proxy；
- 需要复制 dsh-tool-web。

---

## Phase 2：Laya 只做低频候选重排

### 目标

把 Laya 从“每轮都问的模糊建议”收敛成“状态变化时才问的候选重排”。

### 代码任务

1. `lib/src.js` candidate generator 增加：
   - state fingerprint；
   - evidence delta；
   - repeated count；
   - last outcome；
   - blocked reason；
   - next required tool。
2. 相同 fingerprint 不调用 Laya；
3. Laya 返回 `continue` 或低置信度时不注入；
4. 注入消息标明 `recommendationId`、候选原因和“建议非权限”；
5. telemetry 记录：
   - offered candidates；
   - chosen candidate；
   - injected；
   - next actual tool；
   - evidence delta；
   - repeated count；
   - latency/fallback。
6. 不在 `src_http` 里再重复调用 delegate/skill/next-action；避免一个请求触发多个 Laya roundtrip。

### 验收

- 同一 state 连续 10 个 step 最多 1 次 next-action；
- 没有 evidence 增长的重复 intent 候选会降权；
- Laya 建议与实际下一工具可对账；
- Laya 不改变规则审批；
- Laya daemon 不可达时原流程完全可用。

### 停止条件

- 需要 Laya 直接调用工具；
- 需要 Laya 生成任意参数；
- 需要持久化一个新的 job queue；
- Laya 延迟超过当前模型请求可接受预算且无缓存/跳过策略。

---

## Phase 3：Skill 只做可观测提醒闭环

### 目标

不自动执行 Skill，只判断提醒是否有用。

### 代码任务

1. `skill recommendation` 使用结构化 route manifest；关键词只召回；资产类型、前置条件、禁止场景、成本和风险做重排；
2. 删除/隔离历史中把侦察 provider 当 Skill 的路径；
3. 推荐生成 `recommendationId`；
4. `src_read_lesson/src_read_capability` 回写 recommendationId（可从当前 session pending recommendation 关联）；
5. `skill.read` 事件关联最近 recommendation；
6. 下一次 intent/tool/research/evidence 记录是否发生在 read 后；
7. 置信度低、候选弱、已读过时不提示；
8. capability script 仍需原有 approval，绝不自动运行。

### 指标

```text
recommendation_rate
read_rate
read_to_next_action_rate
read_to_evidence_rate
read_to_finding_or_research_rate
skip_rate
false_recommendation_rate
```

### 验收

不能只测 `action=authorization`。必须证明：

```text
推荐 → 模型读取 → 读取后动作 → 新 evidence/research/finding
```

如果 read 后没有提高 evidence 率，删除提醒，而不是增加提示词。

---

## Phase 4：用 laya-browser-agent 替换当前 browser decision backend

### 目标

保留 dsh 现有 Playwright MCP 的 page/context/executor，只把当前 `browser-index` 的决策 backend 替换为本机 `laya-browser-agent/localdecide`。不再同时维护旧 Laya browser-index 决策路径。

### 已完成选择与仍需核查

已确认 `localdecide` 的 `/v1/systemone` 接口接收 state+typed questions，返回 validated choice/probabilities/confidence；其 driver 也明确把 observe 与 execute 分离，model 只选 observed index。仍需确认 dsh 宿主普通 MCP 调用的 before/after 生命周期，才能宣称普通 browser planning 已被替换；当前只替换 browser-index backend。

实现模型必须定位并记录：

1. `mcp__playwright__browser_*` 注册位置；
2. MCP tool call 是否经过 `ctx.tools.execute`；
3. page/context 生命周期所有者；
4. observation 产生位置；
5. action 前后是否有稳定 hook；
6. 如何绑定 session/engagement；
7. MCP 失败/导航/断连如何返回；
8. browser action 是否允许 post-execute 替换结果，不能替换实际动作的，就不要冒充接管。

### 外部项目借鉴

- Stagehand：优先借鉴 `observe → act → extract`，不复制 runtime；
- Browser Use：借鉴状态快照、ActionModel、history/judge；不复制 BrowserSession；
- SeeAct：借鉴候选 grounding；
- BrowserGym/WebArena：只借鉴 trajectory/evaluator，不引入 benchmark 平台；
- OpenAI CUA sample：借鉴 persistent worker + feedback，不复制第二 page/context。

### browser-index backend 已替换；完整 browser planning takeover 仍需 seam 确认后才能实现：

```text
before action observation
→ code candidate list
→ Laya index
→ stale/scope/approval guard
→ existing MCP executor
→ after observation
```

### 不能做

- 在普通 `tools/pre-execute` 中递归调用 snapshot/click；
- 创建第二套 Playwright context/page；
- 让 Laya 生成 selector/URL/JavaScript；
- 把 browser-loop 独立 fixture 通过当成生产接管；
- 在没有真实 host seam 时删除现有 browser prompt/tool/fallback。

### 验收

必须有真实 dsh agent→MCP executor→after observation 轨迹，且：

- Laya adopted action 与原 agent baseline 可配对比较；
- fallback 不误点击；
- stale target 不执行；
- action success 有独立完成校验；
- 没有第二套生命周期。

在 seam 未确认前，`browser-loop.js` 只作为兼容适配器，不能宣称生产 browser planning 已完全接管；不再继续扩大 browser runtime。

---

## Phase 5：审批质量评估，不声称“准确率”

### 当前不能计算准确率

已有 `approval.waiting/resolved` 只能算：

```text
waiting_count
resolved_count
allow_rate
latency
```

不能算审批准确率，因为没有真实标签：请求是否应该批准、是否产生副作用、是否误挂起。

### 最小补充

对每个审批重放记录：

```text
ruleVerdict
layaAdvice
userDecision
responseStatus
responseEvidenceId
sideEffectObserved（只有明确证据才填）
```

禁止用 `allow_rate` 冒充 accuracy。

### 评估方式

- 随机抽样人工复核；
- 本地 fixture 放入允许/拒绝双向样例；
- 高危写操作必须确认拒绝不发包；
- 低风险读请求不应进入审批；
- Laya 只能 advisory，最终准确率标签基于 deterministic rule + 人工结果。

---

## 5. 全局防膨胀审计

每个实现批次必须逐项检查：

### 文件与模块

- 是否新增工具？没有明确用户可调用价值就不新增；
- 是否新增状态表？优先复用 observations/research/coverage/telemetry；
- 是否新建 executor/lifecycle？默认拒绝；
- 是否新增 flag？必须有 off/shadow/on、回滚和测试；
- 是否破坏 `scripts/deploy.mjs` 清单；
- 是否需要 profile patch；是否会覆盖用户 caps-sync 生成区；
- 是否需要重启；是否确认 running session=0。

### 语义重复

- store/schema 是否是唯一硬法律；
- prompt 是否只解释原则；
- tool description 是否只解释参数和失败修复；
- lesson 是否只包含专题打法；
- 是否复制了授权、审批、finding、报告门禁；
- 是否把 provider、skill、tool、数据源混成一类。

### 运行链

- model result 是否真正进入模型上下文；
- `execute` 和 `render` 是否同时测试；
- decision 是否真正影响后续动作，还是只有 telemetry；
- action 是否由现有 executor 执行；
- evidence 是否自动保存；
- projection/store 是否一致；
- parent/child 是否使用同一 engagement；
- fail-open 是否留下明确 telemetry；
- 是否会因重复 step 重复调用外部模型。

### 预算

- Laya 单次调用是否有超时；
- 是否有状态 fingerprint 去重；
- 是否把完整页面/OpenAPI/响应体交给 Laya；
- 是否增加永久 prompt 字符数；
- 是否新增模型调用但没有可衡量收益；
- 是否可在没有 Laya 时完全运行。

---

## 6. 实现模型执行说明

普通实现模型必须按以下顺序执行，不得自行扩张：

```text
1. 读取本文件和最近 git 状态
2. 只实施当前 Phase 指定的一个 batch
3. 先补/更新回归测试
4. 跑 node --check、npm test、preset consistency、git diff --check
5. 检查 deploy 清单/package export/profile patch
6. 输出 diff、测试结果、风险和停止条件
7. 等待下一批，不自动进入下一个 Phase
```

必须停止并报告：

- 找不到宿主 browser seam；
- 需要复制 page/context 生命周期；
- 需要让 Laya 生成任意 URL/selector/payload/tool name；
- 需要新增持久化状态表；
- 需要删除现有 prompt/tool/fallback 才能证明；
- 需要强制中断 running session；
- 需要访问未明确授权目标；
- 搜索 provider 需要把 secret 写入 SRC 数据库或 session；
- 搜索请求没有使用当前 session proxy；
- 需要把工具 advisory 改成强制 deny。

---

## 7. 全局一致性结论

### 保留

- local.99 证据交付链；
- 现有 SRC 工具和 store/projector；
- dsh 原生 `web_search/web_fetch` seam；
- session-scoped proxy；
- bash/curl 原能力和宿主审批；
- Laya browser-loop 的独立实验与 hard guard；
- 现有 lesson/capability approval。

### 删除/回滚方向

- 不再把 Laya next-action 当完整 orchestrator；
- 不再把 browser-loop 当生产接管；
- 不再在 `tools/pre-execute` 里递归执行 browser action；
- 不再固定搜索引擎顺序作为产品策略；
- 不再把 delegate shadow telemetry 宣称为真实委派；
- 不再把 skill reminder 宣称为 skill activation；
- 不再用 approval allow_rate 宣称 approval accuracy。

### 最小后续实现顺序

```text
Phase 0 冻结与回滚
→ Phase 1 搜索 provider + session proxy + engine hint
→ Phase 2 Laya next-action 去重/信息增益字段
→ Phase 3 Skill 推荐→读取→证据漏斗
→ Phase 4 宿主 browser seam 事实核查
→ Phase 5 审批人工标签与准确率评估
```

在 Phase 4 seam 未确认前，不实现生产 browser takeover；在 Phase 1–3 指标未证明收益前，不再扩大 Laya职责。

**此文档完成后不自动改代码。实现从 Phase 0/Phase 1 单独开始，逐批验收。**
