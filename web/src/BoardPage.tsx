import { Plus } from '@gravity-ui/icons'
import { Button, Label, ListBox, SearchField, Select, Spinner, Tabs, toast } from '@heroui/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, type Board, type Item, type Status } from './api'
import { ItemDrawer } from './ItemDrawer'
import { KanbanView } from './KanbanView'
import { ListView } from './ListView'
import { NewItemModal } from './NewItemModal'
import { navigate, type Route } from './router'

type BoardRoute = Extract<Route, { name: 'board' }>

const ALL = '__all'
const NONE = '__none'
const POLL_MS = 30_000

export interface Filters {
  q: string
  label: string
  assignee: string
}

export function BoardPage({ route, onUnauthorized }: { route: BoardRoute; onUnauthorized: () => void }) {
  const [board, setBoard] = useState<Board>()
  const [error, setError] = useState<string>()
  const [filters, setFilters] = useState<Filters>({ q: '', label: ALL, assignee: ALL })
  const [creating, setCreating] = useState(false)
  // While a write is in flight, a poll must not snap the card back.
  const pending = useRef(0)

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      toast.danger(err instanceof Error ? err.message : String(err))
    },
    [onUnauthorized],
  )

  const load = useCallback(async () => {
    if (pending.current > 0) return
    try {
      setBoard(await api.board(route.context))
      setError(undefined)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [route.context, onUnauthorized])

  useEffect(() => {
    void load()
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  /** Apply a change locally now, send it, then take the server's truth. */
  const write = useCallback(
    async (optimistic: ((b: Board) => Board) | undefined, send: () => Promise<{ item: Item }>) => {
      if (optimistic) setBoard((b) => (b ? optimistic(b) : b))
      pending.current++
      try {
        return (await send()).item
      } catch (err) {
        fail(err)
        return undefined
      } finally {
        pending.current--
        await load()
      }
    },
    [fail, load],
  )

  const moveItem = useCallback(
    (key: string, status: Status, order: string[], neighbour: { above?: string; below?: string }) =>
      write(
        (b) => ({ ...b, items: reorder(b.items, key, status, order) }),
        () => api.move(route.context, key, { status, ...neighbour }),
      ),
    [route.context, write],
  )

  const visible = useMemo(() => (board ? applyFilters(board.items, filters) : []), [board, filters])
  const canEdit = board?.role === 'member' && !board.archived
  const open = (key?: string) => navigate({ ...route, item: key })

  if (error)
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-lg font-medium">{error === 'no such board' ? 'This board is not available to you.' : error}</p>
        <Button className="mt-4" variant="secondary" onPress={() => navigate({ name: 'projects' })}>
          All boards
        </Button>
      </div>
    )
  if (!board)
    return (
      <div className="flex justify-center p-16">
        <Spinner />
      </div>
    )

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold tracking-tight">{board.client ?? board.project}</h1>
          <p className="text-sm text-muted">
            {board.items.filter((i) => i.state === 'open').length} open · <span className="mono">{board.prefix}</span>
            {board.role === 'viewer' && ' · view only'}
            {board.archived && ' · archived (read-only)'}
          </p>
        </div>
        <Tabs selectedKey={route.view} onSelectionChange={(k) => navigate({ ...route, view: k as 'list' | 'kanban' }, true)}>
          <Tabs.ListContainer>
            <Tabs.List aria-label="View">
              <Tabs.Tab id="kanban">
                Board
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="list">
                List
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        {canEdit && (
          <Button onPress={() => setCreating(true)}>
            <Plus />
            New ticket
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <SearchField aria-label="Search tickets" value={filters.q} onChange={(q) => setFilters((f) => ({ ...f, q }))} className="w-full sm:w-72">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="Search title, key, description" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <FilterSelect label="Label" value={filters.label} options={board.labels} onChange={(label) => setFilters((f) => ({ ...f, label }))} />
        <FilterSelect label="Assignee" value={filters.assignee} options={board.assignees} onChange={(assignee) => setFilters((f) => ({ ...f, assignee }))} withNone />
      </div>

      {route.view === 'kanban' ? (
        <KanbanView items={visible} canEdit={canEdit} onOpen={open} onMove={moveItem} />
      ) : (
        <ListView items={visible} onOpen={open} />
      )}

      <ItemDrawer
        context={route.context}
        itemKey={route.item}
        board={board}
        canEdit={canEdit}
        onClose={() => open(undefined)}
        onChanged={load}
        onError={fail}
      />
      {canEdit && (
        <NewItemModal
          isOpen={creating}
          onOpenChange={setCreating}
          board={board}
          onCreate={async (fields) => {
            const item = await write(undefined, () => api.add(route.context, fields))
            if (item) toast.success(`Created ${item.key}`)
            return Boolean(item)
          }}
        />
      )}
    </div>
  )
}

function FilterSelect({ label, value, options, onChange, withNone }: { label: string; value: string; options: string[]; onChange: (v: string) => void; withNone?: boolean }) {
  return (
    <Select className="w-44" selectedKey={value} onSelectionChange={(k) => onChange(String(k ?? ALL))}>
      <Label className="sr-only">{label}</Label>
      <Select.Trigger>
        <Select.Value>{({ defaultChildren, isPlaceholder }) => (value === ALL || isPlaceholder ? `${label}: any` : defaultChildren)}</Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBox.Item id={ALL} textValue={`Any ${label.toLowerCase()}`}>
            Any {label.toLowerCase()}
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {withNone ? (
            <ListBox.Item id={NONE} textValue="Unassigned">
              Unassigned
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ) : null}
          {options.map((o) => (
            <ListBox.Item key={o} id={o} textValue={o}>
              {o}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

function applyFilters(items: Item[], f: Filters): Item[] {
  const q = f.q.trim().toLowerCase()
  return items.filter(
    (i) =>
      (!q || i.key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q)) &&
      (f.label === ALL || i.labels.some((l) => l.toLowerCase() === f.label.toLowerCase())) &&
      (f.assignee === ALL || (f.assignee === NONE ? !i.assignee : i.assignee === f.assignee)),
  )
}

/**
 * The optimistic version of a drop: `order` is the target column's keys
 * after the drop. Rebuild the whole table's rank so the column reads in
 * that order, leaving every other item where it was.
 */
function reorder(items: Item[], key: string, status: Status, order: string[]): Item[] {
  const moved = items.find((i) => i.key === key)
  if (!moved) return items
  const updated = { ...moved, status, state: status === 'done' || status === 'archived' ? ('closed' as const) : ('open' as const) }
  const rest = items.filter((i) => i.key !== key)
  const idx = order.indexOf(key)
  const after = order.slice(idx + 1).find((k) => rest.some((i) => i.key === k))
  const before = order.slice(0, idx).reverse().find((k) => rest.some((i) => i.key === k))
  let at = rest.length
  if (after) at = rest.findIndex((i) => i.key === after)
  else if (before) at = rest.findIndex((i) => i.key === before) + 1
  rest.splice(at, 0, updated)
  return rest
}
