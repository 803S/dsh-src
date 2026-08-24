/**
 * ReportView: render, copy, and download the current src projection as
 * Markdown. [SRC] extends the upstream pentest report with impact/victim
 * impact, domain + full URL extraction, the raw request/response data
 * packet, per-asset API-meta formatting (formatApiMeta), and a child-agent
 * checkpoints section. [UI-source rebuild] restored from the local.21 bundle.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SrcProjection, SrcProjectionNode } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import css from './ReportView.module.css'

export interface ReportViewProps {
  readonly src: SrcProjection
  readonly t: PropsLocale['t']
}

/** Humanize an `api:<kind> <json…>` asset meta into `API/<kind>: k=v, …`. */
function formatApiMeta(meta: unknown): string {
  if (typeof meta !== 'string' || !meta.startsWith('api:')) return typeof meta === 'string' ? meta : ''
  const space = meta.indexOf(' ')
  const kind = space === -1 ? meta.slice(4) : meta.slice(4, space)
  const rest = space === -1 ? '' : meta.slice(space + 1)
  let detail = rest
  try {
    if (rest !== '') detail = Object.entries(JSON.parse(rest)).map(([k, v]) => `${k}=${v}`).join(', ')
  } catch {
    // keep the raw text when the JSON payload is malformed
  }
  return `API/${kind}${detail === '' ? '' : `: ${detail}`}`
}

