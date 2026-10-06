import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import ui from './Controls.module.css'
import css from './DomainDataView.module.css'

type Run = ((cmd: string) => Promise<{ kind: string; text: string }>) | undefined
type DomainRow = { target: string; lastUpdated?: number; cleanupPending?: boolean; sessions?: number; notes?: number; assets?: number; findings?: number; research?: number; observations?: number; approvals?: number; todos?: number; infra?: number; surveySeeds?: number }
const counters = [['sessions','会话'],['assets','资产'],['findings','漏洞'],['notes','笔记'],['research','研究'],['observations','观察'],['approvals','审批'],['todos','待办'],['infra','基础设施'],['surveySeeds','种子']] as const

export function DomainDataView({ runCommand }: { runCommand: Run }) {
  const [rows, setRows] = useState<DomainRow[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<DomainRow | null>(null)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null)
  const lock = useRef(false)
  const epoch = useRef(0)
  const invoke = async (line: string) => {
    if (!runCommand) throw new Error('当前会话不支持管理命令。')
    const result = await runCommand(line)
    if (result.kind !== 'success') throw new Error(result.text)
    return result.text
  }
  const readRows = async () => {
    const parsed = JSON.parse(await invoke('/src-domains'))
    if (!Array.isArray(parsed.domains)) throw new Error('域数据列表格式无效')
    return parsed.domains as DomainRow[]
  }
  const load = async () => {
    if (lock.current) return
    const current = epoch.current
    lock.current = true; setLoading(true)
    try { const next = await readRows(); if (current === epoch.current) { setRows(next); setFeedback(null) } }
    catch (e) { if (current === epoch.current) setFeedback({ tone: 'error', text: `读取失败：${(e as Error).message}` }) }
    finally { if (current === epoch.current) { lock.current = false; setLoading(false) } }
  }
  useEffect(() => { void load(); return () => { epoch.current++; lock.current = false } }, [runCommand])
  const remove = async () => {
    if (!selected || !runCommand || lock.current) return
    const target = selected.target
    // This button is the explicit human confirmation. Preserve backend exact-target validation.
    if (!target.trim() || /\s/.test(target)) { setError('目标格式无法安全传给管理命令，请检查域记录。'); return }
    lock.current = true; setBusy(true); setError('')
    try {
      await invoke(`/src-delete-domain ${target} confirm ${target}`)
      setSelected(null)
      setFeedback({ tone: 'success', text: `已删除 ${target} 的 SRC 数据。宿主对话和备份仍保留，请新建会话继续。` })
      try { setRows(await readRows()) }
      catch (e) { setFeedback({ tone: 'error', text: `删除命令已成功，但列表刷新失败：${(e as Error).message}。请刷新列表，不要重复删除。` }) }
    } catch (e) {
      setError(String((e as Error).message))
      // A failed cleanup can be partial; leave its row and confirmation available for an explicit retry.
    } finally { lock.current = false; setBusy(false) }
  }
  if (!runCommand) return <p className={ui.feedback}>当前会话不支持管理命令。</p>
  return <section className={`${ui.scope} ${css.root}`} data-testid="src-domain-data">
    <header className={css.header}><div><span className={css.eyebrow}>DOMAIN DATA</span><h2>域数据管理</h2><p>按目标聚合跨会话记录。清理 SRC 数据，不删除宿主对话历史。</p></div><button type="button" className={ui.button} disabled={busy || loading} onClick={() => void load()}>{loading ? '读取中…' : '刷新列表'}</button></header>
    {feedback && <p className={ui.feedback} data-tone={feedback.tone} role={feedback.tone === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}
    {!rows.length && !loading && <p className={css.empty}>{feedback?.tone === 'error' ? '暂时无法显示域数据，请重试读取。' : '暂无 SRC 域数据'}</p>}
    <div className={css.grid}>{rows.map(row => <article className={css.card} key={row.target}>
      <div className={css.cardHeading}><div><h3>{row.target}</h3><span>最近更新 · {row.lastUpdated ? new Date(row.lastUpdated).toLocaleString() : '未知'}</span></div><button type="button" className={ui.button} disabled={busy || loading} onClick={() => { setError(''); setSelected(row) }}>{row.cleanupPending ? '重试清理' : '删除域数据'}</button></div>
      <dl className={css.counts}>{counters.map(([field,label]) => <div key={field}><dt>{label}</dt><dd>{row[field] ?? 0}</dd></div>)}</dl>
      {row.cleanupPending && <p className={css.warning}>上次清理未完成；其他域和共享数据不会被此次重试清除。</p>}
    </article>)}</div>
    {selected && <ConfirmDialog title={selected.cleanupPending ? '继续清理这个目标？' : '删除这个目标的 SRC 数据？'} confirmLabel={selected.cleanupPending ? '确认重试清理' : '确认删除域数据'} busy={busy} error={error} onCancel={() => setSelected(null)} onConfirm={() => void remove()}>
      <div className={css.deleteTarget}><strong>{selected.target}</strong><span>关联 {selected.sessions ?? 0} 个会话 · {selected.assets ?? 0} 项资产 · {selected.findings ?? 0} 条漏洞记录</span></div>
      <p>将清除该目标的结构化记录、域笔记、专属凭证、经验、遥测和可核实归属的标准目录产物。</p>
      <ul><li>保留其他域、共享凭证、宿主对话历史及备份。</li><li>正在运行的任务会阻止删除，不会自动中断。</li><li>旧对话中的内容不会被抹除，删除后请新建会话。</li></ul>
      <p><strong>此操作不可撤销。</strong>确认后立即清理，无需输入域名。</p>
    </ConfirmDialog>}
  </section>
}
