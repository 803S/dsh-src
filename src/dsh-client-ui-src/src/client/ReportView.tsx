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
  const activeFindings = findings.filter((finding) => (finding.status ?? 'active') === 'active')
  const rejectedFindings = findings.filter((finding) => (finding.status ?? 'active') === 'rejected')
  const chain = src.nodes.map((node) => {
    const anchor = src.edges.find(edge => edge.targetId === node.id)
    const relation = anchor === undefined ? '' : ` (${anchor.kind} ${anchor.sourceId})`
    if (node.kind === 'intent') return `- ${t('kind.intent')} (${node.id}) ${node.title}${node.detail === '' ? '' : `: ${node.detail}`}${relation}`
    if (node.kind === 'fact') return `- ${t('kind.fact')} (${node.id}) [${node.factKind}] ${node.target === '' ? '' : `${node.target}: `}${node.detail}${relation}`
    const rejectTag = (node.status ?? 'active') === 'rejected' ? ' ⚠' + t('report.rejected') : ''
    return `- ${t('kind.finding')} (${node.id}) [${node.severity}] ${node.title}${rejectTag}${relation}`
  })
  const findingSections = activeFindings.flatMap((finding) => {
    const asset = finding.affectedAssetId === undefined ? undefined : src.assets.find(candidate => candidate.id === finding.affectedAssetId)
    /* 收集本 finding 涉及的所有 URL，去重，; 分隔。 */
    const urls = (() => {
      const found = new Set<string>()
      const haystack = (finding.pocEvidence ?? []).join('\n') + '\n' + (finding.steps ?? []).join('\n') + '\n' + (finding.rawRequest ?? '') + '\n' + (finding.rawResponse ?? '')
      for (const m of haystack.matchAll(/https?:\/\/[^\s'")\]]+/g)) found.add(m[0])
      const list = [...found]
      if (list.length === 0) list.push(asset === undefined ? (src.goal?.target ?? '') : asset.value)
      return list.join('; ')
    })()
    /* 第 1 节：漏洞描述&发现方式、漏洞利用及危害——动态填充，空字段不显示、不占位。
       attackChain 本身就是发现→利用→危害的闭合叙事，有则作为主叙述直接融入，不单列【攻击链】块。 */
    const section1 = (() => {
      const lines: string[] = []
      const chain = (finding.attackChain ?? '').trim()
      if (chain !== '') lines.push(chain)
      else if (finding.description !== '') lines.push(finding.description)
      if (lines.length === 0) lines.push(finding.title)
      /* 危害链要素：非空才列出。有 attackChain 主叙述时 impact 已含在叙事中不重复。 */
      if (chain === '' && (finding.impact ?? '') !== '') lines.push(`${t('finding.impact')}: ${finding.impact}`)
      if ((finding.attackPrerequisites ?? '') !== '') lines.push(`${t('finding.attackPrerequisites')}: ${finding.attackPrerequisites}`)
      if ((finding.victimImpact ?? '') !== '') lines.push(`${t('finding.victimImpact')}: ${finding.victimImpact}`)
      if (finding.affectedScope !== '') lines.push(`${t('finding.scope')}: ${finding.affectedScope}`)
      /* 发现方式 / 入口 / app 版本与下载：根据实际情况动态，非空才提。 */
      if (finding.discoveryPath !== '') lines.push(`${t('finding.discoveryPath')}: ${finding.discoveryPath}`)
      if (finding.entryPoint !== '') lines.push(`${t('finding.entryPoint')}: ${finding.entryPoint}`)
      if (asset !== undefined) {
        const meta = String(asset.meta ?? '')
        if (asset.type === 'app' || asset.type === 'mini-program') {
          const dl = meta.match(/(https?:\/\/[^\s'"]+)/)
          if (dl !== null) lines.push(`${t('report.appDownload')}: ${dl[0]}`)
        }
      }
      return lines.length === 0 ? t('report.none') : lines.join('\n')
    })()
    /* 第 2 节：详细复现/证明过程——请求/响应/脚本走代码框，步骤清晰呈现。 */
    const reproBlock = (() => {
      const lines: string[] = []
      if ((finding.steps ?? []).length > 0) {
        ;(finding.steps ?? []).forEach((step, index) => lines.push(`${index + 1}. ${step}`))
        lines.push('')
      }
      if ((finding.rawRequest ?? '') !== '') lines.push('=== Request ===', '```', finding.rawRequest, '```')
      if ((finding.rawResponse ?? '') !== '') { if (lines.length > 0) lines.push(''); lines.push('=== Response ===', '```', finding.rawResponse, '```') }
      if ((finding.rawRequest ?? '') === '' && (finding.rawResponse ?? '') === '' && (finding.pocEvidence ?? []).length > 0) {
        if (lines.length > 0) lines.push('')
        lines.push(`${t('finding.evidence')}:`)
        ;(finding.pocEvidence ?? []).forEach((evidence, index) => lines.push(`${index + 1}. ${evidence}`))
      }
      /* [local.27] 一键 PoC 脚本：独立代码块，保留缩进与换行。 */
      if ((finding.pocScript ?? '').trim() !== '') {
        if (lines.length > 0) lines.push('')
        lines.push(`${t('report.pocScript')}:`, '```', finding.pocScript, '```')
      }
      return lines.length === 0 ? t('report.missing') : lines.join('\n')
    })()
    /* 测试源信息：从 concreteLossEvidence 指针解析。 */
    const testSource = (() => {
      const factNodes = src.nodes.filter((node): node is SrcProjectionNode & { kind: 'fact' } => node.kind === 'fact')
      const lines: string[] = []
      for (const evidenceId of (finding.concreteLossEvidence ?? [])) {
        const fact = factNodes.find((f) => f.id === evidenceId)
        if (fact !== undefined) { lines.push(`- ${fact.target === '' ? '' : fact.target + ': '}${fact.detail}`); continue }
        const research = (src.research ?? []).find((r) => r.id === evidenceId)
        if (research !== undefined) { lines.push(`- [${research.category}] ${research.hypothesis}`); continue }
        lines.push(`- ${evidenceId}`)
      }
      if (asset !== undefined) lines.push(`- ${t('finding.affected')}: [${asset.type}] ${asset.value}`)
      return lines.length === 0 ? t('report.none') : lines.join('\n')
    })()
    const vulnType = (finding.vulnType ?? '') === '' ? t('report.uncategorized') : finding.vulnType
    /* [local.29] 美团 SRC 骨架模板：4 字段 + 漏洞风险详情 4 小节，内容动态填充，空字段不占位。 */
    return [
      `### ${finding.id} ${finding.title}`,
      '',
      `**${t('report.name')}**：${finding.title}`,
      `**${t('report.vulnType')}**：${vulnType}`,
      `**${t('report.url')}**：${urls}`,
      `**${t('report.severity')}**：${finding.severity}`,
      '',
      `**${t('report.riskDetail')}**`,
      '',
      `**${t('report.section1')}**`,
      '',
      section1,
      '',
      `**${t('report.section2')}**`,
      '',
      reproBlock,
      '',
      `**${t('report.section3')}**`,
      '',
      testSource,
      '',
      `**${t('report.section4')}**`,
      '',
      finding.remediation === '' ? t('report.missing') : finding.remediation,
      '',
    ]
  })
  const rejectedLines = rejectedFindings.map((finding) => `- ${finding.id} [${finding.severity}] ${finding.title}——${t('report.rejectReason')}: ${finding.rejectReason ?? t('report.none')}${finding.rejectedAt ? `（${new Date(finding.rejectedAt).toISOString()}）` : ''}`)
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
    '',
    `## ${t('report.rejected')}`,
    ...(rejectedLines.length === 0 ? [t('report.none')] : rejectedLines),
    '',
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
  const lines = markdown.split('\n')
  let inCode = false
  let codeBuffer: string[] = []
  let codeKey = 0
  let paraKey = 0
  /* 行内渲染：`code` 与 **bold**（不改语义，只为让报错/标识可读）。 */
  const renderInline = (text: string): ReactNode => {
    const parts: ReactNode[] = []
    let rest = text
    let i = 0
    while (rest !== '') {
      const code = rest.match(/`([^`]+)`/)
      const bold = rest.match(/\*\*([^*]+)\*\*/)
      const next = [code, bold].filter((m): m is RegExpMatchArray => m !== null).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0]
      if (next === undefined) { parts.push(rest); break }
      const at = next.index ?? 0
      if (at > 0) parts.push(rest.slice(0, at))
      if (next === code) parts.push(<code key={i++} className={css.inlineCode}>{next[1]}</code>)
      else parts.push(<strong key={i++}>{next[1]}</strong>)
      rest = rest.slice(at + next[0].length)
    }
    return <>{parts}</>
  }
  for (const [index, line] of lines.entries()) {
    if (inCode) {
      if (line.trim() === '```') { rows.push(<pre key={`code-${codeKey++}`} className={css.codeblock}><code>{codeBuffer.join('\n')}</code></pre>); inCode = false; codeBuffer = []; continue }
      codeBuffer.push(line)
      continue
    }
    if (line.trim() === '```') { inCode = true; codeBuffer = []; continue }
    if (line === '') { rows.push(<div key={`blank-${index}`} className={css.blank} />); continue }
    if (line.startsWith('### ')) rows.push(<h3 key={index}>{renderInline(line.slice(4))}</h3>)
    else if (line.startsWith('## ')) rows.push(<h2 key={index}>{renderInline(line.slice(3))}</h2>)
    else if (line.startsWith('# ')) rows.push(<h1 key={index}>{renderInline(line.slice(2))}</h1>)
    else if (line.startsWith('- ')) rows.push(<p key={index} className={css.bullet}>{renderInline(line.slice(2))}</p>)
    else if (/^  \d+\. /.test(line)) rows.push(<p key={index} className={css.step}>{line.trim()}</p>)
    else rows.push(<p key={`p-${paraKey++}`}>{renderInline(line)}</p>)
  }
  /* 未闭合的代码块（rawRequest 等末尾缺少 ```` ）：把已缓冲的行收尾渲染，不丢内容。 */
  if (inCode && codeBuffer.length > 0) rows.push(<pre key={`code-${codeKey++}`} className={css.codeblock}><code>{codeBuffer.join('\n')}</code></pre>)
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
