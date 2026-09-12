# dsh-src 优化方案实现细节手册

版本：v1.0

日期：2026-09-12

适用范围：`/Users/lihua-dis/Software/dsh-src` 当前 Node.js ESM 实现、SRC 工具协议、会话投影、能力/Skill 路由和本地 lessons。

关联材料：

- [架构、提示词与 Skill 路由审计](architecture-prompt-skill-audit-2026-09-12.md)
- [约束减法论证](plan-2026-09-08-constraint-reduction.md)
- 顺丰考勤系统会话：`session-77038149-c955-408b-b65b-377766d82e21`
- Cairn 对照报告：`/Users/lihua-dis/Downloads/顺丰科技香港中转场签到系统渗透.html`

本文是实现手册，不是再次复盘。目标是把已经确认的问题变成可排期、可测试、可回滚的工程改造。

## 1. 先给结论

当前最需要优化的不是继续增加提示词规则，也不是先重写所有 Skill。优先级应当是：

1. **先建立 telemetry**，定义并记录 Skill、intent、审批、证据和上下文成本漏斗；没有这一步，无法证明“Skill 激活率低”到底是路由、模型遵循、审批摩擦还是能力本身无效。
2. **把异步编排从模型移到服务端 orchestrator/scheduler**。模型负责研究判断和优先级，服务端负责队列、依赖、超时、重试、orphan 恢复和幂等。
3. **把 `src_state` 改成结构化最小决策视图**。事实正文按 ID 拉取，模型默认只看到下一动作、阻塞原因、正在运行的工作和收官阻塞。
4. **收敛规则真相来源**。store/schema 是法律；工具描述负责参数和错误修复；主 prompt 只保留角色、授权和主循环；Skill 只写专题打法；lesson 只存历史经验。
5. **最后再升级 Skill manifest 和语义路由，并缩短 prompt**。先有数据，再调路由和提示词，避免凭感觉把规则在更多文件中复制一遍。

顺丰会话显示了这条顺序的必要性：主会话 42 turns、138 steps、290 次结构化工具调用，发生 6 次压缩；会话家族 9 个会话合计 1000 次工具调用，但 `src_list_capabilities`、`src_read_capability`、`src_run_capability` 均为 0。唯一入库 finding 为 low，旧版 medium+ 门槛阻止了 low-only 报告交付；97 个 fact 全量渲染又放大了上下文压力。Cairn 报告则以 16 条可复现 low finding 完成交付，说明核心差距首先在编排、证据和交付，而非调用了多少 Skill。

## 2. 目标、非目标和验收原则

### 2.1 目标

- 任意一个 intent 都能回答：当前状态、下一动作、阻塞原因、责任者、超时点、证据入口。
- 每次能力候选都能追踪 `offered → selected → read → run → approval → outcome → evidence → finding/research`。
- 子代理失联后由系统自动识别、限次恢复或标记失败，模型不再手工扫描一整张状态图。
- 事实、finding、观察和审批的正文只在必要时注入；默认上下文保持稳定上限。
- 修改一条硬规则时只有一个可执行真相来源，其他层不再复制完整门禁。
- low 级、可复现的未授权访问可以交付；限制、未测项和静态链在报告中清晰标注。

### 2.2 非目标

- 本阶段不重写整个 dsh 宿主、不更换模型供应商、不改变授权审批的安全边界。
- 不把所有人工判断机械化。资产归属、研究假设、危害链和是否停止仍由模型/用户决策。
- 不把关键词路由一次性删除。先兼容现有 `routePlaybook`，以结构化 manifest 做重排，数据稳定后再下线旧召回。
- 不追求 prompt 字符数的极小值。验收看行为指标、上下文成本和产出质量。

### 2.3 四条实现原则

1. **服务端状态优先于提示词状态**：可以验证、去重、超时或拒绝的规则写代码。
2. **命令产生事件，投影只读事件**：禁止 store 和 projection 各自拼接同一业务语义。
3. **证据先保存，报告后渲染**：响应体、请求形态、状态变化和限制条件必须能按 ID 回放。
4. **所有自动动作可解释、可停止、可回滚**：队列任务带原因、幂等键、重试预算和 feature flag。

## 3. 目标架构

```mermaid
flowchart LR
  U[用户/模型决策] --> C[Domain Commands]
  C --> V[Schema + Policy Gate]
  V --> E[(Append-only Domain Events)]
  E --> P[Projection Builder]
  E --> O[Orchestrator]
  O --> Q[(Durable Job Queue)]
  Q --> W[Tool/Capability Worker]
  W --> A[Approval Gate]
  A --> T[HTTP/Burp/Script Transport]
  T --> E
  P --> S[src_state 最小视图]
  P --> R[报告/面板]
  E --> M[Telemetry Sink]
  M --> K[指标与回放评估]
```

