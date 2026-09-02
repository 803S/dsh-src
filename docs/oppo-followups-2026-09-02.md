# OPPO 会话后续任务（session-7f5638c9）

> 状态快照：2026-09-02 从 src-sessions.db 实际数据导出。该会话 13 个 intent（4 completed / 9 running）、125 facts、7 research（3 blocked / 2 false-positive / 2 testing）、0 findings、111 assets、21 checkpoints、请求预算内停止（每主机 ≤25、全程只读/空 POST、RPS≤2）。
>
> 本文是「下一步做什么」的行动清单：六条待深挖线的当前证据、下一步动作、验收标准。不修改原会话数据；新会话续测时由 `src_add_goal` 的 priorContext（域笔记+已否假设+findings）自动带上下文。

## 会话主线现状

| 线索 | 状态 | 关键证据 |
|---|---|---|
| 工单详情匿名越权（intent-11 / research-6） | **testing，差临门一脚** | fact-104/108/109/112：sow-cms.oppo.com/oppo-api detail 族匿名可达；AES-128-CBC+RSA 加密链路已完整还原（tool.js 可自解密）；但**无真实单号无法证实 data 回填**——列表接口被验证门拦、详情接口对假单号仅返回「查无此单」。待办「提供本人 OPPO 送修单号」pending |
| yihuan 回收 ForInner 接口族（intent-13 / research-7） | **testing** | fact-113~121：静态资源 OSS 直连、app.js 还原中（含 ForInner 订单详情/支付日志/物流轨迹/订单计数）；需还原参数格式后匿名探测 |
| 其余 | 已收口 | 短信轰炸 blocked（脚本环境风控 101102）、CORS 三层防线 false-positive（应用层 Origin 校验）、WAF 归一化绕过 false-positive（18 请求 412 一致）、cloud-pre 预发≈生产（6 抽样路径一致） |

## 六条待深挖线

