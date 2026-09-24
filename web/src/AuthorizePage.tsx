import { Button, Card, Chip, Spinner } from '@heroui/react'
import { useEffect, useState } from 'react'
import { api, ApiError, type Me, type OAuthRequest } from './api'
import { Logo } from './Logo'

const ROLE: Record<string, string> = { member: 'read & write', viewer: 'read only' }

/** Where an MCP client (Claude Code) sends the browser to be let in: who is asking, for what, as whom. */
export function AuthorizePage({ id, me, onUnauthorized }: { id: string; me: Me; onUnauthorized: () => void }) {
  const [req, setReq] = useState<OAuthRequest>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'allow' | 'deny'>()

  useEffect(() => {
    api.oauthRequest(id).then(setReq, (err) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : setError(err.message)))
  }, [id, onUnauthorized])

  async function decide(approve: boolean) {
    setBusy(approve ? 'allow' : 'deny')
    try {
      const { redirect } = await api.oauthDecide(id, approve)
      window.location.href = redirect
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(undefined)
    }
  }

  const noAccess = req && (req.context ? !req.role : req.projects.length === 0)
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <Card className="w-full max-w-md p-2">
        <Card.Header className="gap-2">
          <Logo className="size-7" />
          <Card.Title className="pt-2 text-xl">{req ? `Connect ${req.client} to lore?` : 'Connect to lore'}</Card.Title>
          <Card.Description>
            {req ? (
              <>
                <span className="font-medium text-foreground">{req.client}</span> will use lore's project memory as <span className="font-medium text-foreground">{me.email}</span>, and return to{' '}
                <span className="mono">{req.redirect}</span>.
              </>
            ) : null}
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          {error ? (
            <p className="text-sm text-danger">{error}</p>
          ) : !req ? (
            <Spinner />
          ) : (
            <>
              <div className="rounded-xl bg-default/60 p-3 text-sm">
                {req.context ? (
                  req.role ? (
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        Project <span className="mono">{req.projects.find((p) => p.context === req.context)?.name ?? req.context}</span>
                      </span>
                      <Chip size="sm" variant="soft" color={req.role === 'member' ? 'accent' : 'default'}>
                        {ROLE[req.role]}
                      </Chip>
                    </div>
                  ) : (
                    <span className="text-danger">You don't have access to {req.context}. Ask a host admin to add you to its board.</span>
                  )
                ) : req.projects.length ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-muted">Any project you can open on the board:</span>
                    {req.projects.map((p) => (
                      <div key={p.context} className="flex items-center justify-between">
                        <span>{p.name}</span>
                        <Chip size="sm" variant="soft">
                          {ROLE[p.role]}
                        </Chip>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-danger">You aren't on any project's board yet.</span>
                )}
              </div>
              <p className="text-xs text-muted">Access follows your board role: if you're removed from a board, this app loses it too. Revoke any time under Connect Claude Code.</p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" isPending={busy === 'deny'} isDisabled={Boolean(busy)} onPress={() => void decide(false)}>
                  Deny
                </Button>
                <Button isPending={busy === 'allow'} isDisabled={Boolean(busy) || Boolean(noAccess)} onPress={() => void decide(true)}>
                  Allow
                </Button>
              </div>
            </>
          )}
        </Card.Content>
      </Card>
    </div>
  )
}
