import { ArrowUpRightFromSquare } from '@gravity-ui/icons'
import { Button, Chip, Spinner, Switch, Table, toast } from '@heroui/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type ClientRequest } from './api'

const STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', stale: 'Stale' }
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

  const waiting = useMemo(() => (requests ?? []).filter((r) => !r.ticket && r.status !== 'done' && r.status !== 'stale'), [requests])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (showAll ? (requests ?? []) : waiting)
      .filter((r) => !needle || `${r.request} ${r.requested_by ?? ''} ${r.id}`.toLowerCase().includes(needle))
      .slice()
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  }, [requests, waiting, showAll, q])

  const promote = async (r: ClientRequest) => {
    setBusy(r.id)
    try {
      const { item } = await api.promote(context, r.id)
      setRequests((all) => all?.map((x) => (x.id === r.id ? { ...x, ticket: item.key, similar: undefined } : x)))
      onPromoted()
      toast.success(`Made ${item.key}`, { description: item.title, timeout: 8000, actionProps: { children: 'Open', onPress: () => onOpen(item.key) } })
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
        <Switch isSelected={showAll} onChange={onShowAll} size="sm">
          <Switch.Content className="flex items-center gap-2 text-sm">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            Show ticketed, done &amp; stale
          </Switch.Content>
        </Switch>
      </div>
      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="Client requests" className="min-w-[760px]">
            <Table.Header>
              <Table.Column isRowHeader>Request</Table.Column>
              <Table.Column className="w-44">Asked by</Table.Column>
              <Table.Column className="w-32">Date</Table.Column>
              <Table.Column className="w-28">Status</Table.Column>
              <Table.Column className="w-44">Ticket</Table.Column>
            </Table.Header>
            <Table.Body renderEmptyState={() => <div className="p-8 text-center text-muted">{requests.length ? 'Every request has a ticket.' : 'No client requests recorded yet.'}</div>}>
              {rows.map((r) => (
                <Table.Row key={r.id} id={r.id}>
                  <Table.Cell>
                    <div className="flex flex-col gap-1 py-1">
                      <span className="line-clamp-3 text-sm" title={r.request}>
                        {r.request}
                      </span>
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
                        {canEdit && r.status !== 'done' && (
                          <Button size="sm" variant="secondary" isDisabled={busy !== undefined} onPress={() => void promote(r)}>
                            {busy === r.id ? <Spinner size="sm" /> : 'Make ticket'}
                          </Button>
                        )}
                        {r.similar && (
                          <button type="button" className="text-xs text-warning hover:underline" onClick={() => onOpen(r.similar!)}>
                            may already be {r.similar}
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
