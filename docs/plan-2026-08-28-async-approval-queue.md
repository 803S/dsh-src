# local.31 候选：高危删改审批改异步挂起队列（像待办那样）

## 痛点（用户实测 local.26 模块一）
1. dsh 原生 `ApprovalPanel` 只有 `answer('allowed-once'|'rejected')` 两个按钮，**没有输入框** → 用户"没法输入"。
2. 它是**同步阻塞**整个会话（dsh-user-approval 是轮次内一次性 seam，"请求只在尚未结束的轮次内有效"）→ 用户"没法继续进行"。
3. 显示的 reason 是 `[category] justification —— verdict.reason` 模板，缺请求本体（method/path/headers/body）→ 用户"通用模板缺少信息判断"。
4. dsh-user-approval 明确不支持异步/轮次外（"持久化的轮次外审批工作流仍属暂缓事项"、"服务自身绝不会提示人类"）。

## 结论
要的"像待办那样挂起来"（异步、轮次外、用户慢慢审、带全信息、可输入备注）**dsh-user-approval 给不了**，必须 dsh-src 自建队列，照抄待办机制（domain 表 → 工具挂起返回 → agent 继续 → Web 面板审 → 人机命令 followup → agent 工具 resolve）。

## 设计

### 数据：新表 `pending_approvals`（domain version 11→12）
```
srcPendingApprovalSchema = {
  id, sessionId, intentId?,
  method, url, path,            // 完整请求定位
  headers (string), body (string), // 请求本体，resolve 时原样发出
  category,            // classifyHttpRequest 的类别（破坏性写入/越权删改/未授权删改）
  reason,              // classifyHttpRequest 的 reason（为什么挂）
  justification,       // agent 自填的利用理由
  status: pending|approved|rejected,
  note,                // 用户审批备注
  responseStatus?,     // 批准发出后的响应码（approved 专用）
  createdAt, updatedAt
}
```

### 工具
- **src_http（改）**：高风险时不再调 `ctx.approval`，改为 `store.addPendingApproval(...)` 落表 → 返回 `{ approval: "pending", id, message: "已挂起待你审批，未发出。请到 SRC 面板「审批」区批准或拒绝。批准后我会发出；拒绝则丢弃。" }` → **agent 不阻塞，继续其他工作**（或等用户）。
- **src_resolve_approval（新，commander-only）**：参数 `id, action: allow|reject, note?`。
  - allow → 取出存的 method/url/headers/body 原样发出（经同一 http 函数）→ 返回 `{ status, approval: "allowed" }`；失败也记。
  - reject → 置 status=rejected + note，不发出。
  - 幂等：已 resolved 的再 resolve 报错。
- 删掉 src_http 对 ctx.approval 的依赖（保留 fail-closed 兜底：无 store 时仍不发出）。

### 人机命令 /src-approve（照抄 /src-todo）
- `parseApprovalFeedback(raw)`：`<approvalId> <allow|reject> [备注]`，校验 id 形态、action。
- handler → `agent.followup` 结构化消息：「用户在 Web 面板将高危请求 <id> 标记为「批准/拒绝」<备注>。请立即调用 src_resolve_approval(id, action, note)。批准则发出原请求并据响应推进；拒绝则记理由转其他方向。」
- web profile 命令名 `src-approve`。

### UI：SRC 视图「待办」tab 拆左右
用户原话"或者待办的地方拆成左右放吧"——待办 tab 内左右两栏：
- **左栏：用户待办**（现有 TodoListView 原样保留）
- **右栏：待审请求**（新 ApprovalListView）
  - 卡片显示：⚠️ + category 标签（破坏性写入/越权删改/未授权删改）+ method url + 完整 headers/body（可折叠/代码块）+ reason（为什么挂）+ justification（agent 理由）
  - pending 时：✓ 批准 / ✗ 拒绝 两个按钮 + 点开弹备注 textarea（照抄待办的 noteFor 模式，Enter 发送）
  - approved/rejected：标灰，显示用户备注 + 响应码（approved）
  - tab badge：待办数 + 待审批数合并红点（或分开）
- 不新建 tab，复用「待办」tab 内分栏（符合用户"待办的地方拆成左右"）。

### 提示词
- 删掉/改【高风险动作授权闸】里"经 ctx.approval 挂起经 dsh 审批服务"的描述，改为"高风险请求自动挂进待审批队列（SRC 面板「审批」区），你（agent）不阻塞，继续其他方向；用户批准后 src_resolve_approval 发出，拒绝则转其他方向。挂起时返回 pending，请告知用户有请求待审、不要反复重发同请求堆队列。"
- 新增约束：同一高风险请求不要反复 src_http 堆多个 pending（去重：同 method+url+body 已有 pending 的，复用而非新建）。