### 3.1 当前模块到目标模块的映射

| 当前模块 | 当前职责 | 目标职责 | 首批动作 |
|---|---|---|---|
| `lib/src.js` | prompt、schema、projection、能力加载、工具接线混合 | 组合根和兼容导出 | 先抽 `domain/`、`projection/`、`orchestrator/` 的纯函数 |
| `lib/src/store.js` | durable domain、门禁、生命周期 | 命令处理和领域事件写入 | 保留现有 API，增加事件返回值和幂等键 |
| `lib/src/tools/index.js` | 约 44 个工具、长状态渲染、网络编排 | 薄工具适配层 | 工具只校验参数、调用 command/service、返回结构化结果 |
| `lib/src/playbooks.js` | substring 召回 | 兼容召回器 | 增加 manifest、分数、冲突和理由 |
| `lib/src/lessons.js` | 文件索引、触发提示 | pull 型经验库 | 记录 read/use 事件，禁止承担硬门禁 |
| `lib/src/state.js` | 少量运行时 Map | scheduler lease、退避和进程内缓存 | 不存唯一事实，重启可从 durable job 恢复 |
| `lib/src/mutations.js` | synthetic projection event | 迁移兼容层 | 逐步改为 domain event append |
| `lib/src/reporting.js` | 纯报告投影 | 保持纯函数 | 只从 projection/evidence index 读，不主动查网络 |

建议目录（可以渐进创建，不要求一次搬完）：

```text
lib/src/
  domain/
    schemas.js
    commands.js
    events.js
    policies.js
  projection/
    reducer.js
    views.js
  orchestrator/
    planner.js
    scheduler.js
    transitions.js
    recovery.js
  capabilities/
    manifest.js
    registry.js
    router.js
  telemetry/
    events.js
    sink.js
    budget.js
  transport/
    http.js
    approval.js
```

## 4. 领域对象和数据模型

### 4.1 新增 `orchestration_jobs`

它表示“系统需要执行的一项工作”，与 `srcIntent` 的研究目标分开。一个 intent 可以生成多个 job，一个 job 只能有一个当前执行者。

```js
{
  id: "job-42",
  sessionId: "session-...",
  intentId: "intent-3",
  kind: "capability.run",       // tool.call | capability.run | recovery | finalize-check
  action: "src_http",
  payloadRef: "payload-...",    // 正文在安全存储，状态视图只返回摘要
  status: "queued",             // planned|queued|running|waiting-approval|blocked|completed|failed|orphaned|recovered
  priority: 7,
  dependsOn: ["job-40"],
  idempotencyKey: "intent-3:src_http:sha256:...",
  attempt: 0,
  maxAttempts: 2,
  leaseOwner: "worker-1",
  leaseUntil: 0,
  nextRunAt: 0,
  timeoutMs: 120000,
  lastErrorCode: "",
  createdAt: 0,
  updatedAt: 0,
  completedAt: 0
}
```

硬规则：`idempotencyKey` 唯一；同一 key 的重复命令返回已有 job；`payloadRef` 不把完整响应体塞进普通状态视图。

### 4.2 新增 `route_candidates`

它记录路由当时提供了什么、为什么选中或跳过，避免把“没有调用 Skill”误判成模型问题。

```js
{
  id: "route-9",
  sessionId: "session-...",
  intentId: "intent-3",
  skillId: "authorization",
  score: 0.86,
  rank: 1,
  offered: true,
  selected: false,
  selectedReason: "已有同类 intent 正在运行",
  matchedSignals: ["asset.endpoint", "response.id"],
  rejectedSignals: ["forbiddenWhen: no-object-id"],
  createdAt: 0
}
```

### 4.3 新增 `evidence_links`

不要让 `pocEvidence` 同时承担自由文本、fact ID 和原始响应。新增索引后保持向后兼容：旧 `pocEvidence` 继续渲染，新写入优先使用结构化链接。

```js
{
  id: "evidence-link-7",
  sessionId: "session-...",
  sourceType: "observation",   // fact|observation|response|checkpoint|research
  sourceId: "observation-12",
  targetType: "finding",
  targetId: "finding-2",
  relation: "supports",         // supports|contradicts|context|reproduces
  excerpt: "status=200; body hash=...",
  createdAt: 0
}
```

### 4.4 `telemetry_events`

事件采用追加写入，默认按 session 保留 90 天；大 body 和原始授权说明不直接塞入常驻状态视图。事件失败不能阻塞核心工具。

