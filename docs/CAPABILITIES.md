# dsh-src 外部能力接入规范 v1

> 让 dsh-src 以「docker compose 式」体验接入任意外部 MCP 能力（JS 逆向、二进制分析、
> 移动端、抓包代理等）。用户只维护一份 `~/.dsh/capabilities.yaml`，跑一次 sync，重启生效。

---

## 一、目录规划（唯一约定，不许乱放）

```
$DSH_HOME/                          # 通常是 ~/.dsh/
├── capabilities.yaml               # ← 用户唯一要维护的声明文件（能力清单）
├── tools/                          # Burp 自愈桥安装点（caps-sync 自动从包内拷贝）
│   └── burp-mcp-bridge.mjs
└── capabilities/                   # ← 所有外部能力的统一落点（sync 自动创建）
    └── <id>/                       # 每个能力一个目录，目录名 = 声明里的 id
        ├── .caps-src               # 标记文件：JSON {from, ref, installedAt}
        ├── <clone 的仓库内容>       # git 型：整个仓库 clone 到这里
        └── dist/index.js 等         # build 后的产物也在本目录内
```

铁律：
1. **能力本体只允许出现在 `~/.dsh/capabilities/<id>/`**，禁止散落到 home、/tmp 或 profile 目录。
2. **接线配置不手写**：`scripts/caps-sync.mjs` 从 `capabilities.yaml` 生成，写入
   profile 的 `cordis.patch.yml` 中由 `# ── dsh-src capabilities:8< ──` 包裹的区段；
   区段外的内容 sync 绝不触碰。
3. npx 型能力**不落地**到 capabilities/（npm 缓存即存放层），只有 `git:` 型才 clone。
4. 删除能力 = yaml 里删条目 + 重跑 sync + 手动删目录（sync 不做破坏性删除）。

## 二、capabilities.yaml 格式

> 示例文件版本化在仓库根：`capabilities.yaml.example`，首次使用 `cp capabilities.yaml.example ~/.dsh/capabilities.yaml`。
>
> **懒人路径**：不想手写 yaml 就用 [INSTALL-PROMPT.md](INSTALL-PROMPT.md) 的一键提示词（顶部只需填项目链接），AI 代劳全程。

```yaml
capabilities:
  - id: jshook                       # 必填，唯一；决定目录名与工具前缀 mcp__jshook__*
    from: npm:@jshookmcp/jshook@latest   # 二选一：npm:<pkg> | git:<url>
    # ref: main                      # 仅 git 型：分支/tag，默认远端 HEAD
    # build: pnpm install --frozen-lockfile && pnpm build   # 仅 git 型
    # entry: dist/index.js           # 仅 git 型：构建后的启动文件（相对目录）
    enabled: true                    # false=跳过接线（保留声明）
    env: {}                          # 传给子进程的环境变量
    when: >                          # 给 agent 看的路由提示：什么场景该用它
      遇到 JS 混淆/加密签名/Webpack 打包需要运行时 Hook 时
    evidence: src_record_observation # 证据回灌工具（固定值，留作纪律提醒）
```

## 三、使用流程

```bash
node ~/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src/scripts/caps-sync.mjs
# （源码构建安装的把路径换成仓库目录；其它 profile 加 --profile-dir ~/.dsh/profiles/<名>)
```

之后**重启 dsh web 生效**（MCP 接线是组合态的一部分，不支持热插拔——这是有意取舍）。

多 profile：sync 默认只写 web profile；其它 profile 用同一份清单各跑一次：

```bash
node ~/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src/scripts/caps-sync.mjs --profile-dir ~/.dsh/profiles/src-test   # 例：src-test profile
```

验证：面板对 agent 说「列出 mcp__jshook__ 开头的工具并调用一个只读的」，或直接让 agent 调 src_list_capabilities / src_test_capability。
证据纪律：外部产出一律经 `src_record_observation(tool='<id>')` 固化，未固化不算数。

## 三点五、自定义代理占位（settings.proxy）

清单顶部可加：

```yaml
settings:
  proxy: http://192.168.10.88:7893
```

生效范围：仅 sync 内部 git clone/fetch 与 build 子进程的环境变量（HTTPS_PROXY/HTTP_PROXY 大小写四个全注入）。不配置时尊重你 shell 已有的环境变量；npm 型（npx）不受此设置影响。

## 四、安全边界

- 只接注册在案、来源可信的能力；`failOnStartupError: false` 由 sync 统一写死——
  单个能力起不来绝不阻塞其它功能。
- 外部 MCP = 任意代码执行面：能力结论进 finding 前仍走 finalize 门禁复核。
- `env` 里不要放明文密钥；需要凭据的场景走 infra（src_set_infra / 面板基础设施页）。