### 测试（纯 mock，127.0.0.1，不碰真实目标）
- 高风险请求 → 挂起落表 + 返回 pending + 不发出（mock http 验证 hitCount===0）。
- /src-approve allow → src_resolve_approval → 发出（mock http 返回 200）+ 表状态 approved + note。
- /src-approve reject → 状态 rejected + 不发出（hitCount===0）+ note。
- 幂等：已 resolved 再 resolve 报错。
- 去重：同请求重复 src_http 不堆队列。
- lint 同步：COMMANDER_TOOLS 加 src_resolve_approval；persona deny 补；prompt 同步。

### 风险/取舍
- **不阻塞 agent**：与同步审批的"即时阻断"不同，挂起期间 agent 可能继续做不需要此请求的事——这正是用户要的"挂起来"。代价：批准后 agent 要在新轮次被唤醒发出（followup 驱动），agent 需理解"批准→发出→据响应推进"。
- **存请求本体**：headers/body 含 token 明文落表（与 rawRequest 同性质，已在库）。注意投影不含敏感头？——投影要显示给用户审，必须含；与 FindingsView 显示 rawRequest 一致。
- **保留 fail-closed**：无 store/无 resolve 工具时请求绝不自动发出。
- 老的高风险"ctx.approval"路径：移除（src-test profile 也同步，或保留兜底分支但主路径走队列）。

## 待用户确认
1. 异步挂起模型（agent 不阻塞）vs 修同步审批 UI——确认走异步？
2. UI 放「待办」tab 内左右分栏（不新建 tab）——确认？
3. src_resolve_approval commander-only——确认？
4. 是否接受请求本体（含 token）落表+投影显示——与 rawRequest 一致，确认？

## 落地状态（local.31 已实现）
用户确认「优化吧」后落地，commit 待提交。实现要点：
- **新表 `pending_approvals`**（domain version 11→12 自动迁移，SQLite auto-migrate + zod `.default()` 保旧数据安全）。id kind = `approval`（`approval-N`，对齐人机命令 `/src-approve approval-N`）。
- **store 三方法**：`findPendingApproval`（去重 by method+url+body+pending）、`addPendingApproval`（落表 + 存完整请求本体含 headers/body）、`resolvePendingApproval`（allow→原样重放存储请求并记 responseStatus；reject→不发出；幂等：已 resolved 报错）。
- **src_http 高风险分支改异步挂起**：不再调 `ctx.approval` 同步 seam。落入 `pending_approvals` 表 + 发 `src_record_pending_approval` 合成事件（投影立即出现待审节点）；agent 不阻塞返回 `approval=pending` + `pendingApprovalId`。去重复用既有 pending。fail-closed：无 store 时仍不发出（store 不可达即报错）。
- **新工具 `src_resolve_approval`**（commander-only）：`id`+`action(allow|reject)`+`note`，调 store.resolve + 发 `src_resolve_approval` 合成事件同步 fold。deny 进 3 个 persona + COMMANDER_TOOLS lint。
- **人机命令 `/src-approve`**：`<approvalId> <allow|reject> [备注]`，followup 模式指示 agent 调 src_resolve_approval（照抄 /src-todo / /src-reject）。
- **UI**：SRC 视图「待办」tab 改左右分栏（左待办、右待审 `ApprovalListView`）——完整显示 method/url + `[category]` + justification + 分类理由 + 可展开请求报文（headers/body）+ ✓批准/✗拒绝按钮 + 备注 textarea。header statTrack 增「待审」格 + tab badge 合并待办+待审 pending 数。
- **提示词**：「高危动作授权闸」节重写为异步挂起模型（挂起→告知用户→收 followup→resolve）；描述 src_http 不再返回 rejected/cancelled/unavailable。
- **测试**：86/86 绿（`[local.26/31]` 改 3 个原 mock 审批测试为 pending+resolve 闭环；新增 `[local.31]` 3 个：去重、fold 合成事件、resolve 幂等；纯本地 `127.0.0.1` mock + MemoryDomain，不触网、不调真实 dsh-user-approval）。lint 过。
- **约束遵守**：测试全本地 mock，绝不触真实目标/厂商域名；`classifyHttpRequest` 纯函数不触网。
- **路线 B（零漏根治）仍另起工单**：本 local.31 仍是路线 A（src_http 单点拦截），bash curl 绕过仍需改上游沙箱。