```js
{
  id: "trace-...:17",
  traceId: "trace-...",
  spanId: "span-...",
  parentSpanId: "span-...",
  sessionId: "session-...",
  engagementId: "session-...",
  intentId: "intent-3",
  jobId: "job-42",
  event: "capability.outcome",
  occurredAt: 0,
  actor: "model|user|orchestrator|worker",
  model: "provider/model-version",
  promptTokens: 0,
  stateTokens: 0,
  payload: {},
  schemaVersion: 1
}
```

## 5. Telemetry 实现

### 5.1 事件清单

| 事件 | 触发点 | 必填 payload | 成功定义 |
|---|---|---|---|
| `route.offered` | intent 创建/重新规划 | skillId、score、rank、signals | 候选已写入 |
| `route.selected` | 模型或 orchestrator 选中 | skillId、reason、override | 有明确选择理由 |
| `skill.read` | `src_read_capability` 或 `src_read_lesson` 成功 | skillId、source、bytes | 正文读取成功 |
| `capability.requested` | `src_run_capability` 入队 | capabilityId、jobId、approvalRequired | job 已创建 |
| `approval.waiting` | 高危请求挂起 | approvalId、category、risk | pending 已持久化 |
| `approval.resolved` | 用户批准/拒绝 | approvalId、decision、latencyMs | 状态从 pending 迁移 |
| `capability.outcome` | 能力/工具结束 | jobId、status、errorCode、durationMs | 有终态或明确 blocked |
| `evidence.created` | fact/observation/research 写入 | evidenceType、evidenceId、source | 记录可回读 |
| `evidence.linked` | 证据关联 finding/intent | sourceId、targetId、relation | 关系可回放 |
| `intent.completed` | checkpoint completed 或自动收尾 | intentId、evidenceCount | 状态迁移成功 |
| `intent.recovered` | orphan 恢复成功 | intentId、attempt、childSessionId | 新 checkpoint 或终态 |

### 5.2 发射器接口

新增 `lib/src/telemetry/events.js`：

```js
export function createTelemetry({ sink, clock = Date }) {
  return {
    emit(event, context = {}, payload = {}) {
      const row = normalizeAndBudget({
        id: `${context.traceId ?? crypto.randomUUID()}:${clock.now()}`,
        event,
        occurredAt: clock.now(),
        ...context,
        payload
      });
      // telemetry 不能阻塞工具；sink 失败只进入内部计数器和 stderr。
      Promise.resolve(sink.append(row)).catch(() => undefined);
      return row.id;
    }
  };
}
```

工具执行上下文统一生成 `traceId`，子会话继承 `engagementId` 并生成新的 `spanId`。`src_http`、审批重放、能力脚本和子代理 checkpoint 都必须带上同一组关联字段。

### 5.3 数据体积规则

- telemetry 记录请求的 host/path、方法、状态、耗时、响应长度和 evidence id。
- 大 body 继续沿用现有 2KB 截断、hash 去重和按 ID 拉取，避免常驻状态无限膨胀。
- 原始正文保存在 evidence 存储中，默认状态只显示摘要和索引。

### 5.4 指标口径和聚合示例

Skill 漏斗必须按 `intentId` 作为基本分母，不能用工具调用总数代替：

```text
offer_rate       = intents_with(route.offered) / eligible_intents
selection_rate   = intents_with(route.selected) / intents_with(route.offered)
read_rate        = intents_with(skill.read) / intents_with(route.selected)
run_rate         = intents_with(capability.requested) / intents_with(skill.read)
approval_rate    = approvals_resolved / approvals_waiting
outcome_rate     = outcomes_terminal / requested_jobs
evidence_rate    = intents_with(evidence.created) / requested_jobs
finding_rate     = intents_with(finding_linked) / intents_with(evidence.created)
```

建议先用 JSONL sink 验证字段，再接项目现有 storage domain。聚合可以先用 Node 脚本完成，SQL 仅作为查询口径示意：

```sql
SELECT skill_id,
       COUNT(DISTINCT CASE WHEN event = 'route.offered' THEN intent_id END) AS offered,
       COUNT(DISTINCT CASE WHEN event = 'skill.read' THEN intent_id END) AS read_count,
       COUNT(DISTINCT CASE WHEN event = 'capability.outcome'
                            AND payload_status IN ('completed','blocked','failed')
                           THEN intent_id END) AS terminal,
       COUNT(DISTINCT CASE WHEN event = 'evidence.linked'
                           THEN target_id END) AS findings
FROM telemetry_events
GROUP BY skill_id;
```

每周人工抽样 20 个 intent 标注“应该使用的 Skill”，计算 route precision/recall。只有当漏斗和标注集稳定后，才调整阈值。

## 6. Orchestrator 和 Scheduler

### 6.1 状态机

