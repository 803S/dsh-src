import { useEffect, useRef, useState } from 'react'
import css from './DecisionSettings.module.css'
import ui from './Controls.module.css'

type Run = ((cmd: string) => Promise<{ kind: string; text: string }>) | undefined
type Mode = 'on' | 'shadow' | 'off'
type Settings = { apiKey?: string; riskMode: Mode; skillMode: Mode; delegateMode: Mode; browserMode: Mode; enabled: boolean; endpoint: string; model: string; timeoutMs: number; hasKey: boolean; lastResult?: { ok: boolean; model?: string; errorType?: string; latency: number } | null }
const roles = [
  { field: 'riskMode', name: 'HTTP 风险审批', mark: '01', description: '明确低风险请求可自动执行；高风险、不确定或服务异常转人工。' },
  { field: 'delegateMode', name: '主 / 子代理分工', mark: '02', description: '提供分工建议，是否采纳由主模型决定，不代替实际派发。' },
  { field: 'skillMode', name: 'Skill 文档推荐', mark: '03', description: '推荐真实文档或跳过，不自动运行文档中的操作。' },
  { field: 'browserMode', name: 'Browser 候选选择', mark: '04', description: '从已有浏览器候选中选择；复杂规划仍交给主模型。' },
] as const
const modes: Array<[Mode, string]> = [['on', '生效'], ['shadow', '观测'], ['off', '关闭']]

