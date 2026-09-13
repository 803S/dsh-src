# local.79 实施计划：覆盖硬闸三件套（顺丰 a3c0672c 会话实战复盘落地）

> 状态：待实施。本文档是完整实现规格，按顺序执行即可，无需再做设计决策。
> 背景证据：session-a3c0672c（顺丰 hkhub-attend 重跑，跑在 local.77 代码上）vs 无境 Cairn 报告（16 finding vs 1 finding）对照复盘。

## 0. 反膨胀红线（先读，全程适用）

1. **本计划零静态预算增长**：不改 SRC_INSTRUCTIONS、不改任何工具 description、不改 lessons 内容。三件套全部是服务端闸 + 运行时错误消息。错误消息不进任何预算池。
2. 完成后必须跑 `node scripts/check-preset-consistency.mjs`，断言 description 合计 ≤15000、lessons ≤20000（当前 13263 / 14081，**数字不得上升**）。
3. 不重写 projection（applySrcEvent 红线）；不改任何 schema 的字段名/required（lossless 红线）；不动 src_events 红线（永不阻塞工具路径）。
4. 不新增模块文件 → deploy.mjs 清单无需改动。
5. Git 提交信息一律中文，格式 `local.79：…`；本文档单独一个 commit，代码+测试一个 commit。

## 1. 改动一：checkpoint 完整性闸（blocker，最高优先）

**问题实证**：a3c0672c 会话 §10 divergence 观测点发出 **12 次** `completed-intent-has-completed-checkpoint`（intent-1「前端 JS bundle 解析与 API 端点测绘」、intent-2「API 接口未授权可达性探测」标 completed 但**零 checkpoint**，全部会话仅 intent-3 有 1 条 checkpoint）。finalize 三次调用全部放行（allowIncomplete）。「说测完了但实际没测」的主通道就是它。

**位置**：`lib/src/tools/index.js` finalize 闸段，插在 `pendingTodos` blocker 之后（约 L2762，`存在 N 个未完成的用户待办` 那段后面）。

**规则**（口径与 §10.3-③ 断言完全一致，见 `lib/src/event-store.js` L82）：
```js
/* [local.79] checkpoint 完整性闸：divergence 12 次实证的主通道。 */
const doneCheckpoints = new Set((view.checkpoints ?? []).filter((c) => c.stage === "completed").map((c) => c.intentId));
const completedNoCheckpoint = view.intents.filter((intent) => intent.status === "completed" && !doneCheckpoints.has(intent.id) && intent.systemMigration !== true);
if (completedNoCheckpoint.length > 0) blockers.push(`以下 intent 标 completed 但没有任何 stage=completed 的 checkpoint（委派结果从未回流，"说测完了但实际没测"的主通道）: ${completedNoCheckpoint.map((i) => `${i.id}/${i.title}`).join(", ")}。请补 src_submit(stage=completed, summary=实测结论) 或如实把 intent 改回 running`);
```

**注意**：
- `blockers`（不是 warnings）——intent 完成必须以 checkpoint 回流为凭，这是 §10.3 已确立的不变量，本次只是从「观测」升级为「拦截」。
- `systemMigration !== true` 豁免必须保留（与 event-store.js L82 口径一致，系统迁移行不适用）。
- checkpoint.stage 枚举：`progress/completed/blocked/failed`（lib/src.js L1213）；只认 `completed`。

**回归风险与处理**：新增 blocker 可能使既有 finalize 测试挂掉（fixture 里 completed intent 没配 completed checkpoint）。处理原则：**先跑全量测试，挂掉的 fixture 补 checkpoint 数据修复，不许放宽闸**。但逐个确认挂的是 fixture 数据问题而非合法路径（合法豁免只有 systemMigration）。

## 2. 改动二：资产覆盖对账闸（两条 warning）

**问题实证**：
- 无境报告覆盖 3 个面（hkhub-attend / HKAA / AA APP）16 条 finding；我们会话 goal 限定单域正确守范围，但 fact-7 发现的关联域情报（cas-captcha、顺丰 OSS、内网 API）**只记 fact 不升级**——没有建「扩授权范围确认」userTodo，用户永远不知道隔壁还有 8 条 finding 的面。
- 唯一 1 个 subdomain asset 只有 3 条 coverage 行，「每个登记资产至少被覆盖」无任何检查（DeepSeek 指出的 subdomain/domain 型资产无对账，属实）。

