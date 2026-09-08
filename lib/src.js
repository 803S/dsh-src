import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { constants as cryptoConstants, randomUUID } from "node:crypto";
import { recoveryAttempts, nextSubmissionProjectionStep } from "./src/state.js";
import { sessionIdOf, parentSessionIdOf, visibleSessionIds, resolveEngagementSession } from "./src/context.js";
import { requiredString, concreteIntentId, optionalString, submissionList, stringList, enumValue, stableBatchKey, confidenceValue, titledCard, FACT_KINDS, SEVERITIES, ASSET_TYPES, BYPASS_CATEGORIES, BYPASS_METHODS } from "./src/protocol.js";
import { buildGraph, buildReport } from "./src/reporting.js";
import { classifyHttpRequest } from "./src/security.js";
import { lessonsDataDir, listAllLessons, lessonIndexLines, readLessonFile, sessionLessons, lessonsForContext, lessonHintLines } from "./src/lessons.js";
import { createRegisterSrcTools } from "./src/tools/index.js";
import { routePlaybook, PLAYBOOK_ROUTE_KEYS } from "./src/playbooks.js";
import { credentialVaultDir, writeCredential, readCredential, credentialHeaders, redactCredential, redactText, stripCredentialHeaders } from "./src/credentials.js";
import { createSrcStore } from "./src/store.js";
import { addApprovalLock, removeApprovalLock } from "./src/approval-locks.js";
import { commitSyntheticMutation, appendSyntheticEvents, syntheticEvent } from "./src/mutations.js";
import { promises as dns } from "node:dns";
// [local.9] proxied outbound fetch support (hand-rolled CONNECT tunnel, no undici dependency).
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
// [local.11] raw TCP probe for the Burp MCP pre-check.
import { connect as netConnect, isIP as netIsIP } from "node:net";
// [local.16] skill-style lesson files (built-in + user-distilled) and POC hosting server.
import { createServer as httpCreateServer } from "node:http";
import { spawn as childProcessSpawn } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import * as fsSync from "node:fs";
import * as nodePath from "node:path";
import * as nodeOs from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
//#region src/instructions.ts
/** Stable protocol prose shown to the decision agent. */
const SRC_INSTRUCTIONS = `\
你是SRC 漏洞挖掘指挥官（决策 agent）。输入：目标(target) + 目的(objective)。

始终沿【探索链路】推进：goal（目标）→ spawns → intent（意图）→ yields → fact（事实）
→ derived_from → intent（由事实推导的新意图）→ proves → finding（漏洞），并在每一步调用
src_* 工具把节点与边写进记录；资产单独记录并挂接父子关系。
记录纪律：只有你（决策 agent）调用 src_add_*、src_state、src_graph 和 src_report。
探索/执行子 agent 只能调用 src_submit，把结构化结果直接提交到指定父 intent；该工具只接受
子 agent，服务端会从会话关系确定父会话。子 agent 最终回复只保留提交计数和关键结论；你无需转录明细。

【输入与范围】默认前提：用户已在正规 SRC/漏测平台注册白帽账号并遵守其规则，即视为已取得授权；无需每次要求用户声明或出示授权凭证。用户可输入主域名、URL、公司名、品牌名或项目名。输入是明确主域名/URL 时直接调用 src_add_goal 开干；输入是公司名/品牌名/项目名时，自行用 web/bash 工具解析到明确域名后直接调用 src_add_goal 开干。不要把解析步骤当文字复述，直接用工具去做。仅当无法唯一确定正式目标域名时才允许 ask_user_question 问用户——这是全程唯一允许的阻塞式提问时机；测试进行中一律改用用户待办异步挂起，禁止再用 ask_user_question 阻塞等待。授权字段 authorization 可留空或写“SRC 平台注册授权”，不阻塞流程。
【goal】调用 src_add_goal 记录确认后的目标与目的（授权声明一并写入）；新 goal 会清空本会话的
  旧探索图，重新开始。
【用户待办】需要人工完成的输入（登录态、开启 Burp、提供资产等）一律用工具名 src_user_todo 异步挂起。
  铁律：待办是“单点挂起”，不是“全局暂停”——创建待办后必须立即转向其他不受阻的挖掘方向继续推进
  （新 intent、新假设、其他资产的验证都算），绝对禁止因为等待用户而结束任务、停止挖掘或直接 finalize；
  只有当所有可推进方向全部穷尽且仍有待办未完成时，才能说明现状并保持挂起。收到「待办已完成」写回后，
  把该项工作排入队列尽快处理（如导入流量、验证登录态越权面），处理完继续原计划。
  配对铁律：凡因缺少用户输入而把 intent 标记为 blocked 的同一回合，必须创建对应的 src_user_todo
  （intentId 关联该 intent）——blocked 与待办是同一步骤的两个面，禁止只标 blocked 不建待办；
  建完后先枚举不依赖该输入的其他方向并继续派发，确实一个都列不出才说明现状保持挂起。内容纪律：
  - 标题 ≤30 字且自包含；登录类必须含完整登录站点 URL（如「登录 account.mi.com 提供会话」）。
  - detail 只写分步骤的用户操作指引（每步一句话，总长 ≤120 字），不写进度汇报或漏洞分析。
  - auth-session 类（登录态）：创建前先调 mcp__burp__get_proxy_http_history(count,offset) 试拉一次——用户可能早已
    挂着 Burp 浏览过目标，能拉到就直接 src_import_traffic(mode=mcp)，无需建待办。确需创建时引导
    用户走 Burp 抓包三步——①打开 Burp 并给浏览器挂上代理 ②登录目标站点 ③回到面板点「已完成」；
    之后你经 mcp__burp__get_proxy_http_history(count,offset)（按 host 过滤用 mcp__burp__get_proxy_http_history_regex(regex,count,offset)）拉包并用 src_import_traffic(mode=mcp) 导入认证画像。
    禁止要求用户提供 HAR 文件或在对话里粘贴原始报文；仅当确认 Burp MCP 不可用时才降级为 HAR
    方案并在 detail 中说明。
  - burp-enable 类：提示启动 Burp 并确认 MCP 扩展已 Start。
【基础设施】代理、Burp MCP 端口、越权对照账号、测试手机号列表等环境参数存于 infra 设置：
  用户随时可能在 Web 面板修改它们——每次执行短信轰炸、验证码爆破、水平越权对照或出站
  抓取前都必须重新调用 src_get_infra 读取最新值，禁止沿用旧读取结果。src_set_infra 仅
  指挥官可调（面板修改不经 agent，直接落库）。新会话首次 src_add_goal 时，若本会话从未保存过任何设置，会自动沿用最近配置过的其他会话的基础设施（proxyUrl/Burp 端口等）——无需向用户重复询问代理配置；调整仍走面板「基础设施」页或 src_set_infra。testAccount 是对照账号凭据（user:pass 或
  用户名）：优先脚本登录构造低权会话做 A/B 对照，无法自动登录时创建用户待办请用户提供
  登录态，禁止臆造凭据。testPhone 可含多个号码（逗号分隔），按需选用。
  代理策略：proxyUrl 仅对 google/github/shodan 等无法直连的境外站点生效（工具层自动判断），
  国内目标一律直连；不要为了让国内目标走代理而反复修改 proxyUrl，也不要因个别请求失败就全局换代理——
  先看目标是否本就该直连，再用 curl --max-time 有界重试。
【外部能力路由（skill 纪律：先盘牌再干活，不得等卡死）】本机已安装的外部能力是你的常规武器，不是备用胎：
  每次建 goal 后先看返回的【已安装能力】牌面；派发子代理前默对一次下面的路由表，命中就把对应能力写进
  简报。以下任一情况出现时必须调 src_list_capabilities 盘点并按表路由，禁止直接放弃或只用 curl 硬撞：
  · 抓取网页撞 SPA 空壳/JS 渲染/验证码/反爬 → skill 型 src-rules-scraper（浏览器渲染后从 performance
    面板找 JSON API 取数据）；查厂商 SRC 收录规则/范围/评级标准也走它。
  · 读微信公众号文章/搜公众号历史文 → skill 型 wechat-mp-reader（curl+UA 直抓）。
  · 目标含微信小程序资产需要逆向（API/参数/敏感信息/云开发环境 ID）→ skill 型 wx-minapp-recon
    （扫本机微信缓存 wxapkg → wedecode 反编译 → 提取）。前提是本机微信已打开过目标小程序（含
    登录态），否则先 src_user_todo(kind=manual-test, title="请在微信打开目标小程序并确认登录") 提
    待办移交用户，完成后才扫包逆向；脚本执行走 src_run_capability 异步挂起待审。
  · 资产测绘/找子域/找同类站点/端口指纹 → mcp 型 fofa（工具面 mcp__fofa__* 直接用，不要自己 curl）。
  · 漏洞打法/测试某类功能不知道怎么下手 → skill 型 clown-src-playbook（playbook 命中专题 + 检查项）。
  · 任务卡在客户端/逆向/端侧等本机工具面没覆盖的场景 → 先查清单，没有再告知用户建议接入。
  两类形态用法：①mcp 型——工具面出现 mcp__<id>__* 工具就直接使用；②skill 型——先 src_read_capability
  读其文档了解用法，再用 src_run_capability 提交白名单脚本（异步挂起待审，用户批准后经 src_resolve_approval
  的 allow 拿脚本输出 runOutput）。两类产出都必须经 src_record_observation(tool='<id>') 固化才算数。
  反面清单（中通会话实测教训）：抓规则页面撞 SPA 就写「正文反爬无法抓取」然后放弃 = 不合格——
  抓取受阻是「换方法」信号，不是「结束」信号：先查能力清单，再换 web_search 找镜像/转载，最后才向用户待办降级。
  清单里启用但未接线/未安装的提示用户重跑 sync 并重启 dsh；接入【新】能力不要手改
  capabilities.yaml（sandbox 外、易写坏）——直接调 src_add_capability 一条命令完成（自动 npm
  registry 优先解析、代理、预热、登记、接线），mcp 型接线后提醒用户重启 dsh web；完全没覆盖的场景
  不要硬猜 API——如实告知用户该类任务超出当前工具面并建议参考 docs/CAPABILITIES.md 接入对应能力。
【intent】先调用 src_state 检查既有 intent；同一目标、范围和验证方法的意图只能保留一个，已有等价
  intent（含进行中、已完成或 blocked）不得再次创建或委派。调用 src_add_intent 后必须消费返回的 playbook：
  若有 playbook.docs，先用 src_read_capability(id="clown-src-playbook", file=<能力目录内相对路径>) 读取最相关专题；把 playbook.checks 的首轮检查项、授权边界和停止条件带入委派 prompt。每个 intent 只读取命中的专题和通用短表，禁止通读整个知识库。默认按以下阶段拆分并行或串行 intent：
  1) 被动组织/域名/证书/DNS/ASN/公开页面侦察；2) 低影响主机与 Web 指纹、robots/sitemap、登录边界、API 网关、OpenAPI/GraphQL、JS 接口线索；3) 认证、授权、会话和业务流程假设；4) 注入、XSS、SSRF、文件上传、越权、敏感信息、配置暴露、供应链和业务逻辑验证；5) 独立复核、影响确认和报告整理。仅当目标、范围或验证方法实质不同，才调用 src_add_intent 并委派执行子 agent。可同时创建多个彼此独立且不重复的 intent，并在同一回合分别调用多个 subagent 或 subagent_fork 并发执行；每个委派必须使用它自己的父 intentId。
  【重规划（Decide 三动作）】图是唯一外化记忆，随战况重排搜索前沿：①调优先级——src_update_intent(intentId, priority=1..9)（9 最高，src_state 按 P 降序列出，高产面靠前，配合【资产分诊】使用）；②废弃——评估后决定不做的方向用 src_update_intent(intentId, status="deprecated")（语义区别：failed=试过失败要复盘；deprecated=主动放弃，不阻塞收官也不需要用户待办，但放弃依据要落 fact 或在报告 coverage limitation 说明；已完成 intent 不能废弃）；③新增——出现新攻击面时正常 src_add_intent。状态变化要让图与真实推进一致，不留僵尸 running；若被废弃 intent 的子代理仍在跑，以子代理收尾结论落 fact 为准、不再按该 intent 委派新工作。
  委派前必须调用 src_add_intent，并把该调用刚返回的实际 id 原样写入每个子 agent 提示中的父 intentId。
  禁止传入或保留 delegation-intent-id、intent-id、<intentId> 等占位符；例如返回 id 为 intent-1 时，
  委派必须明确写“父 intentId: intent-1”。委派 prompt 还必须包含 playbook 命中的专题 key、至少两条首轮检查项、对应文档路径，以及“完成首个可验证阶段后立即 src_submit progress checkpoint；若无法开始则提交 blocked/failed checkpoint，不得无输出退出”。委派内容还必须包含：目标、待验证任务、相关事实摘要、
  已知资产及可引用的资产 ID。若该方向涉及抓取/测绘/公众号等外部能力场景，简报里要点名对应能力（如
  「查厂商收录规则用 src-rules-scraper：src_read_capability 读文档后按流程执行」），禁止让子 agent 用 curl 硬撞 SPA。【授权范围写法】简报里禁止自行扩大或转述授权范围（如「授权含 *.其他域」）——
  授权模型是「资产清单即许可」：探测类工具按「goal 主域内或资产清单内」放行，简报只写「以资产清单为准」即可；
  goal 主域外的新 host 由子 agent 自行判定归属后 src_add_asset 登记（source 写判定依据）再测，
  excluded 资产不作为授权依据。
  【归属三档判定（指挥官）】goal 主域外的注册域按归属确信度分三档：①明显属于目标组织（品牌域/
  官方主域名/公开控股关系）→ src_add_asset 直接登记 confirmed（source 写判定依据）后探测，不要
  打扰用户；②疑似但无法公开验证（相似域名/业务强关联但查不到归属证据）→ 调 src_request_asset_confirm
  (domain=注册域, evidence=判定依据) 请用户确认整个注册域——确认后整域授权，否决则整域排除；提交后
  不等待，继续其他方向，收到用户决定后再重试或放弃；子代理会在 src_submit 摘要里报「待归属确认：
  <域>（依据）」，汇总后统一发起；③确定不属于 → 不探测不登记。禁止把②档直接登 confirmed 蒙混过关。
  不要把完整日志喂给子 agent。全部委派发起后立即结束当前回合：不要使用 Start-Sleep、轮询、等待工具或
  shell 命令来等候。子 agent 的完成事件和摘要会自动注入本会话；收到后再根据新增记录继续推进。
  【委派工具一致性】委派 prompt 里点名的 src_* 工具必须是目标子 agent 实际可用的（沿父链解析 goal）：src_scan_surface
  已对 recon/audit 子代理开放；audit/verify 另有 src_test_bypass/src_test_credential；recon 是纯被动面
  （src_http/src_scan_surface），不要在其 prompt 里点名 src_test_* 类主动测试工具；src_record_research 对
  recon/audit 子代理是 deny 的——不要在它们的 prompt 里要求调用。若某回合结束后台子代理迟迟无报告，
  下一步用 list_agents 检查状态，必要时用 src_recover_child 唤醒续跑（子代理有 checkpoint 可恢复）。
【侦察策略】先用 src_scan_surface 做单次预检，识别 WAF/CDN/挑战页、认证边界和限速响应。遇到 WAF 拦截页/403/challenge：这不是停止信号，而是“需先绕过才能继续”的信号。对防护本身做有界绕过试探（换 UA、降速、分块、方法/编码变换，低 RPS + 有限请求预算）；绕不过才返回 requiresDecision 交指挥官决策。对特定载荷的过滤名单（如 <img onerror> 被拦但 <b> 通）做向量枚举（未拦截标签/编码/解析差异）——这是 bypass-filter-list 研究，属 SRC 高价值漏洞范畴，不算“绕过 WAF”。429 限速先退避降速重试，持续 429 才停。401 是认证边界发现信号而不是风控拦截：预检/扫描/导流遇 401 继续扫完并记录（未授权可达性本身就是漏洞面），不触发 requiresDecision、不把 401 记为 protectionSignal。禁止的是无界爆破、拒绝服务、千万级字典、隐蔽大规模扫描；撞到 WAF/403 必须先绕过防护才能继续暴力/遍历/构造载荷类动作，绕不过则停。优先使用被动来源（含 Google dorks 信息收集：泄露凭证/敏感文件/目录结构/索引页/历史缓存/云资产）、页面链接、JS 静态提取、证书透明日志和 DNS 线索，再决定是否主动测绘。
【研究】漏洞研究应借鉴 pentest 的提案→决策→执行循环：先从事实形成假设，再为每个假设创建独立 intent；没有复现证据只能提交 fact/hypothesis，不得提交 finding。验证必须覆盖前置条件、权限边界、最小化 POC、影响范围、误报可能和修复方向；禁止无界爆破、拒绝服务、扩大范围或外传数据。允许的有界验证：①验证码爆破——4 位验证码且无滑块/滑块可绕时，~30 次遍历即可证明任意用户接管；②短信轰炸——~10 次发送测试，无频率限制即成立（medium+）；③小并发爆破——公开密码规则/默认凭据场景用 src_test_credential（低 RPS、有限次数、撞不可绕验证码即停）。
【fact】子 agent 每发现一组独立、已确认的事实/资产/漏洞，就立即调用 src_submit 作为实时检查点，
  不要等到任务结束。直接把发现清单（kind: port/service/vuln/finding/http/info, target, detail, confidence）、
  资产和已确认漏洞提交到该 intent；每批只能包含此前未提交的数据。提交后父会话的记录和渗透页会自动刷新。
  子 agent 最终回复只保留结论、证据摘要和累计计数。
【finding】子 agent 仅在证据已确认时随 src_submit 提交漏洞：title、severity
  （critical/high/medium/low/info）、description，**必须**给出可复现步骤
  （reproducibleSteps：按顺序的复现命令/请���/动作，至少一条）和双视角危害论证：
  impact（攻击者视角）≥40字：具体利用场景——怎么构造利用（恶意页面/请求/参数怎么放）、
  能实际拿到什么（数据/权限/资金/用户）、危害哪些用户或业务，缺这一层就只是信息罗列不算漏洞。
  victimImpact（受害者视角）≥30字：谁受害、损失什么、是否可察觉。
  例：CORS 反射 Origin+Credentials 的 impact 写「攻击者在 xxx 托管页面诱导已登录用户访问，
  JS 可读取其 yyy 接口返回的 zzz 数据」，victimImpact 写「受害者为该站已登录用户；个人资料/
  订单数据被第三方站点读取且全程无感知」；只写「配置不安全」不合格。
【经验库】建 goal 后先看返回的经验索引；验证某类漏洞前若索引或 src_search_lessons 命中同类条目，
  先 src_read_lesson 读全文再定方案——沉淀的套路含真实被拒教训和收录标准，直接复用少走弯路。
  以下时机必须用 src_record_lesson 沉淀经验：① finding 达到收录标准后（把验证套路写成可复用的
  playbook）② 经人工引导从「不收」变「收录」后（pitfalls 必须写 before/after 差异）③ 发现关键
  绕过/证据技巧时。同类型已有文件则更新合并而非新建。finalize 时有 finding 却从未沉淀会收到 warning。
【POC 托管服务器】需要外部可达 URL 的验证（XSS 打码、CSRF、SSRF 回连、盲打）用 src_serve_proof
  在本机起受控 HTTP 服务（把局域网 IP 当受控 VPS），所有访问都会记入日志作为 OOB 证据；拿到 URL
  后诱导目标访问，验证完立即 src_stop_serve 关闭并取回访问日志随 finding 提交——不留常驻服务，
  TTL 到期/goal 重置/插件卸载也会自动关。漏洞验证必须按真实场景构造：需要厂商受控域名的钓鱼类
  场景如实声明该前置条件，不伪造域名；个人控制的 VPS 一律用工具返回的本地局域网 IP URL，
  **禁止把 POC 里的主机改写成 127.0.0.1 或 localhost**——那不是真实可达的利用路径，证据无效。
【漏洞修订】人工引导后需要改 finding 时用 src_update_finding 重写原字段（重点
  impact/victimImpact/pocEvidence/reproducibleSteps/rawRequest）——修订直接落库到面板，禁止写到
  本地文件或只在回复里复述；禁止靠新增重复 finding 覆盖；改完重新 src_report 检查呈现效果。
  重写 POC 时同样遵守真实场景规则（受控域名如实声明、局域网 IP、禁 127.0.0.1/localhost）。
【asset】子 agent 提交的主机/端口/服务/端点/子域都应成为资产，并尽量保留 source、method、confidence 和 candidate/confirmed/excluded 状态。parentId 只能引用委派中已提供的资产 ID；finding 的 affectedAssetId 同样只能引用委派中已提供的资产 ID。无法确定父资产或影响资产时省略对应字段、先按根资产提交，不得臆造 ID。
【覆盖率】每个重要资产都应为侦察、认证/API、漏洞类别和复核阶段调用 src_record_coverage，明确 planned/running/completed/blocked/not-applicable；遇到 WAF、限速、缺少账号、环境不可用或授权排除时必须写 limitation，不得把未测试当作无漏洞。单资产收口时（某个 host 测完/受阻/不适用）必须带 assetId 对准具体资产——面板资产页按它显示覆盖徽标，用户靠它一眼区分「已测」和「没碰过」。
【研究矩阵】每个漏洞假设都先调用 src_record_research，记录 category、hypothesis、preconditions 和证据，按 hypothesis→testing→reproduced→verified 或 false-positive/blocked 推进；只有 verified 且 finding 字段完整时才进入最终报告。
【bypass 研究】broken-access-control/bypass 类是 SRC 高分漏洞，必须作为正式研究类别而不是一律当作违规：authentication-bypass、authorization-bypass、idor-bola、tenant-isolation、workflow-bypass、method-bypass、path-normalization、parser-discrepancy、rate-limit-bypass、cache-auth-boundary、waf-rule-gap、oauth-flow-bypass。流程是：先创建 intent 和 src_record_research 假设，再由复核子 agent 用 src_test_bypass 做有界 baseline→variant 差分验证（提供 baseline、少量变体、researchId 与授权上下文）；src_test_bypass 只在目标 host/subdomain 内、仅允许 GET/HEAD/OPTIONS 和显式 allowBody 的 POST、低 RPS；遇 WAF/403/429/challenge 时先做有界绕过试探（含过滓名单向量枚举：替换标签/编码/方法变体是正常 variant），绕不过才返回 requiresDecision，也不自动创建 finding。只有出现可复现的权限/授权边界差分、且附上授权影响证明和独立复核，才把 research 推进到 verified；仅凭 403→200 或改 header 得到 200 不算漏洞，误报防护与影响证明是必选项。禁止代理池轮换、无限重试和隐蔽大规模扫描。
【框架与 nDay】识别出开源框架/知名组件指纹（如 VAppServer、VSB 站群、致远 OA、Sea.js、常见 CMS）后，立即创建框架研究 intent：①查公开 CVE/历史漏洞（NVD/CNNVD/GitHub advisory/exploit-db，用 web 搜索）匹配版本范围，把“框架+版本+已知漏洞”落 research（category: nday）；②开源框架直接拉源码（GitHub/Gitee）做定向白盒审计（category: framework-audit），针对目标定制点（如特定 jsp/DWR 接口族）找注入/越权/反序列化。nDay 验证做最小化 PoC 确认（不利用、不深入），命中即 high+ finding。
【认证策略】发现大部分业务需登录时按决策树推进：①先用 Google dorks 被动找泄露凭证（GitHub filename:.env "<domain>"、"<domain>" password、Gitee/文库/网盘，SRC 认可白帽凭此登录测试；已知凭据复现不受爆破配额约束）；②找不到则用 src_user_todo(kind=auth-session) 异步引导用户完成 Burp 抓包三步（见【用户待办】），绝不打断任务；用户完成后 mcp__burp__get_proxy_http_history_regex(regex=目标host,count,offset) 拉包，src_import_traffic 把认证头存入本地凭证库并返回 credentialRef（auth-profile fact 只存引用不落明文），子 agent 用 credentialRef 构造请求（src_http credentialRef 参数）测登录态越权面、判断凭据权限范围（如普通用户 token 能否读到他人数据=横向越权实锤）。安全红线：只测凭据对应账户自身的越权面，不横向；只对授权域名跑 dork。
【多账号矩阵】拿到第二及以上账号后用 src_add_test_account 逐条登记（label 主通道，直接粘完整 Cookie/Authorization，凭据自动入本地凭证库、返回 credentialRef；同一会话 label 去重覆盖；已有引用可用 credentialRef 参数免重粘）。后续 src_http 请求用 credentialRef 引用注入认证头，不要把 Cookie/Authorization 明文粘进 headers 或对话。交叉矩阵动作：A 的资源 ID × B 的会话、普通会话 × 管理端端点清单。双探规则：IDOR/越权类需两组不同 id 对确认系统性才提交，单组数据差可能是业务允许的差异而非漏洞。认证态流量走独立更低预算（src_test_bypass 会计数带 Authorization/Cookie 的请求，触顶返回 budgetExhausted 软信号——剩余矩阵格转 src_user_todo 而非硬报错；认证流量稀缺是防锁号与防风控画像）；401 连发（src_test_bypass 返回 sessionLikelyExpired）转「重新登录」待办模板（kind=auth-session，写明哪个账号、用过期迹象），不要反复重放失效凭据触发风控。凭据即用即取，不批量囤积（白帽红线）。
	【Burp MCP 工具面】环境挂有 mcp__burp__* 工具（Burp Pro「MCP Server」扩展，经自愈桥接入）时的用法：①查浏览流量必须用 mcp__burp__get_proxy_http_history_regex(regex=<目标host或域名正则>,count,offset) 按目标过滤后喂给 src_import_traffic(mode=mcp) 统一落库（含 React module federation chunk、找回密码等静态扫不到的 API）；禁止用不带 regex 的 mcp__burp__get_proxy_http_history 判断「有没有包」——它按 offset 从最旧记录返回且不告知总条数，拉到的几乎必然是无关旧流量，据此断言「Burp 里没有目标流量」是错误结论；②断言「Burp 无流量」前必须引用工具调用证据（工具名+regex+count+offset+返回条数），且至少先用 regex 版对目标 host 查一次；③工具表里看不到 mcp__burp__* 工具 ≠ Burp 无流量：那是自愈桥降级（SSE 空闲断开后的重连窗口），应报告「Burp MCP 暂不可用」并下回合重试，不得当作目标无流量的证据；若出现 burp_status 哨兵工具，调用它确认桥状态；④从 proxy 流量提取 Cookie/Authorization 完整构造认证画像（auth-profile fact，可直接复用）；⑤POC 写回 Burp 人工复核：mcp__burp__create_repeater_tab(content,targetHostname,targetPort,usesHttps,tabName?)（raw 请求要 CRLF）建 Repeater 页签，或 mcp__burp__send_http1_request/send_http2_request(content,targetHostname,targetPort,usesHttps) 直发验证。Burp 未开时这些工具不可用——走 HAR/raw 文件导入兜底。React chunk 404 类问题优先用此通道解决，不做静态反推。
【资产分诊】派发 audit intent 前先对侦察产出的资产排序，把高产面排在前面：①登录态/多账号面（垂直越权/租户隔离/双人交互是国内 SRC 出货大户）②测试/预发环境（test/uat/staging/pre/dev 前缀、中间件入口、短期证书、双端网关）③认证类接口（改密/绑定/会话）④AI/移动端资产。测试环境适用三分法：明确含非生产环境→优先级上调（软目标 + 生产跳板双重价值，见 lessons/token-lifecycle）；明确排除→记录 excluded 跳过；沉默/模糊→被动指纹照常做（host 本就在侦察面里），主动测试先建非阻塞 src_user_todo 快速确认，不掐其他方向。
【负结果落盘】结论为「不漏洞」时同样调 src_record_research 记录（status=false-positive 或 blocked，stopReason 写判定理由），不要只记命中。同 intent+category 的记录自动去重覆盖，不会膨胀；落盘的已否假设供后续 briefing 复用、避免重复钻枯井（诚实主题：漏报无闸是最大不对称，负结果也属测试覆盖证据）。
【推进】用 src_state 观察链路：有新事实 → 推导新 intent → 继续；证据不足 → 扩展侦察
  或换方向。
【终止】收官前自检四问，任一为否就先处理再收官：①还有 pending 用户待办吗？②每个因缺用户输入而
  blocked 的 intent 都有对应待办吗？③还有可推导的新方向吗（未完成的假设、停在自动骨架的资产、
  未派生假设的事实）？④【覆盖维度声明】每个适用维度都标注了 covered/uncovered/notApplicable 吗？
  finalize 会硬性拦截这四项，「收益递减」不能替代枚举——列得出方向就必须继续，维度声明缺项也会被拒。
  covered 维度必须带 evidenceId（指向真实 fact/finding/intent/research），否则被拒——「以为测到了」比
  「没测到」更危险。可行动盲区（如缺第二账号导致 multi-account-cross-authz=uncovered）同回合建
  src_user_todo 移交用户，不要只写进报告尾节了事。确已穷尽或目标达成时：先调用 src_finalize_engagement
  检查未完成 intent、保护信号、未复核 finding、真实危害门禁、覆盖维度声明和报告字段；问题处理完或
  明确记录限制后，再调用 src_report 产出最终报告（含每个漏洞的标准报告字段与可复现步骤）。报告不是终点：
  报告尾部会列出「⏸ 等你的事」和「覆盖维度声明」，收到完成回注后继续推进。
  禁止为了收尾而中断仍在产出结果的子代理——interrupt_agent 仅用于子代理明显跑偏/死循环/超预算，
  不允许以「收敛报告」「准备收官」为由掐掉还在干活的子代理。

【子 agent 故障处理】子 agent 中途失败（超时、API 424/上游错误、异常退出）不会自动重试：收到失败通知后，先调 src_state 查看该 intent 已产出的 checkpoint 与事实，判断已完成部分；剩余工作用 src_recover_child 定向唤醒（同一子代理最多四次——即使它从未提交过 checkpoint 也可以唤醒，恢复消息会送达原会话继续干；API 供应商波动、网络不稳定、限流这类基础设施故障不是子代理自身的错误，应当继续唤醒续跑而不是换人重来），唤醒失败或额度用尽再创建新 intent 重新委派；不得假装没发生、不得把失败直接当结论标 failed 了事。注意：API 上游错误（424/upstream_error）通常是暂时的供应商波动，重试往往能成功，不要因一次失败就放弃整条链路；主会话自身请求失败时也一样，下一回合从断点继续即可。子 agent 的失败结论也要以 fact 形式落图，避免重复踩坑。续接旧会话或 web 重启后，先调 src_state 看 orphanIntents：那里列出所有 running 但子代理已失联的 intent（无 checkpoint 或最后 checkpoint 距今≥30分钟无收尾），按其 hint 处置——用 src_recover_child 唤醒补收尾，或把已有 checkpoint 结论落 fact 后将 intent 标 failed 再新建 intent 重委派；绝不对着 running 状态干等。

【厂商规则】goal 建立后、开始验证类工作前：用 web 搜索确认厂商是否有公开 SRC/安全应急响应中心
  （搜索「<厂商名> SRC 漏洞评分规则」「<厂商> 安全应急响应中心 收录标准」等）；有则找到评分/收录规则页，
  用 src_fetch_policy 抓取正文并把要点存为 fact（category=vendor-policy，含规则 URL 与关键条款摘要：
  收录范围、定级基准、不收场景、证明材料要求）。**不收清单必须单独记录**：纯安全头缺失、无一键敏感
  操作的点击劫持、报错页信息罗列等典型拒收项，以及钓鱼场景的托管域要求（如需厂商自有域）——这些直接
  决定 finding 能否提交。之后每个 finding 提交前对照该规则预判有效性并在 impact 里注明对应定级依据；
  厂商规则与通用定级冲突时以厂商规则为准。找不到公开规则时按通用四档执行。
  【覆盖维度声明】同一步骤输出时一并声明本目标适用的覆盖维度（基线：http-authz-surface/cors-headers/
  dom-xhr/dict-budget/multi-account-cross-authz 恒适用；信号派生：发现 wss 资产加 websocket，发现
  app/mini-program 资产加 mobile-api；厂商规则排除某类则该维度标 notApplicable）。维度清单是活文档——
  侦察中段发现新适用维度（如确认目标是多租户产品）随时补声明；finalize 会对照最终版逐项校验。
  此声明与 remainingDirections 切干净：remainingDirections=同类面内还能推进的动作；盲区维度=结构性没碰的类别。
【定级指南（对齐小米 SRC 四档）】严重=直接获取系统权限/RCE/核心数据库数据；高=敏感数据泄露/重要业务越权（如任意用户简历读取）；中=普通越权/一般信息泄露/短信轰炸/验证码爆破可利用；低=反射 XSS/一般未授权信息/轻微逻辑缺陷。提交 finding 时 severity 按此基准判定，impact 描述需注明对应平台定级依据；小程序/App 资产必须记录下载方式（应用商店 URL/二维码）作为 meta。AI 站点/智能客服/LLM 应用是正式测试对象：语义复核确认为真实 AI 面后按 lessons/ai-abuse 课程自主推进（先测越权面/key 暴露等硬通货，再测间接注入与工具滥用）；纯越狱或仅套出系统提示词不构成独立 finding，只能作为注入链的证据环节。测不了或不全面的场景（需登录态的 RAG 投毒、需浏览器人工交互的验证）一律建 src_user_todo(kind=manual-test, intentId 关联) 移交用户，不得静默跳过或直接标 blocked 了事。
【漏洞质量标准（SRC）】finding 只在危害链闭合时诞生，三要素缺一不可：①攻击者能力（impact）②受害者交互与视角
  （victimImpact：谁受害、要做什么或完全无交互、损失什么）③实际损失证据指针（concreteLossEvidence 指向含敏感响应
  体/外带记录的真实证据 id）。服务端准入闸会拒绝缺项提交并提示改路。**弱信号的正确去处**：仅配置缺陷/头反射而
  无敏感数据证明 → src_record_research(false-positive)；差登录态/人工交互才能证 → src_user_todo；绝不塞进漏洞清单。
  severity 无 info 级——不要试图用降级把注水项合法化，要么补全危害链要么如实归档为研究记录。低价值类别默认门槛见
  lessons/submission-quality（clickjacking 需一键敏感操作、纯头缺失/报错页泄露/cookie flag 默认不独立成 finding）。
  **数量目标是产出上限不是 KPI**：用户说「找到 N 个漏洞即停」一律理解为「最多 N 个合格漏洞」——不合格交 0 个并如实
  说明阻塞原因（如目标匿名面硬化、卡在登录态），这是体面且合规的产出；绝不为凑数降低收录标准或把研究信号包装成漏洞。
  报告停止前必须确认存在 medium 及以上、有可复现 POC（raw 包含接口地址）、impact 含具体利用场景且经独立复核 verified 的 finding。
【高危动作授权闸（src_http，异步挂起）】所有对授权目标发出的 HTTP 请求一律走 src_http 工具，不要在 bash 里用 curl/python
  直连。src_http 会自动分类：破坏性/越权/未授权删改类写请求**异步挂起**到待审队列（pending_approvals），你（agent）不阻塞、
  继续其他方向；用户在 SRC 面板「待办」tab 审批区看到完整请求本体（method/url/headers/body + 分类理由 + 你的 justification）后
  批准或拒绝，你收到 followup 后调 src_resolve_approval。判据方法无关（信任接口命名规则做读白名单）。如果 src_http 返回
  approval=pending（含 pendingApprovalId），说明已挂起未发出——不要重复发起同一请求（去重会复用既有 pending）、也不要绕用 bash curl
  硬发。批准后调 src_resolve_approval(id, allow) 发出原请求并据响应推进（成功则记录证据/产 finding；失败转其他方向）；拒绝则调
  src_resolve_approval(id, reject) 记理由后转其他方向，不重发。任何删账号/改他人资源/停服类操作即使你认为“无害验证”也必须先
  说明受害者全貌（userId/账号类型/影响面）在 justification 里，让用户凭全貌判断。【禁止绕行（硬闸）】审批挂起期间该请求
  （同 host+path）禁止经 Burp MCP（send_http1_request/send_http2_request）、curl、python 等任何通道发出——Burp 桥接层会
  直接拒绝转发并提示对应审批 id，curl 直连违反授权纪律。等批准、等拒绝、或换其他资产/方向，绝没有第三条路。
【打回闭环（src_reject_finding）】你提交的 finding 可能被用户打回（status=rejected + 打回备注）。打回的 finding 不删除、
  保留在图里供后续组合利用。收到打回后：①按备注动作（备注例「没看懂能梳理下攻击链吗」「写个一键 PoC 脚本吧」）→
  用 src_update_finding 补 attackChain（从发现→利用前提→利用过程→实际损失→受害者影响的闭合叙事）或产出一键脚本；
  ②不要原样重提相似标题——准入闸会拦住与已打回 finding 相似的二次提交并回带打回理由；确为新链或已补全，先
  src_update_finding 补 attackChain 再说明与打回那条的差异，不要原样重提。打回不是否定，是要求补强到可复现可读懂。
【报告标准化模板（vulnType + attackChain + pocScript）】报告按美团 SRC 官方模板生成：4 个字段（漏洞名称/漏洞类型/漏洞URL/漏洞级别）
  + 漏洞风险详情四小节（描述&发现方式、利用及危害 / 详细复现证明 / 测试源信息 / 修复方案）。提交 finding 时必填 vulnType（如「登录认证漏洞」
  「越权漏洞」「信息泄露」「短信轰炸」「文件上传漏洞」「SSRF」「XSS」「逻辑漏洞」等类别名）与 attackChain（闭合叙事）。
  报告内容动态填充：第 1 节为【攻击链】垂直从上到下①发现→②利用前提→③利用过程→④实际损失→⑤受害者影响（仅非空步骤、不占位；
  有 attackChain 字段时原样呈现）。复现定位信息是厂商复现前置、不是装饰：web 漏洞必填 entryPoint（前端功能点，仅给接口不够——接口可能本就公开）；
  app/小程序漏洞须在影响资产 meta 记录下载方式（应用商店 URL/包名），报告自动出应用下载行；需登录的漏洞在 attackPrerequisites 注明登录入口 URL。
  rawRequest 须为 Burp 格式原始报文（含接口地址），作为第 2 节复现证明主体；一键利用脚本放 pocScript 字段（可直接运行的
  Python/Bash/curl，报告以代码块渲染保留缩进）。

纪律：
- 你是唯一“拍板”者；探索与执行一律委派子 agent，你自己不直接动手。audit/verify 类 intent 必须委派 src_audit/src_verify 子 agent 并产生 checkpoint（checkpoint 为空视同未完成），禁止单纯靠主 agent 自己用 bash/web 验证后直接写 finding。
- 完整记录落在 storage domain；子 agent 用 src_submit 直写父 intent，主 agent 只接收摘要，避免上下文爆炸。
- 委派是异步的：发起后立刻返回，绝不阻塞等待子 agent；完成结果会自动回注。
- 互不依赖且不重复的探索方向应拆为多个 intent 并并发委派；有依赖关系的 intent 必须等其前置事实回注后再创建。
- 任何偏离授权目标范围（src_state 中的目标/授权）的意图都应被拒绝。
- 漏洞必须有可复现步骤，否则视为事实而非 finding。
- 与用户的所有交互一律使用中文：汇报进展、提问、最终报告均用中文；子 agent 的提交与回复、工具摘要也用中文，不要切回英文。严禁夹杂英文口头语或插入语（如 let me / I\u2019ll / however / so）；工具名、命令行、URL 和专有技术名词可保留英文。
- 不要复述动作步骤或解释下一步要怎么做：直接调用 src_* 或 web/bash 工具去做。说了“要检查 robots.txt”就等于没做，必须在同一回合真正发出工具调用。反复复述同一句而不调用工具是错误。`;
//#endregion
//#region src/projection.ts
/**
* The standing `src` session-projection unit: folds the logged
* `src_*` tool calls into the engagement's current exploration graph, so
* the UI reconstructs the same graph from the session log alone — pure
* mathematics, replay-safe, no storage-domain reads. Node/edge ids replicate
* the store's deterministic `<kind>-<n>` counters, so edges resolve across the
* fold. Writes that would violate the store's referential discipline are
* skipped, mirroring the store's rejection. Malformed or foreign events leave
* the state untouched.
* @module @deepseek-ai/dsh-src/src/projection
*/
/** [local.23] 认证态流量独立预算（每会话）：带 Authorization/Cookie 的请求总数触顶后 src_test_bypass
 * 返回软信号（非报错），剩余矩阵格转 src_user_todo。设为 30：认证流量的风险是锁号与风控画像，
 * 比未授权流量更稀缺（评审定稿「阈值低于未授权流量一半」的精神，取一个保守绝对值）。 */
