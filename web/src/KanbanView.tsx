import { CollisionPriority } from '@dnd-kit/abstract'
import { pointerIntersection } from '@dnd-kit/collision'
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from '@dnd-kit/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BOARD_COLUMNS, STATUS_LABEL, type Item, type Status } from './api'
import { ExternalBadge, Labels, PriorityChip } from './bits'
import { PersonAvatar } from './people'

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

/**
 * Drag and drop without moving any DOM node mid-drag: the card that follows
 * the pointer is an overlay, the hovered card shows a drop line, and state
 * changes once, on drop. (Letting the library re-parent cards across
 * columns while the pointer moved made the dragged shape drift a column to
 * the right, so a drop on Blocked landed in Done.)
 */
export function KanbanView({ items, canEdit, onOpen, onMove }: Props) {
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items])
  const [columns, setColumns] = useState<Columns>(() => columnsOf(items))
  const dragging = useRef(false)
  const [active, setActive] = useState<string>()

  // Follow the server between drags; never mid-drag.
  useEffect(() => {
    if (!dragging.current) setColumns(columnsOf(items))
  }, [items])

  return (
    <DragDropProvider
      onDragStart={(event) => {
        dragging.current = true
        setActive(String(event.operation.source?.id ?? ''))
      }}
      onDragEnd={(event) => {
        dragging.current = false
        setActive(undefined)
        if (event.canceled) return
        const { source, target } = event.operation
        const key = String(source?.id ?? '')
        const from = BOARD_COLUMNS.find((s) => columns[s].includes(key))
        if (!from || !target) return
        const data = target.data as { column?: Status; card?: Status; key?: string } | undefined
        const to = data?.column ?? data?.card
        if (!to || !BOARD_COLUMNS.includes(to) || data?.key === key) return
        const order = columns[to].filter((k) => k !== key)
        // On a card: in its place (that card moves down). On the column's empty space: at the end.
        let index = data?.key ? order.indexOf(data.key) : order.length
        if (index < 0) index = order.length
        order.splice(index, 0, key)
        if (from === to && columns[from].join() === order.join()) return
        setColumns({ ...columns, [from]: columns[from].filter((k) => k !== key), [to]: order })
        const neighbour = order[index + 1] ? { above: order[index + 1] } : order[index - 1] ? { below: order[index - 1] } : {}
        onMove(key, to, order, neighbour)
      }}
    >
      <div className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-4">
        {BOARD_COLUMNS.map((status) => (
          <Column key={status} status={status} keys={columns[status]} byKey={byKey} canEdit={canEdit} active={active} onOpen={onOpen} />
        ))}
      </div>
      <DragOverlay>{active && byKey.get(active) ? <CardBody item={byKey.get(active)!} className="rotate-1 shadow-xl" /> : null}</DragOverlay>
    </DragDropProvider>
  )
}

function Column({ status, keys, byKey, canEdit, active, onOpen }: { status: Status; keys: string[]; byKey: Map<string, Item>; canEdit: boolean; active?: string; onOpen: (key: string) => void }) {
  const { ref, isDropTarget } = useDroppable({ id: `column:${status}`, data: { column: status }, collisionPriority: CollisionPriority.Low, collisionDetector: pointerIntersection })
  return (
    <section
      ref={ref}
      aria-label={STATUS_LABEL[status]}
      className={`flex min-h-[60vh] flex-col rounded-2xl border p-2 transition-colors ${isDropTarget ? 'border-accent/60 bg-default/80' : 'border-separator bg-default/40'}`}
    >
      <header className="flex items-center justify-between px-2 pt-1 pb-2">
        <h2 className="text-sm font-semibold">{STATUS_LABEL[status]}</h2>
        <span className="text-xs text-muted">{keys.length}</span>
      </header>
      <div className="flex flex-col gap-2">
        {keys.map((key) => {
          const item = byKey.get(key)
          return item ? <Card key={key} item={item} status={status} canEdit={canEdit} isActive={active === key} onOpen={onOpen} /> : null
        })}
      </div>
    </section>
  )
}

function Card({ item, status, canEdit, isActive, onOpen }: { item: Item; status: Status; canEdit: boolean; isActive: boolean; onOpen: (key: string) => void }) {
  const drag = useDraggable({ id: item.key, disabled: !canEdit })
  // The drop target is the wrapper, not the dragged element, and only what
  // is under the pointer counts: by overlap, the dragged shape (still at
  // the card's start) would always "hit" its own card.
  const drop = useDroppable({ id: `card:${item.key}`, data: { card: status, key: item.key }, disabled: !canEdit, collisionDetector: pointerIntersection })
  return (
    <div ref={drop.ref} className="relative">
      {drop.isDropTarget && !isActive && <div className="pointer-events-none absolute -top-[5px] right-1 left-1 h-[3px] rounded-full bg-accent" />}
      <div
        ref={drag.ref}
        role="button"
        tabIndex={0}
        onClick={() => onOpen(item.key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onOpen(item.key)
        }}
        className={`rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-focus ${canEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
      >
        <CardBody item={item} className={isActive ? 'opacity-40' : 'hover:border-border'} />
      </div>
    </div>
  )
}

function CardBody({ item, className = '' }: { item: Item; className?: string }) {
  return (
    <div className={`rounded-xl border border-separator bg-surface p-3 text-left shadow-sm transition ${className}`}>
      <div className="text-sm leading-snug font-medium">{item.title}</div>
      <div className="mt-2 flex items-center gap-2">
        <span className="mono text-xs text-muted">{item.key}</span>
        <PriorityChip priority={item.priority} />
        <ExternalBadge item={item} />
        <span className="flex-1" />
        {item.assignee && <PersonAvatar name={item.assignee} px={24} />}
      </div>
      {item.labels.length > 0 && (
        <div className="mt-2">
          <Labels labels={item.labels} />
        </div>
      )}
    </div>
  )
}
