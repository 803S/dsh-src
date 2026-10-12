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
- **部署**：web profile 未重启（`local.*` 流程照旧另行执行）。
- **push**：main 积压提交未推送（含本次）。
- `tools/index.js` 非 manager 回退路径（~1937 行）的 `scopeChecked:true` 为既有代码：该路径消费决策（httpDecisionPolicy）非丢弃，且不在 egress 门禁内，本次未动——如后续统一 scope 证明源需另行立项。
- 浏览器/真实目标端到端验证待用户。
