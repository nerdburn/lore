import { ArrowUpRightFromSquare } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Dropdown, Label, Spinner, Switch, Table, toast } from '@heroui/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type ClientRequest } from './api'

const STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', stale: 'Stale', archived: 'Archived' }
const STATUS_COLOR: Record<string, 'default' | 'accent' | 'success' | 'warning'> = { open: 'default', in_progress: 'accent', done: 'success', stale: 'warning' }
const POLL_MS = 60_000

/**
 * What the client has asked for that is not a ticket yet. Each row can be
 * turned into one; rows already tracked, done or gone stale are hidden until
 * asked for.
 */
export function RequestsView({
  context,
  canEdit,
  q,
  showAll,
  onShowAll,
  onOpen,
  onPromoted,
  onError,
}: {
  context: string
  canEdit: boolean
  q: string
  showAll: boolean
  onShowAll: (v: boolean) => void
  onOpen: (key: string) => void
  onPromoted: () => void
  onError: (err: unknown) => void
}) {
  const [requests, setRequests] = useState<ClientRequest[]>()
  const [busy, setBusy] = useState<string>()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      setRequests((await api.requests(context)).requests)
    } catch (err) {
      onError(err)
      setRequests((r) => r ?? [])
    }
  }, [context, onError])

  useEffect(() => {
    void load()
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const waiting = useMemo(() => (requests ?? []).filter((r) => !r.ticket && r.status !== 'done' && r.status !== 'stale' && r.status !== 'archived'), [requests])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (showAll ? (requests ?? []) : waiting)
      .filter((r) => !needle || `${r.request} ${r.requested_by ?? ''} ${r.id} ${r.goals?.map(g => g.outcome).join(' ') ?? ''}`.toLowerCase().includes(needle))
      .slice()
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  }, [requests, waiting, showAll, q])

  const promote = async (r: ClientRequest) => {
    setBusy(r.id)
    try {
      const { item } = await api.promote(context, r.id)
      setRequests((all) => all?.map((x) => (x.id === r.id ? { ...x, ticket: item.key, similar: undefined, coverage: undefined } : x)))
      onPromoted()
      toast.success(`Made ${item.key}`, { description: item.title, timeout: 8000, actionProps: { children: 'Open', onPress: () => onOpen(item.key) } })
    } catch (err) {
      onError(err)
    } finally {
      setBusy(undefined)
    }
  }

  // Only rows on screen can be acted on: a selection never reaches past the search or the switch.
  const picked = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected])
  const allPicked = rows.length > 0 && picked.length === rows.length
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const bulk = async (action: 'ticket' | 'archive' | 'delete' | 'restore', ids = picked.map((r) => r.id)) => {
    if (ids.length === 0) return
    setBusy('bulk')
    try {
      const res = await api.requestsBulk(context, ids, action)
      setRequests(res.requests)
      setSelected(new Set())
      if (action === 'ticket') onPromoted()
      const n = res.changed.length
      const s = n === 1 ? '' : 's'
      const left = res.skipped.length ? ` ${res.skipped.length} left as they were.` : ''
      if (action === 'ticket') toast.success(`Made ${n} ticket${s}`, { description: `${res.tickets.join(', ')}${left}`, timeout: 8000 })
      else if (action === 'restore') toast.success(`Restored ${n} request${s}`)
      else
        toast.success(`${action === 'archive' ? 'Archived' : 'Deleted'} ${n} request${s}`, {
          description: action === 'archive' ? `Hidden until you show archived requests.${left}` : `Removed from the list.${left}`,
          timeout: 10000,
          actionProps: n ? { children: 'Undo', onPress: () => void bulk('restore', res.changed) } : undefined,
        })
    } catch (err) {
      onError(err)
    } finally {
      setBusy(undefined)
    }
  }

  if (!requests) {
    return (
      <div className="flex justify-center p-12">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {waiting.length} request{waiting.length === 1 ? '' : 's'} without a ticket, of {requests.length} recorded from the client.
        </p>
        <div className="flex items-center gap-4">
          {canEdit && (
            <Dropdown>
              <Button size="sm" variant="secondary" isDisabled={picked.length === 0 || busy !== undefined}>
                {busy === 'bulk' ? <Spinner size="sm" /> : `Actions${picked.length ? ` (${picked.length})` : ''}`}
              </Button>
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu onAction={(k) => void bulk(k as 'ticket' | 'archive' | 'delete' | 'restore')} disabledKeys={picked.some((r) => r.status === 'archived') ? [] : ['restore']}>
                  <Dropdown.Item id="ticket" textValue="Make tickets">
                    <Label>Make tickets</Label>
                  </Dropdown.Item>
                  <Dropdown.Item id="archive" textValue="Archive">
                    <Label>Archive</Label>
                  </Dropdown.Item>
                  <Dropdown.Item id="restore" textValue="Unarchive">
                    <Label>Unarchive</Label>
                  </Dropdown.Item>
                  <Dropdown.Item id="delete" textValue="Delete" variant="danger">
                    <Label>Delete</Label>
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          )}
        <Switch isSelected={showAll} onChange={onShowAll} size="sm">
          <Switch.Content className="flex items-center gap-2 text-sm">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            Show ticketed, done, stale &amp; archived
          </Switch.Content>
        </Switch>
        </div>
      </div>
      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="Client requests" className="min-w-[760px]">
            <Table.Header>
              {canEdit && (
                <Table.Column className="w-10">
                  <Checkbox slot={null} aria-label="Select all requests" isSelected={allPicked} isIndeterminate={picked.length > 0 && !allPicked} onChange={(on) => setSelected(on ? new Set(rows.map((r) => r.id)) : new Set())}>
                    <Checkbox.Content>
                      <Checkbox.Control className="border border-muted/50">
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                    </Checkbox.Content>
                  </Checkbox>
                </Table.Column>
              )}
              <Table.Column isRowHeader>Request</Table.Column>
              <Table.Column className="w-44">Asked by</Table.Column>
              <Table.Column className="w-32">Date</Table.Column>
              <Table.Column className="w-28">Status</Table.Column>
              <Table.Column className="w-44">Ticket</Table.Column>
            </Table.Header>
            <Table.Body renderEmptyState={() => <div className="p-8 text-center text-muted">{requests.length ? 'No requests waiting for a ticket.' : 'No client requests recorded yet.'}</div>}>
              {rows.map((r) => (
                <Table.Row key={r.id} id={r.id}>
                  {canEdit && (
                    <Table.Cell>
                      <Checkbox slot={null} aria-label={`Select ${r.id}`} isSelected={selected.has(r.id)} onChange={(on) => toggle(r.id, on)}>
                        <Checkbox.Content>
                          <Checkbox.Control className="border border-muted/50">
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                        </Checkbox.Content>
                      </Checkbox>
                    </Table.Cell>
                  )}
                  <Table.Cell>
                    <div className="flex flex-col gap-1 py-1">
                      <span className="line-clamp-3 text-sm" title={r.request}>
                        {r.request}
                      </span>
                      {r.goals?.map(g => (
                        <span key={g.outcome} className="text-xs text-muted">Goal · {g.outcome} ({g.timing})</span>
                      ))}
                      <span className="flex items-center gap-2 text-xs text-muted">
                        <span className="mono">{r.id}</span>
                        {r.source && /^https?:\/\//.test(r.source) && (
                          <a href={r.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                            where it was asked
                            <ArrowUpRightFromSquare className="size-3" />
                          </a>
                        )}
                      </span>
                    </div>
                  </Table.Cell>
                  <Table.Cell className="text-sm">{r.requested_by ?? <span className="text-muted">—</span>}</Table.Cell>
                  <Table.Cell className="text-sm whitespace-nowrap text-muted">{r.date ?? '—'}</Table.Cell>
                  <Table.Cell>
                    <Chip size="sm" variant="soft" color={STATUS_COLOR[r.status ?? ''] ?? 'default'}>
                      {STATUS_LABEL[r.status ?? ''] ?? r.status ?? '—'}
                    </Chip>
                  </Table.Cell>
                  <Table.Cell>
                    {r.ticket ? (
                      <Button size="sm" variant="ghost" onPress={() => onOpen(r.ticket!)}>
                        <span className="mono">{r.ticket}</span>
                      </Button>
                    ) : (
                      <div className="flex flex-col items-start gap-1">
                        {canEdit && r.status !== 'done' && r.status !== 'archived' && (
                          <Button size="sm" variant="secondary" isDisabled={busy !== undefined} onPress={() => void promote(r)}>
                            {busy === r.id ? <Spinner size="sm" /> : 'Make ticket'}
                          </Button>
                        )}
                        {r.coverage && (
                          <button type="button" className="text-left text-xs text-warning hover:underline" onClick={() => onOpen(r.coverage!.key)}>
                            Jev suggests {r.coverage.key} may cover this request · {r.coverage.title}
                          </button>
                        )}
                        {!r.coverage && r.similar && (
                          <button type="button" className="text-xs text-warning hover:underline" onClick={() => onOpen(r.similar!)}>
                            Similar title · {r.similar}
                          </button>
                        )}
                      </div>
                    )}
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
