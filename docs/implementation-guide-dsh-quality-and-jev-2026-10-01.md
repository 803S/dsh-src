# dsh 质量与 Jev 改进落地手册

日期：2026-10-01

本文把最近一次 dsh 测试会话的审计结果整理成可执行改进任务。目标读者是能够按文件、函数、测试和验收条件逐项执行的低智能模型。本文只描述 dsh/SRC 插件项目的改进；`new-api` 的 400 排查放在文末单独说明。

## 0. 执行规则

### 0.1 只使用可信源码基线

**2026-10-02/03 更新**：仓库已收拢到唯一工作树 `/Users/lihua-dis/Software/dsh-src`、唯一分支 `main`。旧 `dsh-src-jev` 和临时评测工作树已移除，不再使用。部署副本仍位于 `$DSH_HOME/profiles/{web,headless}/node_modules/@lihua_dis/dsh-src`。

local.108 修复与真实测试结果见 [implementation-2026-10-02-session-quality-repair.md](implementation-2026-10-02-session-quality-repair.md)，会话证据见 [audit-2026-10-02-session-fd2c50eb.md](audit-2026-10-02-session-fd2c50eb.md)。下文 Phase 1 涉及宿主/provider 的建议仅为独立后续工作，不属于本轮 SRC 修改范围；本轮不改压缩、上游协议或通用 retry。实现状态以该执行记录与测试证据为准，本文任务列表不是完成声明。

### 0.2 只读审计与修改任务分开

改进模型必须遵守以下边界：

1. 先读取本手册、相关源码和测试，再修改。
2. 不删除或重写历史 session、SQLite、telemetry、approval 和 artifact。
3. 不用 `git reset --hard`、`git checkout --` 覆盖现有变更。
4. 不把测试目标重放、自动批准历史审批或重新发送真实请求当成验证手段。
5. 每个阶段完成后先运行对应的单元测试，再进入下一阶段。
6. 不把日志里保存的密钥、cookie、authorization 或完整目标请求写进文档、测试 fixture 或提交。

### 0.3 统一验收命令

在可信基线目录执行：

```bash
npm test
node --check lib/src.js
node --check lib/src/tools/index.js
node --check lib/src/decision/jev-client.js
```

如果 `package.json` 仍无法解析，先停止功能改动，完成 Phase 0。不要用删掉冲突标记的方式猜测 `ours/theirs`；必须根据分支历史和部署版本逐段合并。

## 1. 问题模型

最近 session `session-9e7a3f76-dd40-4364-8d22-0619f53e6df5` 的主要事实：

- 10 个 turn、75 个 step、6 次 compaction。
- 718 次工具调用，其中 `src_add_fact` 447 次、`src_record_coverage` 63 次、`src_http` 43 次。
- 447 条 fact 全部是 `info`，其中约 438 条只是 OpenAPI 路由枚举。
- 8 个 turn 因同一个 reasoning 协议错误结束。
- 6 次用户发送“继续”，说明故障恢复没有形成闭环。
- 数据库已有完整 session 数据，但 projection cache 仍显示 `turns=1`、`steps=1`、`goal=null`。
- checkpoint 声称生成多个 artifact，实际 artifact 目录只有 README。
- coverage 曾从 `528 total / 44 tested` 变成 `36 total / 36 tested`，并且 limitation 仍承认大量 endpoint 未逐条测试。
- rejected duplicate finding 仍被 finalize 要求验证。

这些问题不是一个 prompt 文案问题，而是五类契约同时失效：

1. **源码契约**：工作区、部署副本、运行版本不一致。
2. **模型协议契约**：reasoning replay 的 provider 能力没有显式声明。
3. **数据真实性契约**：coverage、finding、research、artifact 可以被不完整或错误地写入。
4. **事件与投影契约**：事件流、SQLite、projection cache 不是同一权威状态。
5. **职责边界契约**：prompt、Jev、工具、orchestrator 都在承担部分规划、审批和恢复职责。

## 2. 总体实施顺序（含真实依赖）

⚠️ 以下顺序不能打乱。括号内为原因。

