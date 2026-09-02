# dsh-session-history — 历史会话插件 | Session History Plugin

DeepSeek Harness（DSH）历史会话插件：在 Web 侧边栏底部提供「历史会话」入口，集中管理所有历史会话——浏览、恢复、单独删除或一键清理。

## 功能

- **历史会话列表**：跨工作区列出所有历史会话，按最近更新排序，显示会话标题、工作区与相对时间；当前会话有「当前」标记。
- **归档会话分组**：被归档的会话单独显示在「已归档会话」分组下，一眼可辨。
- **单条恢复**：归档会话右侧的恢复按钮（↻）点击即取消归档并打开该会话，会话重新出现在工作区浏览器与正常历史中。
- **单条删除**：每条会话（含归档）右侧的垃圾桶按钮，确认后永久删除该会话（目录 + 内存状态 + 记账全部清除，不会残留或误入"未分组"）。
- **删除全部**：底部「删除全部历史会话」按钮，一次删除所有非当前、非运行的会话（含归档），确认弹窗显示总数与归档数量。
- **运行保护**：正在运行（有活跃回合）的会话不可删除；当前会话的垃圾桶禁用。

## 安装

### 1. 复制包文件

将本仓库整体复制到 DSH 的 plugins 目录下（按你的部署方式，也可能在 profile 的 node_modules 下）：

```powershell
# 以本机 plugins 目录为例
Copy-Item -Recurse . "D:\deepseek harness\plugins\dsh-session-history"
```

### 2. 注册插件

在 profile 的补丁配置（例如 `~/.dsh/profiles/web/cordis.patch.yml`）中插入：

```yaml
- insert:
    - id: session-history
      name: "@deepseek-ai/dsh-session-history"
      inject: ["connection"]
      config: {}
```

### 3. 重启并刷新

重启 DSH，然后在浏览器中硬刷新（Ctrl+F5）页面。侧边栏底部会出现时钟图标（历史会话）按钮。

## 说明

- **删除机制**：宿主端按安全路径规则校验会话 id，先拆除空闲 agent、再从内存 store 移除、最后删除磁盘目录；**不修改 workspace 记账**，因此删除的会话不会变成"未分组"孤儿，也不会残留幽灵记录。
- **运行中会话保护**：只有真正在运行回合（agent `status === "running"`）的会话会被拒绝删除；已结束的会话即使内存中留有空闲 agent 也可正常删除。
- 依赖 DSH 内置包：`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-client-ui-primitives` 等（见 `package.json` peerDependencies）。
- 客户端 `lib/client.js` 是供 DSH web 加载的模块格式，请勿直接用浏览器打开。

## License

MIT
