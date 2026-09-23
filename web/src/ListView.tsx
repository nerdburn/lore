import { Switch, Table, type SortDescriptor } from '@heroui/react'
import { useMemo, useState } from 'react'
import { WORK_ORDER, type Item } from './api'
import { ago, ExternalBadge, Labels, PriorityChip, StatusChip } from './bits'

type Col = 'rank' | 'key' | 'title' | 'status' | 'priority' | 'assignee' | 'updated'

const keyNum = (k: string) => Number(/-(\d+)$/.exec(k)?.[1] ?? 0)

export function ListView({ items, onOpen, showClosed, onShowClosed }: { items: Item[]; onOpen: (key: string) => void; showClosed: boolean; onShowClosed: (v: boolean) => void }) {
  const [sort, setSort] = useState<SortDescriptor>({ column: 'rank', direction: 'ascending' })

  const rows = useMemo(() => {
    const rank = new Map(items.map((i, n) => [i.key, n]))
    const shown = items.filter((i) => showClosed || i.state === 'open')
    const col = sort.column as Col
    const cmp = (a: Item, b: Item): number => {
      switch (col) {
        case 'key':
          return keyNum(a.key) - keyNum(b.key)
        case 'title':
          return a.title.localeCompare(b.title)
        case 'status':
          return WORK_ORDER.indexOf(a.status) - WORK_ORDER.indexOf(b.status) || rank.get(a.key)! - rank.get(b.key)!
        case 'priority':
          return (a.priority ?? 'P9').localeCompare(b.priority ?? 'P9') || rank.get(a.key)! - rank.get(b.key)!
        case 'assignee':
          return (a.assignee ?? '￿').localeCompare(b.assignee ?? '￿')
        case 'updated':
          return (a.last?.at ?? a.updated).localeCompare(b.last?.at ?? b.updated)
        default:
          return rank.get(a.key)! - rank.get(b.key)!
      }
    }
    const sorted = [...shown].sort(cmp)
    return sort.direction === 'descending' ? sorted.reverse() : sorted
  }, [items, sort, showClosed])

  const header = (id: Col, label: string, extra: { isRowHeader?: boolean; className?: string } = {}) => (
    <Table.Column allowsSorting id={id} {...extra}>
      {({ sortDirection }) => <Table.SortableColumnHeader sortDirection={sortDirection}>{label}</Table.SortableColumnHeader>}
    </Table.Column>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Switch isSelected={showClosed} onChange={onShowClosed} size="sm">
          <Switch.Content className="flex items-center gap-2 text-sm">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            Show done &amp; archived
          </Switch.Content>
        </Switch>
      </div>
      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="Tickets" className="min-w-[760px]" sortDescriptor={sort} onSortChange={setSort} onRowAction={(key) => onOpen(String(key))}>
            <Table.Header>
              {header('rank', '#', { className: 'w-12' })}
              {header('key', 'Key', { className: 'w-24' })}
              {header('title', 'Title', { isRowHeader: true })}
              {header('status', 'Status', { className: 'w-32' })}
              {header('priority', 'Priority', { className: 'w-24' })}
              {header('assignee', 'Assignee', { className: 'w-36' })}
              {header('updated', 'Updated', { className: 'w-28' })}
            </Table.Header>
            <Table.Body renderEmptyState={() => <div className="p-8 text-center text-muted">No tickets match.</div>}>
              {rows.map((i) => (
                <Table.Row key={i.key} id={i.key} className="cursor-pointer">
                  <Table.Cell className="text-muted">{items.indexOf(i) + 1}</Table.Cell>
                  <Table.Cell>
                    <span className="mono text-xs">{i.key}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{i.title}</span>
                      <Labels labels={i.labels} />
                      <ExternalBadge item={i} />
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusChip status={i.status} />
                  </Table.Cell>
                  <Table.Cell>
                    <PriorityChip priority={i.priority} />
                  </Table.Cell>
                  <Table.Cell className="text-sm">{i.assignee ?? <span className="text-muted">—</span>}</Table.Cell>
                  <Table.Cell className="text-sm text-muted">
                    <span title={i.last ? `${i.last.by}: ${i.last.reason}` : undefined}>{ago(i.last?.at ?? i.updated)}</span>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </div>
  )
}
