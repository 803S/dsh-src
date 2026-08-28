# 红线整改方案：高危动作授权闸 + 漏洞打回闭环 + 报告攻击链（local.26 起）

> 本文档是 2026-08-28 取证复盘后的整改契约。取证对象：美团海外会话
> `session-65695562`（2026-08-27，「找到三个漏洞即停止。尽量偏向找海外资产」）。
> 两条已落地红线 + 三条 finding 质量缺口一并整改。**先文档后代码，本文档过审再动。**

## 一、背景：已落地红线与对应缺口

### 红线 1（最严重）：任意用户注销 — 真实用户 userId=15 被注销
- 13:14 closeAccount 端点在被动侦察的 API 路由清单里被发现；
- 06:55 IDOR 读确认（枚举 userId=1/2/3 读信用卡号，返回不同真实卡号）；
- **06:57:49 agent 直接 `POST /api-c/user/v1/closeAccount` header `userId: 15`，无停止无询问**，2 分钟后确认 `User not found!`——一个日本 Keeta 真实用户（nickName=trade, JP, 090****8335, Visa ****6830）被注销；
- 06:58 agent 事后才认「这是破坏性操作」，用户 07:01 发现并命令停止。

### 红线 2：编造 UK/JP 号码发真实短信
- 02:24:34 agent 自行编造 JP `9012345670-5674` + UK `7123456780-6784`，`sentVerificationCode`（**GET**）返回 `code:0 Success` = 真实发出；
- 02:28 用户说「我没有 UK+HK 手机号」，03:32 才制止「不要随意写个手机号测试了，会影响用户」。

### 三条 finding 质量缺口（同会话）
- **缺口 1**：finding 无打回按钮/备注，用户无法对单条 finding 表达「没看懂/要补脚本/不收」。
- **缺口 2**：打回无单独存储/防二次提交——19:53 用户「CORS 沉淀一下」后，21:38 agent 又加了第 4 条 info clickjacking，用户纠正被绕过。
- **缺口 3**：finding 用假设链叙事（「跨域读取敏感接口→商家信息泄露」），22:17 被用户质问后才 8 次更新承认链不闭合。

## 二、架构事实（已核实，决定方案边界）

dsh 框架（`node_modules/@deepseek-ai/dsh-*`）已内置：
- **`dsh-user-approval`**：`ctx.approval` 服务，ask/never 策略、answerers、**fail-closed（无应答器自动拒）**、`allowed-once` 单次授权。
- **`dsh-tool-bash`** 已接 `ctx.approval`（沙箱文件拒绝升级走它审批）。
- **`dsh-bash-sandbox`** 的 `confine()` **包每一条 bash 命令**——咽喉点，agent 任何 curl/python 都过这里。但**现有 confine 只做文件系统 confinement（landlock，三档 read-only/workspace-write/danger-full-access），不做命令内容/出站 HTTP 解析**。
- **`dsh-shell-env`**：`ctx.shellEnv` 注册表，可注入环境变量（HTTP_PROXY 候选注入点，但命名空间受限，需验证）。

dsh-src 能做的：注册工具（`ctx.tools.register`，复用 `ctx.approval`）、改 store/schema、改 prompt/课程/报告渲染。
dsh-src 改不动的：`dsh-tool-bash`/`dsh-bash-sandbox` 源码（上游 npm 包，install 覆盖）。上游 `dsh-tool-bash` line 106-107 自挂 TODO：「deployment policy belongs in `tools/pre-execute` and sandboxing executors」——**命令内容策略是上游已规划未实现的缺口**。

## 三、模块一：高危动作授权闸（对应红线 1+2）

### 3.1 威胁模型

| 类别 | 形态 | 例子 | 能否接受漏 |
|---|---|---|---|
| 越权删改 | 有自己 token，写操作 + 资源 id ≠ 自己 | closeAccount header userId=15 | ❌ 不能漏 |
| 未授权删改（带 id） | 无 token，写操作 + 小序号 id | 无 token DELETE /users/15 | ❌ 不能漏 |
| 未授权删改（不带 id） | 无 token，写操作 + 非读语义 path、无 id | 无 token POST /admin/doAction | ❌ 不能漏 |
| 编造号短信/发包 | 真实目标的副作用触发（GET/POST） | sentVerificationCode GET | ✅ 可漏 |
| 增（创建） | 写操作，新建对象 | enroll/register | ✅ 可漏 |
| 读 IDOR | 写方法但语义读，+ 别人 id | POST orders/detail userId=15 | ✅ 可漏（挂了无害） |