```text
planned
  └─ enqueue ─> queued
queued ── lease ─> running
running ── high-risk ─> waiting-approval
waiting-approval ── allow ─> queued
waiting-approval ── reject/expire ─> blocked
running ── retryable error ─> queued
running ── timeout/lease lost ─> orphaned
running ── success ─> completed
running ── non-retryable error ─> failed
orphaned ── recover ─> recovered ── resume ─> queued
orphaned ── budget exhausted ─> failed
```

状态迁移由 `transitions.js` 的纯函数校验，禁止工具直接写任意 status：

```js
const ALLOWED = {
  planned: ['queued', 'blocked'],
  queued: ['running', 'blocked'],
  running: ['waiting-approval', 'queued', 'completed', 'failed', 'orphaned'],
  'waiting-approval': ['queued', 'blocked'],
  orphaned: ['recovered', 'failed'],
  recovered: ['queued'],
  completed: [], blocked: [], failed: []
};
```

### 6.2 Scheduler 循环

每 1 秒或由事件唤醒一次，执行顺序固定：

1. 读取 `queued` 且 `nextRunAt <= now` 的 job。
2. 检查依赖是否全部 `completed`；未满足则保留 queued 并写 `blockedReasons`。
3. 用 compare-and-swap 写入 `leaseOwner`、`leaseUntil`，防止多 worker 重复执行。
4. 调用 worker；所有工具结果转换成 domain event，再由 reducer 更新状态。
5. 对网络超时、供应商暂时不可用、429/5xx 使用指数退避；对参数错误、越权和审批拒绝不自动重试。
6. lease 超时的 running job 转 `orphaned`，交给 recovery policy。

伪代码：

```js
async function tick(now) {
  for (const job of await queue.claimable(now, 20)) {
    if (!await queue.claimLease(job.id, workerId, now + job.timeoutMs)) continue;
    try {
      const result = await worker.run(job, { signal: timeout(job.timeoutMs) });
      await commands.recordOutcome(job, result);
    } catch (error) {
      await commands.recordFailure(job, classify(error));
    }
  }
}
```

### 6.3 重试和超时预算

| 类别 | 默认次数 | 退避 | 说明 |
|---|---:|---|---|
| provider unavailable、网络连接失败 | 2 | 2s、8s | 不重复发送已批准的破坏性请求，需新 approval |
| 429、临时 5xx | 2 | `Retry-After` 或 5s、20s | 记录 rate-limit 证据 |
| 415、400 参数错误 | 0 | 无 | 返回请求形态诊断，交给模型修正 |
| approval pending | 0 | 等待事件 | 不轮询、不重发 |
| child orphan recovery | 每 intent 2 次 | 立即、5 分钟 | 仍失败就写 fact、标 failed、生成新 job |

### 6.4 Orphan 恢复

恢复条件沿用当前 `src_state` 的 checkpoint 规则，但由 scheduler 自动执行：

- running 且无 checkpoint：标记 `orphaned`，若仍有 childSessionId，入队 `recovery`。
- 最新 checkpoint 为 `progress` 且超过 30 分钟：同上。
- 恢复成功：写 `intent.recovered` 和新的 `checkpoint`；恢复失败：写 `blocked`/`failed`，保留已有事实，不删除图。
- 恢复任务必须带 `recoveryOfJobId`，防止恢复任务再次被当作普通研究任务重复派生。

## 7. `src_state` 结构化最小视图

当前 `src_state` 同时承担面板、证据浏览器、恢复器、覆盖检查和报告提示，导致 97 facts 等长文本重复注入。目标输出如下：

```json
{
  "version": 2,
  "goal": {"target": "example.test", "objective": "authorized assessment"},
  "counts": {"intents": 11, "facts": 97, "findings": 1, "assets": 11},
  "nextActions": [
    {"id": "job-42", "kind": "review-response", "priority": 8, "reason": "415 requires Content-Type check", "sourceId": "observation-19"}
  ],
  "blockedReasons": [
    {"code": "approval.pending", "id": "approval-7", "action": "ask-user"}
  ],
  "runningWork": [
    {"intentId": "intent-3", "jobId": "job-40", "status": "running", "leaseUntil": 0}
  ],
  "evidenceIndex": {
    "recent": ["observation-19", "fact-91"],
    "byIntent": {"intent-3": {"count": 12, "lastId": "fact-91"}},
    "omitted": 73
  },
  "skillHints": [
    {"skillId": "authorization", "score": 0.86, "reason": "object id + authenticated endpoint"}
  ],
  "finalizeBlockers": [],
  "warnings": ["remainingDirections=1"]
}
```

实现方式：

