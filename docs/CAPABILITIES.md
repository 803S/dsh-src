# dsh-src 外部能力接入规范 v2

> 让 dsh-src 以「docker compose 式」体验接入任意外部能力（JS 逆向、二进制分析、
> 移动端、抓包代理等）。用户只维护一份 `~/.dsh/capabilities.yaml`，跑一次 sync，重启生效。
>
> **两类形态**（v2 新增 skill 型）：
> - **mcp 型**（默认）：接 MCP 工具面，重启后工具面出现 `mcp__<id>__*` 工具；
> - **skill 型**：任意「文档 + 脚本」形态的项目（纯 CLI、SKILL.md 知识库、分析器仓库都行）——
>   agent 用 `src_read_capability` 读其文档，用 `src_run_capability` 执行其**白名单内**脚本
>   （执行前挂起待审，人工批准才真正运行）。纯 MCP 项目接不进来时，skill 型是兜底通道。

---

## 一、目录规划（唯一约定，不许乱放）

```
$DSH_HOME/                          # 通常是 ~/.dsh/
├── capabilities.yaml               # ← 用户唯一要维护的声明文件（能力清单）
├── capabilities/
│   ├── index.json                  # ← 能力索引（caps-sync 生成，全部 kind；插件读它）
│   └── <id>/                       # 每个能力一个目录，目录名 = 声明里的 id
│       ├── .caps-src               # 标记文件：JSON {from, ref, installedAt}
│       ├── <clone 的仓库内容>       # git 型：整个仓库 clone 到这里
│       └── dist/index.js 等         # build 后的产物也在本目录内
│       # npm 型 skill 的实际目录在 <id>/node_modules/<包名>/
└── tools/                          # Burp 自愈桥安装点（caps-sync 自动从包内拷贝）
    └── burp-mcp-bridge.mjs
```

铁律：
1. **能力本体只允许出现在 `~/.dsh/capabilities/<id>/`**，禁止散落到 home、/tmp 或 profile 目录。
2. **接线配置不手写**：`scripts/caps-sync.mjs` 从 `capabilities.yaml` 生成，写入
   profile 的 `cordis.patch.yml` 中由 `# ── dsh-src capabilities:8< ──` 包裹的区段；
   区段外的内容 sync 绝不触碰。
3. npm 型 **mcp 能力不落地**到 capabilities/（npm 缓存即存放层）；npm 型 **skill 能力**落地为
   `<id>/node_modules/<包名>/`（sync 用 `npm install --prefix` 安装）。
4. 删除能力 = yaml 里删条目 + 重跑 sync + 手动删目录（sync 不做破坏性删除）。

## 二、capabilities.yaml 格式

> 示例文件版本化在仓库根：`capabilities.yaml.example`，首次使用 `cp capabilities.yaml.example ~/.dsh/capabilities.yaml`。
>
> **懒人路径**：不想手写 yaml 就用 [INSTALL-PROMPT.md](INSTALL-PROMPT.md) 的一键提示词（顶部只需填项目链接），AI 代劳全程。

```yaml
capabilities:
  - id: jshook                       # 必填，唯一；决定目录名与工具前缀 mcp__jshook__*
    from: npm:@jshookmcp/jshook@latest   # 三选一：npm:<pkg> | git:<url> | path:</绝对路径>
    # ref: main                      # 仅 git 型：分支/tag，默认远端 HEAD
    # build: pnpm install --frozen-lockfile && pnpm build   # 仅 git/path 型
    # entry: dist/index.js           # 仅 git/path 型：构建后的启动文件（相对目录）
    enabled: true                    # false=跳过接线（保留声明）
    env: {}                          # 传给子进程的环境变量
    when: >                          # 给 agent 看的路由提示：什么场景该用它
      遇到 JS 混淆/加密签名/Webpack 打包需要运行时 Hook 时
    evidence: src_record_observation # 证据回灌工具（固定值，留作纪律提醒）

  # skill 型（v2）：任意「文档 + 脚本」项目——纯 CLI、分析器仓库、SKILL.md 知识包
  - id: apkx                         # 目录名与审批 url 前缀
    from: git:https://github.com/example/apkx
    kind: skill                      # 必须；省略默认 mcp
    # docs: SKILL.md                 # 文档入口相对路径（省略则自动探测 SKILL.md > README.md）
    scripts: [scripts/extract-endpoints.sh, scripts/apkx.mjs]   # 白名单（必须内联数组）
    when: >
      拿到 APK/小程序包需要反编译、提取端点/密钥时

  # path: 型（local.55）：本机目录直装，无嵌套 git、无网络。仓库转私有后，
  # 能力源头收编进本仓库的首选形态——from 直接指向仓库内能力目录。
  - id: clown-src-playbook
    from: path:/Users/you/Software/dsh-src/skills/clown-src-playbook
    kind: skill
    docs: DSH-ADAPTER.md
    when: >
      SRC 目标规划、接口建模、越权/认证链、注入/SSRF/XSS/上传/业务逻辑测试
```

字段说明（skill 型新增）：
- `kind: skill`——形态标记。skill 型不接 MCP 工具面，不写 `entry`。
- `from` 三种前缀：`npm:`（registry 安装）、`git:`（clone，可用 `ref:` 指定分支；local 路径 `git:file://` 也可）
  、`path:`（本机目录直装：caps-sync 直接拷贝目录到 `~/.dsh/capabilities/<id>/`，排除 `.git/.venv/node_modules`；
  支持与 git 型相同的 `build:`；来源更新后删安装目录重跑 sync）。
