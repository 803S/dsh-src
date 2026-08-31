> **开发/迭代历史文档**。安装与使用见根目录 [README](../README.md)。
> 本文件 = UI 源码工程说明 + 测试硬性红线 + 版本迭代日志（设计决策脉络）。

# dsh-src 开发与迭代历史

## UI 源码工程（src/dsh-client-ui-src/）

- `lib/ui-src.client.js`（浏览器半构建产物）的 **TSX 源码就在本仓库** `src/dsh-client-ui-src/`，
  以上游 [howmp/dsh-pentest](https://github.com/howmp/dsh-pentest) 开源的
  `src/dsh-client-ui-pentest/`（MIT）为基底改造恢复，经 puppeteer 新旧产物双跑对照验收
  （七个 tab 文本逐字符一致、截图像素 ≥99.99% 一致、零 pageerror）。恢复过程存 git 历史
  （原 docs/UI-SOURCE.md，已并入本节）。
- 改 UI 后重建（根目录执行，脚本见根 package.json）：

```bash
npm run ui-src:typecheck     # tsc 类型检查
npm run ui-src:build         # tsdown 构建 → dist/index.js → 覆盖 lib/ui-src.client.js
```

- 首次构建前在 `src/dsh-client-ui-src/` 内 `npm install`。
- 投影类型：`src/dsh-client-ui-src/types/projection.ts` 镜像 `lib/src.js` 的 zod schema——
  **投影加字段必须同步这里**（zod 静默 strip 不报错，local.33 教训）。

## 测试约束（硬性红线）

本仓库的测试一律遵守以下红线——**不遵守 = 危害真实厂商资产/用户，等于线上事故**：

1. **绝不用真实漏洞目标做测试**。`src_http`/`src_test_bypass`/`src_scan_surface` 等触及真实网络的集成测试，
   全部走**本地 mock HTTP 服务器**（`127.0.0.1` + 随机端口 + `node:http`），不向任何外部域名发包。
   目标设为 `127.0.0.1`（IP → 合理公共主机校验通过），URL 指向本地服务器端口。
2. **绝不用任何厂商域名资产做测试**。测试中出现的 `example.test`/`127.0.0.1` 等均为占位/本地地址；
   不在测试里出现 `meituan.com`/`oppo.com` 等真实厂商域名，不构造对真实厂商接口的请求报文。
   会话日志取证（如 `session-65695562`）只查不改、不复现，仅作审计参考。
3. **高危动作分类（`classifyHttpRequest`）是纯函数**，不触网，单测覆盖各种请求形态即可，无需任何 mock 服务器。
4. **高危请求异步挂起队列**（local.31）：集成测试中高危请求挂到 `pending_approvals` 表（本地 `MemoryDomain`，不触网）；
   批准后 `src_resolve_approval` 原样重放到本地 mock 服务器（`127.0.0.1` 随机端口）；不调真实 `dsh-user-approval`，也不需开放交互轮次。
5. **fail-closed 验证**：必须验证挂起阶段 / 拒绝后**mock 服务器收不到任何请求**（`hitCount === 0`），这是模块一-路线A 的拦截红线。
6. **报告节完整性闸**（local.32）：任何新增/改名报告节的改动必须同时过 `[local.32]` 双渲染闸——
   UI `reportOf`（ReportView.tsx，节标题词条 `report.sec.*`，zh 值与服务端逐字一致）与服务端 `buildReport` 的
   `## ` 节标题集合必须相等；节顺序两侧也必须一致。
7. **工具输出 schema 一致性闸**（local.34）：任何给工具返回对象新增/改名顶层键的改动，必须同步该工具
   `output.schema.properties` 声明（dsh 核心运行时按 `additionalProperties:false` 校验，undeclared 键直接报
   invalid output）；测试 harness 的 `run()` 漏斗已内置同样检查，全量测试自动覆盖所有工具调用。
   同理：投影 view 输出新字段必须同步投影 zod schema（local.33 教训，zod 是静默 strip 不报错）。
8. **域笔记沉淀软闸**（local.35）：finalize 时本会话遇到防护/限流信号（protectionSignal 或
   429/403/503 observation）或已否/受阻假设（false-positive/blocked research）却零域笔记新增 → 警告提醒
   补记（软闸不阻断；401 是认证边界发现信号不算信号，与 local.32 语义一致）。提示词改进与闸同步。
9. **测试用唯一会话 id**（local.41 教训）：测试 harness 的 domain 开启是**跨测试共享**的
   （`sharedDomainOpens` 缓存），复用 "parent" 等惯用 id 会带着此前测试的 goal/intent——
   每个测试必须用唯一会话 id（如 g41c/g42d）。
10. **lossless 边界零 undefined 键**（local.42 教训，local.15 同类复发）：工具 execute 的 return
    对象**禁裸返可选字段**——可能为 undefined 的字段一律条件展开 `...(x !== void 0 ? { x } : {})`；
    测试 harness 不走 lossless-JSON 序列化（JSON.stringify 会静默丢键），故新增工具输出字段必须配
    `collectUndefinedKeys` 深扫回归（tests 内有现成 helper）。

遵循以上红线的测试见 `tests/src.integration.test.mjs` 中 `[local.26]`/`[local.26/31]`/`[local.31]`/`[local.32]`/`[local.33]`/`[local.34]`/`[local.35]`/`[local.41]`/`[local.42]`/`[local.43]`/`[local.44]` 系列（117 个测试全过；`classifyHttpRequest` 纯函数 + 异步挂起 + resolve + 去重 + fold + 幂等 + 报告节完整性闸 + 软速率帽 + 401 语义 + 基础设施默认沿用 + 认证预算/域笔记投影通道 + 工具输出 schema 一致性闸 + 域笔记沉淀软闸 + 能力双形态 + lossless 深扫）。

## 参考项目

- [ARTEX](https://github.com/Autumn-27/ARTEX)

## 迭代补记（local.13 → local.47，2026-08-22 ~ 2026-08-31）

> local.13~19 与 local.22~42 期间的版本日志未随提交同步入库，此处按 git 提交记录补记；
> 完整改动细节见各 commit message。local.39 未发布（local.38 后直接进入 local.40）。

- **local.13**（545f2e8）：待办挂起不中断任务；Burp MCP 取包优先（不再索要 HAR）；impact 危害论证门禁；Burp SSE 探测定位（端点在根路径且仅 HTTP）；新增 `src_fetch_policy` 拉取厂商 SRC 规则。
- **local.14**（c192199）：基础设施一键沿用（`/src-infra-copy` + 面板按钮）；Burp 接线示例修正为实测配置。
- **local.15**（f030dde）：智能代理直连路由（仅名单域名走代理）；finalize 受限声明 undefined 污染修复（snapshot 剥 undefined——lossless 边界防线确立）；`src_recover_child` 免 checkpoint 唤醒。
- **local.16**（5d006a6 / ed93a33）：报告双视角 + POC 受控托管服务器说明；skill 式经验库（lessons 双层：内置 + 用户数据目录）；`src_update_finding` 面板落库修订；Burp MCP 自愈桥替换官方 mcp-proxy.jar（SSE 断连 -32603 无法自愈）。
- **local.17**（23bd6b5 等 5 提交）：子代理沿父链解析 goal/infra；委派工具一致性；面板 UI 重构（基础设施 tab 分组卡片化）；三轮修复（facts/observations 表对象型数据炸读取、tab 标签、`src_submit` 数组入参可选）。
- **local.18 / 19**（7cae53b / d97948d）：Burp 接线自动化收尾 + 文档全面修正；caps-sync 缺清单优雅退出；README 写明不再需要官方 jar。
- **local.22**（8f6cb0e 等 5 提交）：开源整备——内网 IP 清理、品牌名目标防护（parseGoalHost）、静态检查 CI；UI 源码工程入库（TSX 图纸补全，产物行为一致）；测透与诚实第一波：盲区声明闸 + 测试环境分诊。
- **local.23**（ef667ed）：多账号矩阵——testAccounts 列表 + 交叉矩阵 persona + 认证态独立预算 + 一致性 lint。
- **local.24**（afdb32f + 5d0b540）：域笔记 + 跨会话 briefing（不钻枯井的机制基础）；src_state 输出 schema 补齐三字段。
- **local.25**（19b33bf）：finding 准入闸——危害链三要素强制 + 移除 info 等级。
- **local.26**（ec711d9 + 2bb8028）：高危动作授权闸（异步挂起审批）+ 漏洞打回闭环（UI 按钮 + `/src-reject`）+ 报告攻击链。
- **local.27**（56cb3f4）：报告标准化模板（vulnType + 攻击链 + 四节）。
- **local.28**（5a436f7）：报告代码块保留缩进 + pocScript 一键脚本字段。
- **local.29**（86d5360）：报告改美团 SRC 官方骨架模板，内容动态填充。
- **local.30**（65368f4）：报告第 1 节垂直攻击链①~⑤ + 复现定位信息（前端功能点/应用下载/登录入口）。
- **local.31**（9b0cd1c）：高危删改审批改异步挂起队列（pendingApprovals + `src_resolve_approval` + `/src-approve` + 待办 tab 左右分栏：左待办、右待审）。
- **local.32**（53b2d0e）：报告双渲染对齐 + 软速率帽 + 401 语义修正 + 基础设施默认沿用。
- **local.33**（e33c61b）：认证预算徽标 + 域笔记 explore 侧栏（投影 schema 补 domainNotes/authBudget——zod 静默 strip 教训）。
- **local.34**（b4c1b1e）：修复 src_state 输出 schema 漏声明 pendingApprovals（运行时 additionalProperties:false 报错）；harness.run() 内置 schema 检查闸（全部工具调用自动过闸）。
- **local.35**（b231d45）：域笔记沉淀软闸（finalize 遇防护/限流信号零笔记→警告）。
- **local.36 / 37 / 38**（7c416fd / 230690e / 289b70b）：UI 视觉三轮打磨——FindingsView 折叠化 + Token 化颜色 → shadcn/Vercel 式极简 + 拟态玻璃 → 拟光阴影 + 叙事密度重写。
- **local.40**（4cc115a 清理 + 0f8c108）：孤儿 intent 巡检（src_state orphanIntents + hint）+ Burp 误报三根因修复（提示词/哨兵工具）。
- **local.41**（0a25580）：caps-sync v2 双形态——skill 型（文档 + 白名单脚本 + 审批执行）+ mcp 型；index.json 能力索引；`src_read/run/resolve_capability` 工具。E2E 验证 mcp 进程级拉起。
- **local.42**（15fd2b7 + 6dec19f）：intent 重规划——deprecated 废弃态 + priority 优先级（Cairn_Y Decide 三动作借鉴）；lossless-JSON 边界两处 undefined 泄漏修复（headless 真实会话实弹首发现，新增深扫 undefined 键回归）；headless 实弹 7/7 全链路验证。
- **local.43**：授权模型 v4「资产清单即许可」（小米会话实战诊断驱动：①父 LLM 简报自由发挥「授权含 *.mi.com」被闸拦 ②闸外子代理改用 bash curl 探测得手——片面闸会教代理绕闸，闸必须与真实授权一致）。探测类 6 工具（src_http/src_scan_surface/src_test_bypass/src_test_credential/src_collect_dorks/src_collect_passive）按「goal 主域内 **或** 资产清单内」放行：`assetGrantHosts` 从资产自由文本 value 派生 host（URL/裸 host/通配符，excluded 不作为授权依据；dorks 对主域做双向覆盖）；`src_add_asset` 升级（source 必填审计线索 + 沿父链写入 engagement 共享清单 + 输出补 duplicate/assetHost）；recon/audit 子代理放开 src_add_asset + persona 授权边界规则（被拒→判定归属→登记→重试一次→否则停手上报）；COMMANDER 简报禁自行转述/扩大授权范围；src_state 输出 `assetScope`（model/totalAssets/grantableHosts/distinctDomains/topDomains）+ render 授权边界说明。bash curl 绕过属上游沙箱边界（dsh-bash-sandbox 不管网络），提示词层禁止。
- **local.44**：资产归属人工确认闭环（candidate 两头无观察结论驱动）。新工具 `src_request_asset_confirm`（仅指挥官）：疑似但无法公开验证归属的注册域，挂「待审队列」新类型 `method=ASSET`（category=asset-attribution，url=注册域，reason=判定依据），提交后不阻塞继续其他方向；goal 主域内/已被资产覆盖/已被否决（excluded）三种情况自动跳过不挂队，同域幂等去重（`*.` 前缀归一化）。用户在面板「待审」区或 `/src-approve <id> allow|reject` 决定：不走「转达 agent 重放」路径，命令直接确定性落库（allow→整域登记 confirmed 资产，reject→excluded）+ 合成 src_resolve_approval 事件 + 信息性 followup（确认→可重试，否决→放弃该域）；`src_resolve_approval` 工具对 ASSET 行报错封死 agent 自批路径。指挥官提示词「归属三档判定」（①归属明确→直接登记 confirmed 不打扰用户 ②疑似无法验证→本工具请用户确认整域 ③确定不属于→不探测不登记）；recon/audit persona 补「拿不准归属报 candidate + summary 写待归属确认」；三份 deny 清单同步。src_state `assetScope` 补 `byStatus` 状态分布；finalize 软警告未决归属确认（报告应写覆盖限制）。UI 待审卡片适配 ASSET 行（🏷️ 资产归属确认标题/确认归属·非本组织按钮/判定依据展示，隐藏请求报文块）。
- **local.45**（647af9a）：domain 打开失败自愈（open 失败的 rejected promise 原先被永久持有）+ legacy 资产 method 归一化（`active`→`authorized-active`，加载时 zod preprocess 映射，写入路径校验不变）。
- **local.46**（1b4b057）：`/src-approve` 直写 ASSET 同步投影——resolvePendingApproval 读回最终资产记录随返回带出，命令层补合成 `src_add_asset` 事件；三处命令（`/src-approve`/`/src-infra`/`/src-infra-copy`）的合成 tool/call 事件统一走 `appendSessionToolEvent`（自带唯一 `callId`）——无 callId 的同类事件全落同一 key 会炸历史加载（local.26 修复过的投影漂移在同层复现）。
- **local.47**（29f07fa + 6ae1755）：待审表 schema `method` 枚举补 `'ASSET'`——修复打开校验炸新会话（old session 写入合法 ASSET 待审行时 schema 不认）；新增 [local.47] 全域往返回归测试（store 写读全表走 valueSchema，把 writer/schema 漂移从运行时故障变成构建期闸）。`scripts/deploy.mjs` 新增部署脚本固化双 profile 目标与 md5 终验——真实线上实弹发现「机器上 4 份 dsh-src 副本」漂移致命陷阱，写脚本防人忘了改哪一份。



- **local.48**（c4df04b）：`src_add_capability` 一键接入外部能力（npm-registry 优先解析→守卫式追加 capabilities.yaml→caps-sync 子进程→回读 index.json）；caps-sync 加固（main-guard 可导入、超时 SIGTERM→SIGKILL 分级、npm 缓存隔离、mcp 型预热）；profileDir 从部署副本路径推导，缺 patch 预检拦截。
- **local.49**：架构评审四小项+合成事件统一路径。①`SYNTHETIC_PROJECTION_EVENTS` 冻结白名单（13 名单）+ `appendSessionToolEvent` 白名单断言（未登记直写 throw——local.26 无 callId 撞 key、local.46 直写漏投影两次教训制度化）；②`appendSubmissionProjection`（src_submit 重放）删除裸 append 重复实现、统一路由 appendSessionToolEvent（同 counter/callId 行为不变）；③`SESSION_SCOPED_TABLES` 更名 `LEGACY_KEY_MIGRATION_TABLES`（真实用途=legacy key 迁移参与表，防「会话内表」误读，goals/domain_notes 缺席系 scoped key 先于两表存在）；④src_add_asset 描述补「归属三档判定」 condensed 规则（与主提示词对齐——LLM 对 description 服从权重高于 system prompt）；⑤tests 顶部会话 id 规范注释 + 新增 2 闸测试（白名单三层闸：throw/调用点⊆名单/名单⊆fold case；元测试拦新增单字符会话 id）。121→123 测试。

## 路线规划（local.49 / local.50，2026-08-31 架构评审后定；local.48 已被 src_add_capability 版本占用 c4df04b）

2026-08-31 对 local.24→local.47 全量架构评审（23 提交）记录的健康项与隐患中，按风险/收益切分为「本版即修（local.49）」与「独立大重构版本（local.50）」两档：

### local.49（低风险文档/提示词级，本版做）
1. **prompt 与工具 description 对齐**：SRC_INSTRUCTIONS「归属三档判定」等规则提炼进相关工具（src_request_asset_confirm/src_add_asset）description 首部——LLM 对 description 的服从权重高于 system prompt。
2. **合成事件名单收敛为常量**：applySrcEvent 里 6 个 synthetic case（src_record_pending_approval / src_domain_notes_snapshot / src_auth_budget 等）抽成 `SYNTHETIC_EVENTS` 冻结常量并导出；appendSessionToolEvent 加白名单断言。
3. **SESSION_SCOPED_TABLES 命名澄清**（goals/domain_notes 跨会话是刻意的，加注释说明）。
4. **测试唯一会话 id 规范**：tests 顶部注释 + 可选 grep 闸（防 p/parent 等通用名回归——虽 harness 已隔离）。

### local.50（结构性大重构，独立版本、零行为变更验收）
1. **lib/src.js 拆分**：43 个工具注册迁至 `lib/src/tools/*.js`；先抽 `lib/src/context.js` 作共享依赖容器（store、resolveVisibleSessionIds、throttledHttp、assetGrantHosts、speed/stateMap 等共享闭包变量）。主文件从 5,735 行降到约 2,000 行。
   - 风险点：工具注册顺序变化可能影响 preset toolFilter 顺序敏感逻辑；117 测试原样全绿为验收闸门；单独 commit 不与任何功能改动混合，出问题整包 revert。
   - 工作估量：约 2,600 行搬迁，建议拆「抽 context 容器 → 按组迁工具（注册组 8 组）→ 主文件收尾」三步走。
2. **store 直写 + 合成事件双写合并为单一 API**（与拆包同批做，避开第三种写法半途状态）。

### 明确不做/延后（评审确认）
- 第三波后两环（基线清单聚合 → 哑脚本 diff → 晨报）：等域笔记积累量足够（当前 u_src_domain_notes 已有 20 条真实数据，达到启动阈值附近）再启动。
- lib/src.js 拆分在开源发布后若外部反馈强烈可提前；无功能压力下维持现状不致命。

## 0.1.0-local.12（真实测试第四轮 2 问题：scan_surface lossless JSON 报错 / 新会话无基础设施页）

- **[修复·关键] `tool "src_scan_surface" returned invalid output: value is not lossless JSON`**：工具返回值会经过 dsh-session 的 lossless JSON 快照校验，**任何值为 `undefined` 的自有属性都会让整体判失败**。src_scan_surface 正常完成路径的返回里写了 `stopped: stopped ? "protection-signal" : void 0`——未触发停机时 stopped 为 undefined，整个输出被拒。之前没暴露是因为真实目标多��� WAF 提前 return；扫无防护目标必炸。同款炸弹还有 src_test_bypass 错误路径 `{ ...req, status: void 0, ... }`（spread 覆盖产生 undefined 自有属性），一并修复：改为条件展开/解构剔除，绝不产出 undefined 值属性。
- **[修复] 新会话看不到基础设施页**：投影 view 在 `goal === null` 时整体返回 null，客户端只渲染空态文案——agent 建 goal 之前用户无法配置代理/Burp 端口等启动期就要用的参数。现在 viewSrcState 恒返回完整视图（goal 字段可为 null），投影 schema 同步放宽 goal 可空、stateVersion 6→7（自动重算）；UI 各处本就处理 goal===null（头部空名、报告显示未初始化）。新会话打开即可直接配置基础设施。
- 测试 40/40 绿（新增 viewSrcState 无 goal 断言 + isJsonValue 对两种旧炸弹形状的失败守卫）+ SSR 回归 23/23（新增新会话渲染用例）。

## 0.1.0-local.11（真实测试第三轮 3 问题修复：infra 表漏声明 / 面板直写不打扰 AI / 代理测活 / 备注换行）

- **[修复·关键] `domain 'src' declares no table 'infra'`**：local.9 引入 infra 设置时只改了 `SESSION_SCOPED_TABLES` 与迁移注释，**忘了在 `defineDomain` 的 spec 里声明 `infra` 表、也没把 domain version 提到 8**——storage-domain 是严格声明白名单，`domain.table("infra")` 直接抛错；面板保存经 agent 调 src_set_infra 时全部失败，值从未落库（这就是「填了再去看变成空」的原因）。已补 `srcInfraSchema` + spec.tables.infra + version 7→8，下次打开自动迁移并建表。单测没抓住是因为 harness 的 MemoryDomain 对任意表名自动建表（掩蔽 bug），真实环境是严格白名单。
- **[行为] `/src-infra` 改为面板直写**：不再 followup 打扰 agent——命令处理器直接调 SrcStore.setInfra 落库，并合成一条 `tool/call src_set_infra` 会话事件保持投影/时间线同步；返回文本带生效值，立即生效。协议同步改为「每次相关测试前必须重新 src_get_infra」。
- **[新功能] `/src-proxy-test` 代理测活**：服务端用现有 CONNECT 隧道直接经配置代理请求探针地址（gstatic generate_204），结果（HTTP 状态+耗时/失败原因）直接显示在基础设施页，全程不经过 agent。UI 新增「测试代理连通」按钮。
- **[改进] `/src-burp-test` 两段式**：先 host 侧 TCP 探测 burpMcpPort（3s 超时）——端口不通时直接给出中文诊断（扩展未装/未 Start/端口不符），完全不打扰 agent；端口可达才 wake agent 做 MCP 层验证。
- **[UI] 待办备注框改 textarea**：支持多行备注，Enter 发送、Shift+Enter 换行、Esc 取消。

## 0.1.0-local.10（真实测试第二轮 5 问题修复：remote.commands 注入 / 对照账号语义 / 多手机号 / Burp 测试按钮 / 待办备注框美化）

- **[修复·关键] `cannot get property "remote.commands" without inject`**：待办发送与基础设施保存全部报此错。根因：cordis 把每个 Remote 命名空间挂为字面量服务名 `"remote.<namespace>"`（`RemoteNamespaceService extends Service`，`super(ctx, "remote.commands")`），而 traceable 代理把 `ctx.remote.commands` 转成 `ctx["remote.commands"]` 查找——模块导出 inject 只写 `"remote"` 不够，必须同时声明 `"remote.commands"`（对照 dsh-client-ui-commands 的 CommandUiRuntime inject 列表确认）。ui-src.client.js 的 inject 数组已补上，待办与基础设施两条链路共用此修复。
- **[语义] 越权对照账号 testAccount**：明确为凭据格式 user:pass 或用户名。协议规定 agent 优先脚本登录构造低权会话做 A/B 对照；无法自动登录时创建用户待办请用户提供登录态，禁止臆造凭据。UI 标签/占位符同步。
- **[功能] testPhone 支持多个号码**：src_set_infra 校验放宽为逗号/顿号/分号/空白分隔的号码列表（逐个验证格式）；UI 占位符、工具描述、协议同步说明。
- **[UI] 基础设施页 Burp MCP 说明重写**：新增说明卡片——三步接线清单（装扩展并 Start → 核对 cordis.patch.yml 的 jar 路径 → 点「测试 Burp MCP 连接」按钮）、显示本机 patch 文件路径、明示端口/jar 两项仅是记录不改配置。新增 `/src-burp-test` 人机命令：转达 agent 立即调用 mcp__burp__get_proxy_history 实测连接并中文汇报结果。
- **[UI] 待办备注框美化**：改为卡片式容器（圆角+浅底色+边框，跟随深色模式），顶部灰色说明行（✓已完成/✗放弃 + 备注可选提示），全宽输入框，右对齐「发送/取消」按钮。

## 0.1.0-local.9（真实测试 7 问题修复：脏目标 / 待办异步化 / 基础设施页 / 时间线重设计 / 全程中文）

- **[修复] 脏目标解析**：`src_add_goal` 的 target 带中文说明（如 `mi.com（小米在线服务主域，含 *.mi.com 子域）`）时，六个出站工具（scan_surface/test_bypass/test_credential/import_traffic/collect_dorks/collect_passive）直接 `new URL()` 抛错。新增 `parseGoalHost()`：非 ASCII 输入跳过 URL 直解（防 IDNA punycode 出乱码主机名），依次尝试「带 scheme 直解 → 加 https:// 直解 → 正则提取首个域名 token」，全部失败给出中文可行动报错。新增 `src_set_goal_target` 工具让 agent 在目标带杂质时就地修正而不清空探��图。
- **[新工具] `src_get_infra` / `src_set_infra`**：会话级基础设施设置（proxyUrl/burpMcpPort/burpProxyJarPath/testAccount/testPhone/httpTimeoutMs），存 sqlite 新表 infra（domain version 7→8，旧库自动迁移）。出站请求统一走 `makeHttpFetch(infra)`：手写 CONNECT 隧道支持 HTTP(S) 代理（不引入 undici 依赖）、永不跟随重定向、超时与 4MB 上限可控；进程级代理用 Node 24 `--use-env-proxy` 文档化。
- **[UI] 待办按钮异步化 + 备注**：✓完成/✗放弃点击后先展开 inline 备注输入框（Enter 发送/Esc 取消），备注随 `/src-todo <id> <status> <note>` 转达给 agent；修复模块导出 inject 缺 `"remote"` 导致点击报错的问题（boot manifest inject 是包加载顺序，模块导出的 inject 才是 cordis 服务名——runCommand 依赖 ctx.remote.commands.execute）。
- **[UI] 新增「基础设施」tab**：表单读写六项设置（保存经 `/src-infra <key> <value>` 人机命令写回，value 为 `-` 表示恢复默认）；附 Burp MCP 接线示例与进程级代理说明。子代理 deny 列表追加 src_set_infra/src_set_goal_target（src_get_infra 允许读取）。
- **[UI] 时间线重设计为「时间轴 + 详情」双栏**：左列色点+时间+单行摘要+按类型过滤 chips（全部/意图/事实/漏洞/检查点/探测），右侧详情面板按类型渲染完整字段——observation 含响应头/响应体原文与决策理由，finding 含七字段+原始请求响应，checkpoint 含阶段小结与决策；顺带修复事实事件从未显示的潜伏 bug（facts 在 projection nodes 里而非顶层 facts 数组）。
- **[纪律] 协议新增【用户待办】【基础设施】两章**：待办标题≤30字含完整登录 URL、detail≤120字分步指引；auth-session 必须走 Burp 三步流程并用 mcp__burp__get_proxy_history 取包、禁索要 HAR 原始包；短信/越权测试前必须先 src_get_infra。全程中文纪律���化（禁 let me/I'll 等英文插入语）；ask_user_question 仅限开场唯一阻塞时机。

## 0.1.0-local.21（包名署名修正：@howmp → @lihua_dis）

- **[改名] 包标识从 `@howmp/dsh-src` 全面迁移到 `@lihua_dis/dsh-src`**：原 scope 系沿用 dsh-pentest 参考项目的命名约定，属错误署名。替换范围：package.json name/author、cordis 服务名×4（ui-src/storage-sqlite/preset-root/src）、invariant 注册名、UI 模块与 CSS 资源 id（构建产物内）、README/docs 全部命令路径、LICENSE 版权行。tgz 资产名相应变为 `lihua_dis-dsh-src-<版本>.tgz`。
- **[安装] 安装目录变化**：包现位于 `~/.dsh/profiles/<p>/node_modules/@lihua_dis/dsh-src/`；从旧版本升级需删除旧 `@howmp/dsh-src` 目录（新旧并存会被宿主识别为两个插件）。caps-sync 默认路径文档已同步。
- 对 dsh-pentest 参考项目的技术致谢保留于 README「致谢」节。

## 0.1.0-local.20（自主收官三闸 + 报告「等你的事」+ AI 面自动深挖）

- **[门禁] finalize 收官三闸**（背景：实战会话第一波即 finalize，blocked intent 不建待办、报告后无人唤醒）：①`remainingDirections` 必填参数——调用前逐项枚举还能推进的方向，非空直接拒绝并回显清单；②pending 用户待办从 warning 升级为 blocker；③存在 blocked intent 但从未创建任何用户待办 → blocker（有待办但无关联 → warning 提示补建 intentId 关联）。三闸均可 `allowIncomplete=true` + reason 越过（受限完成声明照旧写入报告）。
- **[提示词] 【终止】重写为收官前三问**（待办清了吗/blocked 都有待办吗/还有可推导方向吗），禁止用「收益递减」含糊替代枚举；新增「报告不是终点」语义；禁止以收敛报告为由 interrupt 仍在产出结果的子代理。【用户待办】新增配对铁律：因缺用户输入标 blocked 的同一回合必须建 src_user_todo（intentId 关联）。
- **[报告] 尾部固定「⏸ 等你的事」区块**：列出 pending 待办（kind+标题+操作指引）与无待办关联的 blocked intent；无等待事项时显示「已完整收敛」。用户打开报告即可分辨自己是旁观者还是需要动手。
- **[AI 面] 放开自动深挖**：撤回「ai-surface 只落资产标注 manual-recommended 不作为 finding」的一刀切——语义复核确认真实 AI 面后按新内置课程 lessons/ai-abuse 自主推进：优先越权面/key 暴露（硬通货），再间接注入与工具滥用（src_serve_proof OOB 取证）；系统提示词泄露只作注入链证据；纯越狱不构成独立 finding。测不了或不全面（需登录态 RAG 投毒、浏览器人工交互）一律建 manual-test 待办移交用户，不得静默跳过。audit persona 同步。
- **[课程] 新增内置经验 lessons/ai-abuse.md**：测试优先级、无害金丝雀纪律（绝不真实生成违规内容，用受限标记物证明能力）、收录标准、常见误判。
- **[修复] 经验索引标题污染**：lessonIndex 标题混入「## 触发场景」等正文行（原实现取前 3 行拼接后匹配 ^#），改为全文按行匹配第一个一级标题。

## 0.1.0-local.8（质量标准修正 + finalize 门禁收紧 + 冗余工具清理）

- **[政策] 漏洞质量标准修正**：撤回"信息泄露/指纹类只能作 fact 不得作 finding"的一刀切禁令——SRC 平台接受一切有实际危害的真实漏洞（如版本暴露可匹配已知 CVE 定向利用），关键改为如实论证危害、severity 如实定级、不夸大不虚构；finalize 里对应的「仅 info/low 不构成真实危害」从 blocker 降级为 warning。同步修正 audit/verify 子代理 persona 措辞。
- **[门禁] allowIncomplete 收紧**：`src_finalize_engagement` 带 `allowIncomplete=true` 时必须提供 `allowIncompleteReason`（为何带限制出报告：WAF 全程拦截/范围耗尽/用户指示停止等）；理由作为 coverage 声明行写入报告的「资产与测试覆盖率」一节，不再是无痕逃生门。
- **[门禁] unverified finding 阻断消息给出可执行路径**：明确要求先委派 src_verify 子代理独立复核并以 `src_record_research(status=verified, findingId=…)` 关联后再 finalize。
- **[清理] 删除冗余工具 `src_record_recon` / `src_record_asset_observation` 注册**：与 src_add_asset/src_add_fact 完全重叠且实测服从率为零；两者 fold case 保留，旧会话投影回放不受影响（顺带修复 legacy record_recon 回放的 ReferenceError——replay 助手误定义在 src/submit 分支内）。

## 0.1.0-local.7（修复：待办 tab 崩溃 + SRC 视图入口标签）

- **[严重] 修复点击「待办」tab 后整个 SRC 视图崩溃变空白**：local.6 的 SrcView JSX 引用了 `runCommand` 但函数签名漏了解构该 prop，渲染待办列表时抛 `ReferenceError: runCommand is not defined`，被 slot ErrorBoundary 接住后整个视图替换为空 div。已补上签名；新增完整 SrcView 渲染回归测试（含 todos tab + 有/无 runCommand 两分支）。
- **[UI] 头部视图标签错标修正**：zh 字典 `view.src` 从「渗透」改为「SRC」——此前 src-hunter 会话头部第三个 tab 显示为"渗透"，实际是 SRC 漏洞挖掘视图，用户无法辨认入口。

## dsh web 启动 / 停止（部署后的进程管理）

本机 + 局域网共用一个实例（绑 `*:3080`）：

```bash
# 停止：找到监听 3080 的进程并结束
kill $(lsof -ti TCP:3080 -sTCP:LISTEN)

# 启动（后台常驻，日志落 /tmp/dsh-web-local9.log；必须用绝对路径——nohup 不继承 shell 的 export PATH；
# < /dev/null 不能省：stdin 挂在管道上时父进程退出会让 dsh 读到 EOF 静默退出）
nohup "$(pnpm bin)/dsh" web \   # 或 dsh 在 PATH 时直接用 nohup dsh web
  --host 0.0.0.0 --port 3080 \
  --trusted-host 192.0.2.7:3080 --no-open \
  > /tmp/dsh-web-local9.log 2>&1 < /dev/null &

# 验证
lsof -nP -iTCP:3080 -sTCP:LISTEN
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/
```

- 本机访问 http://127.0.0.1:3080 ；局域网访问 http://192.0.2.7:3080
- 日志里的 `Failed to connect to SSE server at https://localhost:9876` 是 Burp MCP 代理在等 Burp 的 MCP Server 扩展（Burp 未开时属正常噪音，不影响其他功能）。
- 注意不要同时跑两个实例指向同一 profile（会并发写同一个 sqlite）。

## 0.1.0-local.6（时间线 observation 详情 + 待办 UI 写回通道）

### 时间线 observation 请求详情（点击展开）
- 投影 observation 补 `respHeaders`/`respBodySnippet`/`assetId`：fold 时截断（响应头 ≤600 字符、响应体片段 ≤1200 字符），避免直接 tool/call 参数无上限把投影撑爆；store 仍保留完整 ≤2000 片段。
- 时间线中带响应数据的 observation 行显示「▸ 点击展开响应详情」，点击展开 响应头 / 响应体片段 pre 块（等宽字体、限高滚动、可收起）。无 snippet 的行不显示展开提示。

### 待办面板 UI 勾选写回通道（UI → agent）
- 新增人机命令 `/src-todo <todoId> <done|abandoned|pending> [备注]`（注册在 src 插件的 agent 作用域，仅 src 会话可见）。
- 命令不直接写状态，而是 `agent.followup(createUserMessage(...))` 把用户操作转成一条对话消息并**唤醒空闲 agent**——由 agent 自己调 `src_user_todo` 落库+投影，单一写路径，且 agent 明确知道待办状态变化、可继续解除阻塞的工作。
- Web 面板「待办」tab 的 pending 项新增「✓ 我已完成」「✗ 放弃此项」按钮：经 `ctx.remote.commands.execute(sessionId, line)` 调用命令，按钮态（发送中/已转达/失败原因)就地反馈；投影更新后列表自动刷新。
- package.json dsh.client.inject 增加 `@deepseek-ai/dsh-api-remotes`（客户端 remote 调用面）。

## 0.1.0-local.5（UI 数据面 + 展示审计修复）

### 投影数据层（此前 UI 拿不到这些数据）
- **[致命] asset type enum 缺 5 种新类型**：投影 schema 只认 6 种资产，出现 ai-surface/threat-intel/mini-program/client/firmware 时 `schema.parse` 直接抛错 → **整个 src 投影崩溃、UI 全挂**。已补全 10 种。
- **[严重] finding 7 字段被 zod strip**：entryPoint/discoveryPath/rawRequest/rawResponse 在投影 view 输出时被静默剥离，UI 与导出报告永远拿不到。schema 已补。
- intent/fact/finding 节点补 `createdAt`（fold 时写入），时间线按真实时间排序（此前全部 at:0 按 id 排，非时间序）。
- 投影 view 补 `apiDiscovery` 统计（API 发现/schema/GraphQL/未推进），header 的 API 发现行从死代码变为真实数据。

### UI 展示
- FindingsView：渲染 漏洞接口来源/前端功能点/原始请求/原始响应（=== Request === / === Response === pre 块）。
- report tab 导出报告补齐与服务端 buildReport 一致的 7 字段结构（数据包优先 raw 请求/响应，无则回退 pocEvidence）。
- AssetsView：显示 状态（待确认/已排除）/来源/方式(非 passive)/置信度%；AI 服务面/威胁情报资产行 🤖 高亮+橙色。
- 资产类型徽标与分组补全 10 种（小程序/客户端/固件/AI 服务面/威胁情报此前在列表和图模式直接消失）。
- tab 徽标：时间线计数含 observations；待办 tab 显示 `(n 待处理)`。
- header counts 行追加 探测次数/pending 待办数（zh/en 字典同步）。
- TodoListView：pending 排最前，done/abandoned 沉底（组内按创建时间倒序）。
- ExploreView 详情抽屉：fact 显示 目标/置信度；finding 追加 危害/修复建议/POC 证据。

## 0.1.0-local.4（全库审计修复）

### 存储
- **v6→v7 原地迁移**：`SqliteStorageBackend.materializeUnit` 对旧版本库自动升级版本戳（新表由 CREATE IF NOT EXISTS 确保旧行由 zod default 补齐字段），不再抛 version-mismatch；更新版本（降级）明确拒绝。
- **WAL 收缩**：backend close 时 `PRAGMA wal_checkpoint(TRUNCATE)`，不再残留膨胀 WAL 文件。

### 投影（UI 数据面修复）
- 投影 schema/view/fold 补齐 `observations`/`userTodos`（此前 UI 时间线 observation 事件与"待办"tab 恒为空）+ counts 两项；checkpoint 投影补 `decision` 字段；stateVersion 4→5。
- `src_submit` 合成投影事件透传 decision（此前时间线决策标签丢失）。
- `src_import_traffic` 每条 observation 落库后补合成 `src_record_observation` 投影事件（Burp MCP/HAR 导入流量�� UI 时间线可见）。
- `src_state` render 文本提示 pending 用户待办。

### preset filter
- 三个子 agent deny 列表补 `src_record_observation`；recon 子 agent 额外收窄 `src_collect_passive/src_collect_dorks/src_import_traffic/src_scan_surface`（被动收集与流量导入是主 agent 编排职责）。

### 工程化
- `"test"` 脚本修正为 `node --test tests/src.integration.test.mjs`（原 vitest 未安装必失败）；移除未使用的 devDependencies。
- peerDependencies 放宽为 `>=0.1.0-rc.6`（钉死 rc.6 且镜像无此版本导致任何 install 失败）。

## 0.1.0-local.3（批次2-5 整改落地）

### 新工具
- `src_collect_dorks`：五类 Google dorks 被动收集（凭据/敏感文件/目录/历史/云端），尽力抓取 DuckDuckGo，受阻时落 fact 附 `web_search` 指令，只对授权域名执行。
- `src_import_traffic`：三模式流量导入 `mcp`（Burp MCP 预取流量）/`har`（HAR 文件）/`raw`（HTTP 文本）→ observations + 认证画像 fact（认证头完整入库）+ endpoint 资产。
- `src_test_credential`：泄露凭据复现（配额豁免：不受≤50/低RPS约束；红线：只测凭据对应账户自身越权面，不横向）。
- `src_record_observation`：时间线观察层（method/path/status/protectionSignal/wafBypassed/source/decision）。
- `src_user_todo`：用户待办清单（仅主 agent 可创建；pending/done/abandoned；用户完成后 agent 继续）。

### 报告 7 字段（批次4）
- finding 新增 `entryPoint`（前端功能点）/`discoveryPath`（漏洞接口来源）/`rawRequest`/`rawResponse`。
- `src_report` 输出：漏洞描述/危害描述/域名/完整URL/漏洞接口来源/前端功能点/数据包（=== Request === / === Response ===）/POC/影响范围/修复建议/影响资产/复现步骤。
- finalize 门禁：rawRequest 非空（Burp 格式数据包必填）。

### UI（批次3）
- 时间线新增 observation 事件（橙色：method/path/status/WAF/bypassed/decision）。
- 新增“待办”tab：用户待办面板（⚠pending/✅done/❌abandoned + kind + detail + 用户备注）。

### AI/威胁情报资产识别（批次5）
- `src_collect_passive` 自动识别 AI 站点（openai/deepseek/qwen/kimi/gemini 等）→ `ai-surface` 资产 + `ai-abuse` 研究骨架（manual-recommended）；威胁情报平台（fofa/shodan/censys/奇安信等）→ `threat-intel` 资产。
- 定级指南对齐小米 SRC 四档（严重/高/中/低），impact 需注明定级依据。

### Burp MCP 接入（已完成配置；后续已被自愈桥替代，见上文「接入你自己的 Burp MCP」节）
- 架构（历史）：`dsh-mcp-client(stdio) → mcp-proxy.jar → Burp Pro MCP 扩展(SSE 127.0.0.1:9876)`；
  现行为 `dsh-mcp-client(stdio) → burp-mcp-bridge.mjs（包 patch 默认启用）→ Burp Pro MCP 扩展`
- jar 已固定到 `~/.dsh/tools/mcp-proxy.jar`（已弃用）；profile patch 已写 `mcp-burp`（failOnStartupError:false，Burp 未开不影响其他工具）
- **用户侧一次性步骤**：Burp Pro → Extender/插件市场装 "MCP Server" 扩展 → Start
- agent 工具面多出 `mcp__burp__*`（get_proxy_history/send_to_repeater 等）；协议【Burp MCP 工具面】段已写明用法（proxy history→src_import_traffic 落库→认证画像→Repeater 回写）

### AI 面识别两层漏斗
- 第一层（代码粗筛）：22 个关键词 + 路径特征（/api/chat、/v1/completions、event-stream）+ 置信分档（0.5-0.9），命中才进漏斗
- 第二层（agent 语义复核）：audit 子 agent persona 要求拉页面判断"是否真 AI 服务"（对话入口/模型 API 调用/流式响应），排除营销文案误报；复核为假置 false-positive

### 剩余外部依赖
1. **wedecode**：小程序反编译工具，确认已装后迁移小程序 skill。
2. **App 下载方式**：应用商店 URL/二维码，落 asset meta。

### checkpoint 决策字段
- `src_submit` 新增 `decision` 参数：为何继续/停止/换向/绕过，进时间线。