1. `src_state` 默认返回 v2；增加 `detail` 参数：`summary`、`evidence`、`orchestration`、`legacy`。
2. `summary` 只返回上例字段，事实正文不超过最近 12 条；finding 相关证据永不被预算裁剪。
3. 新增 `src_get_evidence({ ids, full })`，按 ID 拉取正文，复用现有 `http-output.js` 截断和去重。
4. 保留 v1 兼容窗口 30 天；旧模型检测到 `version=1` 时仍可拿到旧字段，但不再作为默认 prompt 输入。
5. `src_report` 和面板使用 projection 的分页接口，报告生成前才拉取 finding 所需完整证据。

验收：同一顺丰规模的 97 facts 会话，默认 `src_state` 文本 token 降低 60% 以上；finding、intent、pending approval 和 orphan 信息不可丢失。

## 8. Skill manifest 与语义路由

### 8.1 Manifest 格式

在 `preset/src-hunter/skills/*.manifest.json` 或能力索引中增加：

```json
{
  "id": "authorization",
  "version": "1.0.0",
  "assetTypes": ["endpoint", "web", "api"],
  "triggers": {
    "terms": ["越权", "IDOR", "对象权限"],
    "signals": ["response.objectId", "multiAccount", "authRequired"]
  },
  "prerequisites": ["asset.confirmed", "baseline.available"],
  "forbiddenWhen": ["no-object-id", "out-of-scope"],
  "requiredTools": ["src_http", "src_record_research", "src_add_finding"],
  "outputSchema": ["baseline", "crossAccountDiff", "evidenceIds"],
  "expectedEvidence": ["beforeResponse", "afterResponse", "identityContext"],
  "cost": {"tokens": 900, "requests": 8},
  "risk": "medium",
  "docs": ["skills/skill/知识库/idor-test.md"]
}
```

通用 finding 门禁不得复制进 manifest；manifest 只描述这个专题需要什么证据。

### 8.2 路由评分

保留 `routePlaybook` 作为高召回召回器，新增重排：

```text
score = 0.30 * semanticSignal
      + 0.20 * assetTypeMatch
      + 0.20 * prerequisiteMatch
      + 0.15 * evidenceGapMatch
      + 0.10 * historicalOutcome
      - 0.15 * forbiddenSignal
      - 0.10 * duplicateRunningIntent
```

- `semanticSignal` 第一版可用 terms + 中文同义词；后续再接 embedding，避免一开始引入新运行时依赖。
- `historicalOutcome` 只使用 evidence/finding 关联数据，不能按调用次数奖励噪声。
- 取 top-3，低于 0.45 只返回 `recon` 兜底并标记低置信度。
- 多 route 冲突时，按分数、前置条件满足数、风险低者排序；理由写入 `route_candidates`。
- 用户或模型可以 `override`，但必须记录 `actor`、理由和过期范围。

### 8.3 Skill 激活的产品定义

“激活”不能定义成“关键词命中”。建议分三档：

- **发现激活**：候选被提供并有 route 事件。
- **执行激活**：文档被读取且至少一个 required tool/job 被调用。
- **有效激活**：执行产生 expected evidence，并被关联到 finding、research 或明确 blocked 结论。

报告中同时显示三种率，避免用一个百分比掩盖审批失败或证据不足。

## 9. Prompt、工具描述和规则分层

### 9.1 规则优先级

```text
store/schema/approval gate  >  工具参数和错误描述  >  主 prompt 决策原则
                             >  Skill 专题打法      >  lesson 历史经验
```

发生冲突时，工具返回的可执行错误和服务端 gate 优先；模型只需根据错误修复或换方向。

### 9.2 主 prompt 三段式

把 `SRC_INSTRUCTIONS` 收敛为三块，目标约 3.5k–5k 字符：

```text
角色与边界
- 只在授权资产上工作；授权由 goal、资产清单和审批层执行。
- 你负责研究判断、优先级、证据解释和最终交付。

主循环
1. 读 src_state(summary)，选择一个 nextAction 或建立 intent。
2. 需要专题时读取候选 Skill；按 requiredTools 形成最小任务。
3. 委派后等待事件；根据 evidence 更新事实、research 或 finding。
4. 没有可执行动作时运行 finalize，并如实记录限制。

恢复与交付
- 遇到 blocked/approval/orphan，按结构化 reason 处理，不轮询、不重复发送。
- low 级可复现结果也可交付；证据不足就保留为 fact/research。
- 报告必须区分动态实证、静态链、blocked 和未授权验证边界。
```

移出主 prompt 的内容：完整字段表、审批分类、Burp 用法、验证码/短信预算、每个漏洞专题检查项、报告模板字段和所有可由 schema 拒绝的格式规则。

### 9.3 工具 description 写法

每个 description 只回答四件事：输入是什么、何时可调用、失败表示什么、下一步应该看哪个字段。不要在 description 重复整个主 prompt。

例如 `src_http` 保留：“高风险请求返回 pending，必须等待用户决定；批准后响应包含 status、headers 摘要、body 摘要和 hash；415/400 不自动重试，先修正请求形态。” 其余安全政策由 `classifyHttpRequest` 和 approval gate 执行。

