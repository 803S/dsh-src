# step25 “25 字节静默拒绝”根因、step30 判定定案与闸可观测性修复（2026-10-19）

## 范围

只读复核会话 `session-a927392f-e9ca-4924-9fbe-0cd7d100752a`（Jorani 0.6.x 目标，97 步、125 次工具调用）中的出口闸行为，
重点是 step25 四个裸 `403 SRC_GATE_BLOCKED_NOT_SENT`（正文 25 字节、无审批卡、无可见原因）与 step30 “只有 `jdoe` 挂卡”的差异，
并核验它们暴露出的两条观测级缺陷（判定归账、桌面 App 遥测发射）。
复核方式：会话事件、执行账本、冻结清单解密、离线 digest 复现、离线 broker 复现、只打判定服务的复放（`probe:true`）。未重放任何请求、未批准旧审批、未向真实目标发包。

## 结论摘要

1. **step25 不是被策略拒绝、不是范围问题、不是限流**：四条 GET 全部落在 `ledger.claim` 的**精确请求清单比对**上，
   返回 `REQUEST_NOT_APPROVED`（该错误码不带 `approval_id`，所以正文只有 25 字节、也没有审批卡）。
2. **根因是头部集合不一致**：模型在 step24 用 `src_egress_plan` 手写的冻结条目只有 `{method,url}`，
   而 curl 实际发出的请求带 `User-Agent: curl/8.7.1`、`Accept: */*`（`Host` 按规则剔除）。
   冻结条目的 digest 包含完整头部列表，所以线上请求与任何条目都不相等。
3. **同一份计划、同一个 URL，`src_http` 能过、bash/curl 不能过**：`src_http` 按申报头部原样构造请求 → 命中冻结条目
   （step26 的两次 `src_http` 重试正好消费了条目 #1、#3 的预算，`used=1`）。这直接证明差异来自**头部集合**而不是 URL/范围。
4. **模型事后的自我解释是错的**：它写成“计划 URL 必须与逐笔请求精确匹配、`?login=` 变体不在清单里”。
   四个变体都在清单里（1:1 有序对应），缺的是头部。
5. **一个真实缺陷：拒绝不可观测**。`x-src-gate-reason` 头在 bash/curl 管道里几乎必然丢失，而正文恒为 `SRC_GATE_BLOCKED_NOT_SENT`。
   模型只能猜原因，于是猜错了方向并改了通道。本次已修复该缺陷（见“已实施修复”）。
6. **step30 的 POST 差异已定案：不是判定不一致，是判定正确**。`jdoe` 是 Jorani 的默认真实账号，对真实账号触发密码重置会真的外发重置邮件
   → 判定服务判 `external/high/pending`；另外三个 `login` 值都不是真实账号，端点不会产生实际外发或状态变更 → `auth/low/allow`。
   离线复放（只打判定服务、不打目标）10/10 对 `jdoe` 判 `external/high/pending`，12/12 对其余三个判 `auth/low/allow`，确定性可复现。
   会话里只有那一笔挂卡，所以看起来像“只有 jdoe 特别”。判定层无需任何改动。
7. **两个新发现（本轮已修，都在观测侧，不改授权）**：
   - 代理/脚本车道的判定**一条都不入计量**：该车道的 exec 是合成对象（没有 `agent.session`），旧 sink 直接调用 `sessionIdOf(exec)` 抛错并被 `catch` 吞掉。
     后果：step30 那 4 笔同形 POST（3 笔自动放行 + 1 笔挂卡）在 `u_src_decision_recent` 里查不到任何一笔，事后无法解释“为什么只有 jdoe 要审批”。
   - 桌面 App 里**风险漏斗遥测全关**：观测发射以 `DSH_SRC_LAYA_DECISION` 为准（默认 `off`），部署脚本会显式打开，而用户真正使用的桌面 App 不注入任何 `DSH_*` 环境变量。
     后果：当天 `src-telemetry-2026-10-19.jsonl` 67 行里 `risk-grade` 观测行 0 条（只有显式传 `mode` 的 delegate/skill 4 条）。

## 证据

### 冻结清单与 step25 的逐条比对

step24 的 `src_egress_plan` 创建任务 `dc1a207b-ad83-4776-b94a-742d0f7f7b8d`（`lane=proxy`、`automatic=true`、`maxRequests=18`、
`minIntervalMs=800`、4 条 `safeRead=true` 条目、资源 `78662919dd10fadb144b0463e023e164eb27c203653d636f85ab525e0b23ce9a`）：

| 条目 | 计划里的请求 | 冻结 digest（前 8 位） | 预算使用 |
| --- | --- | --- | --- |
| 0 | `GET /session/forgetpassword` | `33cd6f53` | 0 |
| 1 | `GET /session/forgetpassword?login=nonexistentuser123456` | `b9c8e8b8` | 1（step26 `src_http`） |
| 2 | `GET /session/forgetpassword?login=admin` | `93c8fd80` | 0 |
| 3 | `GET /session/forgetpassword?login=` | `3b7db0d8` | 1（step26 `src_http`） |

