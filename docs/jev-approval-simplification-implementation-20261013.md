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

## 2026-10-14 第二轮：本地硬规则先行（read-clear / hard-boundary / needs-judgement 三分）

用户指令：「很多无实际危害的数据包被挂审批了……先是规则挂卡，然后命中的 jev 决策，jev 决策不了或者
决策确实是影响业务或者其他用户数据的高危操作再挂审批，决策无危害的正常测试需求自动放行」。
落地 commit `c6f72bd`（上一轮 `b05dc05`），`npm test` 623/623，web 已重启（PID 68204）。

### 三类判定（`lib/src/security.js` `classifyHttpRequest` → `verdict`）

| verdict | 触发 | 处置 | 是否调用判定服务 |
|---|---|---|---|
| `read-clear` | 读方法（GET/HEAD/OPTIONS）+ 路径/查询无任何可疑语义词、无方法改写头/主机名代理头、无残留百分号转义 | 直接放行、不建卡 | **否**（判定服务不可用也不影响） |
| `hard-boundary` | 删除/破坏类路径词（`delete|drop|destroy|reset|wipe|purge|revoke|unbind…`）、`DELETE` 方法、方法改写头（`x-http-method-override` 等，或代理头值里塞主机名） | 本地终审挂人工，判定服务无权覆盖（仍会调用它，仅为说明与执行通道判定） | 是（只取分类） |
| `needs-judgement` | 读方法命中可疑语义词、写方法、编码歧义/嵌套转义 | 交判定服务：低风险且范围已核对 → 自动放行；判不了/业务数据/归属不明 → 挂人工 | 是 |

要点：词匹配按 token 相等（驼峰切词），不做子串语义近似；body 不作本地语义证据（只扫 path+query）；
代理头只在值是纯 IP/端口列表时豁免。read-clear 的收窄只朝更保守方向（多送判定服务），不需要用户拍板。

### 诊断字段（审计清单⑤）

- 计划卡 `review`：`authority`（`hard-boundary|hard-rules|jev-low-risk|jev-unavailable|human-required|legacy-rules`）、
  `errorType`、`mode`、`hardVeto`、`effect`、`risk`、`objectClass`，纯展示/审计，不被任何放行逻辑反读。
- 工具车道证据/卡片 `layaAdvice.authority`、放行证据 `decisionAuthority` 同源。

### 部署副本实测（两类车道，全在部署副本上跑，目标为本地 stub）

`src_http` 车道（11 类请求；「判定服务=N」为实际调用 stub 的次数）：

| 请求 | 去往 | 判定服务 | 到达目标 | authority |
|---|---|---|---|---|
| 明确只读 `GET /api/v1/users/list` | 放行 | 0 | 1 | hard-rules |
| 明确只读 `GET /api/v1/preset/config` | 放行 | 0 | 1 | hard-rules |
| 明确只读 `GET /api/v1/users/list`（**判定服务 500**） | 放行 | 0 | 1 | hard-rules |
| 可疑读 `GET /api/v1/sms/sentVerificationCode?phoneNumber=1` | 放行 | 1 | 1 | jev-low-risk |
| 编码歧义 `GET /api/v1/info?info=1%` | 放行 | 1 | 1 | jev-low-risk |
| 疑似影响 `GET /api/v1/disable-preview`（判定服务判业务写入） | 挂起 | 1 | 0 | human-required |
| 确定危害 `GET /api/v1/deleteUser`（判定服务仍判读取） | 挂起 | 1 | 0 | hard-boundary |
| 确定危害 `DELETE /api/v1/items/3` | 挂起 | 1 | 0 | hard-boundary |
| 方法改写头 `GET /catalog` + `x-http-method-override: DELETE` | 挂起 | 1 | 0 | hard-boundary |
| 写方法 `POST /api/v1/orders`（判定服务判新建测试文件） | 放行 | 1 | 1 | jev-low-risk |
| 写方法 `POST /api/v1/orders`（判定服务判业务数据） | 挂起 | 1 | 0 | human-required |

