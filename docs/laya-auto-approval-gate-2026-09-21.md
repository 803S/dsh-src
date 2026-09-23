# dsh-src 优化手册中提及的自动审批闸升级

版本：v1.5
发布日期：2026-09-23
更新者：kimi-k3

## 背景

当前 dsh-src 在执行 HTTP 请求时遵循 **纯硬编码审批规则**：凡是写入/破坏性操作，**全部强制挂起待办**（即 `approval=pending`），等用户在面板「待办」区点「批准」/「拒绝」后才真正发出请求。

这种策略虽然安全，但**过度负担了用户**：即使低风险的 GET /public/asset.js 也能触发审批→影响效率；同时，低危流量反复触发审批也稀释了用户的审批注意力，导致高危事件可能被忽略。

此外，还存在两个结构性痛点：
1. **主 agent 过载**：telemetry 证实 61 次 `src_http` 全由主 agent 自主执行，子代理 0 次执行。主 agent 亲自干大量细碎工作，上下文膨胀、决策效率下降。
2. **Skill 激活率低**：可执行 skill（如 `wx-minapp-recon` 扫描小程序包、`clown-src-playbook` 结构化 playbook）依赖 agent 自主判断是否激活，缺乏可靠机制确保在合适的场景触发。

## 核心方案：Laya 驱动增量决策器

### 1. 设计理念

Laya 是 **System 1 快速决策引擎**（~12ms 推理，结构化 score/choice/noul 输出，不生成自由文本）。dsh-src 将其定位为 **「软决策层」**——不替代硬规则，只在规则模糊或需要量化判断时提供辅助。

三个决策器共享 **同一个 Laya 模型 + 同一个 daemon 进程**，区别仅在于 prompt 模板和 schema。每个决策任务独立 flag，可单独 shadow/on，互不干扰。

### 2. 三个决策器的职责

| 决策器 | 触发时机 | 输入特征 | 输出 | 当前优先级 |
|--------|----------|----------|------|------------|
| **Delegation**（主/子代理分工） | 主 agent 拿到子任务，决定自己做还是派给子代理 | 任务类型、复杂度、隔离需求、上下文依赖度 | `delegate` / `self` | ⭐⭐⭐ 最急 |
| **Skill Selector**（技能提醒） | agent 即将自己测/派子代理时（src_http 头部、委派点） | 请求上下文、规则层预筛候选（带分）、本会话已用 skill | `"<skill-key>"` / `skip` | ⭐⭐⭐ 次急 |
| **Vuln Evaluator**（漏洞有效性） | 疑似漏洞产出后，判断是否真实可利用 | 技术栈、响应码、响应体特征、错误信息 | `valid` / `invalid` / `pending` | ⭐ 可选 |

### 3. 共享基础设施

#### 3.1 Laya 决策守护进程
**文件：** `~/models/laya/scripts/laya-decision-daemon.py`
**功能：** 单例模型，监听 TCP/HTTP 决策请求，提供 `/decide` 接口。不同决策器传入不同 `taskType`，daemon 选择对应 prompt 模板。

- 离线模式启动（~1s 冷启）
- 多 prompt 模板路由：`/decide?taskType=delegate|skill|vuln`
- 失败时自动降级为不可用状态

#### 3.2 客户端封装
**文件：** `lib/src/decision/laya-client.js`
**功能：** 将 dsh 的特征转换成 Laya prompt，调用 daemon `/decide`，解析结果。

关键特性：
- 惰性加载单例，启动不阻塞
- 250ms 超时，fail-open（daemon 不可达返回中性值）
- 只对 commander 会话生效，子代理完全不受影响

#### 3.3 旗标控制
**文件：** `lib/src/flags.js`
**新增 flag：**

| Flag | 默认 | 取值 | 说明 |
|------|------|------|------|
| `DSH_SRC_LAYA_DECISION` | `off` | off/shadow/on | 审批闸（已有） |
| `DSH_SRC_LAYA_DELEGATE` | `off` | off/shadow/on | 主/子代理分工决策 |
| `DSH_SRC_LAYA_SKILL` | `off` | off/shadow/on | Skill 提醒（shadow=只记录，on=过闸后注入单行提醒） |
| `DSH_SRC_LAYA_VULN_EVAL` | `off` | off/shadow/on | 漏洞有效性判断 |

### 4. 详细设计

#### 4.1 Delegation（主/子代理分工）

**触发时机：**
- 主 agent 拿到一个子任务（如「对 /api/login 做爆破穷举」「扫描 50 个端点」）
- 在 `src_http` execute 头部或子代理派发点插入 hook

