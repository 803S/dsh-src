import { useState } from 'react'
import type { SrcProjection, SrcProjectionPendingApproval, SrcProjectionUserTodo } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import { ApprovalExplanationCard } from './ApprovalExplanationCard.tsx'
import { approvalMissingSafety, approvalCanConfirmRead, approvalRequestText, approvalNeedsDecision, approvalNeedsAttention } from './approval-explanation.ts'
import { EgressControls } from './EgressControls.tsx'
import css from './ActionCenter.module.css'

type RunCommand = (command: string) => Promise<{ kind: string; text: string }>

function statusLabel(status: SrcProjectionUserTodo['status']): string {
  return status === 'done' ? '已完成' : status === 'abandoned' ? '已放弃' : '待处理'
}

function approvalTitle(approval: SrcProjectionPendingApproval): string {
  if (approval.method === 'TASK') return '目标操作审批'
  if (approval.method === 'ASSET') return `确认资产归属：${approval.url}`
  if (approval.method === 'SCOPE') return `确认测试范围：${approval.url}`
  return `${approval.method} ${approval.url}`
}

function approvalActionLabel(approval: SrcProjectionPendingApproval, allow: boolean): string {
  if (approval.method === 'ASSET') return allow ? '确认归属' : '排除资产'
  if (approval.method === 'SCOPE') return allow ? '确认范围（不发包）' : '拒绝范围'
  return allow ? '批准并执行一次' : '拒绝'
}

