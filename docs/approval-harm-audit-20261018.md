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

### 2. 强删改语义词命中「读方法」时本地终审——**待用户拍板**

`GET /users/reset/1` 之所以无危害却被终审，是因为 `reset ∈ CORE_DESTROY_WORDS` 且规则明确写「即使方法为 GET 也按确定危害」。
这与本项目的分层原则冲突：本地硬闸保留的是**无需语义即可证明**的危害（DELETE、编码后仍命中的删改词、方法/路由改写头）；
读方法 + 空 body 无法被一张词表证明有危害。而 Jev 三例都判了 `read/low/allow`，卡4 的 POST 则被判 `unknown/pending`
（无论怎么改，写方法路径上的行为都不变）。

提案（未实施）：**读方法命中强删改词 → 交判定服务（needs-judgement），写方法命中仍为 hard-boundary**。
保留 write 侧全部现状是硬约束；读侧仍要过判定服务，`action≠allow` 照样挂人工。
风险要写清楚：GET 型状态变更（`/delete?id=1` 这类）会落到判定服务手上，一旦它误判 `read/low/allow` 就会自动发出。
替代收敛方案（可选）：强删改词只出现在 **path 段**（表单路径）时交判定服务，出现在 **query**（`?action=delete` 习惯用法）时维持终审。
两条都需要用户明确点头才做。

### 3. 卡 6/7 的挂起不是本地越权，是判定服务自己说 `unknown`

本地只判「只读疑义」并**交**给判定服务；但卡片记录的执行前判定是 `unknown/unknown/pending/authority=human-required`。
本次复算里同样两笔在最新载荷下得到 `read/low/allow` —— 说明 `unknown` 与载荷细节/服务抖动有关（空 body 的 GET 命中 `create` 语义词）。
诚实结论：**这一张不能靠「放宽本地规则」修掉**；把 `unknown` 一律当自动放行是真降门槛。
可做的是让判定服务拿到更多上下文（见 `docs/jev-context-feed-ablation-20261018.md` 的反直觉结论：喂模型自述会**降低**风险判定，故默认关）。

## 顺带确认的观感来源（非危害问题，但放大「一堆审批」）

- **重复卡**：同一 URL 带/不带 cookie 因 digest 不同各出一张（卡1 vs 卡2、卡6 vs 卡7）。同资源合并是待办 1/3。
- **用途说明不可读**：卡片写「系统默认说明（模型未申报用途，不是模型自述）」，但模型**每条 bash 调用都写了 `description`**
  （如 `Test CORS policy with malicious origins`）。bash/curl 车道从不把该文本接进 `exec.egressPurpose`
  （只有 `src_http` 从 `args.justification` 接，见 `lib/src/tools/index.js:1993`），所以卡片对用户而言「没头没尾」。
- 该会话 37 次 bash、**0 次 `src_http`** —— 所有目标请求都走 curl 单笔车道，即最容易丢用途的车道。

## 验收

- `npm test` **680/680**（679 + 新增 CORS 预检头回归测试）；`node scripts/check-source-hygiene.mjs` 通过。
- 部署副本一致性：`diff -rq lib/src ~/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src/lib/src` 无差异（除 gitignore 的 `__pycache__`）。
- 部署副本行为验收 `/tmp/harm/verify-deployed.mjs` 6/6（CORS 放开、真改写头仍终审、DELETE 仍终审、GET reset 仍终审=待拍板现状、effect-policy 在位）。
- 版本 `0.1.0-local.146`；web 已重启（PID 29920；无 token 401 / 带 token 303）。
