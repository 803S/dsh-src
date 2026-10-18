# 审批卡“实际危害”逐张审计（local.146，2026-10-18）

用户现场提问：「怎么又无危害的操作挂了一堆审批啊？你看看那些有啥危害啊到底」。

审计对象：会话 `session-c8341c79-05b8-4520-9f9f-6921f435830d`（目标 `eci-2ze4ypdelfrdmqaf1dz1.cloudeci1.ichunqiu.com`，
Jorani 0.6.6 请假系统，模型以默认口令进入 Admin 会话后做未授权/CSRF/CORS 对照测试）。
账本 `gate_tasks` 该会话 pending 6 张；会话投影 `u_src_pending_approvals` 另有 1 张已批准（卡1）。

## 方法（零目标流量）

对每笔冻结报文调用**闸自己的两个判据**，而不是靠读策略文字：

1. 本地判据：`lib/src/security.js` 的 `classifyHttpRequest({method,path,query,headers,body})` → `verdict/hardBoundary/reason`；
2. 判定服务：`buildOperationContext + operationContextToJev`（与 `advisor.assessEgressPlan` 单笔车道同一构造）→ `jevDecide(..., {probe:true})`。

脚本：`/tmp/harm/analyze.mjs`。`probe:true` 不写计量、不碰熔断、不向目标发包。

## 结论表

| 卡 | 冻结请求 | 本地判据 | 判定服务 | 卡片状态 | 实际危害 |
|---|---|---|---|---|---|
| 1 | `GET /users/reset/1`（带 cookie） | **hard-boundary** 破坏性写入（`reset` 命中 `CORE_DESTROY_WORDS`） | **read / low / allow** | 已人工批准 | **无** |
| 2 | `GET /users/reset/1`（不带 cookie） | 同上，终审 | read / low / allow | pending（与卡1 仅 cookie 有无之差 → digest 不同 → 重复卡） | **无** |
| 3 | `GET /users/2/reset` | 同上，终审 | read / low / allow | pending | **无** |
| 4 | `POST /users/reset/1` body `password=<stored>&confirm=...` | hard-boundary 破坏性写入 | unknown / pending | pending | **有**（真改掉目标用户 1 的密码）✅ 该挂 |
| 5 | `OPTIONS /users` + `Origin: evil.example.com` + `Access-Control-Request-Method: GET` | **hard-boundary** 请求方法改写 | **read / low / allow** | pending | **无** ❌ 误报 |
| 6/7 | `GET /extra/create`（不带/带 cookie） | needs-judgement 只读疑义（`create` 在 `SUSPICIOUS_WORDS`） | read / low / allow | 卡片记录为 unknown / pending | **无**（首页导航链接 → 表单页） |

**6 张 pending 里 5 张无实际危害**；判定服务自己也在这 5 张上给了 `read/low/allow`。

### 卡 1/2/3「无危害」的证据不是推理，是目标应用自己的 HTML

Jorani 首页/用户列表页里写着：

```js
$("#cmdChangePassword").click(function() {
  $("#frmChangeMyPwdBody").modal('show').load('http://<target>/users/reset/1');
});
```

即 `GET /users/reset/{id}` 是**改密码弹窗的表单体**（渲染页面），`POST` 同一路径才真正改密码。
所以同一个路径上：GET（卡1/2/3）= 只读表单，POST（卡4）= 真实状态变更。
**本地语义词表无法区分这两者；判定服务看得到方法与 body，可以区分**，而本地 `hardBoundary` 恰好剥夺了它的发言权
（卡片 reason 原文：「…即使方法为 GET 也按确定危害挂起审批（终审，判定服务无权覆盖）」）。

## 根因（两个，都是本地层越权）

### 1. CORS 预检协议头被当成「请求方法改写」——已修（local.146）

`lib/src/security.js:35` 旧正则 `/method|rewrite|forward|original/i` 命中标准头名 `access-control-request-method`。
该头只是浏览器在问「我能不能用这个方法」，不改写任何东西；`access-control-request-headers` 同理。
后果：**每个 CORS 配置探测的 OPTIONS 都被钉成确定危害硬闸，判定服务无权覆盖**（卡5 现场实案）。
修法：`METHOD_OVERRIDE_HEADER` 之外单列 `CORS_PREFLIGHT_HEADER = /^access-control-request-(?:method|headers)$/i` 并在判定处排除。
修后 `OPTIONS /users + Origin: evil.example.com` → `read-clear`（明确只读，**根本不建卡**）。
真方法改写头（`x-http-method-override`/`x-method-override`/`x-http-method`/`x-original-method`）与路径改写头
（`x-original-url`/`x-rewrite-url`）行为不变，测试已锁（`tests/egress-gate.test.mjs`）。

### 2. 强删改语义词命中「读方法」时本地终审——**已按用户拍板收敛（local.146）**