1. **Phase 2 → Phase 3**：goal/intent 锚点和 evidence 写入路径必须在 Phase 5 Jev 接入前修好。`intentId` 不存在时，`src_http` 应在审批前明确报错并且不发请求、不生成审批；这类接线错误不能被误报成 Jev 风险问题。
2. **Phase 2/3 → Phase 5**：Jev 的 verdict 效果取决于 Phase 2/3 的数据质量。先修 Phase 5 再修 Phase 2/3，会把 Jev 问题掩盖在"职责划分"里，而不是修真正根因。
3. **Phase 2/3/5 → Phase 6**：orchestrator 需要依赖 Phase 2/3 的 tool handler routing 正确，以及 Phase 5 的 Jev 边界清晰。Phase 6 不能在 Phase 2/3/5 未完成时直接开工。
4. **Phase 0 → Phase 1**：Phase 1 需要可构建的源码基线，Phase 0 先完成。
5. **Phase 1/2/3/5 → Phase 4**：projection stale 检测需要 Phase 2 的 eventSeq 和 Phase 3 的数据契约稳定后再接入。
6. **Appendix A（new-api reasoning 400）**：独立于 Phase 顺序，可立即执行。

### Phase 顺序依赖图

```
Phase 0 ──► Phase 1 ──► Phase 4
                │              ▲
                ▼              │
Phase 2 ───────────────────────┤
  │                             │
  ▼                             │
Phase 3 ───────────────────────┤
  │                             │
  ▼                             │
Phase 5 ───────────────────────┘
  │
  ▼
Phase 6
  │
  ▼
Phase 7

Appendix A（独立，随时可做）
```

每个 Phase 都必须满足"修改范围、测试、验收、回滚点"四项后才能进入下一阶段。

## 2b. Phase 2+3 交叉项：Tool Handler 入口校验

> 本节是 Phase 2 §5.3 和 Phase 3 §6.1/6.3 之间的接线逻辑，在实施 Phase 2/3 时必须同步完成，否则后续 Phase 5 的 Jev verdict 会被上游接线问题污染。

### 2b.1 intentId 存在性校验

**根因**：真实会话中主模型多次传 `goal-1` 当作 `intentId`，导致 `src_http` 在审批前返回 `unknown intent`；这类调用不应生成 pending。真正的 23 条 pending 是另一条路径：请求进入审批后，Jev 返回 `risk=low + verdict=pending`，而旧 reason 模板没有反映实际请求。

**修复位置**：`lib/src/tools/` 各工具 handler 入口。

**要求**：
- 所有接收 `intentId` 参数的工具，在写入前校验 intent 存在；
- 不存在时返回明确错误：`intent '${intentId}' 不存在。当前有效的 intent：${list}`；
- 禁止用 `goal-1` 等非 intentId 字符串绕过校验；
- 列出当前有效的 intentId 和对应 goalId，帮助主模型自我纠正。

**示例错误响应**：
```json
{
  "error": "invalid_intent",
  "message": "intent 'goal-1' does not exist. Current valid intents: ['intent-1', 'intent-2']"
}
```

**测试**：
- 传不存在的 intentId → 返回明确错误，不写入数据；
- 传 `goal-1` 等格式 → 返回明确错误，列出有效 intent；
- 传正确 intentId → 正常写入。

### 2b.2 子代理 evidence 回写 parent engagement

**根因**：`src_test_credential` 在子代理 session 中调用，写入子会话自己的 engagement scope，但父会话才持有 goal，导致 `src engagement is not initialized` 错误，fact/research/coverage 写入孤立会话。

**修复位置**：`lib/src/tools/src-test-credential.js` 或对应 handler。

**要求**：
- 子代理调用 `src_test_credential` 时，必须写入 parent session 的 engagement（由 parent sessionId 路由）；
- fact/research/coverage 的 `engagementId` 字段必须指向 parent engagement；
- 如果 parent engagement 不存在，返回明确错误：`子代理凭证测试需要父会话存在有效 goal`，而不是静默写入子会话；
- 在 `lib/src/child-outcome.js` 中已有 session/event 监听子代理 turn/end 错误，接入此校验。