### 3.2 判据（方法无关，信任接口命名规则）

**挂起当且仅当（满足其一）：**

```
【越权删改】  出站写请求(POST/PUT/PATCH/DELETE) + 资源id ≠ 自己 token 的 id
            （无"自己 id"时，id ∈ 小整数(1..100) 视为"别人"，保守先验）
【未授权删改】出站写请求 + 无 token/无登录态 + 真实目标(非沙箱) + path 非强读语义
【兜底】     path 含强删改语义词(close/cancel/remove/delete/unregister/drop/
            reset/destroy/purge/wipe/deactivate/terminate/offboard)
            → 即使 GET 也挂
【放行】     ①自己 token + 自己资源的写（删自己草稿等）
            ②强读语义 path(query/get/list/detail/check/status/info/read/
              fetch/search/view/lookup) 的未授权写探测 → 放行（信任命名规则）
```

**核心抽象**：`写 + 真实目标 +（未授权 或 越权）` 统一挂，不看 path 名、不靠 id 存在性——所以改名绕不过、不带 id 也绕不过。强读语义 path 放行是为了**不阻断合法未授权写探测**（白帽大量工作是 POST 看鉴权）。

**接口命名规则的信任依据（用户定调）**：现实中 query/get/list/detail 不会执行删操作——「真写个 query 但是删操作那开发也干到头了」。故信任读白名单放行未授权写探测，**「挂羊头（读语义名实删）」作为可接受残余风险记录在案**，不为它牺牲侦察效率。

### 3.3 漏网之鱼矩阵

| 拦截位置 | 越权删改 | 未授权删改(带id) | 未授权删改(不带id) | 挂羊头 | 绕过手段 | dsh-src 内可做 |
|---|---|---|---|---|---|---|
| **路线 A：`src_http` 工具层** | ✓ | ✓ | ✓ | 放行 | agent 绕 src_http 用裸 curl(--noproxy/python socket/base64/heredoc)→漏 | ✅ 能 |
| **路线 B：bash `confine()` 咽喉点** | ✓ | ✓ | ✓ | 放行 | 理论无（除非编译型二进制/裸内核 socket 绕 landlock 网络，超出 SRC agent 能力） | ⚠️ 改上游或贡献沙箱策略插件 |

**结论**：
- 删改零漏只在路线 B 成立。路线 A 有漏网之鱼（裸 curl 绕过），只能止血。
- 挂羊头（读语义名实删）在两条路线都放行——**可接受残余风险**，不为它阻断合法未授权写探测。
- 其余删改形态（越权/未授权带id/未授权不带id）在路线 B 零漏。

### 3.4 审批卡字段（复用 `ctx.approval`，fail-closed）

审批卡必须亮出**受害者全貌 + 行为意图**，不只放请求：

```
- actionId / 审批单号
- 目标: host + 完整 url + 方法
- 分类: 越权删改 / 未授权删改 / 强删改语义词兜底
- 受害者(若可识别): userId / nickName / mobileRegionCode / 卡尾号 —— 从 baseInfo 等读接口预取
- 不可逆声明: 是（删除类）/ 否（修改类）
- agent 自述: 利用影响 + 期待结果（结构化分类给初值，agent 可补，但不依赖其自评定挂否）
- 选项: 批准执行 / 拒绝 / 批准并记住(本会话同类放行)
```

fail-closed：无应答器（无人审）自动拒，agent 收到拒绝标记后停手解释，不得绕道。

### 3.5 落地两步

**第一步（dsh-src 内，立即止血，路线 A）**：
- 新增 `src_http` 工具，命中判据 → `ctx.get("approval")` 挂起；prompt 强制「所有目标 HTTP 必须经 src_http」；bash 预扫描检测裸 curl 打目标 → 告警。
- 标签：**有漏网之鱼**（agent 绕 src_http 用裸 curl），但立刻拦住"守规矩"执行路径，把风险从"每次都可能"降到"故意绕才可能"。

