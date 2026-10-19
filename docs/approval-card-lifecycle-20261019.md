# 审批卡生命周期：无输入只读豁免、陈旧卡 TTL、语义去重键（local.150，2026-10-19）

用户判据（唯一一条，本次落成代码）：

> **只有「可能影响线上运行环境 / 业务正常运行 / 真实用户」的事才需要人来裁决。**
> 模型没申报用途是**调用方的缺陷**，不该转嫁成用户的一张待办。

本文记录这条判据落成代码的三处改动（⑩ 无输入只读、⑪ 陈旧卡 TTL、⑬ 语义去重键）、
现场证据，以及**没有**被放宽的边界。

---

## 0. 现场：为什么会有「又挂 6 个待审核」

2026-10-18 22:4x 起桌面 App（跑 `0.1.0-local.142`）挂出 6 张人工卡，整夜无人处理。逐张取出真身
（`~/.dsh/storages/src-sessions.db` → `u_src_pending_approvals`，副本 `/tmp/s3.db`；账本
`~/.dsh/control/src-egress/ledger.sqlite`，`gate_tasks`）：

| # | 报文 | 当时判成 | 现在（local.150）会怎样 |
|---|---|---|---|
| 1 | `GET /users/reset/1` | 本地硬边界（`reset` 命中强删改词、末段是 id → 交判定服务，App 是 142 版仍本地终审） | 判定服务 allow → **自动放行** |
| 2 | 同 URL 无 cookie | 同上 | 同上 |
| 3 | `GET /users/2/reset` | 同上 | 仍挂（见 §1 ⑨ 保留项） |
| 4 | `POST /users/reset/1` | 写方法，挂人工 | 仍挂（写方法不在豁免范围） |
| 5 | `OPTIONS /users`（CORS 预检） | 146 已修（预检协议头不算方法改写） | **直接放行** |
| 6/7 | `GET /extra/create` | 判定服务 `unknown` → 转人工 | **发出 + 记账 + 标注调用方缺陷** |

离线复放（`/tmp/card-replay.mjs`，走 `bodyBase64`）在**当前代码**下：6 张里只剩 `GET /users/2/reset`、
`POST /users/reset/1`、`GET /extra/create` 三笔还会挂 —— 且 `GET /extra/create` 现在挂的是
「判定服务没答案」这一既有语义（下方 §1 ⑩ 只覆盖本地可证事实的那一层）。

三处根因（各自独立，本次各给一条改动）：

1. **无输入只读报文被判 `unknown` 后转人工**：`GET /extra/create` 与浏览器加载表单页逐字节相同，
   判定服务给不出形态答案，于是变成用户的待办。
2. **host 车道人工卡永不过期**：账本里这批卡的 `manifest.expiresAt = null`（只设了 `lifetimeMs`），
   没人决定就永远躺在待办列表里。
3. **去重键是任务号**：旧键 `src-egress://<taskId>` 每任务唯一 → 同一笔请求重复提案**永不命中**，
   每重试一次就可能多一张卡（现场 32 张僵尸卡、10-18 的 6 张都是这么来的）。

---

## 1. ⑩ 无输入只读 = 本地事实（不占人工，但**不能覆盖否定结论**）

判据（`lib/src/security.js` `impactFreeRead({method,url,headers,body,bodyBase64})`）：

**无输入**（结构上只有一个含义：读方法 ∧ 无正文 —— `GET`/`HEAD` 带正文在计划校验层就被
`SRC_GATE_READ_BODY` 拒掉 ∧ 无查询串 ∧ 路径里没有数字型资源 id）
**∧ 报文里没有「影响类」语义词**（`SUSPICIOUS_WORDS` 减去 `CONSTRUCTION_WORDS`：`verify`/`confirm`/
`approve`/`submit`/`lock`/`enable`/`send`/`pay` 仍算有影响；`create`/`update`/`edit`/`modify`/`save`/
`generate` 只描述「造东西」，不构成影响）
**∧ 不命中本地硬边界。**

