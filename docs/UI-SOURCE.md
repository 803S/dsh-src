# UI 源码现状与恢复路径

> 状态（2026-08-25）：**恢复已完成**。`src/dsh-client-ui-src/` 是 `lib/ui-src.client.js`
> 的 TSX 源码工程（图纸），构建产物与 local.21 bundle 经 puppeteer 双跑对照验收
> （七个 tab 文本/testid 逐字符一致、截图像素 ≥99.99% 一致、交互行为一致、零 pageerror）。
>
> 背景：`lib/ui-src.client.js` 原是 rolldown 打包产物（12,400 行、532KB，无 `.map`），
> **源码并未丢失**——本 UI 以上游 [howmp/dsh-pentest](https://github.com/howmp/dsh-pentest)
> 开源的 `src/dsh-client-ui-pentest/`（MIT，1,103 行 TSX）为基底改造；产物内保留的原始模块路径
> （`C:\Users\admin\Desktop\dsh\dsh-src\src\dsh-client-ui-src\…`，rolldown 未剥注释，
> `//#region` 边界 + JSDoc 完整保留）使反提取成为机械还原而非考古。

## 工程结构

```
src/dsh-client-ui-src/
├── src/client/            # 浏览器侧源码（9 个文件）
│   ├── index.ts           # 插件入口：ModuleLoader 装配、per-session 注册、runCommand 注入
│   ├── SrcView.tsx        # 七 tab 壳（探索链路/漏洞/资产/时间线/待办/基础设施/报告）
│   ├── ExploreView.tsx    # 探索链路图 + 节点详情抽屉（目标/置信度/危害/修复建议/POC）
│   ├── FindingsView.tsx   # 漏洞列表
│   ├── AssetsView.tsx     # 资产列表/图 双模式 + 来源·方式·置信 + 🤖 AI 资产标记
│   ├── ReportView.tsx     # 报告（formatApiMeta / checkpoints / 数据包与截图）
│   ├── GraphDetailDrawer.tsx
│   ├── graph.ts           # 纯函数布局（layoutExploration / layoutAssets）
│   ├── locales.ts         # NS='src' 中英词条（77+77）
│   └── *.module.css       # 六个 CSS Modules（类名 hash 由构建注入）
├── types/                 # 宿主类型投影与 @deepseek-ai/* ambient shim
│   ├── projection.ts      # SrcProjection 形状（镜像 lib/src.js 的 zod schema）
│   ├── slots.ts           # PropsLocale
│   └── vendor-shims.d.ts  # dsh-client-runtime / ui-conversation / locale 类型声明
├── tsdown.config.ts       # 自包含构建配置（见下）
└── package.json           # 构建工具链 devDependencies
```

## 构建命令

```bash
npm run ui-src:typecheck   # tsc 全工程类型检查（strict）
npm run ui-src:build       # tsdown 构建 → dist/index.js → 覆盖 lib/ui-src.client.js
```

首次构建前在 `src/dsh-client-ui-src/` 内 `npm install`（react/@xyflow/react/lightningcss/tsdown 等）。

## tsdown 配置要点（上游 clientBundle() 不公开，此处自实现同构输出）

- **外层包装**：CJS 格式 + intro/outro 手工包 `window.__ModuleLoader__.load({id, factory})`；
  factory 内自造 `var module = { exports: {} }`，结尾 `return module.exports`——与原产物逐行同构。
- **外部依赖**：仅 react / react-dom / react/jsx-runtime 走宿主 `require(...)`；
  `@xyflow/react` 及其 d3 依赖**打进 bundle**（noExternal）。
- **CSS Modules**：rolldown 1.2.5 无 CSS bundling，自写插件用 lightningcss `bundleAsync`
  （`cssModules.pattern = "<prefix>_[local]"`）编译，样式文本注入
  `<style data-plugin-css="@lihua_dis/dsh-src/ui-src/<文件名>">` 并导出 `{local: hashed}` 映射。
- **raw CSS**：`@xyflow/react/dist/style.css` 是全局类名表，不经 hash，原样注入
  （tagId `.../raw`），思路照抄上游 rawCssInline 插件。
- **NODE_ENV**：@xyflow 内部引用 `process.env.NODE_ENV`，浏览器无 process——renderChunk 钩子
  替换为 `"production"`（tsdown 的 define 在此路径未生效，故用插件兜底）。

## 与原产物的已知差异（行为中性）

- **类名 hash 前缀不同**：原产物由原作者机器上的私有工具链生成（如 `_5Empva_`）；
  本工程用 sha1(pluginId+路径) 前 8 位（如 `x7E0QRBB_`）。hash 只需构建内自洽
  （style 注入的类名与 JS 引用一致），无需逆向原算法。
- **sendTool 多余实参已删**：bundle 里 3 处调用给 3 参函数传了第 4 参（JS 静默丢弃，
  行为不变）；源码按真实签名调用。
- **JSX 文本节点 Unicode**：反提取时 bundle 字符串字面量里的 `\u2713` 等转义在 JSX 文本
  位置不生效（渲染出字面 `\u2713`），已改回真实字符 ✓/✗——修复的是恢复引入的瑕疵，
  非 bundle 原有差异。
- CSS 由 lightningcss 重排格式化（属性顺序可能不同），规则集语义等价。

## 同源性证据（2026-08-25 clone 对比）

| 证据 | 结果 |
|---|---|
| `graph.ts` 布局常量 | 逐字一致：`EXPLORE_NODE_SIZE {236×120}`、`CHAIN_EDGE_KINDS`、BFS `depthsOf` |
| `ReportView.reportOf()` | 几乎逐行一致，仅投影名 pentest→src |
| 组件清单 | 一一对应：AssetsView / ExploreView / FindingsView / GraphDetailDrawer / ReportView / graph / locales / index；唯一 PentestView→SrcView |

## SRC 增量（相对上游 pentest）

- **3 个新 tab**：timeline / todos / infra（上游仅 explore/findings/assets/report 四 tab）；
- **SrcView 壳**：4 tab → 7 tab 结构与统计卡条；
- **散点适配**：`formatApiMeta`（API 型 fact 渲染）、投影字段名 pentest→src、locales 词条增量；
- **explore/assets 抽屉字段**：目标/置信度/危害/修复建议/POC 证据透传（graph.ts nodes.map）。

## 验收方法（可复现）

1. `npm run ui-src:typecheck && npm run ui-src:build`；
2. 备份现网 `lib/ui-src.client.js`，替换为新产物，重启 dsh web；
3. puppeteer 打开任一 src-hunter 会话的 SRC 视图，遍历七 tab：
   断言 `[data-testid]` 集合一致、`textContent` 一致、pageerror 为 0；
4. explore 图点 intent/finding 节点，抽屉字段文本与旧产物逐字符比对；
5. 截图像素差 ≤0.01%（时序噪声量级）即视为视觉零变化。
