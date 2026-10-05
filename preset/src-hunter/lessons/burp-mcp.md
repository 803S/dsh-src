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
5. 直接发包使用原生 `send_http1_request(content,targetHostname,targetPort,usesHttps)` 或 `send_http2_request(headers,pseudoHeaders,requestBody,targetHostname,targetPort,usesHttps)`。HTTP1 使用 CRLF 和末尾空行；有请求体必须给出准确字节长度的 Content-Length。HTTP2 不接受 content，pseudoHeaders 必须有 :method、:scheme、:authority、:path。只支持单笔明确报文，不支持走私、歧义分帧或额外隐藏请求。
6. 两种发送工具均由 SRC 冻结实际参数后经过范围、Jev/硬规则和现有人工审批；低风险读取可直接执行，高危/未知返回 sent:false 和审批编号。高危缺少安全材料时，先 src_egress_prepare 补齐，再由用户批准新单。批准后宿主执行保存的原生 Burp 调用，**不要让模型重发**；前置/后置核对明确使用现有受控 HTTP。MCP 成功不等于 HTTP 或业务成功；超时/断线不得盲目重试。
7. 信任已配置 Burp 按参数执行，不监管用户手工 Burp 或扩展产生的额外行为。Burp 可协商 HTTP/2；冻结的是传入工具的参数，不承诺线上逐字节报文不变。Repeater 建页签、引擎控制及其他未适配主动工具仍不可用，不能换通道绕过拒绝。
8. Burp 未开时这些工具不可用——走 HAR/raw 文件导入兜底。React chunk 404 类问题优先用此通道解决，不做静态反推。

## 纪律
- auth-session 类用户待办创建前先 regex 试拉一次（用户可能早已挂着 Burp 浏览过目标），拉到流量直接 `src_import_traffic(mode=mcp)` 免建待办。

<!-- lesson-meta: {"sessionId": "builtin", "vulnType": "Burp MCP 通道", "hook": "查流量必须 get_proxy_http_history_regex 过滤；看不到 burp 工具≠无流量，下回合重试", "createdAt": 1788720000000, "triggers": {"keywords": ["burp", "proxy history", "get_proxy_http_history", "桥降级", "Repeater", "React chunk", "拉包"], "tools": ["src_import_traffic", "src_user_todo"]}} -->