const SRC_AUTH_REQUEST_BUDGET = 30;

/** Wire payload schema of the `src` projection (standing state or pre-init null). */
const srcProjectionSchema = z.union([z.object({
	goal: z.union([z.object({
		id: z.string(),
		target: z.string(),
		objective: z.string(),
		authorization: z.string()
	}), z.null()]),
	nodes: z.array(z.union([
		z.object({
			id: z.string(),
			kind: z.literal("intent"),
			title: z.string(),
			detail: z.string(),
			status: z.enum(["planned", "running", "completed", "blocked", "failed", "deprecated"]),
			priority: z.number().int().optional(),
			playbook: z.object({
				keys: z.array(z.string()),
				docs: z.array(z.string()),
				checks: z.array(z.string()),
				matchedBy: z.array(z.string())
			}).optional(),
			createdAt: z.number()
		}),
		z.object({
			id: z.string(),
			kind: z.literal("fact"),
			factKind: z.enum([
				"port",
				"service",
				"vuln",
				"finding",
				"http",
				"info"
			]),
			intentId: z.string(),
			target: z.string(),
			detail: z.string(),
			confidence: z.number(),
			createdAt: z.number()
		}),
		z.object({
			id: z.string(),
			kind: z.literal("finding"),
			intentId: z.string(),
			title: z.string(),
			severity: z.enum([
				"critical",
				"high",
				"medium",
				"low",
				"info"
			]),
			description: z.string(),
			steps: z.array(z.string()),
			impact: z.string(),
			affectedScope: z.string(),
			remediation: z.string(),
			pocEvidence: z.array(z.string()),
			entryPoint: z.string(),
			discoveryPath: z.string(),
			rawRequest: z.string(),
			rawResponse: z.string(),
			victimImpact: z.string(),
			attackChain: z.string(),
			status: z.enum(["active", "rejected"]),
			rejectReason: z.string(),
			rejectedAt: z.number(),
			affectedAssetId: z.string().optional(),
			createdAt: z.number()
		})
	])),
	assets: z.array(z.object({
		id: z.string(),
		type: z.enum([
			"root-domain",
			"subdomain",
			"ip",
			"service",
			"app",
			"endpoint",
			"mini-program",
			"client",
			"firmware",
			"ai-surface",
			"threat-intel"
		]),
		value: z.string(),
		meta: z.string(),
		source: z.string(), method: z.enum(["passive", "low-impact", "authorized-active", "user-confirmed"]), confidence: z.number(), status: z.enum(["candidate", "confirmed", "excluded"])
	})),
	coverage: z.array(z.object({ id: z.string(), assetId: z.string().optional(), phase: z.string(), category: z.string(), status: z.enum(["planned", "running", "completed", "blocked", "not-applicable"]), evidence: z.array(z.string()), limitation: z.string(), updatedAt: z.number() })),
	research: z.array(z.object({ id: z.string(), intentId: z.string(), category: z.string(), hypothesis: z.string(), preconditions: z.array(z.string()), status: z.enum(["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"]), stopReason: z.string(), evidence: z.array(z.string()), findingId: z.string().optional(), updatedAt: z.number() })),
	checkpoints: z.array(z.object({
		id: z.string(), intentId: z.string(), childSessionId: z.string(),
		stage: z.enum(["progress", "completed", "blocked", "failed"]), summary: z.string(), decision: z.string(),
		facts: z.number(), assets: z.number(), findings: z.number(), batchKey: z.string(), createdAt: z.number()
	})),
	observations: z.array(z.object({ id: z.string(), intentId: z.string(), assetId: z.string().optional(), method: z.string(), path: z.string(), httpStatus: z.number(), protectionSignal: z.boolean(), wafBypassed: z.boolean(), source: z.string(), decision: z.string(), respHeaders: z.string(), respBodySnippet: z.string(), createdAt: z.number() })),
	userTodos: z.array(z.object({ id: z.string(), intentId: z.string().optional(), kind: z.string(), title: z.string(), detail: z.string(), status: z.enum(["pending", "done", "abandoned"]), note: z.string(), createdAt: z.number() })),
	pendingApprovals: z.array(z.object({ id: z.string(), intentId: z.string().optional(), method: z.string(), url: z.string(), path: z.string(), headers: z.string(), body: z.string(), category: z.string(), reason: z.string(), justification: z.string(), status: z.enum(["pending", "approved", "rejected"]), note: z.string(), responseStatus: z.number(), createdAt: z.number(), credentialRef: z.string().optional() })),
	/* [local.33] 域笔记快照 + 认证预算进 wire schema：此前 domainNotes 输出被 zod strip（UI 永远收不到），显式声明后才可达。 */
	domainNotes: z.array(z.object({ id: z.string(), category: z.string(), title: z.string(), content: z.string(), sourceSessionId: z.string(), createdAt: z.number(), updatedAt: z.number() })),
	authBudget: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive() }),
	infra: z.record(z.string(), z.string()),
	edges: z.array(z.object({
		id: z.string(),
		kind: z.enum([
			"spawns",
			"yields",
			"derived_from",
			"proves",
			"parent"
		]),
		sourceId: z.string(),
		targetId: z.string()
	})),
	apiDiscovery: z.object({
		total: z.number().int().nonnegative(),
		schemas: z.number().int().nonnegative(),
		graphql: z.number().int().nonnegative(),
		hints: z.number().int().nonnegative(),
		untouched: z.number().int().nonnegative()
	}),
	counts: z.object({
		intents: z.number().int().nonnegative(),
		facts: z.number().int().nonnegative(),
		findings: z.number().int().nonnegative(),
		assets: z.number().int().nonnegative(),
		coverage: z.number().int().nonnegative(),
		research: z.number().int().nonnegative(),
		checkpoints: z.number().int().nonnegative(),
		observations: z.number().int().nonnegative(),
		userTodos: z.number().int().nonnegative()
	})
}), z.null()]);
/** Initial state: an uninitialized engagement (view projects to null). */
const srcInitialState = {
	goal: null,
	nodes: [],
	assets: [],
	coverage: [],
	research: [],
	checkpoints: [],
	observations: [],
	userTodos: [],
	pendingApprovals: [],
	testAccounts: [],
	domainNotes: [],
	authBudget: { used: 0, limit: SRC_AUTH_REQUEST_BUDGET },
	infra: {},
	edges: [],
	counters: {
		intent: 0,
		fact: 0,
		finding: 0,
		asset: 0,
		edge: 0
	}
};
/** The closed enum values of the wire payloads. */
const FACT_KINDS$1 = new Set([
	"port",
	"service",
	"vuln",
	"finding",
	"http",
	"info"
]);
const SEVERITIES$1 = new Set([
	"critical",
	"high",
	"medium",
	"low"
]);
const ASSET_TYPES$1 = new Set([
	"root-domain",
	"subdomain",
	"ip",
	"service",
	"app",
	"endpoint",
	"mini-program",
	"client",
	"firmware",
	"ai-surface",
	"threat-intel"
]);
/** Read one tool call's raw arguments as an object, or undefined when absent/malformed. */
function argsOf(event) {
	if (event.type !== "tool/call" || !event.data.name.startsWith("src_")) return void 0;
	try {
		const parsed = JSON.parse(event.data.arguments);
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Read a string argument, or '' when absent/not a string. */
function str(value) {
	return typeof value === "string" ? value : "";
}
/**
 * [local.9] Robustly extract a routable hostname from a possibly messy goal target.
 * Real-world agents write targets like "mi.com（小米在线服务主域，含 *.mi.com 子域）";
 * every URL consumer must go through this helper instead of raw `new URL(target)`.
 */
/* [local.43] 授权模型「资产清单即许可」：探测类工具（src_http/src_scan_surface/src_test_*/
/* src_collect_*）按「goal 主域内 或 资产清单内」放行。资产 value 是自由文本（常以 URL/host */
/* 开头带描述尾巴），这里派生可匹配主机名；status=excluded 是 agent 判定的误报，不作为授权依据。 */
function assetGrantHosts(assets) {
	const hosts = [];
	for (const asset of Array.isArray(assets) ? assets : []) {
		if (asset === null || typeof asset !== "object" || asset.status === "excluded") continue;
		const raw = String(asset.value ?? "").trim();
		if (raw === "") continue;
		const head = raw.split(/[\s(（,，;；]/)[0].replace(/\/+$/, "");
		let host = "";
		if (head.includes("://")) {
			try { host = new URL(head).hostname; } catch { host = ""; }
		} else {
			host = head.replace(/^\*\./, "").split("/")[0].replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
		}
		if (host !== "" && /^[a-z0-9.-]+$/.test(host)) hosts.push(host);
	}
	return hosts;
}
async function assetGrantHostsFor(store, sessionId) {
	return assetGrantHosts((await store.sessionData(sessionId)).assets);
}
function hostCoveredByAssets(hosts, hostname) {
	const h = String(hostname).toLowerCase();
	return hosts.some((a) => h === a || h.endsWith(`.${a}`));
}
function parseGoalHost(raw, what = "goal.target") {
	const text = String(raw ?? "").trim();
	if (text === "") throw new Error(`${what} 为空：请先用 src_add_goal 记录明确。目标域名`);
	/* Non-ASCII input ("mi.com（小米…）") must never go through direct URL parsing:
	 * IDNA would silently punycode the junk suffix into a mangled hostname. */
	const asciiOnly = !/[^\x20-\x7E]/.test(text);
	if (asciiOnly && /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
		try {
			const url = new URL(text);
			const host = url.hostname.toLowerCase();
			if (host !== "" && !host.includes("xn--") && isPlausiblePublicHost(host)) return host;
		} catch {}
	}
	if (asciiOnly) {
		try {
			const url = new URL(`https://${text}`);
			const host = url.hostname.toLowerCase();
			if (host !== "" && !host.includes("xn--") && isPlausiblePublicHost(host)) return host;
		} catch {}
	}
	/* Fallback: first domain-like token anywhere in the text. */
	const match = text.match(/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/i);
	if (match !== null) {
		const candidate = match[0].toLowerCase();
		try {
			return new URL(`https://${candidate}`).hostname;
		} catch {}
	}
	throw new Error(`${what}「${text.slice(0, 80)}」不是可测的公网目标：单标签名称（品牌名/公司名，如 OPPO）会被误当 hostname 存储并探测错误目标。请先用 web/bash 工具把品牌解析成官网主域（OPPO → oppo.com），再传入明确域名或 URL。`);
}

/** A single-label hostname ("oppo" from "OPPO") is a brand name, not a public target:
 * URL parsing accepts it silently but every downstream tool would probe the wrong thing.
 * Public SRC targets always carry a TLD (or are an IP); reject label-only hosts. */
function isPlausiblePublicHost(host) {
	return host.includes(".") || netIsIP(host) !== 0;
}

/**
 * [local.9] Infrastructure setting defaults. Users override per session via
 * src_set_infra; the resolved map is exposed to the UI through the projection.
 */
/** [capability] 轻量解析 ~/.dsh/capabilities.yaml（与 scripts/caps-sync.mjs 同一受限子集：条目键值/内联 map/when 折叠块）。只读展示用，不做写盘。 */
function parseCapsYamlSubset(text) {
	const out = [];
	let cur = null;
	let curKey = null;
	let sawHeader = false;
	let sawContent = false;
	for (const raw of String(text).split(/\r?\n/)) {
		const line = raw.replace(/\t/g, "    ");
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		sawContent = true;
		if (/^capabilities:\s*$/.test(line)) { sawHeader = true; cur = null; continue; }
		if (/^settings:\s*$/.test(line)) { continue; }
		const item = line.match(/^  - (.+)$/);
		if (item) {
			const kv = item[1].match(/^([A-Za-z_][\w]*):\s*(.*)$/);
			if (!kv) throw new Error("capabilities 条目首行应为 '- id: xxx'");
			cur = { [kv[1]]: kv[2].trim() };
			out.push(cur); curKey = null;
			continue;
		}
		if (!cur) continue;
		const nested = line.match(/^    ([A-Za-z_][\w]*):\s*(.*)$/);
		if (nested) {
			const [, k, v] = nested;
			if (v === ">" || v === "|" || v === "") { curKey = k; cur[k] = ""; }
			else if (v === "true" || v === "false") cur[k] = v === "true";
			else if (v.startsWith("[")) { cur[k] = parseInlineYamlArray(v); curKey = null; }
			else cur[k] = v.trim();
			continue;
		}
		const cont = line.match(/^      (.+)$/);
		if (cont && curKey) { cur[curKey] = `${cur[curKey]} ${cont[1].trim()}`.trim(); }
	}
	if (sawContent && !sawHeader) throw new Error("文件应以 capabilities: 开头");
	return out;
}

/* [local.65] 已拆除 local.63 的覆盖面清单机制（coverage.yaml → goal 创建机械挂待办）：
 * 枚举是 agent 本职，开局把枚举外包给用户是死编排；缺口提示由 src_state.assetGaps 软引导。 */

/* [local.41] capabilities.yaml 内联数组（scripts: [a.sh, b.py]）与标量剥离。 */
function stripYamlScalar(s) { return (/^".*"$/.test(s) || /^'.*'$/.test(s)) ? s.slice(1, -1) : s; }
function parseInlineYamlArray(v) {
	const m = v.trim().match(/^\[(.*)\]$/);
	if (m === null) return v.trim();
	return m[1].split(",").map((s) => stripYamlScalar(s.trim())).filter((s) => s !== "");
}
/* [local.41] 外部能力清单读取：优先 caps-sync 产出的 ~/.dsh/capabilities/index.json（含
 * kind/dir/docs/scripts/安装状态），缺失时回退 capabilities.yaml 直接解析（此时只有声明信息，
 * kind 一律视为 mcp、无安装目录）。 */
function dshHomeOf() { return process.env.DSH_HOME ? nodePath.resolve(process.env.DSH_HOME) : nodePath.join(nodeOs.homedir(), ".dsh"); }
async function readCapsManifest(dshHome) {
	const indexPath = nodePath.join(dshHome, "capabilities", "index.json");
	try {
		const parsed = JSON.parse(await fsPromises.readFile(indexPath, "utf8"));
		if (Array.isArray(parsed?.capabilities)) return { source: "index", items: parsed.capabilities };
	} catch {}
	try {
		const declared = parseCapsYamlSubset(await fsPromises.readFile(nodePath.join(dshHome, "capabilities.yaml"), "utf8"));
		/* [local.57] 回退路径尊重声明的 kind——skill 型条目此前被硬写成 mcp（开局能力盘点失真）。 */
		/* [local.62] 回退路径携带触发器声明（index.json 缺失时从 yaml 直读，数据编排在降级路径也不失效）。 */
		return { source: "yaml", items: declared.map((c) => ({ id: c.id, kind: c.kind === "skill" ? "skill" : "mcp", from: c.from, enabled: c.enabled !== false, when: typeof c.when === "string" ? c.when : "", ...(Array.isArray(c.triggerAssetTypes) ? { triggerAssetTypes: c.triggerAssetTypes } : {}), ...(Array.isArray(c.triggerKeywords) ? { triggerKeywords: c.triggerKeywords } : {}), ...(typeof c.todoTitle === "string" && c.todoTitle !== "" ? { todoTitle: c.todoTitle, ...(typeof c.todoKind === "string" && c.todoKind !== "" ? { todoKind: c.todoKind } : {}), ...(typeof c.todoDetail === "string" && c.todoDetail !== "" ? { todoDetail: c.todoDetail } : {}) } : {}), status: "unknown" })) };
	} catch (e) {
		/* [local.41] 保留旧语义：清单未创建 vs 解析失败，给 src_list_capabilities 的 parseError。 */
		if (e?.code === "ENOENT") return { source: "none", items: [], parseError: "清单未创建" };
		return { source: "none", items: [], parseError: `清单解析失败：${String(e?.message ?? e).slice(0, 200)}` };
	}
}
async function capsWiredIds(dshHome) {
	const out = new Set();
	try {
		const patchPath = nodePath.join(dshHome, "profiles", "web", "cordis.patch.yml");
		const patch = await fsPromises.readFile(patchPath, "utf8");
		const seg = patch.match(/── dsh-src capabilities:8<[\s\S]*?capabilities:>8 [^─]*──/);
		for (const m of (seg?.[0] ?? "").matchAll(/id: mcp-([A-Za-z0-9-]+)/g)) out.add(m[1]);
	} catch {}
	return out;
}
/* [local.41] 白名单脚本 → 启动命令。按扩展名选解释器，argv 直传不经 shell（无注入面）。 */
function capabilityCommand(dirAbs, scriptRel) {
	if (typeof scriptRel !== "string" || scriptRel === "" || scriptRel.includes("..") || nodePath.isAbsolute(scriptRel)) return { error: "script 必须是能力目录内的相对路径" };
	const abs = nodePath.resolve(dirAbs, scriptRel);
	if (abs !== nodePath.resolve(dirAbs) && !abs.startsWith(nodePath.resolve(dirAbs) + nodePath.sep)) return { error: "script 越出能力目录" };
	const ext = nodePath.extname(abs).toLowerCase();
	if (ext === ".sh" || ext === ".bash") return { command: "bash", args: [abs] };
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { command: process.execPath, args: [abs] };
	if (ext === ".py") return { command: "python3", args: [abs] };
	if (ext === "") return { command: abs, args: [] };
	return { error: `不支持的脚本扩展名「${ext}」（支持 .sh/.bash/.js/.mjs/.cjs/.py 或无扩展名可执行文件）` };
}
/* [local.41] 执行能力脚本：捕获 stdout/stderr（封顶），超时 SIGKILL。close 事件保证管道排空。 */
function runCapabilityProcess(command, args, cwd, env, timeoutMs) {
	return new Promise((resolve) => {
		const child = childProcessSpawn(command, args, { cwd, env: { ...process.env, ...(env ?? {}), DSH_CAP_RUN: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "";
		child.stdout?.on("data", (d) => { if (out.length < 20000) out += String(d); });
		child.stderr?.on("data", (d) => { if (err.length < 20000) err += String(d); });
		const timer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch {}
			resolve({ exitCode: -1, output: `${out}${err ? `\n[stderr]\n${err}` : ""}\n[timeout] 超过 ${(timeoutMs / 1000).toFixed(0)}s 被终止`.trim().slice(0, 12000) });
		}, timeoutMs);
		child.on("error", (e) => { clearTimeout(timer); resolve({ exitCode: -1, output: `[spawn error] ${String(e).slice(0, 300)}` }); });
		child.on("close", (code) => {
			clearTimeout(timer);
			const combined = `${out}${err ? (out !== "" ? "\n[stderr]\n" : "") + err : ""}`.trim();
			resolve({ exitCode: code ?? -1, output: combined.slice(0, 12000) });
		});
	});
}
/* [local.48] 带硬超时的子进程执行（detached 进程组，超时先 SIGTERM 后 SIGKILL 整组——
 * caps-sync 内部会再 spawn git/npm，逐个杀不可靠）。供 src_add_capability 调 caps-sync 用。 */
function runChildWithTimeout(argv, opts = {}) {
	return new Promise((resolve) => {
		const child = childProcessSpawn(argv[0], argv.slice(1), { env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let out = "", err = "", timedOut = false;
		const killTree = (signal) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
		const timer = setTimeout(() => {
			timedOut = true;
			killTree("SIGTERM");
			setTimeout(() => killTree("SIGKILL"), 5000);
		}, opts.timeoutMs ?? 900000);
		child.stdout?.on("data", (d) => { if (out.length < 60000) out += String(d); });
		child.stderr?.on("data", (d) => { if (err.length < 60000) err += String(d); });
		child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: "", err: String(e), timedOut }); });
		child.on("close", (code) => { clearTimeout(timer); resolve({ code: timedOut ? -2 : (code ?? -1), out: out.trim(), err: err.trim(), timedOut }); });
	});
}
const SRC_INFRA_DEFAULTS = Object.freeze({
	proxyUrl: "",
	burpMcpPort: "9876",
	burpProxyJarPath: "",
	testAccount: "",
	testPhone: "",
	httpTimeoutMs: "8000"
});
const SRC_INFRA_KEYS = Object.freeze(Object.keys(SRC_INFRA_DEFAULTS));
const SRC_INFRA_LABELS = Object.freeze({
	proxyUrl: "HTTP 代理（http://127.0.0.1:7890，留空=全直连。仅 google/github 等无法直连的站点自动走代理，国内目标一律直连）",
	burpMcpPort: "Burp MCP 监听端口（默认 9876；默认端口下面板配置即全部，改端口需同步设 BURP_SSE_URL 并重启）",
	burpProxyJarPath: "Burp MCP 自定义桥脚本绝对路径（一般留空=包 patch 默认 ~/.dsh/tools/burp-mcp-bridge.mjs。仅记录/参考，实际接线由包内 cordis.patch.yml 默认提供）",
	testAccount: "越权对照测试账号（user:pass 或用户名；水平越权 A/B 对照）",
	testPhone: "短信/验证码测试手机号，多个用逗号分隔（短信轰炸、验证码爆破类测试用）",
	httpTimeoutMs: "单请求超时毫秒（1000..60000）"
});

//#region [local.9] outbound fetch with optional infra proxy (hand-rolled, no undici)
/** True when the value looks like an usable http(s) proxy origin. */
function isProxyUrl(value) {
	return /^https?:\/\/[A-Za-z0-9.\-_]+:\d{1,5}$/.test(String(value ?? "").trim());
}
/** Minimal fetch-Response subset used by every src_* network call site. */
function emulatedResponse(status, statusText, headerPairs, bodyBuffer) {
	const headerMap = new Map(headerPairs.map(([name, value]) => [String(name).toLowerCase(), String(value)]));
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
		text: async () => bodyBuffer.toString("utf8"),
		json: async () => JSON.parse(bodyBuffer.toString("utf8"))
	};
}
/** Open a CONNECT tunnel through `proxy` to host:port; resolves the raw socket. */
function connectTunnel(proxy, host, port, signal) {
	return new Promise((resolveSocket, rejectSocket) => {
		const req = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method: "CONNECT", path: `${host}:${port}`, headers: { host: `${host}:${port}` } });
		req.on("connect", (res, socket) => res.statusCode === 200 ? resolveSocket(socket) : (socket.destroy(), rejectSocket(new Error(`proxy CONNECT failed: ${res.statusCode}`))));
		req.on("error", rejectSocket);
		if (signal !== void 0) signal.addEventListener("abort", () => { req.destroy(); rejectSocket(new Error("aborted")); }, { once: true });
		req.end();
	});
}
/**
 * [local.15] Hosts that are unreachable or unreliable from mainland networks without a
 * proxy. Everything else connects DIRECTLY even when infra.proxyUrl is configured:
 * domestic targets (OPPO, Xiaomi, ...) are faster direct and some proxies exit abroad,
 * which both slows requests and can trip geo/anti-fraud checks on SRC targets.
 */
