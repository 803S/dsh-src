import { approvalTarget, approvalBlockReason, approvalOperation, approvalHumanSummary } from './approval-explanation.ts'
import type { ApprovalExplanationInput } from './approval-explanation.ts'
import css from './ApprovalExplanationCard.module.css'

/**
 * 人工审批说明卡。
 *
 * 两段式：上方是「这笔请求可能造成什么」的人类摘要（拿不到可解析的冻结请求时明确要求先核对，
 * 不放行无法核对的内容），下方折叠的技术判定（作用对象 / 操作语义 / 判定阻断原因）默认收起，
 * 避免把技术判定塞进人类摘要；展开只影响展示，不改变任何批准口径。
 */
export function ApprovalExplanationCard({ request }: { request: ApprovalExplanationInput }) {
  return <section className={css.root} aria-label="审批阻断原因" data-testid="approval-explanation">
    <div>{approvalHumanSummary(request)}</div>
    <details className={css.technical}>
      <summary>查看技术判定</summary>
      <div>{approvalTarget(request)}</div>
      {approvalOperation(request) && <div>{approvalOperation(request)}</div>}
      <div>{approvalBlockReason(request)}</div>
    </details>
  </section>
}
