import { Card, Chip, Spinner } from '@heroui/react'
import { useEffect, useState } from 'react'
import { api, ApiError, STATUS_LABEL, type ProjectSummary } from './api'
import { boardRoute, href, navigate } from './router'

export function Projects({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api.projects().then(
      (r) => {
        setProjects(r.projects)
        // One board: go straight to it.
        if (r.projects.length === 1) navigate(boardRoute(r.projects[0].context), true)
      },
      (err) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : setError(err.message)),
    )
  }, [onUnauthorized])

  if (error) return <p className="p-8 text-danger">{error}</p>
  if (!projects)
    return (
      <div className="flex justify-center p-16">
        <Spinner />
      </div>
    )

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Boards</h1>
      {projects.length === 0 ? (
        <Card className="p-6">
          <Card.Title>No boards yet</Card.Title>
          <Card.Description>You're signed in, but no project has shared its board with this address. Ask your project lead to add you.</Card.Description>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => {
            const open = p.counts.todo + p.counts.in_progress + p.counts.blocked
            return (
              <a
                key={p.context}
                href={href(boardRoute(p.context))}
                onClick={(e) => {
                  e.preventDefault()
                  navigate(boardRoute(p.context))
                }}
                className="rounded-3xl outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Card className="h-full p-5 transition hover:shadow-md">
                  <Card.Header>
                    <div className="flex items-start justify-between gap-2">
                      <Card.Title className="text-lg">{p.client ?? p.project}</Card.Title>
                      <span className="mono text-xs text-muted">{p.prefix}</span>
                    </div>
                    <Card.Description>
                      {open} open · {p.counts.done} done
                    </Card.Description>
                  </Card.Header>
                  <Card.Footer className="flex flex-wrap gap-1.5 pt-3">
                    {p.counts.blocked > 0 && (
                      <Chip size="sm" color="danger" variant="soft">
                        {p.counts.blocked} {STATUS_LABEL.blocked.toLowerCase()}
                      </Chip>
                    )}
                    {p.role === 'viewer' && (
                      <Chip size="sm" variant="soft">
                        view only
                      </Chip>
                    )}
                    {p.archived && (
                      <Chip size="sm" variant="soft">
                        archived
                      </Chip>
                    )}
                  </Card.Footer>
                </Card>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