const PROXY_REQUIRED_HOST_SUFFIXES = [
	"google.com", "googleapis.com", "gstatic.com", "googleusercontent.com",
	"youtube.com", "ytimg.com",
	"github.com", "githubusercontent.com", "githubassets.com", "github.io",
	"gitlab.com",
	"huggingface.co", "hf.co",
	"openai.com", "anthropic.com",
	"crt.sh",
	"shodan.io", "censys.io", "fofa.info", "zoomeye.org", "quake.360.net",
	"telegram.org", "t.me", "x.com", "twitter.com", "twimg.com",
	"facebook.com", "fbcdn.net", "instagram.com",
	"wikipedia.org", "wikimedia.org",
	"docker.io", "docker.com", "gcr.io", "ghcr.io", "quay.io",
	"cloudflare.com", "jsdelivr.net"
];
/** True when the host itself (or any parent domain) is on the proxy-required list. */
function hostRequiresProxy(hostname) {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return PROXY_REQUIRED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** [local.64] Detect OpenSSL "unsafe legacy renegotiation" handshake failures (undici wraps
 *  the OpenSSL cause several levels deep: fetch failed → TypeError → ... → ssl state machine). */
function isLegacyRenegotiationError(error) {
	let cause = error;
	for (let depth = 0; depth < 5 && cause !== void 0 && cause !== null; depth += 1) {
		if (/legacy.?renegotiation|UNSAFE_LEGACY_RENEGOTIATION_DISABLED/i.test(`${cause.code ?? ""}${cause.message ?? ""}${cause.opensslErrorStack ?? ""}`)) return true;
		cause = cause.cause;
	}
	return false;
}
/** [local.64] Legacy-tolerant https request: SSL_OP_LEGACY_SERVER_CONNECT + minVersion TLSv1.
 *  只在严格 fetch 已报 legacy renegotiation 错后才触发（配置正确的目标永远走默认严格路径）。
 *  与代理隧道路径同款 emulatedResponse 形态：不跟随重定向、仅字符串 body、4MB 读取上限；
 *  显式带 Content-Length（避免 chunked 编码被 WAF 拦）。 */
function legacyHttpsRequest(urlString, init = {}, timeoutMs = 8000) {
	const target = new URL(urlString);
	if (target.protocol !== "https:") throw new Error(`legacy TLS fallback only supports https targets: ${urlString}`);
	const flatHeaders = {};
	for (const [name, value] of Object.entries(init.headers ?? {})) if (typeof value === "string") flatHeaders[name.toLowerCase()] = value;
	flatHeaders.host ??= target.host;
	if (typeof init.body === "string" && flatHeaders["content-length"] === void 0) flatHeaders["content-length"] = String(Buffer.byteLength(init.body));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const response = new Promise((resolveRes, rejectRes) => {
		const req = httpsRequest({ servername: target.hostname, host: target.hostname, port: target.port !== "" ? Number(target.port) : 443, method: init.method ?? "GET", path: `${target.pathname}${target.search}`, headers: flatHeaders, secureOptions: cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT, minVersion: "TLSv1" }, resolveRes);
		req.on("error", rejectRes);
		controller.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
		if (typeof init.body === "string") req.write(init.body);
		req.end();
	});
	return response.then(async (res) => {
		const chunks = [];
		let size = 0;
		for await (const chunk of res) { chunks.push(chunk); size += chunk.length; if (size > 4 * 1024 * 1024) break; }
		const headerPairs = Object.entries(res.headers).flatMap(([name, value]) => Array.isArray(value) ? value.map((entry) => [name, entry]) : [[name, value]]);
		return emulatedResponse(res.statusCode ?? 0, res.statusMessage ?? "", headerPairs, Buffer.concat(chunks));
	}).finally(() => clearTimeout(timer));
}
/** [local.64] 网络层失败（无 HTTP 响应）的报错指引：让 agent 先对照 Burp 通道再定性，
 *  而不是把「fetch failed」误判成目标不可达或幻觉成「审批通道兼容问题」（中通 kfapi 实案）。 */
function networkFailureHint(urlString, error) {
	const host = (() => { try { return new URL(urlString).hostname; } catch { return ""; } })();
	const reason = String(error?.message ?? error);
	return isLegacyRenegotiationError(error)
		? `目标 ${host} 的 TLS 仅支持不安全的老式重协商（unsafe legacy renegotiation），标准 fetch 与 legacy 兼容重试均失败：${reason}。可用 mcp__burp__send_http1_request 走 Burp（Java JSSE 兼容 legacy）通道发同请求对照；Burp 可达即通道差异实锤，再决定是否继续该目标。`
		: `网络层失败（目标 ${host} 无任何 HTTP 响应）：${reason}。先区分通道差异再定性：用 mcp__burp__send_http1_request 发同请求对照（Burp 的 TLS 栈更宽容）——Burp 可达则是本机 fetch 的 TLS/网络兼容性问题（可重试），不可达才是目标侧封禁/下线。不要把 fetch failed 直接定性为「目标不可达」。`;
}
/**
 * [local.9] fetch() replacement that honors infra.proxyUrl without undici:
 * https targets go through a CONNECT tunnel, http targets use absolute-form
 * requests to the proxy. Redirects are never followed (matches the redirect:
 * "manual" call sites). Without a configured proxy it delegates to globalThis.fetch.
 * [local.15] The proxy is only used for hosts on the PROXY_REQUIRED_HOST_SUFFIXES
 * list; all other targets connect directly so domestic SRC targets are not slowed
 * down (or geo-mismatched) by an overseas egress.
 * [local.64] direct 路径遇「unsafe legacy renegotiation」（部分老系统目标，如中通 kfapi）自动
 * 用 node https + SSL_OP_LEGACY_SERVER_CONNECT 降级重试一次；网络层失败统一附通道对照指引。 */
async function proxiedFetch(urlString, init = {}, infra = void 0) {
	const proxyUrl = String(infra?.proxyUrl ?? "").trim();
	const timeoutMs = Math.min(Math.max(Number.parseInt(String(infra?.httpTimeoutMs ?? ""), 10) || 8000, 1000), 60000);
	const target = new URL(urlString);
	if (!/^https?:$/.test(target.protocol)) throw new Error(`proxiedFetch supports only http/https targets: ${urlString}`);
	if (!isProxyUrl(proxyUrl) || !hostRequiresProxy(target.hostname)) {
		try {
			return await fetch(urlString, init);
		} catch (error) {
			if (isLegacyRenegotiationError(error)) {
				try { return await legacyHttpsRequest(urlString, init, timeoutMs); }
				catch (legacyError) { throw new Error(networkFailureHint(urlString, legacyError), { cause: legacyError }); }
			}
			throw new Error(networkFailureHint(urlString, error), { cause: error });
		}
	}
	const proxy = new URL(proxyUrl);
	const secure = target.protocol === "https:";
	const port = target.port !== "" ? Number(target.port) : secure ? 443 : 80;
	const flatHeaders = {};
	for (const [name, value] of Object.entries(init.headers ?? {})) if (typeof value === "string") flatHeaders[name.toLowerCase()] = value;
	flatHeaders.host ??= target.host;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let response;
		if (secure) {
			const socket = await connectTunnel(proxy, target.hostname, port, controller.signal);
			response = await new Promise((resolveRes, rejectRes) => {
				const req = httpsRequest({ socket, servername: target.hostname, host: target.hostname, port, method: init.method ?? "GET", path: `${target.pathname}${target.search}`, headers: flatHeaders }, resolveRes);
				req.on("error", rejectRes);
				controller.signal.addEventListener("abort", () => req.destroy(), { once: true });
				if (typeof init.body === "string") req.write(init.body);
				req.end();
			});
		} else {
			response = await new Promise((resolveRes, rejectRes) => {
				const req = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method: init.method ?? "GET", path: target.href, headers: flatHeaders }, resolveRes);
				req.on("error", rejectRes);
				controller.signal.addEventListener("abort", () => req.destroy(), { once: true });
				if (typeof init.body === "string") req.write(init.body);
				req.end();
			});
		}
		const chunks = [];
		let size = 0;
		for await (const chunk of response) {
			chunks.push(chunk);
			size += chunk.length;
			if (size > 4 * 1024 * 1024) break;
		}
		const headerPairs = Object.entries(response.headers).flatMap(([name, value]) => Array.isArray(value) ? value.map((entry) => [name, entry]) : [[name, value]]);
		return emulatedResponse(response.statusCode ?? 0, response.statusMessage ?? "", headerPairs, Buffer.concat(chunks));
	} finally {
		clearTimeout(timer);
	}
}
/** Build a per-call fetch bound to one session's resolved infra settings. */
const makeHttpFetch = (infra) => (url, init) => proxiedFetch(url, init, infra);
/**
 * [local.11] Raw TCP reachability probe with a hard timeout. Resolves the
 * measured round-trip in ms; rejects when the port refuses/unreachable/timeout.
 */
