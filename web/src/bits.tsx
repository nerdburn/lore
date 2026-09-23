import { Chip } from '@heroui/react'
import { STATUS_LABEL, type Item, type Priority, type Status } from './api'

const STATUS_COLOR: Record<Status, 'default' | 'accent' | 'success' | 'warning' | 'danger'> = {
  todo: 'default',
  in_progress: 'accent',
  blocked: 'danger',
  done: 'success',
  archived: 'default',
}

export function StatusChip({ status }: { status: Status }) {
  return (
    <Chip size="sm" variant="soft" color={STATUS_COLOR[status]}>
      {STATUS_LABEL[status]}
    </Chip>
  )
}

const PRIORITY_COLOR: Record<Priority, 'danger' | 'warning' | 'default'> = { P1: 'danger', P2: 'warning', P3: 'default' }

export function PriorityChip({ priority }: { priority?: Priority }) {
  if (!priority) return null
  return (
    <Chip size="sm" variant="soft" color={PRIORITY_COLOR[priority]}>
      {priority}
    </Chip>
  )
}

export function Labels({ labels, max = 3 }: { labels: string[]; max?: number }) {
  if (labels.length === 0) return null
  return (
    <span className="inline-flex flex-wrap gap-1">
      {labels.slice(0, max).map((l) => (
        <span key={l} className="rounded-full bg-default px-2 py-0.5 text-xs text-muted">
          {l}
        </span>
      ))}
      {labels.length > max && <span className="px-1 text-xs text-muted">+{labels.length - max}</span>}
    </span>
  )
}

export function ExternalBadge({ item }: { item: Item }) {
  if (!item.external) return null
  return (
    <span className={`mono text-xs ${item.drift ? 'text-warning' : 'text-muted'}`} title={item.drift ? `lore and ${item.external.system} disagree on done-ness` : undefined}>
      {item.external.key}
      {item.drift ? ' ≠' : ''}
    </span>
  )
}

export function initials(who: string): string {
  const name = who.split('@')[0]
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase()
}

export function ago(iso?: string): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return iso
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 60) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}