`GET /users/reset/1` 之所以无危害却被终审，是因为 `reset ∈ CORE_DESTROY_WORDS` 且规则明确写「即使方法为 GET 也按确定危害」。
这与本项目的分层原则冲突：本地硬闸保留的是**无需语义即可证明**的危害（DELETE、编码后仍命中的删改词、方法/路由改写头）；
读方法 + 空 body 无法被一张词表证明有危害。而 Jev 三例都判了 `read/low/allow`，卡4 的 POST 则被判 `unknown/pending`
（无论怎么改，写方法路径上的行为都不变）。

用户拍板原文：「交给 jev 判断呗，jev 不就是干这个的嘛，能删数据的这种就限制的死一点吧」。

落地方案（`lib/src/security.js`）——**按动词是不是这个 URL 的端点分档**：

| 场景 | 判据 | 结果 |
|---|---|---|
| 动词在**路径中段**（`/users/reset/1`：末段是 id） | 表单页形态，本地词表看不出有没有副作用 | 交判定服务（不再终审） |
| 动词是**路径末段**（`/delete`、`/users/1/delete`、`/admin/purge`、`/deleteUser`、解码后 `/%64elete`） | 该 URL 本身就是删改端点 | 维持本地终审 |
| 动词在**查询串**（`?action=delete`、`?do=purge`） | `?action=…` 就是状态变更端点的常规写法 | 维持本地终审 |
| **写方法**（POST/PUT/PATCH）或 DELETE | 原样不变 | 维持本地终审 |

「末段」按 `/` 分段后再做 camelCase 拆分，故 `/deleteUser` 仍算端点。残留口子写清楚：`/delete/1` 这种「动词后跟 id」形态会落到判定服务手上——
但如果它误判 `read/low/allow` 就会被自动发出。这是本次收敛接受的残余风险，以换取 6 张卡里 4 张的白卡消失。

端到端验证（`/tmp/harm/e2e.mjs`，零目标流量）：

```
GET /users/reset/1   → 本地 needs-judgement → Jev read/low/allow → 自动发送，不建卡
GET /delete?id=1     → 本地 hard-boundary（未调用 Jev）        → 挂人工卡
GET /users/1/delete  → 本地 hard-boundary（未调用 Jev）        → 挂人工卡
```

### 3. 卡 6/7 的挂起不是本地越权，是判定服务自己说 `unknown`

本地只判「只读疑义」并**交**给判定服务；但卡片记录的执行前判定是 `unknown/unknown/pending/authority=human-required`。
本次复算里同样两笔在最新载荷下得到 `read/low/allow` —— 说明 `unknown` 与载荷细节/服务抖动有关（空 body 的 GET 命中 `create` 语义词）。
诚实结论：**这一张不能靠「放宽本地规则」修掉**；把 `unknown` 一律当自动放行是真降门槛。
可做的是让判定服务拿到更多上下文（见 `docs/jev-context-feed-ablation-20261018.md` 的反直觉结论：喂模型自述会**降低**风险判定，故默认关）。

## 4. 「查看判定记录」里的水词——已清理（local.146）

用户追问：「查看判定记录详情里咋这么多内容？都是必须的还是单纯代码填充一个统一的无意义内容放着的？」

把该会话 7 张卡的 `reason` 原文拉出来逐字比对，**每次都不一样的只有 6 个值**（摘要哈希、影响、对象类别、风险、动作、hardVeto/authority），
其余逐字相同。逐句判定：

| 片段 | 必须吗 | 处置 |
|---|---|---|
| `执行前判定{...}` JSON | **必须**：不是给人看的装饰，而是**真数据通道**——UI `approval-explanation.ts` 的 `assessmentOf()` 与 `approvalBlockReason()` 都在正则解析它，5 个展示判断依赖 `effect/risk/action/hardVeto/fallback` | 保留（一字不动） |
| `摘要<64 位>` | 必须：去重标识（同内容第二次提交靠它认出同一张卡）；UI 的「旧记录无可解析阻断原因」分支也按这个字面词判断 | 保留 |
| `判定依据：影响=…；对象类别=…；风险=…；动作=…；判定服务正常；模式=on` | **不必**：与紧随其后的 JSON **完全同一批字段的第二遍** | 删除（`describeVerdict()` 整个函数移除） |
| `用途说明（系统默认说明（模型未申报用途，不是模型自述））：单笔目标请求，完整内容由出口捕获；需审核实际语义` | **不必**：闸对自己说的一句空话；且同一句已存在 `justification` 字段里 | 改成一行「用途：模型未申报（系统默认说明，不是模型自述）」 |
| `1个精确请求，最多1次，间隔250ms` | 单笔车道恒定值 | 单笔时改「冻结报文：1 笔，批准后只发送这一次」 |
| `有界任务待审（…）` 前缀 | 卡片标题（模型可见事件标题也用它） | 保留 |

新格式（多行，UI 用 `<pre>` 渲染，故换行可读）：

```
有界任务待审：只读取回（本地确定性危害，判定服务无权覆盖）
冻结报文：1 笔，批准后只发送这一次
用途：模型未申报（系统默认说明，不是模型自述）
摘要4420a62cc1593b8a…
执行前判定{"effect":"read","risk":"low","action":"allow",...}
这是单笔冻结请求：用户可直接批准发送原请求（仅一次）或拒绝；…
```