**位置**：`lib/src/tools/index.js` finalize 闸段，插在改动一之后。

**规则 A（confirmed 资产零覆盖 → warning）**：
```js
/* [local.79] 资产覆盖对账：confirmed 资产既无 coverage 行绑定也无 fact 文本提及 → 疑似"登记了没测"。 */
const coveredAssetIds = new Set((coverage ?? []).filter((row) => typeof row.assetId === "string" && row.assetId !== "").map((row) => row.assetId));
const hostOf = (v) => { try { return new URL(/^https?:\/\//.test(v) ? v : `https://${v}`).hostname; } catch { return String(v).toLowerCase(); } };
const goalHost = hostOf(view.goal.target ?? "");
for (const asset of view.assets ?? []) {
	if (asset.status !== "confirmed") continue;
	const mentioned = (view.facts ?? []).some((f) => hostOf(asset.value) === hostOf(f.target ?? "") || String(f.detail ?? "").includes(hostOf(asset.value))) || (view.findings ?? []).some((f) => String(f.detail ?? "").includes(hostOf(asset.value)));
	if (!coveredAssetIds.has(asset.id) && !mentioned) warnings.push(`资产 ${asset.id}（${asset.type}: ${asset.value}）已 confirmed 但没有任何 coverage 行绑定、也没有任何 fact/finding 提及——确认是否真的测过；没测就继续测或如实标 excluded`);
}
```
- 首版 **warning 不 blocker**：资产与测试的关联可能走 fact 文本（fact schema 无 assetId 字段，只有 target/detail），文本匹配是弱关联，硬拦会误伤。观察一版实战再决定升级。

**规则 B（范围外候选资产无待办 → warning）**：
```js
/* [local.79] 范围外候选升级：candidate 状态的主机型资产（goal 域外）必须交给用户拍板，不许悄悄躺平。 */
const externalCandidates = (view.assets ?? []).filter((a) => a.status === "candidate" && ["subdomain", "root-domain", "ip"].includes(a.type) && (() => { const h = hostOf(a.value); return h !== goalHost && !h.endsWith(`.${goalHost}`); })());
if (externalCandidates.length > 0) {
	const hasScopeTodo = (view.userTodos ?? []).some((t) => t.status === "pending" && /范围|授权|scope|扩/i.test(`${t.title ?? ""}${t.detail ?? ""}`));
	if (!hasScopeTodo) warnings.push(`发现 ${externalCandidates.length} 个授权范围外的候选主机型资产（${externalCandidates.slice(0, 5).map((a) => a.value).join(", ")}${externalCandidates.length > 5 ? "…" : ""}）但没有对应的范围决策待办——建 src_user_todo 请用户拍板是否扩授权范围，或标 excluded 说明不属于本目标。顺丰教训：隔壁域 8 条 finding 白丢`);
}
```
- 只查主机型（subdomain/root-domain/ip）：endpoint/app 型 candidate 多来自流量导入，会制造噪音。
- `view.userTodos` 状态枚举含 pending；匹配 /范围|授权|scope|扩/i 即认为已有待办。

## 3. 改动三：observations 数据源薄弱警告（warning）

**问题实证**：a3c0672c 会话 `http.request` 遥测仅 **2 次**（都是 checkLogin），observations 仅 4 行；真正的测试请求（getFillStaffId POST 等）全走子代理 curl。local.78 对账闸靠 observations 去重对账——数据源被绕行架空，agent 只要少报 claimed 就能蒙混。

**位置**：`lib/src/tools/index.js` local.78 对账闸块内（约 L2793-2818，`auditedCoverage` 定义之后）。

**规则**：
```js
/* [local.79] 通道收归提示：有对账数字但 observations 稀疏 = 关键请求绕过了受控通道。 */
if (auditedCoverage.length > 0 && (view.observations ?? []).length < 5) warnings.push(`coverage 已声明接口对账数字，但 observations 仅 ${(view.observations ?? []).length} 条——大量测试请求疑似绕过 src_http 走了裸 curl，审计链路缺失。收官前用 src_http 重放关键请求（同 method+path 各一条即可），否则报告证据不可复现`);
```
- 阈值 5：a3c0672c 实测 4 条（恰好该被警告）；正常单域会话 checkLogin+页面+若干 API 轻松超过。
- warning 不 blocker：绕行本身不否定结果真实性，只是审计弱。

## 4. 明确不做（防止实现者自作主张）

- **不动 lesson 激活注入**：push 机制已存在（local.62 `lessonsForContext`，挂点 src_add_intent/src_test_bypass/src_run_capability/src_finalize_engagement，11/11 builtin lessons 带 triggers+hook，top-3 上限）。a3c0672c 会话 skill.read×4 说明部分生效。扩挂点等下一批遥测数据再定，单独一版。
- **不动 skillHints**（tools/index.js L2605 的 coverage 映射）：它本来就该叫 coverageHints，改名涉及 schema 字段名红线，收益为零。
- **不删** fold 里的 recon 兼容 case、v1 legacy 视图、L1518 legacy-infra 通道（DeepSeek 建议的死代码清理）：recon 兼容 case 涉及旧会话回放，legacy 视图有 30 天兼容窗口约定，单独一版做。
- **不改** src_record_coverage 的 schema（不加必填 assetId）：会破坏既有调用，规则 A 用弱文本关联代替。

## 5. 测试清单（tests/src.integration.test.mjs 末尾追加 `[local.79]` 块）

沿用现有 harness 惯例（参考 §10 测试块）：每个 harness 前 `flags.resetFlagsForTests()` + `__resetSharedDomainOpensForTests()`；child 会话写库走 `src_submit`（child 直调 src_add_fact 会因 requireGoal 炸——既有设计）；事件测试若涉 flag 先 set 后 reset 再 set（resetFlagsForTests 会删 env）。

- **T1**：finalize 时存在 completed intent（无 completed checkpoint）→ `ready:false` 且 blockers 文本含该 intent id；随后经 src_submit 补 stage=completed checkpoint → 重新 finalize 该 blocker 消失。
- **T2**：goal 域外 candidate subdomain 资产 + 无范围待办 → warnings 含「范围决策待办」文本；建 pending userTodo（标题含「扩范围」）→ warning 消失。
- **T3**：confirmed asset 无 coverage 行且 facts/findings 均不提及其 host → warning 含资产 id；补一条 detail 含该 host 的 fact → warning 消失。
- **T4**：coverage 行带 endpointsTotal>0 且 observations 仅 1-2 条 → warnings 含「绕过 src_http」文本。
- **T5（回归）**：全量 `node --test tests/src.integration.test.mjs` 绿（基线 189 + 新增 ≥4）；既有 finalize 测试若因新 blocker 挂，修 fixture 数据（补 completed checkpoint）而非放宽闸。

## 6. 实施顺序与提交

1. 本文档先单独 commit：`local.79：覆盖硬闸三件套实施计划（顺丰 a3c0672c 会话 12 次 divergence + 无境 16 finding 对照复盘落地）`
2. 代码 + 测试一个 commit：`local.79：覆盖硬闸三件套——completed-intent 必须有 completed checkpoint（blocker）、confirmed 资产零覆盖与范围外候选无待办（warning）、observations 稀疏通道收归警告；XXX/XXX 绿`
3. `package.json` version bump → `0.1.0-local.79`（含在代码 commit 里）
4. 验收命令（全部必须过）：
   ```bash
   node --test tests/src.integration.test.mjs          # 全绿
   node scripts/check-preset-consistency.mjs           # 预算数字不涨（description ≤13263、lessons ≤14081 基线）
   ```
5. `node scripts/deploy.mjs` → 重启 web：
   ```bash
   lsof -ti tcp:3080 | xargs kill 2>/dev/null; sleep 1
   cd ~/.dsh/profiles/web && (nohup dsh web > /tmp/dsh-web-local79.log 2>&1 & echo $! > /tmp/dsh-web-local79.pid)
   sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/   # 期望 200
   ```
   注意：lsof 可能返回多个 PID（旧进程残留），kill 后若 3080 仍被占，用 `lsof -ti tcp:3080` 找真实监听 PID 逐个杀再启动（EADDRINUSE 教训）。

## 7. 验收后的用户侧验证点（写进 commit message 提醒）

下次真实会话（顺丰 09-14 恢复后）重点观察：
- intent 标 completed 前是否主动补 checkpoint（闸是否改变了行为而非只制造重试）
- 发现范围外候选资产时是否建范围决策待办（顺丰 HKAA 8 条 finding 的洞）
- observations 数量是否显著上升（通道收归是否生效）
- finalize blockers/warnings 里三类新消息的出现频率（遥测 engagement.finalized 事件可统计）
