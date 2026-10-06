import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import ui from './Controls.module.css'
import css from './ConfirmDialog.module.css'

/** Native top-layer dialog: focus trap, inert background, Esc and focus restoration. */
export function ConfirmDialog({ title, children, confirmLabel, busy, error, onCancel, onConfirm }: {
  title: string; children: ReactNode; confirmLabel: string; busy: boolean; error?: string;
  onCancel: () => void; onConfirm: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    cancel.current?.focus()
    return () => { element.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  return <dialog ref={dialog} className={`${ui.scope} ${css.dialog}`} aria-labelledby={titleId} aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}>
    <header className={css.header}><span className={css.icon} aria-hidden="true">!</span><div><span className={css.eyebrow}>域数据管理</span><h2 id={titleId}>{title}</h2></div></header>
    <div className={css.body}>{children}{error && <p className={ui.feedback} data-tone="error" role="alert">{error}</p>}</div>
    <footer className={css.footer}><button ref={cancel} type="button" className={ui.button} disabled={busy} onClick={onCancel}>取消</button><button type="button" className={`${ui.button} ${ui.danger}`} disabled={busy} onClick={onConfirm}>{busy ? '正在清理…' : confirmLabel}</button></footer>
  </dialog>
}