## 10. Store、事件和 Projection 收敛

### 10.1 迁移策略

不直接重写 `lib/src.js` 的 projection。分四步：

1. **兼容层**：为现有 `store.addFact/addFinding/updateIntent` 返回 `{ value, events }`，同时继续提供旧返回形状。
2. **事件落盘**：新增 `src_events` 表，事件包含 `eventId`、`aggregateId`、`aggregateVersion`、`payload`、`createdAt`；所有领域写入先 append，再由现有 domain table 更新快照。
3. **双折叠校验**：测试环境和灰度环境同时用旧 projection、新 reducer 生成 snapshot，比较 intent/fact/finding/checkpoint/approval 的关键字段并发 `projection.divergence`。
4. **切换读取**：默认读取新 reducer；保留旧 projection replay 30 天用于回滚。确认 divergence 为零后，删除 synthetic event 的新增入口，旧入口只读历史。

### 10.2 事件幂等

- 事件键：`aggregateId:aggregateVersion:eventType`。
- 重放遇到已有 eventId 必须返回 duplicate，不再次追加边。
- projection reducer 必须纯函数；同一事件序列重复 fold 得到相同 hash。
- 每个 checkpoint、approval resolution 和 finding update 都必须可重放。

### 10.3 关键一致性断言

- store 中存在的 active finding 必须在 projection 中存在。
- `pending_approvals.status=pending` 必须出现在 `blockedReasons`。
- completed intent 必须有 completed checkpoint，除非标记为系统迁移产生。
- evidence link 的 source/target 必须属于同一 engagement 或有明确跨会话边界。
- projection 不得生成 store 不存在的 id。

## 11. 分阶段实施计划

### Phase 0：基线、开关和回滚（1–2 天）

任务：

- 建 `optimization/handbook` 对应 issue 清单和变更记录。
- 增加环境变量：`DSH_SRC_TELEMETRY=off|shadow|on`、`DSH_SRC_STATE_VERSION=1|2`、`DSH_SRC_ORCHESTRATOR=off|shadow|on`、`DSH_SRC_ROUTE_V2=off|shadow|on`。
- 为当前 domain、session projection 和 lesson 目录做只读备份；保存 `npm test` 基线。

验收：关闭全部 flag 时 `node scripts/check-preset-consistency.mjs` 和 `npm test` 与当前一致。

### Phase 1：Telemetry（3–5 天）

实现：

- 新增 `lib/src/telemetry/{events,sink,budget}.js`。
- 在 `src_add_intent`、`src_read_capability`、`src_run_capability`、`src_http`、approval、`src_submit`、`src_record_research` 和 finalize 处发事件。
- 先写 JSONL，不改变工具返回；增加 trace/span/engagement 关联。
- 写 `scripts/aggregate-src-telemetry.mjs`，输出 funnel、token、重复调用和 orphan 报表。

验收：回放顺丰会话日志时能得到完整漏斗；telemetry sink 故障不影响工具；事件和状态视图均遵守体积预算。

### Phase 2：结构化 State View（4–7 天）

实现：

- 在 `lib/src/tools/index.js` 抽出 `buildSrcDecisionView`。
- 增加 v2 schema、`src_get_evidence`、分页和 `detail` 参数。
- 保留 legacy render，但默认只返回 summary。
- 增加 facts omitted、finding evidence 永不裁剪和关键 blocker 快照测试。

验收：97 facts 回放的状态 token 降低 60% 以上；报告和面板能按 ID 取回完整证据。

### Phase 3：Orchestrator/Scheduler（1–2 周）

实现：

- 新增 `orchestrator/transitions.js`、`queue.js`、`scheduler.js`、`recovery.js`。
- 为 intent 创建、checkpoint、approval、child failure、finalize 创建 job。
- shadow 模式只计算迁移和下一动作，不执行；比较模型实际行为和 scheduler 建议。
- on 模式先接 recovery、timeout 和 finalize check，再接普通 capability job。

验收：杀掉子代理进程后 30 分钟内自动生成 orphan/recovery 事件；重复 job 不重复发请求；批准前不会执行高危操作。

### Phase 4：规则真相收敛（1 周）

实现：

- 建规则目录清单，给每条规则标 `enforcedBy`、`explainedBy`、`historicalSource`。
- 删除主 prompt 和 Skill 中重复的 schema 门禁；把工具 description 改为参数/错误修复指引。
- 保留授权、禁止绕行、证据诚实和报告边界四类不可编码行为原则。

验收：对 finding、approval、finalize、scope 四类冲突场景做 contract test；修改 store 门禁后无需同步多份同义文本。

