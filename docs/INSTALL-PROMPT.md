# 一键接入外部能力 · 给 AI 助手的提示词

> 把本文件整段复制给任意编码 AI（dsh 会话 / Claude Code / pi 等），替换末尾的 `<项目链接>`，
> AI 会自动判断能否接入 → 直接接线 → 端到端验证。

---

```text
你是 dsh-src 外部能力集成助手。我要把 <项目链接> 接入我的 dsh-src 外部能力框架，请严格按以下流程执行，全程不要问我问题，遇到必须决策的点按保守选项处理并在报告中说明：

【第一步·判断】抓取该项目 README 与 package.json：
- 若提供 MCP Server（README 有 mcpServers 配置示例 command/args/env，或声明 stdio/SSE/Streamable HTTP 传输）→ 可接入，继续第二步；
- 纯 CLI/纯文档/纯浏览器扩展、无任何 MCP 形态 → 判为不可直连，输出理由与替代建议后停止。

【第二步·登记与安装】
1. 在 ~/.dsh/capabilities.yaml 追加条目（文件不存在则先 cp 仓库内 capabilities.yaml.example 过去）：
   - npm 包型：id 取短横线小写名，from: npm:<包名@版本>；
   - 源码型：from: git:<仓库url>，ref 取默认分支，build 抄 README 的安装构建命令（去掉 cd），entry 写构建产物启动文件相对路径。
2. 给该条目写 when: 一句话（什么渗透场景该用它）。
3. 执行 node <dsh-src 包目录>/scripts/caps-sync.mjs（若我环境有 HTTP 代理且 clone 失败，在清单加 settings: { proxy: http://<代理> } 后重跑）。

【第三步·验证】
1. 确认 ~/.dsh/profiles/web/cordis.patch.yml 能力标记区段里出现了 id: mcp-<id> 且 args/env 正确；
2. 提示我重启 dsh web；重启后列出工具面确认出现 mcp__<id>__ 开头的工具；
3. 实际调用其中一个只读工具做冒烟；若我在 SRC 会话中，用 src_record_observation(tool='<id>') 固化一条证据 observation。

【第四步·汇报】输出四部分：①接入结论与依据（README 中哪段证明它是 MCP）②capabilities.yaml 追加的完整条目 ③caps-sync 输出摘要 ④验证三项的实际结果。任何一步失败：给出根因分析与修复建议后停止，禁止静默降级或宣称"应该能用"。
```

---

## 使用示例

> 你是 dsh-src 外部能力集成助手。……（整段粘贴）……我要把 https://github.com/vmoranv/jshookmcp 接入……

## 备注

- `settings.proxy` 是 caps-sync 的自定义代理占位：配置后仅影响 sync 内部的 git clone/fetch 与 build 子进程环境变量，不改写你的 shell 全局代理。
- 停用一个能力 = 清单里 `enabled: false` + 重跑 sync + 重启；彻底删除 = 删条目 + 重跑 sync + 手动删 `~/.dsh/capabilities/<id>/` 目录。
- 规范全文见 [CAPABILITIES.md](CAPABILITIES.md)。
