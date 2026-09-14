# local.80 + local.81 实施计划：产出差距闭环（UI 对账可见性 + Phase 7 测绘种子闭环）

> 状态：待实施。两个 Part 相互独立，**先 A 后 B**，各自独立提交；只做 A 不做 B 也完全成立。
> 背景：顺丰 a3c0672c 会话 vs 无境报告复盘（16 finding vs 1）确认的产出差距根因——UI 看不见对账数字（A）+ 测绘深度不足（B）。闸（local.78/79）解决记账诚实性，本计划解决「看得见」和「测得全」。
> 设计依据：手册 docs/optimization-implementation-handbook-2026-09-12.md §11 Phase 7（已评审设计，本文档将其落为可实施规格）。

## 0. 全局红线（两个 Part 通用，违反即返工）

1. **Git**：提交信息一律中文，格式 `local.80：…` / `local.81：…`；文档与代码分开 commit；`package-lock.json` 勿带入。
2. **预算**：Part A 零静态预算增长（不改任何工具 description/SRC_INSTRUCTIONS/lessons）。Part B 新增一个工具，description ≤800 字符（最终 description 合计 ≤14063，距 15000 硬闸留余量），完成后把新总数写进手册基线。每次提交前跑 `node scripts/check-preset-consistency.mjs` 必须绿。
3. **不动**：applySrcEvent（projection 红线）；已有 schema 的字段名/required（lossless 红线）；src_events 机制；local.78/79 的三道闸。
4. **新增模块必须同步进 `scripts/deploy.mjs` 的 files 清单**（local.67 教训）。
5. 改模板字符串/拼接块后必须 `node -e "await import(...)"` 验证语法（历史上翻车两次）。
6. 测试全量跑一轮约 60 秒，用后台方式：`node --test tests/src.integration.test.mjs > /tmp/t.log 2>&1`；harness 惯例：每个 harness 前 `flags.resetFlagsForTests()` + `__resetSharedDomainOpensForTests()`；child 会话写库只能走 `src_submit`。
7. 动手前 `git log --oneline -3` 确认工作区干净（当前 HEAD 应为 2387145）。

---

# Part A（local.80）：UI 对账可见性 + 开局引导

## A1. 背景

- local.78 给 `src_record_coverage` 加了 `endpointsTotal/Tested/Skipped` 对账数字，服务端 finalize 闸已用，但 UI 报告 tab 的 coverage 表没有这两列——用户在界面上看不到「清单 30 = 实测 6」。
- 数据链路已通：store 记录（lib/src.js L933）→ wire schema（lib/src.js L177，三个 optional 字段）→ `buildGraph` 直接透传 coverage 全行（lib/src/reporting.js L11 `coverage: state.coverage ?? []`）。**后端零改动**，只缺 UI 侧类型声明和渲染。
- 顺丰会话的另一个教训：开局没做 Burp 流量导入和 scan_surface，agent 从零静态爬。src_add_goal 返回值加一次性开局引导（工具返回是运行时消息，不进静态预算）。

## A2. 改动清单

### A2.1 TS 类型补字段
文件：`src/dsh-client-ui-src/types/projection.ts`（L159-170 `SrcProjectionCoverageRow`）
在 `limitation: string` 之后加三行：
```ts
  readonly endpointsTotal: number | undefined
  readonly endpointsTested: number | undefined
  readonly endpointsSkipped: readonly string[] | undefined
```

### A2.2 报告 tab coverage 表加「对账」列
文件：`src/dsh-client-ui-src/src/client/ReportView.tsx`（L85-92 `coverageTableLines`）
- 表头数组追加 `t('report.colEndpoints')`（放 `colAsset` 之后、`colLimitation` 之前）。
- 行数据对应位置：`row.endpointsTotal === undefined ? '—' : `${row.endpointsTested ?? 0}/${row.endpointsTotal}${(row.endpointsSkipped ?? []).length > 0 ? `（跳过${row.endpointsSkipped.length}）` : ''}``（格式：`实测/清单（跳过N）`，无数字显示 `—`）。

### A2.3 locales 加 key
文件：`src/dsh-client-ui-src/src/client/locales.ts`
两处（zh L89 附近、en L240 附近）各加：`'report.colEndpoints': '对账'` / `'report.colEndpoints': 'Tested/Total'`。

### A2.4 src_add_goal 开局引导
文件：`lib/src/tools/index.js`（src_add_goal 的返回值组装处）
在成功返回的 text 尾部追加两行引导（找到现有返回文本，追加而非重写）：
```
开局建议（各跑一次再开 intent）：① src_import_traffic 导入 Burp proxy history（拿登录态真实 API 面，比静态爬 JS 全）② src_scan_surface 扫前端（前缀分簇/多后端/Cookie 服务名信号）。
```
注意：**只改返回文本，不改 description**（description 有预算闸）。