出口网关车道（scope=`http://127.0.0.1:49123`）：域内明确只读放行（判定服务 0 次）／**域外只读放行**（未被范围挡）／
域外写 → `SRC_GATE_OUT_OF_SCOPE`（不调判定服务）／本机未授权端口 → `SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED`
（既有防页面诱导本机请求的护栏，与范围闸无关）／确定危害三类 → 挂起、零发送／判定服务不可用 → 挂起且
`authority=jev-unavailable`、`fallback:true`。

计划车道复跑被审会话的真实历史卡（approval-4 的条目
`GET …/index.php?s=/Home/Archive/single&info=1%`，旧本地硬闸误挂人工）：现在 1 次判定服务调用 + 发包 + **零卡**；
`GET …/config/connect.php` 明确只读，0 次判定服务调用 + 发包。

### 存量卡与残余风险

- `~/.dsh/storages/src-sessions.db` 里 70 张历史卡不会自动消失（不改历史数据）：其中 46 张仍 pending。
  按新规则复算：读方法 1 张（`GET /account/reset_passwd` → 确定危害）、其余 67 张是写方法/TASK（交判定服务，
  本就不是“无危害的读取被误挂”）。是否批量拒绝这 46 张需要用户明确授权。
- 未做：审计清单⑤（隔离靶场实测注册正例，需用户提供靶场且人工审批通道可用）、真判定服务对新路由的
  留出集评测（会消耗真实额度，需用户先批预算）、浏览器端到端。

---

## 附录 B：用户现场 6 条投诉的根因与修复（2026-10-14）

被审会话 `session-1a45c794`（`src-domain-ready`）实测 + 只读复算得到的现场证据，以及逐条落地。全部改动
**只在“故障/夹具/展示”层面**：没有放宽任何安全边界，没有改动 Jev rubric / objectClass，没有批量改历史数据。