**测试**：
- 子代理调用 `src_test_credential` → 验证 fact/research/coverage 写入父会话 engagement；
- 父会话无 goal 时调用 → 返回明确错误，不写入子会话；
- 父子会话均有 goal 时 → 正常写入父 engagement，parent投影可见。

### 2b.3 Approval reason 组合逻辑

**根因**：当前 Jev 返回 `risk=low + verdict=pending` 时，approval reason 统一渲染为"高风险/不确定/矛盾转人工"，完全没有描述实际请求的 method/path/body/effect。

**修复位置**：`lib/src/approval-grants.js` 或对应渲染逻辑。

**Approval reason 必须包含**：
1. Jev 返回的 `risk` 和 `verdict`（例如 `risk=low, verdict=pending`）；
2. 代码规则分类的 effect（例如 `effect=read`、`effect=compute`、`effect=auth-test`）；
3. 实际请求的 method + path（可选 body 摘要）；
4. `verdict=pending` 的具体原因（例如 `executionPolicy 前提下 Jev 判定 pending`、`Jev 服务超时`、`Jev schema 错误`）；
5. 如果是高风险：明确写出 reason 而不是统一模板。

**禁止**：
- 用统一模板抹平所有 pending reason；
- 把 Jev 返回的 `reason` 字段直接当作 approval reason；
- 在 reason 中混入未脱敏的 authorization header、cookie 或 API key。

**示例**：
```
Jev: risk=low, verdict=pending (executionPolicy 前提下判定 pending)
规则: effect=read, OPTIONS
请求: OPTIONS /api/user
原因: Jev 返回 pending，需人工审批
```

vs.

```
Jev: risk=high, verdict=reject
规则: effect=delete + scope boundary
请求: DELETE /api/user/1
原因: 删除操作超出低风险范围，人工审批
```

**测试**：
- 低风险 pending → reason 包含 method/path/effect 和 pending 具体原因；
- 高风险 → reason 包含 method/path 和具体高风险描述；
- Jev 服务错误 → reason 包含具体错误类型和 fallback 状态；
- reason 不含原始 authorization/cookie/API key。



## 2c. 本轮实施边界与完成判据

本轮必须先完成并回归以下 P0/P1，而不是把 `npm test` 通过误当成全部架构完成：

- **已实施项**：Jev 审批 reason 由实际 method/path、规则 effect、Jev risk/verdict/fallback 组合；`src_http` 工具返回值与持久化 approval 使用同一 reason；`goal-*` 作为 intentId 在审批前明确拒绝；子代理凭据证据写回 parent engagement；research identity 包含 `findingId`；report/finalize 共用 active finding 筛选，rejected/duplicate 不再要求 verified。
- **本轮必须新增测试**：低风险 pending、Jev timeout、scope/硬边界、父子凭据写入、同 intent 同 category 不同 finding、rejected finding finalize/report。
- **尚未完成不得宣称完成**：endpoint manifest 创建与 coverage 绑定、artifact 文件 manifest、projection `eventSeq/lastAppliedEventSeq` stale/rebuild、provider capability/reasoning replay、orchestrator `on` 模式、new-api channel #3 修复。
- **生产开关**：`riskMode` 保持用户配置，不由修复过程擅自关闭；本轮代码部署前保存备份和回滚点。

实施状态必须写在每次发布记录中：`done / tested / not-yet-done / risk / rollback` 五项不能省略。

## 3. Phase 0：源码与发布基线

### 目标

任何后续测试都必须能够回答：运行的到底是哪份源码、哪个 commit、哪个 package 版本、哪个 profile。

### 执行步骤

1. 在唯一工作树 `/Users/lihua-dis/Software/dsh-src` 记录当前 commit、版本号和关键文件 hash。
2. 对 `/Users/lihua-dis/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src` 做只读 hash 对照。
3. 在启动日志中输出：`packageVersion`、`gitCommit`、`sourceRoot`、`profileRoot`、`configHash`。
4. 在 `scripts/deploy.mjs` 增加发布前检查：
   - `package.json` 可解析；
   - `npm test` 通过；
   - 关键文件不存在 `<<<<<<<`、`=======`、`>>>>>>>`；
   - 部署后的 package 版本和源码 hash 与发布清单一致。
5. 增加 CI 检查，任何 conflict marker 或非法 JSON 直接失败。

