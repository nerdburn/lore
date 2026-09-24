import { Copy } from '@gravity-ui/icons'
import { Button, Card, Chip, Spinner, toast } from '@heroui/react'
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type Connection, type ProjectSummary } from './api'
import { ago } from './bits'

/** How to point Claude Code at lore, per project — and the apps already connected, with revoke. */
export function ConnectPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>()
  const [connections, setConnections] = useState<Connection[]>()
  const fail = useCallback((err: unknown) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : toast.danger(err instanceof Error ? err.message : String(err))), [onUnauthorized])
  const load = useCallback(() => {
    api.projects().then((r) => setProjects(r.projects), fail)
    api.connections().then((r) => setConnections(r.connections), fail)
  }, [fail])
  useEffect(load, [load])

  const origin = window.location.origin
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connect Claude Code</h1>
        <p className="mt-1 text-sm text-muted">
          Give Claude Code on your machine the same project memory the team's agents use. Run the command for a project, then use <span className="mono">/mcp</span> in Claude Code to sign in — a browser opens,
          you sign in with your email code and approve. Access follows your board role; nothing to paste, nothing to rotate.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        {!projects ? (
          <Spinner />
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted">You aren't on any project's board yet.</p>
        ) : (
          projects.map((p) => {
            const cmd = `claude mcp add --transport http lore-${p.context.replace(/^lore-/, '')} ${origin}/mcp/${p.context}`
            return (
              <Card key={p.context} className="p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium">{p.client ?? p.project}</span>
                  <Chip size="sm" variant="soft" color={p.role === 'member' ? 'accent' : 'default'}>
                    {p.role === 'member' ? 'read & write' : 'read only'}
                  </Chip>
                </div>
                <div className="flex items-center gap-2 rounded-lg bg-default px-3 py-2">
                  <code className="mono flex-1 overflow-x-auto text-xs whitespace-nowrap">{cmd}</code>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label="Copy command"
                    onPress={() => {
                      void navigator.clipboard.writeText(cmd)
                      toast.success('Copied')
                    }}
                  >
                    <Copy />
                  </Button>
                </div>
              </Card>
            )
          })
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Connected apps</h2>
        {!connections ? (
          <Spinner />
        ) : connections.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <div className="flex flex-col divide-y divide-separator rounded-2xl border border-separator bg-surface">
            {connections.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{c.client_name}</div>
                  <div className="text-xs text-muted">
                    {c.resource ? new URL(c.resource).pathname.replace('/mcp/', '') : 'any project'} · connected {ago(c.created)} · last used {ago(c.last_used)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="danger-soft"
                  onPress={async () => {
                    try {
                      await api.revokeConnection(c.id)
                      toast.success(`Revoked ${c.client_name}`)
                      load()
                    } catch (err) {
                      fail(err)
                    }
                  }}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-muted">Revoking ends the app's refresh token; its current access lapses within the hour.</p>
      </section>
    </div>
  )
}
