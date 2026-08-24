/**
 * SRC surface plugin, browser half: the SRC conversation-view tab.
 * Projection-mode surface — the live src state arrives through
 * `useProjection('src')` (seeded by the history tail page, updated by
 * session/projection frames), so this plugin owns no store, no refresh chain,
 * and no event listener.
 *
 * The tab is a per-session surface: the view entry registers only while the
 * CURRENT session is composed from the `src-hunter` agent preset. Sessions
 * drive the entry — switching the current session toggles the registration,
 * and the view ring re-reads its entries on every slots version bump.
 *
 * [SRC vs upstream pentest] extra `remote` / `remote.commands` injects: the
 * view's human-facing buttons (todos / infra) run slash commands through
 * ctx.remote.commands.execute. [UI-source rebuild] restored from local.21
 * bundle.
 */
import type { ClientContext, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the conversation.view
// entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SrcView } from './SrcView.tsx'
import { en, NS, zh } from './locales.ts'

/** The current-session id carried by the sessions list snapshot. */
type CurrentSessionId = SessionListState['current']

/** The agent-preset id whose sessions carry the src capability. */
const SRC_PRESET = 'src-hunter'

/**
 * Whether a session is composed from the src preset — the session itself
 * or any listed ancestor (subagents of a src session inherit its preset;
 * their own rows may or may not carry `agentPreset` on the wire).
 */
function isSrcSession(snapshot: SessionListState, id: string): boolean {
  let cursor: string | undefined = id
  const seen = new Set<string>()
  const byId = snapshot.byId as Readonly<Record<string, { agentPreset?: string; parentId?: string } | undefined>>
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    const row: { agentPreset?: string; parentId?: string } | undefined = byId[cursor]
    if (row?.agentPreset === SRC_PRESET) return true
    cursor = row?.parentId
  }
  return false
}

/** Required services for the view registration and its copy. */
export const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.commands']

/**
 * Client plugin body: the SRC view tab over the src projection, mounted
 * per-session (registered while the current session — or a listed ancestor —
 * carries the `src-hunter` agent preset, disposed as soon as it does not).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-src: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  const sessions = ctx.sessions

  ctx.slots.inject('conversation.view', () => {
    let disposeEntry: (() => void) | undefined
    let sessionId: CurrentSessionId
    let sessionSrc: boolean | undefined

    const sync = (): void => {
      const snapshot = sessions.list.getSnapshot()
      const current = snapshot.current
      const src = current === undefined ? undefined : isSrcSession(snapshot, current)
      if (current === sessionId && src === sessionSrc) return
      disposeEntry?.()
      disposeEntry = undefined
      sessionId = current
      sessionSrc = src
      if (current === undefined || src !== true) return
      disposeEntry = ctx.slots.register({
        name: 'conversation.view',
        id: 'src',
        order: 20,
        locale: NS,
        label: () => t('view.src'),
        inject: (sessionId: string) => ({
          runCommand: async (line: string) => {
            const outcome = await ctx.remote.commands.execute(sessionId, line, [])
            if (!outcome.ok) throw new Error(`command execute failed: ${outcome.error?.code ?? '?'}: ${outcome.error?.message ?? 'transport error'}`)
            return outcome.value === undefined ? { kind: 'error', text: `unknown or malformed command: ${line}` } : outcome.value.result
          },
        }),
      }, SrcView)
    }

    sync()
    const offList = sessions.list.subscribe(sync)
    return () => {
      offList()
      disposeEntry?.()
    }
  })
}