**输入特征：**
```javascript
{
  taskType: "http-probe" | "port-scan" | "banner-grab" | "payload-test" | "recon-batch",
  goalType: "recon" | "vuln" | "exploit" | "report",
  estimatedSteps: 1-10,
  requiresIsolation: true/false,  // 是否需要独立环境/长时间运行
  contextDependency: "high" | "medium" | "low",  // 是否依赖主会话状态
  isWriteOp: true/false
}
```

**输出：**
```javascript
{
  action: "delegate" | "self",
  confidence: 0-1,
  reason: "需要爆破穷举，适合子代理独立运行"
}
```

**决策规则示例（Laya prompt 中的 instructions）：**
- `requiresIsolation=true` + `estimatedSteps≥5` → `delegate`
- `contextDependency=high` → `self`
- `subtaskType=payload-test` + `goalType=exploit` → `delegate`（子代理更适合试错）
- `isWriteOp=true` → `self`（写操作需主 agent 审批，不 delegate）

**嵌入位置：** `tools/index.js` 的 `src_http` execute 头部（已有 hook 位置，扩展 `taskType="delegate"`）

#### 4.2 Skill Selector（技能提醒）

**定位修正（v1.5，用户拍板）：** Skill Selector **不是激活器，是提醒器**。

痛点是**遗忘**而非「没能力」：agent 怀疑某处有漏洞、准备自己测或派子代理去测的时候，**经常想不起来手上还有 skill**（哪类漏洞有现成方法论文档、哪个资产类型有专用脚本链）。Skill Selector 的作用是在这个决策点**递一个候选过去把它叫醒**，由 agent 自己判断该 skill 能不能用。**不做自动激活**——激活与否仍是 agent 的决定。

##### 4.2.1 skill 的真实来源（三处，缺一不可）

| 源 | 位置 | 数量 | 形态 |
|----|------|------|------|
| **playbook route** | `lib/src/playbooks.js` 的 `ROUTES` | 17 | 漏洞方法论文档索引（recon/authorization/injection/…），每条映射若干知识库文档 |
| **知识库文档** | `<clown-src-playbook>/skills/skill/知识库/*.md` | 49 | 单个漏洞类测试方法论（idor-test/ssrf-test/…） |
| **能力 skill** | `~/.dsh/capabilities.yaml` 的 `kind: skill` 条目 | 5 | 可执行脚本链（wx-minapp-recon / droidasc / …）+ 文档型能力 |

> ⚠️ 候选**绝不能**用 `fofa`/`agniops` 这类**侦察工具名**——它们是数据源，不是 skill。v1.4 及之前 local.91 的实现即此处出错，导致 Laya 被问到「该激活哪个 skill」时只能在两个工具名之间选，产出语义垃圾（如 `action="fofa"`）。

##### 4.2.2 触发时机

**决策点**（agent 即将自己动手测 / 即将派子代理时）：
- `src_http` execute 头部——agent 正要发一个测试请求
- 委派点（`src_recon` / 子代理派发）

**不是**每个请求都提醒：无一命中候选 → 静默返回，不调用 Laya、不注入任何内容。

##### 4.2.3 输入特征（全部 off-context）

```javascript
{
  taskType: "skill-activate",
  context: { method, path, host, goalTarget, assetType },
  candidateSkills: ["authorization", "js-reverse"],   // 规则层预筛 topN（≤5，且有分才留）
  skillMatchScores: { authorization: 6, "js-reverse": 3 },  // 来自 scoreRoutes 真实分数
  lastSkillUsed: "recon" | null                        // 本会话 skill.read telemetry 推导
}
```

**候选预筛（规则层，零模型开销）：**
```javascript
// ① 审批分类是强意图信号：classifyHttpRequest 的 category 直连对应 route（score=10）
//    如 category="越权删改" → authorization；"破坏性写入" → business-logic
// ② 放行请求回落到 scoreRoutes 的 terms 匹配（graphql/js/上传/ssrf 等关键词）
//    裸 REST 路径（如 /api/user/1002/profile，无术语词）是零分 → 静默，不调 Laya
const candidates = recallCandidates({ method, path, query, body, category: verdict.category, goalTarget: goal?.target }, 5);
if (candidates.length === 0) return;   // ← 静默，连 Laya 都不调
```
另叠加 `capabilities.yaml` 中 `when`/`triggerKeywords` 命中当前资产类型的能力 skill（单字/双字母缩写如 `mp`/`app` 禁用，防子串误伤）。

**输出：**
```javascript
{
  action: "authorization" | "skip",   // 单个 skill route key，或 skip
  confidence: 0-1,
  evidence: "matchedBy=[越权, 权限]"
}
```

