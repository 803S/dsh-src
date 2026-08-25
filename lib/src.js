import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
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
import { fileURLToPath } from "node:url";
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
  指挥官可调（面板修改不经 agent，直接落库）。testAccount 是对照账号凭据（user:pass 或
  用户名）：优先脚本登录构造低权会话做 A/B 对照，无法自动登录时创建用户待办请用户提供
  登录态，禁止臆造凭据。testPhone 可含多个号码（逗号分隔），按需选用。
  代理策略：proxyUrl 仅对 google/github/shodan 等无法直连的境外站点生效（工具层自动判断），
  国内目标一律直连；不要为了让国内目标走代理而反复修改 proxyUrl，也不要因个别请求失败就全局换代理——
  先看目标是否本就该直连，再用 curl --max-time 有界重试。
【外部能力路由】任务卡在客户端/逆向场景时调 src_list_capabilities 查可用外部能力：命中已接线
  能力（工具面出现 mcp__<id>__*）就直接使用，产出必须经 src_record_observation(tool='<id>')
  固化才算数；清单里启用了但未接线的提示用户重跑 caps-sync 并重启 dsh；完全没覆盖的场景不要
  硬猜 API——如实告知用户该类任务超出当前工具面并建议参考 docs/CAPABILITIES.md 接入对应能力。
【intent】先调用 src_state 检查既有 intent；同一目标、范围和验证方法的意图只能保留一个，已有等价
  intent（含进行中、已完成或 blocked）不得再次创建或委派。默认按以下阶段拆分并行或串行 intent：
  1) 被动组织/域名/证书/DNS/ASN/公开页面侦察；2) 低影响主机与 Web 指纹、robots/sitemap、登录边界、API 网关、OpenAPI/GraphQL、JS 接口线索；3) 认证、授权、会话和业务流程假设；4) 注入、XSS、SSRF、文件上传、越权、敏感信息、配置暴露、供应链和业务逻辑验证；5) 独立复核、影响确认和报告整理。仅当目标、范围或验证方法实质不同，才调用 src_add_intent 并委派执行子 agent。可同时创建多个彼此独立且不重复的 intent，并在同一回合分别调用多个 subagent 或 subagent_fork 并发执行；每个委派必须使用它自己的父 intentId。
  委派前必须调用 src_add_intent，并把该调用刚返回的实际 id 原样写入每个子 agent 提示中的父 intentId。
  禁止传入或保留 delegation-intent-id、intent-id、<intentId> 等占位符；例如返回 id 为 intent-1 时，
  委派必须明确写“父 intentId: intent-1”。委派内容还必须包含：目标、授权范围、待验证任务、相关事实摘要、
  已知资产及可引用的资产 ID。
  不要把完整日志喂给子 agent。全部委派发起后立即结束当前回合：不要使用 Start-Sleep、轮询、等待工具或
  shell 命令来等候。子 agent 的完成事件和摘要会自动注入本会话；收到后再根据新增记录继续推进。
  【委派工具一致性】委派 prompt 里点名的 src_* 工具必须是目标子 agent 实际可用的：执行类（src_test_bypass/
  src_test_credential/src_scan_surface 等）已对子代理开放（沿父链解析 goal）；但 src_record_research 对
  recon/audit 子代理是 deny 的——不要在它们的 prompt 里要求调用。若某回合结束后台子代理迟迟无报告，
  下一步用 list_agents 检查状态，必要时用 src_recover_child 唤醒续跑（子代理有 checkpoint 可恢复）。
【侦察策略】先用 src_scan_surface 做单次预检，识别 WAF/CDN/挑战页、认证边界和限速响应。遇到 WAF 拦截页/403/challenge：这不是停止信号，而是“需先绕过才能继续”的信号。对防护本身做有界绕过试探（换 UA、降速、分块、方法/编码变换，低 RPS + 有限请求预算）；绕不过才返回 requiresDecision 交指挥官决策。对特定载荷的过滤名单（如 <img onerror> 被拦但 <b> 通）做向量枚举（未拦截标签/编码/解析差异）——这是 bypass-filter-list 研究，属 SRC 高价值漏洞范畴，不算“绕过 WAF”。429 限速先退避降速重试，持续 429 才停。禁止的是无界爆破、拒绝服务、千万级字典、隐蔽大规模扫描；撞到 WAF/403 必须先绕过防护才能继续暴力/遍历/构造载荷类动作，绕不过则停。优先使用被动来源（含 Google dorks 信息收集：泄露凭证/敏感文件/目录结构/索引页/历史缓存/云资产）、页面链接、JS 静态提取、证书透明日志和 DNS 线索，再决定是否主动测绘。
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
【覆盖率】每个重要资产都应为侦察、认证/API、漏洞类别和复核阶段调用 src_record_coverage，明确 planned/running/completed/blocked/not-applicable；遇到 WAF、限速、缺少账号、环境不可用或授权排除时必须写 limitation，不得把未测试当作无漏洞。
【研究矩阵】每个漏洞假设都先调用 src_record_research，记录 category、hypothesis、preconditions 和证据，按 hypothesis→testing→reproduced→verified 或 false-positive/blocked 推进；只有 verified 且 finding 字段完整时才进入最终报告。
【bypass 研究】broken-access-control/bypass 类是 SRC 高分漏洞，必须作为正式研究类别而不是一律当作违规：authentication-bypass、authorization-bypass、idor-bola、tenant-isolation、workflow-bypass、method-bypass、path-normalization、parser-discrepancy、rate-limit-bypass、cache-auth-boundary、waf-rule-gap、oauth-flow-bypass。流程是：先创建 intent 和 src_record_research 假设，再由复核子 agent 用 src_test_bypass 做有界 baseline→variant 差分验证（提供 baseline、少量变体、researchId 与授权上下文）；src_test_bypass 只在目标 host/subdomain 内、仅允许 GET/HEAD/OPTIONS 和显式 allowBody 的 POST、低 RPS；遇 WAF/403/429/challenge 时先做有界绕过试探（含过滓名单向量枚举：替换标签/编码/方法变体是正常 variant），绕不过才返回 requiresDecision，也不自动创建 finding。只有出现可复现的权限/授权边界差分、且附上授权影响证明和独立复核，才把 research 推进到 verified；仅凭 403→200 或改 header 得到 200 不算漏洞，误报防护与影响证明是必选项。禁止代理池轮换、无限重试和隐蔽大规模扫描。
【框架与 nDay】识别出开源框架/知名组件指纹（如 VAppServer、VSB 站群、致远 OA、Sea.js、常见 CMS）后，立即创建框架研究 intent：①查公开 CVE/历史漏洞（NVD/CNNVD/GitHub advisory/exploit-db，用 web 搜索）匹配版本范围，把“框架+版本+已知漏洞”落 research（category: nday）；②开源框架直接拉源码（GitHub/Gitee）做定向白盒审计（category: framework-audit），针对目标定制点（如特定 jsp/DWR 接口族）找注入/越权/反序列化。nDay 验证做最小化 PoC 确认（不利用、不深入），命中即 high+ finding。
【认证策略】发现大部分业务需登录时按决策树推进：①先用 Google dorks 被动找泄露凭证（GitHub filename:.env "<domain>"、"<domain>" password、Gitee/文库/网盘，SRC 认可白帽凭此登录测试；已知凭据复现不受爆破配额约束）；②找不到则用 src_user_todo(kind=auth-session) 异步引导用户完成 Burp 抓包三步（见【用户待办】），绝不打断任务；用户完成后 mcp__burp__get_proxy_http_history(count,offset) 拉包，src_import_traffic 完整保留认证头入库（auth-profile fact），子 agent 复用凭据构造请求测登录态越权面、判断凭据权限范围（如普通用户 token 能否读到他人数据=横向越权实锤）。安全红线：只测凭据对应账户自身的越权面，不横向；只对授权域名跑 dork。
【多账号矩阵】拿到第二及以上账号后用 src_add_test_account 逐条登记（label 主通道，直接粘完整 Cookie/Authorization；同一会话 label 去重覆盖）。交叉矩阵动作：A 的资源 ID × B 的会话、普通会话 × 管理端端点清单。双探规则：IDOR/越权类需两组不同 id 对确认系统性才提交，单组数据差可能是业务允许的差异而非漏洞。认证态流量走独立更低预算（src_test_bypass 会计数带 Authorization/Cookie 的请求，触顶返回 budgetExhausted 软信号——剩余矩阵格转 src_user_todo 而非硬报错；认证流量稀缺是防锁号与防风控画像）；401 连发（src_test_bypass 返回 sessionLikelyExpired）转「重新登录」待办模板（kind=auth-session，写明哪个账号、用过期迹象），不要反复重放失效凭据触发风控。凭据即用即取，不批量囤积（白帽红线）。
【域笔记】每次会话把跨会话复用价值的发现沉淀进域笔记（src_record_domain_note，按目标域名全局积累，同目标+标题覆盖更新不膨胀）：①fingerprint=域指纹（技术栈/认证机制/资产布局/ID 规律）；②pitfall=坑位（某接口限流/某子域 WAF/某路径返回结构）；③falsified-summary=已否假设摘要（多个 false-positive research 汇成一句供后续会话跳过）；④baseline=基线素材（覆盖维度经验值，供第三波基线清单）。单次会话内的已否假设本身仍用 src_record_research 落盘，域笔记只记有跨会话价值的摘要。续测同目标时 src_add_goal 自动返回历史域笔记+已否假设+已确认 findings 做 briefing——开局即见，不重复钻枯井、复用已得成果。会话中途要回顾本目标历史坑位/域指纹时用 src_list_domain_notes（只读，含历史任何会话沉淀的笔记标题级清单）。【Burp MCP 工具面】环境挂有 mcp__burp__* 工具（Burp Pro「MCP Server」扩展，经自愈桥接入）时的用法：①mcp__burp__get_proxy_http_history(count,offset)/get_proxy_http_history_regex(regex,count,offset) 拉真实浏览流量（含 React module federation chunk、找回密码等静态扫不到的 API），按目标 host 过滤后喂给 src_import_traffic(mode=mcp) 统一落库——count 单次 ≤100、翻页递增 offset 拉全；②从 proxy 流量提取 Cookie/Authorization 完整构造认证画像（auth-profile fact，可直接复用）；③POC 写回 Burp 人工复核：mcp__burp__create_repeater_tab(content,targetHostname,targetPort,usesHttps,tabName?)（raw 请求要 CRLF）建 Repeater 页签，或 mcp__burp__send_http1_request/send_http2_request(content,targetHostname,targetPort,usesHttps) 直发验证。Burp 未开时这些工具不可用——走 HAR/raw 文件导入兜底。React chunk 404 类问题优先用此通道解决，不做静态反推。
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

【子 agent 故障处理】子 agent 中途失败（超时、API 424/上游错误、异常退出）不会自动重试：收到失败通知后，先调 src_state 查看该 intent 已产出的 checkpoint 与事实，判断已完成部分；剩余工作用 src_recover_child 定向唤醒（同一子代理最多四次——即使它从未提交过 checkpoint 也可以唤醒，恢复消息会送达原会话继续干；API 供应商波动、网络不稳定、限流这类基础设施故障不是子代理自身的错误，应当继续唤醒续跑而不是换人重来），唤醒失败或额度用尽再创建新 intent 重新委派；不得假装没发生、不得把失败直接当结论标 failed 了事。注意：API 上游错误（424/upstream_error）通常是暂时的供应商波动，重试往往能成功，不要因一次失败就放弃整条链路；主会话自身请求失败时也一样，下一回合从断点继续即可。子 agent 的失败结论也要以 fact 形式落图，避免重复踩坑。

【厂商规则】goal 建立后、开始验证类工作前：用 web 搜索确认厂商是否有公开 SRC/安全应急响应中心
  （搜索「<厂商名> SRC 漏洞评分规则」「<厂商> 安全应急响应中心 收录标准」等）；有则找到评分/收录规则页，
  用 src_fetch_policy 抓取正文并把要点存为 fact（category=vendor-policy，含规则 URL 与关键条款摘要：
  收录范围、定级基准、不收场景、证明材料要求）。之后每个 finding 提交前对照该规则预判有效性并在
  impact 里注明对应定级依据；厂商规则与通用定级冲突时以厂商规则为准。找不到公开规则时按通用四档执行。
  【覆盖维度声明】同一步骤输出时一并声明本目标适用的覆盖维度（基线：http-authz-surface/cors-headers/
  dom-xhr/dict-budget/multi-account-cross-authz 恒适用；信号派生：发现 wss 资产加 websocket，发现
  app/mini-program 资产加 mobile-api；厂商规则排除某类则该维度标 notApplicable）。维度清单是活文档——
  侦察中段发现新适用维度（如确认目标是多租户产品）随时补声明；finalize 会对照最终版逐项校验。
  此声明与 remainingDirections 切干净：remainingDirections=同类面内还能推进的动作；盲区维度=结构性没碰的类别。
【定级指南（对齐小米 SRC 四档）】严重=直接获取系统权限/RCE/核心数据库数据；高=敏感数据泄露/重要业务越权（如任意用户简历读取）；中=普通越权/一般信息泄露/短信轰炸/验证码爆破可利用；低=反射 XSS/一般未授权信息/轻微逻辑缺陷。提交 finding 时 severity 按此基准判定，impact 描述需注明对应平台定级依据；小程序/App 资产必须记录下载方式（应用商店 URL/二维码）作为 meta。AI 站点/智能客服/LLM 应用是正式测试对象：语义复核确认为真实 AI 面后按 lessons/ai-abuse 课程自主推进（先测越权面/key 暴露等硬通货，再测间接注入与工具滥用）；纯越狱或仅套出系统提示词不构成独立 finding，只能作为注入链的证据环节。测不了或不全面的场景（需登录态的 RAG 投毒、需浏览器人工交互的验证）一律建 src_user_todo(kind=manual-test, intentId 关联) 移交用户，不得静默跳过或直接标 blocked 了事。
【漏洞质量标准（SRC）】SRC 平台接受一切有实际危害的真实漏洞——包括信息泄露/指纹类（如版本暴露可匹配已知 CVE 定向利用），关键在如实论证危害：finding 必须写清具体利用场景与完整利用路径（攻击者视角、拿到什么、危害谁），不夸大、不虚构，severity 如实定级；只罗列信息而无任何危害论证的发现只能算 fact。定级与有效性判断必须对照厂商 SRC 规。（见【厂商规则】）——同一漏洞不同厂商认定与分档可能不同（典型：窃取 Cookie 类钓鱼场景部分厂商要求链接域名必须是厂商域名，第三方域名场景可能不收或降档）。报告停止前必须确认存在 medium 及以上、有可复现 POC（raw 包含接口地址）、impact 含具体利用场景且经独立复核 verified 的 finding。

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
			status: z.enum(["planned", "running", "completed", "blocked", "failed"]),
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
			affectedAssetId: z.union([z.string(), z.undefined()]),
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
	coverage: z.array(z.object({ id: z.string(), assetId: z.union([z.string(), z.undefined()]), phase: z.string(), category: z.string(), status: z.enum(["planned", "running", "completed", "blocked", "not-applicable"]), evidence: z.array(z.string()), limitation: z.string(), updatedAt: z.number() })),
	research: z.array(z.object({ id: z.string(), intentId: z.string(), category: z.string(), hypothesis: z.string(), preconditions: z.array(z.string()), status: z.enum(["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"]), stopReason: z.string(), evidence: z.array(z.string()), findingId: z.union([z.string(), z.undefined()]), updatedAt: z.number() })),
	checkpoints: z.array(z.object({
		id: z.string(), intentId: z.string(), childSessionId: z.string(),
		stage: z.enum(["progress", "completed", "blocked", "failed"]), summary: z.string(), decision: z.string(),
		facts: z.number(), assets: z.number(), findings: z.number(), batchKey: z.string(), createdAt: z.number()
	})),
	observations: z.array(z.object({ id: z.string(), intentId: z.string(), assetId: z.union([z.string(), z.undefined()]), method: z.string(), path: z.string(), httpStatus: z.number(), protectionSignal: z.boolean(), wafBypassed: z.boolean(), source: z.string(), decision: z.string(), respHeaders: z.string(), respBodySnippet: z.string(), createdAt: z.number() })),
	userTodos: z.array(z.object({ id: z.string(), intentId: z.union([z.string(), z.undefined()]), kind: z.string(), title: z.string(), detail: z.string(), status: z.enum(["pending", "done", "abandoned"]), note: z.string(), createdAt: z.number() })),
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
	testAccounts: [],
	domainNotes: [],
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
	"low",
	"info"
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
			else cur[k] = v.trim();
			continue;
		}
		const cont = line.match(/^      (.+)$/);
		if (cont && curKey) { cur[curKey] = `${cur[curKey]} ${cont[1].trim()}`.trim(); }
	}
	if (sawContent && !sawHeader) throw new Error("文件应以 capabilities: 开头");
	return out;
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
/** [local.23] 认证态流量独立预算（每会话）：带 Authorization/Cookie 的请求总数触顶后 src_test_bypass
 * 返回软信号（非报错），剩余矩阵格转 src_user_todo。设为 30：认证流量的风险是锁号与风控画像，
 * 比未授权流量更稀缺（评审定稿「阈值低于未授权流量一半」的精神，取一个保守绝对值）。 */
const SRC_AUTH_REQUEST_BUDGET = 30;
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

/**
 * [local.9] fetch() replacement that honors infra.proxyUrl without undici:
 * https targets go through a CONNECT tunnel, http targets use absolute-form
 * requests to the proxy. Redirects are never followed (matches the redirect:
 * "manual" call sites). Without a configured proxy it delegates to globalThis.fetch.
 * [local.15] The proxy is only used for hosts on the PROXY_REQUIRED_HOST_SUFFIXES
 * list; all other targets connect directly so domestic SRC targets are not slowed
 * down (or geo-mismatched) by an overseas egress.
 */