## A3. 构建与验收

```bash
cd src/dsh-client-ui-src && npm run typecheck && npm run bundle   # bundle 产物自动 cp 到 lib/ui-src.client.js
node scripts/check-preset-consistency.mjs                          # description 13263 不变（零增长）
node --test tests/src.integration.test.mjs                         # 193/193（A 不加测试，回归不炸即可）
node scripts/deploy.mjs                                            # ui-src.client.js 在清单内
# 重启 web：
lsof -ti tcp:3080 -sTCP:LISTEN | xargs kill; sleep 1
cd ~/.dsh/profiles/web && (nohup dsh web > /tmp/dsh-web-local80.log 2>&1 & echo $! > /tmp/dsh-web-local80.pid)
sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/   # 200
```
UI 验证（留给用户，写进 commit message）：跑过 coverage 的会话 → 报告 tab → coverage 表出现「对账」列。

## A4. 提交

一个 commit（含 version bump `0.1.0-local.80`）：
`local.80：UI 报告 coverage 表加对账列（实测/清单/跳过）+ src_add_goal 开局引导（流量导入+扫前端先行）；typecheck/193 绿/预算零增长；待用户浏览器验证对账列`

---

# Part B（local.81）：Phase 7 测绘种子闭环

## B1. 设计要点（源自手册 §11 Phase 7，已评审）

**动机**：无境 16 条 finding 中 9 条来自测绘面（同域多后端、相邻系统）；我方 JS 提取只出 5 路径 vs 无境 30+。核心缺口是「目标从哪来、怎么穷尽」——发现的 host/端点没有形成「种子 → 逐个闭环」的队列纪律。

**硬性原则**：
- **FOFA 可选**：无 key 时全部功能降级可用，不许出现「没 key 就不可用」的路径。
- **一种子闭环是服务端闸**（非提示语）：同一时间只允许一个 active 种子；其活面未全部处置时 `next` 拒绝并返回剩余活面计数。模型忘了纪律也绕不过去。
- **401/403/登录墙/挑战页判存活不丢弃**（存活≠在登录表单上耗）。
- **股权闸人工版**：全资 1-4 级主体名/品牌/根域建议入队、参股默认不挖——判定提示交给模型+用户确认（src_user_todo），不自动调工商 API。
- **模式判定**：用户给定 URL 清单/固定站=锁面（禁 FOFA 自由跳）；模糊目标（只给集团名）=自由跳。判定写进工具返回引导语，**不进协议常驻文本**。
- flag `DSH_SRC_SURVEY=off|shadow|on`，默认 off，off 时行为与当前完全一致（工具不注册）。

## B2. 改动清单（按实施顺序）

### B2.1 flags.js：加 DSH_SRC_SURVEY
文件：`lib/src/flags.js`（VALID L6 / DEFAULTS L14 两个 freeze 对象）
- `VALID` 加 `DSH_SRC_SURVEY: ["off", "shadow", "on"]`
- `DEFAULTS` 加 `DSH_SRC_SURVEY: "off"`
- 惰性读函数 `srcSurveyFlag` 照抄 `srcEventStoreFlag` 的写法（**必须惰性**，模块级固化是已知 bug 模式）。

### B2.2 新表 survey_seeds（srcDomainSpec v13→v14）
文件：`lib/src.js`
- 新 zod schema（放 srcEventSchema 附近）：
```js
const srcSurveySeedSchema = z.object({
	id, sessionId: id,
	kind: z.enum(["root-domain", "subdomain", "ip", "url"]),
	value: z.string().min(1),
	status: z.enum(["pending", "active", "done", "dead"]),
	source: z.string().default("user"),   /* user-list / js-hint / backfill / fofa / manual */
	note: z.string().default(""),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative()
});
```
- `srcDomainSpec`（L1394）加 `survey_seeds: domainTable(srcSurveySeedSchema)`，`version: 13` → `14`。
- 注意：这是正式领域记录（sessionId 顶层必填，与 src_events 的 payload 内嵌不同）；开盘往返测试（[local.47] 域往返）若枚举全表需同步 fixture。
- **事件旁账不接**：种子的增删改不进 src_events（§10 红线是领域写入插桩，种子生命周期不是领域投影对象；保持 src_events 现有 6 种事件类型不动）。

