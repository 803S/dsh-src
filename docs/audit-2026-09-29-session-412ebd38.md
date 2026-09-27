# 2026-09-29：昨晚最终 SRC 会话复核

会话：`session-412ebd38-9ca1-464a-b16a-5627a410728d`；目标 `8.147.132.32:22975`；只读审查，未重放目标请求、未修改会话数据。

## 结论摘要

昨晚会话确实暴露了新的 dsh-src 项目缺陷；不应只归因于上游模型 401/502 或宿主 retry。已经修复并纳入 local.104 后续增量：

- 只读 JSON-RPC/计算类 POST 不再因为 JSON-RPC `id` 或无认证 POST 语义被批量挂审批；
- approval token 从 10 分钟延长为 24 小时，仍 session/approval/action 绑定且一次性消费；
- tool call 失败后审批 projection 恢复原状态；
- `src_test_bypass` GET/HEAD/OPTIONS 不再输出 `body: undefined`；
- GET/HEAD 携带 body 在 src_http 入口明确报参数错误；
- Google feedback/navigation 垃圾链接不再被 keyless search 当成功结果；
- Pattern 形态校验不再把抽象 `request.url.path`/API 误判为域名或具体路径；
- src_http 自定义 Host 头明确拒绝，避免把未真实发送的 Host 当证据；
- Laya risk prompt 使用实际补全后的 headers；fallback delegate 不再伪装 self；
- OpenAPI fact 合成事件改为完整 `{id,intentId,kind,target,detail,confidence}`；
- projection pendingCalls 只跟踪可回滚的 finding/approval call，不跟踪普通/合成事件；
- 报告 URL 抽取过滤 `http://a/?` 等 Host 伪值；
- 子 agent 失败路径核对：昨晚确实调用过两次 src_recover_child，两个 child 四轮均上游 401，零工具/零 checkpoint；不是项目删除恢复工具。

## 会话证据

- 父会话 16 turns，真实 tool call 200；子 agent 两个均失败于 `401 Invalid token`。
- 父实际调用：`src_http=54`、`src_scan_surface=7`、Burp raw HTTP=23、`web_search=3`、`src_recover_child=2`；没有 397 次 bash 型死循环。
- 其中 11 个工具结果为错误，包括：
  - GET body；
  - `src_test_bypass` lossless JSON；
  - 4 次 Pattern 校验；
  - 两次过期审批 token；
  - 一次审批绕行阻断。
- 两个 intent 的 Laya delegate 均为 fallback/self/confidence=0；当前代码已将 fallback 记录为 pending/unknown，昨晚历史为旧语义。
- 运行时 SQLite 最终：2 completed intents、1 active critical finding、8 research、61 observations、5 approvals（2 approved/3 pending）、0 checkpoints；5 次 finalize 都是 `allowIncomplete=true`，不是完整无阻塞收尾。
- 最终 critical Host-header finding 的对照证据充分：正常 Host=401，Burp raw `Host: a/?`=200，`Host: a/health?`=401；但 RCE 只确认 GET 405/Allow: POST，approval-5 未批准、无命令输出，不能称为已确认 RCE。

## 宿主边界

两个 child 使用 `sensenova-6.8-flash`，父会话经历供应商 401、model_not_found、503、502、reasoning_text 协议错误和 transport 错误；这些属于宿主/上游，不修改 dsh-src。compaction 本次成功，无前次 token-cap 截断。
