import { useEffect, useRef, useState } from 'react'
import type { SrcProjection } from '../../types/projection'
import { DecisionSettings } from './DecisionSettings.tsx'
import css from './InfrastructureView.module.css'
import ui from './Controls.module.css'

type Run = ((cmd: string) => Promise<{ kind: string; text: string }>) | undefined
type InfraStatus = { infra: Record<string, string>; overrideKeys: string[]; initialized: boolean; source: { sessionId: string; updatedAt: number; keys: string[] } | null }
const groups = [
  { id: 'network', title: '网络出站', icon: '↗', subtitle: '代理与请求等待时间', test: '/src-proxy-test', testLabel: '测试代理连通', note: '代理只作用于 SRC 支持的出站请求，不等同于系统代理。测试使用已保存配置。', fields: [
    { key: 'proxyUrl', label: 'HTTP 代理', hint: '留空代表直连，不会自动使用示例地址。', placeholder: '未配置 · 直连' },
    { key: 'httpTimeoutMs', label: 'HTTP 超时 · 毫秒', hint: '1000–60000 毫秒；恢复默认使用 8000。', type: 'number', min: 1000, max: 60000 },
  ] },
  { id: 'burp', title: 'Burp MCP', icon: 'B', subtitle: '抓包工具与端口配置', test: '/src-burp-test', testLabel: '测试 Burp 连接', note: 'Burp 地址为 dsh 所在机器的回环地址。自定义端口/桥路径不自动改写 MCP 接线；端点探测成功后会通知 agent 验证完整链路。', fields: [
    { key: 'burpMcpPort', label: 'Burp 监听端口', hint: '扩展默认端口 9876。', type: 'number', min: 1, max: 65535 },
    { key: 'burpProxyJarPath', label: '自定义桥路径', hint: '留空沿用 profile 默认桥；此项仅保存参考，不会自行修改接线。', placeholder: '使用 profile 默认桥' },
  ] },
  { id: 'credentials', title: '测试凭据', icon: '◎', subtitle: '当前会话的授权测试资料', note: '账号保存到本机凭证库，这里只显示 credential:// 引用。复制基础设施会复制这些引用，不改变目标授权范围。', fields: [
    { key: 'testAccount', label: '对照账号', hint: '有已存凭据时只读展示引用；需要替换时输入新账号资料。', placeholder: '未配置对照账号' },
    { key: 'testPhone', label: '测试手机号', hint: '多个号码以逗号分隔，仅用于授权测试。', placeholder: '未配置测试号码' },
  ] },
] as const