### 禁止事项

- 不从旧 linked worktree、临时目录或未解决冲突的源码部署。
- 不用“当前工作区能启动”代替构建验证。
- 不把部署副本的手工修改当成源码修复。

### 验收

- 新 session 日志能读出唯一 commit 和 package 版本。
- 源码目录、部署副本和 package 版本一致。
- `npm test`、语法检查、打包检查全部通过。
- 任意测试报告都能引用这组版本信息。

## 4. Phase 1：dsh 侧 provider/reasoning 故障恢复

### 现状判断

这次会话的 400 在第一次 compaction 前已经出现，因此不能把 compaction 作为唯一根因。dsh compaction 当前主要裁剪 `tool/result`，而 assistant reasoning replay 仍由 provider 适配器处理。

需要修复的是 dsh 的健壮性：它应知道某个 provider 是否支持 reasoning replay，并在协议错误时给出可恢复路径，而不是整轮静默终止。

### 修改位置

重点检查：

- `@deepseek-ai/dsh-llm-pi-ai` 的 replay state 处理；
- `@deepseek-ai/dsh-llm-deepseek` 或 newapi provider 适配层；
- `@deepseek-ai/dsh-llm-retry` 的 provider 错误分类；
- dsh agent loop 的 `agent/request-error` 和 turn recovery；
- compaction 配置与 `dsh-compaction-basic` 的 provider/model policy。

### 实施要求

1. 为 provider 增加能力声明，至少包括：

   ```js
   {
     supportsReasoningReplay: true,
     reasoningField: "reasoning_content",
     supportsThinkingSignature: true,
     supportsToolCallReplay: true
   }
   ```

2. replay 前校验：
   - provider 与历史 assistant source 一致；
   - model 与历史 response model 一致，或明确允许跨模型 replay；
   - reasoning block 数量与 replay state 一致；
   - thinking signature 属于该 provider 能力。

3. 对“字段缺失、思考格式不支持、replay state 不匹配”单独分类为 `protocol-incompatible`，不要和网络超时、429、503 共用重试策略。

4. `protocol-incompatible` 的恢复顺序：
   - 保留原始错误和 request id；
   - 尝试一次 provider 声明允许的安全降级；
   - 若不允许降级，提示用户切换模型或新建会话；
   - 不伪造 `reasoning_text`、`content[].thinking` 或任意签名；
   - 不无限重试同一请求。

5. compaction 应携带目标 provider/model policy。不同模型的 context threshold、保留尾部、summarizer 和 reasoning replay 策略不能共用未声明的默认值。

### 测试要求

增加最小 provider contract 测试：

- reasoning_content 可正确回放；
- provider 不支持 reasoning replay 时会明确降级或停止；
- 历史模型与当前模型不一致时不会静默重放；
- tool call 与 reasoning block 配对不完整时会给出诊断；
- 400 协议错误不会被当成普通网络错误无限重试；
- 新会话和 compaction 后会话的请求形态一致可解释。

## 5. Phase 2：goal、intent、endpoint manifest 与 coverage

### 5.1 建立不可变 endpoint manifest

不要允许模型通过修改 `endpointsTotal` 改变 coverage 分母。一次 reconnaissance 产生一个 endpoint manifest，每个 endpoint 具有稳定 ID：

```json
{
  "manifestId": "manifest-...",
  "source": "openapi:/openapi.json",
  "generatedAt": "...",
  "endpoints": [
    {
      "endpointId": "ep-...",
      "method": "GET",
      "path": "/api/items",
      "sourceRef": "openapi.paths./api/items.get",
      "status": "discovered"
    }
  ]
}
```

manifest 写入后，endpoint 数量只能由系统根据实际内容计算。模型只能引用 `endpointId`，不能提交任意 total。

### 5.2 重做 coverage 写入契约

`src_record_coverage` 应改为接收：

- `manifestId`；
- `endpointIds`；
- `phase`；
- `status`：`tested`、`skipped`、`blocked`、`not-applicable`；
- `evidenceIds`；
- `reason`。

服务端计算：

