# 影响分类判据收敛为单一事实来源（架构）

- 日期：2026-10-18
- 状态：已实施（`0.1.0-local.145`）
- 起因：用户质疑「这不是一道闸吗，为啥感觉有很多分支……这又要一个单独配置的？不是改一统一的那个地方就好了吗？架构有问题吧？还是项目膨胀了？」

## 结论

架构确实漂移了，而且 `local.144` 那一轮是**我亲手加重**的：`external` / `external-probe` 拆分时，只在两处（判定 rubric + 计划车道）加了新分类，另外几处消费点靠"以后再说"，于是漏出两个真实缺陷（见下）。

但**不是项目膨胀**：这 7 个文件各自属于不同执行车道（判定 rubric / 计划车道 / 单笔车道 / 执行材料 / 执行器选择 / 同资源待决 / 卡片与 UI 文案），车道之间的确需要不同结论。真正错的是**同一概念被各自硬编码**，而且差异是隐式的——写死两个不同名单，没有任何地方说明"为什么这里不一样"。

量化：收敛前，"哪些 effect 能自动放行 / 需要什么材料"这一套判据被硬编码在 **7 个文件 14 处**：

| 位置 | 硬编码内容 |
| --- | --- |
| `decision/jev-client.js` | rubric 判据 + `lowImpact` → 风险下限（决定谁能被判低） |
| `egress/decision-policy.js` | `allowsLowImpact` 名单 + `reviewSummary` 分类白名单 |
| `decision/http-policy.js` | 单笔车道放行名单 |
| `egress/safety-plan.js` | `reviewedReadSafety` 名单 + 材料要求映射 + 材料枚举 |
| `egress/broker.js` | `safeRead` 名单 + 执行器名单 + 隐式只读名单 + safety 只读判定 |
| `egress/manager.js` | 审批卡人话分支 |
| `tools/index.js` | `src_http` 的 `safetyPlan.effect` schema 枚举（第 3 份材料枚举） |
| UI `approval-explanation.ts` | 又一份人话表 + 又一份材料要求映射 |

## 上一轮踩到的两个真坑（都在 `external-probe` 上）

1. 漏改 `safety-plan.js` → 低风险探测被 `SAFETY_PLAN_REQUIRED` 挡成人工卡；
2. 漏改 `broker.js` 的同资源未决判定 → 低风险探测被同一资源上另一笔未决审查挡成人工卡。

两者都表现为"测 SSRF 又被拦了"，但根因是**新增分类没同步消费点**，不是判定结果本身。

另有第三类坑：`http-policy.js` 的放行名单里长期写着 `external` 可自动，只因 `jev-client.js` 那一处常量把 `external` 钉成 `high` 才从未生效——**放行名单不得依赖别处常量兜底**，必须在本地自证。

## 实施

新增 `lib/src/decision/effect-policy.js`：一张表 `EFFECT_POLICY`（8 个分类 × 6 列）+ 由表派生的具名集合。

列：`label`（人话）、`impactFree`（对目标业务状态无副作用，与"是否出网"无关）、`readLike`（低风险时无需备份/前置/回读材料）、`lowImpactOn`（判定侧风险下限：`true` / `false` / `'risk-graded'` / 对象归属数组）、`executor`（谁能执行）、`materialFor`（需要哪种材料语义）。

派生集合（每个都对应一个**独立概念**，车道只能读它们，不得就地写数组）：

- `IMPACT_FREE_EFFECTS` = read / compute / auth / external-probe
- `READ_LIKE_EFFECTS` = read / compute / external-probe
- `WRITE_EXECUTOR_EFFECTS` = auth / write / external / destructive
- `SINGLE_LANE_AUTO_EFFECTS` = IMPACT_FREE + write
- `PLAN_LANE_AUTO_EFFECTS` = IMPACT_FREE + unknown
- `AUXILIARY_READ_EFFECTS` = read / compute（"可按只读对待"，故不含探测与凭据类）
- `IMPLICIT_READ_EFFECTS` = read / compute / unknown
- `SAFETY_*`（材料词汇表：read / compute / replace / create / delete / external）

`describeEffect()` 收走审批卡人话（原来是 `manager.js` 里的一长串 `if`）。

## 行为变化

除下列两项外，全部是**等价替换**（测试逐项断言派生集合与旧字面量相同、`riskFloor` 与旧表达式在 8×5 组合上逐一相同）：

1. `http-policy.js` 的"动作与分类矛盾"检查：`['read','compute']` → `READ_LIKE_EFFECTS`（**收紧**：用 PUT/PATCH 发的"有界外发探测"现在会被判矛盾并交人工）；
2. `broker.js` 里对 `hostExecution.safety` 的只读判定：`['read','compute']` → `SAFETY_NON_MUTATING_EFFECTS`（**收紧**：内部构造的探测类安全计划不再被要求备份材料；模型无法触发，因为模型可声明的 `safetyPlan.effect` 枚举里没有 `external-probe`）。

`src_http` 的 `safetyPlan.effect` 枚举值由 `SAFETY_EFFECTS` 生成，取值与顺序都不变，对外契约无变化。

## 防复发

`tests/effect-policy.test.mjs`（9 条）：

- 表完整性：每个分类都必须有文案与全部维度（新增分类忘补 → 红）；
- 派生集合 == 收敛前的 14 处硬编码值（想改判据必须改这张被测试钉住的表）；
- `riskFloor` 与旧判定表达式的真值矩阵逐个相同；
- **车道一致性**：同一分类在单笔车道 / 计划车道 / 材料车道给出同一结论，差异只能是表里显式声明的那两处；
- `local.144` 那两个坑的回归锁；
- 文案不得掩盖事实（探测不得被描述成"只读"）；
- **跨包对齐**：UI 文案表的键必须是真实分类、且覆盖全部"有影响"的分类；UI 自带的材料映射必须与表相同（UI 独立打包、不能 import lib，故用断言锁）；
- **反蔓延**：扫描 `lib/src/**/*.js`，禁止出现 effect 名单字面量（方括号里 ≥2 个分类字面量，或凭空出现的 `.includes('external-probe')`）。豁免必须写成当行的 `effect-policy-lint-allow` 注释并说明理由（现有 4 处，均为宿主工具名白名单 `['read','write','edit',...]`）。

反向验证：故意在 `decision-policy.js` 里重新塞一份 `['read','compute','auth','external-probe']`，反蔓延测试与车道一致性测试同时报红并给出 `file:line`；还原后 9/9。
