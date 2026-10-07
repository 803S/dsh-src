import { approvalTarget, approvalBlockReason, approvalOperation } from './approval-explanation.ts'
import type { ApprovalExplanationInput } from './approval-explanation.ts'
import css from './ApprovalExplanationCard.module.css'

export function ApprovalExplanationCard({ request }: { request: ApprovalExplanationInput }) {
  return <section className={css.root} aria-label="审批阻断原因" data-testid="approval-explanation">
    <div>{approvalTarget(request)}</div>
    {approvalOperation(request) && <div>{approvalOperation(request)}</div>}
    <div>{approvalBlockReason(request)}</div>
  </section>
}