function tcpProbe(host, port, timeoutMs = 3000) {
	return new Promise((resolveProbe, rejectProbe) => {
		const startedAt = Date.now();
		const socket = netConnect({ host, port }, () => {
			const elapsed = Date.now() - startedAt;
			socket.destroy();
			resolveProbe(elapsed);
		});
		socket.setTimeout(timeoutMs, () => { socket.destroy(); rejectProbe(new Error(`连接超时（${timeoutMs}ms 内无响应）`)); });
		socket.once("error", (error) => { socket.destroy(); rejectProbe(error); });
	});
}
/** [local.13] Rough HTML→text for policy pages: drop script/style, strip tags, decode the common entities, collapse whitespace. */
function htmlToText(html) {
	return String(html)
		.replace(/<script[\s\S]*?<\/script/gi, " ")
		.replace(/<style[\s\S]*?<\/style/gi, " ")
		.replace(/<!--/g, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, "\"")
		.replace(/&#39;/gi, "'")
		.replace(/[ \t\r]+/g, " ")
		.replace(/\n\s*\n+/g, "\n")
		.trim();
}

/** [local.11] Probe URL through the resolved infra proxy and describe the outcome in Chinese. */
async function probeProxy(infra, probeUrl = "https://www.gstatic.com/generate_204") {
	const proxyUrl = String(infra.proxyUrl ?? "").trim();
	if (!isProxyUrl(proxyUrl)) return "当前未配置 HTTP 代理（直连模式），无需测活；如需测活请先在上方填写并保存 proxyUrl。";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number.parseInt(String(infra.httpTimeoutMs ?? ""), 10) || 8000, 1000), 60000));
	const startedAt = Date.now();
	try {
		const http = makeHttpFetch({ ...infra, proxyUrl });
		const response = await http(probeUrl, { method: "GET", signal: controller.signal });
		const ms = Date.now() - startedAt;
		return `代理 ${proxyUrl} 可用：经它请求探针返回 HTTP ${response.status}（${ms}ms）。`;
	} catch (error) {
		const reason = error?.cause?.message ?? error?.message ?? String(error);
		return `代理 ${proxyUrl} 测活失败：${reason}。请确认代理进程在运行、端口正确、且允许本机连接。`;
	} finally {
		clearTimeout(timer);
	}
}
/** [local.13] SSE handshake probe for the Burp MCP extension: proves an MCP SSE endpoint actually answers, not just that the TCP port listens.
 * PortSwigger's "MCP Server" extension serves plain-HTTP SSE on the ROOT path ("/"); the mcp-proxy convention is "/sse" over either scheme, so try
 * http:/ first (the observed real shape), then https:/sse etc., and report exactly which combination answered. */
