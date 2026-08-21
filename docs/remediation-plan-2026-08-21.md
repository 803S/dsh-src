# dsh-src 整改规划文档

日期：2026-08-21
来源：lzit.edu.cn 真实跑（session-a737b09e）全链路分析 + 用户 9 项反馈 + 政策线确认
状态：**仅规划，未动代码**

---

## 一、本次真实跑诊断汇总

### 1.1 产出统计

| 维度 | 数量 | 备注 |
|---|---|---|
| intent | 16 | intent-6（注入验证）、intent-12（弱口令）从头到尾 `planned` 从未执行 |
| fact | ~210（209 yields） | 被动侦察扎实：子域/IP/指纹/认证边界/CSP/证书 |
| finding | **0** | 全程零确认漏洞 |
| checkpoint | 59 | intent-1 独占 ~7 条，audit/verify intent 有 checkpoint（上轮门禁生效前） |
| spawns edge | 2 | **仅 intent-1 委派了 2 个 recon 子 agent；其余 14 个 intent 全是主 agent 自干** |
| 耗时 | ~2 小时 | |

### 1.2 报错/异常分析

| # | 现象 | 根因 | 方案 |
|---|---|---|---|
| A1 | crt.sh 持续 502（checkpoint-11） | 单一证书来源不稳 | 多源兜底（CertSpotter/Google CT/censys），失败显式记 limitation 而非默默换源 |
| A2 | HackerTarget 才补到 ~50 子域（checkpoint-13/15） | 单一被动源；主动枚举被“禁止爆破”卡死 | 放开有限 DNS 字典枚举（见 §3.4） |
| A3 | React 业务 chunk 全 404（checkpoint-44/45，intent-11） | module federation 运行时拼接路径，静态 GET 拿不到 | 走 Burp MCP 拉代理历史里真实浏览时的完整流量（见 §3 P0-3） |
| A4 | **XSS 线索撞过滤名单即弃**（checkpoint-49/59，用户引用段） | “WAF 拦截即停”纪律过严，把“载荷过滤名单枚举”误判为“绕过 WAF” | WAF 纪律三层重写（见 §3.1） |
| A5 | audit/verify 主 agent 自干（spawns 仅 2） | 协议无硬约束（门禁为上轮后加，本跑未生效） | 门禁已上线，待验证 |
| A6 | planned intent 遗漏（6/12） | 指挥官无“清点未执行假设”纪律 | finalize 加 planned-intent 遗漏门禁（见 §3.5） |

### 1.3 产出遗漏/不合理（按价值排序）

1. **XSS surface 放弃**（fact-166/169）：<b> 文本节点未转义回显 + <img onerror> 被拦 = 真实 XSS 面，名单过滤≠不可利用，应继续向量枚举。
2. **找回密码流程未测**（intent-11 blocked）：短信验证码回显/爆破/任意重置是高校站最高频逻辑漏洞，被“JS chunk 404 无法提取 API”阻塞。
3. **弱口令/初始密码未测**（intent-12 planned）：`Lzit@身份证后8位` 规则明确，无样本收集+小并发试登录环节。
4. **登录态业务全盲**：CAS 全站 SSO，子 agent 零凭据，所有受保护业务面（简历/投递/教务）等于没测。
5. **AI/威胁情报面完全没看**：目标无 AI 站点，但流程上没有这一类目，发现了也不会记。
6. **时间线鸡肋**：59 个 checkpoint 只有 stage+summary+计数，无 HTTP 观察、无请求原文、无决策理由。

---

## 二、政策线确认（用户已拍板）

