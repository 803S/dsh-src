/**
 * FindingsView: the 漏洞 sub-tab of the SRC view. Lists every vulnerability
 * finding of the engagement — severity badge, title, description, impact,
 * victim impact, discovery path, entry point, scope, remediation, raw
 * request/response POC, evidence list, reproducible steps, and the affected
 * asset when linked. [UI-source rebuild] restored from the local.21 bundle.
 * [local.26] added the 打回 (reject) button + rejectReason banner: clicking
 * 打回 opens a textarea for a reason, which is relayed to the agent via the
 * /src-reject panel command (mirroring /src-todo); rejected findings show
 * their reason and stay listed for combination use.
 */

import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { SrcProjection, SrcProjectionNode, SrcSeverity } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import type { SrcKey } from './locales.ts'
import css from './FindingsView.module.css'

/** Severity badge label keys. */
const SEVERITY_LABELS: Record<SrcSeverity, SrcKey> = {
  critical: 'severity.critical',
  high: 'severity.high',
  medium: 'severity.medium',
  low: 'severity.low',
  info: 'severity.info',
}

/** Narrow the projection nodes to findings. */
function findingsOf(projection: SrcProjection): Array<SrcProjectionNode & { kind: 'finding' }> {
  return projection.nodes.filter((node): node is SrcProjectionNode & { kind: 'finding' } => node.kind === 'finding')
}

/** Full props of the findings sub-tab. [local.26] runCommand drives the 打回 button. */
export interface FindingsViewProps {
  readonly src: SrcProjection
  readonly t: PropsLocale['t']
  /** [local.26] relay a /src-reject command back to the host; undefined when the
   * session can't echo commands (then the 打回 button is hidden, mirroring todos). */
  readonly runCommand?: ((cmd: string) => Promise<{ kind: string; text: string }>) | undefined
}

/** Small inline-button style, matching the todo action buttons in SrcView. */
function buttonStyle(color: string): CSSProperties {
  return {
    padding: '5px 14px',
    fontSize: 12,
    lineHeight: 1.5,
    borderRadius: 999,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'color-mix(in oklab, var(--dsw-alias-bg-layer-2) 80%, transparent)',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontWeight: 500,
    backdropFilter: 'blur(4px)',
    boxShadow: '0 1px 2px rgba(0,0,0,.03)',
    transition: 'border-color 130ms ease, box-shadow 130ms ease, transform 100ms ease',
  }
}