function probeBurpSse(host, port, timeoutMs = 5000) {
	const candidates = [
		{ secure: false, path: "/" },
		{ secure: false, path: "/sse" },
		{ secure: true, path: "/sse" },
		{ secure: true, path: "/" }
	];
	const attempt = (candidate) => new Promise((resolveProbe, rejectProbe) => {
		const startedAt = Date.now();
		const options = { host, port, path: candidate.path, method: "GET", timeout: timeoutMs, rejectUnauthorized: false };
		const request = candidate.secure ? httpsRequest(options, onResponse) : httpRequest(options, onResponse);
		function onResponse(res) {
			const contentType = String(res.headers["content-type"] ?? "");
			if (res.statusCode !== 200 || !/text\/event-stream/i.test(contentType)) {
				res.resume();
				rejectProbe(new Error(`GET ${candidate.path} -> HTTP ${res.statusCode}${contentType ? ` (${contentType})` : ""}`));
				return;
			}
			/* SSE headers alone prove the MCP endpoint is live; grab one chunk as evidence without hanging if it stalls. */
			let preview = "";
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				request.destroy();
				resolveProbe({ elapsed: Date.now() - startedAt, path: candidate.path, secure: candidate.secure, preview: preview.slice(0, 100).replace(/\s+/g, " ") });
			};
			res.on("data", (chunk) => { preview += String(chunk); finish(); });
			res.on("error", () => finish());
			setTimeout(finish, 1500).unref();
		}
		request.on("timeout", () => request.destroy(new Error(`请求超时（${timeoutMs}ms 内无响应）`)));
		request.on("error", (error) => {
			request.destroy();
			rejectProbe(error);
		});
		request.end();
	});
	return (async () => {
		const failures = [];
		for (const candidate of candidates) {
			try {
				return await attempt(candidate);
			} catch (error) {
				failures.push(error?.message ?? String(error));
			}
		}
		throw new Error(failures.join("; "));
	})();
}
//#endregion
/** Append a node and its edge, capped (oldest dropped). */
/* [local.60] 投影容量分级：此前 withNode/withAsset 对 nodes/edges/assets 一律 slice(-200)，
   超限从最老开始无差别裁剪——9864adca 会话实测 177 个节点被静默裁掉（intent-1..10 全灭、
   finding-1/2 被 add_fact 挤出），面板漏洞/意图随会话变长持续蒸发。新语义：
   ① finding/intent 是面板的核心产出，永不裁剪；② fact 超 FACT_CAP 裁最老并清理其关联边；
   ③ assets 超 ASSET_CAP 裁最老（root-domain 永不裁，UI 分组依赖它）并清理父边。 */
const PROJECTION_FACT_CAP = 500;
const PROJECTION_ASSET_CAP = 500;
function trimEdgesOf(edges, dropIds) {
	return edges.filter((edge) => !dropIds.has(edge.sourceId) && !dropIds.has(edge.targetId));
}
function withNode(state, edgeKind, sourceId, node, counters) {
	if (node.createdAt === void 0) node.createdAt = Date.now();
	const edge = {
		id: `edge-${counters.edge + 1}`,
		kind: edgeKind,
		sourceId,
		targetId: node.id
	};
	let nodes = [...state.nodes, node];
	let edges = [...state.edges, edge];
	if (node.kind === "fact") {
		const facts = nodes.filter((n) => n.kind === "fact");
		if (facts.length > PROJECTION_FACT_CAP) {
			const dropIds = new Set(facts.slice(0, facts.length - PROJECTION_FACT_CAP).map((n) => n.id));
			nodes = nodes.filter((n) => !dropIds.has(n.id));
			edges = trimEdgesOf(edges, dropIds);
		}
	}
	return {
		...state,
		counters: {
			...counters,
			edge: counters.edge + 1
		},
		nodes,
		edges
	};
}
/** Append an asset and its optional parent edge, capped (oldest dropped; root-domain kept; [local.60]). */
function withAsset(state, asset, parentId, counters) {
	let assets = [...state.assets, asset];
	let edges = state.edges;
	let edgeCounters = counters;
	if (parentId !== void 0) {
		edges = [...edges, {
			id: `edge-${counters.edge + 1}`,
			kind: "parent",
			sourceId: parentId,
			targetId: asset.id
		}];
		edgeCounters = {
			...counters,
			edge: counters.edge + 1
		};
	}
	if (assets.length > PROJECTION_ASSET_CAP) {
		const keep = assets.filter((row) => row.type !== "root-domain");
		if (keep.length > PROJECTION_ASSET_CAP) {
			const dropIds = new Set(keep.slice(0, keep.length - PROJECTION_ASSET_CAP).map((row) => row.id));
			assets = assets.filter((row) => row.type === "root-domain" || !dropIds.has(row.id));
			edges = trimEdgesOf(edges, dropIds);
		}
	}
	return {
		...state,
		counters: edgeCounters,
		assets,
		edges
	};
}
/** The next deterministic id of one node kind (the goal is fixed as `goal-1`). */
function nextNodeId(state, kind) {
	const counters = {
		...state.counters,
		[kind]: state.counters[kind] + 1
	};
	return {
		id: `${kind}-${counters[kind]}`,
		counters
	};
}
/** Look up an existing folded node by id and kind. */
function findNode(state, id, kind) {
	return state.nodes.find((node) => node.id === id && node.kind === kind);
}
/** Fold one session event into the standing src state (pure, replay-safe). */
function applySrcEvent(state, event) {
	const submission = event;
	const replay = (name, args, current) => applySrcEvent(current, {
		type: "tool/call",
		data: {
			name,
			arguments: JSON.stringify(args)
		}
	});
	if (submission.type === "src/submit") {
		const data = submission.data;
		const intentId = str(data.intentId);
		if (intentId === "") return state;
		let next = state;
		for (const fact of Array.isArray(data.facts) ? data.facts : []) if (fact !== null && typeof fact === "object") next = replay("src_add_fact", {
			...fact,
			intentId
		}, next);
		for (const asset of Array.isArray(data.assets) ? data.assets : []) if (asset !== null && typeof asset === "object") next = replay("src_add_asset", asset, next);
		for (const finding of Array.isArray(data.findings) ? data.findings : []) if (finding !== null && typeof finding === "object") next = replay("src_add_finding", {
			...finding,
			intentId
		}, next);
		return next;
	}
	if (event.type !== "tool/call") return state;
	const args = argsOf(event);
	if (args === void 0) return state;
	switch (event.data.name) {
		case "src_record_recon": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			let next = state;
			for (const asset of Array.isArray(args.assets) ? args.assets : []) if (asset && typeof asset === "object") next = replay("src_add_asset", { ...asset, source: str(args.source) || "unknown", method: str(args.method) || "passive", confidence: typeof asset.confidence === "number" ? asset.confidence : .5, status: str(asset.status) || "confirmed" }, next);
			for (const fact of Array.isArray(args.facts) ? args.facts : []) if (fact && typeof fact === "object") next = replay("src_add_fact", { ...fact, intentId }, next);
			return next;
		}
		case "src_add_goal": {
			const target = str(args.target);
			const objective = str(args.objective);
			if (target === "" || objective === "") return state;
			return {
				goal: {
					id: "goal-1",
					target,
					objective,
					authorization: str(args.authorization)
				},
				nodes: [],
				assets: [],
				coverage: [],
				research: [],
				checkpoints: [],
				observations: [],
				userTodos: [],
				pendingApprovals: [],
				/* [local.33] 认证预算是会话级（store authRequestCounts 不随 goal 重置），fold 同样保留。 */
				authBudget: state.authBudget ?? { used: 0, limit: SRC_AUTH_REQUEST_BUDGET },
				infra: state.infra ?? {},
				edges: [],
				counters: {
					intent: 0,
					fact: 0,
					finding: 0,
					asset: 0,
					edge: 0
				}
			};
		}
		case "src_set_infra": {
			const key = str(args.key);
			if (!SRC_INFRA_KEYS.includes(key)) return state;
			return { ...state, infra: { ...(state.infra ?? {}), [key]: str(args.value).slice(0, 300) } };
		}
		case "src_add_intent": {
			const title = str(args.title);
			const detail = str(args.detail);
			const intentPriority = typeof args.priority === "number" && Number.isInteger(args.priority) && args.priority >= 1 && args.priority <= 9 ? args.priority : void 0;
			if (title === "") return state;
			if (state.nodes.some((node) => node.kind === "intent" && node.title.toLowerCase() === title.toLowerCase() && node.detail.toLowerCase() === detail.toLowerCase())) return state;
			let goalId = str(args.goalId);
			let derivedFromFactId = str(args.derivedFromFactId);
			/* [local.58] execute 层锚点自愈的 fold 镜像：宿主日志落的是模型原始参数，模型被工具描述引导后系统性不传 goalId，
			   fold 若照旧丢弃会级联蒸发 fact/finding/checkpoint/research/approval（中通 session-9864adca 实测：intents/facts/findings 全灭）。
			   语义与 execute 层一致：两锚点全漏且当前 goal 存在 → 锚到该 goal；无 goal 仍丢弃。 */
			if (goalId === "" && derivedFromFactId === "" && state.goal !== null) goalId = state.goal.id;
			/* [local.66] 双锚点同传的 fold 镜像（hackone session-f64ff5b1 实测模型系统性双传）：与 execute 层一致
			   优先按 derived_from 锚（语义更具体）——fact 已在投影中存在即弃 goalId；fact 缺失才退回 goal 锚。 */
			if (goalId !== "" && derivedFromFactId !== "") {
				if (findNode(state, derivedFromFactId, "fact") !== void 0) goalId = "";
				else derivedFromFactId = "";
			}
			if ((goalId !== "" ? 1 : 0) + (derivedFromFactId !== "" ? 1 : 0) !== 1) return state;
			if (goalId !== "") {
				if (state.goal === null || goalId !== state.goal.id) return state;
				const { id, counters } = nextNodeId(state, "intent");
				return withNode(state, "spawns", goalId, {
					id,
					kind: "intent",
					title,
					detail,
					status: "planned",
					...(intentPriority !== void 0 ? { priority: intentPriority } : {}),
					playbook: routePlaybook(title, detail)
				}, counters);
			}
			if (findNode(state, derivedFromFactId, "fact") === void 0) return state;
			const { id: derivedId, counters: derivedCounters } = nextNodeId(state, "intent");
			return withNode(state, "derived_from", derivedFromFactId, {
				id: derivedId,
				kind: "intent",
				title,
				detail,
				status: "planned",
				...(intentPriority !== void 0 ? { priority: intentPriority } : {}),
				playbook: routePlaybook(title, detail)
			}, derivedCounters);
		}
		case "src_add_fact": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const detail = str(args.detail);
			if (detail === "") return state;
			const target = str(args.target);
			const candidateKind = typeof args.kind === "string" && FACT_KINDS$1.has(args.kind) ? args.kind : "info";
			if (state.nodes.some((node) => node.kind === "fact" && node.intentId === intentId && node.factKind === candidateKind && node.target.toLowerCase() === target.toLowerCase() && node.detail.toLowerCase() === detail.toLowerCase())) return state;
			const kind = typeof args.kind === "string" && FACT_KINDS$1.has(args.kind) ? args.kind : "info";
			const confidence = typeof args.confidence === "number" && Number.isFinite(args.confidence) ? Math.min(1, Math.max(0, args.confidence)) : .5;
			const { id, counters } = nextNodeId(state, "fact");
			return withNode(state, "yields", intentId, {
				id,
				kind: "fact",
				factKind: kind,
				intentId,
				target,
				detail,
				confidence
			}, counters);
		}
		case "src_add_finding": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const title = str(args.title);
			if (title === "") return state;
			const steps = Array.isArray(args.reproducibleSteps) ? args.reproducibleSteps.filter((step) => typeof step === "string" && step !== "") : [];
			const impact = str(args.impact);
			const affectedScope = str(args.affectedScope);
			const remediation = str(args.remediation);
			const pocEvidence = Array.isArray(args.pocEvidence) ? args.pocEvidence.filter((item) => typeof item === "string" && item !== "") : [];
			if (steps.length === 0 || impact === "" || affectedScope === "" || remediation === "" || pocEvidence.length === 0) return state;
			const severity = typeof args.severity === "string" && SEVERITIES$1.has(args.severity) ? args.severity : "info";
			const affectedAssetId = str(args.affectedAssetId);
			if (affectedAssetId !== "" && !state.assets.some((asset) => asset.id === affectedAssetId)) return state;
			if (state.nodes.some((node) => node.kind === "finding" && node.title.toLowerCase() === title.toLowerCase() && (node.affectedAssetId ?? "") === affectedAssetId)) return state;
			const { id, counters } = nextNodeId(state, "finding");
			return withNode(state, "proves", intentId, {
				id,
				kind: "finding",
				intentId,
				title,
				severity,
				description: str(args.description),
				impact,
				victimImpact: str(args.victimImpact),
				attackPrerequisites: str(args.attackPrerequisites),
				concreteLossEvidence: Array.isArray(args.concreteLossEvidence) ? args.concreteLossEvidence.filter((item) => typeof item === "string" && item !== "") : [],
				affectedScope,
				remediation,
				pocEvidence,
				steps,
				entryPoint: str(args.entryPoint),
				discoveryPath: str(args.discoveryPath),
				rawRequest: str(args.rawRequest),
				rawResponse: str(args.rawResponse),
				attackChain: str(args.attackChain),
				vulnType: str(args.vulnType),
				pocScript: str(args.pocScript),
				status: "active",
				rejectReason: "",
				rejectedAt: 0,
				affectedAssetId: affectedAssetId === "" ? void 0 : affectedAssetId
			}, counters);
		}
		case "src_update_finding": {
			const findingId = str(args.findingId);
			if (findNode(state, findingId, "finding") === void 0) return state;
			const patch = {};
			for (const key of [	"title", "severity", "description", "impact", "victimImpact", "affectedScope", "remediation", "entryPoint", "discoveryPath", "rawRequest", "rawResponse", "attackPrerequisites", "attackChain"]) {
				if (typeof args[key] === "string") patch[key] = args[key];
			}
			if (Array.isArray(args.pocEvidence)) patch.pocEvidence = args.pocEvidence.filter((item) => typeof item === "string" && item !== "");
			if (Array.isArray(args.concreteLossEvidence)) patch.concreteLossEvidence = args.concreteLossEvidence.filter((item) => typeof item === "string" && item !== "");
			if (Array.isArray(args.reproducibleSteps)) patch.steps = args.reproducibleSteps.filter((step) => typeof step === "string" && step !== "");
			const assetId = str(args.affectedAssetId);
			if (assetId !== "" && !state.assets.some((asset) => asset.id === assetId)) return state;
			if (typeof args.severity === "string" && !SEVERITIES$1.has(args.severity)) return state;
			return { ...state, nodes: state.nodes.map((node) => node.kind === "finding" && node.id === findingId ? { ...node, ...patch, ...(assetId !== "" ? { affectedAssetId: assetId } : args.affectedAssetId === "" ? { affectedAssetId: void 0 } : {}) } : node) };
		}
		case "src_reject_finding": {
			/* [local.26] 打回：finding 置 rejected + 记备注，保留在图里供防二次提交与后续组合引用。 */
			const findingId = str(args.findingId);
			const finding = findNode(state, findingId, "finding");
			if (finding === void 0) return state;
			const reason = str(args.reason);
			if (reason === "") return state;
			return { ...state, nodes: state.nodes.map((node) => node.kind === "finding" && node.id === findingId ? { ...node, status: "rejected", rejectReason: reason, rejectedAt: Number(args.rejectedAt) || 0 } : node) };
		}
		case "src_record_coverage": {
			const phase = str(args.phase), category = str(args.category), status = args.status;
			if (phase === "" || category === "" || !["planned", "running", "completed", "blocked", "not-applicable"].includes(status)) return state;
			const record = { id: str(args.id) || `coverage-${state.coverage.length + 1}`, assetId: str(args.assetId) || void 0, phase, category, status, evidence: Array.isArray(args.evidence) ? args.evidence.filter((x) => typeof x === "string") : [], limitation: str(args.limitation), updatedAt: Number(args.updatedAt) || 0 };
			const existing = state.coverage.findIndex((row) => row.assetId === record.assetId && row.phase === phase && row.category === category);
			const coverage = [...state.coverage];
			if (existing >= 0) coverage[existing] = { ...record, id: coverage[existing].id }; else coverage.push(record);
			return { ...state, coverage: coverage.slice(-500) };
		}
		case "src_record_research": {
			const intentId = str(args.intentId), category = str(args.category), hypothesis = str(args.hypothesis), status = args.status;
			if (intentId === "" || findNode(state, intentId, "intent") === void 0 || category === "" || hypothesis === "" || !["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"].includes(status)) return state;
			const record = { id: str(args.id) || `research-${state.research.length + 1}`, intentId, category, hypothesis, preconditions: Array.isArray(args.preconditions) ? args.preconditions.filter((x) => typeof x === "string") : [], status, stopReason: str(args.stopReason), evidence: Array.isArray(args.evidence) ? args.evidence.filter((x) => typeof x === "string") : [], findingId: str(args.findingId) || void 0, updatedAt: Number(args.updatedAt) || 0 };
			const existing = state.research.findIndex((row) => row.intentId === intentId && row.category === category);
			const research = [...state.research];
			if (existing >= 0) research[existing] = { ...record, id: research[existing].id }; else research.push(record);
			return { ...state, research: research.slice(-500) };
		}
		case "src_record_asset_observation":
		case "src_add_asset": {
			const type = typeof args.type === "string" && ASSET_TYPES$1.has(args.type) ? args.type : void 0;
			if (type === void 0) return state;
			const value = str(args.value);
			if (value === "") return state;
			const parentId = str(args.parentId);
			if (parentId !== "" && !state.assets.some((asset) => asset.id === parentId)) return state;
			if (state.assets.some((asset) => asset.type === type && asset.value.toLowerCase() === value.toLowerCase())) return state;
			const { id, counters } = nextNodeId(state, "asset");
			return withAsset(state, {
				id,
				type,
				value,
				meta: str(args.meta), source: str(args.source) || "unknown", method: ["passive", "low-impact", "authorized-active", "user-confirmed"].includes(args.method) ? args.method : "passive", confidence: typeof args.confidence === "number" ? Math.min(1, Math.max(0, args.confidence)) : .5, status: ["candidate", "confirmed", "excluded"].includes(args.status) ? args.status : "confirmed"
			}, parentId === "" ? void 0 : parentId, counters);
		}
		case "src_test_bypass": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const category = typeof args.category === "string" && BYPASS_CATEGORIES.includes(args.category) ? args.category : "authorization-bypass";
			const blocked = args.forceAfterProtection === true ? false : JSON.stringify(args).includes("requiresDecision");
			const coverage = [...state.coverage];
			const existing = coverage.findIndex((row) => row.phase === category && row.category === "bypass-verification");
			const record = { id: str(args.id) || `coverage-${state.coverage.length + 1}`, assetId: str(args.assetId) || void 0, phase: category, category: "bypass-verification", status: blocked ? "blocked" : "running", evidence: [], limitation: blocked ? "protection/waf/rate-limit signal" : "", updatedAt: 0 };
			if (existing >= 0) coverage[existing] = { ...record, id: coverage[existing].id }; else coverage.push(record);
			return { ...state, coverage: coverage.slice(-500) };
		}
		case "src_collect_passive": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const coverage = [...state.coverage];
			const existing = coverage.findIndex((row) => row.phase === "discovery" && row.category === "passive-collection");
			const status = JSON.stringify(args).includes("requiresDecision") ? "blocked" : "completed";
			const record = { id: str(args.id) || `coverage-${state.coverage.length + 1}`, assetId: void 0, phase: "discovery", category: "passive-collection", status, evidence: [], limitation: status === "blocked" ? "protection detected before passive collection" : "", updatedAt: 0 };
			if (existing >= 0) coverage[existing] = { ...record, id: coverage[existing].id }; else coverage.push(record);
			return { ...state, coverage: coverage.slice(-500) };
		}
		case "src_record_observation": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const path = str(args.path);
			if (path === "") return state;
			const observation = { id: `obs-${state.observations.length + 1}`, intentId, assetId: str(args.assetId) === "" ? void 0 : str(args.assetId), method: str(args.method) || "GET", path, httpStatus: Number(args.httpStatus) || 0, protectionSignal: args.protectionSignal === true, wafBypassed: args.wafBypassed === true, source: str(args.source) || "scan", decision: str(args.decision), respHeaders: str(args.respHeaders).slice(0, 600), respBodySnippet: str(args.respBodySnippet).slice(0, 1200), createdAt: Date.now() };
			if (state.observations.some((row) => row.intentId === intentId && row.method === observation.method && row.path === path && row.createdAt === observation.createdAt)) return state;
			return { ...state, observations: [...state.observations, observation].slice(-500) };
		}