export function DecisionSettings({ runCommand }: { runCommand: Run }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState<Settings | null>(null)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const storedKey = useRef('')
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | null>(null)
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null)
  const pending = useRef(false)
  const generation = useRef(0)
  const command = useRef(runCommand); command.current = runCommand
  const invoke = async (line: string) => {
    if (!command.current) throw new Error('当前会话不支持设置命令')
    const result = await command.current(line)
    if (result.kind !== 'success') throw new Error(result.text)
    return result.text
  }
  // Separate the saved secret from the draft. Revealing it must not resubmit it on save.
  const safeSettings = (text: string): Settings => {
    const { apiKey, ...value } = JSON.parse(text) as Settings
    storedKey.current = typeof apiKey === 'string' ? apiKey : ''
    return value
  }
  const load = async () => {
    if (pending.current) return
    const current = generation.current
    pending.current = true; setBusy('load'); setFeedback(null)
    try {
      const value = safeSettings(await invoke('/src-decision-status'))
      if (generation.current !== current) return
      setSettings(value); setSaved(value); setKey(''); setClearKey(false); setShowKey(false)    } catch (error) { if (generation.current === current) setFeedback({ tone: 'error', text: String((error as Error).message) }) }
    finally { if (generation.current === current) { pending.current = false; setBusy(null) } }
  }
  useEffect(() => {
    void load()
    return () => { generation.current++; pending.current = false; storedKey.current = '' }
  }, [])
  useEffect(() => {
    if (!showKey) return
    const hide = () => setShowKey(false)
    const timer = window.setTimeout(hide, 30000)
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', hide)
    return () => { clearTimeout(timer); window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', hide) }
  }, [showKey])
  const dirty = !!settings && (JSON.stringify(settings) !== JSON.stringify(saved) || !!key || clearKey)
  const save = async () => {
    if (!settings || pending.current) return
    pending.current = true; setBusy('save'); setFeedback(null)
    try {
      const next = { enabled: settings.enabled, endpoint: settings.endpoint.trim(), model: settings.model.trim(), timeoutMs: settings.timeoutMs, riskMode: settings.riskMode, delegateMode: settings.delegateMode, skillMode: settings.skillMode, browserMode: settings.browserMode,
        ...(clearKey ? { clearKey: true } : key ? { apiKey: key } : {}) }
      const value = safeSettings(await invoke('/src-decision-save ' + JSON.stringify(next)))
      setSettings(value); setSaved(value); setKey(''); setClearKey(false); setShowKey(false)
      setFeedback({ tone: 'success', text: '已全局保存。下一次调用立即生效，无需重启。' })
    } catch (error) { setFeedback({ tone: 'error', text: String((error as Error).message) }) }
    finally { pending.current = false; setBusy(null) }
  }
  const test = async () => {
    if (pending.current) return
    pending.current = true; setBusy('test'); setFeedback(null)
    try { setFeedback({ tone: 'success', text: await invoke('/src-decision-test') }) }
    catch (error) { setFeedback({ tone: 'error', text: String((error as Error).message) }) }
    finally { pending.current = false; setBusy(null) }
  }
  return <section className={`${ui.scope} ${css.root}`} data-testid="decision-settings" aria-busy={busy !== null}>
    <header className={css.header}>
      <div className={css.logo} aria-hidden="true">J</div>
      <div className={css.heading}><span className={css.eyebrow}>DECISION SERVICE</span><h2>Jev <span>/ SystemOne</span></h2><p>全局决策服务 · Web / headless 及所有会话共用</p></div>
      <span className={css.state} data-active={saved?.enabled === true}>{saved ? saved.enabled ? '已保存：启用' : '已保存：停用' : '读取配置中'}</span>
    </header>
    {settings ? <form onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset className={css.fields} disabled={busy !== null}>
        <div className={css.enableRow}><div><strong>启用决策服务</strong><p>只负责低层建议与分类，授权边界仍由代码和用户把关。</p></div><button className={css.switch} type="button" role="switch" aria-label="启用决策服务" aria-checked={settings.enabled} onClick={() => setSettings({ ...settings, enabled: !settings.enabled })}><span /></button></div>
        <div className={css.layout}>
          <section className={css.connection}><div className={css.sectionTitle}><span>连接配置</span><small>SystemOne 协议</small></div>
            <label className={css.field}>完整接口 URL<input className={ui.input} aria-label="决策接口 URL" type="url" required={settings.enabled} value={settings.endpoint} placeholder="https://provider.example/v1/systemone" onChange={event => setSettings({ ...settings, endpoint: event.target.value })} /><small>使用 HTTPS；本机服务允许 HTTP。更换供应商时须输入新 key 或明确清除旧 key。</small></label>
            <div className={css.twoFields}><label className={css.field}>模型<input className={ui.input} aria-label="决策模型" required value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })} /></label><label className={css.field}>等待超时 · 毫秒<input className={ui.input} aria-label="决策超时" type="number" required min={1000} max={300000} step={1} value={settings.timeoutMs} onChange={event => setSettings({ ...settings, timeoutMs: Number(event.target.value) })} /></label></div>
            <label className={css.field} htmlFor="decision-key">API key <small>{saved?.hasKey ? '已有密钥 · 留空保留' : '尚未配置密钥'}</small></label>
            <div className={css.secret}><input id="decision-key" className={ui.input} aria-label="决策 API key" type={showKey ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} disabled={clearKey} value={key} placeholder={clearKey ? '保存时清除已存密钥' : '输入新密钥；留空不修改'} onChange={event => setKey(event.target.value)} /><button type="button" className={ui.button} aria-label={showKey ? '隐藏密钥' : '显示密钥'} aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>{showKey ? '隐藏' : '显示'}</button></div>
            {showKey && <div className={css.notice} data-testid="decision-saved-key"><label className={css.field}>当前已保存的 API key<input className={ui.input} type="text" readOnly value={storedKey.current} autoComplete="off" aria-label="已保存的 API key" placeholder="尚未保存密钥" /></label><small>只读查看，不会作为新密钥提交。30 秒后、窗口失焦或离开本页时自动隐藏；上方输入框用于替换。</small></div>}
            <label className={css.clearKey}><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />保存时清除已保存的 key</label>
            <div className={css.notice}><strong>测试不发送目标业务请求</strong><p>使用合成任务测试已保存的配置，不覆盖你尚未保存的草稿。连接成功不等于判断准确。</p></div>
          </section>
          <section className={css.roles}><div className={css.sectionTitle}><span>职责分配</span><small>生效 / 仅观测 / 不调用</small></div>
            {roles.map(role => <div key={role.field} className={css.roleCard} data-mode={settings[role.field]}><div className={css.roleHeading}><span className={css.roleNumber}>{role.mark}</span><strong>{role.name}</strong></div><p>{role.description}</p><div className={css.segmented} role="group" aria-label={role.name}>{modes.map(([mode, label]) => <button type="button" key={mode} aria-pressed={settings[role.field] === mode} onClick={() => setSettings({ ...settings, [role.field]: mode })}>{label}</button>)}</div></div>)}
            {!settings.enabled && <p className={css.muted}>总开关关闭时，四项职责均不调用 Jev；上方选择会保留为下次启用的配置。</p>}
          </section>
        </div>
      </fieldset>
      <footer className={css.footer}><span className={css.saveHint}>{dirty ? '有未保存的更改' : '配置已同步'}{busy === 'test' ? ' · 正在测试已保存配置…' : ''}</span><div className={css.actions}><button type="button" className={ui.button} disabled={busy !== null || dirty} title={dirty ? '先保存更改，避免刷新丢失草稿' : '重新读取全局配置'} onClick={() => void load()}>刷新</button><button type="button" className={ui.button} disabled={busy !== null || !saved?.endpoint} onClick={() => void test()}>{busy === 'test' ? '测试中…' : '测试已保存的连接'}</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={busy !== null || !dirty}>{busy === 'save' ? '保存中…' : '保存决策设置'}</button></div></footer>
    </form> : <div className={css.loading}><p>{busy ? '正在读取全局配置…' : '尚未取得配置，请重试。'}</p><button type="button" className={ui.button} disabled={busy !== null} onClick={() => void load()}>重新读取设置</button></div>}
    {feedback && <p className={ui.feedback} data-tone={feedback.tone} role={feedback.tone === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}
    {saved?.lastResult && <p className={css.lastResult}>最近记录：{saved.lastResult.ok ? `连接成功 ${saved.lastResult.model ?? ''}` : `未取得建议 ${saved.lastResult.errorType ?? ''}`} · {saved.lastResult.latency} ms</p>}
    <details className={css.details}><summary>数据与失败处理说明</summary><p>远程服务会收到经凭据过滤的任务语义及文档片段，请使用可信供应商。密钥保存于本机受限权限文件，并非加密存储；此页面默认隐藏已存密钥，点击显示后短时只读展示，不使用浏览器持久化存储。</p><p>失败不自动重试、不切换供应商或回退 Laya；风险职责生效时，服务异常可能让 GET 也转人工。观测或关闭时沿用原审批规则。</p></details>
  </section>
}
