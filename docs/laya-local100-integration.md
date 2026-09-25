# local.100：Laya 主决策与无 key 搜索接线

## 已实现

- dsh 原生 `web_search` 使用 `ctx.web` provider seam；SRC 不再依赖 DeepSeek native search key，新增 `src-keyless-search`，先尝试 DuckDuckGo HTML，失败再尝试 Google HTML。模型工具名仍是宿主原生 `web_search`，不是 Laya 搜索。
- SRC 组合根注册 keyless provider，并通过 profile 的 `web.searchProvider=src-keyless-search` 选择它；不修改宿主 dsh 包。
- `agent/pre-step` 接入 Laya `next-action`：每个 commander step 根据 SRC 状态生成有界候选，Laya 选择后以 durable user message 注入主模型；候选只是建议，工具/审批/范围硬闸仍优先。
- `tools/pre-execute` 对 bash、MCP、Playwright/browser 工具做 Laya advisory telemetry；不阻止、不替换、不剥夺 bash/curl 能力。原有 dsh shell sandbox/approval 和 SRC HTTP 审批继续各自生效。
- Laya telemetry 补 source/fallback/latency/probabilities；next-action 与 tool-advisory 单独记录。`laya-client` 每次调用惰性读取 `DSH_SRC_LAYA_URL`，运行时换 daemon 地址不固化。
- `start-dsh-web.sh` 默认开启 `DSH_SRC_LAYA_NEXT/DELEGATE/SKILL/DECISION=on`；代码默认仍保持 off/on 的测试兼容性，显式启动脚本才开启生产行为。risk Laya 不得绕过 `classifyHttpRequest` 审批硬闸。

## 有意未做

- 没有新建 HTB/Lab 模式；HTB 仍只是 SRC 的一个真实授权目标。
- 没有用 Laya 代替搜索 provider；Laya 决策“是否/选择何种下一步”，web_search 由宿主 provider 执行。
- 没有自动强制 skill 运行；Skill Selector 仍需可观测推荐→读取→结果闭环，自动运行脚本仍受既有人工审批。
- browser-loop 仍不拥有 page/context；普通 browser MCP 通过 advisory 观测，独立 candidate loop 不复制宿主生命周期。

## 验收

- npm test：229/229。
- preset consistency、TS 5.9.3 typecheck、语法、diff check 通过。
- 生产 profile 已同步 local.100；当前 Web 由 `start-dsh-web.sh` 重启后应带 `DSH_SRC_LAYA_*` on。重启前确认 session.list 无 running。
- keyless provider 有 DuckDuckGo/Google fallback 单测；不接触真实目标。
