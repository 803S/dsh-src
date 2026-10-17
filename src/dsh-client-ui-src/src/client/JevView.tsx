/**
 * JevView: the judgement-service work panel ("Jev" tab).
 *
 * Data path (single source of truth): the judgement funnel (`jevDecide`)
 * records every decision into the src storage domain, the store publishes the
 * authoritative snapshot, and the snapshot carries `src.jev` into this tab.
 * Nothing here reads telemetry JSONL — telemetry is switchable and post-hoc,
 * while this panel must show the work the service actually did for the
 * CURRENT goal.
 *
 * Compatibility: `src.jev` is optional. Sessions created before [local.106],
 * old projection checkpoints (0.1 restores from them), and any state the 0.1
 * wire schema strips render the empty state instead of throwing.
 */
import type { SrcProjection, SrcProjectionJevEntry, SrcProjectionJevStats } from '../../types/projection'
import type { PropsLocale } from '../../types/slots'
import css from './JevView.module.css'
import ui from './Controls.module.css'

/** Decision duties of the judgement service, in the order the service uses them. */
const TASKS = ['risk-grade', 'scan-plan', 'delegate', 'skill-activate', 'browser-index'] as const
/** Mirrors DECISION_RECENT_LIMIT in lib/src/decision/stats.js (store-side window). */
const MAX_ROWS = 20
/** Row kinds carried by `src.jev.recent` (offer/adopt rows interleave with decisions). */
const KINDS = ['decision', 'offer', 'adopt'] as const

const num = (value: number | undefined): number => (Number.isFinite(value) && (value ?? 0) > 0 ? Math.round(value as number) : 0)
const share = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—')
/** Counter rows, biggest first (bounded keys come from the store-side fold). */
const sorted = (map: Readonly<Record<string, number>> | undefined): Array<[string, number]> =>
  Object.entries(map ?? {}).filter(([key, value]) => key !== '' && num(value) > 0)
    .map(([key, value]): [string, number] => [key, num(value)])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