### Phase 5：Skill Manifest 和 Router v2（1–2 周）

实现：

- 为现有 17 个 `PLAYBOOK_ROUTE_KEYS` 生成 manifest；旧 terms 作为召回字段。
- 增加候选分数、前置条件、禁止条件、requiredTools、expectedEvidence。
- 写 route shadow evaluator，对人工标注集计算 precision/recall。
- 增加人工 override 和 `route_candidates` 落盘。

验收：top-3 recall 达到 90%；误触发率比纯 substring 降低 30%；每个 selected route 都能追踪到 read/run/outcome 或明确 blocked。

### Phase 6：Prompt/Runtime 拆分（1–2 周）

实现：

- 把 `SRC_INSTRUCTIONS` 改成三段式；将专题打法移到 manifest/lesson。
- 从 `lib/src.js` 抽 projection、capability loader、orchestrator；工具注册只做适配。
- 每次拆分后运行 replay、schema、审批和靶场 E2E。

验收：主 prompt 和常驻工具 description 的 token 占比下降 40%；多轮任务的重复 tool call 率下降 30%；finding 交付率不下降。

## 12. 测试和评估体系

### 12.1 单元与契约测试

- `transitions.test.mjs`：每个状态迁移和非法迁移。
- `telemetry-budget.test.mjs`：大 body、重复响应和长授权说明不会突破事件及状态视图预算。
- `router.test.mjs`：同义词、冲突 route、禁止条件、低分 fallback。
- `decision-view.test.mjs`：预算、分页、finding evidence 保留、v1/v2 兼容。
- `event-replay.test.mjs`：事件序列重复 fold 结果 hash 相同。

### 12.2 Property-based / Replay 测试

生成随机的 goal、intent、fact、checkpoint、approval 和 finding 事件序列，验证：

- reducer 不抛异常且不会生成孤儿 ID；
- duplicate event 不改变最终状态；
- store snapshot 与 projection 关键字段一致；
- 任意中断后恢复不会重复执行不可重试动作。

将顺丰主会话和会话家族日志制作离线 replay fixture，只复现状态迁移和工具调用，不重新访问目标；fixture 仅保留测试所需的结构化字段和体积边界。

### 12.3 Mock 靶场 E2E

保留现有 168 项回归，增加四类场景：

1. low-only 多 finding 可以 finalize 和出报告；
2. JSON body 缺 Content-Type 时自动补全，415 会返回 body 诊断；
3. 写入→回读→删除的三步证据链能关联到一个 finding；
4. provider unavailable、child orphan、approval pending 在 scheduler 中可恢复。

### 12.4 Agent A/B 评估

固定同一目标、授权、模型版本和预算，比较：

- prompt 旧版 vs 三段式；
- substring route vs Router v2；
- legacy state vs decision view v2；
- orchestrator off vs on。

每组至少 20 个 intent，记录 route precision/recall、skill 有效激活率、工具重复率、上下文 token、orphan/recovery、finding 数量和人工可交付率。不要只以 finding 数量为 KPI，必须同时看误报、越权和清理完整性。

## 13. 灰度、迁移和回滚

### 13.1 灰度顺序

1. telemetry shadow（100% 会话，只写结构化事件）；
2. state v2 对内部测试会话 10%；
3. orchestrator shadow 100%，执行仍由旧路径；
4. orchestrator on 仅用于低风险 recovery/finalize check；
5. Router v2 shadow，比较候选不改变选择；
6. Router v2 on 10%→50%→100%；
7. prompt 三段式最后灰度，保留旧 prompt 版本号。

### 13.2 回滚条件

任一条件触发立即关闭对应 flag：

- projection divergence > 0.5%；
- 高危请求出现未审批执行；
- 重复不可重试请求 > 0；
- orphan recovery 产生重复 finding 或重复外发；
- state v2 隐藏 pending approval、active finding 或授权边界；
- 有效激活率下降超过 20% 且 route recall 未提升。

回滚只切 flag，保留事件和 job 记录。不要删除新事件或清空 durable store，以便定位和重放。

## 14. 风险清单和应对

| 风险 | 影响 | 预防/处理 |
|---|---|---|
| telemetry 自身膨胀上下文 | token 增加 | telemetry 永不注入 prompt，单独 sink；状态只读聚合计数 |
| scheduler 与旧模型同时执行 | 重复请求 | shadow 阶段只建议；on 阶段以 idempotencyKey 和 lease 锁定 |
| 自动恢复误判 orphan | 重复委派 | recovery 只恢复 checkpoint 缺失/超时任务，超过预算标失败并要求模型决策 |
| route manifest 过严漏召回 | 漏测 | terms 保留高召回，manifest 只做重排；低分 fallback recon |
| 事件和快照不一致 | 面板/报告分叉 | append + snapshot 同一 command；定期 divergence replay |
| 响应体摘要过短 | 证据不可用 | `full=true` 受控拉取；记录 hash、长度和 content-type |
| prompt 变短后行为退化 | 研究漏项 | A/B、人工标注集、固定靶场和快速回滚 |

