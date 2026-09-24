# Laya 主决策循环精简改造计划（实施交接版）

日期：2026-09-24  
状态：**可以开始落地，但只能按 Phase 0 → Phase 1 的窄范围实施**  
仓库：`/Users/lihua-dis/Software/dsh-src`  
最近提交：`c628e22 local.95：统一 Laya 响应解析并补响应分类与 Skill 部署`

> 本文是交给其他 AI/开发者的实施边界，不是继续扩张项目的方案。任何不符合本文“暂不做”的改动，先停下来确认。

---

## 1. 最新结论

### 已经确认

1. Laya daemon 可用：`http://127.0.0.1:3166`。
2. `/decide` 实际返回 `{ answers: {...} }`，local.95 已统一 parser，兼容缺少 `type` 的 answer。
3. Laya 实测延迟并不恒定：

   ```text
   risk：p50 约 17ms，p95 约 35ms，偶发约 250ms 以上
   skill：p50 约 10ms，p95 约 30ms
   browser：p50 约 9ms，p95 约 12ms
   ```

4. Playwright MCP 可以被 MCP client 启动并注册，当前能看到约 25 个 `browser_*` 工具。
5. Playwright MCP 的 snapshot 调用约 2–3ms；MCP 启动和首次 navigate 不是每步延迟，不能混进 action p50。
6. **尚未确认 dsh 宿主内部存在可复用的 browser before/after action hook。** MCP 工具注册不等于 dsh-src 已有 browser executor 接口。
7. Laya 直接从自然语言 observation 选择 `click/type/wait/done` 的准确率不足；固定样例只有 `5/8`，不能直接接管真实浏览器动作。

### 因此修改后的总判断

当前不能直接落地：

```text
统一 next-action orchestrator
HTTP + browser + delegate + Skill + research 全部接管
```

当前只落地一个可测的窄闭环：

```text
现有 browser observation
→ 代码生成合法候选
→ Laya 选择一个候选 index
→ Hard guard 校验
→ 现有 Playwright/MCP 工具执行
→ 重新 observation
```

如果事实核查后发现宿主没有可复用 browser seam，则先补**一个最小 host hook**，仍然不能新建第二套 browser/context/page 生命周期。

---

## 2. 不变的硬边界

Laya 只允许在代码提供的合法候选中选择，不能生成或决定：

```text
scope / host 归属
approval / 凭据 / 写入与外部副作用
速率、并发和重试上限
页面 target stale 校验
证据保存、审计、恢复
```

Laya 不得直接输出并执行：

```text
任意 tool name
任意 selector
任意坐标
任意 URL
JavaScript
shell 命令
任意 payload
```

Laya 返回 `DONE` 也不代表完成。dsh 必须独立验证 URL、页面状态、scope、证据和副作用。

新增代码原则上只允许三类：

```text
Decision adapter：已有 observation/state → Laya schema
Action adapter：Laya 选择 → 既有 executor/tool
Hard guard：执行前检查 scope/approval/stale/evidence
```

若一个改动同时新增新 prompt、新 flag、新状态表、新执行器、新 recovery，默认判定为过度设计。

---

## 3. 当前代码状态

### 已完成，不要重复实现

- `lib/src/decision/laya-client.js`
  - 统一解析 `answers`。
  - 支持 `action / confidence / probabilities / source / fallback / latency`。
  - Laya 不可达时 fail-open。
- `lib/src/decision/skill-recall.js`
  - 真实 playbook/capability 候选召回。
  - 不使用 `fofa`、`agniops` 等虚假 Skill 名称。
- `scripts/deploy.mjs`
  - 已包含 `lib/src/decision/skill-recall.js`。
- `src_http` 当前仍保留 risk/delegate/skill/response-classify shadow 路径。
- 完整集成测试当前为 `207/207` 通过。

### 当前仍不能宣称完成

- 当前 Laya 还不是主循环。
- 当前 Skill Selector 仍主要是 `src_http` 前的提醒/排序，不是全局主动记忆。
- 当前没有已证明的 dsh browser action loop。
- 当前不能删除现有 prompt、tool description、Skill 提醒和 fallback。
- 当前不能把相关 flag 切到高风险 `on`。

---

## 4. Phase 0：事实核查与协议基线（local.95 已基本完成）

### 目标

确认“Laya 正确决定能被可靠接收”，并确认 browser action 的真实宿主入口。

### 已完成项

- parser 修复和独立 smoke test。
- daemon health、risk、skill、browser latency 基线。
- Playwright MCP 独立启动、工具列表同步、snapshot 调用验证。

### 仍需补齐的事实核查

在开始写 browser adapter 前，必须回答并记录：

