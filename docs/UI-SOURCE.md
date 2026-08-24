# UI 源码现状与恢复路径

> 状态（2026-08-25 更正）：`lib/ui-src.client.js` 是 rolldown 打包产物（12,400 行、532KB，无 `.map`），
> 但**源码并非丢失**——本 UI 以上游 [howmp/dsh-pentest](https://github.com/howmp/dsh-pentest)
> 开源的 `src/dsh-client-ui-pentest/`（MIT，1,103 行 TSX）为基底改造；产物内保留的原始模块路径
> （`C:\Users\admin\Desktop\dsh\dsh-src\src\dsh-client-ui-src\…`）表明它在原作者的 Windows 构建
> 环境产出。恢复 = 拷贝上游源码为基底 + 从产物移植 SRC 增量，约 2–3 小时。

## 同源性证据（2026-08-25 clone 对比）

| 证据 | 结果 |
|---|---|
| `graph.ts` 布局常量 | 逐字一致：`EXPLORE_NODE_SIZE {236×120}`、`CHAIN_EDGE_KINDS`、BFS `depthsOf` |
| `ReportView.reportOf()` | 几乎逐行一致，仅投影名 pentest→src |
| 组件清单 | 一一对应：AssetsView / ExploreView / FindingsView / GraphDetailDrawer / ReportView / graph / locales / index；唯一 PentestView→SrcView |

产物 rolldown 时未剥注释：每个原始文件有 `//#region src/client/*.tsx` 边界、JSDoc 完整保留，
反提取是机械还原而非考古。

## SRC 增量（需从产物移植的部分）

- **3 个新 tab**：timeline / todos / infra（上游仅 explore/findings/assets/report 四 tab）；
- **SrcView 壳**：4 tab → 7 tab 结构与统计卡条；
- **散点适配**：`formatApiMeta`（API 型 fact 渲染）、投影字段名 pentest→src、locales 词条增量。

## 恢复路径

1. 拷贝上游 `src/dsh-client-ui-pentest/` → 本仓库 `src/dsh-client-ui-src/`（MIT 允许，保留出处注释）；
2. `PentestView.tsx` → `SrcView.tsx`：按产物 region 反提取 7-tab 壳与三个新组件；
3. 共享文件按产物 diff 做小改（字段名 / formatApiMeta / locales）；
4. 构建链：tsdown + 公开依赖（react / react-dom / @xyflow/react@12 / zustand）；宿主私有包
   （`@deepseek-ai/*`，公网 tarball 已下架）以本地 `.d.ts` shim 提供类型；
5. 验证：新产物与现产物 puppeteer 双跑对照渲染，一致后替换入库并加 `npm run bundle`。
