import { useEffect, useState } from 'react'
type Run = ((cmd: string) => Promise<{ kind: string; text: string }>) | undefined
type Settings = { apiKey: string; riskMode:'on'|'shadow'|'off'; skillMode:'on'|'shadow'|'off'; delegateMode:'on'|'shadow'|'off'; browserMode:'on'|'shadow'|'off'; enabled: boolean; endpoint: string; model: string; timeoutMs: number; hasKey: boolean; lastResult?: { ok: boolean; model?: string; errorType?: string; latency: number } | null }
export function DecisionSettings({ runCommand }: { runCommand: Run }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const invoke = async (cmd: string) => {
    if (!runCommand) throw new Error('当前会话不支持设置命令')
    const r = await runCommand(cmd)
    if (r.kind !== 'success') throw new Error(r.text)
    return r.text
  }
  const load = async () => {
    setBusy(true)
    try { setSettings(JSON.parse(await invoke('/src-decision-status'))); setMessage('') }
    catch (e: any) { setMessage(e.message) } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [runCommand])

  const save = async () => {
    if (!settings) return
    setBusy(true)
    try {
      const next = { enabled: settings.enabled, endpoint: settings.endpoint, model: settings.model, timeoutMs: settings.timeoutMs, riskMode:settings.riskMode,skillMode:settings.skillMode,delegateMode:settings.delegateMode,browserMode:settings.browserMode, ...(key || settings.apiKey ? { apiKey: key || settings.apiKey } : {}), ...(clearKey ? { clearKey: true } : {}) }
      // Never persist the key in browser storage or log command input in the host.
      setSettings(JSON.parse(await invoke('/src-decision-save ' + JSON.stringify(next))))
      setKey(''); setClearKey(false); setMessage('已全局保存，下次调用立即生效；无需重启。key按当前局域网配置直接显示。')
    } catch (e: any) { setKey(''); setMessage(e.message) } finally { setBusy(false) }
  }
  const test = async () => {
    setBusy(true)
    try { setMessage(await invoke('/src-decision-test')); setSettings(JSON.parse(await invoke('/src-decision-status'))) }
    catch (e: any) { setMessage(e.message) } finally { setBusy(false) }
  }
  const inputStyle = { width: '100%', padding: '6px 8px', background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, boxSizing: 'border-box' as const }
  return <section data-testid="decision-settings" style={{ padding: 12, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, marginBottom: 12 }}>
    <strong>全局决策服务 · Jev / SystemOne</strong>
    <p style={{ fontSize: 12 }}>所有会话及 Web/headless 共用，不随目标复制。Jev承担低风险HTTP自动审批、高风险/不确定转人工、主/子分工建议、Skill直接推荐和已有Browser候选选择。普通浏览器规划仍由主模型负责。</p>
    {settings && <fieldset disabled={busy} style={{ border: 0, padding: 0, display: 'grid', gap: 9 }}>
      <label><input type="checkbox" checked={settings.enabled} onChange={e => setSettings({ ...settings, enabled: e.target.checked })} /> 启用决策提示</label>
      {([['riskMode','HTTP风险审批'],['delegateMode','主/子代理分工'],['skillMode','Skill直接推荐'],['browserMode','Browser候选选择']] as const).map(([field,label]) => <label key={field}>{label} <select aria-label={label} value={settings[field]} onChange={e=>setSettings({...settings,[field]:e.target.value as 'on'|'shadow'|'off'})}><option value="on">on · 生效</option><option value="shadow">shadow · 仅观测</option><option value="off">off · 关闭</option></select></label>)}
      <label>完整接口 URL<input aria-label="决策接口 URL" style={inputStyle} value={settings.endpoint} placeholder="https://供应商/v1/systemone" onChange={e => setSettings({ ...settings, endpoint: e.target.value })} /></label>
      <label>模型<input aria-label="决策模型" style={inputStyle} value={settings.model} placeholder="jev-latest 或已支持的固定版本" onChange={e => setSettings({ ...settings, model: e.target.value })} /></label>
      <label>API key<input aria-label="决策 API key" type="text" autoComplete="off" style={inputStyle} value={key || settings.apiKey || ''} placeholder="输入或修改 API key" onChange={e => setKey(e.target.value)} /></label>
      <label><input type="checkbox" checked={clearKey} onChange={e => setClearKey(e.target.checked)} /> 清除已保存 key（换供应商须提供新key或清除旧key）</label>
      <label>等待超时（毫秒）<input aria-label="决策超时" type="number" min={1000} max={300000} style={inputStyle} value={settings.timeoutMs} onChange={e => setSettings({ ...settings, timeoutMs: Number(e.target.value) })} /></label>
      <div style={{ display: 'flex', gap: 10 }}><button type="button" onClick={() => void save()}>保存决策设置</button><button type="button" onClick={() => void test()}>测试已保存的连接</button><button type="button" onClick={() => void load()}>刷新</button></div>
    </fieldset>}
    {!settings && <button type="button" disabled={busy} onClick={() => void load()}>读取设置</button>}
    <p style={{ fontSize: 12 }}>远程会收到经凭据过滤的任务语义及文档片段；当前部署按局域网环境回显并保存API key。失败不重试、不自动切换供应商或回退 Laya；风险on时服务失败包括GET也挂人工。风险off/shadow恢复原审批规则。Key以本地受限权限文件保存，不是加密存储。</p>
    {settings?.lastResult && <div style={{ fontSize: 12 }}>最近结果：{settings.lastResult.ok ? `成功 ${settings.lastResult.model ?? ''}` : `未取得建议 ${settings.lastResult.errorType}`} · {settings.lastResult.latency}ms</div>}
    <div role="status" style={{ fontSize: 12 }}>{busy ? '处理中…' : message}</div>
  </section>
}
