# Jev 审批简化方案实施记录（2026-10-13）

依据：`docs/jev-approval-simplification-plan-20261012.md`（方案）与 `docs/audit-jev-rectification-20261012.md`（审计，判定不通过：594/595）。本文记录第 1–4 步代码实施与验收状态。**不构成"全部修好"声明**：第 5 步（真实 Jev 评测）与部署未执行，见文末"未覆盖项"。

## 改动清单（按方案步骤）

### 第一步：修请求输入投影（审计 F：review-body ≠ execution-body）

`lib/src/decision/operation-context.js` 重写：

- 新增 `projectRequestForReview(request)`：headers 对→object（重复键 `, ` 连接）；bodyBase64 解码——UTF-8 可解→文本（无论 content-type 是否声明）；multipart→类型化 part 摘要（name/filename/类型/sha256/有界预览：文件 2048B、字段 8192B）；二进制→`binaryRepresentation`（sha256 + 512B base64 预览）；空 body→`''`。截断有显式标记，不再"丢或假装为空"。
- `buildOperationContext` 诊断摘要覆盖完整请求+args；operationId 无 callId 时用内容摘要（`req-<digest16>`），不再 `Date.now()`。
- `operationContextToJev(context, {taskType, scopeChecked, verifiedTestObjects})`：不再透传 arguments（§11 减重，请求投影已覆盖语义）；`scopeChecked` 只接受显式布尔，绝不从 scopeOrigin/goalTarget 字符串推导。

### 第二步：受控清单精确查询 + ETag 兜底 + 账号协助修复

- `lib/src/tools/index.js`：`src_account_assist` 走 `upsertUserTodo` 条件展开——title/detail 只在提供时更新（新建才有默认值回退），status 仅显式时更新。修复"只补备注把 done 重置回 pending""更新覆盖标题"。
- `src_account_assist`、`src_read_public_source` 加入 `host-integration.js` SRC_TOOLS（原 UNADAPTED 遗漏 → "未适配工具"空响应）。
- `lib/src/egress/broker.js`：无强 ETag 的新建受控对象（201 自动低影响流、同账号/范围/凭据版本）登记为 `weakOwnership:true`（etag undefined）；propose/ledger 校验对 undefined==undefined 仍成立；带 If-Match 的请求仍要求强 ETag 证明；首次 modify/delete 后 `available=false` 一次性语义不变（保守的对象复用处理，对应方案矩阵 15）。

### 第三步：合并有效决定，删除丢弃结果的重复调用

- `lib/src/egress/advisor.js` 重写：真实 `exec.name`（不再硬编码 egress_http）、`exec.callId` 入 operationId、`justification: plan.purpose`、`scopeChecked: true` 为可信执行事实（broker.propose 已 assertScopeCurrent）、verifiedTestObjects 透传。
- `browser-adapter.js` / `burp-request.js` / `file-tools.js`：删除 `try{await jevDecide}catch{}` 丢弃结果块（高风险不再被吞）。
- `lib/src.js` bash pre-execute：不再调 Jev、不再因 ALS 缺失 deny；保留 classify 遥测（`local-dangerous`/`observed-egress-decides`）；ask 模式本机破坏性命令→确定性 ask。**语义变化（有意）**：扫描器信号只遥测不问人；bash 网络动作决策唯一在出口边界（proxy claim → authorize → propose → broker.assess 用完整冻结请求）。
- `lib/src/bash-guard.js`：`bashDecisionInput`/`bashJevNeedsHuman` 随调用点删除（避免残留"预处理即授权"旧语义）。
- `lib/src/decision/jev-client.js`：scan-plan taskSpec 附带 task 上下文（工具/原理由/operationId），计划不再与动机脱节。

### 第四步：结果与续研

- `/src-todo` 持久化诚实：upsert await；写失败→`kind:'error'`（含错误原文，不向 agent 投递虚假完成，状态不变）；写成功但通知失败→`kind:'success'` 且文本分别报告"已持久化"与"通知 agent 失败"。
- 重复审批识别修复：旧 `RegExp("\b"+id+"\b")` 中 `\b` 是退格字符（匹配永不生效，反而拦掉合法待办）；改为动作意图（批准/审批/同意/放行/通过一下/approve）+ 独立 ID token（`(?<![\w-])approval-1(?![\w-])`，approval-10 不误伤）+ title/detail 同查 + `auth-session` 豁免。
- `lib/src/egress/public-lookup.js`：`src_read_public_source` 通道——仅 HTTPS/无端口/publicSourceHosts 白名单（可用 `DSH_SRC_PUBLIC_SOURCE_HOSTS` 增补）；GET+无 body+header 白名单（user-agent/accept/accept-language）；每会话 15 分钟 12 次预算；pinOrigin 地址钉扎；**响应体 2MiB 有界接收**（读方流本身有界，审计 §6）。