function TodoCard({ todo, runCommand, onFeedback }: { readonly todo: SrcProjectionUserTodo; readonly runCommand?: RunCommand; readonly onFeedback: (message: string) => void }) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteStatus, setNoteStatus] = useState<'done' | 'abandoned'>('done')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (status: 'done' | 'abandoned') => {
    if (!runCommand || busy) return
    setBusy(true)
    try {
      const trimmed = note.trim()
      const result = await runCommand(`/src-todo ${todo.id} ${status}${trimmed ? ` ${trimmed}` : ''}`)
      onFeedback(result.kind === 'success' ? `已转达：${todo.id} → ${status === 'done' ? '已完成' : '已放弃'}` : `命令返回错误：${result.text}`)
      setNoteOpen(false)
      setNote('')
    } catch (error) {
      onFeedback(`发送失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return <article className={`${css.actionCard} ${css.todoCard}`} data-testid="src-todo-card">
    <div className={css.actionIcon} data-status={todo.status}>{todo.status === 'done' ? '✓' : todo.status === 'abandoned' ? '×' : '↗'}</div>
    <div className={css.actionBody}>
      <div className={css.actionHeading}><span className={css.kindLabel}>{todo.kind || '用户待办'}</span><span className={`${css.statusPill} ${css[`status_${todo.status}`]}`}>{statusLabel(todo.status)}</span></div>
      <h3>{todo.title}</h3>
      {todo.detail && <p>{todo.detail}</p>}
      {todo.note && <p className={css.userNote}>用户备注：{todo.note}</p>}
      <div className={css.actionMeta}><code>{todo.id}</code>{todo.intentId && <span>关联研究方向 {todo.intentId}</span>}</div>
      {todo.status === 'pending' && runCommand && <div className={css.actionButtons}>
        {!noteOpen ? <><button type="button" className={css.successButton} disabled={busy} onClick={() => { setNoteStatus('done'); setNote(''); setNoteOpen(true) }}>我已完成</button><button type="button" className={css.ghostButton} disabled={busy} onClick={() => { setNoteStatus('abandoned'); setNote(''); setNoteOpen(true) }}>放弃此项</button></> : <div className={css.noteForm}>
          <label htmlFor={`todo-note-${todo.id}`}>{noteStatus === 'done' ? '完成说明' : '放弃原因'} <span>可选，会转达给 agent</span></label>
          <textarea id={`todo-note-${todo.id}`} autoFocus rows={2} value={note} placeholder={noteStatus === 'done' ? '例如：已用 Burp 抓好登录包' : '例如：暂不具备测试条件'} onChange={event => setNote(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(noteStatus) } if (event.key === 'Escape') setNoteOpen(false) }} />
          <div><button type="button" className={css.ghostButton} onClick={() => setNoteOpen(false)}>取消</button><button type="button" className={noteStatus === 'done' ? css.successButton : css.ghostButton} disabled={busy} onClick={() => void send(noteStatus)}>{busy ? '发送中…' : noteStatus === 'done' ? '确认完成' : '确认放弃'}</button></div>
        </div>}
      </div>}
    </div>
  </article>
}

function ApprovalCard({ approval, runCommand, onFeedback }: { readonly approval: SrcProjectionPendingApproval; readonly runCommand?: RunCommand; readonly onFeedback: (message: string) => void }) {
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [decision, setDecision] = useState<'allow' | 'reject'>('allow')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const retryUnsent = approval.status==='approved' && approval.executionState==='failed-before-send' && approval.executionError==='SRC_GATE_RESOURCE_REQUIRES_REVIEW' && approvalCanConfirmRead(approval)
  const interrupted = approval.category==='egress/task' && approval.status==='approved' && approval.executionState==='authorized'
  const isPending = approvalNeedsDecision(approval)
  const missingSafety = approvalMissingSafety(approval)
  const confirmRead = approvalCanConfirmRead(approval)
  const send = async () => {
    if (!runCommand || busy || decision === 'allow' && missingSafety) return
    setBusy(true)
    try {
      const trimmed = note.trim()
      const result = await runCommand(`/src-approve ${approval.id} ${decision==='allow'&&confirmRead?'allow-read':decision}${trimmed ? ` ${trimmed}` : ''}`)
      onFeedback(result.kind === 'success' ? result.text : `命令返回错误：${result.text}`)
      setDecisionOpen(false)
      setNote('')
    } catch (error) {
      onFeedback(`发送失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const needsAttention = approvalNeedsAttention(approval)
  const statusText = interrupted ? '已批准，待执行核验' : approval.executionState === 'failed-before-send' ? '未发送' : approval.executionState === 'unknown' ? '结果待核对' : approval.status === 'approved' ? '已批准' : approval.status === 'rejected' ? '已拒绝' : '等待决定'
  return <article className={`${css.actionCard} ${css.approvalCard}`} data-testid="src-approval-card">
    <div className={css.actionIcon} data-status={approval.status}>{approval.method === 'ASSET' ? '◎' : '!'}</div>
    <div className={css.actionBody}>
      <div className={css.actionHeading}><span className={css.kindLabel}>{approval.category?.startsWith('egress/') ? '请求审批' : approval.category || '人工审批'}</span><span className={`${css.statusPill} ${needsAttention ? css.status_pending : approval.status === 'approved' ? css.status_done : css.status_abandoned}`}>{statusText}</span></div>
      <h3>{approvalTitle(approval)}</h3>
      <div className={css.actionMeta}><code>{approval.id}</code></div>
      <ApprovalExplanationCard request={approval} />
      {approval.reason && <details className={css.requestDetails}><summary>查看判定记录</summary><pre>{approval.reason}</pre></details>}
      {approval.method !== 'ASSET' && <details className={css.requestDetails}><summary>{approval.method === 'SCOPE' ? '查看精确 origins' : '查看冻结请求（脱敏，非抓包）'}</summary><pre>{approvalRequestText(approval)}</pre></details>}
      {retryUnsent && <p>此前批准后被资源锁拦住，未发送。重新确认时先核验账本无发送记录，再执行原请求一次。</p>}
      {interrupted && <p>批准已记录；若执行已中断，可核验后继续，也可拒绝放弃。已有发送记录时不会重放。</p>}
      {approval.executionError && <p>执行记录：{approval.executionError}</p>}
      {approval.executionState==='unknown' && <p>先核对目标结果，再通过下方“目标出口范围与审批核对”记录结论；不会自动重试。</p>}
      {isPending && confirmRead && !retryUnsent && <p>Jev 未确定影响；核对报文后，可确认本笔仅仅读取、校验或计算，无写入、外发或资源耗尽，再单次放行。</p>}
      {isPending && missingSafety && <p role="status">暂不可执行：先由 AI 使用 src_egress_prepare 补齐实际影响及安全材料（覆盖/删除需备份、前置校验和回读）。批准备注不能代替这些材料；也可拒绝此项。</p>}
      {isPending && runCommand && approval.executionState !== 'executing' && approval.executionState !== 'unknown' && <div className={css.actionButtons}>
        {!decisionOpen ? <><button type="button" className={css.dangerButton} disabled={busy || missingSafety} onClick={() => { setDecision('allow'); setNote(''); setDecisionOpen(true) }}>{missingSafety?'需补执行材料':interrupted?'核验并继续执行':retryUnsent?'核验未发送并重试':confirmRead?'确认低影响并放行':approvalActionLabel(approval, true)}</button><button type="button" className={css.ghostButton} disabled={busy} onClick={() => { setDecision('reject'); setNote(''); setDecisionOpen(true) }}>{approvalActionLabel(approval, false)}</button></> : <div className={css.noteForm}>
          <label htmlFor={`approval-note-${approval.id}`}>{decision === 'allow' ? '批准前补充备注' : '拒绝原因'} <span>可选，会写入审计记录</span></label>
          <textarea id={`approval-note-${approval.id}`} autoFocus rows={2} value={note} placeholder={decision === 'allow' ? '例如：确认这是授权测试账号' : '例如：可能影响真实用户，不批准'} onChange={event => setNote(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } if (event.key === 'Escape') setDecisionOpen(false) }} />
          <div><button type="button" className={css.ghostButton} onClick={() => setDecisionOpen(false)}>取消</button><button type="button" className={decision === 'allow' ? css.dangerButton : css.successButton} disabled={busy} onClick={() => void send()}>{busy ? '发送中…' : decision === 'allow' ? confirmRead?'确认无副作用，发送一次':'确认批准' : '确认拒绝'}</button></div>
        </div>}
      </div>}
    </div>
  </article>
}

export function ActionCenter({ src, t, runCommand }: { readonly src: SrcProjection; readonly t: PropsLocale['t']; readonly runCommand?: RunCommand }) {
  const [feedback, setFeedback] = useState('')
  const todos = [...src.userTodos].sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1) || b.createdAt - a.createdAt)
  const approvals = [...src.pendingApprovals].sort((a, b) => (approvalNeedsAttention(a) ? -1 : 1) - (approvalNeedsAttention(b) ? -1 : 1) || b.createdAt - a.createdAt)
  const pendingTodos = todos.filter(todo => todo.status === 'pending')
  const pendingApprovals = approvals.filter(approvalNeedsAttention)
  return <div className={css.root} data-testid="src-action-center">
    <section className={css.actionHero}><div><span className={css.sectionKicker}>ACTION CENTER</span><h2>把需要人工判断的事情集中处理</h2><p>只挂起对应操作；其他独立工作继续进行。</p></div><div className={css.actionSummary}><strong>{pendingTodos.length + pendingApprovals.length}</strong><span>待处理</span></div></section>
    {feedback && <div className={css.feedback} role="status">{feedback}</div>}
    <div className={css.columns}>
      <section className={css.column}><header className={css.columnHeader}><div><span className={css.columnKicker}>USER TASKS</span><h2>用户待办</h2></div><span className={css.countBadge}>{pendingTodos.length}</span></header>{todos.length === 0 ? <div className={css.empty}>暂无用户待办</div> : todos.map(todo => <TodoCard key={todo.id} todo={todo} runCommand={runCommand} onFeedback={setFeedback} />)}</section>
      <section className={css.column}><header className={css.columnHeader}><div><span className={`${css.columnKicker} ${css.redText}`}>HUMAN REVIEW</span><h2>待审批请求</h2></div><span className={`${css.countBadge} ${pendingApprovals.length > 0 ? css.countBadgeHot : ''}`}>{pendingApprovals.length}</span></header>{approvals.length === 0 ? <div className={css.empty}>暂无待审请求</div> : approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} runCommand={runCommand} onFeedback={setFeedback} />)}</section>
    </div>
    <div className={css.advanced}><EgressControls runCommand={runCommand} /></div>
  </div>
}