```text
total = manifest.endpoints.length
tested = endpoint status == tested 的数量
skipped = endpoint status == skipped 的数量
blocked = endpoint status == blocked 的数量
notApplicable = endpoint status == not-applicable 的数量
```

必须校验：

```text
tested + skipped + blocked + notApplicable <= total
```

finalize 只能验证 manifest 和 coverage，不得接受模型提供的 total/tested/skipped 覆盖系统计算结果。

### 5.3 goal 与 intent 锚点

所有 intent 必须明确绑定一个 goal 或一个已存在 fact。禁止出现没有 goal 的 child 写入、孤立 intent 或把 `goal-1` 当成 intentId 的调用。

工具层应在写入前拒绝：

- 不存在的 goalId；
- 不存在的 intentId；
- 同时传入互斥锚点；
- child 没有 parent engagement 却写入 engagement 数据。

### 验收

- 不能通过修改 coverage 分母绕过 finalize。
- 同一 endpoint 重复记录不会增加 tested 数量。
- 未测试 endpoint 会明确显示为 skipped、blocked 或未完成。
- coverage 可从 manifest 和事件重建，不能只依赖一行汇总数字。

## 6. Phase 3：finding、research、fact 与 artifact 证据一致性

### 6.1 finding 生命周期

定义唯一状态机：

```text
candidate -> active -> verified -> rejected
candidate -> rejected
active -> rejected
```

finalize 只对 `active` finding 要求完成验证。`rejected` 和明确标记为 duplicate 的 finding 不应阻塞 finalize，但必须保留拒绝原因、对应主 finding 和证据链接。

报告渲染范围和 finalize 校验范围必须调用同一个 `eligibleFindings()` 查询，不允许一个查全部 finding、另一个只查 active。

### 6.2 research identity

当前 research upsert identity 使用 `sessionId + intentId + category`，缺少 `findingId`，会导致不同 finding 互相覆盖。

推荐 identity：

```text
engagementId + intentId + findingId + category
```

如果研究对象不是 finding，使用显式 `researchId`，禁止依赖模糊 upsert key。增加唯一索引和冲突测试。

### 6.3 防止 verify 子代理重复造 finding

verify preset 即使禁止直接调用 `src_add_finding`，也可能通过 `src_submit` 的 findings 数组写入重复 finding。服务端必须按角色限制写入能力：

- verify 默认只能提交 observation、fact、research、checkpoint；
- 新 finding 必须显式声明 `createFinding=true` 和创建理由；
- 服务端按规范化标题、根因、影响范围和证据指纹做 duplicate 检查；
- duplicate 时建立 `duplicateOf` 关系，而不是新建 active finding；
- verify 不得修改已有 finding 的严重性和结论，除非通过明确的 finding review 工具。

### 6.4 facts 结构化

447 条普通 `info` fact 会污染上下文、增加压缩压力并降低证据可读性。路由枚举应落为结构化 artifact 或 endpoint manifest；fact 只保存：

- 一句话结论；
- 来源引用；
- 相关 endpoint/finding/observation ID；
- 是否已经验证；
- 去重指纹。

禁止把完整 OpenAPI 路由表逐条复制进 fact 图。

### 6.5 artifact 交付闭环

checkpoint 声称生成的 artifact 必须有 manifest：

```json
{
  "artifactId": "artifact-...",
  "path": "route-table.json",
  "bytes": 1234,
  "sha256": "...",
  "createdBy": "session-...",
  "status": "present"
}
```

finalize 前检查：

1. 文件存在；
2. 文件大小与 manifest 一致；
3. hash 一致；
4. artifact 属于当前 engagement/session；
5. checkpoint 引用的每个交付物都能在 manifest 找到。

只在 checkpoint 文本中声称“已生成文件”不算交付证据。

## 7. Phase 4：事件、SQLite 与 projection 一致性

### 目标

事件日志作为事实来源，SQLite 作为查询投影，projection cache 必须可检测过期并可重建。

### 实施步骤