回归锁：`tests/jev-approval-escalation.test.mjs` 增断言——`reason` 不得出现 `判定依据：影响=`（禁止重复 JSON 字段）、
不得出现 `需审核实际语义`（禁止把闸的默认串当用途）、必须出现 `用途：模型未申报`。

## 5. 审批卡不再打码：直接展示原始冻结报文（local.146）

用户追问：「密码是谁的密码？模型看到密码无所谓吧，不影响啥吧」——追着查明「谁的密码」之后，结论是**打码本身是安全戏**。

### 事实取证（现场 session-c8341c79）

| 卡上的 `<stored>` | 实际是什么 | 有价值的机密吗 |
|---|---|---|
| `password=<stored>`（卡4 body） | **模型自己编的测试密码**（想把目标 1 号用户改成 `Test@12345`）；模型自己的会话日志里明文出现 6 次，且同一行隔壁 `confirm=Test@12345` 就是同一个值的明文 | 不是。打码只造成「半张脸」的观感 |
| `cookie: <stored>`（卡1/3/4/5/7） | 目标站（Jorani）发给模型的**登录会话票据**；模型用 `-b jar.txt` 从 cookie 罐里取用 | 不是用户自己的凭据。而且**值就在会话目录的 cookie jar 里**：`cat jar.txt` 是只读操作（本就不拦），模型随时能读 |

进一步：模型登录用的账号是 Jorani 的公开默认口令 `bbalet/bbalet`（应用自带文档），不是用户的账号。

### 所以打码保护了什么

- **不保护用户**：值就在用户自己机器的 cookie jar 里，用户想看随时能看。
- **不阻挡模型**：`password=` 那个值是模型自己写的；cookie 值它 `cat` 一下就能拿到。
- 唯一实际效果：审批卡看起来「没头没尾」，用户没法核对真实报文。

唯一有意义的残留情形是「模型被目标站返回内容里的提示注入诱导，把票据转发出去」——
但出口闸另有一道**独立**防线：未经用户授权的 origin 根本发不出去（`assertScopeCurrent` 校验 plan.origins ⊆ scope.origins）。

### 落地

- `lib/src/egress/plan-presentation.js` 增 `raw` 通道：审批卡用 `presentPlan(input,{raw:true})`，原样输出 `method/URL/headers/body`。
- 发给**外部判定服务**的那份**仍走打码版**（`presentPlan(...,{review:true})`，凭据名与值一律 `<stored>`）：Jev 是外部服务，没有理由把用户凭据交给它。默认投影（事件/工具结果）也仍打码。
- UI：`src/dsh-client-ui-src/src/client/approval-explanation.ts` 去掉按头名的 `<stored>` 替换；`ActionCenter.tsx` 面板标题由「查看冻结请求（脱敏，非抓包）」改为「**原始报文**，非抓包」。
- 回归锁：`tests/jev-approval-escalation.test.mjs` 新增「卡展示原始报文（凭据不打码）+ review/默认投影仍打码」；`tests/project-defects.test.mjs` 的「审批展示冻结HTTP请求、脱敏凭据」改为断言认证头原样展示且卡内不出现 `<stored>`。

### 验收

`npm test` **682/682**；`/tmp/harm/verify-raw.mjs`（部署副本）7/7；UI 重建 `lib/ui-src.client.js`（766093 B）。

## 顺带确认的观感来源（非危害问题，但放大「一堆审批」）

- **重复卡**：同一 URL 带/不带 cookie 因 digest 不同各出一张（卡1 vs 卡2、卡6 vs 卡7）。同资源合并是待办 1/3。
- **用途说明不可读**：卡片写「系统默认说明（模型未申报用途，不是模型自述）」，但模型**每条 bash 调用都写了 `description`**
  （如 `Test CORS policy with malicious origins`）。bash/curl 车道从不把该文本接进 `exec.egressPurpose`
  （只有 `src_http` 从 `args.justification` 接，见 `lib/src/tools/index.js:1993`），所以卡片对用户而言「没头没尾」。
- 该会话 37 次 bash、**0 次 `src_http`** —— 所有目标请求都走 curl 单笔车道，即最容易丢用途的车道。

## 验收

- `npm test` **681/681**（679 + 新增两条回归测试：CORS 预检头、读方法强删改词分档；另 jev-approval-escalation 增水词断言）；`node scripts/check-source-hygiene.mjs` 通过。
- 部署副本一致性：`diff -rq lib/src ~/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src/lib/src` 无差异（除 gitignore 的 `__pycache__`）。
- 部署副本行为验收 `/tmp/harm/verify-deployed.mjs` 6/6（CORS 放开、真改写头仍终审、DELETE 仍终审、GET reset 仍终审=待拍板现状、effect-policy 在位）。
- 版本 `0.1.0-local.146`；web 已重启（PID 29920；无 token 401 / 带 token 303）。