- 用真实账本 key 离线重算：`{method,url}`（无头部）→ `33cd6f53…`，与冻结条目 #0 完全一致；四个变体按序 1:1 对上。
- 同一 URL 加上 curl 的线上头（`accept: */*`、`user-agent: curl/8.7.1`）→ `6a87fccc…`，**对不上任何条目**。
- `resourceDigest` 三种写法相同（资源身份不受客户端偏好头影响），所以“资源级”检查都没有拦它。
- 结论：四条 GET 全拒、两条 `src_http` 全通，唯一差异就是头部集合。

### 离线复现（不发包）

- `tests/egress-gate.test.mjs`：`模型手写的无头部计划无法匹配 bash/curl 自动添加的客户端偏好头`
  —— 无头部计划 → `plan.state='active'`、`review.authority='hard-rules'`；curl 形状的 claim 抛 `SRC_GATE_REQUEST_NOT_APPROVED` 且
  `approvalId === undefined`；`src_http` 形状的 claim 命中同一条目。
- 复现用的计划评审结果与会话里 step24 返回的 JSON 逐字段一致（`effect:read/risk:low/action:allow/mode:not-applicable/objectClass:unknown/authority:hard-rules`），
  确认复现落在同一条车道上。

### 为什么 step29/step30 的 bash curl 又能过

那两条 bash 命令没有绑定模型手写的计划：车道在 claim 时**按线上真实请求**构造单笔任务（step30 的 `approval-1` 冻结报文里
`user-agent: curl/8.7.1`、`cookie: <stored>`、`accept: */*`、`content-type: …`、body `csrf_test_jorani=<stored>&login=jdoe` 就是线上原文）。
插件自己的 `scan-plan.js` 也内置 `'curl/8.4.0'` 之类的预测头，所以“插件预测的计划 + bash”能匹配；
只有“模型手写且不带头部的计划 + bash”必然不匹配。

### 可观测性缺陷的量化

`lib/src/egress/mitm-addon.py` 的 `deny()` 原来把正文固定为 `SRC_GATE_BLOCKED_NOT_SENT`（25 字节），
真实原因只在 `x-src-gate-reason` 响应头；只有存在 `approval_id` 时正文才会加内容。
step25 的 curl 用了 `-o /tmp/body.txt -w "HTTP:%{http_code} …"`，**头在线上但从未被打印**，模型只能看到正文并推断原因。
`~/.dsh/control/src-egress/` 下没有 mitm 代理日志，事后无法从日志恢复该头；账本 `gate_denials` 也没有本会话 step25 的原因行。
即：一次“原因不可恢复的静默拒绝”。这违反既定约束“`SRC_GATE_BLOCKED_NOT_SENT` 不能作为唯一可见结果”。

### step30 差异定案：`jdoe` 是真实账号（判定正确，代码无需改）

- 车道机制：step30 的 bash 循环**没有绑定**模型手写的计划（那是 step24 的 `dc1a207b`，只被 step26 的 `src_http` 消费），
  所以每一笔 POST 都在代理车道按线上真实请求单独建单：自动放行的落地 `lane='proxy'`，判定为待审的转成 command-only 的 `lane='host'` 人工卡。
- 权威时间线（`gate_dispatches`，窗口内全部 `lane='proxy'`、`maxRequests=1`、`used=1`）：
  `f4131b9b@1792413720692`（POST#1 `nonexistentuser123456`）、`37b600b4@1792413723559`（POST#2 `admin`）、
  `f28d6a7d@1792413729020`（POST#4 `test`）；`jdoe`（POST#3）那笔**没有任何 dispatch**，只有 `approval-1.createdAt=1792413726536`。
  3 笔自动发、1 笔挂卡，与循环顺序 `nonexistentuser123456 → admin → jdoe → test` 严丝合缝。
- 离线复放（`probe:true`，只调到判定服务，用真实 wire 头 + `bodyBase64` 送正文，不发包）：
  `login=jdoe` → `external/high/pending` **10/10**（confidence 0.31–0.41，`external_p` 0.40–0.48）；
  `admin`/`test`/`nonexistentuser123456` → `auth/low/allow` **12/12**（`external_p` 0.23–0.36）。
  复放必须走 `bodyBase64`：`assessEgressPlan` 不做 `normalizePlan`，直接传 `body:` 会丢正文（首版复放 4 笔全 `unknown` 就是这个伪影）。
- 结论：判定按**真实影响**（会不会真的外发）分级，`jdoe` 是真实账号 → `external` → 人工卡；其余不是真实账号 → 无实际影响 → 自动放行。
  这不是“同一请求两套标准”，而是同一标准在不同参数下的不同结果。

### 已实施修复（本轮，不改任何授权判定）

