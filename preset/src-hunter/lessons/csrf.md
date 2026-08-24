# CSRF 检测套路与利用边界

## 触发场景
- 表单提交、状态变更接口（改资料/转账/发消息/改密码）、无 SameSite 保护的 Cookie。
- 响应含 CSRF token 但可被预测/复用/绕过，或接口完全不校验来源。

## 检测套路
1. **识别状态变更接口**：从 Burp 流量/JS 提取 POST/PUT/DELETE 接口，重点是改密、改绑定、资金、权限变更类。
2. **校验来源**：去掉 `Origin`/`Referer` 重放——仍成功即无来源校验。
3. **校验 token**：去掉/篡改 CSRF token 重放；token 是否跨会话复用、是否可预测、是否仅在 header（前端框架常 `_csrf` header）。
4. **SameSite 评估**：Cookie 的 `SameSite` 属性——`None`+`Secure` 仍可跨站；`Lax` 顶层 GET 可绕；`Strict` 难绕但检查是否有子域 cookie 降级。
5. **JSON Content-Type 绕过**：`application/json` 接口常误以为安全，试 `text/plain` + 简单 JSON body、或 `multipart/form-data` 包 JSON——部分框架 Content-Type 检查可绕。

## 利用证明边界（关键）
- **利用证明需受害者浏览器**：CSRF 的危害证明是「受害者访问攻击者页面后其浏览器自动带上凭据发起请求」——这一步**无法在 agent 的请求工具里自证**（agent 不持有受害者的浏览器上下文）。
- 因此：检测出无来源校验/token 可绕/SameSite 弱后，**能自证的部分**（请求构造、绕过条件、接口确实变更状态）落 fact/research；**利用成立需受害者浏览器的部分一律转 `src_user_todo(kind=manual-test, intentId 关联)` 移交用户**，附复现步骤（攻击页面 HTML + 目标接口 + 预期受害者行为）。
- 不要在自主流里声称「已复现 CSRF」却只有 agent 自己发的请求——那是误报。

## 定级（参考）
- 无来源校验 + 关键状态变更（改密/资金）且 SameSite=None：high（需用户在浏览器证明利用链）。
- 仅 token 可绕但利用需特定条件：medium。
- 仅缺失 SameSite 但 Lax 已防住顶层导航：low/info（记 fact）。
