# CORS 任意 Origin 反射 + Credentials

## 触发场景
- Web/API 响应头 `Access-Control-Allow-Origin` 值跟随请求 `Origin` 变化（反射）。
- 响应含 `Access-Control-Allow-Credentials: true` 或接口依赖 Cookie/Authorization 会话。
- 常见于前后端分离站点的 API 网关、用户中心、跨子域 SSO 回调。

## 验证套路
1. `curl -sI -H "Origin: https://evil.example" <目标接口>`（受控域名占位即可，不必真实托管）。
2. 检查响应三要素：① `Access-Control-Allow-Origin: https://evil.example`（原样反射=高危信号；回显白名单固定值或 `null`=低危）② `Access-Control-Allow-Vary: Origin` 缺失说明缓存可能放大危害 ③ `Access-Control-Allow-Credentials: true`。
3. 反射确认后做最小化 PoC：本地 HTML `fetch(url, {credentials:"include"}).then(r=>r.text())`，浏览器带 Cookie 访问确认能读到敏感数据。
4. 找返回敏感数据（个人信息/订单/token）的 GET 接口作证据接口；POST 类需预检（OPTIONS），确认 `Access-Control-Allow-Headers` 是否反射。
5. 证据固定：「恶意 Origin 请求 + 响应三要素 + 浏览器实际读到敏感数据」三段 raw 包/截图。

## 收录标准
- Origin 反射 + `Allow-Credentials: true` + 敏感数据接口三者齐备 → medium 起评。
- 危害论证必须写明：攻击者在何处托管页面、诱导谁（该站已登录用户）访问、能读到哪个接口的什么数据。
- 只有反射但无 Credentials 且数据不敏感 → 通常 low 或不收，如实定级。

## 常见误判
- 只贴 curl 响应头没证明「浏览器场景可利用」→ 补浏览器 fetch PoC 截图。
- Origin 白名单前缀匹配缺陷（`https://evil-target.com` 绕 `.target.com` 校验）也算，但要给出具体绕过域名构造过程。
- 反射固定白名单值不算漏洞——必须确认是任意 Origin 原样回显。
- 未写 victimImpact（谁受害/损失什么/是否无感知）会被要求补全。

## 必抓证据
rawRequest（带恶意 Origin 的完整请求）；rawResponse（含三个 CORS 头的完整响应）；浏览器侧 fetch 成功读取数据的截图或控制台输出。

<!-- lesson-meta: {"hook": "CORS 三证齐才提交：Origin 反射+ACAC:true+登录态敏感 200 实读；只 curl 头不算利用， victimImpact 必写", "triggers": {"keywords": ["cors", "跨域", "origin"]}} -->