1. 新增 `lib/src/egress/deny-hints.js`：一组固定的“为什么没发送、下一步能做什么”提示，只用于解释，不参与判定。
2. `lib/src/egress/control-server.js`：403 响应除 `error` 码外附带 `hint`（截断 400 字符），无提示时字段缺席。
3. `lib/src/egress/mitm-addon.py`：`deny()` 正文恒为 `SRC_GATE_BLOCKED_NOT_SENT\n<真实原因码>`，有 `hint` 时再加一行；
   存在审批编号时保持原有“待审/已拒绝 + 编号 + 处置动作”正文与 `x-src-gate` / `x-src-gate-reason` 头不变。
   step25 那种拒绝现在的可见正文形如：

   ```
   SRC_GATE_BLOCKED_NOT_SENT
   SRC_GATE_REQUEST_NOT_APPROVED
   该请求不在冻结计划的精确清单内：方法、URL、头部集合与正文必须与计划条目逐字节一致（客户端自动加的 User-Agent、Accept 也参与比对）。改用 src_http 按申报头部原样发送，或重新提交包含这些头部的 src_egress_plan。
   ```

4. 测试：新增 `tests/egress-deny-body.py`（6 组：无卡拒绝带原因码、无 hint 也带原因码、审批编号与处置动作不丢、非 GateDenied 内部失败同样带原因码、
   非法原因码归一化、超长 hint 不进入正文），在 `tests/egress-gate.test.mjs` 注册；
   并新增控制面 403 必须带 `hint`、未知失败码不得伪造提示的两条断言；
   `scripts/egress-feasibility/shell-child-probe.mjs` 的精确正文断言改为“必须带真实原因码”。

5. **判定归账（`local.148`）**：`lib/src/decision/record-sink.js` 新增 `sessionIdForDecision(exec)`（`exec.agent.session.id` → 回退 `exec.srcSessionId` → `''`，绝不抛错）；
   `lib/src.js` 的 sink 改用它（只在拿不到会话名时记一行 warn），`lib/src/egress/manager.js` 在 `authorize`/`propose` 处给 exec 盖章 `srcSessionId`，
   `lib/src/telemetry/events.js` 的 `emitLayaDecision` 用同一解析。后果：代理/脚本车道的判定现在与工具车道一样入权威域与遥测。
6. **观测发射判据（`local.148`）**：`lib/src/egress/advisor.js` 新增可注入的纯函数 `riskObservationEnabled(value,{flag,testProcess})`——
   flag 显式不是 `off`（部署脚本）→ 发射；flag=off 但这次判定真的发生了（`mode=on`，即用户在设置里开着判定服务）且不是单测进程 → 发射（桌面 App 场景）；
   其余（没真问过判定服务，或单测 fixture 拿 `mode:'on'` 造假值）→ 维持静默。实测：`npm test` 前后真实 `~/.dsh/storages/src-telemetry/` 库 67 行不变（不污染事后审计）。

测试：新增 `tests/egress-decision-attribution.test.mjs`（4 组：发射判据真值表、归账解析、代理车道观测行带 `sessionId` 且不带正文、出口闸给 exec 盖章），
并在 `tests/src.integration.test.mjs` 增加一条权威域回归（代理车道判定必须入 `decision_stats`/`decision_recent`，无归账身份时静默跳过且不影响判定结果）。

回归：`npm test` 686/686 通过，`node scripts/check-source-hygiene.mjs` 通过。

## 未决问题（需要人工决定）

1. **计划车道与 bash 的语义（本轮未改）**：当前是逐字节精确匹配，因此“模型手写无头部计划 + bash/curl”这条组合必然失败。
   可选方向：
   - A. 保持精确匹配，只依赖本次修复给出的可操作提示（模型应改用 `src_http`，或声明真实头部）。
   - B. 对 `safeRead=true` 的只读条目，在严格 digest 未命中时再用“忽略客户端偏好头（`user-agent`/`accept`/`accept-encoding`/trace）”的归一化 digest 匹配一次；
     `cookie`/`authorization`/`referer`/`origin` 仍必须逐字节一致。这只影响“已验证只读、无目标副作用”的请求，但确实改变了“批准的是什么”。
   - C. 不匹配时回退到按线上请求单独评估（可能产生新审批卡）。会让“一次性审核的精确清单与预算”失去约束意义，默认不采纳。
   需要用户决定是否采用 B（含 `cookie` 场景仍需另行设计“计划如何声明凭据”）。
2. **判定载荷里的会话身份（本轮只做观测，没动载荷）**：代理车道的 exec 没有 agent，所以 `advisor.js` 里送进判定服务的 `sessionId` 现在是空串
   （工具车道则非空）。改成带上会话身份会更完整，但会改变判定服务侧的缓存键与归账口径，属行为变更，留作观察项。
3. **`DSH_SRC_LAYA_DECISION=off` 不再等于“观测全静默”**：本轮之后，只要判定真的发生了（设置里 `riskMode` 为 `on`），观测行就落。
   要完全关闭遥测请用 `DSH_SRC_TELEMETRY=off`（该开关仍然优先）。若希望 `DSH_SRC_LAYA_DECISION=off` 也彻底静默，需要另行拍板。
4. **报告事实**：最新会话报告把未批准的 `GET /users/create`（`approval-2`，`write/high/business-or-unknown`）写成已取得 `200 Create a new user`；
   必须删除或明确标注“未发送、未验证”。
5. 同资源多条目审批卡的合并语义、`SrcView.tsx` 的 TASK 正文解析、路径改写头拆分、0.2 兼容 shim 等仍未完成。