### 1. 登录态 AI/WS（chat.oppo.com 及对话类接口）
- **现状**：chat.oppo.com 网关已接管但全站 404「path location is not configured」（fact-58）；community /ajax 清单里有 chat/frontend/*（fact-101），未测。
- **下一步**：①用 Burp 挂代理真实登录后访问社区/客服对话功能，拉取 chat/frontend/* 与 AI 助手接口的真实报文（WS 或长轮询握手、鉴权头形态）；②检查 WS 鉴权是否只在握手 HTTP 升级请求（Origin/Token 注入面）。
- **验收**：至少还原一个对话接口的鉴权模型（匿名可达/会话必带/独立 token），记录 fact；若 WS 握手可无鉴权升级则升 research。

### 2. 预发环境（cloud-pre 及 OWORK 类）
- **现状**：cloud-pre 是预发组唯一存活（bbspre NXDOMAIN，fact-45/57）；/ucweb/* 与 /sms/* 已路由到 Spring 后端，login/v1/state 无凭据即进解密逻辑（fact-68）；/druid /nacos 被 WAF 412 拦（fact-70）；6 条抽样路径与生产一致（fact-71）。**未探明**：预发后端的 actuator/swagger 变体、/ucweb 业务接口未授权面、预发特有的调试路由。
- **下一步**：①还原 cloud-pre 前端 bundle（与生产同壳但可能有 env 差异），提取完整 /ucweb API 清单；②对 ucweb 接口做匿名矩阵（复用 19 路径零泄露的测法）；③sow-service-test-cn.wanyol.com 连接超时但 DNS 若恢复可复核（fact-106）。
- **验收**：ucweb 匿名矩阵表落 fact（≥10 接口的行为/状态码/是否吐数据）；预发与生产的 diff 清单（哪些只在预发存在）。

### 3. 第二账号（越权 A/B 验证前置）
- **现状**：工单详情线卡在「无真实单号」；todo「提供本人 OPPO 送修单号用于越权验证」pending（fact-112 明确要 A/B：同单号匿名 vs 本人会话对比 data 回填）。
- **下一步**：①指挥官在面板 infra 登记第二个 OPPO 测试账号（`src_add_test_account`，凭据现在入本地凭证库只存引用，不落明文）；②用账号 A 下一个真实送修/回收单，账号 B 尝试读取——跨账号读取成功即 BOLA 决定性证据；③同时跑「匿名读 A 的单」验证 research-6。
- **验收**：A/B 交叉 + 匿名三组对照的响应 diff（加密 data 解密后对比），无论成败都落 research evidence。

### 4. DOM XSS（前端 sink 面）
- **现状**：未系统开展。已知的候选 sink：support.oppo.com 自研 jimu 低代码框架（fact-103，动态渲染面大）、community 搜索/帖子渲染（fact-102）、yihuan H5（vue bundle 2.6MB 未审）、design.oppo.com Nuxt content 模板（fact-123：/api/_content/query 无鉴权，当前仅示例数据——若 content 目录后续存内部文档直接公开）。
- **下一步**：①审 yihuan/community bundle 中的 innerHTML/v-html/document.write sink 与来源参数（URL fragment/postMessage/搜索词）；②对 support 工单查询页的 orderNo 回显位做 DOM 注入探测（只读 GET，遵守预算）。
- **验收**：每站一张 sink→source 表落 fact；发现可控 sink 则构造最小 PoC 截图存 evidence 目录。

### 5. 旧 API JWT（oldcms/auth 遗留面）
- **现状**：oldcms.oppo.com 网关未配置源站（fact-59）；auth.oppo.com 已下线由 id.oppo.com 承接（fact-21）；本人会话含 JWT-TOKEN 头（auth-profile fact-75）。**未测**：JWT 的 alg/签名强度/exp、旧 token 在新 id 域的复用性、oldcms 历史接口是否存在未下线实例。
- **下一步**：①解出 JWT-TOKEN payload（不入库敏感值，只记算法与 exp 结构）；②用 Burp 拿登录/续期流量看 JWT 轮换策略（固定/短期/刷新）；③对 oldcms 残留 IP（47.130.205.184 / 3.1.138.187 边缘节点）做 Host 头绑定探测——仅记录不利用。
- **验收**：JWT 生命周期 fact（签发/过期/轮换），以及「旧 token 是否仍被任何在役接口接受」的测试结论。

### 6. 第三方域归属（wanyol/myoas/danghuan 系）
- **现状**：生产前端硬编码第三方域：sow-service-test-cn.wanyol.com（外包测试网关，超时）、dmg-dts.myoas.com（内部埋点）、danghuan.com / danghuan.realme.com（以物换物渠道，同一应用部署）（fact-73/106/120）；yihuan OSS 桶名可枚举（fact-114）。
- **下一步**：①确认 danghuan.realme.com 与 yihuan.oppo.com 是否共享会话/接口（同应用跨渠道=越权面扩大）；②myoas.com 埋点接口的鉴权与上报伪造面（仅记录）；③在 OSRC 规则下确认这些第三方域是否属于授权范围（**先查厂商规则再测**，超范围只做被动观察）。
- **验收**：归属判定表（域名/注册主体/授权状态/证据），超范围项标注「已声明不可测」。

## 恢复执行的方式

```text
新会话 → src_add_goal target=oppo.com（同目标自动带 priorContext）
→ 依次跑六条线，每线一个 intent
→ 高危/写请求走 src_http 挂起待审
→ 凭据全部走 credentialRef（面板测试凭据卡或 src_add_test_account）
```

## 红线提醒（不变）

- 单号/手机号/IMEI 等真实数据只用本人授权数据；跨账号测试需第二个自有账号。
- 每主机请求 ≤25、RPS≤2、只读优先；WAF 412/验证码/风控即停并记录。
- 测试环境三分法：预发可测但不出数据不动状态；生产只读。
- 第三方域未确认归属前不主动测。