| # | 政策 | 结论 |
|---|---|---|
| P1 | 撞 WAF/载荷过滤名单 | **先绕后破**：防护拦截是有界绕过信号，不是停止线；绕不过才停 |
| P2 | 验证码爆破 | **可以测**：4 位验证码无滑块/滑块可绕 → ~30 次遍历证明任意用户接管 |
| P3 | 短信轰炸 | **可以测**：~10 次无限制即成立 |
| P4 | 小并发爆破 | 允许（设计之初已考虑）：公开密码规则/默认凭据场景、低 RPS、有限次数、撞验证码且不可绕则停 |
| P5 | 开源框架/知名组件 | **白盒审计 + nDay/CVE 历史匹配**：识别框架后直接找源码审计或查已知 CVE，是十分有价值的方向 |
| P6 | 登录态/小程序/App | **通过 Burp Suite MCP 接入**（用户已有商业 Burp Pro）：dsh 的 `dsh-mcp-client` 把 Burp MCP 工具直接挂成 agent 工具面（`mcp__burp__*`），agent 实时读 proxy history/scanner、写回 Repeater，零脚本胶水。HAR/raw HTTP 导入作兜底。小程序需反编译（Src-Pedestal 已有 `wx-minapp-recon` skill）；app 逆向视情况引入 |
| P6b | **Google dorks 被动信息收集**（不只凭证） | 善用 Google 语法做被动信息收集——是 SRC 侦察阶段高价值低成本手段，远不止收集凭证：①泄露凭证（GitHub/Gitee `filename:.env "<domain>"`、`"<domain>" password`、文库/网盘/泄露库，SRC 认可白帽凭此登录测试）；②敏感文件（备份 `.bak/.zip/.tar.gz/.sql`、配置 `config.yml/.env/web.config`、`robots.txt` 泄露的敏感路径、`.git/` 目录泄露、`svn/entries`、`swagger/api-docs` 暴露）；③目录结构与索引页（`intitle:"index of"`、`site:<domain> inurl:admin`）；④历史/临时文件与缓存（`filetype:log`、Google cache 快照里已删页面）；⑤云资产泄露（`x-amz-*`、bucket、OSS 公开）。作 `src_test_credential` 的候选来源（已知凭据复现不受小并发爆破配额约束），也作为 `src_collect_passive` 的重要被动来源补充。安全红线：只测泄露凭据对应账户自身的越权面，不横向；只对授权域名跑 dork |
| P7 | AI 站点/大模型/威胁情报 | 收录并留后续人工测试 |
| P8 | 小米 SRC 对齐 | 收录范围/定级对齐（Web/APP/小程序/IoT/客户端/服务端；严重/高/中/低四档） |

---

## 三、整改规划（按优先级）

### P0-1：WAF/防护纪律重写（§P1+P2+P3）

**改动位置**：`SRC_INSTRUCTIONS`（侦察策略/bypass 研究段）、`src_scan_surface`、`src_test_bypass`、子 agent persona。

**新三层判定**：

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| 初次探测被 WAF/CDN 拦截页挡 | 立即停 | 有界绕过试探（UA 变换、降速、分块、方法/编码变换），低 RPS + 有限请求预算；绕不过 → requiresDecision |
| 特定载荷被过滤名单拦截（`<img onerror>` 被拦但 `<b>` 通） | 立即停（**错误**） | **允许向量枚举**：未拦截标签/编码/解析差异 = bypass-filter-list 研究，SRC 高价值方向；`src_test_bypass` 的 variant 天然支持 |
| 验证码可爆破（4 位无滑块/滑块可绕） | 禁止 | **允许 ~30 次遍历**证明“验证码爆破→任意用户接管”；滑块先做绕过尝试，绕不过则停 |
| 短信轰炸 | 不可测 | **允许 ~10 次**发送测试，无频率限制即成立（medium+） |
| 429 限速 | 立即停 | 退避降速重试；持续 429 才停 |
| 无界暴力（千万字典、DoS、大遍历） | 禁止 | 仍禁止 |

**协议措辞重写要点**（替换现行“侦察策略”段）：

> 【侦察策略】遇 WAF 拦截页/403/challenge：这是“需先绕过才能继续”的信号，不是停止信号。对防护本身做有界绕过（UA/分块/编码/方法/低速）；对特定载荷的过滤名单做向量枚举（未拦截标签/编码/解析差异）——这属正常漏洞研究，不算“绕过 WAF”。4 位验证码无防护（或滑块可绕）时，允许 ~30 次遍历证明任意用户接管；短信接口允许 ~10 次发送测试证明轰炸。只有绕过尝试全部失败、或持续 429 无退避空间，才 requiresDecision。禁止的是无界爆破、DoS、千万级字典、验证码不可绕仍强试。

**工具层**：`src_scan_surface` 增加 `bypassAttempted/bypassed` 返回字段；`src_test_bypass` variant 类型放开“标签/编码替换”；新增验证码/短信预算常量（30/10）写入 schema description。

### P0-2：有限并发爆破（§P4）

**新增工具 `src_test_credential`**：

