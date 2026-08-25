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