1. 每个事件带单调递增 `eventSeq`。
2. 每个 projection 记录 `lastAppliedEventSeq` 和 `projectionVersion`。
3. 读取 session 时比较最新事件 seq 与 projection seq。
4. 不一致时返回 `stale=true`，触发重建或明确显示“正在重建”。
5. 禁止用旧 projection 的 `turns=1`、`steps=1` 覆盖数据库真实计数。
6. 增加 divergence 事件，内容包括：sessionId、projection seq、event seq、重建原因、重建结果。
7. 为 artifact、coverage、finding、approval、child lifecycle 分别提供可重建 projection。

### 验收

- 删除 projection cache 后可以从事件和 SQLite 重建相同 session 视图。
- append 新事件后 projection 不会继续显示旧 goal 或旧 step 数。
- projection 过期时 UI 和 API 都返回可理解的状态，而不是静默错误数据。

## 8. Phase 5：Jev 的正确职责与接入时机

### 8.1 保留当前正确边界

Jev 在 `src_http` 的 scope 检查和本地分类之后、实际请求之前做风险判断，这个位置继续保留。Jev 不能：

- 自己执行 HTTP；
- 消费或制造用户 approval grant；
- 扩大目标 scope；
- 将 pending、timeout、服务错误解释为 allow；
- 放行破坏性、越权、真实外发或影响不明操作。

### 8.2 可以扩展的决策点

按优先级：

1. `risk-grade`：一次 HTTP 请求的低风险/高风险/不明判断。
2. `skill-activate`：对已经由规则预筛的候选进行排序。
3. `delegate`：提供 self/delegate 建议，不能直接代表派发完成。
4. `browser-index`：只能在已有候选动作中选择，不能生成新动作和参数。

### 8.3 不要让 Jev 接管的决策

- 主模型的完整任务规划；
- authorization 来源和授权范围；
- 资产归属；
- endpoint manifest 生成；
- finding 是否成立；
- coverage 是否完成；
- finalize；
- child recovery、approval 生命周期和 retry 调度。

### 8.4 Jev 输入最小化

传给 Jev 的请求必须经过：

1. scope 校验；
2. 凭据脱敏；
3. body 截断或结构化摘要；
4. 明确的 executionPolicy；
5. 当前 goal/intent 的有限上下文。

不要把完整历史会话、未脱敏响应、页面内指令或模型自行写的“允许执行”文本直接交给 Jev。

### 8.5 Jev 失败策略

- risk 模式：服务不可用、超时、非法 JSON、矛盾结论统一转人工；
- skill 模式：失败时静默或给主模型建议，不阻断 HTTP；
- delegate 模式：失败时由主模型决定，不自动派发；
- browser 模式：失败或 none 时不点击、不生成动作；
- 所有结果记录 provider、model、latency、fallback、输入指纹和输出版本。

### 8.5b Jev verdict 的代码侧解释规则（今天 session 的直接根因）

> 2026-10-01 真实会话 session-3291bab8 中，Jev 对 23 条低风险只读请求全部返回 `risk=low + verdict=pending`，被统一渲染为"高风险/不确定/矛盾转人工"。这不是 Jev 宕机，而是 Jev 输入缺少"用户已授权低风险自动审批 + 代码已校验 scope"的 executionPolicy 前提，且 verdict 解释层把 pending 一律当作高风险。

**修复后的解释规则（服务端代码强制，不能靠 Jev 自觉）**：

```
IF Jev 返回 verdict=allow AND risk=low AND effect 已知 AND scope 已过 AND 非破坏性/越权 THEN 自动执行
ELSE IF verdict=pending THEN 人工审批（无论 risk=low 还是 high/unknown；reason 必须组合实际请求语义，见 2b.3）
ELSE IF verdict=reject/unknown 或服务失败/超时/非法输出 THEN 人工审批
```

**关键点**：
1. `verdict=pending` 不等于高风险。reason 渲染必须区分"Jev 判定 pending"和"Jev 服务失败"和"真正的高风险"；
2. Jev 输入必须带 executionPolicy（用户已授权范围、scope 已过、允许低风险自动外发）；
3. Jev 输出必须和代码规则分类交叉验证：`risk=low + effect=read + verdict=allow + scope 已过` 才能自动执行；`verdict=pending` 不能因为 risk=low 被自动放行；
4. 服务端必须有可配置开关（riskMode=on/shadow/off）控制是否让 Jev 参与；
5. 已有 pending 审批单不可通过重发自动重新放行。


