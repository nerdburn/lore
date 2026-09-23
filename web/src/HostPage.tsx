import { Card, Chip, Spinner, Table } from '@heroui/react'
import { useEffect, useState } from 'react'
import { api, ApiError, type ClientStatus, type HostStatus } from './api'
import { ago } from './bits'

/** The host's own status — every client's sync health, open agent sessions, and the onboarding playbook. Admins only. */
export function HostPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [status, setStatus] = useState<HostStatus>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const load = () =>
      api.host().then(setStatus, (err) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : setError(err.message)))
    void load()
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 60_000)
    return () => clearInterval(t)
  }, [onUnauthorized])

  if (error) return <p className="mx-auto max-w-3xl px-4 py-16 text-center">{error}</p>
  if (!status)
    return (
      <div className="flex justify-center p-16">
        <Spinner />
      </div>
    )

  const unhealthy = status.clients.filter((c) => problems(c).length > 0).length
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-8 px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Host status</h1>
        <p className="text-sm text-muted">
          {status.clients.length} context repos · {unhealthy ? `${unhealthy} need attention` : 'all healthy'} · {status.sessions.length} agent sessions · read live from /srv/lore/repos, {ago(status.generated)} ·{' '}
          <a className="text-link hover:underline" href="/status.json">
            status.json
          </a>
        </p>
      </div>

      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="Clients on this host" className="min-w-[900px]">
            <Table.Header>
              <Table.Column isRowHeader>Context repo</Table.Column>
              <Table.Column className="w-24">Lifecycle</Table.Column>
              <Table.Column>Sources</Table.Column>
              <Table.Column className="w-24">Synced</Table.Column>
              <Table.Column className="w-24">Extracted</Table.Column>
              <Table.Column>Health</Table.Column>
            </Table.Header>
            <Table.Body renderEmptyState={() => <div className="p-8 text-center text-muted">No context repos yet.</div>}>
              {status.clients.map((c) => {
                const issues = problems(c)
                const stateOf = new Map(c.sourceStates.map((s) => [s.source, s]))
                return (
                  <Table.Row key={c.name} id={c.name} className={c.lifecycle === 'archived' ? 'opacity-55' : ''}>
                    <Table.Cell>
                      <div className="mono text-sm">{c.name}</div>
                      {c.client && <div className="text-xs text-muted">{c.client}</div>}
                    </Table.Cell>
                    <Table.Cell>
                      <Chip size="sm" variant="soft" color={c.lifecycle === 'archived' ? 'default' : 'success'}>
                        {c.lifecycle ?? '?'}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-wrap gap-1">
                        {c.sources.map((s) => {
                          const st = stateOf.get(s)
                          const ok = !st || st.state === 'ok'
                          return (
                            <Chip key={s} size="sm" variant={ok ? 'secondary' : 'soft'} color={ok ? 'default' : 'warning'}>
                              {s}
                            </Chip>
                          )
                        })}
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-sm text-muted">
                      <span title={c.lastSync}>{ago(c.lastSync) || '—'}</span>
                    </Table.Cell>
                    <Table.Cell className="text-sm text-muted">
                      <span title={c.lastExtract}>{ago(c.lastExtract) || '—'}</span>
                    </Table.Cell>
                    <Table.Cell>
                      {issues.length === 0 ? (
                        <Chip size="sm" variant="soft" color="success">
                          ok
                        </Chip>
                      ) : (
                        <ul className="flex flex-col gap-0.5 text-xs text-danger">
                          {issues.map((i) => (
                            <li key={i}>{i}</li>
                          ))}
                        </ul>
                      )}
                    </Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>

      {status.sessions.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Agent sessions</h2>
          <div className="flex flex-wrap gap-2">
            {summarizeSessions(status.sessions).map((s) => (
              <Chip key={`${s.agent}-${s.context}`} size="sm" variant="secondary">
                {s.agent} → {s.context}
                {s.count > 1 ? ` ×${s.count}` : ''}
              </Chip>
            ))}
          </div>
        </section>
      )}

      <Card className="p-6">
        <div className="prose-lore host-playbook max-w-[75ch]" dangerouslySetInnerHTML={{ __html: status.playbook }} />
      </Card>
    </div>
  )
}

function problems(c: ClientStatus): string[] {
  const out: string[] = []
  if (c.error) out.push(c.error)
  for (const s of c.sourceStates) {
    if (s.state === 'ok') continue
    out.push(s.state === 'never' ? `${s.source} never synced` : `${s.source} ${s.state}${s.staleHours ? ` ${Math.round(s.staleHours)}h` : ''}${s.error ? `: ${s.error}` : ''}`)
  }
  for (const [src, h] of Object.entries(c.health)) if (h.lastError && !out.some((o) => o.startsWith(src))) out.push(`${src}: ${h.lastError}`)
  return out
}

function summarizeSessions(sessions: HostStatus['sessions']) {
  const map = new Map<string, { agent: string; context: string; count: number }>()
  for (const s of sessions) {
    const k = `${s.agent}|${s.context}`
    const e = map.get(k) ?? { agent: s.agent, context: s.context, count: 0 }
    e.count++
    map.set(k, e)
  }
  return [...map.values()].sort((a, b) => a.agent.localeCompare(b.agent))
}