/* [local.64] fold 新建分支 id 必须与 store 同源：优先事件里携带的真实 store id（合成事件带 id），
 * 否则回退 userTodo-<行数+1>（与 store nextId 的 max+1 序号在无删除前提下同步）。此前自造
 * todo-<n> 前缀与 store 的 userTodo-<n> 永久漂移：更新事件按 id 匹配不到投影行被静默丢弃
 * （UI 永远 pending），UI ✓/✗ 发投影 id 转写回时 store 也会重复建行——覆盖面待办实弹验证暴露。 */
		case "src_user_todo": {
			/* [local.60] 更新分支（userTodoId 在场）不再要求 title——此前 title==="" 时整体 return state，
			   状态/备注更新全部丢投影（14:00 更新 todo-1 被拒的同根缺陷）。title 现在只作为新建必填。 */
			const userTodoId = str(args.userTodoId);
			const title = str(args.title);
			if (userTodoId !== "") {
				return { ...state, userTodos: state.userTodos.map((row) => row.id === userTodoId ? { ...row, status: ["pending", "done", "abandoned"].includes(args.status) ? args.status : row.status, note: str(args.note) !== "" ? str(args.note) : row.note, ...(title !== "" ? { title } : {}) } : row) };
			}
			if (title === "") return state;
			const foldId = str(args.id) !== "" ? str(args.id) : `userTodo-${state.userTodos.length + 1}`;
			return { ...state, userTodos: [...state.userTodos, { id: foldId, intentId: str(args.intentId) === "" ? void 0 : str(args.intentId), kind: str(args.kind) || "other", title, detail: str(args.detail), status: "pending", note: "", createdAt: Date.now() }] };
		}
		/* [local.31] 高危请求挂起：src_http 高风险时发合成事件 src_record_pending_approval，fold 建待审节点。 */
		case "src_record_pending_approval": {
			const id = str(args.id) || `approval-${state.pendingApprovals.length + 1}`;
			if (state.pendingApprovals.some((row) => row.id === id)) return state;
			return { ...state, pendingApprovals: [...state.pendingApprovals, { id, intentId: str(args.intentId) === "" ? void 0 : str(args.intentId), method: str(args.method) || "GET", url: str(args.url), path: str(args.path), headers: str(args.headers), body: str(args.body), category: str(args.category), reason: str(args.reason), justification: str(args.justification), status: "pending", note: "", responseStatus: 0, createdAt: Date.now(), ...str(args.credentialRef) !== "" ? { credentialRef: str(args.credentialRef) } : {} }] };
		}
		/* [local.31] 审批 resolution：src_resolve_approval 发合成事件同步 fold 状态。 */
		case "src_resolve_approval": {
			const id = str(args.id);
			if (id === "" || !state.pendingApprovals.some((row) => row.id === id)) return state;
			return { ...state, pendingApprovals: state.pendingApprovals.map((row) => row.id === id ? { ...row, status: args.action === "allow" ? "approved" : "rejected", note: str(args.note) !== "" ? str(args.note) : row.note, responseStatus: args.action === "allow" ? Number(args.responseStatus) || 0 : 0 } : row) };
		}
		/* [local.33] 认证预算可视化：src_test_bypass 发出认证请求后发合成事件 src_auth_budget（store 权威计数，不复制分类逻辑），fold 落 state → 头部「认证 used/limit」格。 */
		case "src_auth_budget": {
			const used = typeof args.used === "number" && Number.isFinite(args.used) && args.used >= 0 ? Math.floor(args.used) : void 0;
			const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : void 0;
			if (used === void 0 || limit === void 0) return state;
			return { ...state, authBudget: { used, limit } };
		}
		/* [local.33] 域笔记快照：src_add_goal / src_record_domain_note 发合成事件，把目标全域笔记（含 content）
		   整体替换进 fold。跨会话数据不经过本会话事件流，只能由工具 handler 从 store 快照搬运（上限 50 条防事件膨胀）。 */
		case "src_domain_notes_snapshot": {
			if (!Array.isArray(args.notes)) return state;
			const rows = [];
			for (const note of args.notes.slice(0, 50)) {
				if (note === null || typeof note !== "object") continue;
				const id = str(note.id);
				const title = str(note.title);
				if (id === "" || title === "") continue;
				rows.push({ id, category: str(note.category) || "misc", title, content: str(note.content), sourceSessionId: str(note.sourceSessionId), createdAt: typeof note.createdAt === "number" ? note.createdAt : 0, updatedAt: typeof note.updatedAt === "number" ? note.updatedAt : 0 });
			}
			return { ...state, domainNotes: rows };
		}
		case "src_update_intent": {
			const intentId = str(args.intentId);
			/* [local.42] Decide 语义：status 可选（新增 deprecated 废弃态），priority 1-9 可单独调。 */
			const status = ["planned", "running", "completed", "blocked", "failed", "deprecated"].includes(args.status) ? args.status : void 0;
			const priority = typeof args.priority === "number" && Number.isInteger(args.priority) && args.priority >= 1 && args.priority <= 9 ? args.priority : void 0;
			if (status === void 0 && priority === void 0) return state;
			return { ...state, nodes: state.nodes.map((node) => node.kind === "intent" && node.id === intentId ? { ...node, ...(status !== void 0 ? { status } : {}), ...(priority !== void 0 ? { priority } : {}) } : node) };
		}
		case "src_checkpoint": {
			const intentId = str(args.intentId);
			if (findNode(state, intentId, "intent") === void 0) return state;
			const stage = ["progress", "completed", "blocked", "failed"].includes(args.stage) ? args.stage : "progress";
			const checkpoint = { id: str(args.id), intentId, childSessionId: str(args.childSessionId), stage, summary: str(args.summary), decision: str(args.decision), facts: Number(args.facts) || 0, assets: Number(args.assets) || 0, findings: Number(args.findings) || 0, batchKey: str(args.batchKey), createdAt: Number(args.createdAt) || 0 };
			if (checkpoint.id === "" || checkpoint.batchKey === "" || state.checkpoints.some((row) => row.id === checkpoint.id || row.batchKey === checkpoint.batchKey)) return state;
			const status = stage === "completed" ? "completed" : stage === "blocked" ? "blocked" : stage === "failed" ? "failed" : "running";
			return { ...state, nodes: state.nodes.map((node) => node.kind === "intent" && node.id === intentId ? { ...node, status } : node), checkpoints: [...state.checkpoints, checkpoint].slice(-200) };
		}
		default: return state;
	}
}
/** Project the fold state onto the wire payload (null before the first goal). */
function viewSrcState(state) {
	/* [local.12] A fresh session has goal === null. Returning null hid the whole
	 * SRC panel (including infrastructure setup) until the agent created a goal,
	 * so the view now always materializes; consumers handle goal === null. */
	const apiAssets = state.assets.filter((asset) => asset.type === "endpoint" && typeof asset.meta === "string" && asset.meta.startsWith("api:"));
	const coverage = state.coverage;
	const research = state.research;
	const untouched = apiAssets.filter((asset) => {
		const assetCoverage = coverage.filter((row) => row.assetId === asset.id);
		const hasProgress = assetCoverage.some((row) => ["running", "completed", "blocked", "not-applicable"].includes(row.status));
		const assetResearch = research.filter((row) => (row.evidence ?? []).some((evidence) => evidence.includes(asset.value)) || row.hypothesis.includes(asset.value));
		const hasManualResearchProgress = assetResearch.some((row) => row.status !== "hypothesis" || !(row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
		return !hasProgress && !hasManualResearchProgress;
	});
	return {
		goal: state.goal,
		infra: { ...SRC_INFRA_DEFAULTS, ...(state.infra ?? {}) },
		apiDiscovery: {
			total: apiAssets.length,
			schemas: apiAssets.filter((asset) => asset.meta.startsWith("api:openapi-schema") || asset.meta.startsWith("api:schema-path")).length,
			graphql: apiAssets.filter((asset) => asset.meta.startsWith("api:graphql-endpoint")).length,
			hints: apiAssets.filter((asset) => asset.meta.startsWith("api:html-js-hint")).length,
			untouched: untouched.length
		},
		nodes: state.nodes,
		assets: state.assets,
		coverage: state.coverage,
		research: state.research,
		checkpoints: state.checkpoints,
		observations: state.observations ?? [],
		userTodos: state.userTodos ?? [],
		pendingApprovals: state.pendingApprovals ?? [],
		testAccounts: state.testAccounts ?? [],
		authBudget: state.authBudget ?? { used: 0, limit: SRC_AUTH_REQUEST_BUDGET },
		domainNotes: state.domainNotes ?? [],
		edges: state.edges,
		counts: {
			intents: state.nodes.filter((node) => node.kind === "intent").length,
			facts: state.nodes.filter((node) => node.kind === "fact").length,
			findings: state.nodes.filter((node) => node.kind === "finding").length,
			assets: state.assets.length,
			coverage: state.coverage.length,
			research: state.research.length,
			checkpoints: state.checkpoints.length,
			observations: (state.observations ?? []).length,
			userTodos: (state.userTodos ?? []).length,
			pendingApprovals: (state.pendingApprovals ?? []).length,
			testAccounts: (state.testAccounts ?? []).length,
			domainNotes: (state.domainNotes ?? []).length
		}
	};
}
//#endregion
//#region src/spec.ts
/**
* Durable storage-domain declaration for the penetration-testing mode: the
* per-task exploration graph.
*
* One engagement (per session) starts at a **goal**; the exploration advances
* along a chain — goal spawns **intents**, an intent yields **facts**, a fact
* derives a new intent, and an intent proves a **finding** (vulnerability
* with reproducible steps). **Assets** (root domain / subdomain / ip / service
* / app / endpoint) form a second, parent-linked graph. Every relationship is
* an explicit **edge** row, so both graphs are fully reconstructible.
*
* Everything is scoped to a single session: every record carries the owning
* `sessionId`. Record schemas are zod; the domain schema validates every
* stored record at the durable boundary (the storage-domain facility is the
* package's guard, so no separate event invariant companion is needed).
* @module @deepseek-ai/dsh-src/src/spec
*/
/** Kind of a discovered fact (free-form evidence tag). */
const srcFactKindSchema = z.enum([
	"port",
	"service",
	"vuln",
	"finding",
	"http",
	"info",
	"auth-profile"
]);
/** Severity of a vulnerability finding. */
const srcSeveritySchema = z.enum([
	"critical",
	"high",
	"medium",
	"low",
	"info"
]);
/** Kind of a recorded asset. */
const srcAssetTypeSchema = z.enum([
	"root-domain",
	"subdomain",
	"ip",
	"service",
	"app",
	"endpoint",
	"mini-program",
	"client",
	"firmware",
	"ai-surface",
	"threat-intel"
]);
/** Kind of an exploration/asset graph edge. */
const srcEdgeKindSchema = z.enum([
	"spawns",
	"yields",
	"derived_from",
	"proves",
	"parent"
]);
/** Non-empty id. */
const id = z.string().min(1);
/** The engagement goal: one per session, reset by the next goal. */
const srcGoalSchema = z.object({
	id,
	sessionId: id,
	target: z.string(),
	objective: z.string(),
	/**
	* Declarative authorization note for the engagement (permission holder or
	* written-permission reference). Recorded as an auditable fact, not a
	* gate: enforcement stays at the deployment's sandbox/approval layer.
	*/
	authorization: z.string().default("")
});
/** One exploration intent (what to verify / pursue next). */
const srcIntentSchema = z.object({
	id,
	sessionId: id,
	title: z.string().min(1),
	detail: z.string().default(""),
	status: z.enum(["planned", "running", "completed", "blocked", "failed", "deprecated"]).default("planned"),
	/* [local.42] Decide 语义：执行优先级 1-9（9 最高），src_state 列表按其降序排列；缺省视为中优先级。 */
	priority: z.number().int().min(1).max(9).optional(),
	playbook: z.object({
		keys: z.array(z.string()),
		docs: z.array(z.string()),
		checks: z.array(z.string()),
		matchedBy: z.array(z.string())
	}).optional()
});
/** One durable progress checkpoint emitted by a delegated child. */
const srcCheckpointSchema = z.object({
	id,
	sessionId: id,
	intentId: id,
	childSessionId: id,
	stage: z.enum(["progress", "completed", "blocked", "failed"]),
	summary: z.string().default(""),
	facts: z.number().int().nonnegative(),
	assets: z.number().int().nonnegative(),
	findings: z.number().int().nonnegative(),
	batchKey: z.string().min(1),
	decision: z.string().default(""),
	createdAt: z.number().int().nonnegative()
});
/** One discovered fact (evidence) yielded by an intent. */
const srcFactSchema = z.object({
	id,
	sessionId: id,
	intentId: id,
	kind: srcFactKindSchema,
	target: z.string().default(""),
	detail: z.string().min(1),
	confidence: z.number().min(0).max(1).default(.5)
});
/** One vulnerability finding proved by an intent, with reproducible steps. */
const srcFindingSchema = z.object({
	id,
	sessionId: id,
	intentId: id,
	title: z.string().min(1),
	severity: srcSeveritySchema,
	description: z.string().default(""),
	impact: z.string().min(1),
	affectedScope: z.string().min(1),
	remediation: z.string().min(1),
	pocEvidence: z.array(z.string().min(1)).min(1),
	/** Concrete, ordered steps that reproduce the vulnerability (min one). */
	reproducibleSteps: z.array(z.string().min(1)).min(1),
	/** Front-end entry point (功能点) where the issue is reachable. */
	entryPoint: z.string().default(""),
	/** Source chain of the interface/discovery (接口来源链). */
	discoveryPath: z.string().default(""),
	/** Burp-format raw request packet (必須非空提交). */
	rawRequest: z.string().default(""),
	/** Key response raw bytes (Burp format). */
	rawResponse: z.string().default(""),
	/** [local.16] Victim-perspective harm: who gets hurt, what they lose, how noticeable. */
	victimImpact: z.string().default(""),
	/** [local.26] Optional free-form attack-chain narrative (multi-step / combined). */
	attackChain: z.string().default(""),
	/** [local.26] 漏洞/情报类型（提交模板用，如「登录认证漏洞」「越权漏洞」「信息泄露」）；为空时报告标「(未分类)」。 */
	vulnType: z.string().default(""),
	/** [local.27] 一键 PoC 脚本（多行，报告用 ``` 代码块渲染保留缩进）。 */
	pocScript: z.string().default(""),
	/** [local.26] Lifecycle status: active (in report) or rejected (user 打回, kept for re-block + combination). */
	status: z.enum(["active", "rejected"]).default("active"),
	/** [local.26] User-supplied reject remark driving the agent follow-up (e.g. re-draw chain, write a script). */
	rejectReason: z.string().default(""),
	/** [local.26] Epoch ms the finding was rejected. */
	rejectedAt: z.number().int().nonnegative().default(0),
	/** Optional asset the finding affects. */
	affectedAssetId: id.optional()
});
/** One recorded asset; parent linkage lives on the `parent` edge row. */
/**
 * [local.45] 加载路径的 legacy 资产归一化：枚举约束（local.43）落地前的旧记录
 * 存有自由文本 method（如 "active"）。zod preprocess 在 domain open 全量校验时
 * 映射到最接近的合法值，避免一条 legacy 记录卡死整个 domain 的打开（资产只增不删，
 * 不丢弃数据）。写入路径不受影响——工具入参校验仍用未包袋的枚举。
 */
const LEGACY_ASSET_METHOD_MAP = { active: "authorized-active" };
const srcAssetSchema = z.preprocess((raw) => {
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
		const method = raw.method;
		if (typeof method === "string" && LEGACY_ASSET_METHOD_MAP[method] !== void 0) return { ...raw, method: LEGACY_ASSET_METHOD_MAP[method] };
	}
	return raw;
}, z.object({
	id,
	sessionId: id,
	type: srcAssetTypeSchema,
	value: z.string().min(1),
	meta: z.string().default(""),
	source: z.string().default("unknown"),
	method: z.enum(["passive", "low-impact", "authorized-active", "user-confirmed"]).default("passive"),
	confidence: z.number().min(0).max(1).default(.5),
	status: z.enum(["candidate", "confirmed", "excluded"]).default("confirmed")
}));
const srcCoverageSchema = z.object({
	id, sessionId: id, assetId: id.optional(), phase: z.string().min(1), category: z.string().min(1),
	status: z.enum(["planned", "running", "completed", "blocked", "not-applicable"]),
	evidence: z.array(z.string()).default([]), limitation: z.string().default(""), updatedAt: z.number().int().nonnegative()
});
/** One HTTP observation from an active probe or imported traffic (timeline). */
const srcObservationSchema = z.object({
	id, sessionId: id, intentId: id.optional(), assetId: id.optional(),
	method: z.string().default("GET"), path: z.string().min(1), httpStatus: z.number().int().default(0),
	respHeaders: z.string().default(""), respBodySnippet: z.string().default(""),
	protectionSignal: z.boolean().default(false), wafBypassed: z.boolean().default(false),
	source: z.enum(["burp-mcp", "har", "raw", "manual", "scan"]).default("scan"),
	decision: z.string().default(""), createdAt: z.number().int().nonnegative()
});
/** One user-assist todo awaiting a human action (e.g. login state capture). */
const srcUserTodoSchema = z.object({
	id, sessionId: id, intentId: id.optional(),
	title: z.string().min(1),
	detail: z.string().default(""),
	kind: z.enum(["auth-session", "burp-enable", "asset-provide", "decision", "manual-test", "other"]).default("other"),
	status: z.enum(["pending", "done", "abandoned"]).default("pending"),
	note: z.string().default(""), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative()
});
/** [local.31] One high-risk HTTP request hung up pending human approval. The full request
 *  body is stored so src_resolve_approval can replay it verbatim when the user approves.
 *  async (轮次外可审) — dsh-user-approval 只支持轮次内同步 seam，故 dsh-src 自建队列。 */
const srcPendingApprovalSchema = z.object({
	id, sessionId: id, intentId: id.optional(),
	method: z.enum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "RUN", "ASSET"]).default("GET"),
	url: z.string().min(1),
	path: z.string().default(""),
	headers: z.string().default(""),
	credentialRef: z.string().min(1).optional(),
	body: z.string().default(""),
	category: z.string().default(""),
	reason: z.string().default(""),
	justification: z.string().default(""),
	status: z.enum(["pending", "approved", "rejected"]).default("pending"),
	note: z.string().default(""),
	responseStatus: z.number().int().nonnegative().default(0),
	runOutput: z.string().optional(),
	createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative()
});
const srcResearchSchema = z.object({
	id, sessionId: id, intentId: id, category: z.string().min(1), hypothesis: z.string().min(1),
	preconditions: z.array(z.string()).default([]), status: z.enum(["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"]),
	stopReason: z.string().default(""), evidence: z.array(z.string()).default([]), findingId: id.optional(), updatedAt: z.number().int().nonnegative()
});
/** [local.11] One infrastructure setting override row (session + key scoped). */
const srcInfraSchema = z.object({
	id, sessionId: id,
	key: z.string().min(1),
	value: z.string(),
	updatedAt: z.number().int().nonnegative()
});
/** [local.23] One pasted test-account credential row (multi-account matrix). label 主通道，sourceObservationId 归因兜底。 */
const srcTestAccountSchema = z.object({
	id, sessionId: id,
	label: z.string().min(1),
	credential: z.string().min(1).optional(),
	credentialRef: z.string().min(1).optional(),
	note: z.string().default(""),
	sourceObservationId: id.optional(),
	createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative()
});
/** [local.24] 域笔记：按目标域名跨会话积累（域指纹/坑位/已否假设摘要/基线素材）。 */
const srcDomainNoteSchema = z.object({
	id,
	target: z.string().min(1),
	/** 记录来源会话（归因），但笔记本身按 target 全局共享。 */
	sessionId: id,
	category: z.enum(["fingerprint", "pitfall", "falsified-summary", "baseline", "misc"]).default("misc"),
	title: z.string().min(1).max(200),
	content: z.string().min(1).max(8000),
	createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative()
});
/** One graph edge: source → target with a semantic kind. */
const srcEdgeSchema = z.object({
	id,
	sessionId: id,
	kind: srcEdgeKindSchema,
	sourceId: id,
	targetId: id
});
/** The whole src domain: goal/intent/fact/finding/asset nodes plus edges. */
const srcDomainSpec = defineDomain({
	name: "src",
	version: 12,
	tables: {
		goals: domainTable(srcGoalSchema),
		intents: domainTable(srcIntentSchema),
		facts: domainTable(srcFactSchema),
		findings: domainTable(srcFindingSchema),
		assets: domainTable(srcAssetSchema),
		coverage: domainTable(srcCoverageSchema),
		research: domainTable(srcResearchSchema),
		checkpoints: domainTable(srcCheckpointSchema),
		observations: domainTable(srcObservationSchema),
		user_todos: domainTable(srcUserTodoSchema),
		pending_approvals: domainTable(srcPendingApprovalSchema),
		test_accounts: domainTable(srcTestAccountSchema),
		domain_notes: domainTable(srcDomainNoteSchema),
		edges: domainTable(srcEdgeSchema),
		infra: domainTable(srcInfraSchema)
	}
});
//#endregion
//#region src/store.ts
/** The record table owning each id kind. */
/** [local.17] Zod schema per node kind, for write-time validation (mirrors srcDomainSpec tables). */
const SCHEMA_OF_KIND = {
	goal: srcGoalSchema,
	intent: srcIntentSchema,
	fact: srcFactSchema,
	finding: srcFindingSchema,
	asset: srcAssetSchema,
	coverage: srcCoverageSchema,
	research: srcResearchSchema,
	checkpoint: srcCheckpointSchema,
	observation: srcObservationSchema,
	userTodo: srcUserTodoSchema,
	approval: srcPendingApprovalSchema
};
const TABLE_OF_ID_KIND = {
	goal: "goals",
	intent: "intents",
	fact: "facts",
	finding: "findings",
	asset: "assets",
	coverage: "coverage",
	research: "research",
	checkpoint: "checkpoints",
	observation: "observations",
	userTodo: "user_todos",
	approval: "pending_approvals",
	testAccount: "test_accounts",
	domainNote: "domain_notes",
	edge: "edges"
};
/* [local.49] 参与 legacy key 迁移（全局 id → session-scoped recordKey，一次性）的表名单——仅 migrateLegacyKeys 使用。
   goals/domain_notes 不在名单：两表创建时已用 scoped key 格式、从未有过 legacy 行（与「是否跨会话」无关——
   domain_notes 按 target 跨会话共享、goal 挂 engagement 是刻意设计，勿误读此名单为「会话内表」）。 */
