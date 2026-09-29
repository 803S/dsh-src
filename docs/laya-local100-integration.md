# local.100：Laya 与无 key 搜索接线（历史快照）

> 当前行为以 [local.105实施记录](implementation-2026-09-29-laya-repair.md) 为准。旧版调用和字段存在不等于生产收益；next-action不承担规划，分工提示不代表实际派发，Skill证据关联不代表因果收益。搜索代理上下文现位于tools/execute，不是pre-execute。

## 已实现

- dsh 原生 `web_search` 使用 `ctx.web` provider seam；SRC 不再依赖 DeepSeek native search key，新增 `src-keyless-search`，先尝试 DuckDuckGo HTML，失败再尝试 Google HTML。模型工具名仍是宿主原生 `web_search`，不是 Laya 搜索。
- SRC 组合根注册 keyless provider，并通过 profile 的 `web.searchProvider=src-keyless-search` 选择它；不修改宿主 dsh 包。
- Laya 职责收敛：风险审批 `risk-grade` advisory、主/子 agent `delegate/self`（在 src_add_intent 决策点）和 Skill Selector 均保留；生产主循环不再使用 `next-action`，不向 commander 注入 `src_submit` 建议。
- `tools/pre-execute` 仅保留 web_search 的 session proxy 注入；不再对 bash/MCP/Playwright 额外调用 Laya。原有 dsh shell sandbox/approval 和 SRC HTTP 风险审批继续各自生效。
- Laya telemetry 补 source/fallback/latency/probabilities；next-action 与 tool-advisory 单独记录。`laya-client` 每次调用惰性读取 `DSH_SRC_LAYA_URL`，运行时换 daemon 地址不固化。
- `start-dsh-web.sh` 生产默认开启 `DSH_SRC_LAYA_DELEGATE/SKILL/DECISION=on`，关闭 `DSH_SRC_LAYA_NEXT`；代码默认 risk/delegate off、skill on。risk Laya 只做 advisory，不得绕过 `classifyHttpRequest` 审批硬闸，也不得阻断普通 GET/认证基线。

## 有意未做

- 没有新建 HTB/Lab 模式；HTB 仍只是 SRC 的一个真实授权目标。
- 没有用 Laya 代替搜索 provider；Laya 决策“是否/选择何种下一步”，web_search 由宿主 provider 执行。
- local.101/102 已补 recommendationId→skill.read→下一工具→evidence outcome 旁路漏斗；没有自动强制 skill 运行，能力脚本仍受既有人工审批。
- browser-loop 仍不拥有 page/context；普通 browser MCP 通过 advisory 观测，独立 candidate loop 不复制宿主生命周期。

## 验收

- npm test：230/230。
- preset consistency、TS 5.9.3 typecheck、语法、diff check 通过。
- 生产 profile 已同步 local.100；当前 Web 由 `start-dsh-web.sh` 重启后应带 `DSH_SRC_LAYA_*` on。重启前确认 session.list 无 running。
- keyless provider 有 DuckDuckGo/Google fallback 单测；不接触真实目标。