export function InfrastructureView({ src, runCommand }: { src: SrcProjection; runCommand: Run }) {
  const [status, setStatus] = useState<InfraStatus | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null)
  const [probe, setProbe] = useState<Record<string, string>>({})
  const command = useRef(runCommand); command.current = runCommand
  const lock = useRef(false), mounted = useRef(true)
  const dirty = Object.keys(draft).length > 0
  const signature = JSON.stringify(src.infra ?? {})
  const invoke = async (line: string) => {
    if (!command.current) throw new Error('当前会话不支持配置命令')
    const result = await command.current(line)
    if (result.kind !== 'success') throw new Error(result.text)
    return result.text
  }
  const readStatus = async () => {
    const next = JSON.parse(await invoke('/src-infra-status')) as InfraStatus
    if (!next.infra || !Array.isArray(next.overrideKeys)) throw new Error('基础设施状态格式不完整，请检查部署版本')
    if (mounted.current) setStatus(next)
    return next
  }
  const refresh = async () => {
    if (lock.current) return
    lock.current = true; setBusy('load')
    try { await readStatus(); if (mounted.current) setFeedback(null) }
    catch (error) { if (mounted.current) setFeedback({ tone: 'error', text: `读取失败：${(error as Error).message}。未用示例值覆盖配置。` }) }
    finally { lock.current = false; if (mounted.current) setBusy(null) }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false } }, [signature])
  const save = async (key: string, reset = false) => {
    if (!status || lock.current || (!reset && !(key in draft))) return
    const value = reset ? '' : draft[key]!.trim()
    lock.current = true; setBusy(key); setFeedback(null)
    try {
      const message = await invoke(`/src-infra ${key} ${value || '-'}`)
      try {
        await readStatus()
        if (mounted.current) { setDraft(previous => { const next = { ...previous }; delete next[key]; return next }); setFeedback({ tone: 'success', text: message }); setProbe({}) }
      } catch (error) { if (mounted.current) setFeedback({ tone: 'error', text: `保存命令已成功，但回读失败：${(error as Error).message}。请刷新核对，不要重复保存。` }) }
    } catch (error) { if (mounted.current) setFeedback({ tone: 'error', text: `保存失败：${(error as Error).message}` }) }
    finally { lock.current = false; if (mounted.current) setBusy(null) }
  }
  const copy = async () => {
    if (lock.current || dirty) return
    lock.current = true; setBusy('copy'); setFeedback(null)
    try {
      const message = await invoke('/src-infra-copy')
      try { await readStatus(); if (mounted.current) { setDraft({}); setProbe({}); setFeedback({ tone: 'success', text: message }) } }
      catch (error) { if (mounted.current) setFeedback({ tone: 'error', text: `${message}；但回读失败：${(error as Error).message}。请刷新核对。` }) }
    } catch (error) { if (mounted.current) setFeedback({ tone: 'error', text: `沿用失败：${(error as Error).message}` }) }
    finally { lock.current = false; if (mounted.current) setBusy(null) }
  }
  const test = async (id: string, line: string) => {
    if (lock.current) return
    lock.current = true; setBusy(id)
    try { const text = await invoke(line); if (mounted.current) setProbe(previous => ({ ...previous, [id]: text })) }
    catch (error) { if (mounted.current) setProbe(previous => ({ ...previous, [id]: `测试失败：${(error as Error).message}` })) }
    finally { lock.current = false; if (mounted.current) setBusy(null) }
  }
  const edit = (key: string, value: string) => setDraft(previous => { const next = { ...previous }; if (value === status?.infra[key]) delete next[key]; else next[key] = value; return next })
  return <div className={css.root}>
    <DecisionSettings runCommand={runCommand} />
    <section className={`${ui.scope} ${css.services}`} data-testid="src-infrastructure" aria-busy={!!busy}>
      <header className={css.header}><div className={css.logo} aria-hidden="true">⌘</div><div><span className={css.eyebrow}>SESSION INFRASTRUCTURE</span><h2>基础服务</h2><p>当前会话配置 · 与上方 Jev 全局设置独立</p></div><span className={css.status}>{status ? `${status.overrideKeys.length} 项已保存` : '正在读取'}</span></header>
      <div className={css.inherit}><div><strong>{status?.overrideKeys.length ? '正在显示当前会话的生效配置' : '当前会话尚未保存覆盖配置'}</strong><p>{status?.initialized ? '已有目标；沿用按钮会覆盖来源中同名的配置项。' : '自动沿用在建立目标时触发；建目标前也可点击沿用或直接保存。'}{status?.source ? ` 最近可复用来源：${status.source.sessionId}（${status.source.keys.length} 项）` : ' 暂无可复用来源。'}</p>{dirty && <p>有未保存草稿，请先保存或放弃草稿再沿用。</p>}</div><div className={css.actions}><button type="button" className={ui.button} disabled={!!busy} onClick={() => void refresh()}>刷新配置</button><button type="button" className={`${ui.button} ${ui.primary}`} disabled={!!busy || dirty || !status?.source} onClick={() => void copy()}>{busy === 'copy' ? '沿用中…' : '沿用上次配置'}</button>{dirty && <button type="button" className={ui.button} disabled={!!busy} onClick={() => setDraft({})}>放弃草稿</button>}</div></div>
      {feedback && <p className={ui.feedback} data-tone={feedback.tone} role={feedback.tone === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}
      <div className={css.grid}>{groups.map(group => <section className={css.card} key={group.id}>
        <header className={css.cardHeader}><span className={css.icon} aria-hidden="true">{group.icon}</span><div><h3>{group.title}</h3><p>{group.subtitle}</p></div></header>
        <div className={css.fields}>{group.fields.map(field => <form key={field.key} onSubmit={event => { event.preventDefault(); void save(field.key) }}>
          <div className={css.fieldHeading}><label htmlFor={`infra-${field.key}`}>{field.label}</label><span>{field.key in draft ? '未保存' : status?.overrideKeys.includes(field.key) ? '已保存' : '默认值'}</span></div>
          <input id={`infra-${field.key}`} className={ui.input} aria-label={field.label} type={'type' in field ? field.type : field.key === 'testAccount' && field.key in draft ? 'password' : 'text'} min={'min' in field ? field.min : undefined} max={'max' in field ? field.max : undefined} step={1} autoComplete="off" value={draft[field.key] ?? status?.infra[field.key] ?? ''} placeholder={'placeholder' in field ? field.placeholder : '读取实际配置…'} disabled={!status || !!busy} onChange={event => edit(field.key, event.target.value)} />
          <p className={css.hint}>{field.hint}</p><div className={css.fieldActions}><button type="button" className={ui.button} disabled={!status || !!busy || !status.overrideKeys.includes(field.key)} onClick={() => void save(field.key, true)}>恢复默认</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={!status || !!busy || !(field.key in draft)}>{busy === field.key ? '保存中…' : '保存'}</button></div>
        </form>)}</div>
        <footer className={css.cardFooter}><p>{group.note}</p>{'test' in group && <button type="button" className={ui.button} disabled={!status || !!busy} onClick={() => void test(group.id, group.test)}>{busy === group.id ? '测试中…' : group.testLabel}</button>}{probe[group.id] && <p className={ui.feedback} role="status">{probe[group.id]}</p>}</footer>
      </section>)}</div>
    </section>
  </div>
}
