# handoff-output-first 实施进度

日期：2026-10-11。基线：`implementation-handoff-output-first-20261011.md`。本记录补充实际代码实施，不替代原交接文档。

## 已完成

### 第一批 A：公共研究资料通道

新增 `src_read_public_source` 和 `lib/src/public-source.js`：

- 只允许 HTTPS GET；
- 默认可信来源为 NVD/CVE/GitHub 安全公告等精确主机，可用 `DSH_SRC_PUBLIC_SOURCE_HOSTS` 增加精确主机；
- 不自动加入授权目标 scope；
- 不携带目标认证头或请求正文；
- 不跟随重定向；
- DNS 解析后的 IPv4/IPv6 私网、回环、保留、文档网段拒绝；
- 返回有界正文、source URL、status、truncated/sourceChars；
- 公共资料不可达与目标主动请求失败保持不同错误来源。

原 `src_fetch_policy` 保留，避免破坏既有厂商规则流程。

### 第一批 B：审批结果直接读取

`src_get_evidence` 现在支持精确 `approval-N`：

- 返回审批状态、执行状态、method/URL、用户决定、响应状态；
- 返回真实 `responseEvidenceId`，如果当前视图没有该证据明确报告，不按相似 URL 或最近请求猜；
- 返回已保存的 responseBody；没有正文时明确显示未保存；
- 仍可在同一调用中用 responseEvidenceId 再读取 observation/fact 正文；
- 没有重发请求，也不要求用户重新贴报文。

### 第一批 C：隔离研究基准

新增 `research-benchmark.js` 确定性基准辅助：

- 解析/比较常见版本号；
- 由公告固定版本范围产生正例/负例；
- 强制 HTTPS 公告来源；
- 显式前提；
- `createsFinding=false`、`networkRequests=0`，不把版本命中自动当漏洞。

测试样本使用 CVE-2025-58360 的公告 URL、GeoServer 2.25.5 正例和 2.25.6 负例，仅做离线范围判断，不发请求。

### 第二批 JEV 接线第一步：bash 候选信号不再直接当最终判断

- bash 候选信号会把完整命令、cwd、目标、scopeOrigin、goal、intent、operationId 和信号交给 JEV risk-grade；
- JEV fallback/unknown/high 或本机破坏性命令仍需人工确认；
- JEV low 只是低影响候选，不授予 shell 网络权限；没有当前 egress execution/task 时，scope 目标命令会提示先建立精确 `src_egress_plan`，真正出网仍受 broker scope、预算、原文和任务绑定；
- 宿主 `ToolRuntime` 测试验证拒绝不执行、allowed-once 恰好执行一次；隐式 curl POST 也覆盖；
- 真实模型会话仍可能受上游 quota/429 阻断，未将入队算作 E2E 成功。
- 硬破坏命令仍独立硬闸；Jev不能把删库/格式化改成低风险。

## 验收

- `npm test`：595/595；
- 公共资料、approval-N、版本正负例、bash/JEV接线定向测试通过；
- `git diff --check`、源码卫生、preset 检查通过。

## 尚未完成

- JEV 统一操作评估还未覆盖脚本正文/文件版本/浏览器/Burp/MCP 的同一 operationId 全链路；本批只完成 bash 候选上下文接入，未假称所有入口已统一；
- 待办通知状态、失败重投、实际后续动作仍未全部完成；
- 原工具输出/动态动作与统一 broker 的 operation evidence 仍需继续收拢；
- 尚未执行真实公网目标验证、旧审批重放或旧靶场请求；
- 本轮未处理用户明确保留的未提交文件和 artifacts，不做 reset/覆盖。