- 参数：`target/loginUrl/username/candidates(≤50)/rateLimitRps(≤0.5)/stopOnCaptcha/bypassCaptchaAttempted/evidence`
- 场景限定：公开泄露的密码规则（如 `Lzit@身份证后8位`）、默认凭据、公开 Top 密码小字典
- 验证码处理：有验证码 → 先按 P0-1 做绕过尝试；绕不过 → 停止并记 limitation
- 落库：成功命中即 finding（任意用户接管/弱口令），失败记 fact
- preset：audit 子 agent 开放；verify 不开（凭据验证属 audit）

**`src_scan_surface` 路径枚举放开**：≤100 path、低 RPS、撞 WAF 先绕后做（与 P0-1 联动）。

### P0-3：登录态——Burp MCP 接入 + 通用流量导入 + dorks 被动信息收集（§P6 / P6b）

#### 方案选型（曾考虑 Caido，评估后改用 Burp MCP）

| 维度 | **Burp MCP（采用）** | mitmproxy+HAR 导入（备选） | Caido（已否） |
|---|---|---|---|
| dsh 集成成本 | **极低**：profile 加 `dsh-mcp-client` 一段配置，工具自动注册为 `mcp__burp__*`，零脚本 | 中：skill+JSONL tail | 中：GraphQL+脚本 |
| 实时读写闭环 | ★★★ 读 proxy history/scanner + 写 Repeater，agent 与人工协同 | ★ 单向读 | ★★ 读为主 |
| 覆盖 App/小程序 | ★★★ Burp 本身是抓包主力 | ★★★ | ★★ |
| 依赖 | 用户已有商业 Burp Pro | 装新工具 | 装新工具 |

理由：dsh 有 `@deepseek-ai/dsh-mcp-client`（stdio 传输、HMR、工具自动挂 ctx.tools），Burp 官方 MCP jar 正好走 stdio MCP——直接挂即可，无需任何胶水代码，且 agent 可闭环写回（Repeater/主动扫描）。Caido 在 dsh 生态里无优势，放弃。

**保留意见**：Burp 官方 MCP 较新，暴露的 `get_proxy_history`/`send_to_repeater`/scanner tool 的完整度（能否读完整 response body、按 host 过滤）需真机验证。因此做**双保险**：主线 MCP 接入，兜底 HAR/raw HTTP 文件导入——Burp 没开或某 tool 不可用时，用户导出 HAR 即可继续。

#### 架构

```
主线：用户 Burp Pro（开启 MCP 扩展，stdio）
        └─ dsh profile: - id: mcp-burp
                        name: '@deepseek-ai/dsh-mcp-client'
                        config: { serverName: burp, transport: stdio,
                                  command: java, args: ['-jar', '<burp-mcp.jar>'] }
        → agent 工具面多出 mcp__burp__* : get_proxy_history / get_scan_results /
          send_to_repeater / get_repeater_results / set_scanner_target ...
        → src_import_traffic 读这些 + 落库（资产/认证画像/observation）

兜底：用户 Burp/浏览器 DevTools Export HAR → src_import_traffic 吃 HAR/raw HTTP
备选（App/小程序不开 Burp 时）：mitmproxy JSONL → 同 import 通道
```

#### 规划

1. **profile 配置**：在 dsh-src 活动配置加一段 `dsh-mcp-client`(serverName=burp)，文档附 `args` jar 路径与 Burp 扩展注册步骤。`failOnStartupError:false`——Burp 没开也不影响其他工具。
2. **新工具 `src_import_traffic`**：双输入——① MCP 模式：在子 agent 内直接调 `mcp__burp__get_proxy_history`(按 host 过滤) 拉 flows；② 文件模式：吃 HAR 或 raw HTTP 文本。两种输入统一产出：资产（endpoint/cookie 线索）、认证画像（脱敏 cookie/token 注入模板）、observation 落库（进时间线）。对齐 Src-Pedestal 的 `src-core auth import-request`。
3. **新工具 `src_collect_dorks`（Google/GitHub dorks 被动信息收集，§P6b；凭证收集是其用途之一）**：输入目标域名 → 用 `web_search/web_fetch` 跑 dork（仅对授权域名）→ 按五类产出：①泄露凭证（GitHub `filename:.env "<domain>"`、`"<domain>" password`、Gitee、文库、Paste 类）落 fact（meta `leak-source`/`confidence`）供 `src_test_credential` 消费；②敏感文件（备份/配置/`.git`/swagger）→ asset(candidate)+fact；③目录结构与索引页（`intitle:"index of"`、`inurl:admin`）→ fact；④历史/临时文件（`filetype:log`、缓存快照）→ fact；⑤云资产泄露（bucket/OSS）→ asset(candidate)。分类落图，不混合。
   - 配额豁免：已知凭据复现不受“≤50/低 RPS”爆破配额约束（这是直接取证不是爆破）。
   - 安全红线：只测泄露凭据对应账户**自身**越权面，不横向（拿 A 凭据试 B 账户）。
