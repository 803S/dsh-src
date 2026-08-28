# 提交质量与低价值类别门槛

## 触发场景
提交任何 finding 前；以及收到「找到 N 个漏洞即停止」类数量目标指令时。

## 危害链三要素（准入闸，服务端强制）
1. **攻击者能力**（impact）：在什么域构造什么页面/请求，能做什么；
2. **受害者交互**（victimImpact）：谁受害、要做什么或完全无交互、损失什么、是否可察觉；
3. **实际损失证据指针**（concreteLossEvidence）：指向含敏感响应体或外带记录的真实 fact/observation/research id。

缺任何一环 = 研究信号不是漏洞。写不出具体受害者交互、或前提里出现「任意外域」而厂商要求自有域时，闸会拒绝——此时正确动作是改记 research(false-positive) 或建 user_todo，不要绕。

## 典型反面教材（waimai CORS 事件 before/after）
- before：网关对任意 Origin 反射 + ACAC:true，仅验证了 `/` 返回 HTML 与 API 路径 403/空码，就提交 3 条 medium「可跨域读取商家订单数据」→ 被厂商口径打回：无登录态敏感 200 证明 + 钓鱼域非厂商自有域。
- after：头反射属实但只算配置缺陷 → research 记录 + 登录态复核待办；后续同域发现先问「拿到敏感 200 JSON 了吗？钓鱼域合规吗？」再谈提交。

## 低价值类别默认门槛（默认不独立成 finding）
- **Clickjacking**：仅当被嵌页面有一键敏感操作（转账/改绑/改密码/发帖）才成立；营销页/内容页/纯登录页嵌套一律不收，最多 research 备案。
- **纯安全头缺失**（XFO/CSP/HSTS/X-Content-Type-Options 单独存在）：不收，聚合为一条 hardening research。
- **报错页信息罗列**（堆栈/版本号）：除非能匹配已知 CVE 并论证定向利用路径，否则是 fact 不是 finding。
- **Cookie flag 缺失**（Secure/SameSite）：需配套会话固定/窃取链才成立。
- **CORS 头反射**：必须登录态下拿到敏感 200 JSON + 浏览器 credentials:include 实读证明（见 cors-origin-credentials 课程）。

## 数量目标纪律
用户给的数量目标是**产出上限不是 KPI**：「找到三个就停」=「最多三个合格的」。不合格交 0 个并如实说明阻塞原因（匿名面硬化/卡登录态/待办已挂），这是体面产出；绝不为凑数降标准。宁可交一份诚实的零漏洞报告，不交三条灌水 medium。

## 打回闭环与攻击链叙事
finding 被用户打回（src_reject_finding，status=rejected + 打回备注）时不是否定，是要求补强：
- **打回不删除**：打回的 finding 保留在图里供后续组合利用；准入闸会拦住与已打回 finding 相似标题的二次提交。
- **按备注动作**：备注例「没看懂，能梳理下攻击链吗」「是短信轰炸的话写个一键 PoC 脚本吧，输入手机号和次数即可」。收到后用 src_update_finding 补 **attackChain**（从发现→利用前提→利用过程→实际损失→受害者影响串成闭合叙事）或产出一键脚本。
- **不原样重提**：确为新链或已补全，先 src_update_finding 补 attackChain，再说明与打回那条的差异，不要同标题重提。
- **报告渲染**：报告会自动把 attackChain 或结构化字段（①发现②利用前提③利用过程④实际损失⑤受害者影响）拼成攻击链节，让假设链无处藏身。

## 报告标准化模板（vulnType + attackChain + rawRequest）
报告按厂商提交格式生成，可直接贴给厂商无需手改格式。提交 finding 时必填以下让报告完整：
- **vulnType**（漏洞/情报类型）：类别名，如「登录认证漏洞」「越权漏洞」「信息泄露」「短信轰炸」「文件上传漏洞」「SSRF」「XSS」「逻辑漏洞」。报告「漏洞/情报类型」行用它。
- **attackChain**（攻击链）：多跳/组合利用必填的闭合叙事；单步漏洞可不填，报告会由结构化字段拼接。
- **rawRequest**（Burp 格式原始报文）：报告「2、漏洞的详细复现/证明过程」节的主体，含接口地址。空 rawRequest 会被 finalize 闸拦截。
- **discoveryPath**（漏洞接口来源）/ **entryPoint**（前端功能点）：报告「1、描述&发现方式」行用它俩。

报告四大节：①漏洞描述&发现方式、漏洞利用及危害 ②漏洞的详细复现/证明过程 ③测试源信息（从 concreteLossEvidence 指针解析真实证据） ④修复方案。打回的 finding 自动移出主清单、进「已打回」节保留备查，主清单只保留 active。