function reportOf(src: SrcProjection, t: ReportViewProps['t']): string {
  if (src.goal === null) return `# ${t('report.title')}\n\n${t('report.uninitialized')}\n`

  const findings = src.nodes.filter((node): node is SrcProjectionNode & { kind: 'finding' } => node.kind === 'finding')
  const chain = src.nodes.map((node) => {
    const anchor = src.edges.find(edge => edge.targetId === node.id)
    const relation = anchor === undefined ? '' : ` (${anchor.kind} ${anchor.sourceId})`
    if (node.kind === 'intent') return `- ${t('kind.intent')} (${node.id}) ${node.title}${node.detail === '' ? '' : `: ${node.detail}`}${relation}`
    if (node.kind === 'fact') return `- ${t('kind.fact')} (${node.id}) [${node.factKind}] ${node.target === '' ? '' : `${node.target}: `}${node.detail}${relation}`
    return `- ${t('kind.finding')} (${node.id}) [${node.severity}] ${node.title}${relation}`
  })
  const findingSections = findings.flatMap((finding) => {
    const asset = finding.affectedAssetId === undefined ? undefined : src.assets.find(candidate => candidate.id === finding.affectedAssetId)
    const domain = asset === undefined
      ? (src.goal?.target ?? '').replace(/^https?:\/\//, '').split('/')[0]
      : asset.value.replace(/^https?:\/\//, '').split('/')[0]
    const evidenceText = (finding.pocEvidence ?? []).join('\n') + '\n' + (finding.steps ?? []).join('\n')
    const urlMatch = evidenceText.match(/https?:\/\/[^\s'"\\)]+/)
    const fullUrl = urlMatch === null ? (asset === undefined ? (src.goal?.target ?? '') : asset.value) : urlMatch[0]
    const rawPacket = [
      finding.rawRequest !== '' ? `=== Request ===\n${finding.rawRequest}` : '',
      finding.rawResponse !== '' ? `=== Response ===\n${finding.rawResponse}` : '',
    ].filter(part => part !== '').join('\n\n')
    return [
      `### ${finding.id} [${finding.severity}] ${finding.title}`,
      `- ${t('report.description')}: ${finding.description === '' ? finding.title : finding.description}`,
      `- ${t('finding.impact')}: ${finding.impact}`,
      `- ${t('finding.victimImpact')}: ${(finding.victimImpact ?? '') === '' ? t('report.victimImpactMissing') : finding.victimImpact}`,
      `- ${t('report.domain')}: ${domain}`,
      `- ${t('report.fullUrl')}: ${fullUrl}`,
      finding.discoveryPath !== '' ? `- ${t('finding.discoveryPath')}: ${finding.discoveryPath}` : '',
      finding.entryPoint !== '' ? `- ${t('finding.entryPoint')}: ${finding.entryPoint}` : '',
      `- ${t('report.dataPacket')}:`,
      ...(rawPacket !== ''
        ? [rawPacket.split('\n').map(line => `  ${line}`).join('\n')]
        : (finding.pocEvidence ?? []).length > 0
          ? (finding.pocEvidence ?? []).map((evidence, index) => `  ${index + 1}. ${evidence}`)
          : ['  （无）']),
      `- ${t('report.screenshot')}: ${t('report.screenshotHint')}`,
      `- ${t('finding.scope')}: ${finding.affectedScope}`,
      `- ${t('finding.remediation')}: ${finding.remediation}`,
      `- ${t('finding.affected')}: ${asset === undefined ? t('report.unlinked') : `[${asset.type}] ${asset.value}`}`,
      `- ${t('finding.steps')}:`,
      ...(finding.steps ?? []).map((step, index) => `  ${index + 1}. ${step}`),
      '',
    ]
  })
  const assetLines = src.assets.map((asset) => {
    const edge = src.edges.find(candidate => candidate.kind === 'parent' && candidate.targetId === asset.id)
    const parent = edge === undefined ? undefined : src.assets.find(candidate => candidate.id === edge.sourceId)
    const metaText = formatApiMeta(asset.meta)
    return `- [${asset.type}] ${asset.value}${metaText === '' ? '' : ` (${metaText})`}${parent === undefined ? '' : ` <- ${parent.value}`}`
  })
  const checkpointLines = (src.checkpoints ?? []).map(row =>
    `- ${row.id} [${row.stage}] ${row.intentId} / ${row.childSessionId}: ${row.summary || t('report.none')} (+${row.facts} facts, +${row.assets} assets, +${row.findings} findings)`)
  return [
    `# ${t('report.title')}`,
    '',
    `- ${t('report.target')}: ${src.goal.target}`,
    `- ${t('report.objective')}: ${src.goal.objective}`,
    `- ${t('report.authorization')}: ${src.goal.authorization === '' ? t('report.undeclared') : src.goal.authorization}`,
    '',
    `## ${t('report.chain')}`,
    ...(chain.length === 0 ? [t('report.chainEmpty')] : chain),
    '',
    `## ${t('report.findings')}`,
    ...(findingSections.length === 0 ? [t('report.none')] : findingSections),
    `## ${t('report.assets')}`,
    ...(assetLines.length === 0 ? [t('report.none')] : assetLines),
    '',
    `## ${t('report.checkpoints')}`,
    ...(checkpointLines.length === 0 ? [t('report.none')] : checkpointLines),
    '',
    `## ${t('report.blindSpots')}`,
    ...blindSpotLines(src, t),
    '',
  ].join('\n')
}

function blindSpotLines(src: SrcProjection, t: ReportViewProps['t']): string[] {
  const rows = (src.coverage ?? []).filter((row) => {
    if (row === null || typeof row !== 'object') return false
    return (row as { phase?: unknown }).phase === 'blind-spot'
  }) as ReadonlyArray<{ category?: unknown; status?: unknown; limitation?: unknown; evidence?: unknown }>
  if (rows.length === 0) return [t('report.blindSpotsEmpty')]
  const statusLabel = (status: unknown) => status === 'completed' ? t('report.blindSpotCovered') : status === 'blocked' ? t('report.blindSpotUncovered') : status === 'not-applicable' ? t('report.blindSpotNa') : String(status)
  return rows.map((row) => {
    const note = typeof row.limitation === 'string' && row.limitation !== '' ? ` — ${row.limitation}` : ''
    const evidence = Array.isArray(row.evidence) && row.evidence.length > 0 ? `（${t('report.blindSpotEvidence')} ${row.evidence.join(',')}）` : ''
    return `- ${String(row.category ?? '?')}: ${statusLabel(row.status)}${note}${evidence}`
  })
}

function filenameOf(target: string): string {
  const name = target.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `src-report-${name === '' ? 'session' : name}.md`
}

/** Render the report's small, fixed Markdown subset without interpreting HTML. */
function MarkdownPreview({ markdown }: { readonly markdown: string }) {
  const rows: ReactNode[] = []
  for (const [index, line] of markdown.split('\n').entries()) {
    if (line === '') continue
    if (line.startsWith('### ')) rows.push(<h3 key={index}>{line.slice(4)}</h3>)
    else if (line.startsWith('## ')) rows.push(<h2 key={index}>{line.slice(3)}</h2>)
    else if (line.startsWith('# ')) rows.push(<h1 key={index}>{line.slice(2)}</h1>)
    else if (line.startsWith('- ')) rows.push(<p key={index} className={css.bullet}>{line.slice(2)}</p>)
    else if (/^  \d+\. /.test(line)) rows.push(<p key={index} className={css.step}>{line.trim()}</p>)
    else rows.push(<p key={index}>{line}</p>)
  }
  return <article className={css.markdown} data-testid="src-report-markdown">{rows}</article>
}

export function ReportView({ src, t }: ReportViewProps) {
  const markdown = reportOf(src, t)
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyState('done')
    } catch {
      setCopyState('failed')
    }
  }

  const download = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filenameOf(src.goal?.target ?? '')
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className={css.root} data-testid="src-report">
      <header className={css.toolbar}>
        <p className={css.hint}>{t('report.hint')}</p>
        <div className={css.actions}>
          <button type="button" className={css.action} onClick={() => { void copy() }} data-testid="src-report-copy">
            {t(copyState === 'done' ? 'report.copied' : 'report.copy')}
          </button>
          <button type="button" className={css.action} onClick={download} data-testid="src-report-download">
            {t('report.download')}
          </button>
        </div>
      </header>
      {copyState === 'failed' && <p className={css.error} role="status">{t('report.copyFailed')}</p>}
      <MarkdownPreview markdown={markdown} />
    </section>
  )
}
