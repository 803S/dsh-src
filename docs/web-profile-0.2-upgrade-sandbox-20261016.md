# web profile → dsh 0.2.1-rc.1 沙盒可行性验证（2026-10-16）

本轮目标是第 3 步「web profile 升级到 0.2.1-rc.1」的前置沙盒验证。**没有触碰真实 web profile**：
真实 `~/.dsh/profiles/web/` 的 `package.json`、`pnpm-workspace.yaml`、`cordis.patch.yml` 与
`node_modules/` 均未改动，真实 3080 监听进程（PID 62164）保持运行。

沙盒位置：`/tmp/wsb`（`DSH_HOME=/tmp/wsb/home`，profile 目录 `/tmp/wsb/home/profiles/web`，
`/tmp/wsb/home/profiles/node_modules` 是指向真实 0.1 farm 的符号链接，用于复现真实解析环境）。

---

## 1. 结论摘要

| 结论 | 证据 |
| --- | --- |
| profile-local 安装 `@deepseek-ai/dsh@0.2.1-rc.1` 可完整落地（304 个 `@deepseek-ai/*` 包） | §2.1 |
| 0.2 host 能启动我们的 profile，并**零** incompatible/禁用行 | §2.3、§2.4 |
| 我们的插件（`@lihua_dis/dsh-src@0.1.0-local.139` tgz）在 0.2 host 下宿主侧真实启动 | §2.4（自建 `storages/src-sessions.db`） |
| 0.2 Web UI 可渲染（无页面/控制台错误） | §2.5 |
| `dsh-session-history@1.0.0` 是硬阻塞：它是 0.1-only，且会把自己的 0.1 依赖闭包 hoist 进 profile 根，反噬 0.2 行 | §3.1 |
| 仓库内 3 个脚本在 0.2 host 下不可用（幂等重启守卫/就绪探针/UI 测试主题源） | §4 |
| 我们的 `package.json` peer 范围会让 `@deepseek-ai/dsh-invariants` 解析到 0.1.0-rc.8 | §3.3 |

**净结论：升级路径可行，但必须先解决 `dsh-session-history` 的取舍（删除或移植）并同步改造启动脚本，
才能动真实 profile。**

---

## 2. 实测证据

### 2.1 安装

沙盒 `package.json`（与真实 profile 的差异：host 换成 0.2、agent-teams 升到 `0.1.24-rc.1`、
插件用 `.139` tgz 代替仓库目录、去掉 `dsh-session-history`）：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "0.2.1-rc.1",
    "@lihua_dis/dsh-src": "file:/Users/lihua-dis/Downloads/dsh-plugins/lihua_dis-dsh-src-0.1.0-local.139.tgz",
    "@nanmicoder/dsh-agent-teams": "0.1.24-rc.1",
    "open-sea-skin": "file:/Users/lihua-dis/.dsh/plugins/open-sea-skin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@lihua_dis/dsh-src",
        "open-sea-skin",
        "@nanmicoder/dsh-agent-teams"
      ]
    }
  }
}
```

`pnpm-workspace.yaml`（`autoInstallPeers` 是关键，见 §3.2）：

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: true
strictPeerDependencies: false

overrides:
  '@deepseek-ai/dsh-invariants': 0.2.1-rc.1
```

结果：`pnpm install` 约 4~5 分钟，产出 `node_modules/`≈488 MB、`@deepseek-ai/*` 304 个包，
其中 **0 个 0.1.x 版本**（`libreoffice-kit`、`node-addon-system` 等非 `@deepseek-ai` 的 0.1.x 与本主题无关）。
`node node_modules/@deepseek-ai/dsh/lib/bin.js --version` → `0.2.1-rc.1`。

pnpm 侧注意项：脚本若不加 `allowBuilds`/`onlyBuiltDependencies` 批准，
`node-pty`、`koffi`、`@deepseek-ai/dsh-subprocess-local` 等构建脚本会被忽略（终端/PTY 能力可能缺失），
真实升级前需要显式批准。pnpm 11 还会自动往 `pnpm-workspace.yaml` 写入很长的
`minimumReleaseAgeExclude` 列表，需接受该重写或显式配置。

### 2.2 未做 peers 安装时（`autoInstallPeers: false`）会直接起不来