##### 4.2.4 上下文污染闸（核心约束，用户拍板）

**Laya prompt 与 telemetry 都不进 agent 上下文**，所以候选列表给 Laya 多长都不污染。**唯一会污染的是注入回 agent 的内容**——因此注入必须过四道闸：

```
1. picked !== "skip"
2. confidence ≥ 阈值（初值 0.6，灰度调参）
3. 该 skill 本会话未被提醒过（同一 skill 不重复提醒）
4. 该 skill 未被读过（本会话无 skill.read 事件）——已经读过的不用再提醒
```

**注入形态：≤1 行**，随工具返回值携带（与既有 `scrapeHint` 同模式）：

```
提示：本次测试涉及越权面，可读 idor-test.md（src_read_capability clown-src-playbook skills/skill/知识库/idor-test.md）
```

| 环节 | 进 agent 上下文 | 量级 |
|------|----------------|------|
| 候选列表 → Laya prompt | ❌ 否（本地 daemon 调用） | 任意 |
| Laya 决策 → telemetry JSONL | ❌ 否（落文件） | 任意 |
| Laya 决策 → agent 提示 | ✅ **是** | **≤1 行 / 每 skill / 每会话一次** |

##### 4.2.5 shadow / on 语义

| 模式 | 行为 |
|------|------|
| `off` | 完全不跑，无 Laya 调用、无 telemetry、无注入 |
| `shadow` | 跑规则预筛 + Laya，落 telemetry（`taskType=skill`），**不注入**——用于灰度评估提醒质量与阈值 |
| `on` | 同上 + 过四道闸后注入 ≤1 行提醒 |

**嵌入位置：** `lib/src/tools/index.js` 的 `src_http` execute 头部（Laya hook 块内），以及委派点。

##### 4.2.6 与 `src_add_intent` 内建路由的关系

`src_add_intent` 已有 `routePlaybookV2` 机械路由，并把 `playbook.docs` 随意图返回（建意图时告知「先读哪些」）。Skill Selector 与之**互补而非重复**：
- 建意图时：规划期，告知**该方向**的方法论文档（静态、随意图）
- 执行测试时：行动期，agent 已临近动手/委派，**此时最容易遗忘**——递一个候选把它叫醒（动态、随请求上下文）

Laya 在此的增量价值 = **语义匹配**：`scoreRoutes` 是词面 substring 命中，Laya 能对「看起来不像但语义相关」的场景补召回（如响应里出现 GraphQL introspection → 命中 api-and-protocol）。

#### 4.3 Vuln Evaluator（漏洞有效性）

**触发时机：**
- `src_findings` 产出疑似漏洞后，判断是否真实可利用

**输入特征：**
```javascript
{
  taskType: "vuln-eval",
  techStack: ["Express", "Node.js", "MongoDB"],
  statusCode: 500,
  responseBody: "...",
  errorMessage: "MongoDB injection detected",
  fingerprintSource: "fofa" | "agniops" | "manual"
}
```

**输出：**
```javascript
{
  action: "valid" | "invalid" | "pending",
  confidence: 0-1,
  reason: "响应特征与 MongoDB 注入指纹高度匹配"
}
```

**决策规则示例：**
- 响应码 500 + 错误信息含 DB 关键词 + fingerprintSource=fofa → `valid`
- 响应码 404 + 无敏感错误信息 → `invalid`
- 置信度 < 0.6 → `pending`（标记待人工确认）

**嵌入位置：** `tools/index.js` 的 `src_record_finding` 或 `src_findings` 汇总阶段

### 5. 部署流程

#### 5.1 环境准备
```bash
# 激活 Laya 环境
cd ~/models/laya
source laya-env/bin/activate
export HF_HOME=/Users/lihua-dis/models/laya/hf_cache
export HF_HUB_OFFLINE=1

# 启动守护进程
python3 scripts/laya-decision-daemon.py &
```

#### 5.2 设置 flag
```bash
# 在启动 dsh 时设置环境变量
export DSH_SRC_LAYA_DECISION=shadow   # 审批闸 shadow
export DSH_SRC_LAYA_DELEGATE=shadow   # 分工决策 shadow
export DSH_SRC_LAYA_SKILL=shadow      # Skill 排序 shadow
# DSH_SRC_LAYA_VULN_EVAL 默认 off，暂不开启
```

#### 5.3 重启 dsh 服务
```bash
cd ~/Software/dsh-src
node scripts/deploy.mjs
# 重启 dsh web / headless
dsh web --host 0.0.0.0 --port 3080
```

### 6. 测试和验证

