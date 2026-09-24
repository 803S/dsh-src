# Laya 主决策循环精简改造计划

日期：2026-09-24  
状态：设计纠偏，尚未实施  
仓库：`/Users/lihua-dis/Software/dsh-src`

## 0. 核心判断

接入 Laya 的正确结果不是让项目增加一套 orchestrator、prompt、状态机和浏览器执行器，而是：

```text
原本由 agent 慢速思考的“下一步做什么”
→ 改为 Laya 快速选择

原本散落在 prompt / tool description / Skill 文档里的流程决策
→ 删除或压缩

原本必须由 agent 记住的工具和 Skill
→ 由代码提供真实候选，Laya 主动选择

原本由 Playwright/现有浏览器执行器完成的动作
→ 仍由原执行器完成，Laya 只负责快速选 operation + target
```

因此本计划的第一目标不是增加能力，而是**减少 agent 思考轮次、减少重复提示词、减少错误动作和减少决策代码重复**。

## 1. 必须保留的边界

Laya 可以决定合法候选中的下一步，但以下内容不能交给 Laya 或 prompt：

```text
scope / host 归属
approval / 凭据 / 写入与外部副作用
速率、并发和重试上限
页面 target stale 校验
证据保存、审计、恢复
```

这些是 dsh-src 的执行内核，不是“限制 Laya 的提示词”。

除此之外，不应继续堆叠静态流程说明来替代 Laya 决策。

## 2. 当前实现的真实问题

### 2.1 当前 Laya 仍是旁路调用

`src_http` 目前可能依次触发：

```text
risk-grade → delegate → skill → HTTP → response-classify
```

但这些决策没有形成一个“下一步行动包”，仍然主要由 agent 自己决定后续动作。因此当前 Laya 增加了调用，却没有替代 agent 的决策轮次。

### 2.2 Skill 接入位置太晚

当前 Skill 主要在 `src_http` 即将执行时才提醒：

```text
agent 已经决定调用 src_http
→ Laya 才提醒 Skill
```

这无法解决 agent 根本没有想到以下动作的问题：

```text
读取 capability、读取 lesson、使用浏览器、调用 Burp、获取认证流量、创建验证 intent、委派子任务
```

Skill/tool recall 必须位于“下一行动决策”之前，而不是只附加在某个工具返回值后面。

### 2.3 当前仓库没有确认的 browser action loop

dsh-src 当前明确拥有 `src_http`、intent、telemetry、Laya client 等 SRC 能力，但仓库内没有一个已确认的 `src_browser`/Playwright action loop 可直接替换。

所以不能直接在 dsh-src 内新建第二套 browser/context/page 生命周期。第一步必须找到现有 browser executor 的真实入口，然后只接一个 adapter：

```text
现有 browser observation
→ Laya decision
→ 现有 Playwright/MCP action executor
```

如果宿主没有 before/after action hook，必须先补一个最小 hook；不能用“新增几个 browser 文件”假装已经接入主循环。

### 2.4 `laya-client.js` 需要先成为可靠协议适配器

当前 risk 路径和通用 `layaRequest()` 对 daemon response 的解析假设不完全一致。若 choice answer 没有预期的 `type` 字段，delegate、skill、response-classify 可能错误 fallback。

在接入主循环前必须统一：

```text
请求 schema
→ response parser
→ action / target / confidence / probabilities
→ fallback
→ latency / adopted telemetry
```

否则 Laya 的正确决定可能被 adapter 丢掉，agent 仍然回到慢思考。

## 3. 最小目标架构

不建设完整 orchestrator。只建设一个薄的 `next-action` 适配层：

```text
当前 observation/state
  → 代码生成真实候选
  → 一次 Laya decide
  → 返回 next-action
  → 既有工具/浏览器执行
  → 执行结果进入下一轮
```

最小输出：

```js
{
  actionId: "src_http|src_read_capability|src_read_lesson|browser.click|delegate|ask_user",
  targetRef: "已有候选 ID 或浏览器编号元素",
  skillId: "已有 skill，可为空",
  args: {},
  confidence: 0,
  source: "laya|rules|fallback"
}
```

这里的 `actionId` 必须来自代码提供的候选，不允许 Laya 生成任意工具名、selector、坐标、URL、JavaScript 或 shell 命令。

## 4. 减法原则

接入 `next-action` 后，应删除或压缩以下重复内容：

- 主 prompt 中“下一步应该调用什么工具”的长流程规则；
- tool description 中重复解释所有 Skill 选择逻辑的文字；
- 每个模块各自维护的 self/delegate/skill/next-step 判断；
- `src_http` 中无条件串行触发 risk、delegate、skill 的多头 hook；
- 为弥补 agent 遗忘而堆叠的静态能力提醒。

保留：

- 工具参数、返回结构和错误修复说明；
- 安全硬闸、审批和 scope 说明；
- 能力/Skill 的真实 manifest；
- 证据、审计和恢复约束。

验收不是“新增了多少 Laya 代码”，而是：

```text
tool description 字符数下降
主 prompt 流程决策文字下降
重复 skill 提醒下降
agent 为下一步产生的 turn 下降
有效动作耗时下降
```

## 5. 实施阶段

### Phase 0：基线和协议修复

目标：先确保 Laya 决策可被可靠使用。

只做：

1. 固定当前 repo/profile/process 版本校验。
2. 测量 daemon `/decide` 的实际延迟：空请求、risk、skill、browser observation 分开测。
3. 统一 `laya-client.js` 的 response parser，兼容 daemon 实际返回，不依赖偶然的 `type` 字段。
4. 保留统一最低公共字段：

   ```text
   action / targetRef / confidence / probabilities / source / fallback / latency
   ```