理由：这种报文与浏览器加载一个表单页逐字节相同。如果它真是状态变更端点，那每次浏览都在改状态，
人工审批也定不出结论 —— 那就不该把它变成人的工作。**判定服务的否定结论仍然有效**：
`action:reject` / `risk:high` / `effect ∈ IMPACT_DENYING_EFFECTS`（`write`/`external`/`destructive`）
一律照常挂卡；`unknown`/`pending`/`fallback`（含「模型没申报用途」）才走豁免，并**记账 + 标注调用方缺陷**。

接线（三车道一处判据）：

- `lib/src/decision/http-policy.js`（`src_http`）新增 `jevDenies` + `context.impactFree` 分支 →
  `{require:false, category:'无输入只读（本地事实）', authority:'read-suspicion-auto'}`；
- `lib/src/egress/broker.js`（计划车道）`impactFree && !jevDenies` → `automatic`；
- host 车道 `lib/src.js` + `lib/src/tools/index.js` 注入同一判据；`src_egress_plan` 的诊断里给出 `adviceAuthority`；
- `lib/src/egress/decision-policy.js` 的 `reviewSummary` authority 白名单加 `read-suspicion-auto`。

**⑨ 保留项（不豁免）**：`GET /users/{id}/reset` 这类「末段强删改词 + 数字资源 id」的路径中段表单页
在发出前无法与「真的重置真实用户密码」的 GET 型端点区分 → 属「可能影响真实用户」，继续挂人工；
要有应用级证据（源码/路由文档证明它是表单页）才改判。

### 判定服务的分类只能在 `effect-policy.js` 定义

`lib/src/decision/effect-policy.js` 给 `write`/`external`/`destructive` 加 `impactDenies: true` 列并导出
`IMPACT_DENYING_EFFECTS`，三个消费点（`http-policy.js`、`egress/broker.js`、`tools/index.js`）一律引用它。
**不能写成 `!impactFree`**：`unknown` 也不是 impactFree，但「服务没答案」不等于「否定答案」。

---

## 2. ⑪ 陈旧人工卡 TTL：只改状态，绝不自动发送

`lib/src/egress/manager.js`：

- `expireStaleApprovals(session)`：只收 `status==='pending' && !row.executionState`（**从未被动过**）且
  `now - createdAt >= ttl` 的卡；置 `status:'expired'` + 说明「自动过期／从未发出」；撤销账本任务
  （`broker.commandPlane.revoke`）；**行保留在库中**作为「从未发出的证据」；TTL 由
  `DSH_SRC_PENDING_APPROVAL_TTL_MS` 控制（默认 24h，`0` 关闭清扫）。
- `reapStaleApprovals()`：对所有会话跑一遍，`lib/src-egress.js` 的 `ready()` 启动时调用（失败只记日志）。
- `publishPendingRow` 开头也顺带清扫本会话，避免「用着用着列表又长出僵尸」。
- 域 schema 版本 `17 → 18`（`srcPendingApprovalSchema.status` 枚举加 `expired`；旧行由 zod default 补齐，
  无需改写行数据）；`lib/storage-sqlite.js` 迁移注释补 v18 行；UI 一律按 `status==='pending'` 过滤 →
  `expired` 行自动从面板消失。

这是**生命周期/UX 改动，不是放宽门槛**：没有任何一笔请求因为过期而被发出。

---

## 3. ⑬ 去重键 = 语义请求身份（凭据不同不合并）

新文件 `lib/src/egress/approval-identity.js`：

- `NON_IDENTITY_HEADERS`：**不参与身份**的客户端口味/追踪头（`user-agent`、`accept`、`accept-encoding`、
  `referer`、`origin`、`x-trace-id`、`x-request-id`、`traceparent`、`tracestate`）。
  **账本 `operation` 身份（`egress/broker.js`）与审批卡去重共用这一份名单** —— 免得账本认两笔而卡片合并成一张，
  冒出「卡片显示 A、实际执行 B」。