## 15. 30/60/90 天排期

### 0–30 天：看得见、稳得住

- 完成 telemetry、体积预算、trace/span 和聚合脚本。
- 完成 state v2 summary、evidence index、`src_get_evidence`。
- 建立顺丰日志 replay fixture 和四类新增 E2E。

交付标准：能回答每个 intent 为什么选/没选某 Skill；97 facts 会话不再因状态渲染触发 oversized；现有 168/168 回归保持通过。

### 31–60 天：编排自动化

- 完成 job schema、状态迁移、lease、退避、approval 事件。
- scheduler shadow 两周，比较建议动作和模型实际动作。
- 上线 orphan/recovery/finalize check 的低风险自动化。
- 开始事件来源单一化迁移和 projection divergence 监控。

交付标准：子代理失联可自动恢复或明确失败；高危动作没有绕过审批；重复 job 不重复执行。

### 61–90 天：路由和 prompt 收敛

- 完成 17 个 Skill manifest、Router v2 和人工 override。
- 完成 prompt 三段式和工具 description 清理。
- 完成 A/B 评估、route 标注集和最终灰度。
- 删除不再使用的 synthetic event 新写入口，保留历史 replay。

交付标准：有效 Skill 激活率、finding 交付率、重复调用率和上下文成本都有可比较的基线；没有用“调用次数增加”冒充质量提升。

## 16. 首批可直接建 issue 的任务

1. `telemetry: add trace/span context and budgeted JSONL sink`：新增事件接口和 JSONL sink。
2. `telemetry: instrument capability and approval funnel`：覆盖 offered/read/requested/waiting/resolved/outcome。
3. `state: introduce decision view v2`：summary、nextActions、blockedReasons、evidenceIndex。
4. `evidence: add src_get_evidence with bounded full response`：按 ID 取证，复用 `http-output.js`。
5. `orchestrator: define job schema and transition table`：纯函数迁移和幂等键。
6. `orchestrator: implement lease scheduler in shadow mode`：不执行，只产建议事件。
7. `recovery: auto-detect orphan and bounded child recovery`：对接现有 `src_recover_child`。
8. `rules: generate rule ownership inventory`：标出 store/prompt/tool/skill/lesson 的重复语义。
9. `router: add manifest parser and route_candidates table`：兼容旧 `routePlaybook`。
10. `router: build labeled evaluation fixture`：中文同义词、冲突和负例。
11. `prompt: split SRC_INSTRUCTIONS into three sections`：保留版本号和旧 prompt 回滚。
12. `projection: dual-fold replay and divergence metric`：新旧 reducer 同步校验。
13. `config: separate capability loading from orchestration`：配置解析与调度边界解耦。
14. `tests: add scheduler/orphan/approval/replay property cases`：覆盖中断、重复和超时。

## 17. 最终验收清单

- [ ] `npm test`、preset consistency 和新增 replay/property/E2E 全通过。
- [ ] telemetry 事件大小受预算控制，完整响应体通过 evidence id 按需读取，不被默认状态视图无限展开。
- [ ] 每个 selected route 都能看到 read/run/outcome，或者明确 blocked/rejected 原因。
- [ ] low-only finding 可以带限制完成报告，不再被 medium+ 门槛阻断。
- [ ] `src_state` 默认不渲染全量 facts；finding 证据可按 ID 拉回。
- [ ] orphan、approval、provider unavailable 和 415 请求形态均有结构化处理路径。
- [ ] store snapshot 与 projection replay 关键字段一致，divergence 为零。
- [ ] 主 prompt、工具描述、Skill 和 lesson 的规则归属有清单且无重复硬门禁。
- [ ] Router v2 有人工标注集、precision/recall 和回滚开关。
- [ ] 顺丰授权环境的任何新结论都来自重新验证；本地靶场和历史会话只作为设计/回放证据。

## 18. 边界说明

本手册不会把历史顺丰会话自动改写成新证据。现有修复已经解决 low finding 准入、low-only 交付、响应体透传、JSON `Content-Type`、事实预算、负结果自查和同域多后端提示，但旧会话的响应体无法 retroactively 恢复。顺丰授权窗口恢复后，仍需重新验证相关请求形态、响应体、写入回读和清理结果，再更新正式报告。

这也是本方案的验收边界：先让系统能够看见、保存和解释每一步，再让 orchestrator 自动推进；任何涉及真实目标的复测、写入或清理都必须继续遵守现有授权与审批链。