4. **协议**：指挥官发现“大部分业务需登录”时，走决策树：
   - 先 `src_collect_dorks` 被动信息收集（找泄露凭据+敏感文件+目录结构，白帽默认授权）；
   - 找不到则 `ask_user_question` 引导用户开 Burp（或导 HAR），用户声明授权测试账号，agent 经 MCP/HAR 导入认证画像后委派子 agent 测登录态业务。
5. **安全**：认证画像脱敏入库；报告/日志不导出真实 token；finalize 报告只含脱敏快照。
6. **解决 A3**：React module federation chunk 404——用户在 Burp 代理下真实浏览时浏览器已加载 chunk，proxy history 里有完整流量，agent 从中直接提取找回密码等 API（不再静态反推）。

### P0-4：framework 白盒审计 + nDay 匹配（§P5）

**改动位置**：`SRC_INSTRUCTIONS` 研究段 + 新 skill `src-nday-hunter`（或协议指引）。

1. **指纹→框架映射**：fact 里的指纹（VAppServer/6.0.0、VSB 站群、致远 OA、深信服、Sea.js）触发框架研究 intent。
2. **nDay 查询**：子 agent 用 web/bash 查公开 CVE/历史漏洞（NVD/cnnvd/GitHub advisory/ exploit-db 搜索），把“框架+版本+已知漏洞”落 research（category: `nday`），验证可行性后做最小化 PoC 确认。
3. **白盒审计**：开源框架直接拉源码（GitHub/Gitee 搜索），针对目标定制点做定向审计（如 VSB 站群的 getnews.jsp/search.jsp/DWR 接口族）。
4. **research category 扩展**：enum 加 `nday`、`framework-audit`。

### P1-1：时间线重构（observation 层）

参照 Src-Pedestal 三层模型（事件/观察/流量+决策）：

1. **新表 `observations`**：`{intentId, assetId, method, path, httpStatus, respHeaders, respBodySnippet, protectionSignal, wafBypassed, source(burp-mcp/har/manual/scan), createdAt}`。子 agent 每次主动探测落一条；Burp MCP/HAR 导入批量落。
2. **checkpoint 关联 observation ids**：summary 显示“X 次探测/N 被拦/M 绕过/+facts +findings”。
3. **新工具 `src_record_observation`**（子 agent 用）+ `src_import_traffic` 批量导入路径。
4. **决策事件**：checkpoint schema 加 `decision` 字段（为什么停/换向/绕过/不绕过）。
5. **UI TimelineView 重写**：时间轴 + 选中详情（请求/响应原文 + 决策理由）。此时 domain 已需存请求原文，顺带给 storage 加 raw exec 通道，一并解决旧 #7（残留表 drop）#8（WAL checkpoint）。

### P1-2：报告 7 字段 + Burp raw 包

**finding schema 扩展**：`entryPoint`（前端功能点）、`discoveryPath`（接口来源链）、`rawRequest`（Burp 格式 raw 报文）、`rawResponse`（关键响应）。`buildReport`/UI 严格按用户 7 字段顺序输出：漏洞描述/危害描述/域名/完整URL/漏洞接口来源+前端功能点/数据包(Burp)/证明截图说明。finalize 加“rawRequest 非空”门禁。报告注意事项（必填否则被忽略/raw 包至少含接口地址/单报告单类型业务线）写入协议。

### P1-3：planned intent 遗漏门禁

finalize 检测 `status=planned` intent → warning 列出，指挥官须显式转 cancelled 或委派。（救回 intent-6/12 类遗漏）

### P2-1：AI/威胁情报资产收录（§P7）