### B2.3 新模块 lib/src/survey.js（纯函数层）
新建文件，导出（全部纯函数，不 import 组合根，与 event-store.js 同一纪律）：
```js
/** 种子表 key：sessionId:survey-seed-<n>（recordKey 同款） */
export function surveySeedKey(...)
/** [闭环判定] active 种子是否已处置完毕：该种子 value 的 host（及其子域）下每个已登记资产
 *  满足以下之一即算处置——有 coverage 行绑定 / fact·finding 文本提及（hostOf 弱关联，口径同 local.79 闸二A）/
 *  status=excluded。未登记任何资产也算处置（种子里没长出东西=挖完了）。返回 {closed, remaining[]} */
export function seedClosureStatus(seed, { assets, coverage, facts, findings })
/** [存活判定] 响应分类：'alive' | 'parked' | 'dead'。
 *  dead=超时/连接失败/DNS 不解析；parked=200 但命中停放页关键词（停放|出售|parking|buy this domain|默认站点）；
 *  其余一律 alive——401/403/登录页/挑战页/WAF 拦截页都是 alive（硬性口径）。 */
export function classifyProbeResponse({ ok, status, bodySnippet })
/** host 提取（与 tools/index.js local.79 的 hostOf 同逻辑，这里成为唯一实现，tools 侧后续可引用） */
export function hostOf(value)
/** 锁面/自由跳模式判定：goal.target 是具体 host（含 scheme 或点分域名）→ locked；含「集团|公司|全体|所有」
 *  或纯品牌词 → free。返回 {mode, guidance}，guidence 是返回给模型的引导语（不进协议常驻）。 */
export function surveyModeOf(goalTarget)
```

### B2.4 store 方法
文件：`lib/src/store.js`
加 4 个方法（复用现有 domain 打开/写入模式，参考 addAsset）：
- `async addSurveySeed(sessionId, { kind, value, source, note })`——同 value 去重（返回已有行+duplicate:true）
- `async surveySeeds(sessionId)`——按 createdAt 排序
- `async updateSurveySeed(sessionId, id, patch)`——status/updatedAt 更新（只允许 pending→active、active→done/dead、pending→dead 的合法迁移，非法迁移 throw）
- 读写走 `survey_seeds` 表，写后照常 `appendSessionToolEvent`（工具事件层，与领域事件无关）。

### B2.5 工具 src_survey_seed
文件：`lib/src/tools/index.js`（注册处加条件：`if (srcSurveyFlag() !== "off") ctx.tools.register(...)`——off 时工具不存在=行为与当前完全一致）
- `name: "src_survey_seed"`
- **description ≤800 字符**（预算硬约束），要点：测绘种子队列与一种子闭环；动作 add/list/next/complete/backfill/probe/fofa；锁面/自由跳模式说明；401/403 判存活口径；股权闸人工确认。写完自查字符数。
- 参数（`action` + 各 action 的字段）：
  - `add {value, kind?, source?, note?}` → 入 pending 队列（去重）；返回含 surveyModeOf(goal).guidance（锁面模式：提示「种子仅用于组织归属确认与范围决策，禁止 FOFA 自由跳」）。
  - `list {}` → 各状态计数 + 明细（cap 20 行）。
  - `next {}` → **服务端闸**：存在 active 种子时，`seedClosureStatus` 不 closed 则 throw（消息含 remaining 数量与清单前 5 项：「种子 X 的活面未处置完（剩 N）：…——挖完/记废/标 excluded 后再取下一个」）；closed 则完成旧种子（active→done）并弹最老 pending→active；队列空返回明确空态。
  - `complete {seedId, outcome}` → outcome 枚举 `exhausted|dead|superseded`；done/dead 落库。
  - `backfill {value, note?}` → 挖到优质面时回灌其注册根域为 pending（active 未闭环不影响入队，只是 next 不弹）。
  - `probe {seedId}` → 对 active/pending 种子做存活批量探测（对种子 host 发 GET，复用现有 http 请求基建与代理通道——参考 src_scan_surface 的 fetch 用法；并发 ≤3、超时 8s、总量 ≤20 host/次）：结果按 classifyProbeResponse 分类，dead 的 host 记 fact（kind=recon，detail 写「非存活：超时/探不通」）防止重复探测，alive 的照常入资产流。**不发任何高危请求，纯 GET 首页**。
  - `fofa {seedId, maxPages?}` → 见 B2.6。
- 股权闸：add/backfill 返回文本带固定提示行：「入队前确认组织归属：全资 1-4 级主体名/品牌/根域可直接入队；参股/拿不准的建 src_user_todo 交用户确认，默认不挖」。

