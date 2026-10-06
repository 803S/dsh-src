import { explainApproval } from './approval-explanation.ts'
import type { ApprovalExplanationInput } from './approval-explanation.ts'
import css from './ApprovalExplanationCard.module.css'

export function ApprovalExplanationCard({ request }: { request: ApprovalExplanationInput }) {
  const explanation = explainApproval(request)
  return <section className={css.root} aria-label="审批操作与后果说明" data-testid="approval-explanation">
    <div><strong>正在做什么：</strong>{explanation.operation}</div>
    <div><strong>作用对象：</strong>{explanation.target}</div>
    <div><strong>操作目的（模型说明）：</strong>{explanation.purpose}</div>
    <div><strong>可能后果：</strong></div>
    <ul>{explanation.consequences.map((line, index) => <li key={index}>{line}</li>)}</ul>
    <div><strong>恢复条件：</strong>{explanation.recovery}</div>
    <div><strong>为什么需要确认：</strong>{explanation.decision}</div>
    <details><summary>查看模型完整说明（未经独立验证）</summary><div className={css.fullText}>{request.justification || '未提供'}</div></details>
  </section>
}
