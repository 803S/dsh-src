/**
 * Minimal host-slot type surface used by the client views, mirroring
 * @deepseek-ai/dsh-client-ui-slots (type-only; erased at build).
 */

export type PropsLocale = {
  /** Translate a locale key (with optional interpolation vars). */
  readonly t: (key: string, vars?: Record<string, unknown>) => string
}

export type PropsRuntime = {
  /** Execute a slash command in the session, as if typed by the user. */
  readonly runCommand?: (command: string) => Promise<{ kind: string; text: string }>
}
