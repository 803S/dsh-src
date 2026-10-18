#!/usr/bin/env node
/**
 * [local.141] 谁独占了这个会话？
 *
 * 0.2 给每个会话一个独占写句柄（`<session>/session.lock`，flock 语义）。一个会话在被
 * 另一个 dsh 实例（桌面 App、另一台 Web、另一个窗口）打开期间，本实例仍能折叠日志用于
 * 阅读，但所有管理命令都会被 `session/writer-held` 拒绝——SRC 面板会显示「读取失败」。
 *
 * 这个脚本回答"那我该去哪一边关掉它"：列出每个 `session.lock` 的持有进程，并把它归成
 * 桌面 App / Web 实例 / 其他进程。只读、不改任何文件、不发任何网络请求。
 *
 * 用法：
 *   node scripts/session-locks.mjs            # 人类可读
 *   node scripts/session-locks.mjs --json     # 机器可读（供上层脚本/报告引用）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 桌面 App 的可执行体特征（0.2 宿主，同样会持锁）。 */
const APP_MARKER = 'DeepSeek Harness.app'

/** 从 `ps -o command=` 的一行里认出这是哪一类宿主。纯函数，便于测试。 */
export function describeHolder(command) {
  const text = String(command ?? '')
  const port = /--port[= ](\d+)/.exec(text)?.[1]
  if (text.includes(APP_MARKER)) return { kind: 'desktop-app', label: '桌面 App（DeepSeek Harness）' }
  if (/dsh[/\\].*lib[/\\]bin\.js\s+web|\bweb\b.*--port/.test(text) || port !== undefined) {
    return { kind: 'web', label: `Web 实例${port === undefined ? '' : `（:${port}）`}` }
  }
  if (text.includes('@deepseek-ai/dsh')) return { kind: 'dsh', label: '其他 dsh 进程' }
  return { kind: 'other', label: '其他进程' }
}

/** 解析 `lsof -F pcn` 输出 → Map<绝对路径, Set<pid>>。纯函数，便于测试。 */
export function parseLsofHolders(text) {
  const holders = new Map()
  let pid
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const tag = line[0]
    if (tag === 'p') pid = Number(line.slice(1))
    else if (tag === 'n' && Number.isFinite(pid)) {
      const file = line.slice(1)
      if (!holders.has(file)) holders.set(file, new Set())
      holders.get(file).add(pid)
    }
  }
  return holders
}

/** 枚举所有会话锁文件。 */
function lockFiles(home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const files = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const lock = join(projectDir, session.name, 'session.lock')
      if (existsSync(lock)) files.push(lock)
    }
  }
  return files.sort()
}

/** 会话目录名 → 会话 id（`session-<uuid>`）。 */
function sessionIdOf(lockPath) {
  const parts = lockPath.split(/[/\\]/)
  return parts[parts.length - 2]
}

/** 会话锁文件的最后写入时间（ms）；拿不到就是 null。 */
function lockTime(file) {
  try { return statSync(file).mtimeMs } catch { return null }
}

export function collectSessionLocks({ home = process.env.DSH_HOME || join(homedir(), '.dsh'), files = null, lsofText = null } = {}) {
  const locks = files ?? lockFiles(home)
  let holders
  let probeError = null
  if (lsofText !== null) holders = parseLsofHolders(lsofText)
  else {
    try {
      holders = parseLsofHolders(execFileSync('lsof', ['-F', 'pcn', '--', ...locks], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
    } catch (error) {
      // lsof 在没有任何持有时以退出码 1 结束，这一支只抛标准输出；缺 lsof 才算探测失败。
      const out = String(error?.stdout ?? '')
      if (out.trim() !== '') holders = parseLsofHolders(out)
      else { holders = new Map(); probeError = String(error?.code ?? error?.message ?? error) }
    }
  }
  const rows = []
  for (const lock of locks) {
    const pids = [...(holders.get(lock) ?? [])].filter(pid => pid !== process.pid)
    rows.push({
      session: sessionIdOf(lock),
      lock,
      project: lock.split(/[/\\]sessions[/\\]/)[1]?.split(/[/\\]/)[0] ?? null,
      lockedAtMs: lockTime(lock),
      holders: pids.map(pid => ({ pid, ...holderCommand(pid) })),
    })
  }
  return { home, probeError, rows }
}

function holderCommand(pid) {
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return { command, ...describeHolder(command) }
  } catch {
    return { command: null, kind: 'unknown', label: '已退出的进程（陈旧锁）' }
  }
}

/**
 * 对外报告形态：会话、锁时间、持有者身份。故意不包含整条命令行——启动参数里可能带 token。
 * 给上层脚本/报告引用，也是 `--json` 的输出。
 */
export function publicReport(result) {
  return {
    home: result.home,
    probeError: result.probeError,
    rows: result.rows.map(row => ({
      session: row.session,
      project: row.project,
      lockedAtMs: row.lockedAtMs,
      holders: row.holders.map(holder => ({ pid: holder.pid, kind: holder.kind, label: holder.label })),
    })),
  }
}

function render(result) {
  const held = result.rows.filter(row => row.holders.length > 0)
  const lines = [`DSH_HOME = ${result.home}`, `会话锁文件 ${result.rows.length} 个，其中被活动进程持有 ${held.length} 个。`]
  if (result.probeError) lines.push(`⚠ 无法探测持有者（${result.probeError}）——没有 lsof 就只能看到锁文件存在与否。`)
  if (held.length === 0) lines.push('没有被独占的会话：任何客户端打开任何会话都不会撞 writer-held。')
  for (const row of held) {
    lines.push('')
    lines.push(`${row.session}`)
    for (const holder of row.holders) lines.push(`  ← pid ${holder.pid} ${holder.label}`)
    if (row.holders.length > 1) lines.push('  ⚠ 有多个持有者：正常只有一个宿主写句柄，多出来的是没正常释放的那一边。')
  }
  const idle = result.rows.filter(row => row.holders.length === 0)
  if (idle.length > 0) lines.push('', `另有 ${idle.length} 个会话有锁文件但无活动持有者（宿主空闲时会保留锁文件，这不影响使用）。`)
  lines.push('', '要看别的客户端的会话而不用它：只读折叠是允许的；一旦要下管理命令（SRC 面板、审批按钮），', '就必须先在那一边关闭该会话或退出那个实例。')
  return lines.join('\n')
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const result = collectSessionLocks()
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(publicReport(result), null, 2)}\n`)
  else process.stdout.write(`${render(result)}\n`)
}