5. telemetry 只记录：候选、选择、延迟、fallback、是否被执行；不新增业务状态表。

验收：

- Laya 正确返回的 choice 不会被错误 fallback；
- daemon 超时仍能回退现有路径；
- 得到真实 p50/p95 后再决定不同任务预算；
- 不新增 prompt 或 orchestrator。

### Phase 1：Next-action 主决策包

目标：让 Laya 真正替代 agent 的下一步思考。

候选来自现有注册表和状态：

```text
现有 dsh tools
现有 capabilities
现有 playbook/lessons
当前 goal/intent
最近 observation/finding
当前 browser action（若宿主提供）
```

Laya 一次选择：

```text
read-skill
read-capability
run-capability
src_http
browser-action
delegate
parallel
record-research
ask-user
```

不再独立串行调用：

```text
先问 delegate
再问 skill
再问 target
```

`delegate` 只是 next-action 的一种候选，不是每个 HTTP 的固定 hook。

### Phase 2：Browser fast loop

前提：确认宿主现有 browser executor。

目标链路：

```text
existing page observation
  → 编号/结构化元素候选
  → 一次 Laya 返回 operation + targetRef
  → stale/scope/approval guard
  → existing Playwright action
  → useful-change observation
```

第一批只接：

```text
observe / click / type / press / scroll / wait / extract
```

Laya 输出示例：

```js
{
  operation: "click",
  targetRef: "e17",
  value: null,
  observationFingerprint: "...",
  confidence: 0.91,
  expiresAt: 0
}
```

不得新增第二套：

```text
browser/context/page 生命周期
Playwright driver
scope/approval/recovery
```

stale、页面变化、Laya 超时或协议错误时，直接重新观察或回退现有 executor。

### Phase 3：主动工具/Skill 记忆

目标：解决 agent 偷懒和忘记工具，而不是在 `src_http` 返回一行容易被忽略的提示。

触发时机：

```text
新 goal/intent
intent 状态变化
出现新资产或新输入类型
browser 页面类型变化
认证边界变化
上一步失败或需要换方向
```

Laya 看到的不是静态 Skill 名称，而是带能力和前置条件的真实候选：

```js
{
  actionId: "src_read_capability",
  targetRef: "authorization",
  reasonCode: "object-id-plus-auth-boundary",
  preconditions: ["second-account"],
  nextAction: "read-before-test"
}
```

去重单位不能是“整个会话一次”，应是：

```text
session + intent + phase + contextFingerprint
```

这样早期读过 `js-reverse` 后，后续进入授权验证仍能召回 `authorization`。

### Phase 4：研究路径和 payload 记忆

只建设轻量研究目录，不建设 payload 执行平台：

```text
research/inbox/
research/triaged/
research/replay/
research/accepted/
```

X、博客、报告中的内容先转成：

```text
假设
前置条件
输入位置
安全变体
预期 oracle
来源/许可证
本地复现状态
```

Laya 选择的是：

```text
是否适用
下一实验
需要什么前置条件
```

不是直接选择并执行任意 payload。

第一批最多 20～50 个经过本地 fixture 或授权目标验证的 hypothesis。未验证内容不进入运行时候选。

## 6. 明确后置事项

以下不再作为 Laya 接入主线的前置工作：

- 完整 `repetition.js` 和强制重复阻断；
- 完整 `closure.js` 和自动 intent 收尾；
- approval/todo TTL 与历史状态治理；
- 持久化 orchestrator/job queue；
- 第二套 browser executor；
- 大型 payload 数据库；
- 全系统统一的复杂 decision envelope。

这些可以在主决策循环已经证明有效后，根据真实数据单独处理。当前只允许记录轻量 observation，不直接阻断差分、状态机或 fuzzing 变体。

## 7. 规模控制

接入 Laya 后新增代码原则上只允许三类：

```text
Decision adapter：把已有状态/候选转成 Laya 输入
Action adapter：把 Laya 输出交给已有工具/浏览器执行器
Hard guard：执行前校验 scope/approval/stale/evidence
```

若一个改动同时新增：

```text
新 prompt + 新 flag + 新状态 + 新存储表 + 新执行器
```

则默认判定为过度设计，必须拆回最小 adapter。

## 8. 关键指标

不以“Laya 调用越少越好”为目标，重点衡量：

```text
被 Laya 替代的 agent planning turn 数
browser action p50/p95
有效动作完成时间
action 失败率
fallback 率
tool/Skill 采纳率
agent 忘记工具导致的重复探索
每个 intent 的有效验证数
verified finding rate
```

只有在这些指标改善时，才继续扩大 Laya 的决策范围。

## 9. Done 定义

本计划完成的标准：

1. Laya 已经进入真实 next-action loop，而不是只写 shadow telemetry。
2. 一次决策能覆盖工具/Skill/浏览器动作选择，agent 不再为每一步重复慢思考。
3. 现有 browser executor 被复用，没有出现第二套 browser 生命周期。
4. 工具和 Skill 由真实候选自动进入决策上下文，agent 不再依赖记忆名称。
5. 旧 prompt 中重复的流程决策被删除或压缩。
6. 安全边界仍由代码硬校验，不依赖 Laya 自律。
7. 研究内容可以通过结构化 hypothesis 进入候选，但未验证 payload 不会直接执行。
8. 项目代码和状态复杂度下降，而不是新增一套 Agent 平台。