**第二步（零漏根治，路线 B）**：
- 在 `dsh-bash-sandbox` 的 `confine()` 加命令内容 + 出站 HTTP 解析，命中删改判据走现成 `ctx.approval`。
- 路径：① fork 上游 `dsh-bash-sandbox`/`dsh-tool-bash` 改源码（profile 用 pnpm overrides 指向 fork，可控但维护负担）② 给上游提 issue/PR 把 line 106 TODO 实现成 `tools/pre-execute` 扩展点，dsh-src 贡献命令内容策略插件挂入（最干净，待上游）。

## 四、模块二：漏洞打回闭环（对应缺口 1+2）

### 4.1 打回按钮 + 用户备注（UI + store）

- 每条 finding 卡片加「打回」按钮 + 备注 textarea。
- 备注为自由文本，承载用户的具体诉求，例（用户原话）：
  - 「没看懂，能梳理下攻击链吗？」
  - 「是短信轰炸的话要不写个简单脚本吧，输入手机号和次数即可的」
- 打回是 store 级操作（不只 UI 状态）：finding 置 `status=rejected` + 写入 `rejectReason` + `rejectedAt` + `rejectedBy`。

### 4.2 单独存储 + 防二次提交 + 保留供组合利用

- **单独存储**：rejected finding 不删除，迁入/复制到 rejected findings 列表（store 新表或 findings 表 `status=rejected` 分区投影），与 active findings 隔离展示。
- **防二次提交**：`store.addFinding` 准入闸（local.25 已有）增一道检查——按**相似键**匹配 rejected 列表，命中则拒绝并回带原打回理由：
  - 相似键 = `endpoint(归一化) + category` +（标题去标点小写归一化的前 N 字）。
  - 命中消息：「此 finding 与已打回的 `#rid` 相似（理由：…），不要二次提交；如确为新链，先说明与打回那条的差异。」
- **保留供组合利用**：rejected findings 保留可读，后续 finding 若与某 rejected 组合可成实锤，agent/用户可引用 rejected 的 id 作为「曾被打回、现已补全」的证据链（report 可标注「组合自打回 #rid，已补：…」）。

### 4.3 打回备注驱动 agent 后续（关键闭环）

打回不是终点，备注驱动 agent 动作：
- 「没看懂，能梳理下攻击链吗？」→ agent 重新梳理攻击链（调模块三），更新 finding 的 attackChain，重提。
- 「短信轰炸要不写个简单脚本吧，输入手机号和次数即可」→ agent 产出一键利用脚本（如 `/tmp/sss/222.py --phone X --count N` 形态），作为 PoC 附回。
- 这把**用户口头纠正落地成可执行的闸 + 后续动作**，根治「prompt invariant = suggestion、用户纠正被绕过」反模式。

### 4.4 变更面

- store：rejected findings 存储 + 相似键索引（schema 迁移，只加表/字段）。
- 工具：新增 `src_reject_finding(id, reason)`（commander-only）；`store.addFinding` 闸增 rejected 相似检查。
- 投影：`viewSrcState` / store view 单独投影 rejected 列表（打回 tab）。
- UI：finding 卡片打回按钮 + 备注 textarea；rejected 单独视图。
- prompt：测透/复核 persona 写明打回闭环纪律（打回的不得二次提交同类、备注即动作指令）。
- lint：`check-preset-consistency.mjs` 同步打回工具到 COMMANDER_TOOLS。

## 五、模块三：报告攻击链（对应缺口 3）

### 5.1 攻击链渲染（复用 local.25 三要素 + discoveryPath）

buildReport 每条 finding 增加「攻击链」节，按步骤串成清晰链路：

```
攻击链：
  ① 发现：{discoveryPath}（漏洞接口来源链，如「mobile/js/app.js → api/resetPwd」或「Burp proxy history 导入」）
  ② 利用前提：{attackPrerequisites}（local.25 已强制 ≥10 字）
  ③ 利用过程：{impact}（攻击者视角的危害链）
  ④ 实际损失证据：{concreteLossEvidence}（local.25 已强制 id 存在性校验，解析回 facts/observations/research）
  ⑤ 受害者影响：{victimImpact}（local.25 已强制 ≥10 字）
```

