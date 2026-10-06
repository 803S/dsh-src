import type { CSSProperties } from 'react'
import type { SrcProjection, SrcProjectionNode } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import css from './OverviewView.module.css'

export interface OverviewViewProps {
  readonly src: SrcProjection
  readonly t: PropsLocale['t']
  readonly onNavigate: (tab: string) => void
}

type Finding = SrcProjectionNode & { kind: 'finding' }

function findingsOf(src: SrcProjection): Finding[] {
  return src.nodes.filter((node): node is Finding => node.kind === 'finding')
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return '暂无记录'
  const delta = Math.max(0, Date.now() - timestamp)
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

const severityLabel: Record<string, string> = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
  info: '提示',
}

export function OverviewView({ src, t, onNavigate }: OverviewViewProps) {
  const findings = findingsOf(src)
  const activeFindings = findings.filter(finding => finding.status !== 'rejected')
  const pendingTodos = src.userTodos.filter(todo => todo.status === 'pending')
  const pendingApprovals = src.pendingApprovals.filter(approval => approval.status === 'pending')
  const runningIntents = src.nodes.filter(node => node.kind === 'intent' && node.status === 'running').length
  const completedIntents = src.nodes.filter(node => node.kind === 'intent' && node.status === 'completed').length
  const totalIntents = src.nodes.filter(node => node.kind === 'intent').length
  const coverageRows = src.coverage.filter(row => typeof row.endpointsTotal === 'number' && row.endpointsTotal > 0)
  const covered = coverageRows.reduce((sum, row) => sum + (row.endpointsTested ?? 0), 0)
  const endpointTotal = coverageRows.reduce((sum, row) => sum + (row.endpointsTotal ?? 0), 0)
  const coveragePercent = endpointTotal > 0 ? Math.round((covered / endpointTotal) * 100) : null
  const latestEvent = [
    ...src.nodes,
    ...src.observations,
    ...src.checkpoints,
  ].reduce((latest, row) => Math.max(latest, row.createdAt ?? 0), 0)
  const topFindings = [...activeFindings].sort((a, b) => {
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    return (rank[a.severity] ?? 5) - (rank[b.severity] ?? 5) || b.createdAt - a.createdAt
  }).slice(0, 3)
  const attentionCount = pendingTodos.length + pendingApprovals.length
  const progress = totalIntents > 0 ? Math.round((completedIntents / totalIntents) * 100) : 0

  return (
    <div className={css.root} data-testid="src-overview">
      <section className={css.hero}>
        <div className={css.heroCopy}>
          <div className={css.eyebrow}><span className={css.liveDot} /> SRC ENGAGEMENT · {runningIntents > 0 ? '正在运行' : '已记录'}</div>
          <h2>{src.goal?.target || '未设置目标'}</h2>
          <p>{src.goal?.objective || '等待 agent 记录本次挖掘目标与验证目的。'}</p>
          <div className={css.heroMeta}>
            {src.goal?.authorization ? <span className={css.metaPill}>授权 · {src.goal.authorization}</span> : <span className={`${css.metaPill} ${css.metaPillWarning}`}>尚未声明授权</span>}
            <span className={css.metaMuted}>最近活动 {relativeTime(latestEvent)}</span>
          </div>
        </div>
        <div className={css.heroAction}>
          <div className={css.progressRing} style={{ '--progress': `${progress * 3.6}deg` } as CSSProperties}>
            <div><strong>{progress}%</strong><span>研究进度</span></div>
          </div>
        </div>
      </section>

      {attentionCount > 0 && (
        <section className={css.attention} aria-label="需要处理的事项">
          <div className={css.sectionHeading}>
            <div><span className={css.sectionKicker}>NEXT ACTION</span><h3>现在需要你的操作</h3></div>
            <button type="button" className={css.textButton} onClick={() => onNavigate('todos')}>打开行动中心 →</button>
          </div>
          <div className={css.attentionGrid}>
            {pendingApprovals.length > 0 && <button type="button" className={`${css.attentionItem} ${css.attentionDanger}`} onClick={() => onNavigate('todos')}>
              <span className={css.attentionIcon}>!</span><span><strong>{pendingApprovals.length} 个待审批请求</strong><small>高风险请求或范围确认正在等待你的决定</small></span><span className={css.attentionArrow}>→</span>
            </button>}
            {pendingTodos.length > 0 && <button type="button" className={`${css.attentionItem} ${css.attentionWarning}`} onClick={() => onNavigate('todos')}>
              <span className={css.attentionIcon}>↗</span><span><strong>{pendingTodos.length} 个用户待办</strong><small>登录态、抓包或其他人工协助会阻塞研究</small></span><span className={css.attentionArrow}>→</span>
            </button>}
          </div>
        </section>
      )}

      <section className={css.metricGrid} aria-label="研究摘要">
        <button type="button" className={`${css.metricCard} ${activeFindings.length > 0 ? css.metricHot : ''}`} onClick={() => onNavigate('findings')}>
          <span className={css.metricLabel}>已发现漏洞</span><strong>{activeFindings.length}</strong><span className={css.metricHint}>{activeFindings.length > 0 ? '进入结果审阅' : '继续推进研究方向'} <span>→</span></span>
        </button>
        <button type="button" className={css.metricCard} onClick={() => onNavigate('explore')}>
          <span className={css.metricLabel}>研究方向</span><strong>{totalIntents}</strong><span className={css.metricHint}>{runningIntents > 0 ? `${runningIntents} 个正在执行` : '探索链路'} <span>→</span></span>
        </button>
        <button type="button" className={css.metricCard} onClick={() => onNavigate('assets')}>
          <span className={css.metricLabel}>已登记资产</span><strong>{src.assets.length}</strong><span className={css.metricHint}>资产清单与覆盖范围 <span>→</span></span>
        </button>
        <button type="button" className={`${css.metricCard} ${coveragePercent !== null && coveragePercent < 70 ? css.metricWarm : ''}`} onClick={() => onNavigate('timeline')}>
          <span className={css.metricLabel}>接口覆盖</span><strong>{coveragePercent === null ? '—' : `${coveragePercent}%`}</strong><span className={css.metricHint}>{endpointTotal > 0 ? `${covered} / ${endpointTotal} 已实测` : '暂无对账数据'} <span>→</span></span>
        </button>
      </section>

      <div className={css.columns}>
        <section className={css.panel}>
          <div className={css.sectionHeading}><div><span className={css.sectionKicker}>FINDINGS</span><h3>最值得先看的结果</h3></div><button type="button" className={css.textButton} onClick={() => onNavigate('findings')}>全部漏洞 →</button></div>
          {topFindings.length === 0 ? <div className={css.emptyPanel}><span>◌</span><p>还没有已确认的漏洞结果<br /><small>Agent 会在验证完成后把结果汇总到这里</small></p></div> : <div className={css.resultList}>{topFindings.map(finding => <button type="button" className={css.resultRow} key={finding.id} onClick={() => onNavigate('findings')}><span className={css.severityDot} data-severity={finding.severity} /><span className={css.resultBody}><strong>{finding.title}</strong><small>{finding.description || finding.impact || '已记录结果，打开详情查看完整证据。'}</small></span><span className={css.resultSeverity} data-severity={finding.severity}>{severityLabel[finding.severity] ?? finding.severity}</span></button>)}</div>}
        </section>
        <section className={css.panel}>
          <div className={css.sectionHeading}><div><span className={css.sectionKicker}>OPERATIONS</span><h3>运行概览</h3></div><button type="button" className={css.textButton} onClick={() => onNavigate('timeline')}>查看活动 →</button></div>
          <div className={css.operationList}>
            <div><span className={`${css.operationIcon} ${css.operationBlue}`}>◈</span><span><strong>探索链路</strong><small>{src.counts?.facts ?? 0} 个事实 · {src.counts?.observations ?? 0} 次探测</small></span><b>{src.counts?.checkpoints ?? 0}</b></div>
            <div><span className={`${css.operationIcon} ${css.operationGreen}`}>✓</span><span><strong>认证预算</strong><small>{src.authBudget ? `${src.authBudget.used} / ${src.authBudget.limit} 次已使用` : '暂未记录预算'}</small></span><b>{src.authBudget ? `${Math.round((src.authBudget.used / Math.max(src.authBudget.limit, 1)) * 100)}%` : '—'}</b></div>
            <div><span className={`${css.operationIcon} ${css.operationPurple}`}>⌁</span><span><strong>API 发现</strong><small>{src.apiDiscovery ? `${src.apiDiscovery.total} 个端点 · ${src.apiDiscovery.untouched} 个未推进` : '暂无 API 发现统计'}</small></span><b>{src.apiDiscovery?.total ?? 0}</b></div>
          </div>
        </section>
      </div>
      <p className={css.disclaimer}>{t('report.hint')} · 数据来自当前会话的权威 SRC 状态</p>
    </div>
  )
}
