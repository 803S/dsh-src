# fetch failed ≠ 目标不可达：先对照 Burp 通道再定性

## 触发场景
- `src_http` / 审批放行（src_resolve_approval）返回「网络层失败（无 HTTP 响应）」或 `fetch failed`。
- 同一目标不同通道结果不同：本机 fetch 失败但 Burp 可达（或反之）。
- 报错里出现 `unsafe legacy renegotiation`（服务端 TLS 只支持老式重协商，OpenSSL 默认拒绝；Java/Burp 的 JSSE 兼容，所以 Burp 打得通）。
- 想把连续失败解释成「审批通道兼容问题」「目标封禁」「服务下线」等结论之前——先做通道对照，不要凭空归因。

## 对照步骤
1. 用 `mcp__burp__send_http1_request` 发同一个请求（同 method/path/body，Host 头一致）。
2. Burp 返回 HTTP 响应 → 本机 fetch 的 TLS/网络兼容性问题：local.64 起 src_http 已自动对 legacy renegotiation 降级重试，报错依旧时换代理出口或记录通道差异后转其他方向；不要反复空重试。
3. Burp 也无响应 → 才是目标侧封禁/下线：如实记录（记 fact，写明「双通道均无响应」），不要编造「已知兼容问题」之类无法验证的归因。
4. 结论写进 checkpoint/fact 时必须注明通道（「经 Burp 通道」「经 src_http」），父会话据此判断放行重放能否成功。

## 纪律
- 连续 ≥2 次同类失败必须停下来做通道对照或换方向，不空转重试。
- 对用户的汇报只说可验证的事实（报错原文、通道、时间），不发明「已知问题」。

<!-- lesson-meta: {"sessionId": "builtin", "vulnType": "网络层失败通道对照", "createdAt": 1788720000000, "triggers": {"keywords": ["fetch failed", "网络层失败", "legacy renegotiation", "通道", "审批失败", "不可达"], "tools": ["src_http", "src_resolve_approval", "src_test_bypass"]}} -->
