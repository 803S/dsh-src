/**
 * ReportView: render, copy, and download the current src projection as
 * Markdown. [SRC] extends the upstream pentest report with impact/victim
 * impact, domain + full URL extraction, the raw request/response data
 * packet, per-asset API-meta formatting (formatApiMeta), and a child-agent
 * checkpoints section. [UI-source rebuild] restored from the local.21 bundle.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SrcProjection, SrcProjectionCoverageRow, SrcProjectionNode } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import css from './ReportView.module.css'

export interface ReportViewProps {
  readonly src: SrcProjection
  readonly t: PropsLocale['t']
}

function reportOf(src: SrcProjection, t: ReportViewProps['t']): string {
  if (src.goal === null) return `# ${t('report.title')}\n\n${t('report.uninitialized')}\n`

  const findings = src.nodes.filter((node): node is SrcProjectionNode & { kind: 'finding' } => node.kind === 'finding')
  const activeFindings = findings.filter((finding) => (finding.status ?? 'active') === 'active')
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
    /* 第 1 节：漏洞描述&发现方式、漏洞利用及危害。结构：一句话描述 → 【攻击链】垂直从上到下（动态、空步骤不占位）→
       前端定位信息（前端功能点/应用下载/影响范围，复现必需）。 */
    const section1 = (() => {
      const lines: string[] = []
      /* 一句话描述（简洁）。 */
      if (finding.description !== '') lines.push(finding.description, '')
      /* 攻击链：垂直从上到下。attackChain 字段非空时原样呈现；否则从结构化字段构建①到⑤，仅非空步骤、不占位。 */
      const chainLines: string[] = []
      const chainField = (finding.attackChain ?? '').trim()
      if (chainField !== '') chainLines.push(chainField)
      else {
        if (finding.discoveryPath !== '') chainLines.push(`① 发现：${finding.discoveryPath}`)
        if ((finding.attackPrerequisites ?? '') !== '') chainLines.push(`② 利用前提：${finding.attackPrerequisites}`)
        if ((finding.impact ?? '') !== '') chainLines.push(`③ 利用过程：${finding.impact}`)
        if ((finding.concreteLossEvidence ?? []).length > 0) chainLines.push(`④ 实际损失：${(finding.concreteLossEvidence ?? []).join('; ')}`)
        if ((finding.victimImpact ?? '') !== '') chainLines.push(`⑤ 受害者影响：${finding.victimImpact}`)
      }
      if (chainLines.length > 0) lines.push('【攻击链】', ...chainLines, '')
      /* 前端定位信息：复现必需。web 漏洞填前端功能点；app 漏洞要有应用下载；需登录的在②利用前提已注明登录入口。 */
      if (finding.entryPoint !== '') lines.push(`${t('finding.entryPoint')}：${finding.entryPoint}`)
      if (asset !== undefined && (asset.type === 'app' || asset.type === 'mini-program')) {
        const meta = String(asset.meta ?? '')
        const dl = meta.match(/(https?:\/\/[^\s'"]+)/)
        const download = dl !== null ? dl[0] : (asset.value.startsWith('http') ? asset.value : (meta !== '' ? meta : asset.value))
        lines.push(`${t('report.appDownload')}：${download}`)
      }
      if (finding.affectedScope !== '') lines.push(`${t('finding.scope')}：${finding.affectedScope}`)
      return lines.length === 0 ? t('report.none') : lines.join('\n').replace(/\n+$/, '')
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
  /* [local.82] 报告=交付物：漏洞发现 + 测试范围与限制。内部过程数据撤出（服务端 buildReport 同构）。 */
  return [
    `# ${t('report.title')}`,
    '',
    `- ${t('report.target')}: ${src.goal.target}`,
    `- ${t('report.objective')}: ${src.goal.objective}`,
    `- ${t('report.authorization')}: ${src.goal.authorization === '' ? t('report.undeclared') : src.goal.authorization}`,
    '',
    `## ${t('report.sec.findings')}`,
    ...(findingSections.length === 0 ? [t('report.none')] : findingSections),
    '',
    `## ${t('report.sec.scope')}`,
    ...scopeLimitationLines(src, t),
  ].join('\n')
}

/** 测试范围与限制：blindSpots 声明 ∪ coverage 行限制说明 ∪ 跳过接口计数（口径与服务端 buildReport 一致）。 */
function scopeLimitationLines(src: SrcProjection, t: ReportViewProps['t']): string[] {
  const rows = (src.coverage ?? []).filter((row) => row.phase === 'blind-spot')
  const statusLabel = (status: SrcProjectionCoverageRow['status']) => status === 'completed' ? t('report.blindSpotCovered') : status === 'blocked' ? t('report.blindSpotUncovered') : status === 'not-applicable' ? t('report.blindSpotNa') : status
  const lines: string[] = [
    ...rows.map((row) => {
      const note = row.limitation !== '' ? ` — ${row.limitation}` : ''
      const evidence = row.evidence.length > 0 ? `（${t('report.blindSpotEvidence')} ${row.evidence.join(',')}）` : ''
      return `- ${row.category}: ${statusLabel(row.status)}${note}${evidence}`
    }),
    ...(src.coverage ?? []).filter((row) => row.phase !== 'blind-spot' && row.limitation !== '').map((row) => `- ${row.phase}/${row.category}: ${row.limitation}`),
  ]
  const skipped = (src.coverage ?? []).reduce((sum, row) => sum + (row.endpointsSkipped ?? []).length, 0)
  if (skipped > 0) lines.push(`- ${t('report.skippedEndpoints')}`.replace('N', String(skipped)))
  return lines.length === 0 ? [t('report.none')] : lines
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
  let tableKey = 0
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
  const isTableDelimiter = (line: string): boolean => /^\|(\s*:?-+:?\s*\|)+$/.test(line.trim())
  const cellsOf = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (inCode) {
      if (line.trim() === '```') { rows.push(<pre key={`code-${codeKey++}`} className={css.codeblock}><code>{codeBuffer.join('\n')}</code></pre>); inCode = false; codeBuffer = []; continue }
      codeBuffer.push(line)
      continue
    }
    if (line.trim() === '```') { inCode = true; codeBuffer = []; continue }
    /* [local.32] 管道表格：表头行 + `---` 分隔行 + 数据行 → 原生 table（斑马纹/圆角由 css 负责；
       代码块内的表格不会被解析——inCode 分支先行）。 */
    if (line.trim().startsWith('|') && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
      const header = cellsOf(line)
      const body: string[][] = []
      let cursor = index + 2
      while (cursor < lines.length && lines[cursor].trim().startsWith('|')) { body.push(cellsOf(lines[cursor])); cursor += 1 }
      rows.push(
        <div key={`table-${tableKey++}`} className={css.tableWrap}>
          <table className={css.table}>
            <thead><tr>{header.map((cell, i) => <th key={i}>{renderInline(cell)}</th>)}</tr></thead>
            <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderInline(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      index = cursor - 1
      continue
    }
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
