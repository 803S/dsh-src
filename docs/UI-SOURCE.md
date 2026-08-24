# UI 源码现状与重建路径

> 状态（2026-08-25）：**`lib/ui-src.client.js` 是 rolldown 打包产物，源码工程不在本仓库**。
> 产物约 12,400 行、532KB，无 sourceMappingURL 对应的 `.map` 文件——无法反解回源码。

## 背景

项目早期在仓库外的临时目录开发 UI（rolldown + react + zustand），构建产物
`ui-src.client.js` 直接提交入库；源码目录随临时工作区清理而丢失。当前产物
仍可运行（宿主 `__ModuleLoader__` 加载 factory），但带来三个问题：

1. **外部贡献者无法审阅或修改 UI**——开源仓库只有产物；
2. **维护困难**——改 UI 只能对着打包代码盲改，local.17 徽章改造误删 tab 标签即源于此；
3. **无法重建**——没有 lockfile、没有 tsconfig、没有组件文件边界。

## 产物内含结构（逆向盘点）

| 组件/模块 | 依据 |
|---|---|
| 7 个视图 | `WorkspaceView`（统计卡条）、`FindingsView`、`AssetsView`、`TimelineView`、`TodoListView`、`InfraView`、`ReportView` |
| 图视图 | `@xyflow/react`（React Flow，探索链路可视化，29 处引用） |
| 状态管理 | `zustand`（11 处） |
| 运行时依赖 | react / react-dom（由宿主 dsh client runtime 注入）、`@deepseek-ai/dsh-client-ui-conversation` |
| 模块 id | `@lihua_dis/dsh-src/ui-src`（CSS 以内联 style tag 注入，id 带 `-css` 后缀） |

## 重建路径（待做）

1. 新建 `ui/` 目录：rolldown 工程 + `src/client/`（按上表拆分视图组件）；
2. 以现产物为「黄金参照」：新构建的 bundle 与旧产物对同一份投影数据渲染结果一致即视为重建成功；
3. `package.json` 增加 `scripts.build: ui → lib/ui-src.client.js`，CI 增加构建检查；
4. 重建完成前，README 的功能介绍照常成立（产物可用），但接受 PR 时 UI 部分只能 issue 讨论。
