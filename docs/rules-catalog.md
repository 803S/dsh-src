# 规则真相收敛目录（Phase 4）

规则唯一真相源分层（优先级从高到低，§9.1）：**store/schema/approval 门禁（服务端强制） > 工具参数与错误恢复（description） > 主 prompt（本协议） > Skill/经验库**。
本目录逐条标注每条规则的 enforcement 位置，消除 prompt 与门禁的重复表述。修改规则时只改 enforcedBy 层，prompt 层不再复述细节。

## 服务端强制（enforcedBy=store/schema/gate，prompt 不再复述细节）

| 规则 | enforcedBy | explainedBy | historicalSource |
|---|---|---|---|
| finding 准入：medium+ 必须三要素（impact/victimImpact/concreteLossEvidence）；提供即校验证据存在性 | src_add_finding schema + store 校验（缺项直接拒绝） | prompt【角色与边界·证据诚实】；子 agent persona「准入闸（服务端强制）」 | #11b（2026-08 评审定稿，local.25→67 收紧为 medium+ 门槛） |
| severity 无 info；low 未授权可达+PoC 即入库 | src_add_finding schema enum | prompt 证据诚实段 | #11b 准入放宽（local.71） |
| evidence id 必须可解析（concreteLossEvidence 指向本会话真实节点） | store addFinding 引用校验 | prompt 证据诚实段 | 顺丰会话实证（2026-09-08） |
| HTTP 授权闸：破坏性/越权/未授权写请求异步挂起待审，fail-closed | src_http execute 判据 + approval-locks 硬闸 | src_http description【判据】【审批锁】 | local.26/31/54/60/67 迭代 |
| 写类无本地豁免：没有判定服务结论的 POST/PUT/PATCH/DELETE 一律挂人工，不再自动外发（`require:false` 只保留给「明确只读」） | `classifyHttpRequest` 写方法分支 `require:true` + `httpDecisionPolicy` 在 `mode!=="on"` 时原样透传 `require` | `lib/src/security.js` 头注释 [local.138]；`lib/src/decision/http-policy.js` | local.138（2026-10-15 用户指令「回到我之前的规则审批」；漏洞实例：带 `Authorization` 的 `PUT /bucket/key` 掉到最后一条写分支被自动放行） |
| 判定服务故障 ≠ 放行（fail-safe）：网络/超时/401/403/5xx/未配置/熔断一律不发包、不写审批卡，只留每会话至多 1 条「判定服务不可用」待办 | `serviceOutage()` → `raiseServiceOutage()`（按标题前缀去重）；`httpDecisionPolicy` 因 `fallback!==false` 返回挂起 | `lib/src/decision/service-outage.js` | 2026-10-14 401 事故（28 次调用→32 张卡）后引入 |
| 审批挂起期间同 host+path 禁止绕行（Burp MCP/curl 等通道直接拒绝） | approval-locks 桥接层拒绝 | src_http description【审批锁，硬闸】+ prompt 禁止绕行段 | 2026-08-22 Burp 破案（SSE 绕行路径封堵） |
| 范围闸只约束写/影响类（读/枚举/探测不受限）；写类授权=用户声明域名（整域）∪精确 origin；资产清单=归属与写许可来源 | src_http/src_scan_surface/src_collect_* store 判定 + egress 范围闸（写类报 SRC_GATE_OUT_OF_SCOPE） | prompt 授权段；recon/audit persona【只读不受限 / 写类看归属】 | local.43 → 2026-10-13 用户指令（只读不再被挡） |
| excluded 资产（用户/agent 明确排除）读与写一律拦 | 各探测/发送工具 store 判定（报「已被资产清单标记 excluded」） | prompt 授权段 | local.43 演进 |
| finalize 硬拦四项（pending 待办/blocked 无待办/可推导新方向/覆盖未标） | src_finalize_engagement execute | prompt 主循环 4 | local.44+ 迭代 |
| finding 报告必填 rawRequest（Burp 格式）+ entryPoint + vulnType + attackChain | src_submit/finalize 门禁 | prompt 报告边界段 | local.60/72 |
| intent 等价去重（同目标+范围+验证方法只留一个） | src_add_intent store 校验 | prompt 主循环 1 | local.12 |
| 待办 userTodoId 配对（blocked intent 必须有待办） | src_state blockedReasons + finalize 拦截 | prompt 恢复与交付段 | local.65/66 |
| telemetry 永不阻塞、永不进上下文 | telemetry sink（fire-and-forget + budget） | —（架构红线，无 prompt 层） | local.70 Phase 1 |
| 证据指针永不裁剪 | src_get_evidence / http-output | — | local.72 Phase 2 |

## 工具层解释（explainedBy=工具 description，prompt 只留一句原则）

| 规则 | enforcedBy | explainedBy |
|---|---|---|
| 待办单点挂起铁律（建后立即转其他方向） | 无（行为约定） | src_user_todo description【铁律】+ prompt 恢复与交付段 |
| Burp 抓包三步引导 | 无 | src_user_todo description【auth-session 登录态】 |
| infra 每次敏感动作前重读 | 无 | src_get_infra description【代理策略】【沿用机制】 |
| src_http 响应体透传/去重/CT 补全 | src_http + http-output | src_http description【响应体透传】 |
| src_http 认证头 credentialRef 引用（明文不落会话） | credentials 库 | src_http description + parameters.headers |
| 写类审批只按「计划」计卡（一份 `src_http` 计划 = 一行 `gate_tasks` = 一张卡，计划上限 256 entries/1000 请求） | `lib/src/egress/ledger.js` 插行点 + `lib/src/egress/plan.js` 上限 | — |
| 委派工具角色一致性（recon/audit/verify 工具面差异） | preset toolFilter deny 清单 | src-hunter persona + check-preset-consistency 闸 |

## 经验库层（explainedBy=lessons/Skill，可被上层推翻）

- 有界验证数值（验证码 ~30 次、短信 ~10 次）：lessons/submission-quality + SRC_AUTH_REQUEST_BUDGET（local.43）
- 侦察信号语义（WAF/401/429 解读）：lessons + prompt 恢复与交付段
- 低价值类别门槛、厂商规则对照：lessons/submission-quality、src_fetch_policy
- 打法专题（越权/注入/SSRF 等 16 专题）：clown-src 知识库 + playbooks.js 路由（BASE_DOCS 3 篇 + 命中专题 docs/checks）

## 四类冲突场景 contract test（Phase 4 验收）

对 finding、approval、finalize、scope 四类冲突场景断言「服务端 gate 优先」：
`tests/src.integration.test.mjs` [local.73 Phase 4] contract test —— 即使 prompt/Skill 文本被改错或删除，服务端门禁仍拒绝违规行为：

1. **finding**：medium 缺三要素被拒；evidence 指针不可解析被拒（1442/1469 号测试族）。
2. **approval**：审批挂起期间同 host+path 经桥接通道绕行被硬闸拒绝（approval-locks 测试族）。
3. **finalize**：pending 待办/可推导新方向未处理被硬拦，allowIncomplete 必须带 reason（542 号测试族）。
4. **scope**：主域外未登记 host 探测报 outside the authorized goal host（666 号测试族）。
