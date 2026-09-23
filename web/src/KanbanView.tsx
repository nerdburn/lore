import { CollisionPriority } from '@dnd-kit/abstract'
import { DragDropProvider, useDroppable } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { Avatar } from '@heroui/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BOARD_COLUMNS, STATUS_LABEL, type Item, type Status } from './api'
import { ExternalBadge, initials, Labels, PriorityChip } from './bits'

type Columns = Record<Status, string[]>

interface Props {
  items: Item[]
  canEdit: boolean
  onOpen: (key: string) => void
  /** `order` = the target column's keys after the drop; the neighbour anchors the rank. */
  onMove: (key: string, status: Status, order: string[], neighbour: { above?: string; below?: string }) => void
}

function columnsOf(items: Item[]): Columns {
  const cols = Object.fromEntries(BOARD_COLUMNS.map((s) => [s, [] as string[]])) as unknown as Columns
  for (const i of items) if (i.status in cols) cols[i.status].push(i.key)
  return cols
}

export function KanbanView({ items, canEdit, onOpen, onMove }: Props) {
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items])
  const [columns, setColumns] = useState<Columns>(() => columnsOf(items))
  const snapshot = useRef(columns)
  const dragging = useRef(false)

  // Follow the server between drags; never mid-drag.
  useEffect(() => {
    if (!dragging.current) setColumns(columnsOf(items))
  }, [items])

  return (
    <DragDropProvider
      onDragStart={() => {
        dragging.current = true
        snapshot.current = columns
      }}
      onDragEnd={(event) => {
        dragging.current = false
        // Mid-drag, dnd-kit reorders the DOM itself (optimistic sorting); React
        // state changes only here, once, so the two never fight over a card.
        if (event.canceled) return
        const { source, target } = event.operation
        const key = String(source?.id ?? '')
        const before = snapshot.current
        const from = BOARD_COLUMNS.find((s) => before[s].includes(key))
        if (!from) return
        let to: Status = from
        let index = before[from].indexOf(key)
        if (isSortable(source)) {
          to = String(source.group) as Status
          index = source.index
        }
        // Dropped on a column's empty space rather than on a card: its end.
        if (target && !isSortable(target) && (BOARD_COLUMNS as string[]).includes(String(target.id))) {
          to = String(target.id) as Status
          if (to !== from || !isSortable(source)) index = before[to].filter((k) => k !== key).length
        }
        if (!BOARD_COLUMNS.includes(to)) return
        if (to === from && before[from].indexOf(key) === index) return
        const order = before[to].filter((k) => k !== key)
        order.splice(Math.min(index, order.length), 0, key)
        const next = { ...before, [from]: before[from].filter((k) => k !== key), [to]: order }
        setColumns(next)
        const idx = order.indexOf(key)
        const neighbour = order[idx + 1] ? { above: order[idx + 1] } : order[idx - 1] ? { below: order[idx - 1] } : {}
        onMove(key, to, order, neighbour)
      }}
    >
      <div className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-4">
        {BOARD_COLUMNS.map((status) => (
          <Column key={status} status={status} keys={columns[status]} byKey={byKey} canEdit={canEdit} onOpen={onOpen} />
        ))}
      </div>
    </DragDropProvider>
  )
}

function Column({ status, keys, byKey, canEdit, onOpen }: { status: Status; keys: string[]; byKey: Map<string, Item>; canEdit: boolean; onOpen: (key: string) => void }) {
  const { ref, isDropTarget } = useDroppable({ id: status, type: 'column', accept: 'item', collisionPriority: CollisionPriority.Low })
  return (
    <section
      ref={ref}
      aria-label={STATUS_LABEL[status]}
      className={`flex min-h-[60vh] flex-col rounded-2xl border border-separator bg-default/40 p-2 transition-colors ${isDropTarget ? 'bg-default/80' : ''}`}
    >
      <header className="flex items-center justify-between px-2 pt-1 pb-2">
        <h2 className="text-sm font-semibold">{STATUS_LABEL[status]}</h2>
        <span className="text-xs text-muted">{keys.length}</span>
      </header>
      <div className="flex flex-col gap-2">
        {keys.map((key, index) => {
          const item = byKey.get(key)
          return item ? <Card key={key} item={item} index={index} status={status} canEdit={canEdit} onOpen={onOpen} /> : null
        })}
      </div>
    </section>
  )
}

function Card({ item, index, status, canEdit, onOpen }: { item: Item; index: number; status: Status; canEdit: boolean; onOpen: (key: string) => void }) {
  const { ref, isDragging } = useSortable({ id: item.key, index, group: status, type: 'item', accept: 'item', disabled: !canEdit })
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(item.key)
      }}
      className={`group rounded-xl border border-separator bg-surface p-3 text-left shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-focus ${
        canEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      } ${isDragging ? 'opacity-60 shadow-lg' : 'hover:border-border'}`}
    >
      <div className="text-sm leading-snug font-medium">{item.title}</div>
      <div className="mt-2 flex items-center gap-2">
        <span className="mono text-xs text-muted">{item.key}</span>
        <PriorityChip priority={item.priority} />
        <ExternalBadge item={item} />
        <span className="flex-1" />
        {item.assignee && (
          <Avatar size="sm" className="size-6 text-[10px]" aria-label={item.assignee}>
            <Avatar.Fallback>{initials(item.assignee)}</Avatar.Fallback>
          </Avatar>
        )}
      </div>
      {item.labels.length > 0 && (
        <div className="mt-2">
          <Labels labels={item.labels} />
        </div>
      )}
    </div>
  )
}