#### 6.1 测试步骤
1. **shadow 模式测试**：启动 dsh，设置对应 flag=shadow，观察日志记录和 telemetry 数据
2. **数据分析**：统计各决策器的准确率、误放率、漏放率
3. **阈值调整**：根据实际测试结果调整置信度阈值
4. **on 模式测试**：当各项指标满足要求后，切 on 验证自动效果
5. **回归测试**：确保所有现有测试都能通过

#### 6.2 验收指标

| 验收指标 | Delegation | Skill Selector | Vuln Evaluator |
|----------|-----------|----------------|----------------|
| 测试通过率 | ≥ 95% | ≥ 95% | ≥ 95% |
| 准确率（shadow 数据） | ≥ 80% | ≥ 75% | ≥ 85% |
| 误放率（on 模式） | < 5% | < 5% | < 3% |
| 漏放率（on 模式） | < 10% | < 10% | < 5% |
| 平均每次决策耗时 | ≤ 100ms | ≤ 100ms | ≤ 100ms |

### 7. 资源与性能

**单模型多 prompt 模板**：
- Laya 模型只加载一次（~500MB RAM，~1s 冷启）
- 不同决策器传入不同 `taskType`，daemon 选择对应 prompt 模板
- 每次推理 ~12ms，不增加额外模型加载开销

**本地部署可行性**：
- 单台 MacBook Pro 16GB 可流畅运行
- 若后续增加更多决策器，只需增加 prompt 模板，无需加载新模型

### 8. 版本历史

#### v1.5 (2026-09-23)
- **Skill Selector 定位修正（用户拍板）**：从「激活器」改为「**提醒器**」——解决的是 agent 在动手/委派时的**遗忘**，不是能力缺失；由 agent 自己判断 skill 能不能用，不自动激活
- **skill 真实来源澄清**：三处——`playbooks.js` 的 17 个 route + 知识库 49 篇文档 + `capabilities.yaml` 的 5 个能力 skill；**纠正 local.91 用 `fofa`/`agniops`（侦察工具，非 skill）当候选的语义错误**
- **候选预筛改走 `scoreRoutes`**：用真实分数与 matchedBy，零额外模型开销；无正分候选→静默不调 Laya
- **新增上下文污染闸（4.2.4）**：Laya prompt 与 telemetry 均 off-context；注入回 agent 的内容过四道闸（非 skip / confidence≥阈值 / 本会话未提醒过 / 本会话未读过），且**≤1 行**
- **shadow/on 语义明确**：shadow=只落 telemetry 不注入；on=过闸后注入单行提醒
- 阐明与 `src_add_intent` 内建路由的互补关系（规划期告知 vs 行动期提醒）

#### v1.4 (2026-09-22)
- 修正 skill 定义（是执行脚本链，非提示词模板）
- 明确三层分工：规则层（召回）→ Laya（排序）→ 执行层（运行）
- 决策器优先级：Delegation > Skill Selector > Vuln Evaluator
- 单模型多 prompt 模板设计

#### v1.3 (2026-09-21)
- 新增自动审批闸方案设计
- 建立全套方案落地文档
- 提供代码实现文档

#### v1.2 (2026-09-12)
- Phase 7/8 测绘种子闭环方案
- 补充阶段性变化

#### v1.1 (2026-08-28)
- 基础优化方案设计
- 初步评估过程

### 9. 附录

#### A. 术语表

| 术语 | 释义 |
|------|------|
| 决策守护进程 | 负责 load Laya 模型、提供 HTTP 决策接口的进程 |
| prompt 模板 | 不同决策器的输入格式（taskType 不同，schema 不同） |
| flag | 用于控制自动审批闸行为的标志位 |
| shadow 模式 | 仅记录 Laya 决策结果，不对实际审批行为产生影响 |
| on 模式 | 根据 Laya 决策结果自动放行/拦截 |
| fail-open | 守护进程不可用时，自动降级为原有流程 |
| commander | 主 agent 会话（非子代理会话） |
| skill | 两层含义：①**能力 skill** = `capabilities.yaml` 中 `kind: skill` 的条目，可执行脚本链（如 `wx-minapp-recon` = 扫描→反编译→提取→分析）或文档型能力；②**方法论文档** = 知识库 `skills/skill/知识库/*.md`（如 `idor-test.md`），由 playbook route 索引。**不是**侦察工具（fofa/agniops） |
| skill 提醒 | 在 agent 即将测试/委派时，递一个相关 skill 候选过去把它叫醒；不自动激活 |
| 污染闸 | 注入回 agent 上下文的四道条件，保证提醒 ≤1 行且不重复 |