### 8.6 解决当前 Skill 提醒时机问题

当前 Skill 推荐挂在 `src_http` 前，但提示往往随请求结果一起返回，容易错过本次操作。改为两阶段：

1. 在模型选择工具或 `src_add_intent` 时提前产生候选提示；
2. 在 `src_http` 前只做一次轻量确认；
3. 读取 Skill 后把 recommendationId 与下一个行动、证据和 outcome 关联；
4. 没有读取或没有后续证据时不要把推荐计为成功。

## 9. Phase 6：orchestrator 与 prompt 收敛

### 9.1 orchestrator 负责什么

现有 `lib/src/orchestrator/` 已有 shadow 建议和状态机，但 `on` 模式后台 tick/lease 尚未完成。下一步应把以下逻辑集中到 orchestrator：

- planned → queued；
- queued → running；
- child started/error/ended；
- orphan detection 和定向恢复；
- approval pending/resolved；
- user todo blocked；
- finalize readiness；
- provider protocol error 后的 session 状态。

工具不应任意直接写 intent status。所有状态迁移必须经过 `transitions.js` 的合法迁移表，并写入事件。

### 9.2 事件驱动而不是轮询

审批、child completion、child error、artifact sync 和 projection rebuild 采用事件触发。不要用“每隔几秒轮询 pending”或“用户发送继续后碰运气恢复”。

每个 child 至少记录：

- childSessionId；
- parentSessionId；
- intentId；
- startedAt；
- lastTurnAt；
- lastCheckpointAt；
- lastError；
- residency 状态；
- 可恢复次数和最后一次恢复原因。

### 9.3 prompt 瘦身

`lib/src.js` 中的 SRC instructions 不应同时承担授权、编排、审批、恢复、Burp、Skill、coverage 和报告规则。拆分为：

- 系统硬规则：代码和服务端强制；
- 工具契约：每个工具的输入、输出和失败方式；
- 当前任务上下文：goal、intent、scope、预算；
- 模型建议：路线、Skill、delegate/self；
- 报告模板：只在 finalize 阶段注入。

prompt 中写“应该怎样做”的内容，服务端必须再次验证，不能仅靠模型遵守。

## 10. Phase 7：授权与审计字段

goal 当前 `authorization=""`，但 prompt 将“正规 SRC 注册”近似当成默认授权。必须把授权变成显式数据：

```json
{
  "authorization": {
    "source": "user-message|saved-policy|manual-confirmation",
    "principal": "...",
    "grantedAt": "...",
    "scope": ["https://example.com"],
    "instructionRef": "user-message-id",
    "limits": {
      "allowUnauthenticatedRead": true,
      "allowWrite": false,
      "allowExternalSend": false
    }
  }
}
```

要求：

- 没有授权来源时不能自动放行；
- 应用接口未鉴权不等于用户没有授权测试（这是今天 session-3291bab8 的直接根因之一）；
- Jev 只能消费已经验证的 executionPolicy；
- executionPolicy 的来源必须是显式授权记录（user-message / saved-policy / manual-confirmation），不能由主模型自行声明；
- Jev verdict 解释层必须交叉验证：授权记录 + scope 校验结果 + Jev risk/effect/verdict + 代码硬边界，四个条件全部满足才允许自动执行；
- scope 越界在 Jev 之前拒绝；
- 所有 approval、自动放行和 finalize 报告引用授权记录。

## 11. 测试矩阵

### P0 必测

- conflict marker 和非法 package JSON 阻止构建；
- 部署版本/hash 与源码清单一致；
- projection stale 检测与重建；
- coverage 分母不可由模型修改；
- active/rejected finding finalize 语义一致；
- research 不会跨 finding 覆盖；
- artifact manifest 缺文件时 finalize 失败；
- scope 越界永远不能被 Jev allow；
- Jev timeout/schema error 进入人工路径；
- reasoning protocol error 不无限重试。

### P1 必测

- verify 子代理重复 finding 去重；
- child error 后仍驻留时的 orphan/recovery；
- parent/child evidence 回写；
- endpoint manifest 重复导入和 endpoint ID 稳定性；
- Skill offered/selected/read/run/approval/outcome/evidence 漏斗；
- 删除 projection 后完整回放；
- 新会话、长会话和 compaction 后会话的 provider replay。

