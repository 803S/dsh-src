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

/* [local.32] 报告新增五节的渲染辅助：API 发现摘要 / 资产与测试覆盖率 / 漏洞研究矩阵 /
   建议人工测试的 AI·威胁情报资产 / ⏸ 等你的事。内容口径与服务端 buildReport 一致，
   呈现用 markdown 表格 + 状态徽标（预览更可读；下载的 .md 仍是标准管道表格）。 */

/** 表格单元格消毒：竖线会破行，换行会破表。 */
function mdCell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '｜').replace(/\r?\n/g, ' ').trim()
}

function mdTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => mdCell(cell)).join(' | ')} |`),
  ]
}

function researchStatusLabel(t: ReportViewProps['t'], status: string): string {
  if (status === 'verified') return `✅ ${t('report.stVerified')}`
  if (status === 'reproduced') return `🧪 ${t('report.stReproduced')}`
  if (status === 'testing') return `🔄 ${t('report.stTesting')}`
  if (status === 'false-positive') return `❌ ${t('report.stFalsePositive')}`
  if (status === 'blocked') return `⛔ ${t('report.stBlocked')}`
  return `💭 ${t('report.stHypothesis')}`
}

function coverageStatusLabel(t: ReportViewProps['t'], status: string): string {
  if (status === 'completed') return `✅ ${t('report.stCompleted')}`
  if (status === 'running') return `🔄 ${t('report.stRunning')}`
  if (status === 'blocked') return `⛔ ${t('report.stBlocked')}`
  if (status === 'not-applicable') return `➖ ${t('report.stNa')}`
  return `📅 ${t('report.stPlanned')}`
}

/** API 发现摘要：统计直接用投影里服务端算好的 apiDiscovery（口径一致），示例客户端取前 5。 */
function apiSummaryLines(src: SrcProjection, t: ReportViewProps['t']): string[] {
  const stats = src.apiDiscovery ?? { total: 0, schemas: 0, graphql: 0, hints: 0, untouched: 0 }
  const table = mdTable(
    [t('report.apiTotal'), t('report.apiSchemas'), t('report.apiGraphql'), t('report.apiHints'), t('report.apiUntouched')],
    [[String(stats.total), String(stats.schemas), String(stats.graphql), String(stats.hints), String(stats.untouched)]],
  )
  const apiAssets = src.assets.filter((asset) => asset.type === 'endpoint' && typeof asset.meta === 'string' && asset.meta.startsWith('api:'))
  const examples = apiAssets.slice(0, 5).map((asset) => {
    const meta = formatApiMeta(asset.meta)
    return `- \`${asset.value}\`${meta === '' ? '' : `（${meta}）`}`
  })
  return [...table, ...(examples.length === 0 ? [t('report.none')] : examples)]
}

/** 资产与测试覆盖率：表格呈现（blind-spot 行归「覆盖维度声明」节，不在此重复）。 */
function coverageTableLines(src: SrcProjection, t: ReportViewProps['t']): string[] {
  const rows = (src.coverage ?? []).filter((row) => row.phase !== 'blind-spot')
  if (rows.length === 0) return [t('report.none')]
  return mdTable(
    [t('report.colId'), t('report.colStatus'), t('report.colPhase'), t('report.colCategory'), t('report.colAsset'), t('report.colEndpoints'), t('report.colLimitation'), t('report.colEvidence')],
    rows.map((row) => {
      const skipped = row.endpointsSkipped ?? []
      const endpoints = row.endpointsTotal === undefined ? '—' : `${row.endpointsTested ?? 0}/${row.endpointsTotal}${skipped.length > 0 ? `（跳过${skipped.length}）` : ''}`
      return [row.id, coverageStatusLabel(t, row.status), row.phase, row.category, row.assetId ?? '—', endpoints, row.limitation === '' ? '—' : row.limitation, row.evidence.length === 0 ? '—' : row.evidence.join('; ')]
    }),
  )
}

/** 漏洞研究矩阵：假设 → 测试/复现 → 结论，一张表看完研究走向。 */
function researchTableLines(src: SrcProjection, t: ReportViewProps['t']): string[] {
  const rows = src.research ?? []
  if (rows.length === 0) return [t('report.none')]
  return mdTable(
    [t('report.colId'), t('report.colStatus'), t('report.colCategory'), t('report.colHypothesis'), t('report.colStopReason')],
    rows.map((row) => [row.id, researchStatusLabel(t, row.status), row.category, row.hypothesis, row.stopReason === '' ? '—' : row.stopReason]),
  )
}

/** 建议人工测试的 AI/威胁情报资产：列表 + 一条说明（服务端每行重复同一句，UI 收敛为一行）。 */
function aiAssetLines(src: SrcProjection, t: ReportViewProps['t']): string[] {
  const rows = src.assets.filter((asset) => asset.type === 'ai-surface' || asset.type === 'threat-intel')
  if (rows.length === 0) return [t('report.none')]
  return [...rows.map((asset) => `- [${asset.type}] ${asset.value}${asset.meta === '' ? '' : `（${asset.meta}）`}`), '', t('report.aiAssetsNote')]
}

