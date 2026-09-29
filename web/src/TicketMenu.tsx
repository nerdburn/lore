import { Fragment, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Item } from './api'

export type TicketAction = 'copy' | 'assign' | 'done' | 'delete'
export type MenuEvent = MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>
export type OpenTicketMenu = (item: Item, event: MenuEvent) => void
export interface TicketMenuPosition { key: string; x: number; y: number; trigger: HTMLElement }

export function menuPosition(item: Item, e: MenuEvent): TicketMenuPosition {
  e.preventDefault()
  e.stopPropagation()
  const trigger = 'key' in e && e.target instanceof HTMLElement ? e.target : e.currentTarget
  const rect = trigger.getBoundingClientRect()
  const pointer = 'clientX' in e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY) && (e.clientX !== 0 || e.clientY !== 0)
  return { key: item.key, x: pointer ? e.clientX : rect.left + 12, y: pointer ? e.clientY : rect.top + 24, trigger }
}

export const isMenuKey = (e: KeyboardEvent) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')

/** A viewport-clamped menu shared by cards and rows, with native menu keyboard behavior. */
export function TicketMenu({ position, item, canEdit, me, busy, onClose, onAction }: {
  position: TicketMenuPosition
  item: Item
  canEdit: boolean
  me: string
  busy: boolean
  onClose: (restoreFocus?: boolean) => void
  onAction: (action: TicketAction, item: Item) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const menu = ref.current!
    const { width, height } = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [position])
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close.current(false) }
    const dismiss = () => close.current(false)
    const scroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) dismiss() }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', dismiss)
    // Dismiss on user scrolling, not delayed scroll events from focusing or
    // revealing a card in a horizontally scrolled column.
    window.addEventListener('wheel', scroll, { capture: true, passive: true })
    window.addEventListener('touchmove', scroll, { capture: true, passive: true })
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('wheel', scroll, true)
      window.removeEventListener('touchmove', scroll, true)
      window.removeEventListener('blur', dismiss)
    }
  }, [])
  const actions: { id: TicketAction; label: string; disabled?: boolean }[] = [
    { id: 'copy', label: 'Copy ticket URL' },
    ...(canEdit ? [
      { id: 'assign' as const, label: 'Assign to me', disabled: busy || item.assignee === me },
      { id: 'done' as const, label: 'Mark as done', disabled: busy || item.status === 'done' || item.status === 'archived' },
      { id: 'delete' as const, label: 'Delete', disabled: busy || item.status === 'archived' },
    ] : []),
  ]
  return createPortal(
    <div ref={ref} role="menu" aria-label={`Actions for ${item.key}`} className="fixed z-50 w-56 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-separator bg-surface p-1 shadow-lg" style={{ left: position.x, top: position.y, maxHeight: 'calc(100vh - 16px)' }}
      onContextMenu={e => e.preventDefault()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault()
          onClose()
          return
        }
        const buttons = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        let next = -1
        if (e.key === 'ArrowDown') next = (current + 1) % buttons.length
        if (e.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length
        if (e.key === 'Home') next = 0
        if (e.key === 'End') next = buttons.length - 1
        if (next >= 0) { e.preventDefault(); buttons[next]?.focus() }
      }}>
      {actions.map(action => <Fragment key={action.id}>
        {action.id === 'delete' && <div role="separator" className="my-1 h-px bg-separator" />}
        <button type="button" role="menuitem" tabIndex={-1} disabled={action.disabled}
        className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-default focus:bg-default disabled:cursor-default disabled:opacity-40 ${action.id === 'delete' ? 'text-danger' : 'text-foreground'}`}
        onPointerMove={e => { if (!action.disabled) e.currentTarget.focus({ preventScroll: true }) }}
        onClick={() => { onClose(); onAction(action.id, item) }}>
        {action.label}
      </button></Fragment>)}
    </div>, document.body,
  )
}