| # | 用户看到的现象 | 实证根因 | 修复（文件） |
|---|---|---|---|
| ① | 同一动作「弹窗审批完又挂个待办」 | 批准动作有两套面：宿主原生一次性批准（全会话只有 1 次 `approval/asked`：`src_serve_proof`）+ 面板审批卡；此外 agent 还会用**换种说法**的待办复述同一件事（现场 `userTodo-1`「请确认目标出口范围（当前 POST 被范围匹配拒绝），以放行后台认证面测试」），既不写审批 ID 也不写“待审”，旧去重规则漏过 | `src_user_todo` 去重补第三种形态：`approvalTodoDuplicatesSurface`（范围/批准意图 + 文本点名的主机 ↔ pending 卡主机；或存在 pending `method=SCOPE` 的范围确认卡时，“确认范围/授权”类待办一律拦；无主机时按文本点名的 HTTP 方法 ↔ 待审方法）。`kind=auth-session` 与其它工作项仍可建（`lib/src/tools/index.js`） |
| ② | Burp 通道被闸拦（`SRC_GATE_HOST_MISMATCH`） | 我方 `burp-request.js` 要求 `Host` 里出现端口，而现场报文是 `Host: eci-…`（浏览器/工具本来就不写默认端口），`targetPort:80` | `hostHeaderMatches(value,{hostname,targetPort})`：主机名必须全等；端口**可省略**，给了就必须等于目标端口（`lib/src/egress/burp-request.js`）。宿主侧代理出口本身不在本仓库，见回复中的说明 |
| ③ | 一次挂 20+ 审批，包含只读请求 | 判定服务 token 失效（见 ⑥）叠加 `SUSPICIOUS_WORDS` 把**静态路径里的名词**当可疑语义（`/Public/share/…`、`/Upload/`、`/Data/install.lock`），一抖就整屏挂卡 | `SUSPICIOUS_WORDS` 只留动作/外发/费用语义；新增静态资源快通道（read 方法 + 后缀命中 + query 干净 + 无编码歧义 → `read-clear`，不调判定服务）（`lib/src/security.js`） |
| ④ | `tested endpoint 缺少相同方法和路径的真实 observation` | `computeCoverage` 用含 query 的原始 URL 当 key，而记录时已剥 query → 同一条真实观察匹配不上；报错也没说怎么办 | `endpointKey` 统一剥 query/fragment；报错文案给出三种可行动原因（被闸拦就记 `blocked`；走了 Burp 未落 observation 就补 `src_record_observation`；方法不同）（`lib/src/endpoint-manifest.js`） |
| ⑤ | 宿主拦本机局域网 IP（`SRC_GATE_NON_PUBLIC_TARGET`） | `src_serve_proof` 的回连 URL 是本机 LAN IP + 随机端口，`pinOrigin` 因私网地址拒绝；同时现场还有 `请求 origin=https://…com` vs `授权 origins=https://…com:80` 的误拦 | ① 新增本机托管登记表 `lib/src/egress/local-serve.js`（精确 origin、TTL、**永不写入持久化 scope**），`src_serve_proof` 监听成功后登记、关闭即注销；② `originGranted` 承认同主机默认端口（`https://h:80 ≡ https://h`，非 80/443 一律不放）（`lib/src/egress/plan.js`、`target-context.js`、`manager.js`、`lib/src.js`） |
| ⑥ | 「一点网络波动都不能有吗」——判定服务 401 一瞬 → 20+ 只读请求被挂 | `~/.dsh/settings/src-decision.json` 的 apiKey 已失效：34 条 `laya.decision` 全是 `fb=true`（28× `http-401`）。旧行为把**基础设施故障**当成**每笔请求的安全结论**，逐请求铸 `egress/task` 卡（32 张僵尸卡就是这么来的） | ① 新增 `lib/src/decision/service-outage.js`：401/403/5xx/网络/超时/未配置/取消/熔断 → **不铸任何按请求审批卡**，改抛可重试 `SRC_GATE_DECISION_UNAVAILABLE` + 每会话至多一条去重待办；本地确定危害（`hardVeto`）仍照常挂卡。② `jev-client` 有界重试：网络/超时/5xx/JSON 抖动重试一次（300ms）；401/403 不重试；认证失败即熔断 120s、瞬态连续 3 次 30s、成功即复位，熔断期间不打网络且一律返回同一中性结论（**不放行任何东西**）。③ 429 不重试（重试只是加压），但计入熔断 |

**语义类失败不变**：`schema`/非法答案仍按原设计挂人工审批——那是「服务判不了这笔请求」，不是「服务坏了」。

### 验证

- `npm test`：**628/628 通过**（新增：静态资源快通道 1 项、判定服务故障不铸卡 1 项、本机托管 origin 1 项、
  Host 校验 1 项、Jev 重试/熔断口径重写 1 项、待办重复审批第三形态并入既有测试）。
- 部署副本实测 `/tmp/r10-live.mjs`（跑 `~/.dsh/profiles/web` 里的副本，本机 stub，**27 项全过**）：
  静态资源 5 例放行（判定服务 0 次）、`/delete.php` 仍终审；401 → `SRC_GATE_DECISION_UNAVAILABLE`（可重试、
  0 张卡、1 条去重待办、二次故障不新增）；503 抖动重试恰一次且结论与健康服务一致；Burp 无端口 Host 5 例；
  `:80` 等价 4 例；托管 origin 回连 7 例（含「未登记私网端口仍拦」）；换说法复述审批被拒 + 账号类待办仍可建。
- 部署：`node scripts/deploy.mjs`（EXIT=0，内含 628 测试硬门）+ `bash scripts/start-dsh-web.sh`（PID 89799，
  `management.html -> 200`，日志 0 error），副本文件 md5 与仓库一致。

### 本轮仍未做（需要用户拍板或环境）