async function proxiedFetch(urlString, init = {}, infra = void 0) {
	const proxyUrl = String(infra?.proxyUrl ?? "").trim();
	const timeoutMs = Math.min(Math.max(Number.parseInt(String(infra?.httpTimeoutMs ?? ""), 10) || 8000, 1000), 60000);
	const target = new URL(urlString);
	if (!/^https?:$/.test(target.protocol)) throw new Error(`proxiedFetch supports only http/https targets: ${urlString}`);
	if (!isProxyUrl(proxyUrl) || !hostRequiresProxy(target.hostname)) return fetch(urlString, init);
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
function withNode(state, edgeKind, sourceId, node, counters) {
	if (node.createdAt === void 0) node.createdAt = Date.now();
	const edge = {
		id: `edge-${counters.edge + 1}`,
		kind: edgeKind,
		sourceId,
		targetId: node.id
	};
	return {
		...state,
		counters: {
			...counters,
			edge: counters.edge + 1
		},
		nodes: [...state.nodes, node].slice(-200),
		edges: [...state.edges, edge].slice(-200)
	};
}
/** Append an asset and its optional parent edge, capped (oldest dropped). */
function withAsset(state, asset, parentId, counters) {
	const assets = [...state.assets, asset].slice(-200);
	if (parentId === void 0) return {
		...state,
		counters,
		assets
	};
	const edge = {
		id: `edge-${counters.edge + 1}`,
		kind: "parent",
		sourceId: parentId,
		targetId: asset.id
	};
	return {
		...state,
		counters: {
			...counters,
			edge: counters.edge + 1
		},
		assets,
		edges: [...state.edges, edge].slice(-200)
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
			if (title === "") return state;
			if (state.nodes.some((node) => node.kind === "intent" && node.title.toLowerCase() === title.toLowerCase() && node.detail.toLowerCase() === detail.toLowerCase())) return state;
			const goalId = str(args.goalId);
			const derivedFromFactId = str(args.derivedFromFactId);
			if ((goalId !== "" ? 1 : 0) + (derivedFromFactId !== "" ? 1 : 0) !== 1) return state;
			if (goalId !== "") {
				if (state.goal === null || goalId !== state.goal.id) return state;
				const { id, counters } = nextNodeId(state, "intent");
				return withNode(state, "spawns", goalId, {
					id,
					kind: "intent",
					title,
					detail,
					status: "planned"
				}, counters);
			}
			if (findNode(state, derivedFromFactId, "fact") === void 0) return state;
			const { id: derivedId, counters: derivedCounters } = nextNodeId(state, "intent");
			return withNode(state, "derived_from", derivedFromFactId, {
				id: derivedId,
				kind: "intent",
				title,
				detail,
				status: "planned"
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
				affectedScope,
				remediation,
				pocEvidence,
				steps,
				entryPoint: str(args.entryPoint),
				discoveryPath: str(args.discoveryPath),
				rawRequest: str(args.rawRequest),
				rawResponse: str(args.rawResponse),
				affectedAssetId: affectedAssetId === "" ? void 0 : affectedAssetId
			}, counters);
		}
		case "src_update_finding": {
			const findingId = str(args.findingId);
			if (findNode(state, findingId, "finding") === void 0) return state;
			const patch = {};
			for (const key of [	"title", "severity", "description", "impact", "victimImpact", "affectedScope", "remediation", "entryPoint", "discoveryPath", "rawRequest", "rawResponse"]) {
				if (typeof args[key] === "string") patch[key] = args[key];
			}
			if (Array.isArray(args.pocEvidence)) patch.pocEvidence = args.pocEvidence.filter((item) => typeof item === "string" && item !== "");
			if (Array.isArray(args.reproducibleSteps)) patch.steps = args.reproducibleSteps.filter((step) => typeof step === "string" && step !== "");
			const assetId = str(args.affectedAssetId);
			if (assetId !== "" && !state.assets.some((asset) => asset.id === assetId)) return state;
			if (typeof args.severity === "string" && !SEVERITIES$1.has(args.severity)) return state;
			return { ...state, nodes: state.nodes.map((node) => node.kind === "finding" && node.id === findingId ? { ...node, ...patch, ...(assetId !== "" ? { affectedAssetId: assetId } : args.affectedAssetId === "" ? { affectedAssetId: void 0 } : {}) } : node) };
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
			const record = { id: str(args.id) || `coverage-${state.coverage.length + 1}`, assetId: str(args.assetId) || void 0, phase: category, category: "bypass-verification", status: blocked ? "blocked" : "testing", evidence: [], limitation: blocked ? "protection/waf/rate-limit signal" : "", updatedAt: 0 };
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
		case "src_user_todo": {
			const title = str(args.title);
			if (title === "") return state;
			const userTodoId = str(args.userTodoId);
			if (userTodoId !== "") {
				return { ...state, userTodos: state.userTodos.map((row) => row.id === userTodoId ? { ...row, status: ["pending", "done", "abandoned"].includes(args.status) ? args.status : row.status, note: str(args.note) !== "" ? str(args.note) : row.note } : row) };
			}
			return { ...state, userTodos: [...state.userTodos, { id: `todo-${state.userTodos.length + 1}`, intentId: str(args.intentId) === "" ? void 0 : str(args.intentId), kind: str(args.kind) || "other", title, detail: str(args.detail), status: "pending", note: "", createdAt: Date.now() }] };
		}
		case "src_update_intent": {
			const intentId = str(args.intentId);
			const status = args.status;
			if (!["planned", "running", "completed", "blocked", "failed"].includes(status)) return state;
			return { ...state, nodes: state.nodes.map((node) => node.kind === "intent" && node.id === intentId ? { ...node, status } : node) };
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
		testAccounts: state.testAccounts ?? [],
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
	status: z.enum(["planned", "running", "completed", "blocked", "failed"]).default("planned")
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
	/** Optional asset the finding affects. */
	affectedAssetId: id.optional()
});
/** One recorded asset; parent linkage lives on the `parent` edge row. */
const srcAssetSchema = z.object({
	id,
	sessionId: id,
	type: srcAssetTypeSchema,
	value: z.string().min(1),
	meta: z.string().default(""),
	source: z.string().default("unknown"),
	method: z.enum(["passive", "low-impact", "authorized-active", "user-confirmed"]).default("passive"),
	confidence: z.number().min(0).max(1).default(.5),
	status: z.enum(["candidate", "confirmed", "excluded"]).default("confirmed")
});
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
	credential: z.string().min(1),
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
	version: 10,
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
	userTodo: srcUserTodoSchema
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
	testAccount: "test_accounts",
	domainNote: "domain_notes",
	edge: "edges"
};
const SESSION_SCOPED_TABLES = [
	"intents",
	"facts",
	"findings",
	"assets",
	"coverage",
	"research",
	"checkpoints",
	"observations",
	"user_todos",
	"test_accounts",
	"infra",
	"edges"
];
/** Physical key for a session-local graph node or edge. */
function recordKey(sessionId, id) {
	return `${sessionId}:${id}`;
}
/** Copy and freeze one record before it crosses the service boundary. */
/** [local.15] Strip own properties whose value is `undefined` before freezing: spreading
 * `{ ...input }` where input carries explicit `undefined` optional fields (e.g.
 * `assetId: void 0` from src_finalize_engagement) otherwise leaves those keys on the
 * in-memory record. Disk JSON drops them on serialize, but the live table rows keep the
 * `undefined` values and every later view()/src_state/src_graph output then fails the
 * lossless-JSON tool boundary with "value is not lossless JSON". */
function snapshot(value) {
	const copy = { ...value };
	for (const key of Object.keys(copy)) if (copy[key] === void 0) delete copy[key];
	return Object.freeze(copy);
}
//#region src/lessons.ts
/** [local.16] Skill-style lesson files: built-in methodology ships with the plugin;
 * user-distilled lessons live under the storage data dir so deployments never wipe them. */
const LESSONS_BUILTIN_DIR = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "preset", "src-hunter", "lessons");
/* [local.16] Env override is read lazily (per call): tests set DSH_SRC_LESSONS_DIR after module load. */
const lessonsDataDir = () => (process.env.DSH_SRC_LESSONS_DIR ?? "") !== "" ? process.env.DSH_SRC_LESSONS_DIR : nodePath.join(nodeOs.homedir(), ".dsh", "storages", "src-lessons");
/** List one lesson dir as { file, title, mtime }; missing dir yields []. */
async function listLessonDir(dir) {
	let names;
	try {
		names = await fsPromises.readdir(dir);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
		const full = nodePath.join(dir, name);
		try {
			const stat = await fsPromises.stat(full);
			const head = await fsPromises.readFile(full, "utf8");
			const titleMatch = /^#\s+(.+)$/m.exec(head);
			out.push({ file: name.replace(/\.md$/, ""), title: titleMatch?.[1]?.trim() ?? name, dir, mtime: stat.mtimeMs });
		} catch {}
	}
	return out;
}
/** All lessons (built-in first, distilled second); same slug → distilled wins with `overrides: true`. */
async function listAllLessons() {
	const builtin = await listLessonDir(LESSONS_BUILTIN_DIR);
	const distilled = await listLessonDir(lessonsDataDir());
	const bySlug = new Map();
	for (const row of builtin) bySlug.set(row.file, { ...row, source: "builtin" });
	for (const row of distilled) bySlug.set(row.file, { ...row, source: "distilled", overrides: bySlug.has(row.file) });
	return [...bySlug.values()];
}
/** One-line index for prompt injection / tool outputs. */
async function lessonIndexLines() {
	const rows = await listAllLessons();
	if (rows.length === 0) return [];
	return rows.map((row) => `- ${row.title}（src_read_lesson id=${JSON.stringify(row.file)}${row.source === "distilled" ? "，沉淀" : ""}${row.overrides === true ? "，覆盖内置" : ""}）`);
}
async function readLessonFile(slug) {
	const safe = nodePath.basename(String(slug ?? ""));
	if (safe === "" || safe === ".") throw new Error("lesson id 非法（不含路径分隔符）");
	for (const dir of [lessonsDataDir(), LESSONS_BUILTIN_DIR]) {
		try {
			return { text: await fsPromises.readFile(nodePath.join(dir, `${safe}.md`), "utf8"), source: dir === lessonsDataDir() ? "distilled" : "builtin" };
		} catch {}
	}
	throw new Error(`找不到经验文件 ${safe}；用 src_search_lessons 查看现有列表`);
}
const LESSON_META_RE = /^<!--\s*lesson-meta:\s*(\{.*?\})\s*-->$/m;
/** Parse the trailing meta comment of a distilled lesson (session/finding/target/vulnType). */
function parseLessonMeta(text) {
	try {
		const match = LESSON_META_RE.exec(text);
		return match === null ? {} : JSON.parse(match[1]);
	} catch {
		return {};
	}
}
/** Distilled lessons recorded by one session (meta.sessionId match), newest first. */
async function sessionLessons(sessionId) {
	const rows = await listLessonDir(lessonsDataDir());
	const out = [];
	for (const row of rows) {
		try {
			const text = await fsPromises.readFile(nodePath.join(row.dir, `${row.file}.md`), "utf8");
			const meta = parseLessonMeta(text);
			if (meta.sessionId === sessionId) out.push({ file: row.file, title: row.title, vulnType: String(meta.vulnType ?? ""), createdAt: Number(meta.createdAt ?? row.mtime) });
		} catch {}
	}
	return out.sort((a, b) => b.createdAt - a.createdAt);
}
//#endregion
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
var SrcStore = class {
	ctx;
	domainPromise;
	/** [local.23] Per-session authenticated-request counters (in-memory; restart resets, which is fine — budgets are advisory soft signals). */
	authRequestCounts = /* @__PURE__ */ new Map();
	constructor(ctx) {
		this.ctx = ctx;
	}
	/** Resolve the opened domain, opening it lazily on first use. */
	domain() {
		if (this.domainPromise === void 0) {
			const key = srcDomainSpec.name;
			const cached = sharedDomainOpens.get(key);
			if (cached !== void 0) {
				try { console.warn(`[dsh-src] domain '${key}' already open elsewhere — reusing the shared open promise to avoid double-open.`); } catch {}
				this.domainPromise = cached;
			} else {
				const p = this.ctx.storageDomain.open(srcDomainSpec).then(async (domain) => {
					await this.migrateLegacyKeys(domain);
					return domain;
				});
				sharedDomainOpens.set(key, p);
				p.catch(() => sharedDomainOpens.delete(key));
				this.domainPromise = p;
			}
		}
		return this.domainPromise;
	}
	/** Move legacy global-id rows to the session-scoped key format once. */
	async migrateLegacyKeys(domain) {
		for (const name of SESSION_SCOPED_TABLES) {
			const table = domain.table(name);
			for (const [key, row] of table.entries()) {
				const record = row;
				const scopedKey = recordKey(record.sessionId, record.id);
				if (key === scopedKey) continue;
				if (table.get(scopedKey) === void 0) await table.put(scopedKey, row);
				await table.delete(key);
			}
		}
	}
	/** Close the domain and release its backend unit (idempotent). */
	async dispose() {
		const pending = this.domainPromise;
		if (pending !== void 0) {
			this.domainPromise = void 0;
			await (await pending).close();
		}
	}
	/** Read one session's goal row, if present. */
	async getGoal(sessionId) {
		return (await this.domain()).table("goals").get(sessionId);
	}
	/** Read the goal row, failing with a guiding error when absent. */
	async requireGoal(sessionId) {
		const goal = await this.getGoal(sessionId);
		if (goal === void 0) throw new Error("src engagement is not initialized; call src_add_goal with target and objective first");
		return goal;
	}
	/** The next deterministic id for one kind in one session (max existing seq + 1). */
	async nextId(kind, sessionId) {
		const table = (await this.domain()).table(TABLE_OF_ID_KIND[kind]);
		let max = 0;
		for (const [, row] of table.entries()) {
			if (row.sessionId !== sessionId) continue;
			const match = /-(\d+)$/.exec(row.id);
			/* v8 ignore next 1 -- unreachable: every row this store writes carries the `<kind>-<n>` id pattern. */
			if (match !== null) max = Math.max(max, Number(match[1]));
		}
		return `${kind}-${max + 1}`;
	}
	/** Delete every exploration row of one session (goal reset). */
	async clearSession(sessionId) {
		const domain = await this.domain();
		for (const name of [
			"goals",
			"intents",
			"facts",
			"findings",
			"assets",
			"coverage",
			"research",
			"checkpoints",
			"edges"
		]) {
			const table = domain.table(name);
			for (const [key, row] of table.entries()) if (row.sessionId === sessionId) await table.delete(key);
		}
	}
	/**
	* Create or reset the engagement goal. A new goal clears the whole
	* exploration graph of the session and restarts fresh counters.
	*/
	async initGoal(sessionId, input) {
		/* [local.16] A fresh goal means the previous engagement ended: stop its live POC servers. */
		await closeProofServersOfSession(sessionId);
		await this.clearSession(sessionId);
		const goal = snapshot({
			id: "goal-1",
			sessionId,
			target: input.target,
			objective: input.objective,
			authorization: input.authorization
		});
		await (await this.domain()).table("goals").put(sessionId, goal);
		return goal;
	}
	/** Validate a reference row (same session, expected table) or fail loud. */
	async requireRef(sessionId, tableName, refId, label) {
		const row = (await this.domain()).table(tableName).get(recordKey(sessionId, refId));
		if (row === void 0) throw new Error(`src: unknown ${label} ${refId}`);
		/* v8 ignore next -- session-scoped keys are normalized on domain open and the domain has one writer. */
		if (row.sessionId !== sessionId) throw new Error(`src: ${label} ${refId} belongs to another session`);
	}
	/** Mint one node (and its connecting edge) in one write. */
	async addNode(sessionId, edgeKind, sourceId, nodeKind, node) {
		await this.requireGoal(sessionId);
		const domain = await this.domain();
		const nodeId = await this.nextId(nodeKind, sessionId);
		const record = snapshot({
			id: nodeId,
			sessionId,
			...node
		});
		/* [local.17] 写入即按 domain schema 校验：sqlite 后端读取时同样校验，脏行落库会让该会话所有
		 * 读取全炸（真实事故：import_traffic 写入 kind=auth-profile 而 enum 没有它，面板/工具读取全灭）。 */
		SCHEMA_OF_KIND[nodeKind].parse(record);
		await domain.table(TABLE_OF_ID_KIND[nodeKind]).put(recordKey(sessionId, nodeId), record);
		if (edgeKind === void 0) return { nodeId };
		const edgeId = await this.nextId("edge", sessionId);
		const edge = snapshot({
			id: edgeId,
			sessionId,
			kind: edgeKind,
			sourceId,
			targetId: nodeId
		});
		await domain.table("edges").put(recordKey(sessionId, edgeId), edge);
		return {
			nodeId,
			edge: {
				id: edgeId,
				kind: edgeKind,
				sourceId,
				targetId: nodeId
			}
		};
	}
	/** Record one intent spawned by the goal or derived from a fact. */
	async addIntent(sessionId, input) {
		if ((input.goalId !== void 0 ? 1 : 0) + (input.derivedFromFactId !== void 0 ? 1 : 0) !== 1) throw new Error("src_add_intent requires exactly one anchor: goalId (spawns) or derivedFromFactId (derived_from)");
		const existing = (await this.sessionData(sessionId)).intents.find((intent) => intent.title.trim().toLowerCase() === input.title.trim().toLowerCase() && intent.detail.trim().toLowerCase() === input.detail.trim().toLowerCase());
		if (existing !== void 0) return { nodeId: existing.id, duplicate: true };
		if (input.goalId !== void 0) {
			const goal = await this.requireGoal(sessionId);
			if (input.goalId !== goal.id) throw new Error(`src: unknown goal ${input.goalId}`);
			return this.addNode(sessionId, "spawns", input.goalId, "intent", {
				title: input.title,
				detail: input.detail,
				status: "planned"
			});
		}
		/* v8 ignore next 1 -- unreachable: anchors === 1 and the goalId branch returned, so the derived anchor is present. */
		const derivedFromFactId = input.derivedFromFactId ?? "";
		await this.requireRef(sessionId, "facts", derivedFromFactId, "fact");
		return this.addNode(sessionId, "derived_from", derivedFromFactId, "intent", {
			title: input.title,
			detail: input.detail,
			status: "planned"
		});
	}
	/** Update the lifecycle status of one intent. */
	async updateIntent(sessionId, intentId, status) {
		await this.requireRef(sessionId, "intents", intentId, "intent");
		const table = (await this.domain()).table("intents");
		const key = recordKey(sessionId, intentId);
		const current = table.get(key);
		const record = snapshot({ ...current, status });
		await table.put(key, record);
		return record;
	}
	/** Append one durable delegated-child progress checkpoint. */
	async addCheckpoint(sessionId, input) {
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		const table = (await this.domain()).table("checkpoints");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.intentId === input.intentId && row.childSessionId === input.childSessionId && row.stage === input.stage && row.summary === input.summary && row.facts === input.facts && row.assets === input.assets && row.findings === input.findings && row.batchKey === input.batchKey);
		if (existing !== void 0) return { ...existing, duplicate: true };
		const checkpointId = await this.nextId("checkpoint", sessionId);
		const record = snapshot({ id: checkpointId, sessionId, ...input, createdAt: Date.now() });
		await table.put(recordKey(sessionId, checkpointId), record);
		const status = input.stage === "completed" ? "completed" : input.stage === "blocked" ? "blocked" : input.stage === "failed" ? "failed" : "running";
		await this.updateIntent(sessionId, input.intentId, status);
		return record;
	}
	/** Record one fact yielded by an intent. */
	async addFact(sessionId, input) {
		await this.requireGoal(sessionId);
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		/* [local.17] 写入即校验：sqlite 后端读取时按 domain schema 严格校验，非法 kind 落库会让整个会话的
		 * facts 读取全炸（真实事故：auth-profile 不在 enum，import_traffic 写入成功、面板读取全灭）。 */
		const existing = (await this.sessionData(sessionId)).facts.find((fact) => fact.intentId === input.intentId && fact.kind === input.kind && fact.target.trim().toLowerCase() === input.target.trim().toLowerCase() && fact.detail.trim().toLowerCase() === input.detail.trim().toLowerCase());
		if (existing !== void 0) return { nodeId: existing.id, duplicate: true };
		return this.addNode(sessionId, "yields", input.intentId, "fact", {
			intentId: input.intentId,
			kind: input.kind,
			target: input.target,
			detail: input.detail,
			confidence: input.confidence
		});
	}
	/** Record one finding proved by an intent (with reproducible steps). */
	async addFinding(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.reproducibleSteps.length === 0) throw new Error("src_add_finding requires at least one reproducible step");
		if (input.impact === "" || input.affectedScope === "" || input.remediation === "" || input.pocEvidence.length === 0) throw new Error("src_add_finding requires impact, affectedScope, remediation, and pocEvidence");
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		if (input.affectedAssetId !== void 0) await this.requireRef(sessionId, "assets", input.affectedAssetId, "asset");
		const existing = (await this.sessionData(sessionId)).findings.find((finding) => finding.title.trim().toLowerCase() === input.title.trim().toLowerCase() && (finding.affectedAssetId ?? "") === (input.affectedAssetId ?? ""));
		if (existing !== void 0) return { nodeId: existing.id, duplicate: true };
		return this.addNode(sessionId, "proves", input.intentId, "finding", {
			intentId: input.intentId,
			title: input.title,
			severity: input.severity,
			description: input.description,
			impact: input.impact,
			victimImpact: input.victimImpact ?? "",
			affectedScope: input.affectedScope,
			remediation: input.remediation,
			pocEvidence: [...input.pocEvidence],
			reproducibleSteps: [...input.reproducibleSteps],
			entryPoint: input.entryPoint ?? "",
			discoveryPath: input.discoveryPath ?? "",
			rawRequest: input.rawRequest ?? "",
			rawResponse: input.rawResponse ?? "",
			...input.affectedAssetId !== void 0 ? { affectedAssetId: input.affectedAssetId } : {}
		});
	}
	/** [local.16] Rewrite one finding in place after human-guided acceptance-criteria fixes. */
	async updateFinding(sessionId, findingId, patch) {
		await this.requireGoal(sessionId);
		const table = (await this.domain()).table("findings");
		const key = recordKey(sessionId, findingId);
		const existing = await table.get(key);
		if (existing === void 0) throw new Error(`src: unknown finding ${findingId}；先调 src_state 查看现有 finding id`);
		if (existing.sessionId !== sessionId) throw new Error(`src: finding ${findingId} belongs to another session`);
		if (patch.title !== void 0 && patch.title !== existing.title) {
			const clash = (await this.sessionData(sessionId)).findings.find((row) => row.id !== findingId && row.title.trim().toLowerCase() === patch.title.trim().toLowerCase());
			if (clash !== void 0) throw new Error(`已有同名 finding ${clash.id}「${clash.title}」；换一个标题或直接更新那个 finding，不要重名`);
		}
		if (patch.affectedAssetId !== void 0 && patch.affectedAssetId !== "" ) await this.requireRef(sessionId, "assets", patch.affectedAssetId, "asset");
		const next = snapshot({ ...existing, ...patch, ...(patch.affectedAssetId === "" ? { affectedAssetId: void 0 } : {}) });
		await table.put(key, next);
		return next;
	}
	/** Record one asset; an optional parent links it into the asset graph. */
	async addAsset(sessionId, input) {
		await this.requireGoal(sessionId);
		const parentId = input.parentId === "" ? void 0 : input.parentId;
		if (parentId !== void 0) await this.requireRef(sessionId, "assets", parentId, "asset");
		const existing = (await this.sessionData(sessionId)).assets.find((asset) => asset.type === input.type && asset.value.trim().toLowerCase() === input.value.trim().toLowerCase());
		if (existing !== void 0) {
			const rank = { candidate: 0, confirmed: 1, excluded: 2 };
			const record = snapshot({ ...existing, meta: input.meta || existing.meta, source: input.source ?? existing.source, method: input.method ?? existing.method, confidence: Math.max(existing.confidence ?? 0, input.confidence ?? 0), status: rank[input.status ?? "confirmed"] >= rank[existing.status ?? "confirmed"] ? input.status ?? "confirmed" : existing.status });
			await (await this.domain()).table("assets").put(recordKey(sessionId, existing.id), record);
			return { nodeId: existing.id, duplicate: true, updated: true };
		}
		return this.addNode(sessionId, parentId === void 0 ? void 0 : "parent", parentId ?? "", "asset", {
			type: input.type,
			value: input.value,
			meta: input.meta,
			source: input.source ?? "unknown",
			method: input.method ?? "passive",
			confidence: input.confidence ?? .5,
			status: input.status ?? "confirmed"
		});
	}
	/** Record coverage for an asset/phase/category combination. */
	async upsertCoverage(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.assetId !== void 0) await this.requireRef(sessionId, "assets", input.assetId, "asset");
		const table = (await this.domain()).table("coverage");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.assetId === input.assetId && row.phase === input.phase && row.category === input.category);
		const idValue = existing?.id ?? await this.nextId("coverage", sessionId);
		const record = snapshot({ id: idValue, sessionId, ...input, evidence: [...input.evidence], updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return { ...record, updated: existing !== void 0 };
	}
	/** Record or update a vulnerability research hypothesis. */
	async upsertResearch(sessionId, input) {
		await this.requireGoal(sessionId);
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		if (input.findingId !== void 0) await this.requireRef(sessionId, "findings", input.findingId, "finding");
		const table = (await this.domain()).table("research");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.intentId === input.intentId && row.category === input.category);
		const idValue = existing?.id ?? await this.nextId("research", sessionId);
		const record = snapshot({ id: idValue, sessionId, ...input, preconditions: [...input.preconditions], evidence: [...input.evidence], updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return { ...record, updated: existing !== void 0 };
	}
	/** Record one HTTP observation row (timeline/evidence layer). */
	async upsertObservation(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.intentId !== void 0) await this.requireRef(sessionId, "intents", input.intentId, "intent");
		if (input.assetId !== void 0) await this.requireRef(sessionId, "assets", input.assetId, "asset");
		const table = (await this.domain()).table("observations");
		const idValue = await this.nextId("observation", sessionId);
		/* [local.17] respHeaders/reqHeaders 可能是 Burp 扩展返回的对象，落库前统一序列化为文本（schema 是 string）。 */
		const headersText = (h) => typeof h === "string" ? h : h !== null && typeof h === "object" ? Object.entries(h).map(([k, v]) => `${k}: ${String(v)}`).join("\n") : String(h ?? "");
		const record = snapshot({ id: idValue, sessionId, method: input.method ?? "GET", path: input.path, httpStatus: input.httpStatus ?? 0, respHeaders: headersText(input.respHeaders), respBodySnippet: typeof input.respBodySnippet === "string" ? input.respBodySnippet : String(input.respBodySnippet ?? ""), protectionSignal: input.protectionSignal ?? false, wafBypassed: input.wafBypassed ?? false, source: input.source ?? "scan", decision: input.decision ?? "", createdAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return record;
	}
	/** Record one user-assist todo awaiting a human action. */
	async upsertUserTodo(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.intentId !== void 0) await this.requireRef(sessionId, "intents", input.intentId, "intent");
		const table = (await this.domain()).table("user_todos");
		const existing = input.userTodoId !== void 0 ? [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.id === input.userTodoId) : void 0;
		if (existing !== void 0) {
			const record = snapshot({ ...existing, title: input.title ?? existing.title, detail: input.detail ?? existing.detail, status: input.status ?? existing.status, note: input.note ?? existing.note, updatedAt: Date.now() });
			await table.put(recordKey(sessionId, existing.id), record);
			return { ...record, updated: true };
		}
		delete input.userTodoId;
		const idValue = await this.nextId("userTodo", sessionId);
		const record = snapshot({ id: idValue, sessionId, title: input.title, detail: input.detail ?? "", kind: input.kind ?? "other", status: input.status ?? "pending", note: input.note ?? "", createdAt: Date.now(), updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return record;
	}
	/** [local.23] Upsert a pasted test-account credential row (dedupe by label per session). */
	async upsertTestAccount(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.sourceObservationId !== void 0) await this.requireRef(sessionId, "observations", input.sourceObservationId, "observation");
		const table = (await this.domain()).table("test_accounts");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.label.toLowerCase() === input.label.toLowerCase());
		const idValue = existing?.id ?? await this.nextId("testAccount", sessionId);
		const record = snapshot({ id: idValue, sessionId, label: input.label, credential: input.credential, note: input.note ?? "", ...(input.sourceObservationId !== void 0 ? { sourceObservationId: input.sourceObservationId } : {}), createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return { ...record, updated: existing !== void 0 };
	}
	/** [local.23] List a session's test accounts (label 主通道 + infra.testAccount 单值兼容为无 label 条目). */
	async listTestAccounts(sessionId) {
		const table = (await this.domain()).table("test_accounts");
		const rows = [...table.entries()].map(([, row]) => row).filter((row) => row.sessionId === sessionId).map((row) => ({ id: row.id, label: row.label, note: row.note, sourceObservationId: row.sourceObservationId, createdAt: row.createdAt, updatedAt: row.updatedAt }));
		const legacy = (await this.getInfra(sessionId)).testAccount;
		const legacyCredential = String(legacy ?? "").trim();
		if (legacyCredential !== "" && !rows.some((row) => row.label.toLowerCase() === "legacy-infra")) rows.push({ id: "infra:testAccount", label: "legacy-infra", note: "旧版 infra.testAccount 单值（向后兼容读入）", createdAt: 0, updatedAt: 0 });
		return rows;
	}
	/** [local.24] Upsert a domain note keyed by target+title (same target+title 覆盖更新，跨会话积累不膨胀). */
	async upsertDomainNote(sessionId, input) {
		const target = input.target;
		const table = (await this.domain()).table("domain_notes");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.target === target && row.title.toLowerCase() === input.title.toLowerCase());
		const idValue = existing?.id ?? await this.nextId("domainNote", sessionId);
		const record = snapshot({ id: idValue, target, sessionId, category: input.category, title: input.title, content: input.content, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() });
		await table.put(`${target}:${idValue}`, record);
		return { ...record, updated: existing !== void 0 };
	}
	/** [local.24] List domain notes for a target (any session). */
	async listDomainNotes(target) {
		const table = (await this.domain()).table("domain_notes");
		return [...table.entries()].map(([, row]) => row).filter((row) => row.target === target).sort((a, b) => a.createdAt - b.createdAt).map((row) => ({ id: row.id, category: row.category, title: row.title, content: row.content, sourceSessionId: row.sessionId, createdAt: row.createdAt, updatedAt: row.updatedAt }));
	}
	/**
	 * [local.24] Cross-session briefing: prior context for a target — domain notes,
	 * falsified/blocked research hypotheses (已否假设) and confirmed findings across ALL sessions
	 * that touched the same target. Used by src_add_goal so resume/restart 不钻枯井、复用已得。
	 */
	async collectPriorContext(target, excludeSessionId) {
		const domain = await this.domain();
		const notes = (await this.listDomainNotes(target)).map((row) => ({ id: row.id, category: row.category, title: row.title, sourceSessionId: row.sourceSessionId }));
		const priorSessions = [];
		for (const [, row] of domain.table("goals").entries()) {
			if (row.target === target && row.sessionId !== excludeSessionId) priorSessions.push(row.sessionId);
		}
		const falsified = [];
		const findings = [];
		for (const sid of priorSessions) {
			for (const [, row] of domain.table("research").entries()) {
				if (row.sessionId === sid && (row.status === "false-positive" || row.status === "blocked")) falsified.push({ hypothesis: row.hypothesis, category: row.category, stopReason: row.stopReason, sourceSessionId: sid });
			}
			for (const [, row] of domain.table("findings").entries()) {
				if (row.sessionId === sid) findings.push({ title: row.title, severity: row.severity, id: row.id, sourceSessionId: sid });
			}
		}
		const result = {};
		if (notes.length > 0) result.notes = notes;
		if (falsified.length > 0) result.falsifiedHypotheses = falsified;
		if (findings.length > 0) result.findings = findings;
		if (priorSessions.length > 0) result.priorSessions = priorSessions.length;
		return result;
	}
	/** [local.23] Count one authenticated request (carries Authorization or Cookie) and return the running total for the session. */
	countAuthRequest(sessionId, n = 1) {
		const cur = this.authRequestCounts.get(sessionId) ?? 0;
		const next = cur + n;
		this.authRequestCounts.set(sessionId, next);
		return next;
	}
	authRequestTotal(sessionId) {
		return this.authRequestCounts.get(sessionId) ?? 0;
	}
	/**
	 * [local.9] Read resolved infrastructure settings: defaults merged over the
	 * session's stored overrides. Survives goal resets by design.
	 */
	async getInfra(sessionId) {
		const table = (await this.domain()).table("infra");
		const overrides = {};
		for (const [, row] of table.entries()) if (row.sessionId === sessionId) overrides[row.key] = row.value;
		return { ...SRC_INFRA_DEFAULTS, ...overrides };
	}
	/** [local.17] Raw override rows of one session (empty when the session never overrode anything). */
	async getInfraOverrides(sessionId) {
		const table = (await this.domain()).table("infra");
		const rows = [];
		for (const [, row] of table.entries()) if (row.sessionId === sessionId) rows.push(row);
		return rows;
	}
	/** [local.14] Persist one infrastructure setting override (validated upstream). */
	async setInfra(sessionId, key, value) {
		const table = (await this.domain()).table("infra");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.key === key);
		if (value === "") {
			/* Empty value clears the override so the built-in default applies again. */
			if (existing !== void 0) await table.delete(recordKey(sessionId, existing.id));
			return snapshot({ id: existing?.id ?? key, sessionId, key, value: SRC_INFRA_DEFAULTS[key] ?? "", updatedAt: Date.now() });
		}
		const record = snapshot({ id: existing?.id ?? key, sessionId, key, value, updatedAt: Date.now() });
		await table.put(recordKey(sessionId, record.id), record);
		return record;
	}
	/** [local.14] Most recent other session that has any infra override: { sourceSessionId, overrides } or undefined. */
	async latestOtherInfra(sessionId) {
		const table = (await this.domain()).table("infra");
		const bySource = new Map();
		for (const [, row] of table.entries()) {
			if (row.sessionId === sessionId || !SRC_INFRA_KEYS.includes(row.key)) continue;
			const current = bySource.get(row.sessionId);
			if (current === void 0 || row.updatedAt > current.updatedAt) bySource.set(row.sessionId, row);
		}
		let latestAt = -1;
		let sourceSessionId;
		for (const [candidate, row] of bySource) if (row.updatedAt > latestAt) {
			latestAt = row.updatedAt;
			sourceSessionId = candidate;
		}
		if (sourceSessionId === void 0) return void 0;
		const overrides = {};
		for (const [, row] of table.entries()) if (row.sessionId === sourceSessionId && row.value !== "") overrides[row.key] = row.value;
		return { sourceSessionId, updatedAt: latestAt, overrides };
	}
	/** [local.9] Rewrite the goal target in place without resetting the graph. */
	async updateGoalTarget(sessionId, target) {
		const existing = await this.getGoal(sessionId);
		if (existing === void 0) throw new Error("src: no goal to update");
		const record = snapshot({ ...existing, target });
		await (await this.domain()).table("goals").put(sessionId, record);
		return record;
	}
	/** Read all exploration rows of one session, ordered by id (insertion order). */
	async sessionData(sessionId) {
		const domain = await this.domain();
		const bySession = (rows) => [...rows].map(([, row]) => row).filter((row) => row.sessionId === sessionId).sort((a, b) => a.id.localeCompare(b.id, "en"));
		return {
			goal: await this.getGoal(sessionId),
			intents: bySession(domain.table("intents").entries()),
			facts: bySession(domain.table("facts").entries()),
			findings: bySession(domain.table("findings").entries()),
			assets: bySession(domain.table("assets").entries()),
			coverage: bySession(domain.table("coverage").entries()),
			research: bySession(domain.table("research").entries()),
			checkpoints: bySession(domain.table("checkpoints").entries()),
			observations: bySession(domain.table("observations").entries()),
			userTodos: bySession(domain.table("user_todos").entries()),
			testAccounts: bySession(domain.table("test_accounts").entries()).map((row) => ({ id: row.id, label: row.label, note: row.note, sourceObservationId: row.sourceObservationId, createdAt: row.createdAt, updatedAt: row.updatedAt })),
			edges: bySession(domain.table("edges").entries()),
			infra: bySession(domain.table("infra").entries())
		};
	}
	/** Build the model-visible summary view for one session. */
	async view(sessionId) {
		const { goal, intents, facts, findings, assets, coverage, research, checkpoints, observations, userTodos, testAccounts, edges, infra } = await this.sessionData(sessionId);
		/* [local.24] 域笔记按目标域名跨会话共享：本会话有 goal 时一并投影（历史任何会话沉淀的都可见）。 */
		const domainNotes = goal === void 0 ? [] : (await this.listDomainNotes(goal.target)).map((row) => ({ id: row.id, category: row.category, title: row.title, sourceSessionId: row.sourceSessionId, updatedAt: row.updatedAt }));
		if (goal === void 0) return {
			initialized: false,
			infra: { ...SRC_INFRA_DEFAULTS },
			intents: [],
			facts: [],
			findings: [],
			assets: [],
			coverage: [],
			research: [],
			checkpoints: [],
			observations: [],
			userTodos: [],
			testAccounts: [],
			domainNotes: [],
			edges: [],
			counts: {
				intents: 0,
				facts: 0,
				findings: 0,
				assets: 0,
				coverage: 0,
				research: 0,
				checkpoints: 0,
				observations: 0,
				userTodos: 0,
				testAccounts: 0,
				domainNotes: 0
			},
			authBudget: { used: 0, limit: SRC_AUTH_REQUEST_BUDGET }
		};
		return snapshot({
			initialized: true,
			goal,
			infra: { ...SRC_INFRA_DEFAULTS, ...Object.fromEntries(infra.map((row) => [row.key, row.value])) },
			intents,
			facts,
			findings,
			assets,
			coverage,
			research,
			checkpoints,
			observations,
			userTodos,
			testAccounts: (() => {
				const rows = testAccounts;
				const legacyCredential = String((Object.fromEntries(infra.map((row) => [row.key, row.value]))).testAccount ?? "").trim();
				if (legacyCredential !== "" && !rows.some((row) => row.label.toLowerCase() === "legacy-infra")) {
					return [...rows, { id: "infra:testAccount", label: "legacy-infra", note: "旧版 infra.testAccount 单值（向后兼容读入）", sourceObservationId: void 0, createdAt: 0, updatedAt: 0 }];
				}
				return rows;
			})(),
			edges,
			domainNotes,
			counts: {
				intents: intents.length,
				facts: facts.length,
				findings: findings.length,
				assets: assets.length,
				coverage: coverage.length,
				research: research.length,
				checkpoints: checkpoints.length,
				observations: observations.length,
				userTodos: userTodos.length,
				testAccounts: testAccounts.length,
				domainNotes: domainNotes.length
			},
			authBudget: { used: this.authRequestTotal(sessionId), limit: SRC_AUTH_REQUEST_BUDGET }
		});
	}
};
//#endregion
//#region src/tools.ts
/** Resolve the calling session id or fail a non-agent caller (like todo_write). */
function sessionIdOf(exec) {
	if (!exec.agent) throw new Error("src_* tools require an owning agent session");
	return exec.agent.session.id;
}
/** Resolve the only graph a delegated child is allowed to submit into. */
function parentSessionIdOf(exec) {
	const parentSessionId = exec.agent?.session.header?.parentSession;
	if (parentSessionId === void 0 || parentSessionId === "") throw new Error("src_submit is only available to a delegated subagent with a parent session");
	return parentSessionId;
}
/** [local.17] Sessions visible to one exec: the calling session first, then live ancestors via
 * `header.parentSession` (bounded walk). Delegated children inherit the conversation context
 * but not the store rows — goals/infra live on the engagement (commander) session — so
 * execution-class tools must resolve the ancestor session that owns them. */
function visibleSessionIds(ctx, exec) {
	const ids = [sessionIdOf(exec)];
	let header = exec.agent?.session?.header;
	for (let depth = 0; depth < 8; depth += 1) {
		const parent = header?.parentSession;
		if (parent === void 0 || parent === "" || ids.includes(parent)) break;
		ids.push(parent);
		header = ctx.sessions?.get?.(parent)?.header;
	}
	return ids;
}
/** [local.17] Resolve the session owning the active SRC goal: the calling session when it has
 * one, otherwise the nearest ancestor holding the goal row (delegated children). Returns
 * undefined when no session in the chain initialized an engagement. */
async function resolveEngagementSession(store, ctx, exec) {
	for (const id of visibleSessionIds(ctx, exec)) {
		if (await store.getGoal(id) !== void 0) return id;
	}
	return void 0;
}
function requiredString(value, name) {
	if (typeof value !== "string" || value === "") throw new Error(`src_submit requires ${name}`);
	return value;
}
/** Reject prompt variables before they are mistaken for a parent graph id. */
function concreteIntentId(value) {
	const normalized = value.trim();
	if (/^(?:[<{[]\s*)?(?:delegation[-_])?intent[-_]?id(?:\s*[>}\]])?$/i.test(normalized)) throw new Error(`src_submit requires the concrete parent intent ID returned by src_add_intent; received placeholder ${JSON.stringify(value)}`);
	return normalized;
}
function optionalString(value) {
	return typeof value === "string" ? value : "";
}
function submissionList(value, name) {
	if (!Array.isArray(value) || !value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) throw new Error(`src_submit requires ${name} to be an array of objects`);
	return value;
}
function stringList(value, name) {
	if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item !== "")) throw new Error(`src_submit ${name} must be a non-empty array of strings`);
	return value;
}
function enumValue(value, allowed, fallback, name) {
	if (value === void 0) return fallback;
	if (typeof value === "string" && allowed.includes(value)) return value;
	throw new Error(`src_submit ${name} must be one of: ${allowed.join(", ")}`);
}
function stableBatchKey(value) {
	return JSON.stringify(value, Object.keys(value).sort());
}
function confidenceValue(value) {
	if (value === void 0) return .5;
	const text = typeof value === "string" ? value.trim() : void 0;
	const isPercent = text?.endsWith("%") === true;
	const parsed = typeof value === "number" ? value : text === void 0 || text === "" ? NaN : Number(isPercent ? text.slice(0, -1) : text);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error("src_submit confidence must be 0..1 or a percentage from 0 to 100");
	if (isPercent || parsed > 1) {
		if (parsed > 100) throw new Error("src_submit confidence must be 0..1 or a percentage from 0 to 100");
		return parsed / 100;
	}
	return parsed;
}
/** Completed generic card for the read-only projections: a domain title over the raw content. */
function titledCard(title, result) {
	if (result.isError) return void 0;
	return {
		card: "generic",
		title,
		content: result.content
	};
}
/** The closed enum values exposed by the tools. */
const FACT_KINDS = [
	"port",
	"service",
	"vuln",
	"finding",
	"http",
	"info"
];
const SEVERITIES = [
	"critical",
	"high",
	"medium",
	"low",
	"info"
];
const recoveryAttempts = new Map();
const ASSET_TYPES = [
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
];
/** Broken-access-control / bypass vulnerability classes that SRC treats as first-class research categories. */
const BYPASS_CATEGORIES = [
	"authentication-bypass",
	"authorization-bypass",
	"idor-bola",
	"tenant-isolation",
	"workflow-bypass",
	"method-bypass",
	"path-normalization",
	"parser-discrepancy",
	"rate-limit-bypass",
	"cache-auth-boundary",
	"waf-rule-gap",
	"oauth-flow-bypass"
];
/** HTTP methods a bypass hypothesis may safely vary. POST is allowed only with an explicit allowBody flag. */
const BYPASS_METHODS = [
	"GET",
	"HEAD",
	"OPTIONS",
	"POST"
];
let submissionProjectionEvent = 0;
/**
* Drive the live parent projection from a delegated write. The durable graph
* lives in storage, while the Web client consumes the session projection;
* regular tool calls are the shared, known event vocabulary that updates both
* the projection and history replay without introducing a custom session event.
*/
function appendSessionToolEvent(parent, name, args) {
	if (parent === void 0 || typeof parent.append !== "function") return;
	submissionProjectionEvent += 1;
	parent.append("tool/call", {
		turn: 0,
		step: submissionProjectionEvent,
		callId: `src-submit-${submissionProjectionEvent}`,
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
	const append = parent.append.bind(parent);
	const calls = [
		// Projection replay applies the same semantic deduplication as the store.
		// The parent session remains the source of truth if a duplicate checkpoint arrives.
		...[],
		...facts.map((fact) => ({
			name: "src_add_fact",
			args: {
				...fact,
				intentId
			}
		})),
		...assets.map((asset) => ({
			name: "src_add_asset",
			args: { ...asset }
		})),
		...findings.map((finding) => ({
			name: "src_add_finding",
			args: {
				...finding,
				intentId
			}
		}))
	];
	for (const call of calls) {
		submissionProjectionEvent += 1;
		append("tool/call", {
			turn: 0,
			step: submissionProjectionEvent,
			callId: `src-submit-${submissionProjectionEvent}`,
			name: call.name,
			arguments: JSON.stringify(call.args)
		});
	}
	submissionProjectionEvent += 1;
	append("tool/call", {
		turn: 0,
		step: submissionProjectionEvent,
		callId: `src-submit-${submissionProjectionEvent}`,
		name: "src_checkpoint",
		arguments: JSON.stringify({ intentId, ...checkpoint, decision: decision ?? "" })
	});
}
/** Build the exploration-chain dump for one session (pure projection). */
function buildGraph(state) {
	return {
		goal: state.goal ?? null,
		intents: state.intents,
		facts: state.facts,
		findings: state.findings,
		assets: state.assets,
		coverage: state.coverage ?? [],
		research: state.research ?? [],
		checkpoints: state.checkpoints ?? [],
		edges: state.edges
	};
}
/** Build the final report for one session (pure projection). */
function buildReport(state) {
	if (state.goal === void 0) return [
		"# SRC 漏洞挖掘报告",
		"",
		"（未初始化：尚未调用 src_add_goal。）"
	].join("\n");
	const goal = state.goal;
	const anchorOf = (targetId) => {
		const edge = state.edges.find((e) => e.targetId === targetId);
		/* v8 ignore next 1 -- unreachable: the store writes the connecting edge with every node. */
		return edge === void 0 ? "?" : `${edge.kind} ${edge.sourceId}`;
	};
	const chainLines = [
		`- 目标 (goal ${goal.id})「${goal.target}」— 目的: ${goal.objective}`,
		...state.intents.map((intent) => `- 意图 (intent ${intent.id})「${intent.title}」(${anchorOf(intent.id)})${intent.detail === "" ? "" : ` — ${intent.detail}`}`),
		...state.facts.map((fact) => `- 事实 (fact ${fact.id}) [${fact.kind}] ${fact.target === "" ? "" : `${fact.target}: `}${fact.detail} (${anchorOf(fact.id)})`),
		...state.findings.map((finding) => `- 漏洞 (finding ${finding.id}) [${finding.severity}] ${finding.title} (${anchorOf(finding.id)})`)
	];
	const findingSections = state.findings.map((finding) => {
		const asset = finding.affectedAssetId === void 0 ? void 0 : state.assets.find((a) => a.id === finding.affectedAssetId);
		const domain = asset === void 0 ? goal.target.replace(/^https?:\/\//, "").split("/")[0] : asset.value.replace(/^https?:\/\//, "").split("/")[0];
		const fullUrl = (() => {
			const evidence = finding.pocEvidence.join("\n") + "\n" + finding.reproducibleSteps.join("\n");
			const m = evidence.match(/https?:\/\/[^\s'"\\)]+/);
			return m === null ? (asset === void 0 ? goal.target : asset.value) : m[0];
		})();
		return [
			`### ${finding.id} [${finding.severity}] ${finding.title}`,
			`- 漏洞描述: ${finding.description === "" ? finding.title : finding.description}`,
			`- 攻击者视角（利用场景）: ${finding.impact}`,
			`- 受害者视角（危害与损失）: ${(finding.victimImpact ?? "") === "" ? "（未填写——须用 src_update_finding 补写：谁受害、损失什么、是否可察觉）" : finding.victimImpact}`,
			`- 域名: ${domain}`,
			`- 完整 URL: ${fullUrl}`,
			`- 漏洞接口来源: ${finding.discoveryPath === "" ? "（未填写接口来源链）" : finding.discoveryPath}`,
			`- 前端功能点: ${finding.entryPoint === "" ? "（未填写）" : finding.entryPoint}`,
			"- 数据包（Burp 格式 raw 请求/响应）:",
			...(finding.rawRequest ?? "") === "" ? ["  （rawRequest 缺失，须补 Burp 格式原始请求）"] : [`  === Request ===`, finding.rawRequest],
			...(finding.rawResponse ?? "") === "" ? [] : [`  === Response ===`, finding.rawResponse],
			"- 补充 POC 证据（pocEvidence）:",
			...finding.pocEvidence.map((evidence, index) => `  ${index + 1}. ${evidence}`),
			`- 证明截图说明: ${finding.pocEvidence.length > 0 || (finding.rawRequest ?? "") !== "" ? "按上述 raw 请求/可复现步骤逐步执行并截取响应即可；单报告单类型业务线，必填否则被忽略" : "（无）"}`,
			`- 影响范围: ${finding.affectedScope}`,
			`- 修复建议: ${finding.remediation}`,
			`- 影响资产: ${asset === void 0 ? "（未关联）" : `[${asset.type}] ${asset.value}`}`,
			"- 可复现步骤:",
			...finding.reproducibleSteps.map((step, index) => `  ${index + 1}. ${step}`)
		].join("\n");
	});
	const assetLines = state.assets.map((asset) => {
		const parent = state.edges.find((e) => e.kind === "parent" && e.targetId === asset.id);
		const parentAsset = parent === void 0 ? void 0 : state.assets.find((a) => a.id === parent.sourceId);
		let metaText = asset.meta;
		if (typeof asset.meta === "string" && asset.meta.startsWith("api:")) {
			const space = asset.meta.indexOf(" ");
			const kind = space === -1 ? asset.meta.slice(4) : asset.meta.slice(4, space);
			const rest = space === -1 ? "" : asset.meta.slice(space + 1);
			let detail = rest;
			try {
				if (rest !== "") detail = Object.entries(JSON.parse(rest)).map(([k, v]) => `${k}=${v}`).join(", ");
			} catch {}
			metaText = `API/${kind}${detail === "" ? "" : `: ${detail}`}`;
		}
		return `- [${asset.type}] ${asset.value}${metaText === "" ? "" : `（${metaText}）`}${parentAsset === void 0 ? "" : ` ← ${parentAsset.value}`}`;
	});
	const apiAssets = state.assets.filter((asset) => asset.type === "endpoint" && typeof asset.meta === "string" && asset.meta.startsWith("api:"));
	const apiSummary = {
		total: apiAssets.length,
		schemas: apiAssets.filter((asset) => asset.meta.startsWith("api:openapi-schema") || asset.meta.startsWith("api:schema-path")).length,
		graphql: apiAssets.filter((asset) => asset.meta.startsWith("api:graphql-endpoint")).length,
		hints: apiAssets.filter((asset) => asset.meta.startsWith("api:html-js-hint") || asset.meta.startsWith("api:html-js-family")).length,
		untouched: (() => {
			const coverage = state.coverage ?? [];
			const research = state.research ?? [];
			return apiAssets.filter((asset) => {
				const assetCoverage = coverage.filter((row) => row.assetId === asset.id);
				const hasProgress = assetCoverage.some((row) => ["running", "completed", "blocked", "not-applicable"].includes(row.status));
				const assetResearch = research.filter((row) => (row.evidence ?? []).some((evidence) => evidence.includes(asset.value)) || row.hypothesis.includes(asset.value));
				const hasManualResearchProgress = assetResearch.some((row) => row.status !== "hypothesis" || !(row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				return !hasProgress && !hasManualResearchProgress;
			}).length;
		})(),
		examples: apiAssets.slice(0, 5).map((asset) => asset.value)
	};
	const coverageLines = (state.coverage ?? []).map((row) => `- ${row.id} [${row.status}] ${row.phase}/${row.category}${row.assetId === void 0 ? "" : ` → ${row.assetId}`}${row.limitation === "" ? "" : ` — ${row.limitation}`}${row.evidence.length === 0 ? "" : `（${row.evidence.join("; ")}）`}`);
	const researchLines = (state.research ?? []).map((row) => `- ${row.id} [${row.status}] ${row.category}: ${row.hypothesis}${row.stopReason === "" ? "" : ` — ${row.stopReason}`}`);
	const checkpointLines = (state.checkpoints ?? []).map((checkpoint) => `- ${checkpoint.id} [${checkpoint.stage}] ${checkpoint.intentId} / ${checkpoint.childSessionId}: ${checkpoint.summary === "" ? "（无摘要）" : checkpoint.summary}（+${checkpoint.facts} facts, +${checkpoint.assets} assets, +${checkpoint.findings} findings）`);
	return [
		"# SRC 漏洞挖掘报告",
		"",
		`- 目标 (target): ${goal.target}`,
		`- 目的 (objective): ${goal.objective}`,
		`- 授权 (authorization): ${goal.authorization === "" ? "（未声明）" : goal.authorization}`,
		"",
		"## 探索链路",
		...chainLines.length === 1 ? ["（仅目标，尚未展开）"] : chainLines,
		"",
		"## 漏洞发现",
		...findingSections.length === 0 ? ["（无）"] : findingSections,
		"",
		"## API 发现摘要",
		`- 总数: ${apiSummary.total}`,
		`- OpenAPI / schema: ${apiSummary.schemas}`,
		`- GraphQL: ${apiSummary.graphql}`,
		`- JS/HTML hint: ${apiSummary.hints}`,
		`- 尚未推进: ${apiSummary.untouched}`,
		...(apiSummary.examples.length === 0 ? ["- 示例: （无）"] : [`- 示例: ${apiSummary.examples.join(", ")}`]),
		"",
		"## 资产",
		...assetLines.length === 0 ? ["（无）"] : assetLines,
		"",
		"## 资产与测试覆盖率",
		...coverageLines.length === 0 ? ["（无）"] : coverageLines,
		"",
		"## 漏洞研究矩阵",
		...researchLines.length === 0 ? ["（无）"] : researchLines,
		"",
		"## 子 Agent 检查点",
		...checkpointLines.length === 0 ? ["（无）"] : checkpointLines,
		"",
		"## 建议人工测试的 AI/威胁情报资产",
		...(state.assets ?? []).filter((asset) => asset.type === "ai-surface" || asset.type === "threat-intel").length === 0 ? ["（无）"] : (state.assets ?? []).filter((asset) => asset.type === "ai-surface" || asset.type === "threat-intel").map((asset) => `- [${asset.type}] ${asset.value}（${asset.meta}）— 按 lessons/ai-abuse 套路已测部分见漏洞发现；未测完/需登录态的部分见下方「等你的事」`),
		"",
		"## 覆盖维度声明",
		...(() => {
			const blindSpotRows = (state.coverage ?? []).filter((row) => row.phase === "blind-spot");
			if (blindSpotRows.length === 0) return ["（无——本次未声明覆盖维度，盲区不可见）"];
			const statusLabel = (s) => s === "completed" ? "已覆盖" : s === "blocked" ? "未覆盖" : s === "not-applicable" ? "不适用" : s;
			return blindSpotRows.map((row) => `- ${row.category}: ${statusLabel(row.status)}${(row.limitation ?? "") !== "" ? ` — ${row.limitation}` : ""}${(row.evidence ?? []).length > 0 ? `（证据 ${row.evidence.join(",")})` : ""}`);
		})(),
		"",
		"## ⏸ 等你的事",
		...(() => {
			const pendingTodos = (state.userTodos ?? []).filter((todo) => todo.status === "pending");
			const lines = pendingTodos.map((todo) => `- [${todo.kind}] ${todo.title}${todo.detail === "" ? "" : ` — ${todo.detail}`}`);
			const hangIntents = (state.intents ?? []).filter((intent) => intent.status === "blocked");
			for (const intent of hangIntents) {
				if (pendingTodos.some((todo) => todo.intentId === intent.id)) continue;
				lines.push(`- ${intent.id}/${intent.title} — 已挂起${intent.detail === "" ? "" : `（${intent.detail}）`}: 需要你提供输入或决策后才能继续`);
			}
			return lines.length === 0 ? ["（无——本次任务已完整收敛，无需你操作）"] : [...lines, "", "完成任一项后面板点「已完成」或直接告诉 agent，会话会继续推进对应工作。"];
		})(),
		"",
	].join("\n");
}
/** Register all `src_*` tools on the caller's tool registry. */
function registerSrcTools(ctx, store) {
	ctx.tools.register(defineTool({
		name: "src_scan_surface",
		description: "Run a bounded authorized HTTP surface scan for the SRC recon role. This performs only low-impact GET requests and returns normalized status/title/content-type/path hints; it never writes findings or stores response bodies.",
		parameters: {
			baseUrl: { type: "string", required: true, description: "Authorized target URL or host." },
			paths: { type: "array", required: true, description: "Explicit small path list; maximum 100 paths (low-impact bounded scan).", items: { type: "string" } },
			concurrency: { type: "number", description: "1..32, default 8. Automatically reduced when protection is detected." },
			rps: { type: "number", description: "Requests per second, 1..10, default 4. Scanning stops on rate-limit signals." },
			forceAfterPreflight: { type: "boolean", description: "Only use after explicit commander decision; never bypasses WAF automatically." },
			timeoutMs: { type: "number", description: "Request timeout, 1000..15000, default 5000." }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Scanned ${v.requested} paths: ${v.responses} responses, ${v.hints} interface hints.` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_scan_surface requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const base = new URL(args.baseUrl.includes("://") ? args.baseUrl : `https://${args.baseUrl}`);
			if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(target.protocol)) throw new Error("src_scan_surface supports only http/https targets");
			if (base.hostname !== target.hostname && !base.hostname.endsWith(`.${target.hostname}`)) throw new Error("src_scan_surface target is outside the authorized goal host");
			const paths = [...new Set((Array.isArray(args.paths) ? args.paths : []).filter((path) => typeof path === "string" && path.startsWith("/")).slice(0, 100))];
			const preflightController = new AbortController();
			const preflightTimer = setTimeout(() => preflightController.abort(), 5000);
			let preflight;
			try {
				const response = await http(new URL("/", base), { method: "GET", redirect: "manual", signal: preflightController.signal, headers: { "user-agent": "dsh-src-recon/1" } });
				const headers = [...response.headers.entries()].filter(([name]) => ["server", "via", "x-cache", "cf-ray", "x-sucuri-id", "x-cdn", "x-waf"].includes(name)).map(([name, value]) => `${name}: ${value}`);
				const text = (response.headers.get("content-type") ?? "").includes("text/html") ? (await response.text()).slice(0, 8192) : "";
				const challenge = /captcha|challenge|access denied|attention required|cloudflare|sucuri|akamai/i.test(`${headers.join(" ")} ${text}`);
				preflight = { status: response.status, headers, challenge, protection: challenge || [401, 403, 429].includes(response.status) };
			} catch (error) { preflight = { status: 0, headers: [], challenge: false, protection: false, error: error.name === "AbortError" ? "timeout" : "network-error" }; }
			finally { clearTimeout(preflightTimer); }
			if (preflight.protection && args.forceAfterPreflight !== true) {
				// Bounded bypass attempt: try a few UA/method variants at low rate before giving up.
				const bypassUas = ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv/127.0) Gecko/20100101 Firefox/127.0", "curl/8.4.0"];
				const bypassAttempts = [];
				let bypassed = false;
				for (const ua of bypassUas) {
					const c2 = new AbortController();
					const t2 = setTimeout(() => c2.abort(), 5000);
					try {
						const r2 = await http(new URL("/", base), { method: "GET", redirect: "manual", signal: c2.signal, headers: { "user-agent": ua, "accept": "text/html,application/xhtml+xml" } });
						const ok = r2.status < 400 && ![401, 403, 429].includes(r2.status);
						bypassAttempts.push({ ua: ua.slice(0, 24), status: r2.status, ok });
						if (ok) { bypassed = true; break; }
					} catch { bypassAttempts.push({ ua: ua.slice(0, 24), status: 0, ok: false }); } finally { clearTimeout(t2); }
				}
				if (!bypassed) return { baseUrl: base.origin, requested: 0, responses: 0, hints: 0, preflight, bypassAttempted: true, bypassed: false, stopped: "protection-detected", requiresDecision: true, bypassAttempts, results: [] };
			}
			const concurrency = Math.min(32, Math.max(1, Number(args.concurrency) || 8));
			const rps = Math.min(10, Math.max(1, Number(args.rps) || 4));
			const timeoutMs = Math.min(15000, Math.max(1000, Number(args.timeoutMs) || 5000));
			const interval = 1000 / rps;
			let cursor = 0;
			let lastStart = 0;
			const results = [];
			let stopped = false;
			let protectionSignals = 0;
			let rateLimitBackoffUsed = false;
			const worker = async () => {
				while (true) {
					const index = cursor++;
					if (index >= paths.length || stopped) return;
					const now = Date.now();
					const wait = Math.max(0, lastStart + interval - now);
					if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
					lastStart = Date.now();
					const url = new URL(paths[index], base);
					if (url.hostname !== base.hostname) continue;
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), timeoutMs);
					try {
						const response = await http(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "user-agent": "dsh-src-recon/1" } });
						const contentType = response.headers.get("content-type") ?? "";
					const length = Number(response.headers.get("content-length") ?? 0) || 0;
					if (response.status === 429 && !rateLimitBackoffUsed) { rateLimitBackoffUsed = true; await new Promise((resolve) => setTimeout(resolve, 3000)); }
					else if (response.status === 429 || [401, 403, 503].includes(response.status)) protectionSignals += 1;
					if (protectionSignals >= 2) stopped = true;
						const result = { path: url.pathname, status: response.status, contentType, length, protectionSignal: [401, 403, 429, 503].includes(response.status) };
						if (contentType.includes("text/html") || contentType.includes("javascript")) {
							const text = (await response.text()).slice(0, 65536);
							result.hints = [...new Set([...text.matchAll(/(?:src|href|fetch|axios(?:\.get|\.post)?)[\\s=('\"]+([^\\s'\"<>`)]+)/gi)].map((match) => match[1]).filter((value) => value.startsWith("/")))].slice(0, 100);
						}
						results.push(result);
					} catch (error) {
						results.push({ path: url.pathname, error: error.name === "AbortError" ? "timeout" : "network-error" });
					} finally { clearTimeout(timer); }
				}
			};
			await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()));
			/* [local.12] never emit undefined-valued properties: tool outputs must survive lossless JSON snapshotting. */
			return { baseUrl: base.origin, requested: paths.length, responses: results.filter((result) => result.status !== void 0).length, hints: results.reduce((count, result) => count + (result.hints?.length ?? 0), 0), preflight, ...(stopped ? { stopped: "protection-signal" } : {}), requiresDecision: stopped, results };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_test_bypass",
		description: "Verify a broken-access-control / bypass hypothesis with a bounded baseline→variant comparison. Requires an initialized goal, an existing src_record_research hypothesis, and an in-scope asset URL. Runs a small, explicit variant list (GET/HEAD/OPTIONS, or POST only with allowBody) against a baseline and reports a reproducible boundary differential if the authentication/authorization outcome changes. It never requests outside the authorized host, never stores response bodies, stops on WAF/403/429/challenge unless the commander explicitly continues, and never auto-creates a finding: a boundary differential alone is not impact proof. The commander records impact/authorization proof and promotes the research to verified before any finding is reportable.",
		parameters: {
			intentId: { type: "string", required: true, description: "Existing research intent id." },
			researchId: { type: "string", required: true, description: "Existing src_record_research record id this run maps to." },
			category: { type: "string", required: true, enum: BYPASS_CATEGORIES, description: "Bypass vulnerability class." },
			baseUrl: { type: "string", required: true, description: "Authorized target URL or host." },
			baseline: { type: "object", additionalProperties: false, required: true, description: "Baseline request that establishes the current authorization outcome.", properties: { method: { type: "string", enum: ["GET", "HEAD", "OPTIONS"] }, path: { type: "string", required: true }, headers: { type: "object", additionalProperties: true, description: "Optional headers to keep identical; bounded to 8 by the executor." } } },
			variants: { type: "array", required: true, description: "Explicit variants to compare against the baseline, max 10.", items: { type: "object", additionalProperties: false, properties: { method: { type: "string", enum: BYPASS_METHODS }, path: { type: "string", required: true }, headers: { type: "object", additionalProperties: true, description: "Headers to vary; bounded to 8 by the executor." }, rawBody: { type: "string" }, allowBody: { type: "boolean" }, note: { type: "string" } } } },
			rps: { type: "number", description: "Requests per second, 1..5, default 1." },
			forceAfterProtection: { type: "boolean", description: "Only use after explicit commander decision (a confirmed scope and a tracked hypothesis are already required)." }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Bypass hypothesis ${v.researchId}: ${v.differential ? "boundary differential reproduced" : "no differential"}; tested ${v.results.length} variants.` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_test_bypass requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(engagementId ?? sessionId, "intents", intentId, "intent");
			const researchId = concreteIntentId(requiredString(args.researchId, "researchId"));
			await store.requireRef(engagementId ?? sessionId, "research", researchId, "research");
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const base = new URL(args.baseUrl.includes("://") ? args.baseUrl : `https://${args.baseUrl}`);
			if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(target.protocol)) throw new Error("src_test_bypass supports only http/https targets");
			if (base.hostname !== target.hostname && !base.hostname.endsWith(`.${target.hostname}`)) throw new Error("src_test_bypass target is outside the authorized goal host");
			const category = enumValue(args.category, BYPASS_CATEGORIES, "authorization-bypass", "category");
			const baselineInput = args.baseline;
			const variantInputs = (Array.isArray(args.variants) ? args.variants : []).filter((v) => v && typeof v === "object").slice(0, 10);
			if (variantInputs.length === 0) throw new Error("src_test_bypass requires at least one variant");
			const rps = Math.min(5, Math.max(1, Number(args.rps) || 1));
			const interval = 1000 / rps;
			const timeoutMs = 10000;
			const total = variantInputs.length + 1;
			const results = [];
			let requiresDecision = false;
			const normalized = (req) => {
				const method = typeof req.method === "string" && BYPASS_METHODS.includes(req.method.toUpperCase()) ? req.method.toUpperCase() : "GET";
				const headers = {};
				if (req.headers && typeof req.headers === "object") for (const [key, value] of Object.entries(req.headers)) { if (Object.keys(headers).length >= 8) break; if (typeof key === "string" && typeof value === "string") headers[key] = value; }
				let body = void 0;
				if (method === "POST" && req.allowBody === true && typeof req.rawBody === "string") body = req.rawBody.slice(0, 4096);
				return { method, path: typeof req.path === "string" && req.path.startsWith("/") ? req.path : "/", headers, body, note: typeof req.note === "string" ? req.note : "" };
			};
			const requests = [{ ...normalized(baselineInput), phase: "baseline" }, ...variantInputs.map((v, i) => ({ ...normalized(v), phase: `variant-${i + 1}` }))];
			const runOne = async (req) => {
				const url = new URL(req.path, base);
				if (url.hostname !== base.hostname) return { ...req, error: "off-host", skipped: true };
				/* [local.23] 认证态流量独立计数：带 Authorization/Cookie 的请求进独立预算（防锁号 + 防被风控画像）。 */
				const isAuthed = Object.keys(req.headers ?? {}).some((name) => { const l = name.toLowerCase(); return l === "authorization" || l === "cookie"; });
				let authBudgetUsed = void 0;
				if (isAuthed) authBudgetUsed = store.countAuthRequest(sessionId, 1);
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeoutMs);
				try {
					const defaultContentType = req.method === "POST" && !Object.keys(req.headers ?? {}).some((name) => name.toLowerCase() === "content-type") ? { "content-type": "application/x-www-form-urlencoded" } : {};
					const response = await http(url, { method: req.method, redirect: "manual", signal: controller.signal, headers: { "user-agent": "dsh-src/1", ...defaultContentType, ...req.headers }, body: req.body === void 0 || typeof req.body !== "string" ? void 0 : req.body });
					const contentType = response.headers.get("content-type") ?? "";
					const length = Number(response.headers.get("content-length") ?? 0) || 0;
					const loc = response.status >= 300 && response.status < 400 ? response.headers.get("location") ?? "" : "";
					const protection = [403, 429, 503].includes(response.status) || /captcha|challenge|access denied|attention required|cloudflare|sucuri|akamai/i.test((response.headers.get("server") ?? "") + " " + (response.headers.get("via") ?? ""));
					return { ...req, status: response.status, contentType, length, redirect: loc, protection, ...(isAuthed ? { authed: true, authBudgetUsed } : {}) };
				} catch (error) {
					const { status: _droppedStatus, ...reqRest } = req;
					return { ...reqRest, error: error.name === "AbortError" ? "timeout" : "network-error" };
				} finally { clearTimeout(timer); }
			};
			let lastStart = 0;
			for (const req of requests) {
				const wait = Math.max(0, lastStart + interval - Date.now());
				if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
				lastStart = Date.now();
				const result = await runOne(req);
				// Normalize baseline protection for differential comparison later; never auto-bypass.
				if (result.phase !== "baseline" && result.protection && args.forceAfterProtection !== true) { requiresDecision = true; results.push(result); break; }
				results.push(result);
			}
			const baselineR = results.find((r) => r.phase === "baseline");
			const baselineAllowed = !!(baselineR && baselineR.status !== void 0 && baselineR.status < 400 && baselineR.status !== 403);
			const differential = results.filter((r) => r.phase !== "baseline" && r.status !== void 0).find((r) => {
				const allowed = r.status < 400 && r.status !== 403;
				return allowed !== baselineAllowed && r.protection !== true;
			}) !== void 0;
			/* [local.23] 认证预算/401 连发检查。预算为软信号：触顶不报错，提示剩余矩阵格转待办。 */
			const authBudgetUsed = results.filter((r) => r.authed === true).reduce((acc, r) => Math.max(acc, r.authBudgetUsed ?? 0), 0);
			const authBudgetExhausted = authBudgetUsed >= SRC_AUTH_REQUEST_BUDGET;
			/* 401 连发：本次运行中认证请求连续返回 401 ≥3 → 会话可能失效，转「重新登录」待办模板。 */
			const authed401Streak = (() => {
				let streak = 0; let max = 0;
				for (const r of results) {
					if (r.authed === true && r.status === 401) { streak += 1; max = Math.max(max, streak); }
					else if (r.authed === true) streak = 0;
				}
				return max;
			})();
			const sessionLikelyExpired = authed401Streak >= 3;
			const evidence = [`${category}|${intentId}|baseline=${baselineR?.status ?? "err"}|differential=${differential ? "yes" : "no"}|requiresDecision=${requiresDecision ? "yes" : "no"}`, ...results.map((r) => `${r.phase}|${r.method}|${r.path}|${r.status ?? r.error}|${r.protection ? "protection" : "ok"}`)];
			// Fold the run into the tracked research record so verification stays durable and linked.
			const researchRow = (await store.sessionData(sessionId)).research.find((row) => row.id === researchId);
			if (researchRow !== void 0) await store.upsertResearch(sessionId, {
				intentId, category: researchRow.category, hypothesis: researchRow.hypothesis, preconditions: researchRow.preconditions,
				status: researchRow.status === "hypothesis" ? "testing" : researchRow.status, stopReason: researchRow.stopReason,
				evidence: [...researchRow.evidence, ...evidence], ...researchRow.findingId !== void 0 ? { findingId: researchRow.findingId } : {}
			});
			if (requiresDecision && args.forceAfterProtection !== true) {
				await store.upsertCoverage(sessionId, { assetId: args.assetId && typeof args.assetId === "string" ? args.assetId : void 0, phase: category, category: "bypass-verification", status: "blocked", evidence, limitation: "protection/waf/rate-limit signal; commander decision required" });
				return { researchId: args.researchId, category, differential: false, requiresDecision: true, results, ...(sessionLikelyExpired ? { sessionLikelyExpired: true } : {}), ...(authBudgetExhausted ? { authBudgetExhausted: true, authBudgetUsed, authBudgetLimit: SRC_AUTH_REQUEST_BUDGET } : {}) };
			}
			await store.upsertCoverage(sessionId, { assetId: args.assetId && typeof args.assetId === "string" ? args.assetId : void 0, phase: category, category: "bypass-verification", status: differential ? "completed" : "completed", evidence, limitation: "" });
			return { researchId: args.researchId, category, differential, requiresDecision: false, results, ...(sessionLikelyExpired ? { sessionLikelyExpired: true } : {}), ...(authBudgetExhausted ? { authBudgetExhausted: true, authBudgetUsed, authBudgetLimit: SRC_AUTH_REQUEST_BUDGET } : {}) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_test_credential",
		description: "对登录接口做有界凭据验证（小并发爆破/泄露凭据复现）。仅限公开密码规则/默认凭据/泄露凭证场景：最多 50 次尝试、RPS≤0.5、遇不可绕验证码即停。成功命中即构成弱口令/任意用户接管 finding 证据（仍需独立复核）；失败记 fact。不做无界字典爆破、不横向尝试其他账号。",
		parameters: {
			intentId: { type: "string", required: true, description: "现有研究 intent id。" },
			loginUrl: { type: "string", required: true, description: "授权目标登录/认证接口 URL（须在 goal host 内）。" },
			username: { type: "string", required: true, description: "目标账号（来自泄露凭据/公开样本/默认规则）。" },
			candidates: { type: "array", required: true, description: "候选密码列表（来源：公开密码规则如 Lzit@身份证后8位、默认凭据、泄露凭证），最多 50 条。", items: { type: "string" } },
			rps: { type: "number", description: "每秒请求数，0.1..0.5，默认 0.5。" },
			dictionarySource: { type: "string", required: true, description: "字典来源说明（密码规则/默认凭据/泄露凭证出处），写入证据。" },
			authProfileId: { type: "string", description: "可选：已导入认证画像 id（带验证码会话）。" },
			captchaBypassNote: { type: "string", description: "若登录需验证码：填写已验证的验证码可绕依据（如 4 位无滑块/滑块可绕，~30 次遍历计划）；未验证则遇验证码即停。" },
			stopOnCaptcha: { type: "boolean", description: "默认 true：遇验证码且无法绕过时立即停止并返回 requiresDecision。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `凭据验证：${v.hit ? `命中！${v.hitUser}（${v.triedCount} 次尝试）` : `未命中（${v.triedCount ?? 0} 次尝试）`}${v.requiresDecision ? "; 需指挥官决策" : ""}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_test_credential requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(engagementId ?? sessionId, "intents", intentId, "intent");
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const login = new URL(args.loginUrl.includes("://") ? args.loginUrl : `https://${args.loginUrl}`);
			if (!/^https?:$/.test(login.protocol)) throw new Error("src_test_credential supports only http/https targets");
			if (login.hostname !== target.hostname && !login.hostname.endsWith(`.${target.hostname}`)) throw new Error("src_test_credential target is outside the authorized goal host");
			const username = requiredString(args.username, "username");
			const candidates = (Array.isArray(args.candidates) ? args.candidates : []).filter((c) => typeof c === "string" && c.length > 0).slice(0, 50);
			if (candidates.length === 0) throw new Error("src_test_credential requires at least one candidate");
			const rps = Math.min(0.5, Math.max(0.1, Number(args.rps) || 0.5));
			const interval = 1000 / rps;
			const dictionarySource = requiredString(args.dictionarySource, "dictionarySource");
			const stopOnCaptcha = args.stopOnCaptcha !== false;
			const results = [];
			let hit = false;
			let hitCredential = "";
			let requiresDecision = false;
			let stopReason = "";
			let lastStart = 0;
			for (const candidate of candidates) {
				const wait = Math.max(0, lastStart + interval - Date.now());
					if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
				lastStart = Date.now();
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 10000);
				try {
					const body = new URLSearchParams({ username, password: candidate }).toString();
					const response = await http(login, { method: "POST", redirect: "manual", signal: controller.signal, headers: { "user-agent": "dsh-src/1", "content-type": "application/x-www-form-urlencoded" }, body });
					const text = (await response.text()).slice(0, 4096);
					// 验证码/滑块检测：页面或响应含验证码特征且未声明可绕 → 停
					if (stopOnCaptcha && args.captchaBypassNote === void 0 && /captcha|验证码|slider|滑块|geetest/i.test(text)) {
							requiresDecision = true; stopReason = "captcha-detected-unverifiable"; results.push({ credential: "***", status: response.status, captcha: true }); break;
						}
					// 命中判定：302/200 且响应不含失败特征
					const failPattern = /(密码错误|账号或密码|用户名或密码|login.*(fail|error)|invalid|incorrect|失败)/i;
					const looksHit = [200, 302].includes(response.status) && !failPattern.test(text);
					results.push({ credential: candidate.slice(0, 2) + "***", status: response.status, hit: looksHit });
					if (looksHit) { hit = true; hitCredential = candidate; break; }
					if ([401, 403, 429, 503].includes(response.status)) { requiresDecision = true; stopReason = "protection-signal"; break; }
				} catch (error) {
					results.push({ credential: candidate.slice(0, 2) + "***", error: error.name === "AbortError" ? "timeout" : "network-error" });
				} finally { clearTimeout(timer); }
			}
			const evidence = [`credential-test|${intentId}|${login.hostname}${login.pathname}|user=${username}|source=${dictionarySource}|tried=${results.length}|hit=${hit}${hit ? "|hitCredential=" + hitCredential : ""}|requiresDecision=${requiresDecision ? "yes" : "no"}${stopReason ? "|stop=" + stopReason : ""}`, ...results.map((r) => `${r.credential}|${r.status ?? r.error}|${r.hit ? "hit" : r.captcha ? "captcha" : "miss"}`)];
			// 命中即记 fact（凭据证据不落明文到 fact 正文，仅记录命中状态与来源）
			if (hit) await store.addFact(sessionId, { intentId, kind: "vuln", target: login.origin, detail: `凭据命中：${login.host}${login.pathname} 用户 ${username}（来源：${dictionarySource}）；完整凭据见 research evidence，需独立复核后升 finding`, confidence: 0.9 });
			const researchRow = (await store.sessionData(sessionId)).research.find((row) => row.intentId === intentId && row.category === "credential-test");
			if (researchRow !== void 0) await store.upsertResearch(sessionId, { intentId, category: "credential-test", hypothesis: researchRow.hypothesis, preconditions: researchRow.preconditions, status: hit ? "reproduced" : researchRow.status === "hypothesis" ? "testing" : researchRow.status, stopReason: researchRow.stopReason, evidence: [...researchRow.evidence, ...evidence], ...researchRow.findingId !== void 0 ? { findingId: researchRow.findingId } : {} });
			await store.upsertCoverage(sessionId, { assetId: void 0, phase: "credential-test", category: "authentication", status: hit ? "completed" : requiresDecision ? "blocked" : "completed", evidence, limitation: requiresDecision ? `${stopReason}；指挥官决策后可继续` : "" });
			return { intentId, loginUrl: login.origin + login.pathname, username, triedCount: results.length, hit, hitUser: hit ? username : "", hitCredentialRedacted: hit ? hitCredential.slice(0, 2) + "***" : "", requiresDecision, stopReason, results };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_observation",
		description: "记录一次 HTTP 主动探测或导入流量得到的观察（时间线/证据层）。每次显式请求后（或 Burp/har 导入恢复的流量）调用，使时间线能展示真实请求、防护信号与绕过结果，并连同决策理由。有界：只记状态码、响应片段(<=2000字符)、是否撞 WAF/401/403/429、是否绕过尝试成功。",
		parameters: {
			intentId: { type: "string", description: "发起本次探测的 intent。" },
			assetId: { type: "string", description: "被探测的资产(endpoint/service)。" },
			method: { type: "string", description: "HTTP 方法，默认 GET。" },
			path: { type: "string", required: true, description: "观察到的请求 URL/路径。" },
			httpStatus: { type: "integer", description: "HTTP 响应状态码。" },
			respHeaders: { type: "string", description: "关键响应头(如 Server、Content-Type)。" },
			respBodySnippet: { type: "string", description: "响应体短片段。" },
			protectionSignal: { type: "boolean", description: "该响应是否为 WAF/403/429/401/challenge。" },
			wafBypassed: { type: "boolean", description: "此处防护绕过尝试是否成功。" },
			source: { type: "string", enum: ["burp-mcp", "har", "raw", "manual", "scan"], description: "流量来源。" },
			decision: { type: "string", description: "本次探测后为何继续/停止/绕过。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: "observation " + v.id + " " + v.method + " " + v.path + " -> " + v.httpStatus + (v.protectionSignal ? " (protected)" : "") + (v.wafBypassed ? " (bypassed)" : "") }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const record = await store.upsertObservation(sessionId, {
				...args.intentId !== void 0 ? { intentId: args.intentId } : {},
				...args.assetId !== void 0 ? { assetId: args.assetId } : {},
				method: args.method, path: args.path, httpStatus: args.httpStatus ?? 0,
				respHeaders: args.respHeaders ?? "", respBodySnippet: (args.respBodySnippet ?? "").slice(0, 2000),
				protectionSignal: args.protectionSignal ?? false, wafBypassed: args.wafBypassed ?? false,
				source: args.source ?? "scan", decision: args.decision ?? ""
			});
			return record;
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_user_todo",
		description: "创建、完成或放弃一个用户待办项——一项必须先由人工完成才能继续测试的工作（如提供已登录的 Burp 请求给认证会话、启用 Burp MCP、提供 App/小程序下载链接）。创建时给 title+detail；用户反馈完成后用同一 userTodoId 并将 status 改为 done 并附一个 note。pending/done 待办会列在 src_state.userTodos。凡完整测试被只靠人工能提供的输入阻塞时使用。",
		parameters: {
			userTodoId: { type: "string", description: "要更新的既有待办 id（省略则新建）。" },
			intentId: { type: "string", description: "该待办解除阻塞的 intent（可选）。" },
			title: { type: "string", required: true, description: "给用户看的简短待办标题。" },
			detail: { type: "string", description: "agent 需要什么、用户如何提供。" },
			kind: { type: "string", enum: ["auth-session", "burp-enable", "asset-provide", "decision", "manual-test", "other"], description: "待办类别。" },
			status: { type: "string", enum: ["pending", "done", "abandoned"], description: "新建为 pending；用户响应后 done/abandoned。" },
			note: { type: "string", description: "用户备注/说明（自由文本）。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: "todo " + v.id + " [" + v.status + "] " + v.title }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const record = await store.upsertUserTodo(sessionId, {
				...args.userTodoId !== void 0 ? { userTodoId: args.userTodoId } : {},
				...args.intentId !== void 0 ? { intentId: args.intentId } : {},
				title: args.title, ...args.detail !== void 0 ? { detail: args.detail } : {},
				...args.kind !== void 0 ? { kind: args.kind } : {}, ...args.status !== void 0 ? { status: args.status } : {},
				...args.note !== void 0 ? { note: args.note } : {}
			});
			return record;
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_import_traffic",
		description: "从 Burp MCP / HAR / raw HTTP 文本导入已认证流量，解决登录态盲区与 React chunk 404（proxy history 里有完整真实流量）。三种模式：mcp=传入已用 mcp__burp__get_proxy_history 拿到的 flows 数组；har=传入 HAR JSON 字符串；raw=传入 raw HTTP 请求文本（Burp 格式）。仅导入 host 在授权 goal 内的流量；认证头(Cookie/Authorization/Token)完整入库为 auth-profile fact（供子 agent 直接复用构造请求、判断凭据权限范围与实际危害；仅存本地库，报告导出时注意不要外传）。请求/响应落 observations(时间线)、endpoint 落 asset(candidate)。不发新请求，只解析已有流量。",
		parameters: {
			intentId: { type: "string", required: true, description: "现有研究 intent id。" },
			mode: { type: "string", required: true, enum: ["mcp", "har", "raw"], description: "导入来源模式。" },
			data: { type: "string", description: "har 模式传 HAR JSON 字符串；raw 模式传 raw HTTP 文本。" },
			flows: { type: "array", description: "mcp 模式传入的流量数组，元素含 method/url/status/reqHeaders/respHeaders/body。", items: { type: "object", additionalProperties: true } },
			authProfileNote: { type: "string", description: "可选：用户声明的授权测试账号说明（落 evidence）。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: "导入流量：" + v.observations + " 条 observation，" + v.assets + " 个 endpoint asset，" + v.authFacts + " 条认证画像；跳过越界 " + v.outOfScope }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_import_traffic requires an initialized SRC goal");
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(engagementId ?? sessionId, "intents", intentId, "intent");
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const inScope = (host) => host === target.hostname || host.endsWith(`.${target.hostname}`);
			const parseFlows = [];
			const outOfScope = { count: 0 };
			if (args.mode === "mcp") {
				for (const f of Array.isArray(args.flows) ? args.flows : []) {
					try { const u = new URL(f.url); if (!inScope(u.hostname)) { outOfScope.count++; continue; } const hdrText = (h) => typeof h === "string" ? h : h !== null && typeof h === "object" ? Object.entries(h).map(([k2, v2]) => `${k2}: ${String(v2)}`).join("\n") : ""; parseFlows.push({ method: f.method || "GET", url: f.url, status: Number(f.status) || 0, reqHeaders: hdrText(f.reqHeaders), respHeaders: hdrText(f.respHeaders), body: (f.body || "").slice(0, 2000) }); } catch { outOfScope.count++; }
				}
			} else if (args.mode === "har") {
				let har;
				try { har = JSON.parse(requiredString(args.data, "data")); } catch { throw new Error("src_import_traffic: HAR JSON 解析失败"); }
				for (const entry of (har?.log?.entries ?? [])) {
					try { const u = new URL(entry.request?.url); if (!inScope(u.hostname)) { outOfScope.count++; continue; } parseFlows.push({ method: entry.request?.method || "GET", url: entry.request?.url, status: entry.response?.status || 0, reqHeaders: (entry.request?.headers ?? []).map((h) => h.name + ": " + h.value).join("\n"), respHeaders: (entry.response?.headers ?? []).map((h) => h.name + ": " + h.value).join("\n"), body: ((entry.response?.content?.text) || "").slice(0, 2000) }); } catch { outOfScope.count++; }
				}
			} else if (args.mode === "raw") {
				const text = requiredString(args.data, "data");
				const lines = text.split("\r?\n");
				const reqLine = lines[0] || "";
				const m = reqLine.match(/^(\S+)\s+(\S+)/);
				if (m) {
					const hostHeader = lines.find((l) => /^host:/i.test(l));
					const host = hostHeader ? hostHeader.split(":").slice(1).join(":").trim() : target.hostname;
					if (!inScope(host)) { outOfScope.count++; } else parseFlows.push({ method: m[1], url: `https://${host}${m[2]}`, status: 0, reqHeaders: lines.slice(0, 20).join("\n"), respHeaders: "", body: "" });
				}
			}
			const authFactKeys = /* @__PURE__ */ new Set();
			let obsCount = 0, assetCount = 0;
			for (const f of parseFlows) {
				let url; try { url = new URL(f.url); } catch { continue; }
				await store.upsertObservation(sessionId, { intentId, method: f.method, path: url.pathname + url.search, httpStatus: f.status, respHeaders: f.respHeaders, respBodySnippet: f.body, protectionSignal: [401, 403, 429, 503].includes(f.status), wafBypassed: false, source: args.mode === "mcp" ? "burp-mcp" : args.mode === "har" ? "har" : "raw", decision: "imported traffic" });
				appendObservationProjection(exec, intentId, { method: f.method, path: url.pathname + url.search, httpStatus: f.status, protectionSignal: [401, 403, 429, 503].includes(f.status), wafBypassed: false, source: args.mode === "mcp" ? "burp-mcp" : args.mode === "har" ? "har" : "raw", decision: "imported traffic" });
				obsCount++;
				await store.addAsset(sessionId, { type: "endpoint", value: url.host + url.pathname, meta: `imported-endpoint ${f.method}`, source: args.mode, method: "passive", confidence: 0.7, status: "candidate" });
				assetCount++;
				const authHeaders = f.reqHeaders.split("\n").filter((l) => /^(cookie|authorization|token|x-auth|x-csrf)/i.test(l));
				for (const line of authHeaders) {
					const sep = line.indexOf(":");
					if (sep < 0) continue;
					const k = line.slice(0, sep).trim().toLowerCase();
					const v = line.slice(sep + 1).trim();
					if (authFactKeys.has(k + ":" + v.slice(0, 4))) continue;
					authFactKeys.add(k + ":" + v.slice(0, 4));
					await store.addFact(sessionId, { intentId, kind: "auth-profile", target: url.host, detail: `${k}: ${v}${args.authProfileNote ? "；用户声明：" + args.authProfileNote : ""}`, confidence: 0.9 });
				}
			}
			await store.upsertCoverage(sessionId, { assetId: void 0, phase: "recon", category: "traffic-import", status: "completed", evidence: [`import ${args.mode}: ${obsCount} in-scope, ${outOfScope.count} out-of-scope`], limitation: outOfScope.count > 0 ? `${outOfScope.count} 条流量越界已跳过` : "" });
			return { mode: args.mode, observations: obsCount, assets: assetCount, authFacts: authFactKeys.size, outOfScope: outOfScope.count };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_collect_dorks",
		description: "对授权域名做 Google/GitHub dorks 被动信息收集（五类产出：泄露凭证/敏感文件/目录结构与索引页/历史缓存与临时文件/云资产泄露）。只对 goal 授权域名生成 dork；工具尽力直接抓取 DuckDuckGo html 端点，被拦截时把查询串落 fact 并指示用 web_search 执行。发现的泄露凭证/敏感文件/泄露 URL 各落 fact 或 candidate asset，供 src_test_credential（配额豁免）与后续研究消费。红线：只对授权域名跑 dork；泄露凭据只测对应账户自身越权面，不横向。",
		parameters: {
			intentId: { type: "string", required: true, description: "现有侦察 intent id。" },
			domain: { type: "string", required: true, description: "授权目标主域（须在 goal host 范围内）。" },
			categories: { type: "array", description: "可选：限定类别（credential/sensitive-file/directory/history/cloud），默认全五类。", items: { type: "string", enum: ["credential", "sensitive-file", "directory", "history", "cloud"] } },
			fetchResults: { type: "boolean", description: "默认 true：尽力直接抓取搜索结果；false 只生成查询串落 fact。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: "dorks 收集：生成 " + v.queries + " 条查询，抓取 " + v.fetched + " 条结果，落 " + v.facts + " facts / " + v.assets + " assets" }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_collect_dorks requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(engagementId ?? sessionId, "intents", intentId, "intent");
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const domain = requiredString(args.domain, "domain").trim().toLowerCase();
			if (domain !== target.hostname && !domain.endsWith(`.${target.hostname}`) && !target.hostname.endsWith(`.${domain}`)) throw new Error("src_collect_dorks domain is outside the authorized goal host");
			const wanted = Array.isArray(args.categories) && args.categories.length > 0 ? args.categories.filter((c) => ["credential", "sensitive-file", "directory", "history", "cloud"].includes(c)) : ["credential", "sensitive-file", "directory", "history", "cloud"];
			const dorkSets = {
				"credential": [
					`site:github.com "${domain}" password`,
					`site:github.com filename:.env "${domain}"`,
					`site:gitee.com "${domain}" 密码 OR password`,
					`"${domain}" password OR 密码 filetype:env OR filetype:txt OR filetype:log`
				],
				"sensitive-file": [
					`site:${domain} filetype:bak OR filetype:sql OR filetype:zip OR filetype:tar.gz OR filetype:7z`,
					`site:${domain} inurl:config OR inurl:.env OR inurl:web.config OR inurl:settings`,
					`site:${domain} inurl:".git" OR inurl:"svn/entries" OR inurl:.DS_Store`,
					`site:${domain} inurl:swagger OR inurl:api-docs OR inurl:openapi`
				],
				"directory": [
					`site:${domain} intitle:"index of"`,
					`site:${domain} inurl:admin OR inurl:manage OR inurl:backend OR inurl:login`,
					`site:${domain} inurl:upload OR inurl:backup OR inurl:temp`
				],
				"history": [
					`site:${domain} filetype:log OR filetype:tmp`,
					`site:${domain} inurl:test OR inurl:dev OR inurl:debug OR inurl:old`
				],
				"cloud": [
					`site:${domain} "AccessKeyId" OR "SecretAccessKey" OR "x-amz"`,
					`"${domain}" bucket OR oss OR cos site:github.com`
				]
			};
			const queries = [];
			for (const category of wanted) for (const q of dorkSets[category]) queries.push({ category, q });
			let fetchedCount = 0;
			let blockedSources = 0;
			const evidence = [];
			if (args.fetchResults !== false) {
				for (const item of queries.slice(0, 6)) {
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), 6000);
					try {
						const response = await http(`https://duckduckgo.com/html/?q=${encodeURIComponent(item.q)}`, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "accept": "text/html" } });
						fetchedCount += 1;
						if (response.status !== 200) { blockedSources += 1; evidence.push(`ddg|${item.category}|${response.status}|blocked`); continue; }
						const text = (await response.text()).slice(0, 200000);
					const hits = [...text.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].slice(0, 10);
						if (hits.length === 0) { evidence.push(`ddg|${item.category}|200|no-results`); continue; }
						for (const hit of hits) {
							const href = hit[1].replace(/&amp;/g, "&");
							const title = hit[2].replace(/<[^>]+>/g, "").trim();
							await store.addFact(sessionId, { intentId, kind: "info", target: domain, detail: `dorks[${item.category}] 命中：${title} — ${href.slice(0, 300)}（查询：${item.q}）`, confidence: 0.6 });
						}
						evidence.push(`ddg|${item.category}|200|${hits.length} hits`);
					} catch (error) {
						blockedSources += 1;
						evidence.push(`ddg|${item.category}|error|${error.name === "AbortError" ? "timeout" : "network"}`);
					} finally { clearTimeout(timer); }
				}
			}
			let facts = 0;
			for (const item of queries) {
				await store.addFact(sessionId, { intentId, kind: "info", target: domain, detail: `dorks[${item.category}] 查询：${item.q}；${blockedSources > 0 ? "直接抓取被拦或部分被拦，请用 web_search 执行并回填结果" : "可直接执行或用 web_search"}`, confidence: 0.5 });
				facts += 1;
			}
			await store.upsertCoverage(sessionId, { assetId: void 0, phase: "recon", category: "dorks", status: "completed", evidence: [`dorks ${domain}: ${queries.length} queries, ${fetchedCount} fetched, ${blockedSources} blocked`, ...evidence], limitation: blockedSources > 0 ? `${blockedSources} 个来源被拦，需 web_search 补齐` : "" });
			return { domain, queries: queries.length, fetched: fetchedCount, blockedSources, facts, assets: 0, categories: wanted };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_collect_passive",
		description: "Run a bounded passive discovery pass for an authorized goal host. It fetches robots.txt, sitemap.xml, the homepage, a bounded set of same-host HTML/JS URLs, and common OpenAPI/Swagger/GraphQL metadata paths, then performs limited DNS A/CNAME lookups for in-scope hostnames. Discovered assets are normalized as candidates only; no findings are created and no response bodies are persisted.",
		parameters: {
			intentId: { type: "string", required: true, description: "Existing reconnaissance intent id." },
			baseUrl: { type: "string", required: true, description: "Authorized target URL or host." },
			hostnames: { type: "array", description: "Optional additional in-scope hostnames to resolve passively.", items: { type: "string" } },
			maxHints: { type: "number", description: "Maximum extracted URL hints to follow, default 20, cap 50." }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Passive discovery collected ${v.assets} assets and ${v.facts} facts from ${v.sources} sources.` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_collect_passive requires an initialized SRC goal");
			const http = makeHttpFetch(await store.getInfra(engagementId ?? sessionId));
			const intentId = concreteIntentId(requiredString(args.intentId, "intentId"));
			await store.requireRef(engagementId ?? sessionId, "intents", intentId, "intent");
			const target = new URL(`https://${parseGoalHost(goal.target)}`);
			const base = new URL(args.baseUrl.includes("://") ? args.baseUrl : `https://${args.baseUrl}`);
			if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(target.protocol)) throw new Error("src_collect_passive supports only http/https targets");
			if (base.hostname !== target.hostname && !base.hostname.endsWith(`.${target.hostname}`)) throw new Error("src_collect_passive target is outside the authorized goal host");
			const hostnames = [...new Set([target.hostname, base.hostname, ...((Array.isArray(args.hostnames) ? args.hostnames : []).filter((host) => typeof host === "string").map((host) => host.trim().toLowerCase()).filter((host) => host !== "" && (host === target.hostname || host.endsWith(`.${target.hostname}`))))])].slice(0, 20);
			const maxHints = Math.min(50, Math.max(0, Number(args.maxHints) || 20));
			const fetched = [];
			const facts = [];
			const assets = [];
			const signals = [];
			const apiMeta = (kind, details = {}) => `api:${kind}${Object.keys(details).length === 0 ? "" : ` ${JSON.stringify(details)}`}`;
			const normalizeEndpointHint = (hint) => {
				if (typeof hint !== "string" || hint === "") return "";
				try {
					const normalized = new URL(hint, base);
					if (normalized.origin !== base.origin) return "";
					return `${normalized.pathname}${normalized.search}`;
				} catch {
					return hint.startsWith("/") ? hint : "";
				}
			};
			const coverageSkeleton = async (assetId, assetValue, tags = []) => {
				const rows = [
					{ phase: "web", category: "authentication" },
					{ phase: "api", category: "authorization" },
					{ phase: "api", category: "idor-bola" }
				];
				if (tags.includes("graphql")) rows.push({ phase: "api", category: "graphql" });
				if (tags.includes("openapi")) rows.push({ phase: "api", category: "schema-review" });
				for (const row of rows) await store.upsertCoverage(sessionId, { assetId, phase: row.phase, category: row.category, status: "planned", evidence: [`auto-skeleton ${assetValue}`], limitation: "" });
			};
			const researchSkeleton = async (assetValue, tags = [], hints = []) => {
				const rows = [
					{ category: "authorization", hypothesis: `${assetValue} may expose authorization boundary weaknesses` },
					{ category: "idor-bola", hypothesis: `${assetValue} may accept object identifiers without proper ownership checks` }
				];
				if (tags.includes("graphql")) {
					rows.push({ category: "graphql", hypothesis: `${assetValue} GraphQL schema and operations require authorization review` });
					rows.push({ category: "authorization-bypass", hypothesis: `${assetValue} GraphQL operations may bypass field or resolver authorization` });
				}
				if (tags.includes("openapi")) rows.push({ category: "workflow-bypass", hypothesis: `${assetValue} documented API paths may expose workflow/state transition weaknesses` });
				if (hints.length > 0) rows.push({ category: "method-bypass", hypothesis: `${assetValue} paths [${hints.slice(0, 6).join(", ")}] may behave differently across HTTP methods or parameter combinations` });
				for (const row of rows) await store.upsertResearch(sessionId, { intentId, category: row.category, hypothesis: row.hypothesis, preconditions: ["authorized target", `derived from passive discovery: ${assetValue}`], status: "hypothesis", stopReason: "", evidence: [`auto-skeleton ${assetValue}`] });
			};
			const recordAsset = async (type, value, meta, source, method = "passive", confidence = .55, status = "candidate", parentId, coverageTags = []) => {
				const record = await store.addAsset(sessionId, { type, value, meta, source, method, confidence, status, ...parentId ? { parentId } : {} });
				assets.push({ id: record.nodeId, type, value, status, source });
				if (type === "endpoint") await coverageSkeleton(record.nodeId, value, coverageTags);
				return record.nodeId;
			};
			const recordFact = async (kind, targetValue, detail, confidence = .6) => {
				const record = await store.addFact(sessionId, { intentId, kind, target: targetValue, detail, confidence });
				facts.push(record.id);
			};
			const preflight = await http(new URL("/", base), { method: "GET", redirect: "manual", headers: { "user-agent": "dsh-src-passive/1" } }).catch((error) => ({ status: 0, headers: { get: () => null }, error }));
			if (preflight.status !== void 0 && [401, 403, 429, 503].includes(preflight.status)) {
				await store.upsertCoverage(sessionId, { phase: "discovery", category: "passive-collection", status: "blocked", evidence: [`preflight ${preflight.status}`], limitation: "protection detected before passive collection" });
				return { assets: 0, facts: 0, sources: 0, preflight: preflight.status, requiresDecision: true, results: [] };
			}
			const endpointParentId = await recordAsset("app", base.origin, "passive root", "passive", "passive", .7, "candidate");
			// AI 站点/大模型/威胁情报资产识别（P7/P8：发现即收录并留人工测试）
			try {
				const aiResp = await http(new URL("/", base), { method: "GET", redirect: "manual", headers: { "user-agent": "dsh-src-passive/1" } });
				const aiBody = ((aiResp.headers.get("content-type") ?? "").includes("text") ? await aiResp.text() : "").slice(0, 65536);
				// 第一层：代码信号粗筛（关键词+结构信号），命中才进入 agent 语义复核漏斗
				const aiSignals = ["openai", "anthropic", "deepseek", "qwen", "通义", "kimi", "moonshot", "gemini", "midjourney", "stable-diffusion", "chatgpt", "大模型", "llm", "智能助手", "智能客服", "ai助手", "ai 助手", "copilot", "chatbot", "completions", "embeddings", "prompt", "sk-", "gpt"];
				const tiSignals = ["fofa", "shodan", "censys", "奇安信", "qianxin", "威胁情报", "ti.aliyun", "virustotal", "微步", "情报订阅"];
				const lower = aiBody.toLowerCase();
				const aiHits = aiSignals.filter((k) => lower.includes(k));
				const tiHits = tiSignals.filter((k) => lower.includes(k));
				// 结构信号：/api/chat、/v1/completions、/api/ai 等路径特征 + SSE 流式响应头
				const aiPathSignals = /\/api\/(chat|ai|llm|completions|assistant)|\/v1\/(chat|completions|embeddings)|event-stream/i;
				const aiConfidence = aiHits.length === 0 ? (aiPathSignals.test(aiBody) ? 0.5 : 0) : Math.min(0.9, 0.5 + aiHits.length * 0.15);
				if (aiBody !== "" && aiConfidence >= 0.5) {
					// 第二层：agent 语义复核——不自动定论，落 candidate 资产+复核假设，由 audit 子 agent 拉取页面语义判断"是否真 AI 面"
					const aiId = await recordAsset("ai-surface", base.origin, `ai:signal ${aiHits.slice(0, 4).join(",") || "path-pattern"} conf=${aiConfidence.toFixed(2)} needs-llm-review`, "passive", "passive", aiConfidence, "candidate");
					await recordFact("info", base.origin, `AI 面粗筛信号（${aiHits.slice(0, 4).join(",") || "路径特征"}，置信 ${aiConfidence.toFixed(2)}）：需子 agent 拉取页面语义复核是否真实 AI 服务（排除营销文案误报），复核通过后测 prompt-injection/模型越权/key 泄露/SSRF via tool-call`, aiConfidence);
					await store.upsertResearch(sessionId, { intentId, category: "ai-abuse", hypothesis: `${base.origin} 疑似 AI 面（信号：${aiHits.slice(0, 3).join(",") || "路径特征"}）——先语义复核真伪，再测 prompt-injection/模型越权/key 泄露`, preconditions: ["authorized target", "ai-surface signal detected", "needs llm review before testing"], status: "hypothesis", stopReason: "", evidence: [`auto-skeleton ai-surface ${base.origin}`, `signal-confidence ${aiConfidence.toFixed(2)}`, "nextStep: llm-review-then-manual-test"] });
					assets.push({ id: aiId, type: "ai-surface", value: base.origin, status: "candidate", source: "passive" });
				}
				if (tiHits.length > 0) {
					await recordAsset("threat-intel", base.origin, `ti:signal ${tiHits.slice(0, 3).join(",")} needs-llm-review`, "passive", "passive", .6, "candidate");
					await recordFact("info", base.origin, "威胁情报平台特征信号，需子 agent 语义复核后留人工测试", .5);
				}
			} catch {}
			const commonApiPaths = ["/openapi.json", "/openapi.yaml", "/swagger.json", "/swagger/v1/swagger.json", "/api-docs", "/v3/api-docs", "/graphql"];
			const urls = [new URL("/robots.txt", base), new URL("/sitemap.xml", base), new URL("/", base), ...commonApiPaths.map((path) => new URL(path, base))];
			for (const url of urls) {
				try {
					const response = await http(url, { method: "GET", redirect: "manual", headers: { "user-agent": "dsh-src-passive/1" } });
					const contentType = response.headers.get("content-type") ?? "";
					const body = contentType.includes("text") || contentType.includes("xml") || contentType.includes("javascript") ? (await response.text()).slice(0, 65536) : "";
					fetched.push({ url: url.pathname, status: response.status, contentType });
					if (url.pathname === "/robots.txt" && body !== "") {
						for (const match of body.matchAll(/^\s*(?:Allow|Disallow|Sitemap):\s*(.+)$/gmi)) {
							const hint = match[1].trim();
							if (hint.startsWith("http")) continue;
							if (hint.startsWith("/")) await recordFact("http", base.origin, `robots.txt hint ${hint}`);
						}
					}
					if (url.pathname === "/sitemap.xml" && body !== "") {
						for (const match of body.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
							const hinted = new URL(match[1].trim(), base);
							if (hinted.hostname === base.hostname || hinted.hostname.endsWith(`.${target.hostname}`)) {
								await recordAsset(hinted.hostname === target.hostname ? "root-domain" : "subdomain", hinted.hostname, "sitemap.xml", "sitemap.xml", "passive", .7, "candidate");
								await recordFact("http", hinted.origin, `sitemap.xml loc ${hinted.pathname}`);
							}
						}
					}
					if (url.pathname !== "/robots.txt" && url.pathname !== "/sitemap.xml" && response.status >= 200 && response.status < 300) {
						if (/graphql/i.test(url.pathname) || /application\/graphql-response\+json|application\/json/i.test(contentType) && /__schema|query|mutation/i.test(body)) {
							await recordAsset("endpoint", `${base.origin}${url.pathname}`, apiMeta("graphql-endpoint", { sourcePath: url.pathname }), "passive", "passive", .8, "candidate", endpointParentId, ["graphql"]);
							await recordFact("http", `${base.origin}${url.pathname}`, `graphql candidate ${url.pathname}`);
							const gqlHints = [...new Set([...body.matchAll(/\b(query|mutation)\s+([A-Za-z0-9_]+)/g)].map((match) => `${match[1]} ${match[2]}`).slice(0, 12))];
							for (const op of gqlHints) await recordFact("http", `${base.origin}${url.pathname}`, `graphql operation ${op}`);
							await researchSkeleton(`${base.origin}${url.pathname}`, ["graphql"], gqlHints);
						}
						if (/openapi|swagger|api-docs/i.test(url.pathname) || /openapi\s*:\s*3|swagger\s*:\s*['\"]?2/i.test(body)) {
							await recordAsset("endpoint", `${base.origin}${url.pathname}`, apiMeta("openapi-schema", { sourcePath: url.pathname }), "passive", "passive", .85, "candidate", endpointParentId, ["openapi"]);
							await recordFact("http", `${base.origin}${url.pathname}`, `api schema candidate ${url.pathname}`);
							const schemaHints = [];
							const openapiMethods = new Set();
							const openapiParams = new Set();
							try {
								const parsed = JSON.parse(body);
								if (parsed && typeof parsed === "object" && parsed.paths && typeof parsed.paths === "object") {
									for (const [pathKey, pathValue] of Object.entries(parsed.paths)) {
										if (typeof pathKey === "string" && pathKey.startsWith("/")) {
											schemaHints.push(pathKey);
											await recordAsset("endpoint", `${base.origin}${pathKey}`, apiMeta("schema-path", { path: pathKey }), "passive", "passive", .7, "candidate", endpointParentId, ["openapi"]);
										}
										if (pathValue && typeof pathValue === "object") {
											for (const [methodKey, methodValue] of Object.entries(pathValue)) {
												if (typeof methodKey === "string" && /^(get|post|put|delete|patch|options|head)$/i.test(methodKey)) openapiMethods.add(methodKey.toUpperCase());
												const params = methodValue && typeof methodValue === "object" ? methodValue.parameters : void 0;
												if (Array.isArray(params)) for (const param of params) if (param && typeof param === "object" && typeof param.name === "string") openapiParams.add(param.name);
											}
										}
									}
								}
							} catch {}
							for (const match of body.matchAll(/"\/(?:api|v\d+|graphql)[^"\s]{0,120}"|'\/(?:api|v\d+|graphql)[^'\s]{0,120}'/g)) {
								const raw = match[0].slice(1, -1);
								if (!schemaHints.includes(raw)) schemaHints.push(raw);
								await recordAsset("endpoint", `${base.origin}${raw}`, apiMeta("schema-path", { path: raw }), "passive", "passive", .7, "candidate", endpointParentId, ["openapi"]);
							}
							for (const method of [...openapiMethods, ...new Set([...body.matchAll(/\b(get|post|put|delete|patch|options|head)\b/gi)].map((match) => match[1].toUpperCase()).slice(0, 12))]) await recordFact("info", `${base.origin}${url.pathname}`, `openapi method ${method}`);
							for (const param of [...openapiParams, ...new Set([...body.matchAll(/"name"\s*:\s*"([A-Za-z0-9_.-]{1,40})"/g)].map((match) => match[1]).slice(0, 20))]) await recordFact("info", `${base.origin}${url.pathname}`, `openapi parameter ${param}`);
							await researchSkeleton(`${base.origin}${url.pathname}`, ["openapi"], schemaHints);
						}
					}
					if ((contentType.includes("text/html") || contentType.includes("javascript")) && body !== "") {
						const hints = [...new Set([...body.matchAll(/(?:src|href|fetch|axios(?:\.get|\.post)?)[\s=('\"]+([^\s'\"<>`]+)/gi)].map((match) => normalizeEndpointHint(match[1])).filter(Boolean).slice(0, maxHints))];
						const hintFamilies = [...new Set(hints.map((hint) => hint.split("?")[0]).filter(Boolean))];
						for (const hint of hints) {
							await recordFact("http", base.origin, `interface hint ${hint}`);
							await recordAsset("endpoint", `${base.origin}${hint}`, apiMeta("html-js-hint", { path: hint }), "passive", "passive", .65, "candidate", endpointParentId, ["html-js-hint"]);
						}
						for (const family of hintFamilies) {
							if (!hints.includes(family)) await recordAsset("endpoint", `${base.origin}${family}`, apiMeta("html-js-family", { path: family }), "passive", "passive", .6, "candidate", endpointParentId, ["html-js-hint"]);
						}
						if (hints.length) await researchSkeleton(base.origin, ["html-js-hint"], hintFamilies);
						for (const param of [...new Set([...body.matchAll(/[?&]([a-zA-Z0-9_.-]{2,40})=/g)].map((match) => match[1]).slice(0, 30))]) await recordFact("info", base.origin, `parameter hint ${param}`);
					}
				} catch (error) {
					signals.push(String(error?.name ?? error));
				}
			}
			for (const host of hostnames) {
				try {
					const [a, cname] = await Promise.all([dns.resolve4(host).catch(() => []), dns.resolveCname(host).catch(() => [])]);
					for (const ip of a.slice(0, 8)) await recordAsset("ip", ip, host, "dns", "passive", .8, "candidate");
					for (const alias of cname.slice(0, 8)) await recordAsset("subdomain", alias.toLowerCase(), host, "dns", "passive", .75, "candidate");
					await recordFact("info", host, `dns a=${a.length} cname=${cname.length}`);
				} catch (error) {
					signals.push(`dns:${host}`);
				}
			}
			await store.upsertCoverage(sessionId, { phase: "discovery", category: "passive-collection", status: signals.length > 0 ? "blocked" : "completed", evidence: [...fetched.map((row) => `${row.url} ${row.status}`), ...signals], limitation: signals.length > 0 ? "some passive signals were blocked or failed" : "" });
			return { assets: assets.length, facts: facts.length, sources: fetched.length + hostnames.length, requiresDecision: false, results: fetched };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_submit",
		description: "Immediately submit each newly confirmed delegated result directly into the specified parent intent. Available only to subagents: it records facts, assets, and confirmed findings in the parent graph, refreshes the parent projection, then returns only submission counts. Use it as real-time checkpoints; never resubmit an item. parentId and affectedAssetId may reference only an existing parent-session asset supplied in the delegation; omit either field for a newly submitted asset. All three arrays are optional: omit findings/assets/facts that do not apply instead of sending empty arrays.",
		parameters: {
			intentId: {
				type: "string",
				required: true,
				description: "The parent intent id supplied in the delegation prompt."
			},
			facts: {
				type: "array",
				description: "Observed facts to attach to the parent intent.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							enum: FACT_KINDS,
							description: "Fact kind (default info)."
						},
						target: {
							type: "string",
							description: "Host, URL, or service this fact refers to."
						},
						detail: {
							type: "string",
							required: true,
							description: "Confirmed evidence."
						},
						confidence: { oneOf: [{
							type: "number",
							description: "Confidence 0..1, or 0..100 as a percentage."
						}, {
							type: "string",
							description: "Percentage such as \"90%\"."
						}] }
					}
				}
			},
			assets: {
				type: "array",
				description: "New assets discovered during execution. parentId may reference only an existing parent-session asset supplied in the delegation.",
				items: {
					type: "object",
					additionalProperties: true,
					properties: {
						type: {
							type: "string",
							required: true,
							enum: ASSET_TYPES,
							description: "Asset type: root-domain / subdomain / ip / service / app / endpoint."
						},
						value: {
							type: "string",
							required: true,
							description: "Asset value."
						},
						parentId: {
							type: "string",
							description: "Existing parent-session asset id, when known."
						},
						meta: {
							type: "string",
							description: "Optional asset metadata."
						},
						source: {
							type: "string",
							description: "资产来源（crt.sh/DNS/官网导航/JS bundle/手工确认等），必须填写以保留溯源。"
						},
						method: {
							type: "string",
							enum: ["passive", "low-impact", "authorized-active", "user-confirmed"],
							description: "发现方法，默认 passive。"
						},
						confidence: { oneOf: [{ type: "number" }, { type: "string" }], description: "置信度 0..1 或百分比。" },
						status: {
							type: "string",
							enum: ["candidate", "confirmed", "excluded"],
							description: "资产状态；被动发现的默认 candidate。"
						}
					}
				}
			},
			stage: { type: "string", enum: ["progress", "completed", "blocked", "failed"], description: "Checkpoint lifecycle stage; default progress." },
			summary: { type: "string", description: "Bounded progress or completion summary." },
			decision: { type: "string", description: "为何在本次 checkpoint 后继续/停止/换向/绕过（决策理由，进时间线）。" },
			findings: {
				type: "array",
				description: "已确认的漏洞。每个 finding 只能是一个类型、一条业务线、一个漏洞点；不得把不同类型/不同业务线塞进同一个 finding。",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						title: {
							type: "string",
							required: true,
							description: "漏洞标题（中文）。"
						},
						severity: {
							type: "string",
							enum: SEVERITIES,
							description: "严重级别 critical/high/medium/low/info。"
						},
						impact: { type: "string", required: true, description: "危害论证：攻击者视角的具体利用场景——如何构造利用（恶意页面/请求）、实际拿到什么数据或权限、危害哪些用户/业务；纯配置问题或信息罗列不算。≥40字。" },
						affectedScope: { type: "string", required: true, description: "影响范围：受影响的用户/记录/主机/端点。" },
						remediation: { type: "string", required: true, description: "修复建议。" },
						entryPoint: { type: "string", description: "前端功能点：漏洞入口的前端页面/功能（如“找回密码页-手机号输入框”）。" },
						discoveryPath: { type: "string", description: "漏洞接口来源链：该接口如何被发现（如“React chunk 解析 / mobile/js/app.js → api/resetPwd”或“Burp proxy history 导入”）。" },
						rawRequest: { type: "string", description: "Burp 格式 raw 请求报文（必填门禁：报告 finalize 会拦截空 rawRequest；至少含接口地址）。" },
						rawResponse: { type: "string", description: "关键响应 raw 报文（Burp 格式）。" },
						victimImpact: { type: "string", description: "受害者视角危害：谁受害、损失什么、是否可察觉，≥30字。" },
						pocEvidence: { type: "array", required: true, description: "POC 证据，补充证据；数据包主字段用 rawRequest。", items: { type: "string" } },
						description: {
							type: "string",
							description: "漏洞描述：清楚说明漏洞是什么、在什么接口产生。"
						},
						reproducibleSteps: {
							type: "array",
							required: true,
							description: "One or more ordered commands, requests, or actions that reproduce the vulnerability.",
							items: { type: "string" }
						},
						affectedAssetId: {
							type: "string",
							description: "Existing affected parent-session asset id, when known."
						}
					}
				}
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					facts: {
						type: "number",
						required: true
					},
					assets: {
						type: "number",
						required: true
					},
					findings: { type: "number", required: true },
					checkpointId: { type: "string", required: true },
					stage: { type: "string", required: true },
					duplicateCheckpoint: { type: "boolean", required: true }
				}
			},
			render: (_a, value) => [{
				type: "text",
				text: `Submitted ${value.facts} facts, ${value.assets} assets, and ${value.findings} findings to the parent session.`
			}]
		},
		execute: async (args, exec) => {
			const childSessionId = sessionIdOf(exec);
			const parentSessionId = parentSessionIdOf(exec);
			const input = args;
			const intentId = concreteIntentId(requiredString(input.intentId, "intentId"));
			/* [local.17] 三个数组均可省略（无 finding 的提交不必传空数组），缺省按空列表处理。 */
			const facts = submissionList(Array.isArray(input.facts) ? input.facts : [], "facts");
			const assets = submissionList(Array.isArray(input.assets) ? input.assets : [], "assets");
			const findings = submissionList(Array.isArray(input.findings) ? input.findings : [], "findings");
			const parent = ctx.sessions.get(parentSessionId);
			if (parent === void 0) throw new Error(`src_submit parent session ${parentSessionId} is not live`);
			const factWrites = facts.map((fact) => ({
				intentId,
				kind: enumValue(fact.kind, FACT_KINDS, "info", "fact.kind"),
				target: optionalString(fact.target),
				detail: requiredString(fact.detail, "fact.detail"),
				confidence: confidenceValue(fact.confidence)
			}));
			const assetWrites = assets.map((asset) => ({
				type: enumValue(asset.type, ASSET_TYPES, "endpoint", "asset.type"),
				value: requiredString(asset.value, "asset.value"),
				meta: optionalString(asset.meta),
				source: typeof asset.source === "string" && asset.source !== "" ? asset.source : "delegated-subagent",
				method: enumValue(asset.method, ["passive", "low-impact", "authorized-active", "user-confirmed"], "passive", "asset.method"),
				confidence: confidenceValue(asset.confidence) ?? 0.5,
				status: enumValue(asset.status, ["candidate", "confirmed", "excluded"], "candidate", "asset.status"),
				...typeof asset.parentId === "string" ? { parentId: asset.parentId } : {}
			}));
			const findingWrites = findings.map((finding) => ({
				intentId,
				title: requiredString(finding.title, "finding.title"),
				severity: enumValue(finding.severity, SEVERITIES, "info", "finding.severity"),
				description: optionalString(finding.description),
				impact: requiredString(finding.impact, "finding.impact"),
				affectedScope: requiredString(finding.affectedScope, "finding.affectedScope"),
				remediation: requiredString(finding.remediation, "finding.remediation"),
				pocEvidence: stringList(finding.pocEvidence, "finding.pocEvidence"),
				reproducibleSteps: stringList(finding.reproducibleSteps, "finding.reproducibleSteps"),
				entryPoint: optionalString(finding.entryPoint),
				discoveryPath: optionalString(finding.discoveryPath),
				rawRequest: optionalString(finding.rawRequest),
				rawResponse: optionalString(finding.rawResponse),
				victimImpact: typeof finding.victimImpact === "string" ? finding.victimImpact : "",
				...typeof finding.affectedAssetId === "string" ? { affectedAssetId: finding.affectedAssetId } : {}
			}));
			await store.requireRef(parentSessionId, "intents", intentId, "intent");
			for (const asset of assetWrites) if (asset.parentId !== void 0 && asset.parentId !== "") await store.requireRef(parentSessionId, "assets", asset.parentId, "asset");
			for (const finding of findingWrites) if (finding.affectedAssetId !== void 0 && finding.affectedAssetId !== "") await store.requireRef(parentSessionId, "assets", finding.affectedAssetId, "asset");
			const acceptedFacts = [];
			const acceptedAssets = [];
			const acceptedFindings = [];
			for (const write of factWrites) {
				const result = await store.addFact(parentSessionId, write);
				if (!result.duplicate) acceptedFacts.push(write);
			}
			for (const write of assetWrites) {
				const result = await store.addAsset(parentSessionId, write);
				if (!result.duplicate) acceptedAssets.push(write);
			}
			for (const write of findingWrites) {
				const result = await store.addFinding(parentSessionId, write);
				if (!result.duplicate) acceptedFindings.push(write);
			}
			const stage = enumValue(input.stage, ["progress", "completed", "blocked", "failed"], "progress", "stage");
			const summary = optionalString(input.summary);
			const batchKey = stableBatchKey({ intentId, childSessionId, stage, summary, facts: factWrites, assets: assetWrites, findings: findingWrites });
			const checkpoint = await store.addCheckpoint(parentSessionId, { intentId, childSessionId, stage, summary, decision: optionalString(input.decision), facts: acceptedFacts.length, assets: acceptedAssets.length, findings: acceptedFindings.length, batchKey });
			if (!checkpoint.duplicate) appendSubmissionProjection(parent, intentId, acceptedFacts, acceptedAssets, acceptedFindings, { id: checkpoint.id, childSessionId, stage, summary, facts: acceptedFacts.length, assets: acceptedAssets.length, findings: acceptedFindings.length, createdAt: checkpoint.createdAt, batchKey }, optionalString(input.decision));
			return {
				facts: acceptedFacts.length,
				assets: acceptedAssets.length,
				findings: acceptedFindings.length,
				checkpointId: checkpoint.id,
				stage,
				duplicateCheckpoint: checkpoint.duplicate === true
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_recover_child",
		description: "定向唤醒一个失败的 SRC 子代理继续未完成的工作（即使它从未提交过 checkpoint 也可以）。收到子代理失败通知后优先用它，同一 parent/intent/child 最多两次；失败常因暂时性 API 上游错误（424），唤醒后从断点继续。不自动循环。",
		parameters: {
			childSessionId: { type: "string", required: true, description: "Failed continuable child session id." },
			intentId: { type: "string", required: true, description: "Parent SRC intent assigned to this child." },
			message: { type: "string", required: true, description: "Bounded recovery task; include the real intent id and remaining scope." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { messageId: { type: "string", required: true }, attempt: { type: "number", required: true } } }, render: (_a, v) => [{ type: "text", text: `Recovery message ${v.messageId} queued for ${v.attempt}/4.` }] },
		execute: async (args, exec) => {
			const parent = exec.agent;
			if (!parent) throw new Error("src_recover_child requires a calling agent");
			const sessionId = sessionIdOf(exec);
			const childSessionId = requiredString(args.childSessionId, "childSessionId");
			const intentId = requiredString(args.intentId, "intentId");
			await store.requireRef(sessionId, "intents", intentId, "intent");
			/* [local.15] Accept the recovery even when the child never submitted a checkpoint:
			 * a child that dies to an API failure mid-first-turn has no checkpoint yet, and
			 * requiring one made src_recover_child unusable for exactly the children that most
			 * need recovery. The intent linkage (verified above) is the authority binding the
			 * child to this parent; the child session id comes from the runtime's own failed-settlement notice. */
			const key = `${sessionId}:${intentId}:${childSessionId}`;
			const attempt = (recoveryAttempts.get(key) ?? 0) + 1;
			if (attempt > 4) throw new Error("src_recover_child recovery limit reached (4)");
			recoveryAttempts.set(key, attempt);
			const message = `SRC recovery attempt ${attempt}/4 for parent intent ${intentId}. ${requiredString(args.message, "message")} Submit a progress or completed checkpoint with src_submit; do not expand scope.`;
			try {
				const messageId = await ctx.subagents.followup(parent, SessionId(childSessionId), [{ type: "text", text: message }], { source: { kind: "coordinator", form: "relay", senderSessionId: parent.id }, signal: exec.signal });
				await store.updateIntent(sessionId, intentId, "running");
				return { messageId, attempt };
			} catch (error) {
				recoveryAttempts.delete(key);
				throw error;
			}
		}
	}));
	// [local.8] src_record_asset_observation 工具注册已删除（与 src_add_asset 冗余）；fold case 保留以兼容旧会话投影回放。
	ctx.tools.register(defineTool({
		name: "src_record_research",
		description: "Track one vulnerability research hypothesis through testing, reproduction, verification, false-positive, or blocked status. Use this for every vulnerability category before creating a reportable finding.",
		parameters: {
			intentId: { type: "string", required: true }, category: { type: "string", required: true }, hypothesis: { type: "string", required: true }, preconditions: { type: "array", items: { type: "string" } }, status: { type: "string", required: true, enum: ["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"] }, stopReason: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, findingId: { type: "string" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, updated: { type: "boolean", required: true } } }, render: (_a, v) => [{ type: "text", text: `Research ${v.id} ${v.updated ? "updated" : "recorded"}.` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const record = await store.upsertResearch(sessionId, { intentId: requiredString(args.intentId, "intentId"), category: requiredString(args.category, "category"), hypothesis: requiredString(args.hypothesis, "hypothesis"), preconditions: Array.isArray(args.preconditions) ? args.preconditions.filter((x) => typeof x === "string") : [], status: enumValue(args.status, ["hypothesis", "testing", "reproduced", "verified", "false-positive", "blocked"], "hypothesis", "status"), stopReason: optionalString(args.stopReason), evidence: Array.isArray(args.evidence) ? args.evidence.filter((x) => typeof x === "string") : [], ...typeof args.findingId === "string" ? { findingId: args.findingId } : {} });
			return { id: record.id, updated: record.updated };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_get_infra",
		description: "读取本会话基础设施设置的生效值（默认值合并会话覆盖）：HTTP 代理 proxyUrl、Burp MCP 端口 burpMcpPort、mcp-proxy.jar 路径 burpProxyJarPath、越权对照账号 testAccount、短信测试手机号 testPhone、单请求超时 httpTimeoutMs。执行短信轰炸/验证码爆破、水平越权对照、或需要代理才能出网的侦察前必须先调用本工具。",
		parameters: {},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: Object.entries(v.infra ?? {}).map(([key, value]) => `${key}=${value === "" ? "(空)" : value}`).join("; ") }] },
		execute: async (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理没有自己的 infra 覆盖行，沿 parentSession 链找到第一个有覆盖的会话读取。 */
			const chain = visibleSessionIds(ctx, exec);
			let infra = await store.getInfra(chain[0]);
			for (const id of chain.slice(1)) {
				const overrides = await store.getInfraOverrides(id);
				if (overrides.length > 0) { infra = await store.getInfra(id); break; }
			}
			return {
				infra,
				labels: SRC_INFRA_LABELS,
				processEnvProxy: {
					httpsProxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "",
					httpProxy: process.env.HTTP_PROXY ?? process.env.http_proxy ?? "",
					useEnvProxyFlag: process.execArgv.includes("--use-env-proxy") || /(^|\s)--use-env-proxy(\s|$)/.test(process.env.NODE_OPTIONS ?? "")
				}
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_list_capabilities",
		description: "列出外部能力（MCP 工具面扩展，如 JS 逆向/二进制/移动端分析）的声明与接线状态：读 ~/.dsh/capabilities.yaml 清单并对照 profile patch 已生成区段，逐条给出 id/来源/enabled/已接线/when 触发场景。当任务疑似需要客户端逆向类能力而当前工具面没有对应 mcp__<id>__* 工具时调用本工具查可用能力；未接线的告知用户编辑清单后运行 node <dsh-src包>/scripts/caps-sync.mjs 并重启 dsh。只读操作，不修改任何文件。",
		parameters: {},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: (v.items ?? []).map((c) => `${c.wired ? "✓" : c.enabled ? "○" : "×"} ${c.id}${c.wired ? "（已接线）" : c.enabled ? "（已启用但未接线：需重跑 caps-sync+重启）" : "（已停用）"}${c.when ? ` — 适用:${c.when}` : ""}`).join("\n") || "清单为空或未创建 ~/.dsh/capabilities.yaml" }] },
		execute: async (_args, _exec) => {
			const dshHome = process.env.DSH_HOME ? nodePath.resolve(process.env.DSH_HOME) : nodePath.join(nodeOs.homedir(), ".dsh");
			const yamlPath = nodePath.join(dshHome, "capabilities.yaml");
			let declared = [];
			let parseError = "";
			try {
				declared = parseCapsYamlSubset(await fsPromises.readFile(yamlPath, "utf8"));
			} catch (e) {
				parseError = e?.code === "ENOENT" ? "清单未创建" : `解析失败: ${String(e.message ?? e).slice(0, 200)}`;
			}
			const wiredIds = new Set();
			try {
				const patchPath = nodePath.join(dshHome, "profiles", "web", "cordis.patch.yml");
				if (fsSync.existsSync(patchPath)) {
					const patch = await fsPromises.readFile(patchPath, "utf8");
					const seg = patch.match(/── dsh-src capabilities:8<[\s\S]*?capabilities:>8 [^─]*──/);
					for (const m of (seg?.[0] ?? "").matchAll(/id: mcp-([A-Za-z0-9-]+)/g)) wiredIds.add(m[1]);
				}
			} catch {}
			return {
				yamlPath,
				parseError,
				items: declared.map((c) => ({ id: c.id, from: c.from, enabled: c.enabled !== false, wired: wiredIds.has(c.id), when: typeof c.when === "string" ? c.when : "" }))
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_test_capability",
		description: "端到端测活一个外部能力：①确认它在 profile patch 能力区段已接线 ②按清单来源真实 spawn 其启动命令（npm 型 npx 拉起、git 型 node entry），观察 4 秒内是否稳定存活（stdio MCP server 启动后应挂起等输入而非退出）。返回 spawn 结果与诊断建议。仅指挥官可调；npm 型首次会触发包下载可能较慢。这不是完整 MCP tools/list 握手——最终以工具面出现 mcp__<id>__* 为准。",
		parameters: {
			id: { type: "string", required: true, description: "capabilities.yaml 里的能力 id。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: v.ok ? `✓ ${v.id}: 进程启动并存活 ${v.aliveMs}ms${v.hint ? "。" + v.hint : ""}` : `✗ ${v.id}: ${v.reason}${v.hint ? "。" + v.hint : ""}` }] },
		execute: async (args, exec) => {
			const id = requiredString(args.id, "id");
			if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error("id 格式不合法");
			const dshHome = process.env.DSH_HOME ? nodePath.resolve(process.env.DSH_HOME) : nodePath.join(nodeOs.homedir(), ".dsh");
			/* 接线检查 */
			let wired = false;
			try {
				const patchPath = nodePath.join(dshHome, "profiles", "web", "cordis.patch.yml");
				if (fsSync.existsSync(patchPath)) {
					const patch = await fsPromises.readFile(patchPath, "utf8");
					const seg = patch.match(/── dsh-src capabilities:8<[\s\S]*?capabilities:>8 [^─]*──/);
					wired = new RegExp(`id: mcp-${id}\\b`).test(seg?.[0] ?? "");
				}
			} catch {}
			/* 清单读取 */
			let cap;
			try { cap = parseCapsYamlSubset(await fsPromises.readFile(nodePath.join(dshHome, "capabilities.yaml"), "utf8")).find((c) => c.id === id); } catch {}
			if (!cap) return { id, ok: false, wired, reason: "清单中无此 id 或清单不可读" };
			if (cap.enabled === false) return { id, ok: false, wired, reason: "该能力 enabled: false" };
			if (!wired) return { id, ok: false, wired: false, reason: "未出现在 patch 接线区段", hint: "先运行 caps-sync 并重启 dsh web" };
			/* 构造 spawn 命令 */
			const capsDir = nodePath.join(dshHome, "capabilities");
			const isNpm = String(cap.from ?? "").startsWith("npm:");
			const command = isNpm ? "npx" : "node";
			const cmdArgs = isNpm ? ["-y", cap.from.slice(4)] : [nodePath.join(capsDir, id, typeof cap.entry === "string" && cap.entry !== "" ? cap.entry : "dist/index.js")];
			const childEnv = { ...process.env };
			if (cap.env && typeof cap.env === "object") for (const [k, v] of Object.entries(cap.env)) childEnv[k] = String(v);
			childEnv.DSH_CAP_TEST = "1";
			const startedAt = Date.now();
			let stdout = "", stderr = "", exited = null;
			await new Promise((resolveProbe) => {
				const child = childProcessSpawn(command, cmdArgs, { env: childEnv, cwd: isNpm ? undefined : capsDir ? nodePath.join(capsDir, id) : undefined, stdio: ["pipe", "pipe", "pipe"] });
				const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolveProbe(); }, 4000);
				child.stdout?.on("data", (d) => { stdout += String(d).slice(0, 500); });
				child.stderr?.on("data", (d) => { stderr += String(d).slice(0, 500); });
				child.on("error", (e) => { clearTimeout(timer); exited = `spawn error: ${String(e).slice(0, 200)}`; resolveProbe(); });
				child.on("exit", (code, signal) => { if (exited === null) exited = `exit code=${code} signal=${signal}`; });
				setTimeout(() => { if (exited === null) { try { child.kill("SIGKILL"); } catch {} } }, 4200);
			});
			const aliveMs = Date.now() - startedAt;
			const survived = aliveMs >= 3800;
			return {
				id,
				ok: survived,
				wired,
				aliveMs,
				reason: survived ? void 0 : exited ?? "提前退出",
				stdoutHead: stdout.trim().slice(0, 300) || void 0,
				stderrHead: stderr.trim().slice(0, 300) || void 0,
				hint: survived ? (isNpm ? "npx 已拉起；重启 dsh 后工具面应出现 mcp__" + id + "__*" : "构建产物可运行；重启 dsh 后工具面应出现 mcp__" + id + "__*") : "查 stderrHead；git 型先确认 build 已成功、entry 路径正确"
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_fetch_policy",
		description: "抓取厂商 SRC/安全应急响应中心的漏洞评分与收录规则��面正文（只读一次 GET；境外站点自动走会话代理，国内站点直连）。用于【厂商规则】步骤：把返回正文的要点存为 fact(category=vendor-policy)。仅指挥官可调。",
		parameters: {
			url: { type: "string", required: true, description: "规则页面 URL（http/https）。" },
			maxLength: { type: "number", description: "返回正文最大字符数，默认 8000，上限 20000。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `[${v.status}] ${v.url}（${v.chars} 字符）\n${v.text}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const infra = await store.getInfra(sessionId);
			const http = makeHttpFetch(infra);
			const url = requiredString(args.url, "url");
			let parsed;
			try { parsed = new URL(url); } catch { throw new Error("src_fetch_policy: url 无法解析"); }
			if (!/^https?:$/.test(parsed.protocol)) throw new Error("src_fetch_policy supports only http/https urls");
			const maxChars = Math.min(Math.max(Number(args.maxLength) || 8000, 500), 20000);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number.parseInt(String(infra.httpTimeoutMs ?? ""), 10) || 15000, 2000), 60000));
			try {
				const response = await http(url, { method: "GET", signal: controller.signal });
				const raw = await response.text();
				const text = htmlToText(raw).slice(0, maxChars);
				return { status: response.status, url, chars: text.length, text };
			} finally {
				clearTimeout(timer);
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_set_infra",
		description: `写入一项基础设施设置（仅指挥官）。key 必须是：${SRC_INFRA_KEYS.join(" / ")}。value 为字符串（≤300 字符）：proxyUrl 形如 http://127.0.0.1:7890 或留空表示直连；burpMcpPort 为端口数字；httpTimeoutMs 取值 1000..60000；testPhone 为手机号列表（多个用逗号分隔）；testAccount 为对照账号凭据，格式 user:pass 或用户名。`,
		parameters: {
			key: { type: "string", required: true, description: "设置键。" },
			value: { type: "string", required: true, description: "设置值（字符串）。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { key: { type: "string", required: true }, value: { type: "string", required: true }, updatedAt: { type: "number", required: true } } }, render: (_a, v) => [{ type: "text", text: `已保存基础设施设置 ${v.key}=${v.value === "" ? "(空)" : v.value}。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const key = requiredString(args.key, "key");
			if (!SRC_INFRA_KEYS.includes(key)) throw new Error(`src_set_infra key 必须是 ${SRC_INFRA_KEYS.join(" / ")}`);
			const value = (typeof args.value === "string" ? args.value : String(args.value ?? "")).trim();
			if (value.length > 300) throw new Error("src_set_infra value 过长（≤300 字符）");
			if (key === "proxyUrl" && value !== "" && !isProxyUrl(value)) throw new Error("proxyUrl 格式应为 http://127.0.0.1:7890");
			if (key === "burpMcpPort" && value !== "" && !/^\d{1,5}$/.test(value)) throw new Error("burpMcpPort 应为端口号数字");
			if (key === "httpTimeoutMs") { const parsed = Number(value === "" ? "8000" : value); if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 60000) throw new Error("httpTimeoutMs 取值为 1000..60000 的整数毫秒"); }
			if (key === "testPhone" && value !== "") {
				const phones = value.split(/[,，、;；\s]+/).filter((part) => part !== "");
				if (phones.length === 0 || phones.some((part) => !/^\+?\d{5,15}$/.test(part))) throw new Error("testPhone 应为纯数字手机号（可带国家码 +），多个用逗号分隔");
			}
			const record = await store.setInfra(sessionId, key, value);
			return { key: record.key, value: record.value, updatedAt: record.updatedAt };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_test_account",
		description: "[local.23] 添加/更新一条越权对照测试账号凭据（多账号矩阵）。粘贴式 label 主通道：直接粘完整 Cookie/Authorization 字符串。同一会话内 label 去重覆盖。仅指挥官可调；用于水平/垂直越权 A/B 对照与多账号交叉矩阵。凭据即用即取，不批量囤积。",
		parameters: {
			label: { type: "string", required: true, description: "本组凭据的标识（如 ‘商家账号B’/‘管理员号’），同一会话 label 去重。" },
			credential: { type: "string", required: true, description: "完整凭据串：Cookie 头、Authorization 头、或 user:pass。直接粘贴 Burp 抓包的 Cookie: ... 整行。长度上限 8000 字符。" },
			note: { type: "string", description: "备注（账号角色/来源/过期提醒等）。" },
			sourceObservationId: { type: "string", description: "归因兜底：若凭据来自某条 observation（如从代理流量里提取的会话 token），填该 observation id。主通道是直接粘贴凭据。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, label: { type: "string", required: true }, updated: { type: "boolean", required: true }, updatedAt: { type: "number", required: true } } }, render: (_a, v) => [{ type: "text", text: `已${v.updated ? "更新" : "新增"}测试账号 ${v.label}（id ${v.id}）。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const label = requiredString(args.label, "label").trim();
			if (label.length > 80) throw new Error("src_add_test_account label 过长（≤80 字符）");
			const credential = requiredString(args.credential, "credential");
			if (credential.length > 8000) throw new Error("src_add_test_account credential 过长（≤8000 字符；过长的 Cookie 应裁剪为相关字段）");
			const sourceObservationId = typeof args.sourceObservationId === "string" ? args.sourceObservationId.trim() : "";
			const record = await store.upsertTestAccount(sessionId, { label, credential, note: typeof args.note === "string" ? args.note : "", ...(sourceObservationId !== "" ? { sourceObservationId } : {}) });
			return { id: record.id, label: record.label, updated: record.updated, updatedAt: record.updatedAt };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_domain_note",
		description: "[local.24] 沉淀一条域笔记（按目标域名跨会话积累）。同一目标+标题覆盖更新不膨胀。仅指挥官可调。用于：记域指纹（资产/技术栈/认证机制）、坑位（踩过的雷如某接口限流/某子域 WAF）、已否假设摘要、基线素材。续测同目标时 src_add_goal 会自动返回历史域笔记做 briefing，避免重复钻枯井。注意：单次会话的已否假设本身仍用 src_record_research 落盘，本工具只记跨会话复用价值的摘要。",
		parameters: {
			category: { type: "string", required: true, enum: ["fingerprint", "pitfall", "falsified-summary", "baseline", "misc"], description: "fingerprint=域指纹（技术栈/认证机制/资产布局），pitfall=坑位（限流/WAF/踩雷），falsified-summary=已否假设摘要，baseline=基线素材（覆盖维度经验值），misc=其他。" },
			title: { type: "string", required: true, description: "标题（≤200 字符），同目标+标题去重覆盖。" },
			content: { type: "string", required: true, description: "正文（≤8000 字符）。结构化一点便于复用：坑位记现象+绕过尝试+结论。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, target: { type: "string", required: true }, updated: { type: "boolean", required: true }, updatedAt: { type: "number", required: true } } }, render: (_a, v) => [{ type: "text", text: `已${v.updated ? "更新" : "新增"}域笔记 [${v.target}] ${v.title}（id ${v.id}）。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_record_domain_note requires an initialized SRC goal (call src_add_goal first)");
			const title = requiredString(args.title, "title").trim();
			if (title.length > 200) throw new Error("src_record_domain_note title 过长（≤200 字符）");
			const content = requiredString(args.content, "content");
			if (content.length > 8000) throw new Error("src_record_domain_note content 过长（≤8000 字符）");
			const category = enumValue(args.category, ["fingerprint", "pitfall", "falsified-summary", "baseline", "misc"], "misc", "category");
			const record = await store.upsertDomainNote(sessionId, { target: goal.target, category, title, content });
			return { id: record.id, target: record.target, updated: record.updated, updatedAt: record.updatedAt };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_list_domain_notes",
		description: "[local.24] 列出当前目标的全部域笔记（按目标域名跨会话积累，历史任何会话沉淀的都可见）。只读。用于会话中途回顾：本目标踩过哪些坑、有什么域指纹、已否假设摘要，避免重复钻枯井。content 不返回（精简），需要全文用 src_add_goal 开局的 priorContext 或后续单条查看。",
		parameters: {},
		output: { schema: { type: "object", additionalProperties: false, properties: { target: { type: "string", required: true }, notes: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, category: { type: "string", required: true }, title: { type: "string", required: true }, sourceSessionId: { type: "string", required: true }, updatedAt: { type: "number", required: true } } } } } }, render: (_a, v) => [{ type: "text", text: `目标 ${v.target} 域笔记（${v.notes.length} 条）：${v.notes.length === 0 ? "（无）" : "\n" + v.notes.map((n) => `- [${n.category}] ${n.title}（来自会话 ${n.sourceSessionId}）`).join("\n")}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_list_domain_notes requires an initialized SRC goal (call src_add_goal first)");
			const notes = (await store.listDomainNotes(goal.target)).map((row) => ({ id: row.id, category: row.category, title: row.title, sourceSessionId: row.sourceSessionId, updatedAt: row.updatedAt }));
			return { target: goal.target, notes };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_set_goal_target",
		description: "修正当前会话的目标域名（不清空探索图、不重置计数）：传入目标字符串，自动提取主机名写回 goal.target。用于目标带杂质说明文字、或其他 src_* 工具报「无法解析出目标域名」时自我修正。",
		parameters: {
			target: { type: "string", required: true, description: "目标主域名或 URL（如 mi.com）。" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, target: { type: "string", required: true } } }, render: (_a, v) => [{ type: "text", text: `Goal target 已更新为 ${v.target}。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.17] 委派子代理继承对话上下文但不继承 store 行：沿 parentSession 链找到持有 goal 的会话再用。 */
			const engagementId = await resolveEngagementSession(store, ctx, exec);
			const goal = engagementId === void 0 ? void 0 : await store.getGoal(engagementId);
			if (goal === void 0) throw new Error("src_set_goal_target requires an initialized SRC goal (call src_add_goal first)");
			const updated = await store.updateGoalTarget(engagementId ?? sessionId, parseGoalHost(requiredString(args.target, "target"), "target"));
			return { id: updated.id, target: updated.target };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_coverage",
		description: "Record coverage for an asset and assessment category. Use planned/running/completed/blocked/not-applicable with evidence or an explicit limitation so the final report can distinguish tested from untested areas.",
		parameters: {
			assetId: { type: "string" }, phase: { type: "string", required: true }, category: { type: "string", required: true }, status: { type: "string", required: true, enum: ["planned", "running", "completed", "blocked", "not-applicable"] }, evidence: { type: "array", items: { type: "string" } }, limitation: { type: "string" }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, updated: { type: "boolean", required: true } } }, render: (_a, v) => [{ type: "text", text: `Coverage ${v.id} ${v.updated ? "updated" : "recorded"}.` }] },
		execute: async (args, exec) => {
			const record = await store.upsertCoverage(sessionIdOf(exec), { ...typeof args.assetId === "string" && args.assetId.trim() !== "" ? { assetId: args.assetId.trim() } : {}, phase: requiredString(args.phase, "phase"), category: requiredString(args.category, "category"), status: enumValue(args.status, ["planned", "running", "completed", "blocked", "not-applicable"], "planned", "status"), evidence: Array.isArray(args.evidence) ? args.evidence.filter((x) => typeof x === "string") : [], limitation: optionalString(args.limitation) });
			return { id: record.id, updated: record.updated };
		}
	}));
	// [local.8] src_record_recon 工具注册已删除（与 src_add_asset/src_add_fact 冗余）；fold case 保留以兼容旧会话投影回放。
	ctx.tools.register(defineTool({
		name: "src_add_goal",
		description: "Start a penetration-testing engagement: set the target and objective, RESETTING the whole exploration graph of this session (a new goal starts a fresh chain). Call this once before recording intents, facts, findings, or assets. Record the engagement authorization (permission holder or written-permission reference) as a declarative audit fact — the package enforces no gate by itself.",
		parameters: {
			target: {
				type: "string",
				required: true,
				description: "The penetration target host or URL (e.g. mi.com or https://mi.com). Descriptive suffixes are stripped automatically — always pass a bare domain when possible."
			},
			objective: {
				type: "string",
				required: true,
				description: "The purpose / completion objective of this engagement."
			},
			authorization: {
				type: "string",
				description: "Optional declarative authorization note (who authorized the engagement, or a written-permission reference)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					target: {
						type: "string",
						required: true
					},
					objective: {
						type: "string",
						required: true
					},
					lessonIndex: { type: "array", items: { type: "string" } },
					priorContext: { type: "object", additionalProperties: true }
				}
			},
			render: (_a, v) => {
				const lines = [`Recorded goal ${v.id} → ${v.target}.`];
				if (Array.isArray(v.lessonIndex) && v.lessonIndex.length > 0) lines.push(`已有经验库（同类漏洞先 src_read_lesson 读全文再定验证方案）：`, v.lessonIndex.join("\n"));
				if (v.priorContext && Object.keys(v.priorContext).length > 0) {
					lines.push("", `【跨会话 briefing】此目标历史（${v.priorContext.priorSessions ?? 0} 次先前会话）：`);
					if (Array.isArray(v.priorContext.notes) && v.priorContext.notes.length > 0) lines.push(`域笔记：`, ...v.priorContext.notes.map((n) => `- [${n.category}] ${n.title}`));
					if (Array.isArray(v.priorContext.falsifiedHypotheses) && v.priorContext.falsifiedHypotheses.length > 0) lines.push(`已否假设（勿重复钻枯井）：`, ...v.priorContext.falsifiedHypotheses.map((h) => `- [${h.category}] ${h.hypothesis}（${h.stopReason || "未记录理由"}）`));
					if (Array.isArray(v.priorContext.findings) && v.priorContext.findings.length > 0) lines.push(`已确认漏洞（复用/回归）：`, ...v.priorContext.findings.map((f) => `- [${f.severity}] ${f.title}`));
				}
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			/* [local.9] Normalize dirty targets ("mi.com（小米在线服务主域…）") to a bare host. */
			const normalizedHost = parseGoalHost(requiredString(args.target, "target"), "target");
			const goal = await store.initGoal(sessionId, {
				target: normalizedHost,
				objective: args.objective,
				authorization: args.authorization ?? ""
			});
			let lessonIndex = [];
			try { lessonIndex = await lessonIndexLines(); } catch {}
			/* [local.24] 跨会话 briefing：同目标的历史域笔记 + 已否假设 + 已确认 findings，
			 * 续测同目标时开局即可见，不重复钻已否枯井、复用已得成果。 */
			let priorContext;
			try { priorContext = await store.collectPriorContext(normalizedHost, sessionId); } catch {}
			const hasPrior = priorContext !== void 0 && Object.keys(priorContext).length > 0;
				return {
				id: goal.id,
				target: goal.target,
				objective: goal.objective,
				...(lessonIndex.length > 0 ? { lessonIndex } : {}),
				...(hasPrior ? { priorContext } : {})
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_intent",
		description: "Record one exploration intent (what to verify / pursue next) as a node in the exploration chain. Anchor it with EXACTLY ONE of: goalId (spawns: an intent exploring toward the goal) or derivedFromFactId (derived_from: a new intent derived from a previously recorded fact). The edge kind is recorded automatically.",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "Short intent title (e.g. \"enumerate web endpoints\")."
			},
			detail: {
				type: "string",
				description: "Optional detail (scope, hypothesis, expected evidence)."
			},
			goalId: {
				type: "string",
				description: "Anchor goal id (spawns edge). Exactly one of goalId / derivedFromFactId is required."
			},
			derivedFromFactId: {
				type: "string",
				description: "Anchor fact id (derived_from edge). Exactly one of goalId / derivedFromFactId is required."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					edgeId: {
						type: "string",
						required: true
					},
					edgeKind: {
						type: "string",
						required: true
					},
					sourceId: {
						type: "string",
						required: true
					}
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded intent ${v.id}「${v.title}」 (${v.edgeKind} ${v.sourceId} → ${v.id}, edge ${v.edgeId}).`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const write = await store.addIntent(sessionId, {
				title: args.title,
				detail: args.detail ?? "",
				...args.goalId !== void 0 ? { goalId: args.goalId } : {},
				...args.derivedFromFactId !== void 0 ? { derivedFromFactId: args.derivedFromFactId } : {}
			});
			/* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for intent writes. */
			return {
				id: write.nodeId,
				title: args.title,
				edgeId: write.edge?.id ?? "",
				edgeKind: write.edge?.kind ?? "",
				sourceId: write.edge?.sourceId ?? ""
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_update_intent",
		description: "Update an intent lifecycle after delegation or human intervention.",
		parameters: {
			intentId: { type: "string", required: true, description: "Existing intent id." },
			status: { type: "string", required: true, enum: ["planned", "running", "completed", "blocked", "failed"], description: "New lifecycle status." }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `Intent ${v.id} is now ${v.status}.` }] },
		execute: async (args, exec) => store.updateIntent(sessionIdOf(exec), args.intentId, args.status)
	}));
	ctx.tools.register(defineTool({
		name: "src_add_fact",
		description: "Record one discovered fact (evidence) yielded by an intent. This is a decision-agent tool; execution subagents submit facts through src_submit.",
		parameters: {
			intentId: {
				type: "string",
				required: true,
				description: "The intent id that yielded this fact (yields edge)."
			},
			detail: {
				type: "string",
				required: true,
				description: "The fact content (e.g. \"tcp/80 open\", \"login endpoint returns 200 on default creds\")."
			},
			kind: {
				type: "string",
				enum: FACT_KINDS,
				description: "Fact kind (default info)."
			},
			target: {
				type: "string",
				description: "Host/URL/service this fact refers to."
			},
			confidence: {
				oneOf: [{
					type: "number",
					description: "Confidence 0..1, or 0..100 as a percentage."
				}, {
					type: "string",
					description: "Percentage such as \"90%\"."
				}],
				description: "Confidence (default 0.5)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					kind: {
						type: "string",
						required: true
					},
					detail: {
						type: "string",
						required: true
					},
					edgeId: {
						type: "string",
						required: true
					}
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded fact ${v.id} [${v.kind}] ${v.detail} (edge ${v.edgeId}).`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const write = await store.addFact(sessionId, {
				intentId: args.intentId,
				kind: args.kind ?? "info",
				target: args.target ?? "",
				detail: args.detail,
				confidence: confidenceValue(args.confidence)
			});
			/* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for fact writes. */
			return {
				id: write.nodeId,
				kind: args.kind ?? "info",
				detail: args.detail,
				edgeId: write.edge?.id ?? ""
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_finding",
		description: "Record one vulnerability finding proved by an intent (proves edge). The finding MUST include concrete, ordered reproducible steps (reproducibleSteps, min 1) — the exact commands/requests/actions that reproduce the vulnerability. Optionally link the affected asset.",
		parameters: {
			intentId: {
				type: "string",
				required: true,
				description: "The intent id that proved this finding (proves edge)."
			},
			title: {
				type: "string",
				required: true,
				description: "Short finding title (e.g. \"SQL injection in /search\")."
			},
			severity: {
				type: "string",
				required: true,
				enum: SEVERITIES,
				description: "Severity: critical / high / medium / low / info."
			},
			impact: { type: "string", required: true, description: "危害论证：攻击者视角的具体利用场景——如何构造利用（恶意页面/请求）、实际拿到什么数据或权限、危害哪些用户/业务；纯配置问题或信息罗列不算。≥40字。" },
			affectedScope: { type: "string", required: true, description: "影响范围：受影响的用户/记录/主机/端点。" },
			remediation: { type: "string", required: true, description: "修复建议。" },
			entryPoint: { type: "string", description: "前端功能点：漏洞入口的前端页面/功能（如“找回密码页-手机号输入框”）。" },
			discoveryPath: { type: "string", description: "漏洞接口来源链：该接口如何被发现（如“React chunk 解析 / mobile/js/app.js → api/resetPwd”或“Burp proxy history 导入”）。" },
			rawRequest: { type: "string", description: "Burp 格式 raw 请求报文（必填门禁：报告 finalize 会拦截空 rawRequest；至少含接口地址）。" },
			rawResponse: { type: "string", description: "关键响应 raw 报文（Burp 格式）。" },
			victimImpact: { type: "string", description: "受害者视角危害：谁受害、损失什么、是否可察觉（如「已登录用户被诱导访问恶意页后，其个人资料被远程读取且无感知」）≥30字。" },
			pocEvidence: { type: "array", required: true, description: "POC 证据，补充证据；数据包主字段用 rawRequest。", items: { type: "string" } },
			reproducibleSteps: {
				type: "array",
				required: true,
				description: "Ordered steps that reproduce the vulnerability (commands, requests, actions). At least one step is required (enforced at the durable boundary).",
				items: { type: "string" }
			},
			description: {
				type: "string",
				description: "Impact / root-cause description."
			},
			affectedAssetId: {
				type: "string",
				description: "Optional asset id this finding affects."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					severity: {
						type: "string",
						required: true
					},
					edgeId: {
						type: "string",
						required: true
					}
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded finding ${v.id} [${v.severity}] ${v.title} (edge ${v.edgeId}).`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const write = await store.addFinding(sessionId, {
				intentId: args.intentId,
				title: args.title,
				severity: args.severity,
				description: args.description ?? "",
				impact: args.impact,
				victimImpact: typeof args.victimImpact === "string" ? args.victimImpact : "",
				affectedScope: args.affectedScope,
				remediation: args.remediation,
				pocEvidence: args.pocEvidence,
				reproducibleSteps: args.reproducibleSteps,
				entryPoint: args.entryPoint ?? "",
				discoveryPath: args.discoveryPath ?? "",
				rawRequest: args.rawRequest ?? "",
				rawResponse: args.rawResponse ?? "",
				...args.affectedAssetId !== void 0 ? { affectedAssetId: args.affectedAssetId } : {}
			});
			/* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for finding writes. */
			return {
				id: write.nodeId,
				title: args.title,
				severity: args.severity,
				edgeId: write.edge?.id ?? ""
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_add_asset",
		description: "Record one asset of the engagement: root-domain, subdomain, ip, service, app, or endpoint. Optionally link it to a parent asset (parentId, e.g. a subdomain under its root domain, a service under its ip) so the asset graph reflects real ownership. parentId may be omitted or an empty string for a root asset. Record parent assets BEFORE their children and reuse the returned ids.",
		parameters: {
			type: {
				type: "string",
				required: true,
				enum: ASSET_TYPES,
				description: "Asset type: root-domain / subdomain / ip / service / app / endpoint."
			},
			value: {
				type: "string",
				required: true,
				description: "The asset value (e.g. \"example.com\", \"192.0.2.5\", \"nginx/1.24\")."
			},
			parentId: {
				type: "string",
				description: "Optional parent asset id (parent edge, e.g. the subdomain owning this endpoint)."
			},
			meta: {
				type: "string",
				description: "Optional free-form metadata (version, technology, note)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					type: {
						type: "string",
						required: true
					},
					value: {
						type: "string",
						required: true
					},
					edgeId: { type: "string" }
				}
			},
			render: (_a, v) => [{
				type: "text",
				text: `Recorded asset ${v.id} [${v.type}] ${v.value}${v.edgeId === void 0 ? "" : ` (parent edge ${v.edgeId})`}.`
			}]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const write = await store.addAsset(sessionId, {
				type: args.type,
				value: args.value,
				...args.parentId !== void 0 ? { parentId: args.parentId } : {},
				meta: args.meta ?? "",
				source: args.source ?? "unknown",
				method: args.method ?? "passive",
				confidence: args.confidence ?? .5,
				status: args.status ?? "confirmed"
			});
			return {
				id: write.nodeId,
				type: args.type,
				value: args.value,
				...write.edge !== void 0 ? { edgeId: write.edge.id } : {}
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_state",
		description: "Read the current src state for this session: goal, node counts, and short node/asset listings. Call this to decide the next exploration step.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					initialized: {
						type: "boolean",
						required: true
					},
					goal: {
						type: "object",
						additionalProperties: true,
						properties: {}
					},
					counts: {
						type: "object",
						additionalProperties: true,
						properties: {}
					},
					intents: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					facts: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					findings: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					checkpoints: { type: "array", required: true, items: { type: "object", additionalProperties: true, properties: {} } },
					assets: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					},
					apiDiscovery: { type: "object", additionalProperties: true, properties: {} },
					coverage: { type: "array", required: true, items: { type: "object", additionalProperties: true, properties: {} } },
					research: { type: "array", required: true, items: { type: "object", additionalProperties: true, properties: {} } },
					observations: { type: "array", required: true, items: { type: "object", additionalProperties: true, properties: {} } },
					userTodos: { type: "array", required: true, items: { type: "object", additionalProperties: true, properties: {} } },
					infra: { type: "object", additionalProperties: true, properties: {} },
					edges: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {}
						}
					}
				}
			},
			render: (_a, v) => {
				const view = v;
				if (!view.initialized || view.goal === void 0) return [{
					type: "text",
					text: "Not initialized. Call src_add_goal with target and objective."
				}];
				const goal = view.goal;
				const join = (rows) => rows.join("; ") || "none";
				const api = view.apiDiscovery ?? { total: 0, schemas: 0, graphql: 0, hints: 0, untouched: 0, examples: [] };
				const pendingTodos = (view.userTodos ?? []).filter((row) => row.status === "pending");
				const todoNote = pendingTodos.length ? ` Pending user todos (${pendingTodos.length}): ${pendingTodos.map((row) => `${row.id}「${row.title}」`).join("; ")}.` : "";
				return [{
					type: "text",
					text: `Target: ${goal.target} | Objective: ${goal.objective} | ${view.counts.intents} intents, ${view.counts.facts} facts, ${view.counts.findings} findings, ${view.counts.assets} assets. API discovery: total=${api.total}, schemas=${api.schemas}, graphql=${api.graphql}, hints=${api.hints}, untouched=${api.untouched}${api.examples?.length ? `, examples=${api.examples.join(", ")}` : ""}. Intents: ${join(view.intents.map((i) => `${i.id}「${i.title}」`))}. Facts: ${join(view.facts.map((f) => `${f.id} [${f.kind}] ${f.detail}`))}. Findings: ${join(view.findings.map((f) => `${f.id} [${f.severity}] ${f.title}`))}. Assets: ${join(view.assets.map((a) => `${a.id} [${a.type}] ${a.value}`))}.${todoNote}`
				}];
			}
		},
		presentResult: (_args, result) => titledCard("SRC 漏洞挖掘状态", result),
		execute: async (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			const view = await store.view(sessionId);
			const coverage = view.coverage ?? [];
			const research = view.research ?? [];
			const apiAssets = (view.assets ?? []).filter((asset) => asset.type === "endpoint" && typeof asset.meta === "string" && asset.meta.startsWith("api:"));
			const untouched = apiAssets.filter((asset) => {
				const assetCoverage = coverage.filter((row) => row.assetId === asset.id);
				const hasProgress = assetCoverage.some((row) => ["running", "completed", "blocked", "not-applicable"].includes(row.status));
				const assetResearch = research.filter((row) => (row.evidence ?? []).some((evidence) => evidence.includes(asset.value)) || row.hypothesis.includes(asset.value));
				const hasManualResearchProgress = assetResearch.some((row) => row.status !== "hypothesis" || !(row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				return !hasProgress && !hasManualResearchProgress;
			});
			return {
				...view,
				apiDiscovery: {
					total: apiAssets.length,
					schemas: apiAssets.filter((asset) => asset.meta.startsWith("api:openapi-schema") || asset.meta.startsWith("api:schema-path")).length,
					graphql: apiAssets.filter((asset) => asset.meta.startsWith("api:graphql-endpoint")).length,
					hints: apiAssets.filter((asset) => asset.meta.startsWith("api:html-js-hint")).length,
					untouched: untouched.length,
					examples: apiAssets.slice(0, 5).map((asset) => asset.value)
				}
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_graph",
		description: "Dump the full exploration graph of this session as JSON: goal, intents, facts, findings, assets, and every edge (spawns / yields / derived_from / proves / parent). Use this to review the chain before reporting.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { graph: {
					type: "object",
					additionalProperties: true,
					properties: {}
				} }
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v.graph)
			}]
		},
		presentResult: (_args, result) => titledCard("SRC 探索图", result),
		execute: async (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			return { graph: buildGraph(await store.view(sessionId)) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_finalize_engagement",
		description: "Run the SRC pre-report acceptance gate. It checks intent completion, unresolved protection decisions, finding evidence, verification coverage, pending user todos, and remaining derivable directions. It does not hide limitations and does not submit to a platform.",
		parameters: {
			remainingDirections: { type: "array", required: true, description: "收官自查（必填）：调用前逐项枚举当前还能推进的方向（未完成的假设、停在自动骨架的资产、未派生假设的事实、可开的新 intent）。非空数组会被拒绝——先把方向建成 intent 推进；确已穷尽传 []。与 blindSpots 切干净：这里是同类面内还能推进的动作；blindSpots 是结构性没碰的类别。", items: { type: "string" } },
			blindSpots: { type: "array", required: true, description: "覆盖维度声明（必填）：逐项声明本目标适用的覆盖维度及其状态，让结构性盲区可见。期望维度 = 基线【http-authz-surface/cors-headers/dom-xhr/dict-budget/multi-account-cross-authz】∪ 信号派生（wss 资产→websocket；app/mini-program 资产→mobile-api）；厂商规则排除的维度传 notApplicable。每项 {dimension, status, note?, evidenceId?}。缺项被拒；covered 必须带可解析的 evidenceId（指向真实 fact/finding/intent/research 的 id），否则被拒；uncovered 的可行动盲区同回合建 src_user_todo。", items: { type: "object", additionalProperties: false, properties: { dimension: { type: "string", required: true }, status: { type: "string", enum: ["covered", "uncovered", "notApplicable"], required: true }, note: { type: "string" }, evidenceId: { type: "string", description: "covered 必填：指向真实 fact/finding/intent/research 的 id，服务端校验存在性。" } } } },
			allowIncomplete: { type: "boolean", description: "Set true only when the report must document explicit limitations or a human interruption." },
			allowIncompleteReason: { type: "string", description: "Required when allowIncomplete=true. Why the engagement must stop with limitations (e.g. WAF blocked all probes, scope exhausted, user-directed stop). Recorded verbatim into the report as a declaration row." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { ready: { type: "boolean", required: true }, blockers: { type: "array", required: true }, warnings: { type: "array", required: true } } }, render: (_a, v) => [{ type: "text", text: `${v.ready ? "SRC engagement ready for report." : `SRC report blockers: ${v.blockers.join("; ")}`} ${v.warnings.length ? `Warnings: ${v.warnings.join("; ")}` : ""}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const view = await store.view(sessionId);
			if (view.goal === void 0) throw new Error("src_finalize_engagement requires an initialized SRC goal");
			let incompleteReason = "";
			if (args.allowIncomplete === true) {
				incompleteReason = typeof args.allowIncompleteReason === "string" ? args.allowIncompleteReason.trim() : "";
				if (incompleteReason === "") throw new Error("allowIncomplete=true 时必须提供 allowIncompleteReason（说明为何带限制出报告：WAF 全程拦截/范围耗尽/用户指示停止等）；该声明会作为 coverage 行写入报告的「资产与测试覆盖率」一节");
				const record = await store.upsertCoverage(sessionId, { assetId: void 0, phase: "report", category: "受限完成声明", status: "not-applicable", evidence: [], limitation: incompleteReason });
				if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_record_coverage", { id: record.id, phase: "report", category: "受限完成声明", status: "not-applicable", evidence: [], limitation: incompleteReason, updatedAt: record.updatedAt });
			}
			const blockers = [];
			const warnings = [];
			/* [local.20] 收官三闸：remainingDirections 枚举 / pending 待办 / blocked 无待办。 */
			const directions = Array.isArray(args.remainingDirections) ? args.remainingDirections.filter((d) => typeof d === "string" && d.trim() !== "") : null;
			if (directions === null) throw new Error("src_finalize_engagement 需要 remainingDirections 参数（收官自查）：逐项列出当前还能推进的方向；确已穷尽传空数组 []。非空会被拒绝——先把方向建成 intent 推进再回来");
			if (directions.length > 0) blockers.push(`你列出了 ${directions.length} 个可继续推进的方向却要求收官——先把它们建成 intent 并委派执行，或逐项说明为何不可行后从列表删除重试: ${directions.slice(0, 5).join("; ")}`);
			/* [local.22] 覆盖维度声明闸（blindSpots）：期望维度必须全声明；covered 必须带可解析证据。 */
			const blindSpots = Array.isArray(args.blindSpots) ? args.blindSpots : null;
			if (blindSpots === null) throw new Error("src_finalize_engagement 需要 blindSpots 参数（覆盖维度声明）：逐项声明适用维度的 covered/uncovered/notApplicable；期望维度 = 基线 http-authz-surface/cors-headers/dom-xhr/dict-budget/multi-account-cross-authz ∪ 信号派生（wss 资产→websocket；app/mini-program 资产→mobile-api）。缺项被拒，covered 必须带可解析的 evidenceId");
			const BS_STATUS_MAP = { covered: "completed", uncovered: "blocked", notApplicable: "not-applicable" };
			const declaredDims = /* @__PURE__ */ new Set();
			const validBlindSpots = [];
			for (const entry of blindSpots) {
				if (entry === null || typeof entry !== "object") continue;
				const dimension = typeof entry.dimension === "string" ? entry.dimension.trim() : "";
				const status = entry.status;
				if (dimension === "" || !["covered", "uncovered", "notApplicable"].includes(status)) continue;
				declaredDims.add(dimension);
				const evidenceId = typeof entry.evidenceId === "string" ? entry.evidenceId.trim() : "";
				validBlindSpots.push({ dimension, status, note: typeof entry.note === "string" ? entry.note : "", evidenceId });
			}
			/* 期望维度 = 基线 ∪ 信号派生（从投影资产）。 */
			const BLIND_SPOT_BASELINE = ["http-authz-surface", "cors-headers", "dom-xhr", "dict-budget", "multi-account-cross-authz"];
			const expectedDims = new Set(BLIND_SPOT_BASELINE);
			for (const asset of (view.assets ?? [])) {
				const v = (asset.value ?? "").toLowerCase();
				if (/^wss:\/\//.test(v) || asset.type === "endpoint" && /\bws\b|websocket/.test(v)) expectedDims.add("websocket");
				if (asset.type === "app" || asset.type === "mini-program") expectedDims.add("mobile-api");
			}
			const missingDims = [...expectedDims].filter((d) => !declaredDims.has(d));
			if (missingDims.length > 0) blockers.push(`覆盖维度声明缺项：以下适用维度未声明状态（期望 covered/uncovered/notApplicable）：${missingDims.join(", ")}。盲区必须显式可见，不许默认跳过`);
			/* covered 必须带可解析 evidenceId。 */
			const evidenceExists = (id) => {
				if (id === "") return false;
				if ((view.intents ?? []).some((n) => n.id === id)) return true;
				if ((view.facts ?? []).some((n) => n.id === id)) return true;
				if ((view.findings ?? []).some((n) => n.id === id)) return true;
				if ((view.research ?? []).some((r) => r.id === id)) return true;
				return false;
			};
			const noEvidence = validBlindSpots.filter((b) => b.status === "covered" && !evidenceExists(b.evidenceId));
			if (noEvidence.length > 0) blockers.push(`以下维度标 covered 但 evidenceId 缺失或不可解析（必须指向真实 fact/finding/intent/research 的 id）：${noEvidence.map((b) => `${b.dimension}(${b.evidenceId === "" ? "无 evidenceId" : b.evidenceId})`).join(", ")}。「以为测到了」比「没测到」更危险——请提供证据指针或改标 uncovered 并说明原因`);
			/* 启发式警告：wss 资产存在但无相关研究/覆盖记录，提示可能漏测。 */
			if (expectedDims.has("websocket")) {
				const wsResearch = (view.research ?? []).some((r) => /websocket|ws\b/i.test(r.hypothesis)) || (view.coverage ?? []).some((c) => /websocket|ws\b/i.test(c.category));
				const wsEntry = validBlindSpots.find((b) => b.dimension === "websocket");
				if (wsEntry && wsEntry.status === "covered" && !wsResearch) warnings.push(`websocket 维度标 covered 但找不到对应研究/覆盖记录——确认 evidenceId 指向的是真正的 WebSocket 测试证据`);
			}
			/* uncovered 可行动盲区 → 提示同回合建待办（多账号场景是已知高频项）。 */
			const actionableUncovered = validBlindSpots.filter((b) => b.status === "uncovered" && b.dimension === "multi-account-cross-authz");
			if (actionableUncovered.length > 0) {
				const hasAccountTodo = (view.userTodos ?? []).some((t) => /账号|account|越权.*对照|第二.*账号/i.test(t.title + " " + t.detail));
				if (!hasAccountTodo) warnings.push(`multi-account-cross-authz 标 uncovered（缺多账号无法测垂直越权/租户隔离）但未建对应 src_user_todo——请同回合建待办请求用户提供第二测试账号，而非只写进报告尾节`);
			}
			/* 持久化 blindSpots 为 coverage 行（phase=blind-spot，复用现有表免迁移）。 */
			for (const b of validBlindSpots) {
				const record = await store.upsertCoverage(sessionId, { assetId: void 0, phase: "blind-spot", category: b.dimension, status: BS_STATUS_MAP[b.status], evidence: b.evidenceId !== "" ? [b.evidenceId] : [], limitation: b.note });
				if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_record_coverage", { id: record.id, phase: "blind-spot", category: b.dimension, status: BS_STATUS_MAP[b.status], evidence: b.evidenceId !== "" ? [b.evidenceId] : [], limitation: b.note, updatedAt: record.updatedAt });
			}
			const unfinished = view.intents.filter((intent) => !["completed", "blocked"].includes(intent.status));
			if (unfinished.length) blockers.push(`未完成 intent: ${unfinished.map((intent) => `${intent.id}/${intent.title}`).join(", ")}`);
			const plannedStale = view.intents.filter((intent) => intent.status === "planned" && !(view.checkpoints ?? []).some((c) => c.intentId === intent.id));
			if (plannedStale.length) warnings.push(`以下 intent 从未委派执行（长期停在 planned，需显式委派或转 cancelled）: ${plannedStale.map((intent) => `${intent.id}/${intent.title}`).join(", ")}`);
			const failed = view.intents.filter((intent) => intent.status === "failed");
			if (failed.length) blockers.push(`失败 intent 未处理: ${failed.map((intent) => intent.id).join(", ")}`);
			if (view.goal.authorization === "" && !view.findings.some((f) => f.severity === "critical" || f.severity === "high")) warnings.push("未记录授权说明（SRC 平台注册默认已授权，可忽略）");
			if (view.findings.length === 0) warnings.push("没有确认的 finding，报告将主要记录侦察结果和限制");
			const pendingTodos = (view.userTodos ?? []).filter((todo) => todo.status === "pending");
			if (pendingTodos.length) blockers.push(`存在 ${pendingTodos.length} 个未完成的用户待办（${pendingTodos.map((todo) => `${todo.id}:${todo.title}`).join(", ")}）：有等待用户的操作就不算穷尽——除非其他方向已全部穷尽且确需带限制出报告（传 allowIncomplete），否则应继续推进或等待回注后再收官`);
			const blockedIntents = view.intents.filter((intent) => intent.status === "blocked");
			if (blockedIntents.length && (view.userTodos ?? []).length === 0) blockers.push(`以下 intent 标记为 blocked 但从未创建任何用户待办——若阻塞源于缺用户输入（登录态/资产/人工操作），必须先建 src_user_todo（intentId 关联）再收官；若与技术相关请在 coverage limitation 写明依据: ${blockedIntents.map((intent) => `${intent.id}/${intent.title}`).join(", ")}`);
			else if (blockedIntents.length) {
				for (const intent of blockedIntents) {
					const linked = (view.userTodos ?? []).some((todo) => todo.intentId === intent.id || todo.status === "done" || new RegExp(intent.title.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(`${todo.title} ${todo.detail}`));
					if (!linked) warnings.push(`blocked intent ${intent.id}/${intent.title} 没有找到关联的用户待办：若它在等用户输入，请补建 src_user_todo 并用 intentId 关联；若非用户依赖请在 coverage limitation 写明依据`);
				}
			}
			const coverage = view.coverage ?? [];
			if (coverage.length === 0) warnings.push("没有覆盖率记录，无法证明测试范围完整性");
			const incompleteCoverage = coverage.filter((row) => ["planned", "running", "blocked"].includes(row.status));
			if (incompleteCoverage.length) warnings.push(`存在 ${incompleteCoverage.length} 项未完成或受阻的覆盖记录`);
			const research = view.research ?? [];
			const discoveryEndpoints = (view.assets ?? []).filter((asset) => asset.type === "endpoint" && ((asset.meta ?? "").startsWith("api:") || /(openapi|graphql|schema-path|html-js-hint)/i.test(asset.meta ?? "")));
			const untouchedEndpoints = discoveryEndpoints.filter((asset) => {
				const assetCoverage = coverage.filter((row) => row.assetId === asset.id);
				const hasProgress = assetCoverage.some((row) => ["running", "completed", "blocked", "not-applicable"].includes(row.status));
				const assetResearch = research.filter((row) => (row.evidence ?? []).some((evidence) => evidence.includes(asset.value)) || row.hypothesis.includes(asset.value));
				const hasManualResearchProgress = assetResearch.some((row) => row.status !== "hypothesis" || !(row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				return !hasProgress && !hasManualResearchProgress;
			});
			const autoOnlyEndpoints = discoveryEndpoints.filter((asset) => {
				const assetCoverage = coverage.filter((row) => row.assetId === asset.id);
				const assetResearch = research.filter((row) => (row.evidence ?? []).some((evidence) => evidence.includes(asset.value)) || row.hypothesis.includes(asset.value));
				const onlyPlannedCoverage = assetCoverage.length > 0 && assetCoverage.every((row) => row.status === "planned" && (row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				const onlyAutoResearch = assetResearch.length > 0 && assetResearch.every((row) => row.status === "hypothesis" && (row.evidence ?? []).some((evidence) => evidence.startsWith("auto-skeleton ")));
				return onlyPlannedCoverage && onlyAutoResearch;
			});
			if (untouchedEndpoints.length) blockers.push(`发现 ${untouchedEndpoints.length} 个 API/接口资产尚未进入研究或覆盖推进——收官前必须逐一推进（委派验证）或明确降级理由（传 allowIncomplete 并在 reason 中说明）: ${untouchedEndpoints.slice(0, 5).map((asset) => asset.value).join(", ")}`);
			if (autoOnlyEndpoints.length) blockers.push(`发现 ${autoOnlyEndpoints.length} 个 API/接口资产仍停留在自动生成骨架，尚无人工推进——收官前必须逐一验证或明确降级理由: ${autoOnlyEndpoints.slice(0, 5).map((asset) => asset.value).join(", ")}`);
			const openResearch = research.filter((row) => ["hypothesis", "testing"].includes(row.status));
			if (openResearch.length) blockers.push(`存在 ${openResearch.length} 个未完成漏洞研究假设`);
			const unverifiedFindings = view.findings.filter((finding) => !research.some((row) => row.status === "verified" && row.findingId === finding.id));
			if (unverifiedFindings.length) blockers.push(`finding 缺少独立 verified 研究记录: ${unverifiedFindings.map((finding) => finding.id).join(", ")}。须先委派 src_verify 子代理独立复核，并以 src_record_research(status=verified, findingId=…) 关联后再 finalize；确需带限制停止则传 allowIncomplete=true 并附 allowIncompleteReason`);
			const mediumPlusFindings = view.findings.filter((f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium");
			if (view.findings.length > 0 && mediumPlusFindings.length === 0) warnings.push("仅存在 info/low 。 finding：若危害论证充分（如版本暴露→匹配已知 CVE 定向利用）可直接出报告；建议继续推进越权/注入/逻辑等验证类漏洞提高收录率");
			const thinImpact = view.findings.filter((finding) => (finding.impact ?? "").trim().length < 40);
			if (thinImpact.length) warnings.push(`以下 finding 的 impact 危害论证过短（<40字），可能缺少具体利用场景（攻击者怎么构造、拿到什么、危害谁），建议补全后再出报告: ${thinImpact.map((finding) => finding.id).join(", ")}`);
			const thinVictim = view.findings.filter((finding) => (finding.victimImpact ?? "").trim().length < 30);
			if (thinVictim.length) warnings.push(`以下 finding 缺少受害者视角危害（victimImpact <30字）：报告需按攻击者/受害者双视角呈现——谁受害、损失什么、是否可察觉: ${thinVictim.map((finding) => finding.id).join(", ")}`);
			try {
				const distilled = await sessionLessons(sessionId);
				if (view.findings.length > 0 && distilled.length === 0) warnings.push("本次会话有 finding 但未沉淀任何经验（src_record_lesson）：若验证套路或人工引导修正有可复用价值，请先沉淀再出报告，供后续同类漏洞直接复用");
			} catch {}
			const missingRaw = view.findings.filter((finding) => (finding.rawRequest ?? "").trim() === "");
			if (missingRaw.length) blockers.push(`finding 缺少 Burp 格式 rawRequest（数据包必填）: ${missingRaw.map((finding) => finding.id).join(", ")}`);
			const checkpoints = view.checkpoints ?? [];
			if (checkpoints.some((checkpoint) => checkpoint.stage === "failed")) blockers.push("存在失败的 child checkpoint");
			for (const finding of view.findings) {
				const hasCheckpoint = checkpoints.some((c) => c.intentId === finding.intentId);
				if (!hasCheckpoint) warnings.push(`finding ${finding.id} 所在 intent ${finding.intentId} 无子 agent checkpoint，疑为主 agent 自干验证，证据链不完整`);
			}
			const ready = blockers.length === 0 || args.allowIncomplete === true;
			if (args.allowIncomplete === true && blockers.length > 0) warnings.push(`已按「受限完成」处理 ${blockers.length} 项阻断项，声明已写入报告: ${incompleteReason}`);
			return { ready, blockers, warnings };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_report",
		description: "Generate the final Markdown report for this session: goal, the exploration chain (goal → intents → facts → derived intents → findings), every vulnerability with its reproducible steps, and the asset graph. Call this when the engagement is done.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { markdown: {
					type: "string",
					required: true
				} }
			},
			render: (_a, v) => [{
				type: "text",
				text: v.markdown
			}]
		},
		presentResult: (_args, result) => titledCard("SRC 漏洞挖掘报告", result),
		execute: async (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			let markdown = buildReport(await store.view(sessionId));
			/* [local.16] Append the lessons distilled by this session (skill-style md files). */
			try {
				const lessons = await sessionLessons(sessionId);
				if (lessons.length > 0) markdown += "\n## 本次沉淀的经验（src_read_lesson 可读全文）\n" + lessons.map((row) => `- ${row.title}（id=${JSON.stringify(row.file)}，类型：${row.vulnType}）`).join("\n") + "\n";
			} catch {}
			return { markdown };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_update_finding",
		description: "重写一个已确认 finding 的字段（仅更新传入的字段），更新直接落库并实时反映在面板漏洞列表与报告里——人工引导后的修订一律走本工具，不要把修订内容写到本地文件或只在回复文本里复述。重点重写 impact/victimImpact/pocEvidence/reproducibleSteps/rawRequest，改完重新 src_report；禁止靠新增重复 finding 覆盖。",
		parameters: {
			findingId: { type: "string", required: true, description: "要修订的 finding id（先 src_state 查看）。" },
			title: { type: "string", description: "新标题（不得与其他 finding 重名）。" },
			severity: { type: "string", enum: SEVERITIES, description: "新严重级别。" },
			description: { type: "string", description: "漏洞描述：清楚说明漏洞是什么、在什么接口产生。" },
			impact: { type: "string", description: "攻击者视角利用场景：怎么构造、拿到什么、危害谁，≥40字。" },
			victimImpact: { type: "string", description: "受害者视角危害：谁受害、损失什么、是否可察觉，≥30字。" },
			affectedScope: { type: "string", description: "影响范围。" },
			remediation: { type: "string", description: "修复建议。" },
			entryPoint: { type: "string", description: "前端功能点。" },
			discoveryPath: { type: "string", description: "接口来源链。" },
			rawRequest: { type: "string", description: "Burp 格式 raw 请求报文。" },
			rawResponse: { type: "string", description: "关键响应 raw 报文。" },
			pocEvidence: { type: "array", items: { type: "string" }, description: "补充 POC 证据（整体替换）。" },
			reproducibleSteps: { type: "array", items: { type: "string" }, description: "复现步骤（整体替换，至少一条）。" },
			affectedAssetId: { type: "string", description: "影响资产 id；传空字符串解除关联。" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, updated: { type: "array", items: { type: "string" }, required: true } } },
			render: (_a, v) => [{ type: "text", text: `已重写 ${v.id} 的 ${v.updated.length} 个字段：${v.updated.join(", ")}。修订已落库，面板漏洞列表与报告即时生效。` }]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const patch = {};
			for (const key of ["title", "severity", "description", "impact", "victimImpact", "affectedScope", "remediation", "entryPoint", "discoveryPath", "rawRequest", "rawResponse"]) if (typeof args[key] === "string") patch[key] = args[key];
			if (Array.isArray(args.pocEvidence)) patch.pocEvidence = args.pocEvidence.filter((item) => typeof item === "string" && item !== "");
			if (Array.isArray(args.reproducibleSteps) && args.reproducibleSteps.filter((step) => typeof step === "string" && step !== "").length === 0) throw new Error("reproducibleSteps 不能清空为 0 条——漏洞必须有可复现步骤");
			if (Array.isArray(args.reproducibleSteps)) patch.reproducibleSteps = args.reproducibleSteps.filter((step) => typeof step === "string" && step !== "");
			if (typeof args.affectedAssetId === "string") patch.affectedAssetId = args.affectedAssetId;
			if (Object.keys(patch).length === 0) throw new Error("没有提供任何要更新的字段");
			await store.updateFinding(sessionId, requiredString(args.findingId, "findingId"), patch);
			/* Synthetic tool/call keeps the projection fold in sync with the direct write. */
			if (exec.agent !== void 0) appendSessionToolEvent(exec.agent.session, "src_update_finding", { ...patch, findingId: args.findingId });
			return { id: String(args.findingId), updated: Object.keys(patch) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_record_lesson",
		description: "沉淀一条漏洞挖掘经验到经验库（markdown 文件，跨会话永久生效）：同类漏洞以后都按这个套路验证。触发时机：① finding 达到 SRC 收录标准后 ② 经人工引导从“不收”变“收录”后（必须沉淀 before/after 差异）③ 验证中发现关键绕过/证据技巧时。同类型已有文件则合并更新而非新建。",
		parameters: {
			id: { type: "string", description: "经验文件 slug（小写中划线，如 cors-origin-reflection）。同 id 已存在则更新合并该文件；省略则自动生成。" },
			vulnType: { type: "string", required: true, description: "漏洞类型标题（如「CORS 任意 Origin 反射 + Credentials」）。" },
			scenario: { type: "string", required: true, description: "触发场景/识别特征：什么目标上什么信号提示可以试这类漏洞。" },
			verificationPlaybook: { type: "string", required: true, description: "验证套路：分步写清怎么做（请求怎么构造、用什么工具、注意什么边界），后续同类型照此执行。" },
			acceptanceCriteria: { type: "string", required: true, description: "收录标准：满足什么才算达到 SRC 收录标准（危害论证要点、必要证据）。" },
			pitfalls: { type: "string", description: "常见误判/被拒原因：为什么最初不收、缺了什么、怎么补才收（before/after 对比）。" },
			keyEvidence: { type: "string", description: "必抓证据清单（如双向 Origin 头回显截图+Credentials=true 响应头）。" },
			sourceFindingTitle: { type: "string", description: "来源 finding 标题（可选，便于溯源）。" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, path: { type: "string", required: true }, updatedExisting: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: `${v.updatedExisting ? "已更新" : "已新建"}经验 ${v.id} → ${v.path}；今后建 goal 时会出现在索引里，同类漏洞直接 src_read_lesson 复用。` }]
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const slugBase = (typeof args.id === "string" && /^[-a-z0-9]{3,64}$/.test(args.id) ? args.id : `lesson-${Date.now()}`).replace(/[^-a-z0-9]/g, "-").slice(0, 64);
			const dir = lessonsDataDir();
			let slug = slugBase;
			let existing = "";
			try {
				existing = await fsPromises.readFile(nodePath.join(dir, `${slug}.md`), "utf8");
			} catch {}
			if (existing === "" && typeof args.id !== "string") {
				/* Auto slug from vulnType when not provided; keep it stable for later merges. */
				const pinyinish = String(args.vulnType).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
				slug = pinyinish.length >= 3 ? pinyinish : slugBase;
				try { existing = await fsPromises.readFile(nodePath.join(dir, `${slug}.md`), "utf8"); } catch {}
			}
			await fsPromises.mkdir(dir, { recursive: true });
			const meta = JSON.stringify({ sessionId, vulnType: args.vulnType, sourceFindingTitle: typeof args.sourceFindingTitle === "string" ? args.sourceFindingTitle : "", createdAt: Date.now() });
			const body = [
				`# ${args.vulnType}`,
				"",
				`## 触发场景`,
				args.scenario,
				"",
				`## 验证套路`,
				args.verificationPlaybook,
				"",
				`## 收录标准`,
				args.acceptanceCriteria,
				"",
				...(typeof args.pitfalls === "string" && args.pitfalls !== "" ? [`## 常见误判与被拒原因`, args.pitfalls, ""] : []),
				...(typeof args.keyEvidence === "string" && args.keyEvidence !== "" ? [`## 必抓证据`, args.keyEvidence, ""] : []),
				...(typeof args.sourceFindingTitle === "string" && args.sourceFindingTitle !== "" ? [`> 来源：${args.sourceFindingTitle}`, ""] : []),
				`<!-- lesson-meta: ${meta} -->`,
				""
			].join("\n");
			await fsPromises.writeFile(nodePath.join(dir, `${slug}.md`), body, "utf8");
			return { id: slug, path: nodePath.join(dir, `${slug}.md`), updatedExisting: existing !== "" };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_read_lesson",
		description: "读一篇经验全文（内置方法论或沉淀经验；沉淀版优先于同名内置版）。开测前对索引里的同类条目先读再验证。",
		parameters: { id: { type: "string", required: true, description: "经验文件 id（来自 goal 返回的索引或 src_search_lessons）。" } },
		output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, source: { type: "string", required: true }, text: { type: "string", required: true } } }, render: (_a, v) => [{ type: "text", text: `[${v.source}] ${v.text}` }] },
		execute: async (args, exec) => {
			const { text, source } = await readLessonFile(String(args.id));
			return { id: String(args.id), source, text };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_search_lessons",
		description: "按关键词搜经验库（内置+沉淀，返回匹配的标题与命中行）。开始验证一类不确定怎么证的漏洞前先搜一次。",
		parameters: { query: { type: "string", required: true, description: "关键词（如 CORS / 短信 / 越权 / apk）。" } },
		output: { schema: { type: "object", additionalProperties: false, properties: { hits: { type: "array", items: { type: "object", additionalProperties: true, properties: {} }, required: true } } }, render: (_a, v) => [{ type: "text", text: v.hits.length === 0 ? `经验库无「${String(_a?.query ?? "")}」相关条目。` : v.hits.map((hit) => `- ${hit.title}（${hit.source}${hit.overrides === true ? "，覆盖内置" : ""}）：${hit.snippet}`).join("\n") }] },
		execute: async (_args, exec) => {
			const query = String(_args.query ?? "").trim().toLowerCase();
			const hits = [];
			if (query !== "") {
				for (const row of await listAllLessons()) {
					try {
						const text = await fsPromises.readFile(nodePath.join(row.dir, `${row.file}.md`), "utf8");
						const line = text.split("\n").find((candidate) => candidate.toLowerCase().includes(query));
						if (line !== void 0 || row.title.toLowerCase().includes(query)) hits.push({ file: row.file, title: row.title, source: row.source, ...(row.overrides === true ? { overrides: true } : {}), snippet: (line ?? row.title).trim().slice(0, 160) });
					} catch {}
				}
			}
			return { hits: hits.slice(0, 20) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_serve_proof",
		description: "在本机起一个受控 HTTP 服务器托管 POC 页面/载荷（把本机局域网 IP 当受控 VPS 用），并记录所有访问作为 OOB 回连证据。用于 XSS 打码、CSRF、SSRF 回连、盲打等需要外部可达 URL 的场景。返回 http://<局域网IP>:<port>/<filename>。服务会在 TTL 到期、goal 重置或插件卸载时自动关闭——POC 验证完成后应立即用 src_stop_serve 显式关闭并取回访问日志。",
		parameters: {
			payload: { type: "string", required: true, description: "要托管的完整内容（HTML/JS/文本，≤200KB）。如 XSS POC 页、SSRF 探针 URL 列表。" },
			filename: { type: "string", description: "路径文件名（默认 poc.html）；访问 URL 即 http://<ip>:<port>/<filename>。任意路径都返回同一内容并记入日志。" },
			contentType: { type: "string", description: "Content-Type（默认 text/html; charset=utf-8）。" },
			ttlSeconds: { type: "number", description: "存活秒数，默认 3600，上限 86400，到期自动关闭。" }
		},
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: `POC 服务已就绪：${v.url}\n访问日志将在 src_stop_serve 时返回（当前 ${v.hits} 条）。TTL ${Math.round(v.ttlSeconds)}s 到期自动关闭。诱导目标访问该 URL 即可记录回连证据。` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const payload = Buffer.from(String(args.payload ?? ""), "utf8");
			if (payload.length === 0) throw new Error("payload 不能为空");
			if (payload.length > 200 * 1024) throw new Error("payload 过大（≤200KB）——POC 页面应最小化");
			const filename = (() => {
				const raw = String(args.filename ?? "poc.html").replace(/^\/+/, "");
				const safe = nodePath.basename(raw);
				return safe === "" || safe === "." ? "poc.html" : safe;
			})();
			const contentType = /^[\w.+-]+\/[-\w.+]+(?:;\s*[\w-]+=[^\r\n;]*)*$/.test(String(args.contentType ?? "text/html; charset=utf-8").trim()) ? String(args.contentType).trim() : "text/html; charset=utf-8";
			const ttlSeconds = Math.min(Math.max(Number(args.ttlSeconds) || 3600, 10), 86400);
			const server = httpCreateServer((_req, res) => {
				if (entry.hits.length < 1000) entry.hits.push({ at: new Date().toISOString(), ip: _req.socket.remoteAddress ?? "", ua: String(_req.headers["user-agent"] ?? "").slice(0, 300), path: (_req.url ?? "/").slice(0, 500) });
				res.writeHead(200, { "content-type": contentType, "access-control-allow-origin": "*" });
				res.end(payload);
			});
			const entry = { sessionId, ...(exec.agent?.session.header?.parentSession !== void 0 ? { parentSessionId: exec.agent.session.header.parentSession } : {}), server, timer: void 0, hits: [], meta: { filename, contentType, ttlSeconds } };
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "0.0.0.0", resolve);
			});
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			const serveId = `serve-${sessionId}-${port}`;
			liveProofServers.set(serveId, entry);
			entry.timer = setTimeout(() => { liveProofServers.delete(serveId); server.close(); }, ttlSeconds * 1000);
			entry.timer.unref?.();
			return {
				serveId,
				url: `http://${lanIPv4()}:${port}/${filename}`,
				ttlSeconds,
				hits: 0
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "src_stop_serve",
		description: "关闭一个 POC 托管服务器并取回完整访问日志（时间/来源IP/UA/路径）——这是 SSRF/XSS/盲打类漏洞的回连证据，随 src_submit 一并提交。POC 验证完成后立即调用，不留常驻服务。",
		parameters: { serveId: { type: "string", required: true, description: "src_serve_proof 返回的 serveId。" } },
		output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: "text", text: v.stopped !== true ? `未找到运行中的服务 ${String(v.serveId)}（可能已到期自动关闭）。` : `已关闭 ${v.serveId}，共 ${v.hits.length} 次访问：\n${v.hits.length === 0 ? "（无访问记录）" : v.hits.map((hit) => `${hit.at} ${hit.ip} ${hit.path} [${hit.ua}]`).join("\n")}` }] },
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			const serveId = requiredString(args.serveId, "serveId");
			const meta = await closeProofServer(sessionId, serveId);
			if (meta === void 0) return { serveId, stopped: false, hits: [] };
			return { serveId, stopped: true, hits: meta.hits };
		}
	}));
}
//#endregion
//#region src/index.ts
/** Plugin identity. */
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
const TODO_FEEDBACK_USAGE = "用法：/src-todo <todoId> <done|abandoned|pending> [备注]，如 /src-todo todo-2 done 已用 Burp 抓包";
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
	if (!/^todo-\d+$/.test(userTodoId)) return { ok: false, error: `待办 id "${userTodoId}" 不合法。` + TODO_FEEDBACK_USAGE };
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
				const record = await store.setInfra(invocation.agent.session.id, key, value);
				/* Synthetic tool/call keeps the projection fold in sync with the direct write. */
				invocation.agent.session.append("tool/call", { name: "src_set_infra", arguments: JSON.stringify({ key, value }) });
				const cleared = value === "";
				return { kind: "success", text: `已${cleared ? "清空并恢复默认" : "保存"} ${key}${cleared ? `（当前生效值：${record.value === "" ? "空" : record.value}）` : `=${record.value}`}，立即生效；agent 下次执行相关测试时会通过 src_get_infra 读取最新值。` };
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
				for (const key of keys) {
					await store.setInfra(sessionId, key, source.overrides[key]);
					invocation.agent.session.append("tool/call", { name: "src_set_infra", arguments: JSON.stringify({ key, value: source.overrides[key] }) });
				}
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
		description: "Burp MCP 连通性测试：先 TCP 探测 Burp 端口，再做 SSE 握手验证扩展端点可达，然后请 agent 经自愈桥做一次真实 tools/list + 工具调用端到端验证。",
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
					content: [{ type: "text", text: `【Burp MCP 连通性测试】服务端探测全部通过：①TCP 127.0.0.1:${port} 可达（${elapsed}ms）②MCP SSE 端点 http://127.0.0.1:${port}${sse.path} 握手成功（HTTP 200 text/event-stream，${sse.elapsed}ms${sse.preview !== "" ? `，首包：${sse.preview}` : ""}）。请立即调用 mcp__burp__tools_list 确认工具清单已加载（应含 get_proxy_http_history 等 27 个工具），再调 mcp__burp__get_proxy_http_history（count 取 5, offset 0）做端到端验证并如实汇报：成功则报告当前代理历史条数；失败给出错误原文与排查建议（dsh web 是否在自愈桥更新后重启过、Burp 扩展是否 Start）。全程中文，不要臆测结果。` }],
					source: { kind: "user" }
				}));
				return { kind: "success", text: `①端口 127.0.0.1:${port} 可达（${elapsed}ms）②SSE 握手通过（HTTP 200，${sse.elapsed}ms）。注意：该直探只证明扩展端点活着——完整链路还要经 dsh 的自愈桥（burp-mcp-bridge），已请 agent 做 tools/list + 真实调用端到端验证，结果会出现在对话里。` };
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
			stateVersion: 8
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
export { __resetSharedDomainOpensForTests, apply, inject, name, applySrcEvent, parseTodoFeedback, srcAssetSchema, srcAssetTypeSchema, srcDomainSpec, srcEdgeKindSchema, srcEdgeSchema, srcFactKindSchema, srcFactSchema, srcFindingSchema, srcGoalSchema, srcIntentSchema, srcSeveritySchema, srcInitialState, viewSrcState };