`node .../dsh/lib/bin.js --version` 报
`Cannot find package '@deepseek-ai/cordis-plugin-group' imported from .../dsh-app-boot/lib/index.js`，
因为 `dsh-app-boot` 的 peers（`cordis-plugin-group ~1.0.5`、`cordis-plugin-include ~1.0.10`、
`cordis-plugin-loader ~1.0.6`、`cordis ~4.0.5`、`dsh-launch-environment 0.2.1-rc.1`）不在 profile 树内。
若退回「靠父级 0.1 farm 提供 peers」的现状，能启动，但 peers 版本全部偏低：
farm 里 `cordis-plugin-group@1.0.1`、`cordis-plugin-include@1.0.6`、`cordis-plugin-loader@1.0.2`、
`cordis@4.0.1`、`dsh-launch-environment@0.1.0-rc.8`、`dsh-home-paths@0.1.0-rc.8`——
满足不了 0.2 的 `~1.0.5 / ~1.0.10 / ~1.0.6 / ~4.0.5 / 0.2.1-rc.1` 要求。
**故 0.2 profile 必须自带 peers。**

### 2.3 组合配置树检查（不启动进程）

```
DSH_HOME=/tmp/wsb/home node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config
```

- exit 0，stderr 空，1307 行组合树；
- `incompatible|disabling` 命中 **0** 次；
- 全文没有 `dsh-workflow-worker-thread`、`dsh-client-runtime`、`dsh-client-ui-primitives`、`dsh-invariants` 等 0.1-only 名；
- 我们的行全部挂载：`ui-src`、`storage-src-sqlite`、`src-domain-admin`、`src-preset-root`、`src-egress`、`src-bash-executor`；
- `preset-src-hunter` 指向 `./node_modules/@lihua_dis/dsh-src/preset/src-hunter/agent-02.cordis.yml`
  （即 local.137 的 0.2 变体），tgz 内确认包含该文件；
- profile patch 层的 4 项（burp / fofa / playwright MCP、`credentials.path=.credentials-web.yaml`）均已生效。

### 2.4 真实启动

```
DSH_HOME=/tmp/wsb/home node node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 3181
```

启动日志（全文）只有 burp 桥、playwright MCP 与 `dsh web: http://127.0.0.1:3181/?token=...`，
**没有一行 plugin 错误或禁用**。同时沙盒 DSH_HOME 下出现了
`storages/src-sessions.db` + `-wal` + `-shm`，证明 `@lihua_dis/dsh-src/storage-sqlite` 在 0.2 host 下
真实执行（插件宿主侧启动成功，不只是“没报错”）。

### 2.5 Web UI 渲染

Playwright（`~/.dsh/capabilities/playwright`）打开 `http://127.0.0.1:3181/?token=...`：
HTTP 200 SPA、`pageerror` 0 条、console error/warning 0 条，截图 `/tmp/wsb/web02-boot.png`
（显示 0.2 预览版欢迎界面）。

---

## 3. 机制性发现（会直接影响升级方案）

### 3.1 `dsh-session-history` 是硬阻塞（两类问题叠加）

1. **自身不兼容**：0.2 报
   `Plugin @deepseek-ai/dsh-session-history@1.0.0 is incompatible with dsh 0.2.1-rc.1:
   requirements {"@deepseek-ai/dsh-client-runtime":"^0.1.0-rc.6","@deepseek-ai/dsh-client-ui-primitives":"^0.1.0-rc.6"}`
   （这两个包在 0.2 全线不存在）。
2. **拖入 0.1 闭包并反噬 0.2**：`autoInstallPeers: true` 时，pnpm 为了满足它的 peers 会把
   `@deepseek-ai/dsh-client-runtime@0.1.0-rc.8` 及其整条 0.1 闭包（`dsh-host-apiproxy`、
   `dsh-api-remotes`、`dsh-session-projection-cache`、`dsh-session-reference` …）hoist 到 profile 根目录。
   于是按名解析先命中根目录的 **0.1** 副本，0.2 行被禁用：

   ```
   dsh: disabling profile plugin row "session-projection-cache": Plugin @deepseek-ai/dsh-session-projection-cache@0.1.0-rc.8 is incompatible with dsh 0.2.1-rc.1
   dsh: disabling profile plugin row "api-remotes": Plugin @deepseek-ai/dsh-api-remotes@0.1.0-rc.8 is incompatible with dsh 0.2.1-rc.1
   dsh: disabling profile plugin row "session-history": Plugin @deepseek-ai/dsh-session-history@1.0.0 is incompatible with dsh 0.2.1-rc.1
   ```

   把该依赖从沙盒 `package.json` 移除并重装后，上述三行全部消失，
   根目录 `@deepseek-ai/*` 的 0.1 副本从 2（含 `dsh-invariants`）降为 0（配 §3.3 的 override）。