- `~/.dsh/settings/src-decision.json` 的 **apiKey 已失效**，必须用户更换（不是网络波动）；换 key 前所有
  需要判定的请求都会走「判定服务不可用」通道。
- 存量 32 张 `判定服务不可用` 僵尸卡 + 46 张历史 pending 卡：**不擅自清理**，待用户授权。
- `src_serve_proof` 的宿主原生弹窗是否合并进面板审批（唯一不可事后回滚的动作）：待用户拍板。
- 审计清单⑤（隔离靶场实测注册正例）、真判定服务留出集评测（需预算）、浏览器端到端。

---

## 附录 C：实时面板数据源改走 store 权威态（2026-10-17）

**触发**：面板「实时数据」原先由插件往会话日志里**伪造 `tool/call` 行**、再由本插件自己的投影 fold 出来。这条路
既污染会话日志（历史会话里出现宿主从没发起过的工具调用），又依赖宿主日志写入时机，0.1/0.2 行为还不一致。

**本轮改造**：live 数据只走 `ctx.sessionProjections.drive(...)`，内容取自 store 的**权威全量快照**；日志一个字节都不写。

| 问题 | 实证根因 | 修复（文件） |
|---|---|---|
| live 数据靠伪造日志行 | 插件 `appendSessionToolEvent` 自己 `session.append` 一条 `tool/call` | 只保留白名单校验 + 驱动投影，**永不 append**；面板数据改由 driver 送 `drive`（`lib/src.js`） |
| 0.1 冷读整段重放被拒 | poke 用 `seq = session.seq` 时，checkpoint 行落在日志水位**之外**，0.1 `restore` 判定 `row.seq` 超出 `endSeq` → 抛 `cannot restore from seq 2` | 0.1 用 `Math.max(cursor - 1, 0)`、0.2 用 `cursor`；判别器 `typeof projectionRegistry?.cachedSnapshot === "function"`（0.2 有 `SessionProjectionCache`）（`lib/src.js`） |
| 0.2 丢增量/跨 seq 抛错 | 0.2 `drive` 对 `cell.observedSeq >= event.seq` 直接 `continue`，`advanceCell` 遇缺口抛 `cannot advance across missing seq`，且 `observedSeq` 初始化 `-1` | poke 必须是**完整快照**（不是增量），且 seq 严格递增、不跨缺口（`lib/src.js`） |
| 改基础设施配置后面板停在旧值 | `infra` 不在 `committed-state.js` 的 `projectionTables` 里，提交包装看不到它 | 抽出 `publishAuthoritative(sessionId)`；`setInfra` 写入/清空各调一次；提交包装统一走它（`lib/src/store.js`） |
| **宿主出现幽灵「工具执行中」** | poke 借用 `tool/call` 时，宿主自有投影 `sessionStats` 把它当**真实工具调用**登记：`pendingCalls["src-live-…"] = 时间戳`，而永远不会有对应 result；0.2 hydrate 冷启动还会把它恢复出来 | poke 改用**插件专用事件类型** `src_authoritative_state`（`data` = 快照）。自定义类型不在宿主事件词典内，宿主投影一律忽略；`applySrcEvent` 顶部新增该分支，旧日志里的历史 `tool/call` 合成行保留 fold 分支以兼容（`lib/src.js`） |
| 投影在 `apply` 里读不到权威态 | `apply`/`view` 是同步的，而 `store.domain()` 是异步的 | store 记录已解析句柄 `openedDomain` + 每会话 `commitDepths`，抽出同步内核 `sessionDataFrom` / `domainNotesFrom`；domain 未开时**保持现状、不猜测**（`lib/src/store.js`） |
| 真实 registry 找不到 cell | 真 registry 的 cell 是 `WeakMap`，按**会话对象身份**索引，不只是 session id | driver 用 canonical session：`store.ctx?.sessions?.get?.(sessionId) ?? session`（`lib/src.js`） |