```text
1. Playwright MCP 工具由哪个 profile/plugin 注册？
2. dsh agent 调用 MCP 工具时，最终是否经过 ctx.tools.execute？
3. browser_navigate/browser_snapshot/browser_click 的 exec.agent/session 是否可取得？
4. browser context/page 生命周期由谁管理？
5. observation 在哪里产生，格式是什么？
6. 是否存在 browser action 前后的稳定 hook？
7. 工具失败、页面变化、连接断开如何返回？
8. 如何把 action 绑定到 SRC session/engagement？
```

调查方式优先使用：

```text
代码定位 + 运行时最小 trace + 一个低风险 data: 页面
```

不要用一次大范围 `find/rg` 就断言“仓库没有 executor”。宿主包、profile patch、MCP client 和 dsh-src 必须分开查。

### Phase 0 验收

- parser 回归测试通过。
- Laya timeout/fallback 可观测且不阻塞原流程。
- 明确 browser seam 的代码位置和生命周期所有者。
- 未确认 seam 前，不新建 `lib/src/browser/*`。

---

## 5. Phase 1：最小 Browser Action Loop（当前唯一主线）

### 5.1 候选必须由代码生成

不要把完整页面自然语言直接交给 Laya，让它自由产生 `click + target` 两个字段。第一版使用**编号候选**，避免 operation 和 target 组合错误：

```js
[
  {
    index: 0,
    operation: "click",
    targetRef: "e2",
    label: "Continue",
    allowed: true,
    guard: { page: "same-fingerprint" }
  },
  {
    index: 1,
    operation: "type",
    targetRef: "e3",
    valueRef: "approved-input-1",
    label: "Name",
    allowed: true,
    guard: { page: "same-fingerprint" }
  },
  {
    index: 2,
    operation: "wait",
    targetRef: null,
    allowed: true
  }
]
```

候选中的 `valueRef` 必须引用代码侧已经批准的值，不能让 Laya 生成任意敏感值或凭据。

### 5.2 Laya 只选择 index

建议 schema：

```js
{
  index: {
    type: "choice",
    instructions: "只选择一个候选 index；不要输出候选之外的值",
    criteria: ["0", "1", "2"]
  }
}
```

prompt 中明确提供：

```text
goal
observation fingerprint
编号候选
完成判据
禁止选择 done 的条件
```

第一版不让 Laya 同时独立选择：

```text
operation + target + value + done
```

因为当前实测表明自由组合会出现错误的 `done` 和错误 target 选择。

### 5.3 Hard guard 必须在执行前

代码侧必须校验：

```text
index 是否存在
candidate.allowed 是否为 true
operation 是否为白名单
targetRef 是否仍存在
observation fingerprint 是否仍匹配
当前 URL/host 是否仍在 scope
写入/提交/外部副作用是否需要 approval
速率/并发/重试限制是否满足
```

任一失败：

```text
不执行动作
重新 observation 或走 fallback
记录 guard_denied
```

不得让 Laya 通过返回一个新 selector 来绕过 stale guard。

### 5.4 DONE 的特殊规则

第一版可以不提供 `done` 候选。若必须提供：

```text
done 只能由代码在独立验证成功后注入候选
Laya 不能仅凭“看起来完成”选择 done
```

完成验证至少包括：

```text
URL/页面状态符合目标
必要元素或结果存在
scope 未变化
动作副作用已确认
证据已保存或明确记录为未保存
```

### 5.5 第一个测试页面

使用本地、无副作用页面，不使用真实目标：

```html
<button id="continue">Continue</button>
<input aria-label="Name">
<div id="state">idle</div>
```

测试动作只允许：

```text
click
 type
wait
```

禁止第一版接入：

```text
登录
支付
删除
提交外部数据
任意真实 SRC 目标
```

### 5.6 Phase 1 telemetry

不新增状态表，只追加 telemetry 字段：

```text
browser.decision
browser.action
browser.guard
browser.observation
```

至少记录：

```text
sessionId
engagementId
observationFingerprint
candidateCount
chosenIndex
operation
targetRef
confidence
probabilities
latency
source=laya|fallback|rules
fallback
adopted
replacedAgentTurn
executed
success
failureCode
guardCode
```

telemetry 必须 fire-and-forget，失败不能阻塞浏览器动作。

### 5.7 Phase 1 验收

必须同时满足：

1. 真实调用链经过现有 Playwright/MCP executor。
2. 没有新增第二套 browser/context/page 生命周期。
3. 至少一个本地页面完成：

   ```text
   observation → Laya index → guard → click/type/wait → observation
   ```