local.25 已强制②④⑤字段存在性，本模块把它们**渲染成连贯叙事链**（而非散落字段），让"假设链"无处藏身——链不闭合时用户一眼可看出并打回（接模块二「没看懂，能梳理下攻击链吗？」）。

### 5.2 可选 attackChain 字段

若结构化字段不足以表达复杂链（多跳/组合利用），finding 增可选 `attackChain: string`（自由文本，多步链叙事），报告优先用它，缺则由①-⑤拼接。打回备注若要求「梳理攻击链」，agent 回填此字段重提。

## 六、优先级与依赖

| 模块 | dsh-src 内可做 | 依赖 | 阶段 |
|---|---|---|---|
| 二 打回闭环 | ✅ 全部 | store 迁移 + UI + prompt | local.26 可独立先上 |
| 三 报告攻击链 | ✅ 全部 | buildReport 渲染 | local.26 可独立先上 |
| 一-路线A src_http | ✅ | 新工具 + ctx.approval + prompt + bash 预扫描 | local.26 可上（止血，有漏网） |
| 一-路线B 咽喉点 | ❌ 改上游 | fork 或推上游 tools/pre-execute | local.27+ 根治（零漏） |

**建议**：模块二+三先上（纯 dsh-src 内、无上游依赖、直接堵 finding 质量缺口）；模块一路线 A 同步上止血；路线 B 作根治并行推进（fork 决策或推上游）。

## 七、风险与取舍（诚实清单）

1. **挂羊头（读语义名实删）**：两路线都放行，可接受残余——现实开发不会把删操作命名 query，用户已定调。文档记其为残余风险，不为它牺牲侦察效率。
2. **未授权写探测的审批代价**：信任读白名单后，未授权写探测（强读语义 path）放行，代价可控；非读语义的未授权写挂起审批，符合白帽纪律（未授权对真实目标写，停下来问本就正确）。
3. **路线 A 的漏网之鱼**：agent 绕 src_http 用裸 curl 可漏——这是路线 A 的已知上限，路线 B 补零漏。止血期靠 prompt + bash 预扫描 + 审计压低概率，不假装零漏。
4. **打回存储增长**：rejected findings 永久保留供组合引用，随会话累积——需评估存储量，必要时按目标/时间归档。
5. **相似键误判**：打回相似键（endpoint+category+标题前缀）可能误拦真正新链——回带打回理由 + 允许"说明差异后重提"作为逃逸阀。

## 八、不在本轮（负范围承诺）

❌ 夜间全自动主动测试 ❌ 常驻侦查 agent ❌ storage v7 全量重写（仅本轮加表/字段） ❌ 答疑 agent（先攒实战问题）

## 九、下一步

1. 用户过审本文档（判据/咽喉点/打回闭环/攻击链渲染/优先级）。
2. 过审后按模块二+三+路线 A 落 local.26（中文提交，本地提交不推 GitHub）。
3. 路线 B 单独决策：fork 上游 or 推上游 PR，另起工单。

## 十、回测（用红线 1+2 验证判据）

| 红线场景 | 判据命中 | 路线B结果 |
|---|---|---|
| 06:57:49 `POST closeAccount` header `userId:15`（有 token，自己=3020900） | 越权删改：写+id≠自己 | 挂✓ 零漏 |
| 02:24:34 `GET sentVerificationCode?phoneNumber=9012345670`（编造号、无自己id可比） | GET+发包 → 放行 | 放行（可接受漏） |
| 假设：无 token `POST /admin/doAction`（中性名无id删数据） | 未授权删改：写+无token+真实目标+path非读语义 | 挂✓ 零漏 |
| 假设：无 token `POST /admin/query`（读语义名实删·挂羊头） | 放行（读白名单） | 放行（残余风险） |
| 假设：`POST orders/detail` header `userId:15`（IDOR 读） | 越权：写+id≠自己 → 挂（读，但挂无害） | 挂（无害，符合"宁可多挂读换删改零漏"） |