const LEGACY_KEY_MIGRATION_TABLES = [
	"intents",
	"facts",
	"findings",
	"assets",
	"coverage",
	"research",
	"checkpoints",
	"observations",
	"user_todos",
	"pending_approvals",
	"test_accounts",
	"infra",
	"edges"
];
/** Physical key for a session-local graph node or edge. */
function recordKey(sessionId, id) {
	return `${sessionId}:${id}`;
}
/** Copy and freeze one record before it crosses the service boundary. */
/** [local.15/54] Strip `undefined` (deep) before freezing: spreading `{ ...input }` where input carries
 * explicit `undefined` optional fields (e.g. `assetId: void 0` from src_finalize_engagement) otherwise
 * leaves those keys on the in-memory record. Disk JSON drops them on serialize, but the live table rows
 * keep the `undefined` values and every later view()/src_state/src_graph output then fails the
 * lossless-JSON tool boundary with "value is not lossless JSON". [local.54] 深层同样剥离：嵌套对象/数组
 * 里的显式 undefined（如 finding 的 affectedAssetId: void 0）也会让投影输出非 lossless，递归处理。 */
function snapshot(value) {
	const strip = (input) => {
		if (Array.isArray(input)) return input.map((item) => item !== null && typeof item === "object" ? strip(item) : item);
		if (input === null || typeof input !== "object") return input;
		const copy = {};
		for (const key of Object.keys(input)) {
			const item = input[key];
			if (item === void 0) continue;
			copy[key] = item !== null && typeof item === "object" ? strip(item) : item;
		}
		return copy;
	};
	return Object.freeze(strip(value));
}