4. stale target 不会执行。
5. Laya timeout/非法 index 会 fallback，不会阻塞或执行任意动作。
6. `done` 不会绕过独立完成校验。
7. 能统计 adopted、fallback、guard denied、action success/failure。
8. 与 agent 原流程有可比较的 planning turn 和有效动作耗时基线。

在这些条件满足前，不能扩展到 HTTP、delegate、research 或全局 next-action。

---

## 6. Phase 2：才考虑统一 Next-action

只有 Phase 1 证明 Laya 能稳定替代一个真实 browser planning turn 后，才把候选范围从 browser action 扩展到已有工具/Skill。

候选仍由代码生成：

```text
src_read_capability
src_read_lesson
src_run_capability
src_http
browser-action
delegate
record-research
ask-user
```

第一版不做 `parallel` 自动并行；并行会改变审批、速率、证据和状态语义，必须另行验证。

统一 next-action 的最小结果：

```js
{
  actionId,
  targetRef,
  argsRef,
  confidence,
  source,
  fallback,
  latency
}
```

`argsRef` 只能引用代码生成并通过 hard guard 的参数，不允许 Laya 自由构造任意工具参数。

接入统一 next-action 后，才评估删除：

```text
src_http 固定 delegate hook
src_http 固定 skill hook
重复主 prompt 流程文字
重复 tool description 决策规则
```

删除必须以 telemetry 证明为依据，不能提前删。

---

## 7. Phase 3：主动 Skill/tool recall（后置）

当前 `src_http → skillHint` 继续保留，不能宣称为全局主动记忆。

后置版本的触发点应是：

```text
新 goal/intent
新资产或新输入类型
认证边界变化
browser 页面类型变化
上一步失败或需要换方向
```

候选必须来自：

```text
真实注册工具
capability manifest
playbook route
lesson
browser action
```

去重单位：

```text
session + intent + phase + contextFingerprint
```

不要按整个 session 粗暴只提醒一次。

---

## 8. 明确暂不实施

在 Phase 1/2 未验收前，禁止开始：

```text
完整 next-action orchestrator
新的 orchestrator/recovery/job queue
第二套 browser executor
完整 closure/repetition 系统
强制重复请求阻断
approval/todo TTL
大型 payload registry
研究内容自动执行
高风险 Laya on 模式
删除现有 prompt/tool description/fallback
```

这些不是永远不做，而是不能作为当前 browser loop 的前置工作。

---

## 9. 关键指标和比较方式

不能预先把 `250ms` 或 `p50≤100ms/p95≤250ms` 当成已验证目标。先测量，再定预算。

至少比较：

```text
agent planning turns
Laya decision latency p50/p95/p99
fallback rate
adoption rate
replacedAgentTurn
stale/guard denial rate
action failure rate
有效动作完成时间
每个 intent 的有效验证数
verified finding rate
```

成功标准不是“Laya 调用更多”，而是：

```text
在不增加安全违规和错误动作的前提下
减少 agent planning turns
减少无效浏览器动作
减少有效动作完成时间
```

如果 Laya 的选择准确率不足，优先改：

```text
候选生成
observation 结构化
完成判据
hard guard
```

不要继续堆 prompt 文字来掩盖准确率问题。

---

## 10. 交给实施 AI 的第一批任务

按以下顺序执行，完成一项再做下一项：

1. 不改业务逻辑，定位 Playwright MCP 在当前 web profile 的注册、同步、调用和生命周期。
2. 用低风险 `data:` 页面记录一次真实 dsh agent → MCP tool → browser result 的完整链路。
3. 确认是否有可复用 before/after action hook；没有则提出最小 host hook 位置和接口，不要直接新建 browser 子系统。
4. 新增一个只负责 `observation → candidate list → Laya index` 的 Decision adapter。
5. 新增一个只负责 candidate index → 既有 MCP tool 的 Action adapter。
6. 新增 stale/scope/approval/done 的 Hard guard。
7. 用本地 fixture 完成一个 click 或 type 闭环。
8. 加 telemetry 和回归测试。
9. 输出 baseline 与 Laya loop 对比后，等待确认再进入 Phase 2。

### 实施 AI 的停止条件

遇到以下任一情况必须停止扩大范围并报告：

```text
找不到 browser executor 所有者
需要复制 page/context 生命周期
需要新增持久化状态表
需要让 Laya 生成任意 selector/URL/工具参数
需要提前删除 prompt/fallback
需要把 flag 切到 on 才能证明功能
需要同时改 HTTP、delegate、Skill、research 多条链
```

这份计划的最终目标是做减法：让 Laya 接管已经被代码结构化的下一动作，而不是再造一个 Agent 平台。
