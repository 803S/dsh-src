# Burp MCP 工具面（regex 拉包 / 桥降级 / Repeater 回写）

## 触发场景
- 需要查用户浏览器的目标流量（React module federation chunk、找回密码等静态扫不到的 API 就在 proxy history 里）。
- 需要把 POC 写回 Burp 人工复核（Repeater 页签 / 直发请求验证）。
- 工具表里看不到 mcp__burp__* 工具，或调用报桥降级/重连窗口。

## 用法
1. 查浏览流量必须用 `mcp__burp__get_proxy_http_history_regex(regex=<目标host或域名正则>,count,offset)` 按目标过滤后喂给 `src_import_traffic(mode=mcp)` 统一落库。**禁止用不带 regex 的 `mcp__burp__get_proxy_http_history` 判断「有没有包」**——它按 offset 从最旧记录返回且不告知总条数，拉到的几乎必然是无关旧流量，据此断言「Burp 里没有目标流量」是错误结论。
2. 断言「Burp 无流量」前必须引用工具调用证据（工具名+regex+count+offset+返回条数），且至少先用 regex 版对目标 host 查一次。
3. 工具表里看不到 mcp__burp__* 工具 ≠ Burp 无流量：那是自愈桥降级（SSE 空闲断开后的重连窗口），应报告「Burp MCP 暂不可用」并下回合重试，不得当作目标无流量的证据；若出现 burp_status 哨兵工具，调用它确认桥状态。
4. 从 proxy 流量提取 Cookie/Authorization 完整构造认证画像（auth-profile fact，可直接复用）。
5. POC 写回 Burp 人工复核：`mcp__burp__create_repeater_tab(content,targetHostname,targetPort,usesHttps,tabName?)`（raw 请求要 CRLF）建 Repeater 页签；或 `mcp__burp__send_http1_request` / `send_http2_request(content,targetHostname,targetPort,usesHttps)` 直发验证。
6. Burp 未开时这些工具不可用——走 HAR/raw 文件导入兜底。React chunk 404 类问题优先用此通道解决，不做静态反推。

## 纪律
- auth-session 类用户待办创建前先 regex 试拉一次（用户可能早已挂着 Burp 浏览过目标），拉到流量直接 `src_import_traffic(mode=mcp)` 免建待办。

<!-- lesson-meta: {"sessionId": "builtin", "vulnType": "Burp MCP 通道", "createdAt": 1788720000000, "triggers": {"keywords": ["burp", "proxy history", "get_proxy_http_history", "桥降级", "Repeater", "React chunk", "拉包"], "tools": ["src_import_traffic", "src_user_todo"]}} -->