即：**只要留着 `dsh-session-history`，即使它的行被禁用，升级后的 web 也会损失
`api-remotes` 与 `session-projection-cache` 两条 0.2 原生能力。** 这不是可选优化。

### 3.2 0.2 对不兼容插件是「逐行禁用」，不丢整文件

`dsh-session-history` 是通过 `cordis.patch.yml` 的 `insert` 注入的。0.2 只禁用该行，
同文件的 burp/fofa/playwright/credentials 四项全部正常生效（`--dump-config` 与启动日志均可证）。
这与 local.137 时期遇到的 **preset include 整体失效**（`its included file ... reaches an incompatible plugin,
and that file is never rewritten`）是两种不同语义：include 触雷会牵连整个文件，patch 的 `insert` 只牵连该行。
现行「0.2 预设改用 `agent-02.cordis.yml`」的做法在 0.2 下继续成立。

### 3.3 我们自己的 peer 范围会把 `dsh-invariants` 拉成 0.1

`@lihua_dis/dsh-src` 声明 `peerDependencies["@deepseek-ai/dsh-invariants"] = ">=0.1.0-rc.6"`，
pnpm 据此解析到 `0.1.0-rc.8` 并 hoist 到 profile 根目录（`pnpm why` 显示唯一引用方就是我们）。
虽然本沙盒实测没让它禁用任何 0.2 行，但它让「插件加载的 invariants」与「host 内的 invariants」变成两个版本，
属于版本错配隐患。真实升级需在 profile 侧加 override 固定为 `0.2.1-rc.1`（本沙盒已用该 override 消除）。

---

## 4. 必须同步改造的仓库文件（当前在 0.2 host 下会坏）

