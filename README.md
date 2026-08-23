# dsh-src — DSH SRC 漏洞挖掘模式

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 SRC 漏洞挖掘模式插件。它把一次授权漏洞挖掘组织成一条**可审计的探索链路**：目标 → 研究方向 → 事实 → 假设 → 验证 → 漏洞报告，全程由 agent 推进、在 Web 面板可视化，最终一键产出结构化 Markdown 报告。

一个自包含 bundle 包（`@howmp/dsh-src`）：宿主工具集、Web 界面、sqlite 存储后端和「SRC 专业模式」agent 预设通过包内 `exports` 一同分发，`dsh plugin add` 一条命令安装。

---

## 功能特性

### 探索链路方法论
- **结构化记录**：`goal → intent → fact → finding` 四层节点 + `spawns / yields / derived_from / proves` 关系边，每次 `src_*` 工具调用都落库并可重放，图与日志永远一致。
- **子代理并发委派**：主 agent 按事实拆分研究方向，fork 子代理并发执行；每个子代理通过 `src_submit` 直写父 intent 并留下 durable checkpoint——父会话崩溃也能恢复现场（`src_recover_child`）。
- **AI 发现漏斗**：被动采集（crt.sh/HackerTarget/Google dorks/robots/sitemap/JS 接口 hint）→ API endpoint 资产化 → 自动生成 coverage/research skeleton → 逐项推进验证，防止「发现了接口但没真正测」。

### Web 面板（七个标签页）
| 标签页 | 内容 |
|---|---|
| 探索链路 | 交互式图视图（可平移缩放），展示 goal→intent→fact→finding 全链 |
| 漏洞 | finding 卡片：severity、危害双视角论证、可复现步骤、POC、原始请求/响应 |
| 资产 | 资产树 + 分组列表，来源/方式/置信度/状态四维溯源 |
| 时间线 | 时间轴 + 详情双栏，observation 可展开看完整请求响应头与体 |
| 待办 | agent 发起的用户待办（如登录态抓包），勾选后自动写回会话 |
| 基础设施 | 代理 / Burp MCP / 测试凭据配置，带连通性测试按钮，新会话可一键沿用 |
| 报告 | 结构化 Markdown 报告，可直接复制提交 SRC 平台 |

### 人机命令（面板直写存储，不打扰 agent）
| 命令 | 作用 |
|---|---|
| `/src-infra <key> <value>` | 保存基础设施设置（`-` 恢复默认） |
| `/src-infra-copy` | 从最近配置过的会话沿用全部基础设施 |
| `/src-proxy-test` | 经代理请求探针，直出连通性结果 |
| `/src-burp-test` | Burp MCP 端到端实测（tools/list + 拉 history） |
| `/src-todo <id> <status> [note]` | 用户待办完成/放弃反馈 |

### 安全纪律（提示词与工具双重约束）
- 只测有授权的目标（SRC 平台注册即视为默认授权）；公司名/品牌名不会自动变成扫描目标。
- WAF 三层纪律：识别保护信号即停 → 有界绕过研究（逐变体低并发差分）→ 绝不无界暴力。
- 允许有界爆破（登录弱口令等），禁止 DoS、代理池轮换、captcha 破解、隐蔽大规模扫描。
- finding 必须包含可复现步骤、影响论证、受影响范围、修复建议和至少一条 POC；未复现内容只能作为 fact/hypothesis。

---

## 环境要求

- **Node.js ≥ 24**（使用内置 `node:sqlite`）
- **dsh CLI**（`@deepseek-ai/dsh` ≥ 0.1.0-rc.6）与已初始化的 `web` profile
- 可选：**Burp Suite Pro** + "MCP Server" BApp 扩展（实时流量导入）

## 安装

> 安装本质是把 bundle 包装进 profile 的依赖树：`dsh plugin --profile web add <包>` 内部转发 `pnpm add`，重启 dsh 后补丁层自动生效。

### 方式一：从 GitHub Release 安装（推荐）

```bash
# 资产名以 Releases 页为准（形如 howmp-dsh-src-<版本>.tgz）
dsh plugin --profile web add https://github.com/803S/dsh-src/releases/latest/download/howmp-dsh-src-<版本>.tgz
```

### 方式二：从源码构建安装

```bash
git clone https://github.com/803S/dsh-src.git
cd dsh-src && npm pack
dsh plugin --profile web add file:$PWD/howmp-dsh-src-<版本>.tgz
```

### 启用

重启 dsh 后：

1. 新建会话时选择自动注册的 **「SRC 专业模式」**（预设名 `src-hunter`）；
2. 或设为默认预设（`$DSH_HOME/settings.yaml`）：

```yaml
agent-presets:
  default: src-hunter
```

3. 打开对话输入目标开始挖掘；侧栏出现 **SRC** 视图即可看到探索链路各标签页。

## 可选：接入 Burp MCP

不接 Burp 插件照常工作（HAR/raw 文件导入兜底）。要实时导入浏览流量、把抓包直接喂给 agent：

1. Burp Suite Pro 安装 "MCP Server" 扩展并点 **Start**（默认监听 `127.0.0.1:9876`）。
2. 安装自愈桥脚本（源码在本仓 `tools/burp-mcp-bridge.mjs`，负责 stdio↔SSE 协议转换、断连自动重开会话）：

```bash
cp burp-mcp-bridge.mjs ~/.dsh/tools/
```

3. 把下面整段加进 profile 补丁文件 `$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: mcp-burp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: burp          # 必须叫 burp —— 工具名才是 mcp__burp__*
        transport: stdio
        command: node
        args: ['~/.dsh/tools/burp-mcp-bridge.mjs']
        failOnStartupError: false # Burp 未开时不阻塞其它功能
        toolCallTimeoutMs: 120000
```

4. 重启 dsh，面板「基础设施」页点「测试连接」验证。

## 使用速览

对 agent 说人话即可开场：

> 挖掘 https://xxx.example.com 的 SRC，授权说明：SRC 平台注册账号 ID 12345

agent 会建 goal → 被动侦察收敛资产面 → 拆分 intent 并发委派子代理 → 逐项验证 → finalize 门禁检查 → 出报告。「基础设施」页建议先配好出站代理（国内目标直连更快，google/github 等域名自动走代理）。

## 数据与隐私

- 所有记录写入本机 `$DSH_HOME/storages/src-sessions.db`（sqlite），不出网。
- 包本身零运行时依赖、零遥测；Google dorks 等被动采集直接从你本机发出。

## 界面预览

### 工作台（对话 + 统计卡条）

![工作台](images/workspace.png)

### 漏洞视图

![漏洞视图](images/findings.png)

### 资产视图

![资产视图](images/assets.png)

### 时间线

![时间线](images/timeline.png)

### 用户待办

![用户待办](images/todos.png)

### 基础设施

![基础设施](images/infra.png)

### 报告

![报告](images/report.png)

## 致谢与项目来源

本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh，MIT License）生态的二次开发作品：插件结构、bundle 分发机制、Web 面板与 agent 预设体系均基于 dsh 的公开插件接口构建。感谢 dsh 原作者的设计与开源。

本项目以 [howmp/dsh-pentest](https://github.com/howmp/dsh-pentest) 为参考二次开发而来，探索链路数据模型、工具分层与 Web 面板结构承自该项目。

## 文档

- [开发与迭代历史](docs/DEVELOPMENT.md) —— 架构细节、设计决策、版本迭代日志。

## License

[MIT](LICENSE)