### 回放测试

使用脱敏的历史 session fixture，只回放工具和状态事件，不访问真实目标、不调用付费主模型。每次回放检查：

- 状态迁移序列；
- coverage 汇总；
- finding 状态；
- artifact manifest；
- projection hash；
- finalize 结果。

## 12. 灰度与发布

推荐顺序：

1. 先在 `shadow` 模式记录 orchestrator、coverage、新 projection 和 Jev 结果。
2. 只对合成 fixture 开启强校验。
3. 选择一个新 session 开启 endpoint manifest 和 artifact manifest。
4. 验证 3 个以上无真实目标的完整回放。
5. 再对低风险 HTTP 开启 Jev 自动放行。
6. 最后才启用 orchestrator `on` 模式。

每次发布保存：

- package version；
- git commit；
- profile；
- config hash；
- schema version；
- feature flags；
- 测试结果；
- 回滚点。

回滚只回滚代码和 feature flag，不覆盖后续 SQLite、event store、artifact 和 telemetry。数据迁移必须向后兼容。

## 13. 完成定义

当且仅当以下条件全部满足，才能认为改进完成：

- 工作区和部署副本有唯一、可追溯的源码基线；
- 长会话 compaction 不会因为未知 provider replay 能力静默终止；
- coverage 的 total 只能来自 manifest；
- rejected finding 不会阻塞 finalize；
- research 不会跨 finding 覆盖；
- verify 不会无审批地产生重复 active finding；
- 路由枚举不会以 400 多条普通 fact 膨胀上下文；
- artifact 声明都有文件、大小和 hash 证据；
- projection stale 可发现、可重建；
- 授权来源、范围和限制可审计；
- Jev 只承担局部决策，硬边界和状态机不依赖模型自觉；
- 子代理错误、审批、恢复和 finalize 由事件驱动；
- 失败会话不需要用户反复发送“继续”才能恢复或得到明确原因。

## Appendix A：new-api reasoning 400（独立项目）

这一部分不属于 dsh 项目本身，最后处理。当前证据只能说明它是最可能的外部链路问题，不能证明具体转换层：

- new-api channel #3 的 400 request id 与 dsh session 匹配；
- dsh 历史 replay state 使用 `thinkingSignature: "reasoning_content"`；
- 同一路由出现多个 responseModel，存在混用不兼容模型的风险；
- 400 在第一次 compaction 前已经出现，因此不能称为“compaction 单独导致”；
- 没有 new-api 入口的原始 JSON，不能断言是 dsh 发错还是 new-api 转换错。

### new-api 项目的检查顺序

1. 用失败 request id 定位 channel #3 的完整入站和出站日志。
2. 对比 dsh → new-api、new-api → 上游两份脱敏 JSON。
3. 确认 channel #3 是否混用 DeepSeek、MiniMax、Vision 等不同 reasoning 协议模型。
4. 每个模型拆成固定 channel，禁止同一 channel 自动混用。
5. 确认 thinking 开关和 reasoning 字段映射是否一致：`reasoning_content`、`reasoning_text`、`content[].thinking` 不能靠猜测互换。
6. 若上游不支持 reasoning replay，临时关闭该 channel 的 thinking 或切换兼容模型。
7. 新建会话验证，再验证 compaction 后的第二次请求。
8. 不要添加伪造 reasoning 字段，不要用无限重试掩盖 400。

### 临时使用建议

- 先停用 channel #3 或切换到已知兼容 channel；
- 固定 provider/model，不要混合路由；
- 必要时关闭 thinking 并新建 dsh 会话；
- 只有在 new-api 明确修复字段转换或模型映射后，才恢复原 channel。

### 何时需要 dsh 新版

如果只是为了恢复当前使用，不必等待 dsh 新版；调整 new-api channel 或关闭 thinking 通常可以绕开问题。

如果希望 dsh 自动恢复，则需要 dsh 增加 provider capability、协议错误分类、一次性安全降级和兼容路由切换。仅仅升级 dsh，而不修复 new-api channel 的模型映射，不能保证问题消失。

