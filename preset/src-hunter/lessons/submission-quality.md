# 提交质量与低价值类别门槛

## 触发场景
提交任何 finding 前；以及收到「找到 N 个漏洞即停止」类数量目标指令时。

## 危害链三要素（medium+ 准入闸，服务端强制）
1. **攻击者能力**（impact）：在什么域构造什么页面/请求，能做什么；
2. **受害者交互**（victimImpact）：谁受害、要做什么或完全无交互、损失什么、是否可察觉；
3. **实际损失证据指针**（concreteLossEvidence）：指向含敏感响应体或外带记录的真实 fact/observation/research id。

准入标准是 #11b：未授权可达 + 可复现 PoC 即 low 起评入库，不因「没拿到损失实锤」停在 fact 态；三要素是 medium 及以上的强制条件，也是 low 的升危依据（组合出实际损失证据时升 medium+）。写不出受害者交互、或前提出现「任意外域」而厂商要求自有域时闸会拒绝——此时正确动作是 research(false-positive) 或 user_todo，不要绕。

## 低价值类别默认门槛（默认不独立成 finding）
- **Clickjacking**：仅当被嵌页面有一键敏感操作（转账/改绑/改密码/发帖）才成立；营销页/内容页/纯登录页嵌套一律不收。
- **纯安全头缺失**（XFO/CSP/HSTS/X-Content-Type-Options 单独存在）：不收，聚合为一条 hardening research。
- **报错页信息罗列**（堆栈/版本号）：除非匹配已知 CVE 并论证定向利用路径，否则是 fact 不是 finding。
- **Cookie flag 缺失**（Secure/SameSite）：需配套会话固定/窃取链才成立。
- **CORS 头反射**：必须登录态下拿到敏感 200 JSON + 浏览器 credentials:include 实读证明（见 cors 课程）。

## 数量目标纪律
数量目标是**产出上限不是 KPI**：「找到三个就停」=「最多三个合格的」。不合格交 0 个并如实说明阻塞原因（匿名面硬化/卡登录态/待办已挂），这是体面产出；绝不为凑数降标准。

## 打回闭环
打回（src_reject_finding，status=rejected + 备注）不是否定，是要求补强：打回不删除、留图供组合利用；按备注用 src_update_finding 补 attackChain（发现→利用前提→利用过程→实际损失→受害者影响闭合叙事）或一键 PoC 脚本；确为新链先补 attackChain 再说明差异，禁止同标题原样重提（准入闸拦相似二次提交）。

## 报告模板（美团 SRC 骨架）
4 字段（漏洞名称/漏洞类型/漏洞URL/漏洞级别）+ 风险详情四小节（描述&发现方式、利用及危害 / 详细复现证明 / 测试源信息 / 修复方案）；第 1 节是【攻击链】垂直五步，仅非空步骤。
- **vulnType**：类别名（「越权漏洞」「信息泄露」「短信轰炸」「SSRF」等）；**attackChain**：多跳/组合利用必填，有则原样呈现第 1 节。
- **rawRequest**：Burp 格式原始报文（含接口地址），第 2 节复现证明主体，空会被 finalize 闸拦；**pocScript**：可一键运行的 Python/Bash/curl，打回「写个脚本」时用 src_update_finding 补。
- **复现定位（厂商复现前置，不是装饰）**：web 漏洞必填 entryPoint（前端功能点，仅给接口不够）；app/小程序下载方式记资产 meta（报告自动出下载行）；需登录的在 attackPrerequisites 注明登录入口 URL。
- 测试源信息从 concreteLossEvidence 指针解析真实证据；打回的 finding 自动移入「已打回」节备查。

## 通用定级基准（小米四档；厂商公开规则优先，可从 vendor-policy fact 推导）
**严重**：直接获取系统权限/RCE/核心数据库数据。**高**：敏感数据泄露/重要业务越权。**中**：普通越权/一般信息泄露/短信轰炸/验证码爆破可利用。**低**：反射 XSS/一般未授权信息/轻微逻辑缺陷。impact 注明对应平台定级依据；找不到厂商规则按本基准。

<!-- lesson-meta: {"hook": "数量目标是上限不是 KPI；medium+ 必须三要素齐备，弱信号转 research/user_todo；报告按美团模板四字段+四小节", "triggers": {"tools": ["src_finalize_engagement", "src_submit"]}} -->