### B2.6 FOFA provider（可选，无 key 全降级）
文件：`lib/src/survey.js` 内实现 `fofaSearch(seed, { key, base, maxPages, fetchImpl, sleep })` 纯异步函数（fetch 注入便于测试）：
- key 从 `process.env.DSH_SRC_FOFA_KEY` **惰性**读；无 key 时 `fofa` action 返回降级提示（「未配置 DSH_SRC_FOFA_KEY，跳过 FOFA provider；种子闭环不依赖它」），**不报错**。
- 查询围绕单个种子（`domain="example.com"` 语法），翻页 ≤maxPages（默认 3）；429 指数退避（1s/2s/4s，3 次后放弃返回部分结果+提示）。
- 结果：host → assets（type=subdomain，status=candidate，source="fofa"）；**key 值绝不进返回文本/日志/telemetry**（只回「provider=fofa, N hosts」）。
- 锁面模式下 `fofa` action 直接拒绝（「固定站锁面模式禁用 FOFA 自由跳」）。

### B2.7 persona deny lists
文件：`preset/src-hunter/agent.cordis.yml`（**手维护文件**，三个 subagent persona 的 toolFilter deny 数组在 L204/L216/L228）各追加 `src_survey_seed`（种子调度是指挥官专属）。
**勿动** `cordis.patch.yml` 里「dsh-src capabilities:8< 自动生成区段」（那是 caps-sync.mjs 从 capabilities.yaml 生成的，改那里会被下次 sync 覆盖）。改完跑 `node scripts/check-preset-consistency.mjs` 验 persona×toolFilter 一致性。

### B2.8 deploy 清单
文件：`scripts/deploy.mjs` L32 files 数组加 `"lib/src/survey.js"`（放 event-store.js 之后）。

### B2.9 手册状态行
文件：`docs/optimization-implementation-handbook-2026-09-12.md` §11 Phase 7 章节头追加完成状态行（commit sha + 测试数 + description 新基线数字）。

## B3. 测试清单（tests/src.integration.test.mjs 末尾 `[local.81]` 块）

- **T1 注册闸**：flag off（默认）时 harness 的 tools 里**无** `src_survey_seed`；设 `DSH_SRC_SURVEY=shadow` + reset + 再 set 后新 harness 有该工具（「set→reset→再 set」顺序，resetFlagsForTests 会删 env——local.77 教训）。
- **T2 生命周期**：add（含去重：同 value 二次 add 返 duplicate）→ next 弹出 active → complete(exhausted) → done；list 计数正确。
- **T3 一种子闭环闸**：active 种子下登记 1 个未处置资产（无 coverage/无提及/非 excluded）→ next throw 且消息含「剩 1」；给该资产补 coverage 行（assetId 绑定）后 next 放行。再验「未登记资产=自然闭环」分支。
- **T4 存活分类**（纯函数）：401/403/登录页 bodySnippet → alive；200+停放关键词 → parked；超时 ok:false → dead；200 正常业务 → alive。
- **T5 FOFA 降级**：无 key 时 fofa action 返回降级文本不 throw；锁面模式（goal.target=具体 host）时 fofa 被拒。
- **T6 零污染**：flag off 全程 `survey_seeds` 表零写入；[local.47] 域往返测试仍绿（v14 schema 兼容）。
- **T7 开盘往返**：survey seed 行通过 srcDomainSpec 开盘 schema（sessionId 顶层必填）。

## B4. 验收与提交

```bash
node --test tests/src.integration.test.mjs          # 193+新增 全绿
node scripts/check-preset-consistency.mjs           # description 新总数 ≤14063 且写入手册基线
node scripts/deploy.mjs && 重启 web（同 Part A 流程，日志 /tmp/dsh-web-local81.log）
```
提交（均为中文）：
1. 代码+测试+bump `0.1.0-local.81`：`local.81：Phase 7 测绘种子闭环——survey_seeds 表+src_survey_seed 工具（add/list/next/complete/backfill/probe/fofa）+一种子闭环服务端闸+401 判存活+FOFA 可选降级+DSH_SRC_SURVEY 开关；XXX/XXX 绿`
2. 手册：`local.81：手册 §11 Phase 7 完成状态行+description 基线数字更新`

## B5. 明确不做（防自作主张）

- 不改 SRC_INSTRUCTIONS（种子纪律全部走工具返回引导语+服务端闸，不进协议常驻）。
- 不动 src_events 的 6 种事件类型（种子生命周期不进事件旁账）。
- 不自动调工商 API（股权闸人工确认版）。
- 不删 local.79 三道闸、不改 skillHints、不动 lessons 注入面（等遥测数据）。
- FOFA 之外不接 hunter/shodan（接口按 provider 留扩展位但不实现）。
- probe 动作只做 GET 首页存活探测，不做端口扫描/目录爆破。