## 验收测试（全部离线）

| 文件 | 覆盖 |
|---|---|
| `tests/jev-wire-payload.test.mjs`（新，6） | 投影（JSON 重复键/multipart/二进制/空体）；凭证头可提取→脱敏；scopeChecked 显式位不推导；operationId 稳定+含 callId；advisor 线缆正文/工具名/justification；read/delete payload 必不同；scan-plan plan+task 同送；jev-client 全文送审+`<stored>` 脱敏+服务密钥不外发 |
| `tests/egress-public-lane.test.mjs`（新，3） | 通道判定（工具名+host+https）；约束在问人/网络前失败关闭；有界接收+钉扎管道 |
| `tests/src.integration.test.mjs`（+3） | 重复审批识别正反例/ID 边界/豁免；/src-todo 三态（成功/写失败/通知失败）；account_assist 语义 |
| `tests/laya-repair.test.mjs`（重写） | bash gate：本机破坏性→确定性 ask（jevCalls===0）；http-write 不再 pre-execute Jev、不重复问人 |

`npm test`：**607/607 通过**（基线 594/595）。

## 停止条件核查（方案 §9）

1. 同一操作两个不相关决定 → 不成立：唯一决策点在出口边界 broker.assess；wire 测试锁定 read/delete payload 差异。
2. high 在某入口被忽略 → 不成立：三个丢弃块已删；laya-repair/egress-onboarding 锁定高风险仍走 pending。
3. low 无法执行 → 不成立：egress-onboarding 低风险自动执行链路保持；broker weakOwnership 兜底无 ETag 场景。
4. review-body ≠ execution-body → 不成立：jev-wire-payload 断言最终 payload 与执行请求同源（canonicalRequest 冻结）。
5. 原危险批量删除样本自动执行 → 不成立：该样本（无受控对象、无 If-Match 证明）仍需人审；对照样本走自动。

## 未覆盖项（不随本次交付）

- **第 5 步真实 Jev 评测**：14 主样本+对照需真实 configured Jev 调用与固定 rubric，须在部署后单独执行；本轮仅 mock 线缆验收。
- **部署**：第一轮已交付并部署（commit `c86b6ae` → web/headless，web PID 71605，127.0.0.1:3080）；本轮（第二轮）改动需再次 `node scripts/deploy.mjs` 后生效。
- **push**：main 积压提交未推送（含本次）。
- `tools/index.js` 非 manager 回退路径（~1937 行）的 `scopeChecked:true` 为既有代码：该路径消费决策（httpDecisionPolicy）非丢弃，且不在 egress 门禁内，本次未动——如后续统一 scope 证明源需另行立项。
- 浏览器/真实目标端到端验证待用户。

## 第二轮：审计 2026-10-13 复核后续

输入：`docs/audit-latest-session-20261013.md`（只读复核 GreenCMS 会话，结论「有产出，但 Jev 自动放行/人工只处理高影响操作仍未落地」）+ 本轮只读取证（见 `docs/audit-latest-session-20261013-crosscheck.md`）。

关键取证修正两条审计判断：

1. 审计 §1「没有看到 Jev 风险调用证据」→ **观测缺口**：会话 jsonl 内层实证注册 POST 判定由 Jev 返回（`mode:"on"`、`fallback:false`、`write/high/pending`）；`advisor.js → jevDecide` 以前不写 telemetry（`emitLayaDecision` 只在 `lib/src/tools/index.js`），所以 `laya.decision` 里 `risk-grade` 恒为 0。修观测，不改 rubric。
2. 审计 §2「审批提示禁用导致方向停摆」→ **审批通道不可用**（子代理 delegation `policy:"never"`），不是目标负结果；`src_egress_prepare` 两次 `SRC_GATE_INVALID_SAFETY_READ` 是「把补材料写成唯一出路」的文案缺陷，不是安全校验过严。