const when = (at: number): string => at > 0 ? new Date(at).toLocaleString([], { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
/** Duty label: known duties are localized, anything else (tampered/legacy row) renders as text. */
const taskLabel = (task: string, t: PropsLocale['t']) => (TASKS as readonly string[]).includes(task) || task === 'unsupported' ? t(`jev.task.${task}` as `jev.task.${typeof TASKS[number] | 'unsupported'}`) : task
const kindLabel = (kind: string, t: PropsLocale['t']) => (KINDS as readonly string[]).includes(kind) ? t(`jev.kind.${kind}` as `jev.kind.${typeof KINDS[number]}`) : kind

function Bars({ title, hint, map, total, testId }: {
  title: string
  hint: string
  map: Readonly<Record<string, number>> | undefined
  total: number
  testId: string
}) {
  const list = sorted(map)
  const peak = list[0]?.[1] ?? 1
  return <section className={css.card} data-testid={testId}>
    <header className={css.cardHeader}><h3>{title}</h3><p>{hint}</p></header>
    {list.length === 0
      ? <p className={css.none}>—</p>
      : <ul className={css.bars}>{list.map(([key, value]) => <li key={key}>
        <span className={css.barLabel} title={key}>{key}</span>
        <span className={css.barTrack} aria-hidden="true"><span className={css.barFill} style={{ width: `${Math.max(6, Math.round((value / peak) * 100))}%` }} /></span>
        <span className={css.barValue}>{value}<small>{share(value, total)}</small></span>
      </li>)}</ul>}
  </section>
}

function RecentRow({ entry, t }: { entry: SrcProjectionJevEntry; t: PropsLocale['t'] }) {
  const verdict = [entry.action, entry.effect].filter(part => part !== '').join(' · ') || '—'
  const model = [entry.model, entry.mode === '' ? '' : `mode=${entry.mode}`].filter(part => part !== '').join(' · ')
  return <tr data-testid="src-jev-row" data-fallback={entry.fallback ? 'true' : 'false'} data-kind={entry.kind}>
    <td>{when(entry.at)}</td>
    <td>{taskLabel(entry.taskType, t)}</td>
    <td>{entry.kind === 'decision' ? verdict : '—'}{entry.kind === 'decision' && entry.risk !== '' ? <span className={css.chip}>{entry.risk}</span> : null}</td>
    <td>{entry.fallback
      ? <><span className={css.badge} data-tone="fallback">{t('jev.badge.fallback')}</span>{entry.errorType === undefined ? null : <div className={css.error}>{entry.errorType}</div>}</>
      : <span className={css.badge} data-tone="ok">{t('jev.badge.ok')}</span>}</td>
    <td>{entry.latency === undefined ? '—' : `${entry.latency} ms`}</td>
    <td>{model === '' ? '—' : model}</td>
    <td className={css.subject} title={entry.subject}>
      {entry.kind === 'decision' ? null : <span className={css.kind}>{kindLabel(entry.kind, t)}</span>}
      {entry.subject === '' ? '—' : entry.subject}
      {entry.recommendationId === undefined ? null : <code>{` ${entry.recommendationId}`}</code>}
    </td>
  </tr>
}

export function JevView({ src, t }: { src: SrcProjection; t: PropsLocale['t'] }) {
  const stats: SrcProjectionJevStats | null = src.jev?.stats ?? null
  const recent: readonly SrcProjectionJevEntry[] = src.jev?.recent ?? []
  const total = num(stats?.total)
  const fallback = num(stats?.fallback)
  const offered = num(stats?.offered)
  const adopted = num(stats?.adopted)
  const activities = total + offered + adopted
  const latency = stats?.latency
  const avg = latency === undefined || latency.count <= 0 ? 0 : Math.round(latency.sum / latency.count)
  const errors = sorted(stats?.errors)
  const errorPeak = errors[0]?.[1] ?? 1
  const duties: string[] = [...TASKS, ...(num(stats?.byTask.unsupported) > 0 ? ['unsupported'] : [])]
  return <section className={`${ui.scope} ${css.root}`} data-testid="src-jev">
    <div className={css.panel}>
      <header className={css.header}>
        <div className={css.logo} aria-hidden="true">◇</div>
        <div>
          <span className={css.eyebrow}>JEV DECISION SERVICE</span>
          <h2>{t('jev.title')}</h2>
          <p>{t('jev.subtitle')}</p>
        </div>
        <span className={css.status}>{t('jev.scopeBadge')}</span>
      </header>
      <p className={css.scope}>{t('jev.scope')}</p>
      {activities === 0
        ? <div className={css.empty} data-testid="src-jev-empty">
          <h3>{t('jev.empty.title')}</h3>
          <p>{t('jev.empty.body')}</p>
        </div>
        : <>
          <div className={css.metrics}>
            <div className={css.metric} data-testid="src-jev-metric-total">
              <span>{t('jev.metric.total')}</span>
              <strong data-testid="src-jev-total">{total}</strong>
              <small>{t('jev.metric.totalHint')}</small>
            </div>
            <div className={css.metric} data-testid="src-jev-metric-fallback">
              <span>{t('jev.metric.fallback')}</span>
              <strong data-testid="src-jev-fallback">{fallback}</strong>
              <small>{`${t('jev.metric.fallbackRate')} ${share(fallback, total)} · ${t('jev.metric.fallbackHint')}`}</small>
            </div>
            <div className={css.metric} data-testid="src-jev-metric-latency">
              <span>{t('jev.metric.latency')}</span>
              <strong data-testid="src-jev-latency">{`${avg} ms`}</strong>
              <small>{`${t('jev.metric.latencyMax')} ${num(latency?.max)} ms · ${t('jev.metric.latencyLast')} ${num(latency?.last)} ms · n=${num(latency?.count)}`}</small>
            </div>
            <div className={css.metric} data-testid="src-jev-metric-adopt">
              <span>{t('jev.metric.adopt')}</span>
              <strong data-testid="src-jev-adopt">{`${adopted} / ${offered}`}</strong>
              <small>{`${t('jev.metric.adoptRate')} ${share(adopted, offered)} · ${t('jev.metric.adoptHint')}`}</small>
            </div>
          </div>
          <div className={css.sections}>
            <section className={css.card} data-testid="src-jev-tasks">
              <header className={css.cardHeader}><h3>{t('jev.tasks')}</h3><p>{t('jev.tasksHint')}</p></header>
              <div className={css.tasks}>{duties.map(task => {
                const value = num(stats?.byTask[task])
                return <div className={css.taskRow} key={task} data-testid={`src-jev-task-${task}`}>
                  <span>{taskLabel(task, t)}</span>
                  <strong>{value}</strong>
                  <small>{share(value, total)}</small>
                </div>
              })}</div>
            </section>
            <Bars title={t('jev.dist.action')} hint={t('jev.dist.actionHint')} map={stats?.byAction} total={total} testId="src-jev-by-action" />
            <Bars title={t('jev.dist.effect')} hint={t('jev.dist.effectHint')} map={stats?.byEffect} total={total} testId="src-jev-by-effect" />
            <Bars title={t('jev.dist.source')} hint={t('jev.dist.sourceHint')} map={stats?.bySource} total={total} testId="src-jev-by-source" />
            <Bars title={t('jev.dist.model')} hint={t('jev.dist.modelHint')} map={stats?.byModel} total={total} testId="src-jev-by-model" />
            <Bars title={t('jev.dist.mode')} hint={t('jev.dist.modeHint')} map={stats?.byMode} total={total} testId="src-jev-by-mode" />
            <section className={css.card} data-testid="src-jev-errors">
              <header className={css.cardHeader}><h3>{t('jev.errors')}</h3><p>{t('jev.errorsHint')}</p></header>
              {errors.length === 0
                ? <p className={css.none}>{t('jev.errorsNone')}</p>
                : <ul className={css.bars}>{errors.map(([key, value]) => <li key={key}>
                  <span className={css.barLabel} title={key}>{key}</span>
                  <span className={css.barTrack} aria-hidden="true"><span className={css.barFill} style={{ width: `${Math.max(6, Math.round((value / errorPeak) * 100))}%` }} /></span>
                  <span className={css.barValue}>{value}</span>
                </li>)}</ul>}
            </section>
            <section className={css.card} data-testid="src-jev-advice">
              <header className={css.cardHeader}><h3>{t('jev.advice')}</h3><p>{t('jev.adviceHint')}</p></header>
              <div className={css.tasks}>
                <div className={css.taskRow}><span>{t('jev.advice.offered')}</span><strong>{offered}</strong><small /></div>
                <div className={css.taskRow}><span>{t('jev.advice.adopted')}</span><strong>{adopted}</strong><small>{share(adopted, offered)}</small></div>
                {sorted(stats?.offeredByTask).map(([task, value]) => <div className={css.taskRow} key={task}>
                  <span>{`${t('jev.advice.byTask')} · ${taskLabel(task, t)}`}</span><strong>{value}</strong><small>{share(value, offered)}</small>
                </div>)}
              </div>
            </section>
          </div>
        </>}
      <section className={css.recent} data-testid="src-jev-recent">
        <header className={css.recentHeader}>
          <div><h3>{t('jev.recent')}</h3><p>{`${t('jev.recentHint')} ${recent.length}/${MAX_ROWS}`}</p></div>
        </header>
        {recent.length === 0
          ? <p className={css.none}>{t('jev.recentEmpty')}</p>
          : <div className={css.scroll}><table>
            <thead><tr>
              <th scope="col">{t('jev.col.time')}</th>
              <th scope="col">{t('jev.col.task')}</th>
              <th scope="col">{t('jev.col.verdict')}</th>
              <th scope="col">{t('jev.col.state')}</th>
              <th scope="col">{t('jev.col.latency')}</th>
              <th scope="col">{t('jev.col.model')}</th>
              <th scope="col">{t('jev.col.subject')}</th>
            </tr></thead>
            <tbody>{recent.map(entry => <RecentRow key={`${entry.kind}-${entry.seq}`} entry={entry} t={t} />)}</tbody>
          </table></div>}
      </section>
    </div>
  </section>
}
