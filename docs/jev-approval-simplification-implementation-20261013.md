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

## 第三轮：用户三点诉求（范围/资产收集/闸门口径）2026-10-14

用户原话要点：① 去掉开局的「测试范围审批」卡；② 范围限制阻碍资产收集（顺丰这类**多个主域**没法展开）；③ 审批闸只应用于「防 AI 删库 / 删其他用户数据 / 影响线上业务 / 影响其他用户」，读取、枚举、探测应放行。

### 改动清单

- `lib/src/egress/user-scope.js`（范围播种语义重写）：
  - 新增 `declaredTargets(text)`：按**行**（首行是目标清单表头时后续行也算）解析，行再按 `，,、;；` 切成子句；只保留含目标句标志（针对/目标/资产/范围/攻击面/测试/扫描/审计/target/scope/test/scan/audit）的行；含排除语气（不要/无需/禁止/排除/不含/不再/撤回/停止/暂停/取消…）的**子句**整段丢弃。
  - URL → 精确 origin（保留原「不猜注册域」语义）；`*.域` → 整域；**裸域 → 默认 http/https 两个 origin + 该域整域**（用户写下域名即声明域空间；此前只给两个 origin，是“资产收集被挡”的直接原因）。
  - 多目标不再退回问人：一份人类任务里写出多个主域/通配域/URL，逐个授权（上限 256，超限视为不可用）。带凭据 URL 仍整份作废。
  - 授权来源边界不变：只吃 `role==='user' && source.kind==='user' && source.rpcId` 的**人类原始消息**；模型文本/工具输出/合成回注/子会话一律不授予。撤回检查改为「该消息没有声明目标且含撤回语气 → 不回吃更早目标」；同一消息里既声明又排除时，以该消息声明的目标为准（排除子句已在解析时剔除）。
- `lib/src/public-source.js`：`DEFAULT_HOSTS` 扩为公开只读侦察源（`crt.sh`、`api.certspotter.com`、`app.agniops.in`、`api.fofa.info`、`dns.google`、`cloudflare-dns.com`、`grep.app`、`searchcode.com`、`web.archive.org`、搜索引擎、`api.github.com`），去掉重复 `github.com`。
- `lib/src/egress/public-lookup.js`：`web_fetch` 并入公开资料通道（`isPublicLookup` 接受 `src_read_public_source|web_fetch`）；仍是 HTTPS、无端口、白名单 host、GET、无 body，响应走 `boundedBody`（≥2MB 截断）。`bash`/`curl` 不进该通道。
- `lib/src/egress/plan.js`：`requiresHuman` 的编码歧义硬闸（裸 `%`/二次编码）**只对非幂等方法（POST/PUT/PATCH/DELETE…）生效**，`GET/HEAD/OPTIONS` 豁免（审计 approval-4：`GET ...&info=1%` 被本地误挂人工闸）。方法/路由改写头（`x-http-method-override`/`x-original-url`/`x-rewrite-url` 等）仍是硬闸；`assertScanExecutable` 去掉已失效的二次 `requiresHuman` 检查。
- `lib/src/egress/scope-requests.js`：范围卡降级为**兜底**（只在“完全没有任何已声明目标”时出现），文案改为给出两条出路（直接在对话里写目标域 / 确认本卡列出的精确 origins，且明确说明批卡不授予整域）。

### 语义边界（本轮明确保留，未放宽）

- 写操作闸不动：注册/登录/写入仍需 Jev 判定 + 人工批准；`allowsLowImpact` 未放宽；Jev rubric / objectClass 分类未改（“创建型对象可自动放行”仍待用户拍板）。
- 不自动把 SCOPE 卡升级为整域授权（共享托管的第三方 SaaS 域会连带授权其他租户）。整域授权只走两条路：用户显式写域名/`*.域名`，或 `src_request_asset_confirm` 归属确认（用户点击 → `confirmDomain('allow')`）。
- 不做“任意公网 GET 自动放行”：GET 同样可打 XSS/注入（审计 approval-5/6），只把**公开只读索引/元数据源**纳入公共资料通道。

### 验收测试（`npm test` 617/617）

| 文件 | 覆盖 |
|---|---|
| `tests/egress-onboarding.test.mjs` | 新增「多域声明一次到位」端到端：`*.fixture.test` + URL 播种后域内子域发现直接发（0 审批行、1 次发包、DNS 固定）；域外 → `SRC_GATE_OUT_OF_SCOPE` 不挂卡。多目标/裸域+整域/混合形态/列表写法/邮箱不误判的 `explicitUserScope` 断言；排除子句、凭据 URL、无目标句闲聊、引用/示例/撤回仍不授权 |
| `tests/egress-gate.test.mjs` | 编码歧义硬闸按方法矩阵断言（GET/HEAD/OPTIONS 放行、POST/PUT/PATCH/DELETE 拦、改写头对读方法仍拦）；原编码补材料用例改为 POST |
| `tests/egress-public-lane.test.mjs` | 侦察源（crt.sh/certspotter/agniops/fofa/DoH/archive/grep.app）在 `src_read_public_source` 与 `web_fetch` 下均入通道；名单外 `web_fetch`、`bash` 不入通道 |