### 验证

- `npm test`：**634/634 通过**，0 失败（`tests/src.integration.test.mjs` 单文件 237/237）。
  - 测试护栏新增第二份**宿主替身投影** `hostStats`（只在 `event.type === "tool/call"` 时记账），直接守
    「poke 不得被宿主当成真实工具调用」这一不变量；并新增 `[local.105] poke 不进日志、也不被宿主投影当成一次真实工具调用`。
  - poke 断言由「必须带真实 callId」改为新形态：`type === "src_authoritative_state"`、`data.callId === void 0`、
    `typeof data.view === "object"`、审批决策 `allow`/`reject`。
- **0.1 运行时**（真实 `dsh-session-projection` 0.1 registry + 宿主替身投影，`/tmp/v135-01-proj.mjs` 全绿）：
  日志自造行 **0**；checkpoint 行 `{"src":{"ver":17,"seq":1,…testPhone:"13800138000"}}`；`restore` 冷读恢复权威数据
  （即附录所述抛错路径）；增量后面板 infra 拿到新值；**宿主自有投影只看到 1 条真实 `tool/call`（`src_http`），
  poke 三次 drive 一条都没被记账**。
- **0.2 运行时**（真实桌面 App 副本，`/tmp/probe13`，端口 3218）：
  - 写入路径：UI 发 `/src-infra testPhone …` → store WAL 有值；`session_projcache` 快照 `src.ver=17`、`seq=30`、
    `infra.testPhone=13900003333`、`sessionStats.pendingCalls = {}`（**无幽灵**）、所有宿主行 seq 一致；会话日志
    `session.v4.jsonl.zstd` 只有 header 行、**0 条伪造行**。
  - 端到端（`/tmp/v135-02-e2e.mjs`）：新会话 + SRC 专业模式 + 正常对话（「收到。」）+ `/src-infra` 回执
    「已保存 testPhone=…」+ 面板出现 对话/轨迹/**SRC** 页签。
  - 冷读：重启 App 副本 → 打开会话 → 点 `[data-testid="src-tab-infra"]` → 输入框值即 store 真值
    （`13900003333`）；无 pageerror / console.error。
- 部署：`node scripts/deploy.mjs` EXIT=0（内含 634 测试硬门），同步到 `~/.dsh/profiles/{web,headless}` 的副本
  130 个核心文件 + 12 条内置经验；重新 `npm pack` → `lihua_dis-dsh-src-0.1.0-local.135.tgz`，解包校验
  `lib/src.js`、`lib/src/store.js`、`package.json` 与仓库 hash 一致。
- `stateVersion` 保持 **17**（用户已允许旧数据丢失，不触发存量重算）；历史会话**未改写**。

### 本轮未做 / 已知限制

- **0.1 浏览器端 UI 端到端未取到**：0.1 的 0.1.0 `dsh web` 客户端在全新浏览器 profile 下，输入区的
  「选择工作区」一直是 `readonly` + `data-phase="inert"` 状态（下拉菜单能开、能选中工作区，输入区仍不激活），
  因此无法从 UI 发消息/命令；这是该客户端**既有的**工作区绑定问题，与本轮改动无关。作为补偿，0.1 侧的接受
  证据用的是真实 0.1 投影库 + 真实插件代码的组件级探针（含 `restore` 冷读这条原先会抛错的路径）。
  另：0.1 的 `POST /api/commands/execute`（RPC 信封 `{type:"client-request",rpcId,method:"commands/execute",
  payload:{args:{agentId,line,images}}}`）能返回 `ok:true`，但用于验证的会话是 `standard` 预设、不在 SRC 域内，
  故未产生 SRC 写入（不构成反例，仅说明该路径未覆盖）。
- 探针数据只写在 `/tmp/probe13`、`/tmp/probe16`，未触碰真实 `~/.dsh`；用户正在运行的真实 App 全程未被重启或干扰。
