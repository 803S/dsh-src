# 剩余架构条件验证：HTTPS、权限模式、控制接口

2026-10-04。仅本机合成靶场，未改生产 DSH、系统代理/信任或安装依赖。使用已安装 mitmproxy 12.2.3。

## 已证实

- 19 个确定性场景保留 baseline 对照：同一目标/本地 TCP 控制端/Unix socket 未约束时可达，增加约束后对应直连失败。
- HTTPS 经 mitmproxy 可以取得方法、路径、完整 JSON/XML body；固定 fixture 策略拒绝 XML PUT；307 跳转后 GET /delete 再次被拒，目标只有初次 /redirect。
- 客户端仅信任测试用公开 CA；上游仍验证测试服务器证书。没装系统 CA，也未全局关闭 TLS 验证。未提供测试 CA 的客户端报 curl 60。
- 完整访问模式的原生直连成功；独立进程启动保护后直连失败、代理正常，本地 workspace 外临时文件读写删除成功。read-only 仍拒绝写文件，代理仍能读。
- 网络限制本身挡不住读取同 UID 控制文件。仅对合成控制目录加保护后读取被拒。该测试不证明任意符号链接/硬链接或其他文件工具已经全覆盖。
- 真实 DSH ToolRuntime 验证 session-e0584033-ae9c-4787-99a0-4a58f56c11a3：8 次工具调用、8 次最终 spawn 保护。目标收到 GET /read、POST /compute、GET /redirect；没有 PUT /settings、GET /delete 或其他直连。0 模型请求、0 Jev 请求。

## 明确保留的失败与限制

- 首次真实 DSH 启动（I8qvvZ）因其 watcher 尝试监听测试 Unix socket 崩溃；在创建主模型会话前失败。将 socket 移到 DSH_HOME 之外后排除测试环境问题。没有将失败计为通过。
- 主模型会话 session-aa0e7c81-73b5-4405-8840-886581e9ca14 确实保存了指定 prompt，但模型声称没有任务、检查环境并创建示例代码，没有执行指定目标请求。8 steps、9 tools、144273 累计 tokens，0 目标/代理请求。**模型驱动验收失败/未覆盖**，不是零旁路证明。不推测是模型、供应商还是消息适配造成，需另查。
- 随后使用真实 DSH ToolRuntime 直接执行固定命令矩阵，没再无限重复付费主模型。其通过证明执行链，而非主模型任务理解能力。
- 本次代理采用固定合成策略，不是 Jev；未测试真实人工审批、重启执行状态、吞吐或生产事故恢复。
- 未测试 HTTP/2/QUIC、IPv6、原始 UDP、Apple Events/Mach IPC、浏览器/Burp/远端 MCP、完整提权审批 UI、OS 权限逃逸。试验设置了独立会话的 full-access 模式，不是伪造生产审批。
- 进程启动接入使用隔离宿主内的实验性 shell.spawnSpec 包装；正式版本必须以版本化 SRC executor/provider 实现并做兼容检查。

## 复现

```sh
node scripts/egress-feasibility/extended-probe.mjs
node scripts/egress-feasibility/dsh-run.mjs --run --tls-full-access --tool-runtime-only
# 付费真实模型复验（本次记录为未覆盖，不能把进程退出0当通过）：
node scripts/egress-feasibility/dsh-run.mjs --run --tls-full-access
```

需允许回环端口与原生 sandbox-exec。执行脚本没有修改系统设置；临时 mitmdump 与靶场已退出，临时模型凭据已由 finally 清理。结果见本目录 JSON。