- `requestIdentity(request)`：方法 + URL + 正文 + 头（去掉上面那批；其余头取 `名=值摘要` 比较，含凭据与
  `content-type`/CSRF）。**凭据不同即不同身份**（有无 cookie 是两笔影响面不同的请求）。摘要只在内存里用于比较，
  不落库、不外发（卡片正文仍按用户要求展示原始冻结报文）。
- `planIdentity(entries)` / `cardIdentity(bodyText)`：从新提案的呈现、或既有卡行正文反算同一套身份；
  解析失败一律返回 `null`（**宁可不合并**）。
- `manager.publishPendingRow(session,task,input,burp,dedupe=true)`：同身份的 `status==='pending'` 旧卡 →
  `reusedRow()` 复用（把行重指到**本次任务**并撤销旧任务，避免用户批准的是一笔不存在的任务）；
  绑定与 `pending.set` 对新建/复用一视同仁（否则批准会执行旧冻结报文）。
  `preparePending`（补材料）显式走 `{dedupe:false}` —— 那是「替换这张卡」，不是「重复提案」。
- 与 step25 同源：**客户端口味头不是请求身份**。旧键 `src-egress://<taskId>` 因此永不命中。

---

## 4. 测试与验收

| 面 | 用例 |
|---|---|
| 身份判据 | `tests/egress-approval-identity.test.mjs`（偏好头不参与、凭据/正文/方法/URL 参与、不可解析返回 null、多笔计划顺序敏感） |
| 无输入只读 | `tests/jev-policy.test.mjs:68`（说不清四态 → 豁免并标 `read-suspicion-auto`；否决态/带输入/语义词 → 照挂；hardBoundary 优先）；`tests/egress-gate.test.mjs:1022`（端到端：`GET /extra/create` 真能派发、带查询串或写语义仍 `pending`） |
| 陈旧卡 TTL | `tests/jev-approval-escalation.test.mjs`（老化 2h 收掉、未超时不动、`note` 含「自动过期/从未发出」、`f.sent.length===0`、行仍在库、`reapStaleApprovals()` 返回受影响会话、TTL=0 关闭） |
| 去重复用 | `tests/egress-burp-passive.test.mjs`（偏好头不制造重复卡、凭据不同两张卡、**卡片与线上报文逐字节一致**）；`tests/jev-approval-escalation.test.mjs`（孤儿卡：任务已不在账本时同身份提案回收复用） |
| 域版本 | `tests/quality-contracts.test.mjs`（`srcDomainSpec.version === 18`） |

- 全量 `npm test`：**696/696 pass**（`tests/egress-approval-identity.test.mjs` 已并入 `npm test` 清单）。
- `node scripts/check-source-hygiene.mjs` 通过。
- 版本 `0.1.0-local.150`；`npm pack` → `~/Downloads/dsh-plugins/lihua_dis-dsh-src-0.1.0-local.150.tgz`；
  `node scripts/deploy.mjs` 同步 web/headless（并显式同步 desktop profile），web 重启。

## 5. 用户侧唯一动作

重启桌面 App（GUI 进程只能由用户重启）→ 载入 local.150。重启时会触发启动清扫，把 10-18 那批
`expiresAt=null` 的陈旧卡置 `expired`（只改状态、不发请求），待办列表应当只剩「真的需要人」的条目。

## 6. 没有放宽的边界（明确列出）

- 判定服务的 `reject` / `risk=high` / `effect ∈ {write, external, destructive}` **仍然挂卡**；本地硬边界仍然终审。
- TTL 过期**不发送**任何请求，也不删行。
- 凭据不同**不合并**（不因为「URL 一样」就把两笔请求并成一张卡）。
- 写方法（`POST`/`PUT`/`PATCH`/`DELETE`）不在无输入只读豁免范围；`GET`/`HEAD` 带正文在计划校验层就被拒。
- 「无凭据写类本地自动放行」（用户未授权）**未做**；`DSH_SRC_JEV_SESSION_CONTEXT` 默认仍 `off`。