/** ⏸ 等你的事：未完成待办 + 挂起（blocked）且没有对应待办的意图。 */
function waitingOnYouLines(src: SrcProjection, t: ReportViewProps['t']): string[] {
  const pendingTodos = (src.userTodos ?? []).filter((todo) => todo.status === 'pending')
  const lines = pendingTodos.map((todo) => `- [${todo.kind}] ${todo.title}${todo.detail === '' ? '' : ` — ${todo.detail}`}`)
  const blockedIntents = src.nodes.filter((node): node is SrcProjectionNode & { kind: 'intent' } => node.kind === 'intent' && node.status === 'blocked')
  for (const node of blockedIntents) {
    if (pendingTodos.some((todo) => todo.intentId === node.id)) continue
    lines.push(`- ${node.id}/${node.title} — ${t('report.waitingBlockedLabel')}${node.detail === '' ? '' : `（${node.detail}）`}: ${t('report.waitingBlocked')}`)
  }
  if (lines.length === 0) return [t('report.waitingEmpty')]
  return [...lines, '', t('report.waitingHint')]
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
  const rejectedLines = rejectedFindings.map((finding) => `- ${finding.id} [${finding.severity}] ${finding.title}——${t('report.rejectReason')}: ${finding.rejectReason ?? t('report.rejectReasonMissing')}${finding.rejectedAt ? `（${new Date(finding.rejectedAt).toISOString()}）` : ''}`)
  const assetLines = src.assets.map((asset) => {
    const edge = src.edges.find(candidate => candidate.kind === 'parent' && candidate.targetId === asset.id)
    const parent = edge === undefined ? undefined : src.assets.find(candidate => candidate.id === edge.sourceId)
    const metaText = formatApiMeta(asset.meta)
    return `- [${asset.type}] ${asset.value}${metaText === '' ? '' : ` (${metaText})`}${parent === undefined ? '' : ` <- ${parent.value}`}`
  })
  const checkpointLines = (src.checkpoints ?? []).map(row =>
    `- ${row.id} [${row.stage}] ${row.intentId} / ${row.childSessionId}: ${row.summary || t('report.noSummary')} (+${row.facts} facts, +${row.assets} assets, +${row.findings} findings)`)
  /* [local.32] 节标题全部走 report.sec.*（zh 与服务端 buildReport 逐字一致，tests 有完整性闸对比两侧集合）；
     节顺序与 buildReport 严格相同：探索链路→漏洞发现→已打回→API 发现摘要→资产→资产与测试覆盖率→
     漏洞研究矩阵→子 Agent 检查点→AI/威胁情报资产→覆盖维度声明→⏸ 等你的事。 */
  return [
    `# ${t('report.title')}`,
    '',
    `- ${t('report.target')}: ${src.goal.target}`,
    `- ${t('report.objective')}: ${src.goal.objective}`,
    `- ${t('report.authorization')}: ${src.goal.authorization === '' ? t('report.undeclared') : src.goal.authorization}`,
    '',
    `## ${t('report.sec.chain')}`,
    ...(chain.length === 0 ? [t('report.chainEmpty')] : chain),
    '',
    `## ${t('report.sec.findings')}`,
    ...(findingSections.length === 0 ? [t('report.none')] : findingSections),
    '',
    `## ${t('report.sec.rejected')}`,
    ...(rejectedLines.length === 0 ? [t('report.none')] : rejectedLines),
    '',
    `## ${t('report.sec.apiSummary')}`,
    ...apiSummaryLines(src, t),
    '',
    `## ${t('report.sec.assets')}`,
    ...(assetLines.length === 0 ? [t('report.none')] : assetLines),
    '',
    `## ${t('report.sec.coverage')}`,
    ...coverageTableLines(src, t),
    '',
    `## ${t('report.sec.research')}`,
    ...researchTableLines(src, t),
    '',
    `## ${t('report.sec.checkpoints')}`,
    ...(checkpointLines.length === 0 ? [t('report.none')] : checkpointLines),
    '',
    `## ${t('report.sec.aiAssets')}`,
    ...aiAssetLines(src, t),
    '',
    `## ${t('report.sec.blindSpots')}`,
    ...blindSpotLines(src, t),
    '',
    `## ${t('report.sec.waitingOnYou')}`,
    ...waitingOnYouLines(src, t),
    '',
  ].join('\n')
}

function blindSpotLines(src: SrcProjection, t: ReportViewProps['t']): string[] {
  const rows = (src.coverage ?? []).filter((row) => row.phase === 'blind-spot')
  if (rows.length === 0) return [t('report.blindSpotsEmpty')]
  const statusLabel = (status: SrcProjectionCoverageRow['status']) => status === 'completed' ? t('report.blindSpotCovered') : status === 'blocked' ? t('report.blindSpotUncovered') : status === 'not-applicable' ? t('report.blindSpotNa') : status
  return rows.map((row) => {
    const note = row.limitation !== '' ? ` — ${row.limitation}` : ''
    const evidence = row.evidence.length > 0 ? `（${t('report.blindSpotEvidence')} ${row.evidence.join(',')}）` : ''
    return `- ${row.category}: ${statusLabel(row.status)}${note}${evidence}`
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