| 文件 | 0.1 假设 | 0.2 实测结果 |
| --- | --- | --- |
| `scripts/check-web-idle.mjs` | `POST /api/session.list` 单方法 RPC | 0.2 网关只提供 `/api/remote.mux` 多路复用流，`/api/session.list` → `not found`；无 token → 401。**空闲守卫在 0.2 下必然失败** |
| `scripts/start-dsh-web.sh` | 就绪探针 `GET /management.html` == 200 | 0.2 下 `/management.html` → **404**（该页面不复存在），就绪等待会超时并 `exit 1` |
| `scripts/start-dsh-web.sh` | `spawn('dsh', ['web','--no-open'])` 用全局 0.1 host | 需改为 profile-local host：`node ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open`，否则 profile 内的 0.2 依赖不会被使用 |
| `scripts/test-ui-settings.mjs` | 主题 CSS 从 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`（0.1 farm）提取 | 0.2 profile 下该路径仍会解析到 0.1 farm（版本错位），需改为取 profile 内 0.2 主题或容忍两种 |

0.2 的鉴权方式已从「回环免鉴权」变为 **cookie**：访问 `/?token=<启动日志里的 token>` 会 303 并种下
`dsh-auth-*` cookie，之后 `GET /` 返回 200。新的就绪探针可据此实现（无 token 时 `/` 返回 401 也可作为“服务已监听”的信号）。

---

## 5. 待决策（进入真实升级前必须拍板）

1. **`dsh-session-history` 的取舍**
   - A. 在 0.2 的 web profile 中移除该插件与 `cordis.patch.yml` 中的 `insert` 行（推荐）。
     0.2 自带 `dsh-client-ui-sidebar-browser` / `dsh-experimental-session-search` / `dsh-tool-session-query`，
     会话浏览/搜索/归档由内置能力覆盖；仓库里的 `plugins/dsh-session-history/`（vendored 源码）与
     `~/.dsh/plugins/dsh-session-history/` 都不删除，随时可回退。
   - B. 把它移植到 0.2（重写 client 侧注入与宿主 RPC）——工作量明显大于本计划范围。
2. **是否现在执行真实切换**（写入 `~/.dsh/profiles/web/node_modules/` + 改启动脚本 + 重启 web）。
   计划原文在「web 0.2 验收通过」后才删 Option R 双视图，属于需要用户确认的闸门。
3. **重启守卫的替代方案**：0.2 无单方法 RPC。可选
   (a) 由我们的插件暴露一个只读「是否忙」RPC（需要新的 0.2 通信方式）；
   (b) 读 0.2 自己的会话索引（尚未确认库/字段）；
   (c) 0.2 下不自动 kill，改为显式 `--force` 才重启（最保守）。

---

## 6. 未验证 / 已知风险

- **未做真实会话**：沙盒 DSH_HOME 没有凭据与模型，因此没有跑起一轮对话，
  工具清单（`src_*` 数量）、审批卡、Jev 记录链路、`src_http` 行为在 0.2 web 下**尚未验收**。
  这是 Option R 删除前的必须项。
- **凭据文件格式未验**：web profile 现在指向 `.credentials-web.yaml`（0.1 平铺布局）。
  0.2 的 `dsh-credentials-local` 期望 `version:1` 嵌套布局，切换后需要验证该文件能否被 0.2 读取
  （可考虑切换后与 App 共用 `~/.dsh/.credentials.yaml`，但会引入两个 0.2 进程并发写同一文件的问题）。
- **构建脚本未批准**：`node-pty` 等未 build，终端/PTY 能力可能缺失。
- **真实解析环境仍在**：真实 profile 的父级 `~/.dsh/profiles/node_modules` 是 0.1 farm，
  0.2 树里若缺任何名字仍会静默回落到 0.1（本沙盒已用符号链接复现该条件）。
- **真实 3080 监听进程是 PID 62164（已运行 2 天）**，而 PID 96582 是另一个 8 小时前启动、
  未监听 3080 的重复 web 实例（日志里 `[dsh-src] domain 'src' already open elsewhere` 来自它与前者的冲突）。
  切换前建议先厘清该重复实例，避免重启后两条宿主同时占用存储。
- 沙盒目录 `/tmp/wsb` 保留用于复跑；`/tmp/wsb/dump.yml` 为组合树快照，`/tmp/wsb/web02-boot.png` 为 UI 截图。

---

## 7. 真实切换执行记录（2026-10-18）

用户决策：**「如果会导致插件出问题那就不切，没啥问题或者有正向提升那就切」**。沙盒已证明无破坏且能力不退，
故本轮完成真实切换并按验收结果收口。

### 7.1 做了什么

| # | 动作 | 结果 |
| --- | --- | --- |
| 1 | 备份 `~/.dsh/profiles/web/{package.json,pnpm-workspace.yaml,pnpm-lock.yaml,cordis.patch.yml}` | `~/.dsh/backups/web-profile-0.1-20261018-101048/`（4 文件，原样可回退） |
| 2 | 重写 profile `package.json` | 依赖改为 `@deepseek-ai/dsh@0.2.1-rc.1` + `@lihua_dis/dsh-src`（file:，随 `deploy.mjs`/`pnpm install` 复制）+ `@nanmicoder/dsh-agent-teams@0.1.24-rc.1` + `open-sea-skin`；**移除 `dsh-session-history`** |
| 3 | 重写 profile `pnpm-workspace.yaml` | `nodeLinker: hoisted`、`autoInstallPeers: true`、`strictPeerDependencies: false`、`overrides['@deepseek-ai/dsh-invariants']=0.2.1-rc.1`、`allowBuilds`（node-pty/koffi/protobufjs/@google/genai/dsh-subprocess-local = true） |
| 4 | `cordis.patch.yml`：删 `session-history` 的 `insert` 行 | 原位留注释说明原因与回退路径（源码与 `~/.dsh/plugins/dsh-session-history` 均未删） |
| 5 | `cordis.patch.yml`：补 0.2 环境配置三段（`llm-pi-ai` provider 段 / `agent-default-model` / `agent-preset-registry`） | 0.1 时代这三段来自全局 `~/.dsh/settings.yaml`；0.2 只认 profile patch 层。**缺这段时 web 会退回 `deepseek-official/deepseek-flash` 并报「API 密钥无效」** |
| 6 | `cordis.patch.yml`：订正「凭据分家」注释 | 实测 `.credentials-web.yaml` 已是 `version:1` 嵌套布局且 0.2 能读，分文件如今只为「App 与 web 各持一份」，不再是格式兼容问题 |
| 7 | `cd ~/.dsh/profiles/web && pnpm install` | 4.6s（store 已有全部 tarball）；`@deepseek-ai/*` **304 个、0 个 0.1.x**；`node_modules` 602 MB；`dsh-session-history` 已不在树内 |
| 8 | `node .../dsh/lib/bin.js --version` / `--dump-config` | `0.2.1-rc.1`；dump exit 0、stderr 空、**1392 行**、`incompatible\|disabling` 命中 **0 次**、全文无 0.1-only 包名；`ui-src`/`storage-src-sqlite`/`src-domain-admin`/`preset-root`/`preset-src-hunter` 全部挂载，preset include 指向 `agent-02.cordis.yml` |
| 9 | 重写 `scripts/start-dsh-web.sh` | 用 **profile 自带 host**（`~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open`）；就绪探针改 `GET /`（401/200 皆算监听）；等日志里的 token URL；回报 `disabled_plugin_rows`；只杀命令行匹配 `dsh/lib/bin.js*web*` 的监听 PID |
| 10 | 重写 `scripts/check-web-idle.mjs` | 两层：0.1 `POST /api/session.list` → 0.2 读 `session_projcache/sessions/*.json` 的 `turnBoundary.openTurnStartSeq`（**只有它算忙**；首次重启时曾把 `sessionStats.openStep` 也当忙，被 70 份崩溃残留投影误判为忙而拒绝重启——实测 486 份真实投影里 `openTurnStartSeq` 非空 0 份、`openStep` 非空 70 份，故只认前者，陈旧 `openStep` 降为 `staleOpenSteps` 诊断计数，并在 busy 行投影文件超 1 小时未更新时提示可用 `DSH_WEB_FORCE=1`）；都不可用 **fail-closed**（exit 3，需 `DSH_WEB_FORCE=1`） |
| 11 | `scripts/test-ui-settings.mjs` 主题来源改为 profile 内 0.2 主题（web→desktop→0.1 farm 依次回退） | 0.2 主题变量名同款，解析出 19083 字节默认主题 |
| 12 | 清理重复实例 | PID 96582 查明是 **`DSH_HOME=/tmp/probe16` 的遗留探针 web（3081）**，已 kill；真实 0.1 web 是 PID 62164（3080） |
| 13 | `bash scripts/start-dsh-web.sh` | 空闲探测（当时仍是 0.1 RPC）返回 `434/434 idle` → 停止 62164 → 起 **PID 65673（0.2.1-rc.1 host）**；`disabled_plugin_rows=0`；日志只有 burp 桥、playwright MCP 与 token URL |

### 7.2 真实环境验收（真实 `~/.dsh`，非沙盒）

新开一个真实会话（`~/.dsh/sessions/…Src-Pedestal-src-domain-ready…/session-f075f8f3…`）跑一轮真实问答：

- **TOOLS 150 / SRC 55**，`src_*` 全在位（含 `src_http`/`src_serve_proof`/`src_resolve_approval`）。对比基线：0.1 web 最新真实会话 144/55，桌面 App（local.136）2~11/0 → **0.2 web 覆盖率 ≥ 0.1，无退化**。
- `agentPreset = src-hunter`，默认模型 `newapi/deepseek-v4.1-flash`（= 桌面 App 同款），一轮 `turn/start → step/start → assistant/message → step/end → turn/end` 正常闭合（`llmMs≈22.5s`），`src` 投影行存在。
- UI（token 换 cookie 后）：模式选择器显示「SRC 专业模式」，会话视图页签 = **对话 / 轨迹 / SRC**，会话列表与标题正常，`pageerror` 0 条。
- **`.credentials-web.yaml`（嵌套版）被 0.2 正常读取**：模型真实应答，无 AUTH/密钥错误 → 之前「未验证」的凭据格式问题解决（`.credentials-web.yaml` 无需改格式）。
- burp 桥 `upstream session established`；fofa / playwright MCP 行正常注册。
- `~/.dsh/storages/src-sessions.db`（+`-wal`/`-shm`）由 **0.2 host 下的 `@lihua_dis/dsh-src/storage-sqlite` 真实写**；存量 434 会话与 41 张 pending 卡未受影响（未做任何批量处置）。

### 7.3 Option R（预设双视图）处置：**保留，不删**

原计划写的是「web 0.2 验收通过后删除 Option R 双视图」。验收已通过，但本轮**刻意不删**，理由是可验证的能力回退：

- Option R 的 `@drop-0.2-view` 行不是历史包袱，而是 **0.1 的工作流引擎行**（`@deepseek-ai/dsh-workflow-worker-thread`，
  0.2 已移除、改用 `dsh-workflow-ptc`）。`scripts/check-preset-consistency.mjs` 的闸就写着
  「删了 0.1 会静默失去该能力」。
- 0.1 运行时**仍在服役**：`~/.dsh/profiles/headless` 是 `scripts/deploy.mjs` 的活目标，且 0.1 从
  **预设目录**读 `agent.cordis.yml`（真源）。删掉双视图只剩两条路，都不可取：
  ① 只留 0.2 视图 → 0.1 headless 静默失去工作流引擎；② 只留真源 → 0.2 整份 include 被策略闸丢弃（回到 local.136 的老 bug）。
- 代价侧：生成器 + 两个一致性闸（`--check` freshness、正文不得出现 0.1 专有包名）已经在 `npm test` 里常态化，
  维护成本很低。**只有当用户决定彻底退役 0.1（含 headless）时，删双视图才是安全且值得的**，届时一并退休
  `scripts/gen-preset-02.mjs` 与 `preset/src-hunter/agent-02.cordis.yml`。

### 7.4 §5/§6 状态更新

- §5.1 `dsh-session-history` 取舍 → **按 A 执行**（web profile 中移除；0.2 内置 sidebar-browser / session-search / session-query 覆盖；源码保留可回退）。
- §5.2 真实切换 → **已执行并验收通过**。
- §5.3 重启守卫 → 采用「(c) fail-closed + 显式 `DSH_WEB_FORCE=1`」，并叠加 (b) 的投影缓存轮次判断（`openTurnStartSeq`），不再依赖 0.1 RPC。
  实测补充：0.2 下 `POST /api/session.list` 确实 404（落到第二层），第二层的忙判据必须只用 `turnBoundary.openTurnStartSeq`；`sessionStats.openStep` 在真实环境里有 70/486 份是崩溃残留，拿它判忙会让重启永远被拒。
- §6 凭据格式 → 已验（0.2 读嵌套布局正常）。
- §6 真实会话验收 → 已验（150/55）。
- §6 重复实例 → 已查明并清理（`/tmp/probe16` 遗留）。
- 仍开放：`koffi` 在 profile 树内未见 `.node` 产物（未验证是否有包专用查找路径，也未发现我们的链路依赖它）；
  `node-pty` 有 darwin-arm64 prebuilds，PTY 能力应可用（尚未在 0.2 web 里实跑终端工具）。
- 未做（超出本轮范围）：0.2 下的审批卡交互、Jev 记录写入链路、`src_http` 实跑——均需用户在真实会话里点/发真实请求；
  本轮只验证了工具面与装配面。

### 7.5 交付（本轮）

- `scripts/start-dsh-web.sh`、`scripts/check-web-idle.mjs`、`scripts/test-ui-settings.mjs`、`tests/deployment.test.mjs`、`docs/DEVELOPMENT.md`（web 启停章节）+ 本文档。
- `npm test` **647/647 pass**（新增「空闲守卫两层探测并 fail-closed」用例；旧用例 `DSH API health check failed` 随探针一起改写）。
- `node scripts/check-preset-consistency.mjs`、`node scripts/gen-preset-02.mjs --check` 均 OK。
- **版本**：`package.json` → `0.1.0-local.140`，重打 `lihua_dis-dsh-src-0.1.0-local.140.tgz`；不推远端（用户自行 push）。
