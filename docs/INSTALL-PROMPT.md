# 一键接入外部能力 · 给 AI 助手的提示词

> 用法：① 填下面配置区 → ② 把**整个文件内容**原样复制给任意编码 AI（dsh 会话 / Claude Code / pi 等）。正文无需任何改动。

═══════════════════════════════════════
## 配置区（只改这里，其余一律不动）

```
项目链接 = <必填：要接入的 MCP 项目 GitHub 地址，如 https://github.com/vmoranv/jshookmcp>
代理地址 = <可选：仅 git 型 clone 被墙时填，如 http://127.0.0.1:7890；留空 = 直连>
dsh-src 包目录 = <一般不用改：默认 ~/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src>
```

═══════════════════════════════════════

以下是给 AI 的提示词正文。执行时**先读取上文「配置区」三个值并代入**：`项目链接`、`代理地址`、`dsh-src 包目录`；代理为空则视为直连。

```text
你是 dsh-src 外部能力集成助手。我要把「项目链接」指向的项目接入我的 dsh-src 外部能力框架，请严格按以下流程执行，全程不要问我问题，遇到必须决策的点按保守选项处理并在报告中说明：

【第零步·优先工具】若你在 dsh 会话中且工具面有 src_add_capability：直接调它一次完成登记+安装+预热+接线（from 直接填「项目链接」——GitHub 链接会自动探测 npm registry，命中即走 npm: 免 GitHub 网络；有代理传 proxy 参数；skill 型另传 kind/docs/scripts），然后跳到【第三步·验证】。后续手动步骤仅当你不在 dsh 会话（Claude Code/pi 等外部助手）或工具报错时才走。

【第一步·判断】抓取该项目 README 与 package.json：
- 网络顺序铁律：GitHub 链接先探 npm registry（npm view <仓库名> --json，带 HTTPS_PROXY 与超时），命中且 repository 指向该项目就直接走 npm:<包名@版本>——registry 可达性通常远好于 GitHub（真实教训：GitHub 经代理完全不可达拖了 25 分钟，npm registry 一次成功）。所有网络命令必须带超时（curl --max-time；macOS 无 timeout 命令，不要用）。
- 若提供 MCP Server（README 有 mcpServers 配置示例 command/args/env，或声明 stdio/SSE/Streamable HTTP 传输）→ 按 mcp 型接入，继续第二步；
- 若是纯 CLI/脚本/文档项目（有可执行脚本或 SKILL.md/README 用法文档，但无 MCP 形态）→ 按 skill 型接入，继续第二步；
- 两者都不是（纯浏览器扩展、纯网页服务且无任何本地可执行形态）→ 判为不可直连，输出理由与替代建议后停止。

【第二步·登记与安装】
1. 在 ~/.dsh/capabilities.yaml 追加条目（文件不存在则先 cp 配置区 dsh-src 包目录内的 capabilities.yaml.example 过去；若在 dsh 会话中编辑被 sandbox 拒绝，改用 bash 追加，或提醒用户改用 src_add_capability）：
   - mcp 型·npm 包：id 取短横线小写名，from: npm:<包名@版本>；
   - mcp 型·源码：from: git:<仓库url>，ref 取默认分支，build 抄 README 的安装构建命令（去掉 cd），entry 写构建产物启动文件相对路径；
   - skill 型：kind: skill，from: npm:<pkg> 或 git:<url>，docs 写文档入口相对路径（省略则自动探测 SKILL.md > README.md），scripts 写白名单（内联数组，只登记阅读文档后确认安全、无破坏性的可执行脚本路径；纯文档项目无脚本则省略 scripts，仅当知识库用）。
2. 给该条目写 when: 一句话（什么渗透/逆向场景该用它）。
3. 若配置区「代理地址」非空且清单尚无 settings.proxy：在清单顶部加 settings:\n  proxy: 代理地址 后重跑（已有则沿用）。
4. 执行 node <配置区 dsh-src 包目录>/scripts/caps-sync.mjs（内置网络超时与 npm 缓存；git clone 失败会提示 npm registry 备选路线）。

【第三步·验证】
1. mcp 型：确认 ~/.dsh/profiles/web/cordis.patch.yml 能力标记区段里出现了 id: mcp-<id> 且 args/env 正确；提示我重启 dsh web；重启后列出工具面确认出现 mcp__<id>__ 开头的工具；实际调用其中一个只读工具做冒烟。禁止两件事：不要用 bash 手动 npx <包名> 冒烟（dsh web 会拉起自己的服务实例，手动实例冗余且容易误杀真服务）；不要 pkill/killall 按包名杀进程（同理）。
   skill 型：确认 ~/.dsh/capabilities/index.json 里该条目 status=installed 且 dir/docs/scripts 正确；无需重启；若我在 SRC 会话中，调 src_list_capabilities 确认出现 ✓已安装 [skill] 条目，再调 src_read_capability 读其文档开头 20 行做冒烟；脚本冒烟走 src_run_capability（会挂起待审，提醒我在「待办」tab 批准）。
2. 若我在 SRC 会话中，用 src_record_observation(tool='<id>') 固化一条证据 observation。

【第四步·汇报】输出四部分：①接入结论与依据（README 中哪段证明它是 MCP）②capabilities.yaml 追加的完整条目 ③caps-sync 输出摘要 ④验证三项的实际结果。任何一步失败：给出根因分析与修复建议后停止，禁止静默降级或宣称"应该能用"。
```

<details>
<summary><b>备注与深度说明（点开折叠）</b></summary>

- **优先用工具**：dsh 会话内 src_add_capability 一条命令替代第二步全部手工操作（登记/安装/预热/接线/索引）；同 id 重调安全（清单不重写、仅重跑 sync），网络失败修复后直接重试即可。npm 统一缓存到 ~/.dsh/.npm-cache（绕开 ~/.npm 权限坑；若见 npm error sudo chown 报错即此因，sudo chown -R $(id -u):$(id -g) ~/.npm 可一次性根治）。
- `settings.proxy` 是 caps-sync 的代理占位：即配置区的「代理地址」，仅影响 sync 内部的 git clone/fetch 与 build 子进程环境变量，不改写你的 shell 全局代理；不配置默认直连。
- **mcp 型 vs skill 型**：前者接入后成为 agent 工具面的一部分（mcp__<id>__*），后者不产生工具，agent 通过 src_read_capability（读文档）+ src_run_capability（白名单脚本，执行前挂待审人工批准）使用——适合没有 MCP 形态但文档+脚本齐全的 CLI/分析器/知识包项目。mcp 型需重启 dsh web 生效；skill 型同步完即可用（无需重启，插件每次调用都读最新 index.json）。
- 多 profile：sync 默认只写 web profile，其它 profile 加参数再跑一次：
  `node ~/.dsh/profiles/web/node_modules/@lihua_dis/dsh-src/scripts/caps-sync.mjs --profile-dir ~/.dsh/profiles/src-test`
- 停用一个能力 = 清单里 `enabled: false` + 重跑 sync + 重启；彻底删除 = 删条目 + 重跑 sync + 手动删 `~/.dsh/capabilities/<id>/` 目录。
- 更新已装能力到最新 = 删掉 `~/.dsh/capabilities/<id>/` 目录 + 重跑 sync（自动重新 clone+build）。
- 规范全文见 [CAPABILITIES.md](CAPABILITIES.md)。

</details>
