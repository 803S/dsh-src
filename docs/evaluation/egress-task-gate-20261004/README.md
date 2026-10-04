# 任务级出口闸实现验证（2026-10-04）

## 结论与范围

**仅实现并验证核心库及隔离 DSH 接入；不是生产发布，也不是全通道安全验收。**

新增 `lib/src/egress/`：严格请求/任务规范化、Jev scan-plan 评估、HMAC 请求绑定、SQLite 发送领取和预算、仅供可信控制面使用的决定接口、无审批接口的私有代理 API、mitmproxy addon、最终 spawn 网络约束函数。普通测试命令包含核心不变量测试。

未修改生产 profile、未重启生产 DSH、未安装全局证书、未恢复 Laya。

## 已实现约束

- 精确绑定 URL（含 query）、方法、语义请求头、完整 body 字节；拒绝含糊 URL、重复头、Host/长度冲突、Upgrade/任意隧道等。不按脚本名称、HTTP 方法或 URL 前缀授予权限。
- 一个有限计划一次评估；实际请求逐项匹配并消耗条目/计划预算。每 origin 跨任务/会话共享节流及单并发，不按请求再调用 Jev。
- 审批摘要绑定 session、scope/credential/policy 版本及有效期。scopeFor 必须来自可信用户授权，不得接模型自行登记的资产清单。
- Jev off/shadow/异常/未知/置信不足不能自动授权；危险语义、非读取方法、认证请求不能被“低风险”覆盖为自动许可。
- SQLite FULL 同步与事务领取；单实例独占连接。失败不退预算；未知发送结果禁止相同请求自动重试。重启撤销旧任务，并把未完成发送标为 unknown。
- SQLite 只存请求 HMAC 和额度，不存明文凭据；HMAC key 必须由宿主安全保存。计划留在控制面内存，重启后不能自动恢复批准。
- proxy API 没有 approve 接口，session/task 在服务端绑定；人工决定接口不能暴露给模型或代理。
- 非读取方法即使点击批准也返回 `SRC_GATE_WRITE_EXECUTOR_REQUIRED`，防止跳过尚未接入的写前备份、前置条件及恢复执行器。

默认上限：256 个精确请求、计划 256 KiB、单请求体 64 KiB、1000 次请求、15 分钟、每 origin 至少间隔 250 ms。不支持通配动态爬取授权。

## 真实 DSH ToolRuntime + HTTPS

复现（需本机监听与 sandbox-exec 权限，使用已安装 DSH/mitmproxy）：

```sh
node scripts/egress-feasibility/dsh-run.mjs --run --task-gate --tool-runtime-only
```

证据：`tool-runtime.json`。

- 会话：`session-` ID 见 JSON completion.sessions。
- 10 次真实 bash 调用，10 次最终启动约束；danger-full-access 文件模式仍不能直连。
- 任务评估 1 次，成功领取 3 次，记录响应 3 次。
- 靶场只收到 `GET /read`、`GET /redirect`、`GET /read`。
- 307 第二跳 `/delete`、DELETE、XML PUT、直连、Python 直连、预算外第四次请求未到达靶场。
- 合成控制秘密读取失败；本地创建/读/删除成功。
- **advisor 返回和人工决定为测试桩；不是线上 Jev 或真实 UI 身份验证。**

## 真实模型会话：失败，不能计为通过

复现命令去掉 `--tool-runtime-only`。证据：`model-failed.json`、`model-error.jsonl`。

已配置 newapi/hy4 映射的上游模型 `hy4-preview` 返回 400 `model_not_found`。零工具调用、零目标请求，因此验收失败；没有更改用户模型配置或无界重试。旧 harness 把空闲状态写为 completed，新检查以目标计数断言失败，并已修正后续 harness 对 turn/error 的状态记录。

## 未完成，禁止作为上线依据

1. `src_scan_surface`/`src_http`/其他 target transport 尚未使用此 broker。正式 host executor/provider 尚未安装；当前仅隔离 harness 包装 final spawn。
2. 现有 pending approval UI、用户命令来源验证、决定与摘要绑定尚未接入本模块。commandPlane 的隔离目前是调用契约，不是正式宿主身份验证实现。
3. 浏览器、Burp JVM、远程 MCP、PTY、Mach/Apple Events/系统进程代发，以及原生 read/edit 的控制目录保护尚未纳管/验收。
4. 未实现通用写前条件、备份/恢复/写后验证与安全的单笔高危请求执行流程。拒绝这些动作不等于完成该流程。
5. 单独的内部 ledger 尚未与既有 SRC SQLite 生命周期、证据投影和审批真相整合；未做生产凭据生命周期和多实例部署。
6. 真实 Jev 效果、真实人工允许/拒绝、主模型端到端以及常驻资源开销尚未验收。

**生产原有旁路仍存在。当前成果不能宣称完成用户要求的“所有目标高危操作都经过审批”。**

## 最终回归记录

- `npm test`：316/316 通过（含 34 个出口闸测试、1 个新增 Jev scan-plan 契约测试）。首次受沙箱 EPERM 影响的运行不计通过；允许本机监听后完整重跑通过。
- `npm run ui-src:typecheck`：通过。
- `node scripts/check-preset-consistency.mjs`：通过。
- `git diff --check`：通过。
- `npm pack --dry-run --ignore-scripts --json`：确认 Python addon 纳入包；没有发布包。
- 两次隔离 DSH 的临时 provider credential 文件均已删除；测试正常退出清理代理/服务器。
