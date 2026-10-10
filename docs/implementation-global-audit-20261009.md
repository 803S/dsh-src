# 全局审计方案实施记录

日期：2026-10-10。基线方案：`docs/global-audit-and-optimization-plan-20261009.md`。

## 本轮已实施

- 待办：`intentId`、`targetUrl` 在新建和更新时持久化；传入未知 `userTodoId` 明确拒绝，不再误建新行；UI 测试覆盖完成/放弃入口和完整 URL。
- 收官：blocked intent 已有 pending approval 时不再机械要求复制用户待办。
- UI：审批卡测试改为验证当前自然语言实际语义和折叠技术详情；`ui-src:test` 通过。
- 原工具治理：新增 `lib/src/bash-guard.js`，通过宿主 `tools/pre-execute` 接线。生产启动脚本默认 `DSH_SRC_BASH_GATE=ask`；普通测试/临时关闭可设 `shadow` 或 `off`。检测 scope 目标的 curl PUT/POST/DELETE/PATCH、上传、危险本机命令和扫描器；ask 使用宿主 allowed-once 审批，shadow 只记录 `bash.gate` telemetry。静态 shell 解析不是沙箱，变量拼接/base64/脚本仍需操作系统级隔离。
- 大状态输出：生产启动脚本默认 `DSH_SRC_STATE_VERSION=2`，`src_state` 默认按启动环境输出 summary；legacy 仍可显式 `detail=legacy`，库默认保留 v1 兼容以避免离线夹具隐式漂移。summary 只传索引/计数，正文用 `src_get_evidence` 分页读取。
- 发布/测试：bash guard 单测纳入 npm test；585 个原有测试和新增 6 个 bash 测试通过；UI typecheck/build/test 通过。

## 本轮真实主动验证计划/状态

使用合成 fixture 和一个新 dsh 会话主动触发：

1. 创建 intent 与 `src_user_todo`，验证 `intentId/targetUrl` 落库；用未知 ID 更新应失败。
2. 通过 bash 执行本机只读命令，确认不拦；通过 scope 目标的 `curl -X DELETE`，确认 ask 闸出现自然语言审批且未发送，只有批准后单次执行。
3. 调用 `src_state`，确认默认返回 v2 summary 而不是全量 facts/observations。

若上游 reasoning/quota 中断，记录已完成的工具调用和未完成项，不将会话失败算作验收成功。

## 尚未完成的方案项

- 宿主 GenericCommandCard 对旧历史大摘要的有界渲染：A/B 已证明必要，但需要宿主扩展点或明确授权的兼容补丁；本轮未直接改全局宿主 bundle。
- 报告 stale 指针/自动阻断、同一 tgz 的完整外发发布闭环、数据库索引/dirty-key/正文引用迁移、完整 todo 通知投递状态、全工具操作统一执行器和独立复核自动派发，仍需单独实施和真实验收。
- bash 静态闸只覆盖常见显式命令；不是防对抗边界。高风险真实环境仍应使用网络/OS sandbox。

## 验收约束

本记录不把 npm 通过、零 pageerror 或人工批准写成业务安全证明。真实目标请求、旧审批、旧报告未被本轮自动重放或改写。