- 资产 enum 加 `ai-surface`（meta: `ai:chat`/`ai:image-gen`/`ai:llm-api`）与 `threat-intel`。
- `src_collect_passive` 加识别规则：AI 站点特征（openai/anthropic/deepseek/qwen/kimi/gemini/midjourney 等）、API key 形态（`sk-`、`Bearer`）、威胁情报平台（fofa/shodan/censys/qianxin/ti.aliyun）。
- 发现即落 asset（candidate）+ 自动生成 research 假设（prompt-injection/模型越权/key 泄露/SSRF via tool-call），标 `nextStep: manual-recommended`，报告单列“建议人工测试的 AI 资产”段。

### P2-2：小程序/App/端侧收录（§P6 后半 + P8）

- 资产 enum 加 `mini-program`、`client`、`firmware`；`app` 复用并重定义。
- **skill 迁移**：把 Src-Pedestal 的 `wx-minapp-recon`（wxapkg 扫描→wedecode 反编译→接口/参数/敏感信息提取→AI 回填）适配到 dsh skill provider 下；dsh 已有 `skill` 工具机制（按 cwd 发现目录，模型可调用），迁移成本低。
- **流量路径**：小程序/App 抓包同走 Burp（MCP 接入主线）或 mitmproxy（备选）→ `src_import_traffic` → 资产+observation。这是 App 端最实用的路径，无需逆向。
- **App 逆向**（后置）：必要时引入 apktool/jadx 类 skill，仅做静态接口提取+硬编码密钥发现，不做动态插桩。
- **对齐小米 SRC**：app/小程序资产必填“下载方式”（应用商店 URL/二维码）——写进 schema；定级四档（严重/高/中/低）写进 severity 判定指南，impact 注明定级依据。

### P2-3：定级指南对齐小米 SRC

finding 提交时的 severity 判定基准写进协议：严重=直接获权限/RCE/核心数据；高=敏感数据泄露/重要越权；中=普通越权/信息泄露/短信轰炸；低=反射 XSS/一般未授权信息。impact 描述需注明对应平台定级依据。

---

## 四、实施批次

| 批次 | 内容 | 预计规模 |
|---|---|---|
| 批次1（P0） | WAF 纪律重写 + 爆破/验证码/短信政策 + `src_test_credential` + nDay 协议 + planned 门禁 | 协议大改 + 1 新工具 + 2 工具参数扩展 |
| 批次2（P0） | Burp MCP profile 接入 + `src_import_traffic`（HAR/raw/MCP 双输入）+ `src_collect_dorks`（dorks 被动信息收集：凭证/敏感文件/目录/云资产）+ 认证画像（脱敏）+ `src_test_credential` 配额豁免 | profile 配置 + 2 新工具 + 1 新表（auth_profiles）|
| 批次3（P1） | observation 层 + checkpoint 决策字段 + 时间线 UI 重写 + storage raw exec（顺带 #7#8） | 1 新表 + 1 工具 + UI 大改 |
| 批次4（P1） | 报告 7 字段 + Burp raw 门禁 | schema + buildReport + UI |
| 批批次5（P2） | AI/威胁情报收录规则 + 小程序 skill 迁移 + App 资产 + 定级指南 | 收集规则 + skill 迁移 |

---

## 五、待确认项（不阻塞批次1）

1. **Burp MCP jar 路径/接口真机验证**：你下载 Burp 官方 MCP server jar，告知 jar 路径；上线后让我真机枚举它暴露的 `mcp__burp__*` tool 列表（确认能否读完整 response body、按 host 过滤 history）。若关键 tool 缺失，批次2 走兜底 HAR 导入，MCP 线降级或后置。
2. **wx-minapp-recon 依赖**：wedecode 全局安装（`npm i wedecode -g`，Node 环境）——确认本机已装或批准安装。
3. **App 逆向深度**：静态提取级（jadx/apktool skill）是否够用，还是需要 Frida 动态（建议不做，风险和复杂度高）。
4. **dorks 信息收集边界**：`src_collect_dorks` 是否限定只查公开搜索引擎可见的泄露（GitHub/Gitee/文库），还是允许调用已知泄露库 API（如已购买的商业泄漏库）？建议默认走公开 dork，商业库按需人工补。
5. **skill 归属**：minapp/nday skill 放 dsh-src 包内（随插件分发）还是独立 skill 包（按 cwd 发现）？建议独立 skill 包，dsh-src 协议只引用技能名。





---

类似需要用户登录获取登录态的这种可以搞一个用户待办清单，任务先保留待用户协助，用户完成后在面板勾选已完成（也可以留一个用户输入备注的地方简单说明），然后主 agent 看到用户完成则继续测试这样。