- `docs`——agent 用 `src_read_capability` 读的入口文档；省略则按 SKILL.md > README.md > README_CN.md 探测。
- `scripts`——**白名单**，只有列出的相对路径能被 `src_run_capability` 执行；改白名单 = 改 yaml + 重跑 sync。
  支持的解释器按扩展名自动选：`.sh/.bash`→bash、`.js/.mjs/.cjs`→node、`.py`→python3、无扩展名→直接执行
  （需可执行位）。argv 直传不经 shell，无注入面。npm 型 skill 的 `from: npm:<pkg>` 会安装到本地目录。

## 三、使用流程

**优先路径（local.48 起）**：dsh 会话内直接让 agent 调 **src_add_capability**，一条命令完成登记+安装+预热+接线+索引：

```text
调 src_add_capability，from=https://github.com/<o>/<r>（或 npm:<pkg>、owner/repo），kind=mcp，when=<场景>
```

GitHub 链接会自动探 npm registry（命中走 npm: 免 GitHub 网络）；proxy 参数可在清单无 settings.proxy 时写入持久化；mcp 型接线后重启 dsh web 生效。同 id 重调安全（清单不重写、仅重跑 sync）。下述手动流程仅在外部助手场景或工具报错时使用：

```bash
node ~/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src/scripts/caps-sync.mjs
# （源码构建安装的把路径换成仓库目录；其它 profile 加 --profile-dir ~/.dsh/profiles/<名>）
```

之后**重启 dsh web 生效**（MCP 接线是组合态的一部分，不支持热插拔——这是有意取舍）。

多 profile：sync 默认只写 web profile；其它 profile 用同一份清单各跑一次：

```bash
node ~/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src/scripts/caps-sync.mjs --profile-dir ~/.dsh/profiles/src-test   # 例：src-test profile
```

验证：面板对 agent 说「列出 mcp__jshook__ 开头的工具并调用一个只读的」，或直接让 agent 调 src_list_capabilities / src_test_capability。
证据纪律：外部产出一律经 `src_record_observation(tool='<id>')` 固化，未固化不算数。

### skill 型的使用方式

skill 型**不产生工具面工具**。agent 侧流程（提示词【外部能力路由】已内置）：

1. `src_list_capabilities`——看到 `✓已安装 [skill] <id> — 白名单脚本:…`；
2. `src_read_capability(id)`——读 `docs`/SKILL.md/README.md 了解用法（只读、截断）；
3. `src_run_capability(id, script, args)`——提交白名单脚本。**脚本不会立刻执行**：异步挂起到
   「待办」tab 待审区（method=RUN 的卡片，参数与授权说明可见）；用户点批准 →
   agent 收到 followup 调 `src_resolve_approval(id, allow)` → 此刻才真正 spawn，脚本
   stdout/stderr 随审批结果回给 agent；拒绝则不执行。同参数重复提交会复用既有待审项。

caps-sync 对 skill 型额外产出：`~/.dsh/capabilities/index.json`（全部 kind 的安装状态、
dir/docs/scripts——插件工具的数据源，勿手改）。

## 三点五、统一本地配置与 FOFA

`~/.dsh/capabilities.yaml` 是能力和本地运行配置的唯一用户入口。除了 `capabilities:` 外，`settings:` 可统一配置代理和本地 FOFA：

```yaml
settings:
  proxy: http://127.0.0.1:7890
  fofaUv: /Users/your-name/.local/bin/uv
  fofaEmail: your-email
  fofaKey: your-key
  fofaEmailBackup: backup-email
  fofaKeyBackup: backup-key
  fofaEmailBackup2: backup2-email
  fofaKeyBackup2: backup2-key

capabilities:
  - id: fofa
    from: path:/Users/your-name/Software/dsh-src/mcp-servers/fofa_MCP
    entry: fofa-launcher.mjs
    when: 当前授权 SRC 目标的 FOFA 资产搜索
```

Key 保存在本机 capabilities.yaml，仓库保持私有（capabilities.yaml 随私库跟踪，切勿改回公开）；本机文件仍建议 `chmod 600`。FOFA launcher 在运行时从同一份 `capabilities.yaml` 读取 Key，不读取散落的 `.env` 或 PowerShell 文件。删除/停用 FOFA 时只需将该条目的 `enabled` 改为 `false` 后重跑 sync。

### 三点六、自定义代理占位（settings.proxy）

清单顶部可加：

```yaml
settings:
  proxy: http://192.0.2.88:7893
```

生效范围：仅 sync 内部 git clone/fetch 与 build 子进程的环境变量（HTTPS_PROXY/HTTP_PROXY 大小写四个全注入）。不配置时尊重你 shell 已有的环境变量；npm 型（npx）不受此设置影响。

## 四、安全边界

- 只接注册在案、来源可信的能力；`failOnStartupError: false` 由 sync 统一写死——
  单个能力起不来绝不阻塞其它功能。
- 外部 MCP = 任意代码执行面：能力结论进 finding 前仍走 finalize 门禁复核。
- **skill 型 = 更直接的命令执行面**，因此三重闸：①只执行白名单内脚本 ②每次执行前挂起待审
  （人工批准才运行）③解释器按扩展名白名单化、argv 直传不经 shell、目录内相对路径（禁 `..`）。
  审批记录（method=RUN）与 HTTP 待审同队列同审计，`runOutput` 落库可回查。
- `env` 里不要放明文密钥；需要目标测试凭据的场景走 infra（src_set_infra / 面板基础设施页）。本地 FOFA Key 例外地放在仅本机可读的 `capabilities.yaml` `settings` 字段，由 launcher 运行时读取，不进入 profile patch 或能力索引。
