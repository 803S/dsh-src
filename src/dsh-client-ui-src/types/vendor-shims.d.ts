/**
 * Ambient type shims for the host-provided @deepseek-ai client packages.
 * These modules exist at runtime (injected by the dsh ModuleLoader); only
 * their type surface is declared here, narrowed to what this plugin uses.
 */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface ClientEffectContext {
    effect(fn: () => (() => void) | void, name: string): void
  }
  export interface SessionListRow {
    readonly agentPreset?: string
    readonly parentId?: string
  }
  export interface SessionListState {
    readonly current: string | undefined
    readonly byId: Readonly<Record<string, SessionListRow | undefined>>
  }
  export interface RemoteCommandsApi {
    execute(sessionId: string, line: string, args: readonly string[]):
      Promise<{ ok: true; value?: { result: { kind: string; text: string } } } | { ok: false; error?: { code?: string; message?: string } }>
  }
  export interface ClientContext extends ClientEffectContext {
    readonly sessions: {
      readonly list: {
        getSnapshot(): SessionListState
        subscribe(fn: () => void): () => void
      }
    }
    readonly remote: {
      readonly commands: RemoteCommandsApi
    }
    readonly locale: LocaleContextApi
    readonly slots: SlotsContextApi
  }
  export interface LocaleBoundTranslate {
    (key: string, vars?: Record<string, unknown>): string
  }
  export interface LocaleContextApi {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): void
    bind(namespace: string): LocaleBoundTranslate
  }
  export interface SlotRegistration {
    name: string
    id: string
    order?: number
    locale?: string
    label?: () => string
    inject?: (sessionId: string) => Record<string, unknown>
  }
  export interface SlotsContextApi {
    register<T>(registration: SlotRegistration, component: T): () => void
    inject<T>(name: string, factory: () => ({} | undefined)): void
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  // Type-only merge target: the conversation.view slot declaration.
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  // Type-only merge target: the ctx.locale context merge.
}