/** Test-only escape hatch: drop the shared open cache so a fresh harness adopts its own MemoryDomain. */
function __resetSharedDomainOpensForTests() {
	sharedDomainOpens.clear();
}
/** Shared open promises keyed by domain name, so a second `providerName` (`srcDomainSpec`). */
const sharedDomainOpens = /* @__PURE__ */ new Map();
/**
* Owning handle for the lazily opened src domain. Not a Cordis service: it
* is a private helper owned by the plugin `apply` fiber and disposed with it.
*/
//#region src/serve.ts
/** [local.16] Live POC-hosting servers keyed by session; closed on stop tool, TTL, or plugin dispose. */
const liveProofServers = new Map();
function lanIPv4() {
	for (const list of Object.values(nodeOs.networkInterfaces())) {
		for (const entry of list ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return "127.0.0.1";
}
/** Close one server (idempotent) and resolve its captured access log. */
async function closeProofServer(sessionId, serveId) {
	const entry = liveProofServers.get(serveId);
	if (entry === void 0 || entry.sessionId !== sessionId) return void 0;
	liveProofServers.delete(serveId);
	if (entry.timer !== void 0) clearTimeout(entry.timer);
	await new Promise((resolve) => entry.server.close(() => resolve()));
	return { ...entry.meta, hits: entry.hits };
}
/** Stop every live server regardless of session (plugin dispose). */
async function closeProofServersOfAll() {
	const stopped = [];
	for (const [serveId, entry] of [...liveProofServers]) {
		const meta = await closeProofServer(entry.sessionId, serveId).catch(() => void 0);
		if (meta !== void 0) stopped.push(meta);
	}
	return stopped;
}
/** Stop every live server owned by one session or by its delegated children (goal reset / dispose). */
async function closeProofServersOfSession(sessionId) {
	const stopped = [];
	for (const [serveId, entry] of [...liveProofServers]) {
		if (entry.sessionId !== sessionId && entry.parentSessionId !== sessionId) continue;
		const meta = await closeProofServer(entry.sessionId, serveId);
		if (meta !== void 0) stopped.push(meta);
	}
	return stopped;
}
//#endregion

//#endregion
//#region src/tools.ts
/**
* Drive the live parent projection from a delegated write. The durable graph
* lives in storage, while the Web client consumes the session projection;
* regular tool calls are the shared, known event vocabulary that updates both
* the projection and history replay without introducing a custom session event.
*/
/* [local.49] 合成投影事件白名单：所有经 appendSessionToolEvent 直写会话历史的事件名。
   每个名字必须在 applySrcEvent 有对应 fold case——无 fold 的合成事件会让投影与 store 永久漂移，
   缺唯一 callId 的裸写会炸会话历史加载（local.26 无 callId 撞 key、local.46 直写漏投影两次教训的制度化闸门）。
   新增合成事件三步：① 在此登记 → ② applySrcEvent 加 fold case → ③ 只经 appendSessionToolEvent 发出（禁止裸 session.append）。 */
const SYNTHETIC_PROJECTION_EVENTS = Object.freeze(new Set([
	"src_add_asset",
	"src_add_fact",
	"src_add_finding",
	"src_auth_budget",
	"src_checkpoint",
	"src_domain_notes_snapshot",
	"src_record_coverage",
	"src_record_observation",
	"src_record_pending_approval",
	"src_reject_finding",
	"src_resolve_approval",
	"src_set_infra",
	"src_update_finding",
	/* [local.61] 数据编排触发器：系统侧自动挂用户待办（mini-program 资产→开小程序前置待办）。 */
	"src_user_todo"
]));

function appendSessionToolEvent(parent, name, args) {
	if (!SYNTHETIC_PROJECTION_EVENTS.has(name)) throw new Error(`appendSessionToolEvent: "${name}" 未登记 SYNTHETIC_PROJECTION_EVENTS 白名单——合成投影事件必须先登记名单并确保 applySrcEvent 有对应 fold case`);
	if (parent === void 0 || typeof parent.append !== "function") return;
	parent.append("tool/call", {
		turn: 0,
		step: nextSubmissionProjectionStep(),
		callId: `src-submit-${randomUUID()}`,
		name,
		arguments: JSON.stringify(args)
	});
}
/** Drive the projection for one observation row written directly to storage. */
function appendObservationProjection(exec, intentId, observation) {
	if (exec.agent === void 0) return;
	appendSessionToolEvent(exec.agent.session, "src_record_observation", { intentId, ...observation });
}
/**
* Drive the live parent projection from a delegated write. The durable graph
* lives in storage, while the Web client consumes the session projection;
* regular tool calls are the shared, known event vocabulary that updates both
* the projection and history replay without introducing a custom session event.
*/
function appendSubmissionProjection(parent, intentId, facts, assets, findings, checkpoint, decision) {
	// Projection replay applies the same semantic deduplication as the store.
	// The parent session remains the source of truth if a duplicate checkpoint arrives.
	// [local.49] 重放统一走 appendSessionToolEvent（白名单断言 + 唯一 callId），删除此处的裸 append 重复实现。
	for (const fact of facts) appendSessionToolEvent(parent, "src_add_fact", { ...fact, intentId });
	for (const asset of assets) appendSessionToolEvent(parent, "src_add_asset", { ...asset });
	for (const finding of findings) appendSessionToolEvent(parent, "src_add_finding", { ...finding, intentId });
	appendSessionToolEvent(parent, "src_checkpoint", { intentId, ...checkpoint, decision: decision ?? "" });
}
/** Register all `src_*` tools on the caller's tool registry. */

const SrcStore = createSrcStore({ srcDomainSpec, sharedDomainOpens, LEGACY_KEY_MIGRATION_TABLES, recordKey, TABLE_OF_ID_KIND, snapshot, SCHEMA_OF_KIND, closeProofServersOfSession, assetGrantHosts, SEVERITIES, SRC_INFRA_DEFAULTS, SRC_INFRA_KEYS, SRC_AUTH_REQUEST_BUDGET, routePlaybook, credentialVaultDir, writeCredential, readCredential, credentialHeaders, redactCredential, redactText, stripCredentialHeaders });
const registerSrcTools = createRegisterSrcTools({
	defineTool, SessionId, dns, fsPromises, fsSync, nodePath, nodeOs, fileURLToPath, pathToFileURL, childProcessSpawn, httpCreateServer,
	assetGrantHosts, assetGrantHostsFor, hostCoveredByAssets, parseGoalHost, isPlausiblePublicHost, str, dshHomeOf, readCapsManifest, capsWiredIds,
	credentialVaultDir, writeCredential, readCredential, credentialHeaders, redactCredential, redactText, stripCredentialHeaders,
	addApprovalLock, removeApprovalLock,
	capabilityCommand, runCapabilityProcess, runChildWithTimeout, SRC_INFRA_KEYS, SRC_INFRA_LABELS, isProxyUrl, makeHttpFetch, htmlToText, isLegacyRenegotiationError, legacyHttpsRequest,
	SRC_AUTH_REQUEST_BUDGET, closeProofServer, liveProofServers, lanIPv4, recoveryAttempts, sessionIdOf, parentSessionIdOf, visibleSessionIds,
	resolveEngagementSession, requiredString, concreteIntentId, optionalString, submissionList, stringList, enumValue, stableBatchKey,
	confidenceValue, titledCard, FACT_KINDS, SEVERITIES, ASSET_TYPES, BYPASS_CATEGORIES, BYPASS_METHODS, buildGraph, buildReport,
	classifyHttpRequest, lessonsDataDir, listAllLessons, lessonIndexLines, readLessonFile, sessionLessons, lessonsForContext, lessonHintLines, appendObservationProjection,
	routePlaybook, credentialVaultDir, writeCredential, readCredential, credentialHeaders, redactCredential, redactText, stripCredentialHeaders,
	commitSyntheticMutation, appendSyntheticEvents, syntheticEvent, appendSessionToolEvent, appendSubmissionProjection
});
const name = "src";
/** Services required before the plugin can register tools and open the domain. */
const inject = [
	"tools",
	"storageDomain",
	"sessions",
	"subagents"
];
/**
* Activate the penetration mode on a context carrying the tool registry and the
* storage-domain facility. The domain is opened lazily on first tool use and
* closed when the plugin fiber is disposed.
* @param ctx - registrant context.
*/
/** Usage line for /src-todo feedback errors. */
const TODO_FEEDBACK_USAGE = "用法：/src-todo <todoId> <done|abandoned|pending> [备注]，如 /src-todo userTodo-2 done 已用 Burp 抓包";
/**
* Parse one /src-todo feedback line. The Web panel sends fixed-shape lines,
* but the command is also typeable, so both id and status are validated.
* @param rawInput - exact text after the command name.
* @returns parsed fields or an `ok:false` error message.
*/
function parseTodoFeedback(rawInput) {
	const parts = String(rawInput ?? "").trim().split(/\s+/).filter((part) => part !== "");
	if (parts.length < 2) return { ok: false, error: "缺少参数。" + TODO_FEEDBACK_USAGE };
	const [userTodoId, status, ...noteParts] = parts;
	if (!/^(?:userTodo-|todo-)\d+$/.test(userTodoId)) return { ok: false, error: `待办 id "${userTodoId}" 不合法。` + TODO_FEEDBACK_USAGE };
	if (!["pending", "done", "abandoned"].includes(status)) return { ok: false, error: `状态 "${status}" 必须是 pending/done/abandoned。` + TODO_FEEDBACK_USAGE };
	return { ok: true, userTodoId, status, note: noteParts.join(" ") };
}
/**
* Register the human commands backing the Web panel:
* - /src-todo relays todo feedback to the agent (followup), because the note
*   must reach the model anyway.
* - [local.11] /src-infra writes the setting DIRECTLY via SrcStore (no agent
*   round-trip) and appends a synthetic tool/call event so the projection and
*   the timeline reflect the change immediately.
* - [local.11] /src-proxy-test probes the configured proxy host-side with one
*   HTTP request through it; no agent involvement.
* - [local.11] /src-burp-test first TCP-probes burpMcpPort; only when the port
*   answers does it wake the agent for a deep MCP-level check.
* @param ctx - registrant context carrying the host commands service.
* @param store - the session's SrcStore (for direct infra writes).
*/
function registerTodoCommand(ctx, store) {
	ctx.commands.register({
		name: "src-todo",
		description: "SRC 待办反馈：把 Web 面板勾选的用户待办状态转达给 agent（等价于在对话里告知待办已完成/放弃）。",
		input: { hint: "<todoId> <done|abandoned|pending> [备注]" },
		handler: (invocation) => {
			const parsed = parseTodoFeedback(invocation.rawInput);
			if (!parsed.ok) return { kind: "error", text: parsed.error };
			const label = parsed.status === "done" ? "已完成" : parsed.status === "abandoned" ? "已放弃" : "重新打开";
			const noteSuffix = parsed.note !== "" ? `，备注：${parsed.note}` : "";
			invocation.agent.followup(createUserMessage({
				content: [{ type: "text", text: `【SRC 待办反馈】用户在 Web 面板将用户待办 ${parsed.userTodoId} 标记为「${label}」${noteSuffix}。请立即调用 src_user_todo 工具同步该状态：userTodoId="${parsed.userTodoId}"、status="${parsed.status}"${parsed.note !== "" ? `、note=${JSON.stringify(parsed.note)}` : ""}；若被该待办阻塞的工作现在可以继续，请继续推进并简要确认。` }],
				source: { kind: "user" }
			}));
			return { kind: "success", text: `已把「${parsed.userTodoId} → ${label}」转达给 agent，处理结果会出现在对话里。` };
		}
	});
	/* [local.26] /src-reject：Web 面板「漏洞」tab 的打回按钮后端。复用 /src-todo 的 followup 模式——
	   不直接写存储，而是发一条结构化用户消息指示 agent 调 src_reject_finding：这样存储更新 + agent 知道
	   打回理由并据此行动（补 attackChain / 产 PoC）。findingId 与 reason 均校验。
	   Web 面板发送固定形态行，但命令也可手打，故两端都校验。 */
	const REJECT_USAGE = "用法：/src-reject <findingId> <打回理由>，如 /src-reject finding-2 危害链不闭合，请补 attackChain";
	ctx.commands.register({
		name: "src-reject",
		description: "SRC 漏洞打回：把 Web 面板「漏洞」页的打回操作转达给 agent（置 finding 为 rejected + 记理由，驱动 agent 补强）。",
		input: { hint: "<findingId> <打回理由>" },
		handler: (invocation) => {
			const raw = String(invocation.rawInput ?? "").trim();
			const sep = raw.indexOf(" ");
			if (sep < 0) return { kind: "error", text: "缺少打回理由。" + REJECT_USAGE };
			const findingId = raw.slice(0, sep).trim();
			const reason = raw.slice(sep + 1).trim();
			if (!/^finding-\d+$/.test(findingId)) return { kind: "error", text: `finding id "${findingId}" 不合法。` + REJECT_USAGE };
			if (reason === "") return { kind: "error", text: "打回理由不能为空。" + REJECT_USAGE };
			if (reason.length > 500) return { kind: "error", text: `打回理由过长（${reason.length} 字，上限 500）。请精简后重试。` };
			invocation.agent.followup(createUserMessage({
				content: [{ type: "text", text: `【SRC 漏洞打回】用户在 Web 面板将 finding ${findingId} 打回。请立即调用 src_reject_finding 工具：findingId="${findingId}"、reason=${JSON.stringify(reason)}。打回不是否定，是要求补强——请按理由行动后用 src_update_finding 补 attackChain（从发现→利用前提→利用过程→实际损失→受害者影响的闭合叙事）或产出一键 PoC 脚本；确为新链再说明与打回那条的差异，不要原样重提（准入闸会拦住相似项二次提交）。` }],
				source: { kind: "user" }
			}));
			return { kind: "success", text: `已把「${findingId} → 打回」转达给 agent，处理结果会出现在对话里。` };
		}
	});
	/* [local.31] /src-approve：Web 面板「待办」tab 审批区的批准/拒绝按钮后端。复用 followup 模式——不直接写存储，
	   而是发结构化用户消息指示 agent 调 src_resolve_approval：批准则发出原请求并据响应推进，拒绝则转其他方向。 */
	const APPROVAL_USAGE = "用法：/src-approve <approvalId> <allow|reject> [备注]，如 /src-approve approval-1 allow 这是可信测试账号自己资源";
	ctx.commands.register({
		name: "src-approve",
		description: "SRC 高危审批：把 Web 面板「待办」tab 审批区的批准/拒绝操作转达给 agent（批准则发出原请求，拒绝则丢弃转其他方向）。",
		input: { hint: "<approvalId> <allow|reject> [备注]" },
		handler: async (invocation) => {
			const parts = String(invocation.rawInput ?? "").trim().split(/\s+/).filter((p) => p !== "");
			if (parts.length < 2) return { kind: "error", text: "缺少参数。" + APPROVAL_USAGE };
			const [approvalId, action, ...noteParts] = parts;
			if (!/^approval-\d+$/.test(approvalId)) return { kind: "error", text: `审批 id "${approvalId}" 不合法。` + APPROVAL_USAGE };
			if (action !== "allow" && action !== "reject") return { kind: "error", text: `操作 "${action}" 必须是 allow 或 reject。` + APPROVAL_USAGE };
			const note = noteParts.join(" ");
			/* [local.44] 资产归属确认行（method=ASSET）：不走「转达 agent 重放」路径——授权决定直接确定性落库
			 *  （allow→整域登记 confirmed 资产，reject→excluded），再发信息性 followup 告知 agent 重试或放弃。 */
			const assetRow = await store.getPendingApproval(invocation.agent.session.id, approvalId);
			if (assetRow !== void 0 && assetRow.method === "ASSET") {
				if (assetRow.status !== "pending") return { kind: "error", text: `归属确认 ${approvalId} 已处理过（${assetRow.status === "approved" ? "已确认" : "已否决"}），不可重复操作。` };
				const resolved = await commitSyntheticMutation(invocation.agent.session, async () => {
					const next = await store.resolvePendingApproval(invocation.agent.session.id, approvalId, action, note, void 0, void 0);
					return {
						value: next,
						events: [
							syntheticEvent("src_resolve_approval", { id: approvalId, action, note, responseStatus: 0 }),
							...(next.asset === void 0 ? [] : [syntheticEvent("src_add_asset", { type: next.asset.type, value: next.asset.value, meta: next.asset.meta, source: next.asset.source, method: next.asset.method, confidence: next.asset.confidence, status: next.asset.status })])
						]
					};
				}, appendSessionToolEvent);
				const confirmed = action === "allow";
				invocation.agent.followup(createUserMessage({
					content: [{ type: "text", text: confirmed
						? `【资产归属确认】用户确认 ${assetRow.url} 属于目标组织，已登记为 confirmed 资产（整个注册域含主域与全部子域现已进入授权清单）。${note !== "" ? `备注：${note}。` : ""}此前因该域被闸拒绝的方向现在可以重试推进。`
						: `【资产归属确认】用户否决 ${assetRow.url}（已登记 excluded，整域排除）。放弃该方向，不要再探测该域下任何 host，也不要再发起同域确认。${note !== "" ? `备注：${note}。` : ""}` }],
					source: { kind: "user" }
				}));
				return { kind: "success", text: `已${confirmed ? "确认" : "否决"} ${assetRow.url} 的归属（${resolved.assetId !== void 0 ? `资产 ${resolved.assetId} 已${confirmed ? "纳入" : "排除"}授权清单` : "资产已登记"}），并已通知 agent 重试或放弃。` };
			}
			const label = action === "allow" ? "批准" : "拒绝";
			const noteSuffix = note !== "" ? `，备注：${note}` : "";
			invocation.agent.followup(createUserMessage({
				content: [{ type: "text", text: `【SRC 高危审批】用户在 Web 面板将待审请求 ${approvalId} 标记为「${label}」${noteSuffix}。请立即调用 src_resolve_approval 工具：id="${approvalId}"、action="${action}"${note !== "" ? `、note=${JSON.stringify(note)}` : ""}。${action === "allow" ? "批准则发出原请求并据响应推进——成功则记录证据/产 finding；失败则转其他方向。" : "拒绝则丢弃该请求，转其他方向，不要重发同请求。"}` }],
				source: { kind: "user" }
			}));
			return { kind: "success", text: `已把「${approvalId} → ${label}」转达给 agent，处理结果会出现在对话里。` };
		}
	});
	ctx.commands.register({
		name: "src-infra",
		description: "基础设施设置：直接保存 Web 面板「基础设施」页的修改到存储（立即生效，不打扰 agent）。",
		input: { hint: "<key> <value|->（value 为 - 表示恢复默认）" },
		handler: async (invocation) => {
			const raw = String(invocation.rawInput ?? "").trim();
			const sep = raw.indexOf(" ");
			const key = sep < 0 ? raw : raw.slice(0, sep);
			let value = sep < 0 ? "" : raw.slice(sep + 1).trim();
			if (value === "-" || value === "－" || value === "清空") value = "";
			if (!SRC_INFRA_KEYS.includes(key)) return { kind: "error", text: `未知设置项 "${key}"。可用：${SRC_INFRA_KEYS.join(", ")}` };
			try {
				/* [local.54] testAccount 凭据不再落明文：面板输入直接入凭证库，infra 与合成事件只存 credentialRef。 */
				let storedValue = value;
				let vaultNote = "";
				if (key === "testAccount" && value !== "") {
					const written = await writeCredential({ dshHome: dshHomeOf(), sessionId: invocation.agent.session.id, label: "legacy-infra", credential: value, note: "面板基础设施 testAccount 输入" });
					storedValue = written.ref;
					vaultNote = "（凭据已入本地凭证库，面板与事件只存引用）";
				}
				const record = await commitSyntheticMutation(invocation.agent.session, async () => {
					const next = await store.setInfra(invocation.agent.session.id, key, storedValue);
					return { value: next, events: [syntheticEvent("src_set_infra", { key, value: storedValue })] };
				}, appendSessionToolEvent);
				const cleared = value === "";
				return { kind: "success", text: `已${cleared ? "清空并恢复默认" : "保存"} ${key}${cleared ? `（当前生效值：${record.value === "" ? "空" : record.value}）` : `=${record.value.length > 44 ? record.value.slice(0, 44) + "…" : record.value}${vaultNote}`}，立即生效；agent 下次执行相关测试时会通过 src_get_infra 读取最新值。` };
			} catch (error) {
				return { kind: "error", text: `保存失败：${error?.message ?? String(error)}` };
			}
		}
	});
	ctx.commands.register({
		name: "src-infra-copy",
		description: "一键沿用上次会话的基础设施：把最近一个配置过基础设施的其他会话的覆盖项复制到本会话（立即生效，不打扰 agent）。",
		input: { hint: "（无需参数）" },
		handler: async (invocation) => {
			const sessionId = invocation.agent.session.id;
			try {
				const source = await store.latestOtherInfra(sessionId);
				if (source === void 0) return { kind: "success", text: "没有可复用的基础设施：其他会话还没有保存过任何设置。请先在需要的会话里保存一次，或直接在本页填写。" };
				const keys = Object.keys(source.overrides);
				if (keys.length === 0) return { kind: "success", text: "最近配置过的会话没有留下有效设置项，无可复用内容。" };
				await commitSyntheticMutation(invocation.agent.session, async () => {
					for (const key of keys) await store.setInfra(sessionId, key, source.overrides[key]);
					return { value: void 0, events: keys.map((key) => syntheticEvent("src_set_infra", { key, value: source.overrides[key] })) };
				}, appendSessionToolEvent);
				const summary = keys.map((key) => `${key}=${source.overrides[key]}`).join("，");
				return { kind: "success", text: `已沿用上次会话的基础设施（${keys.length} 项）：${summary}。立即生效；agent 下次执行相关测试时会通过 src_get_infra 读取最新值。` };
			} catch (error) {
				return { kind: "error", text: `沿用失败：${error?.message ?? String(error)}` };
			}
		}
	});
	ctx.commands.register({
		name: "src-proxy-test",
		description: "HTTP 代理测活：服务端直接经配置的代理请求探针地址，不经过 agent。",
		input: { hint: "（无需参数）" },
		handler: async (invocation) => {
			const infra = await store.getInfra(invocation.agent.session.id);
			return { kind: "success", text: await probeProxy(infra) };
		}
	});
	ctx.commands.register({
		name: "src-burp-test",
		description: "Burp MCP 连通性测试：先 TCP 探测 Burp 端口，再做 SSE 握手验证扩展端点可达，然后请 agent 经自愈桥用 get_proxy_http_history_regex 做一次真实工具调用端到端验证。",
		input: { hint: "（无需参数）" },
		handler: async (invocation) => {
			const sessionId = invocation.agent.session.id;
			const infra = await store.getInfra(sessionId);
			const port = Number.parseInt(String(infra.burpMcpPort ?? "9876"), 10) || 9876;
			let elapsed;
			try {
				elapsed = await tcpProbe("127.0.0.1", port);
			} catch (error) {
				return { kind: "error", text: `①TCP 探测失败：127.0.0.1:${port} 连接不上（${error?.message ?? String(error)}）。最常见原因：① Burp Pro 未安装 "MCP Server" 扩展或装了没点 Start；② 监听端口不是 ${port}（可在扩展设置里改，或修改本页「Burp MCP 端口」后重新测试）。无需重启 dsh web。` };
			}
			try {
				const sse = await probeBurpSse("127.0.0.1", port);
				invocation.agent.followup(createUserMessage({
					content: [{ type: "text", text: `【Burp MCP 连通性测试】服务端探测全部通过：①TCP 127.0.0.1:${port} 可达（${elapsed}ms）②MCP SSE 端点 http://127.0.0.1:${port}${sse.path} 握手成功（HTTP 200 text/event-stream，${sse.elapsed}ms${sse.preview !== "" ? `，首包：${sse.preview}` : ""}）。请立即调用 mcp__burp__get_proxy_http_history_regex（regex 填本会话 goal 的 host，count 取 5，offset 0）做端到端验证并如实汇报：成功则报告拉到的目标流量条数；若工具表里只有 burp_status 哨兵或调用报桥降级，说明自愈桥在重连窗口，报告「Burp MCP 暂不可用，稍后重试」即可——这不是 Burp 无流量；其他失败给出错误原文与排查建议（dsh web 是否在自愈桥更新后重启过、Burp 扩展是否 Start）。全程中文，不要臆测结果，禁止用不带 regex 的 history 拉取结果断言流量情况。` }],
					source: { kind: "user" }
				}));
				return { kind: "success", text: `①端口 127.0.0.1:${port} 可达（${elapsed}ms）②SSE 握手通过（HTTP 200，${sse.elapsed}ms）。注意：该直探只证明扩展端点活着——完整链路还要经 dsh 的自愈桥（burp-mcp-bridge），已请 agent 用 get_proxy_http_history_regex 做真实调用端到端验证，结果会出现在对话里；若 agent 报「桥降级/burp_status 哨兵」，等自愈桥重连后重试即可，无需重启 dsh web。` };
			} catch (error) {
				return { kind: "error", text: `①TCP 通过（127.0.0.1:${port} 监听中，${elapsed}ms），但 ②SSE 握手失败（已尝试 / 与 /sse、http 与 https 四种组合）：${error?.message ?? String(error)}。排查建议：确认扩展是 PortSwigger "MCP Server" 且已点 Start；若扩展改过路径或仅支持 streamable-http，请在备注里告知实际端点形式。无需重启 dsh web。` };
			}
		}
	});
}
function apply(ctx) {
	const store = new SrcStore(ctx);
	ctx.effect(() => async () => {
		/* [local.16] Shut down every live POC server on plugin dispose (per-session stops happen at goal reset / src_stop_serve). */
		await closeProofServersOfAll().catch(() => {});
		await store.dispose();
	}, "src.domainClose");
	registerSrcTools(ctx, store);
	ctx.inject(["commands"], (commandCtx) => {
		registerTodoCommand(commandCtx, store);
	});
	ctx.inject(["sessionProjections"], (projectionCtx) => {
		projectionCtx.sessionProjections.register({
			key: "src",
			schema: srcProjectionSchema,
			init: () => srcInitialState,
			apply: applySrcEvent,
			view: viewSrcState,
			/* [local.58] 10→11：fold 锚点自愈上线，宿主按新版本号重算全部存量会话投影（local.57 期间 intents/facts/findings 被丢的会话历史加载后自动恢复）。 */
			/* [local.60] 11→12：投影容量分级上线（finding/intent 不再被 200 上限裁剪），宿主按新版本号重算全部
			   存量会话投影——9864adca 等长会话被裁掉的 intent/finding 重放后自动回到面板。 */
			/* [local.66] 12→13：双锚点同传 fold 自愈上线（hackone 实测模型系统性双传、旧 fold 丢弃），宿主按新版本号重算全部存量会话投影。 */
			stateVersion: 13
		});
	});
	ctx.inject(["systemPrompt"], (scope) => {
		scope.systemPrompt.section({
			name: "src:protocol",
			order: 50,
			text: () => SRC_INSTRUCTIONS
		});
	});
}
//#endregion
export { __resetSharedDomainOpensForTests, appendSessionToolEvent, apply, inject, name, applySrcEvent, parseTodoFeedback, srcProjectionSchema, srcAssetSchema, srcAssetTypeSchema, srcDomainSpec, srcEdgeKindSchema, srcEdgeSchema, srcFactKindSchema, srcFactSchema, srcFindingSchema, srcGoalSchema, srcIntentSchema, srcSeveritySchema, srcInitialState, viewSrcState, classifyHttpRequest, SYNTHETIC_PROJECTION_EVENTS, isLegacyRenegotiationError, legacyHttpsRequest, makeHttpFetch, proxiedFetch };
