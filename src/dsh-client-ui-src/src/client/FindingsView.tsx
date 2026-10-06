import { useMemo, useState } from 'react'
import type { SrcProjection, SrcProjectionNode, SrcSeverity } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import type { SrcKey } from './locales.ts'
import { FindingDetailDrawer } from './FindingDetailDrawer.tsx'
import css from './FindingsView.module.css'

const SEVERITY_LABELS: Record<SrcSeverity, SrcKey> = {
  critical: 'severity.critical',
  high: 'severity.high',
  medium: 'severity.medium',
  low: 'severity.low',
  info: 'severity.info',
}

type Finding = SrcProjectionNode & { kind: 'finding' }

function findingsOf(projection: SrcProjection): Finding[] {
  return projection.nodes.filter((node): node is Finding => node.kind === 'finding')
}

function evidenceCount(finding: Finding): number {
  return (finding.pocEvidence?.length ?? 0) + (finding.rawRequest ? 1 : 0) + (finding.rawResponse ? 1 : 0)
}

export interface FindingsViewProps {
  readonly src: SrcProjection
  readonly t: PropsLocale['t']
  readonly runCommand?: ((cmd: string) => Promise<{ kind: string; text: string }>) | undefined
}

export function FindingsView({ src, t, runCommand }: FindingsViewProps) {
  const findings = findingsOf(src)
  const [severityFilter, setSeverityFilter] = useState<'all' | SrcSeverity>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'rejected'>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')

  const filtered = useMemo(() => findings.filter(finding => {
    if (severityFilter !== 'all' && finding.severity !== severityFilter) return false
    if (statusFilter !== 'all' && finding.status !== statusFilter) return false
    const needle = query.trim().toLowerCase()
    if (needle && !`${finding.title} ${finding.description} ${finding.impact} ${finding.id}`.toLowerCase().includes(needle)) return false
    return true
  }).sort((a, b) => {
    const rank: Record<SrcSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    return (rank[a.severity] ?? 5) - (rank[b.severity] ?? 5) || b.createdAt - a.createdAt
  }), [findings, query, severityFilter, statusFilter])

  const selected = selectedId === null ? null : findings.find(finding => finding.id === selectedId) ?? null
  const activeCount = findings.filter(finding => finding.status !== 'rejected').length
  const rejectedCount = findings.length - activeCount
  const highCount = findings.filter(finding => finding.status !== 'rejected' && (finding.severity === 'critical' || finding.severity === 'high')).length

  if (findings.length === 0) {
    return <div className={css.emptyState} data-testid="src-findings-empty"><span>◌</span><h3>{t('findings.empty')}</h3><p>当 agent 完成一轮验证后，漏洞摘要和可复现证据会显示在这里。</p></div>
  }

  return <section className={css.root} data-testid="src-findings">
    <header className={css.toolbar}>
      <div className={css.toolbarIntro}><span className={css.kicker}>RESULTS / REVIEW</span><h2>漏洞结果</h2><p>{activeCount} 个有效结果{highCount > 0 ? ` · ${highCount} 个高风险` : ''}{rejectedCount > 0 ? ` · ${rejectedCount} 个已打回` : ''}</p></div>
      <div className={css.summary}><strong>{activeCount}</strong><span>有效漏洞</span></div>
    </header>
    <div className={css.filters} role="toolbar" aria-label="漏洞筛选">
      <label className={css.search}><span aria-hidden>⌕</span><input value={query} placeholder="搜索标题、影响或编号" aria-label="搜索漏洞" onChange={event => setQuery(event.target.value)} /></label>
      <div className={css.segmented} aria-label="风险等级"><button type="button" aria-pressed={severityFilter === 'all'} onClick={() => setSeverityFilter('all')}>全部</button>{(['critical', 'high', 'medium', 'low'] as const).map(level => <button key={level} type="button" aria-pressed={severityFilter === level} data-severity={level} onClick={() => setSeverityFilter(level)}>{t(SEVERITY_LABELS[level])}</button>)}</div>
      <div className={css.segmented} aria-label="漏洞状态"><button type="button" aria-pressed={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>全部状态</button><button type="button" aria-pressed={statusFilter === 'active'} onClick={() => setStatusFilter('active')}>有效</button><button type="button" aria-pressed={statusFilter === 'rejected'} onClick={() => setStatusFilter('rejected')}>已打回</button></div>
    </div>
    {feedback && <div className={css.feedback} role="status">{feedback}</div>}
    {filtered.length === 0 ? <div className={css.emptyState}><span>⌕</span><h3>没有匹配的漏洞</h3><p>尝试清空搜索或调整筛选条件。</p></div> : <div className={css.list}>
      {filtered.map(finding => {
        const asset = finding.affectedAssetId ? src.assets.find(candidate => candidate.id === finding.affectedAssetId) : undefined
        const rejected = finding.status === 'rejected'
        return <article key={finding.id} className={`${css.finding} ${rejected ? css.findingRejected : ''}`} data-testid="src-finding">
          <div className={css.severityRail} data-severity={finding.severity} />
          <div className={css.findingMain}>
            <header className={css.header}><div className={css.headerTitle}><span className={css.severity} data-severity={finding.severity}>{t(SEVERITY_LABELS[finding.severity])}</span><h3>{finding.title}</h3></div><span className={css.id}>{finding.id}</span></header>
            <div className={css.statusLine}><span className={`${css.reviewStatus} ${rejected ? css.reviewRejected : css.reviewReady}`}>{rejected ? '已打回 · 保留备查' : '待审阅'}</span>{asset && <span className={css.asset}>{asset.value}</span>}{finding.vulnType && <span className={css.type}>{finding.vulnType}</span>}</div>
            <p className={css.description}>{finding.description || finding.impact || '暂无漏洞摘要，打开详情查看结构化记录。'}</p>
            <div className={css.evidenceSummary}><span>证据 <strong>{evidenceCount(finding)}</strong></span><span>复现步骤 <strong>{finding.steps.length}</strong></span><span>影响范围 <strong>{finding.affectedScope ? '已填写' : '待补充'}</strong></span></div>
            {rejected && finding.rejectReason && <div className={css.rejectReason} data-testid="src-finding-rejected">打回理由：{finding.rejectReason}</div>}
            <footer className={css.cardFooter}><button type="button" className={css.primaryButton} onClick={() => setSelectedId(finding.id)}>查看完整详情 <span>→</span></button>{!rejected && runCommand && <button type="button" className={css.secondaryButton} onClick={() => setSelectedId(finding.id)}>审阅并打回</button>}<span className={css.footerHint}>更新于 {finding.createdAt ? new Date(finding.createdAt).toLocaleString() : '未知'}</span></footer>
          </div>
        </article>
      })}
    </div>}
    {selected && <FindingDetailDrawer finding={selected} src={src} t={t} runCommand={runCommand} onClose={() => setSelectedId(null)} />}
  </section>
}