### 改动清单

- `lib/src/egress/notifications.js`：新增 `APPROVAL_CHANNEL_ESCALATION`（子代理/委派上下文必须把 `approvalId` 交回父会话，不重发/不换工具/不改写原请求/不记成不可利用或耗尽）与 `pendingSingleRequestNotice()`（单笔冻结请求说明：用户可直接批准发送原请求一次；材料仅在确需时用 `src_egress_prepare` 补）。
- `lib/src/egress/manager.js`：
  - 新增 `describeReview()`，审批卡 `reason` 由裸 `执行前判定{...}` 改为人类可读前缀（`单次登录/注册验证`、`创建新的测试标记，不覆盖既有对象`、`业务数据写入，或对象归属不明`…）+ 摘要/判定原文 + `用途说明（模型自述，非归属证据）` + 明确选项（可直接批准 / 材料可选）。展示层，不参与授权。
  - `PENDING_OR_REJECTED.nextAction`：不再只说「补安全材料」；`safety-material-required` 分支改为「用户可直接批准冻结原请求；只有在确实需要时才补材料」；`human-impact-confirmation-required` 分支保留并追加升级说明。
- `lib/src.js`（系统提示「高危单笔」段）：改为「审批卡是单点挂起点，用户可直接放行冻结原请求（仅一次）」+ 子代理升级 `pendingApprovalId` + 不得因等待记成不可利用/耗尽。
- `lib/src/egress/task-tool.js`：`src_egress_prepare` 描述改为「可选」，说明不覆盖/删除既有对象时无需调用、子代理应交回父会话。
- `lib/src/egress/advisor.js`：`risk-grade`/`scan-plan` 判定补 telemetry 旁路（`emitLayaDecision`，含 effect/risk/objectClass/fallback/latency/`verifiedTestObjectCount`，**不含请求内容或凭据**；失败不影响判定，判定值原样透传）。开关用 `DSH_SRC_LAYA_DECISION`（off=静默）——部署 web/headless 默认 `on`，测试进程默认 `off`，避免单测写入真实 `~/.dsh` 遥测污染事后审计。
- `lib/src/tools/index.js`：
  - `approvalTodoMentions` 升级为「行对象」匹配（ID token / 审批单 URL / `targetUrl`）并新增 `approvalTodoDuplicatesPending`：不写 ID 但明确指向待审队列的「是否批准…（共 N 个待审请求）」也拦（这是复核会话里真实出现过的复制审批）。
  - `src_record_research`：`status=false-positive` 且文本/证据引用仍 pending 的 `approval-N` → 拒绝，提示改记 `blocked`（待审≠证伪）。

### 验收测试（新增 7 条，全部离线）

| 文件 | 覆盖 |
|---|---|
| `tests/jev-approval-escalation.test.mjs`（新，4） | 升级文案（approvalId/父会话/不可利用）；单笔写入待审：错误与审批卡都带 approvalId + 可直接批准 + 人类可读描述 + 零发包；影响未定待审不逼补材料；危险误放策略矩阵（批量/无归属删除、归属不明写入不自动；残余只读分类路径**显式记录未消除**）+ 样本文件仍在 |
| `tests/jev-wire-payload.test.mjs`（+1） | broker 判定补 telemetry：risk-grade/scan-plan 可归因、判定值透传、无正文泄露 |
| `tests/src.integration.test.mjs`（+2） | 待审队列复制待办被拦（独立工作项不误伤）；引用 pending ID 的 false-positive 被拒、改 blocked 成功、普通 false-positive 不受影响 |

`npm test`：**614/614 通过**（第二轮前 607）。

### 本轮未做（需用户决策 / 属人工判断）

- 审计最小任务⑤（隔离靶场 + 可用人工审批通道实测一次注册正例）：高影响操作，需用户提供靶场；AI 不自行对真实目标执行。
- 最小任务③的**写操作**（finding 定级/去重修改）：已出只读核对报告与建议（crosscheck 文档），未改域数据。
- "新建测试对象/测试账号注册可自动放行" 属授权扩张（改 rubric 或 objectClass 分类），未擅动；`write+new-test-file+POST` 与 "只读分类 + 非 PUT/PATCH/DELETE 正文" 两条残余自动路径已在测试中显式记录。
- 第 5 步真实 Jev 评测（14 主样本 + 对照）仍未执行。
