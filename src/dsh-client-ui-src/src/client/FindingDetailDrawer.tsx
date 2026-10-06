import { useEffect, useState } from 'react'
import type { SrcProjection, SrcProjectionNode } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import css from './FindingDetailDrawer.module.css'

type Finding = SrcProjectionNode & { kind: 'finding' }

export function FindingDetailDrawer({ finding, src, t, runCommand, onClose }: {
  readonly finding: Finding
  readonly src: SrcProjection
  readonly t: PropsLocale['t']
  readonly runCommand?: ((cmd: string) => Promise<{ kind: string; text: string }>)
  readonly onClose: () => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const asset = finding.affectedAssetId ? src.assets.find(candidate => candidate.id === finding.affectedAssetId) : undefined
  const rejected = finding.status === 'rejected'

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const sendReject = async () => {
    const trimmed = reason.trim()
    if (!runCommand || busy || !trimmed) return
    const fingerprint = (finding as Finding & { fingerprint?: string }).fingerprint
    if (!fingerprint) {
      setFeedback('尚未取得权威漏洞指纹，请刷新后重试。')
      return
    }
    setBusy(true)
    setFeedback('')
    try {
      const result = await runCommand('/src-reject-checked ' + JSON.stringify({ findingId: finding.id, fingerprint, reason: trimmed }))
      if (result.kind !== 'success') throw new Error(result.text)
      setFeedback(`已打回 ${finding.id}，等待 agent 处理。`)
      setRejecting(false)
      setReason('')
    } catch (error) {
      setFeedback(`打回失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setFeedback(`${label}已复制`)
    } catch {
      setFeedback(`${label}复制失败`)
    }
  }

  return (
    <div className={css.layer} data-testid="finding-detail-drawer">
      <button type="button" className={css.backdrop} aria-label="关闭漏洞详情" onClick={onClose} />
      <aside className={css.drawer} role="dialog" aria-modal="true" aria-label="漏洞详情">
        <header className={css.header}>
          <div className={css.heading}>
            <div className={css.badges}>
              <span className={css.severity} data-severity={finding.severity}>{t(`severity.${finding.severity}`)}</span>
              <span className={`${css.status} ${rejected ? css.statusRejected : css.statusActive}`}>{rejected ? '已打回' : '待审阅'}</span>
            </div>
            <h2>{finding.title}</h2>
            <p>{finding.id}{asset ? ` · ${asset.value}` : ''}</p>
          </div>
          <button type="button" className={css.close} aria-label="关闭详情" onClick={onClose}>×</button>
        </header>
        <div className={css.body}>
          {rejected && <section className={`${css.callout} ${css.calloutDanger}`} data-testid="src-finding-rejected"><strong>此漏洞已被打回</strong><p>{finding.rejectReason || '未提供打回理由。'}</p><small>记录保留备查，准入闸会阻止相似项重复提交。</small></section>}
          <section className={css.section}>
            <h3>风险摘要</h3>
            <p>{finding.description || finding.impact || '暂无摘要。'}</p>
            {finding.victimImpact && <div className={css.impact}><strong>对用户的实际影响</strong><p>{finding.victimImpact}</p></div>}
            <dl className={css.facts}>
              {finding.impact && <div><dt>利用场景</dt><dd>{finding.impact}</dd></div>}
              {finding.affectedScope && <div><dt>影响范围</dt><dd>{finding.affectedScope}</dd></div>}
              {asset && <div><dt>影响资产</dt><dd>{asset.value} <small>{asset.type}</small></dd></div>}
              {finding.entryPoint && <div><dt>前端入口</dt><dd>{finding.entryPoint}</dd></div>}
              {finding.discoveryPath && <div><dt>发现路径</dt><dd>{finding.discoveryPath}</dd></div>}
            </dl>
          </section>

          {finding.attackChain && <section className={css.section}><h3>攻击链</h3><div className={css.prose}>{finding.attackChain}</div></section>}
          {finding.steps.length > 0 && <section className={css.section}><h3>复现步骤 <span>{finding.steps.length}</span></h3><ol className={css.steps}>{finding.steps.map((step, index) => <li key={index}><span>{index + 1}</span><p>{step}</p></li>)}</ol></section>}
          {finding.pocEvidence.length > 0 && <section className={css.section}><h3>POC 证据 <span>{finding.pocEvidence.length}</span></h3><ul className={css.evidence}>{finding.pocEvidence.map((entry, index) => <li key={index}>{entry}</li>)}</ul></section>}
          {(finding.rawRequest || finding.rawResponse || finding.pocScript) && <section className={css.section}>
            <h3>请求与响应</h3>
            {finding.rawRequest && <details className={css.codeDetails}><summary>原始请求 <button type="button" onClick={event => { event.preventDefault(); void copy(finding.rawRequest, '原始请求') }}>复制</button></summary><pre>{finding.rawRequest}</pre></details>}
            {finding.rawResponse && <details className={css.codeDetails}><summary>原始响应 <button type="button" onClick={event => { event.preventDefault(); void copy(finding.rawResponse, '原始响应') }}>复制</button></summary><pre>{finding.rawResponse}</pre></details>}
            {finding.pocScript && <details className={css.codeDetails}><summary>POC 脚本 <button type="button" onClick={event => { event.preventDefault(); void copy(finding.pocScript, 'POC 脚本') }}>复制</button></summary><pre>{finding.pocScript}</pre></details>}
          </section>}
          {finding.remediation && <section className={css.section}><h3>修复建议</h3><p>{finding.remediation}</p></section>}
          {feedback && <div className={css.feedback} role="status">{feedback}</div>}
          {!rejected && runCommand && <section className={css.rejectSection} data-testid="src-finding-reject">
            {!rejecting ? <button type="button" className={css.rejectButton} onClick={() => setRejecting(true)}>打回并要求补充证据</button> : <div className={css.rejectForm}>
              <label htmlFor="finding-reject-reason">打回理由 <span>会转达给 agent，用于补充攻击链或验证证据</span></label>
              <textarea id="finding-reject-reason" autoFocus rows={3} value={reason} placeholder="例如：危害链尚未闭合，请补充可复现证据。" onChange={event => setReason(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendReject() } if (event.key === 'Escape') setRejecting(false) }} />
              <div><button type="button" className={css.cancelButton} onClick={() => setRejecting(false)}>取消</button><button type="button" className={css.rejectButton} disabled={busy || !reason.trim()} onClick={() => void sendReject()}>{busy ? '发送中…' : '确认打回'}</button></div>
            </div>}
          </section>}
        </div>
      </aside>
    </div>
  )
}