export function FindingsView({ src, t, runCommand }: FindingsViewProps) {
  const findings = findingsOf(src)
  /* [local.26] reject UI state — mirrors the todo noteFor pattern. */
  const [noteFor, setNoteFor] = useState<{ readonly id: string } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  if (findings.length === 0) {
    return <p className={css.empty} data-testid="src-findings-empty">{t('findings.empty')}</p>
  }

  /** Relay the reject to the agent via /src-reject (just like /src-todo). */
  const sendReject = async (findingId: string, reason: string) => {
    if (busyId !== null || runCommand === undefined) return
    const trimmed = reason.trim()
    if (trimmed === '') {
      setFeedback('打回理由不能为空。')
      return
    }
    setBusyId(findingId)
    setFeedback(null)
    try {
      const result = await runCommand(`/src-reject ${findingId} ${trimmed}`)
      setFeedback(result.kind === 'success'
        ? `已打回 ${findingId}（理由：${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}），等待 agent 处理…`
        : `命令返回错误：${result.text}`)
      setNoteFor(null)
      setNoteText('')
    } catch (error) {
      setFeedback(`打回失败：${(error as Error).message ?? String(error)}`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <ul className={css.list} data-testid="src-findings">
      {findings.map((finding) => {
        const asset = finding.affectedAssetId === undefined
          ? undefined
          : src.assets.find(candidate => candidate.id === finding.affectedAssetId)
        const isRejected = finding.status === 'rejected'
        return (
          <li key={finding.id} className={css.finding} data-testid="src-finding"
              style={isRejected ? { opacity: 0.7, borderColor: 'rgba(200,90,70,.6)' } : undefined}>
            <header className={css.header}>
              <span className={css.severity} data-severity={finding.severity}>{t(SEVERITY_LABELS[finding.severity])}</span>
              <h4 className={css.title}>{finding.title}</h4>
              <span className={css.id}>{finding.id}</span>
            </header>
            {/* [local.26] reject banner: a rejected finding stays listed (kept for
                combination use + similarity-gate), with its reason shown up top. */}
            {isRejected && (
              <div style={{ display: 'flex', gap: 6, padding: '6px 10px', borderRadius: 8,
                  border: '1px solid rgba(200,90,70,.4)', background: 'rgba(200,90,70,.08)',
                  fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' }} data-testid="src-finding-rejected">
                <span>⚠</span>
                <div>
                  <strong>已打回（保留备查，准入闸会拦住相似项二次提交）</strong>
                  {finding.rejectReason !== '' && (
                    <div style={{ marginTop: 2, color: 'var(--dsw-alias-label-secondary)' }}>
                      打回理由：{finding.rejectReason}
                    </div>
                  )}
                </div>
              </div>
            )}
            {finding.description !== '' && <p className={css.description}>{finding.description}</p>}
            <p className={css.description}>{t('finding.impact')}: {finding.impact}</p>
            {(finding.victimImpact ?? '') !== '' && <p className={css.description}>{t('finding.victimImpact')}: {finding.victimImpact}</p>}
            {/* [local.26] attack chain narrative: shown when the agent filled it in. */}
            {(finding.attackChain ?? '') !== '' && (
              <div className={css.stepsBlock}>
                <span className={css.stepsLabel}>{t('finding.attackChain')}</span>
                <pre className={css.steps} style={{ whiteSpace: 'pre-wrap', margin: 0, paddingLeft: 0, listStyle: 'none' }}>{finding.attackChain}</pre>
              </div>
            )}
            {finding.discoveryPath !== '' && <p className={css.description}>{t('finding.discoveryPath')}: {finding.discoveryPath}</p>}
            {finding.entryPoint !== '' && <p className={css.description}>{t('finding.entryPoint')}: {finding.entryPoint}</p>}
            <p className={css.description}>{t('finding.scope')}: {finding.affectedScope}</p>
            <p className={css.description}>{t('finding.remediation')}: {finding.remediation}</p>
            {(finding.rawRequest !== '' || finding.rawResponse !== '') && (
              <details className={css.fold}>
                <summary className={css.foldSummary}>{t('finding.rawRequest')} / {t('finding.rawResponse')}</summary>
                <div className={css.stepsBlock}>
                  {finding.rawRequest !== '' && (
                    <>
                      <span className={css.stepsLabel}>{t('finding.rawRequest')}</span>
                      <pre className={css.steps} style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{finding.rawRequest}</pre>
                    </>
                  )}
                  {finding.rawResponse !== '' && (
                    <>
                      <span className={css.stepsLabel}>{t('finding.rawResponse')}</span>
                      <pre className={css.steps} style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{finding.rawResponse}</pre>
                    </>
                  )}
                </div>
              </details>
            )}
            <details className={css.fold}>
              <summary className={css.foldSummary}>{t('finding.evidence')}</summary>
              <div className={css.stepsBlock}>
                <ol className={css.steps}>
                  {(finding.pocEvidence ?? []).map((evidence, index) => <li key={index}>{evidence}</li>)}
                </ol>
              </div>
            </details>
            <details className={css.fold}>
              <summary className={css.foldSummary}>{t('finding.steps')}</summary>
              <div className={css.stepsBlock}>
                <ol className={css.steps}>
                  {finding.steps.map((step, index) => <li key={index}>{step}</li>)}
                </ol>
              </div>
            </details>
            {asset !== undefined && (
              <p className={css.asset}>{t('finding.affected')}: [{asset.type}] {asset.value}</p>
            )}
            {/* [local.26] 打回 button — only for active findings, only when the
                session can relay commands. Rejected ones keep their banner above. */}
            {!isRejected && runCommand !== undefined && (
              <div style={{ marginTop: 2 }} data-testid="src-finding-reject">
                {noteFor?.id === finding.id ? (
                  <div style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(127,127,127,.3)',
                      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))' }}>
                    <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 5 }}>
                      打回此项 —— 说明理由（会转达给 agent，驱动它补 attackChain / 产 PoC）
                    </div>
                    <textarea autoFocus={true} rows={3} value={noteText}
                      placeholder="如：危害链不闭合，请补 attackChain&#10;（Enter 发送，Shift+Enter 换行）"
                      onChange={(event) => setNoteText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          void sendReject(finding.id, noteText)
                        }
                        if (event.key === 'Escape') setNoteFor(null)
                      }}
                      style={{ display: 'block', width: '100%', boxSizing: 'border-box', fontSize: 13,
                        padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(127,127,127,.4)',
                        background: 'transparent', color: 'inherit', resize: 'vertical', minHeight: 60,
                        fontFamily: 'inherit', lineHeight: 1.5 }} />
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center', marginTop: 7 }}>
                      <button type="button" disabled={busyId !== null}
                        onClick={() => void sendReject(finding.id, noteText)}
                        style={buttonStyle('#c65746')}>
                        {busyId !== null ? '发送中…' : '打回'}
                      </button>
                      <button type="button" onClick={() => setNoteFor(null)} style={buttonStyle('var(--dsw-alias-label-tertiary)')}>取消</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button type="button" disabled={busyId !== null}
                      onClick={() => { setNoteText(''); setNoteFor({ id: finding.id }) }}
                      style={buttonStyle('#c65746')}>
                      打回
                    </button>
                    {busyId === finding.id && <span style={{ color: '#e80', fontSize: 12 }}>发送中…</span>}
                  </div>
                )}
              </div>
            )}
            {feedback !== null && noteFor?.id === finding.id && (
              <div style={{ color: busyId !== null ? '#e80' : 'var(--dsw-alias-state-error-primary, #c33)', fontSize: 12, padding: '2px 4px' }}>
                {feedback}
              </div>
            )}
          </li>
        )
      })}
      {feedback !== null && noteFor === null && (
        <li style={{ listStyle: 'none', color: 'var(--dsh-alias-label-secondary)', fontSize: 12, padding: '4px 2px' }}>{feedback}</li>
      )}
    </ul>
  )
}
