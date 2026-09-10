# 网络层失败：通道分歧对照——换工具，不定性，不放弃

## 触发场景
- `src_http` / 审批放行（src_resolve_approval）返回「网络层失败（无 HTTP 响应）」或 `fetch failed`。
- 同一目标不同工具/通道结果不同：本机 fetch 失败但 Burp 可达（或反之）。
- 报错里出现 `unsafe legacy renegotiation`（服务端 TLS 只支持老式重协商，OpenSSL 默认拒绝；Java/Burp 的 JSSE 兼容，所以 Burp 打得通）。
- 想把连续失败解释成「审批通道兼容问题」「目标封禁」「服务下线」之前——这些结论必须先验证，不许凭空归因。

## 处置原则：一个工具失败 ≠ 资产没价值，先穷尽通道与工具
1. src_http 直连失败先读报错：local.64 起遇到 legacy renegotiation 已自动降级重试一次（SSL_OP_LEGACY_SERVER_CONNECT）；仍失败说明还有别的网络层问题，报错里带了指引。
2. 换通道对照：用 `mcp__burp__send_http1_request` 发同一个请求（同 method/path/body，Host 头一致；Burp 的 TLS 栈更宽容）。Burp 通 → 通道差异实锤，**继续用 Burp 打这个目标**——找到可用通道就是资产可测，不是放弃理由。
3. 再换：配了代理就切代理出口再试 src_http；Burp 也不通试 capability 里的 curl/脚本通道。
4. 所有常规通道均无响应，才记一条「双通道均无响应」的 fact（附时间与报错原文），转向其他方向；目标可能真下线，但这是验证后的结论。
5. 结论写进 checkpoint/fact 必须注明通道（「经 src_http 直连」「经 Burp 通道」「经代理」），父会话据此判断审批重放能否成功、该用哪个通道续打。

## 纪律
- 连续 ≥2 次同类失败必须换通道或换方向，不空转重试同一条路。
- 审批重放失败的常见根因是「取证通道 ≠ 放行执行通道」（如当初用 Burp 取证、重放走 src_http）：先对照通道，不要怪审批系统。
- 对用户的汇报只说可验证的事实（报错原文、通道、时间），不发明「已知问题」。

## 能力路由反面清单（抓取/枚举受阻 ≠ 结束）
- 抓规则页面撞 SPA 空壳就写「正文反爬无法抓取」然后放弃 = 不合格——抓取受阻是「换方法」信号，不是「结束」信号：先调 src_list_capabilities 查能力清单（skill 型如 src-rules-scraper 走浏览器渲染），再换 web_search 找镜像/转载，最后才向用户待办降级。
- 同理适用于所有「本机工具面没覆盖」的场景：先查清单，没有再如实告知用户建议接入，不要硬猜 API。

<!-- lesson-meta: {"sessionId": "builtin", "vulnType": "网络层失败通道对照", "hook": "fetch failed≠不可达：先试 Burp 通道对照再定性，禁止未验证归因；抓取受阻是换方法信号", "createdAt": 1788720000000, "triggers": {"keywords": ["fetch failed", "网络层失败", "legacy renegotiation", "通道", "审批失败", "不可达"], "tools": ["src_http", "src_resolve_approval", "src_test_bypass"]}} -->
