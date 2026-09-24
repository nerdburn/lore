import { parse as parseYaml, stringify } from 'yaml'
import type { AttachmentContext, Connector, ConnectorContext, Doc, RemoteAttachment } from '../types.js'

/**
 * Linear connector — issues, comments and uploads for the configured teams,
 * through the GraphQL API (`https://api.linear.app/graphql`). Like Jira:
 *
 * - Stream docs: an issue when first seen and again whenever its delivery
 *   state changes (state, assignee, priority, title, labels); every comment
 *   once. Linear bodies are already markdown.
 * - A source-owned work table, context/work/linear/<TEAM>.yaml — the current
 *   issue list with Linear's own state (`category` = the state type:
 *   triage | backlog | unstarted | started | completed | canceled). Seeded
 *   with every open issue on the first sync; mirrored into the lore tracker.
 *
 * Auth: a personal API key is sent as `Authorization: <key>` (no Bearer).
 * On the host both hosts go through exe.dev http-proxy integrations that
 * inject it: `api_base` for the API and `uploads_base` for
 * uploads.linear.app, where files pasted into issues live.
 */

interface TeamCursor {
  since: string
  fingerprints: Record<string, string>
}
type LinearCursor = Record<string, TeamCursor>

const API = 'https://api.linear.app/graphql'
const UPLOADS = 'https://uploads.linear.app'
const DEFAULT_OVERLAP_DAYS = 1
const DAY_MS = 86_400_000

export interface LinearWorkItem {
  key: string
  title: string
  /** Linear's state name, e.g. "In Review". */
  status: string
  /** The state type: triage | backlog | unstarted | started | completed | canceled. */
  category: string
  state: 'open' | 'closed'
  priority?: string
  assignee?: string
  creator?: string
  labels: string[]
  parent?: string
  project?: string
  cycle?: string
  created: string
  updated: string
  resolved?: string
  url: string
}

const ISSUE_FIELDS = `id identifier title description url priority priorityLabel createdAt updatedAt completedAt canceledAt
  state { name type } assignee { name email } creator { name email } labels { nodes { name } }
  parent { identifier } project { name } cycle { name number }`

export const linear: Connector = {
  name: 'linear',

  async fetch(ctx: ConnectorContext) {
    const api = linearClient(ctx.config)
    const teams = (ctx.config.teams as string[] | undefined) ?? []
    if (teams.length === 0) throw new Error('linear: no teams configured')
    const includeComments = !((ctx.config.include as string[] | undefined)?.length) || (ctx.config.include as string[]).includes('comments')
    const overlapMs = numberOr(ctx.config.overlap_days, DEFAULT_OVERLAP_DAYS) * DAY_MS
    const cursor = { ...(ctx.cursor as LinearCursor) }
    const docs: Doc[] = []
    const errors: string[] = []
    const files: Record<string, string> = {}

    for (const team of teams) {
      const prev = cursor[team]
      const sinceMs = prev ? Math.max(new Date(prev.since).getTime() - overlapMs, ctx.since) : ctx.since
      const since = new Date(sinceMs).toISOString()
      const startedAt = new Date().toISOString()
      const fingerprints = { ...(prev?.fingerprints ?? {}) }
      const workPath = `context/work/linear/${team}.yaml`
      const table = new Map<string, LinearWorkItem>()
      for (const item of readWorkTable(ctx.readFile(workPath))) table.set(item.key, item)
      try {
        const updated = await api.issues({ team: { key: { eq: team } }, updatedAt: { gte: since } })
        const seed = prev ? [] : await api.issues({ team: { key: { eq: team } }, state: { type: { nin: ['completed', 'canceled'] } } })
        const seen = new Set<string>()
        for (const issue of [...seed, ...updated]) {
          const item = toWorkItem(issue)
          table.set(item.key, item)
          if (seen.has(item.key)) continue
          seen.add(item.key)
          const fp = fingerprint(item)
          if (fingerprints[item.key] === fp) continue
          docs.push(fingerprints[item.key] ? stateChangeDoc(team, issue, item) : openedDoc(team, issue, item))
          fingerprints[item.key] = fp
        }
        if (includeComments) {
          for (const c of await api.comments({ issue: { team: { key: { eq: team } } }, createdAt: { gte: since } })) docs.push(commentDoc(team, c))
        }
        files[workPath] = renderWorkTable(team, [...table.values()])
        cursor[team] = { since: startedAt, fingerprints }
        ctx.log(`linear: ${team} → ${docs.length} docs so far, ${table.size} work items`)
      } catch (err) {
        if (err instanceof LinearError && err.status < 500) {
          errors.push(`${team}: ${err.message} — check the team key and the API key's access`)
          continue
        }
        throw err
      }
    }
    return { docs, nextCursor: cursor, files, ...(errors.length ? { errors } : {}) }
  },

  /** Files pasted into the issues' descriptions and comments (uploads.linear.app). */
  async attachments(ctx: AttachmentContext, refs: string[]): Promise<RemoteAttachment[]> {
    const api = linearClient(ctx.config)
    const keys = refs.filter((r) => r.startsWith('linear:')).map((r) => r.slice('linear:'.length))
    const out: RemoteAttachment[] = []
    for (let i = 0; i < keys.length; i += 50) {
      const batch = keys.slice(i, i + 50)
      for (const issue of await api.issuesWithComments(batch)) {
        const ref = `linear:${issue.identifier}`
        const bodies = [{ text: issue.description ?? '', at: issue.createdAt, by: issue.creator?.name }, ...(issue.comments?.nodes ?? []).map((c) => ({ text: c.body ?? '', at: c.createdAt, by: c.user?.name }))]
        for (const b of bodies) {
          for (const u of uploadLinks(b.text)) {
            if (out.some((a) => a.ref === ref && a.sourceId === u.url)) continue
            out.push({ ref, sourceId: u.url, name: u.name, url: u.url, ...(b.at ? { created: b.at } : {}), ...(b.by ? { author: b.by } : {}) })
          }
        }
      }
    }
    return out
  },

  async download(ctx: AttachmentContext, att: RemoteAttachment): Promise<Response> {
    const base = ((ctx.config.uploads_base as string | undefined) ?? UPLOADS).replace(/\/+$/, '')
    const url = att.url.startsWith(UPLOADS) ? base + att.url.slice(UPLOADS.length) : att.url
    const key = ctx.config.token as string | undefined
    return fetch(url, { headers: key && !ctx.config.uploads_base ? { Authorization: key } : {} })
  },
}

/** `![shot.png](https://uploads.linear.app/…)` and bare upload links in a markdown body. */
export function uploadLinks(md: string): { url: string; name: string }[] {
  const out: { url: string; name: string }[] = []
  const seen = new Set<string>()
  for (const m of md.matchAll(/!?\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)|(https:\/\/uploads\.linear\.app\/[^\s)>\]]+)/g)) {
    const url = m[2] ?? m[3]
    if (seen.has(url)) continue
    seen.add(url)
    const tail = decodeURIComponent(url.split('?')[0].split('/').pop() ?? 'upload')
    out.push({ url, name: (m[1] || tail).trim() || tail })
  }
  return out
}

// ---- docs ----

function statusLine(item: LinearWorkItem): string {
  const bits = [item.status]
  if (item.priority) bits.push(`priority: ${item.priority}`)
  if (item.assignee) bits.push(`assignee: ${item.assignee}`)
  if (item.labels.length) bits.push(`labels: ${item.labels.join(', ')}`)
  if (item.cycle) bits.push(`cycle: ${item.cycle}`)
  if (item.project) bits.push(`project: ${item.project}`)
  return bits.join(' · ')
}

function meta(team: string, issue: { id: string; identifier: string }, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const m: Record<string, string> = { team, key: issue.identifier, issue_id: issue.id }
  for (const [k, v] of Object.entries(extra)) if (v) m[k] = v.replace(/\s+/g, '_')
  return m
}

function openedDoc(team: string, issue: LinearIssue, item: LinearWorkItem): Doc {
  return {
    id: `linear-${item.key}`,
    source: 'linear',
    channel: team,
    author: issue.creator?.name ?? 'unknown',
    timestamp: iso(issue.createdAt),
    permalink: item.url,
    meta: meta(team, issue, { state: item.category }),
    text: `**${item.key}: ${item.title}** (${statusLine(item)})\n\n${issue.description?.trim() || '(no description)'}`,
  }
}

function stateChangeDoc(team: string, issue: LinearIssue, item: LinearWorkItem): Doc {
  return {
    id: `linear-${item.key}@${iso(issue.updatedAt)}`,
    source: 'linear',
    channel: team,
    author: 'linear',
    timestamp: iso(issue.updatedAt),
    permalink: item.url,
    thread: item.key,
    meta: meta(team, issue, { state: item.category }),
    text: `${item.key} "${item.title}" is now: ${statusLine(item)}`,
  }
}

function commentDoc(team: string, c: LinearComment): Doc {
  return {
    id: `linear-comment-${c.id}`,
    source: 'linear',
    channel: team,
    author: c.user?.name ?? 'unknown',
    timestamp: iso(c.createdAt),
    permalink: c.url,
    thread: c.issue?.identifier,
    meta: { team, ...(c.issue?.identifier ? { key: c.issue.identifier } : {}), comment: c.id, ...(c.updatedAt && c.updatedAt !== c.createdAt ? { edited: iso(c.updatedAt) } : {}) },
    text: (c.body ?? '').trim(),
  }
}

// ---- work table ----

function toWorkItem(i: LinearIssue): LinearWorkItem {
  const category = i.state?.type ?? 'unstarted'
  const item: LinearWorkItem = {
    key: i.identifier,
    title: i.title,
    status: i.state?.name ?? 'Unknown',
    category,
    state: category === 'completed' || category === 'canceled' ? 'closed' : 'open',
    labels: (i.labels?.nodes ?? []).map((l) => l.name).sort(),
    created: iso(i.createdAt),
    updated: iso(i.updatedAt),
    url: i.url,
  }
  if (i.priority && i.priorityLabel) item.priority = i.priorityLabel
  if (i.assignee?.name) item.assignee = i.assignee.name
  if (i.creator?.name) item.creator = i.creator.name
  if (i.parent?.identifier) item.parent = i.parent.identifier
  if (i.project?.name) item.project = i.project.name
  if (i.cycle) item.cycle = i.cycle.name ?? `Cycle ${i.cycle.number}`
  const done = i.completedAt ?? i.canceledAt
  if (done) item.resolved = iso(done)
  return item
}

function fingerprint(item: LinearWorkItem): string {
  return JSON.stringify([item.status, item.title, item.priority ?? null, item.assignee ?? null, item.labels, item.cycle ?? null])
}

export function readWorkTable(text: string | undefined): LinearWorkItem[] {
  if (!text) return []
  try {
    const parsed = parseYaml(text.replace(/^(#.*\n)+/, ''))
    return Array.isArray(parsed) ? (parsed as LinearWorkItem[]) : []
  } catch {
    return []
  }
}

function renderWorkTable(team: string, items: LinearWorkItem[]): string {
  const open = items.filter((i) => i.state === 'open').sort((a, b) => b.updated.localeCompare(a.updated))
  const closed = items.filter((i) => i.state !== 'open').sort((a, b) => b.updated.localeCompare(a.updated))
  return (
    `# Source-owned by Linear (${team}) — written by \`lore sync\`, authoritative for issue state.\n` +
    `# Never hand-edit or LLM-edit; open first, then done/canceled, newest activity first.\n` +
    stringify([...open, ...closed])
  )
}

// ---- API client ----

export class LinearError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

interface LinearIssue {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  priority?: number
  priorityLabel?: string
  createdAt: string
  updatedAt: string
  completedAt?: string | null
  canceledAt?: string | null
  state?: { name: string; type: string }
  assignee?: { name: string; email?: string } | null
  creator?: { name: string; email?: string } | null
  labels?: { nodes: { name: string }[] }
  parent?: { identifier: string } | null
  project?: { name: string } | null
  cycle?: { name?: string | null; number: number } | null
  comments?: { nodes: LinearComment[] }
}

interface LinearComment {
  id: string
  body?: string
  createdAt: string
  updatedAt?: string
  url?: string
  user?: { name: string } | null
  issue?: { identifier: string } | null
}

export interface LinearApi {
  issues(filter: Record<string, unknown>): Promise<LinearIssue[]>
  comments(filter: Record<string, unknown>): Promise<LinearComment[]>
  issuesWithComments(identifiers: string[]): Promise<LinearIssue[]>
}

function linearClient(cfg: Record<string, unknown>): LinearApi {
  const url = ((cfg.api_base as string | undefined) ?? API).replace(/\/+$/, '')
  const key = cfg.token as string | undefined
  if (!key && cfg.api_base === undefined) throw new Error('linear: no credentials (set token, or api_base to a proxy that injects the key)')
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    for (;;) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { Authorization: key } : {}) },
        body: JSON.stringify({ query, variables }),
      })
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get('retry-after') ?? '5'), 120) * 1000))
        continue
      }
      const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] }
      if (!res.ok || body.errors?.length) throw new LinearError(res.ok ? 400 : res.status, `linear ${res.status}: ${(body.errors ?? []).map((e) => e.message).join('; ').slice(0, 200) || res.statusText}`)
      return body.data as T
    }
  }
  async function paged<T>(field: 'issues' | 'comments', selection: string, filter: Record<string, unknown>): Promise<T[]> {
    const out: T[] = []
    let after: string | undefined
    const q = `query($filter: ${field === 'issues' ? 'IssueFilter' : 'CommentFilter'}, $after: String) { ${field}(filter: $filter, first: 100, after: $after) { nodes { ${selection} } pageInfo { hasNextPage endCursor } } }`
    for (;;) {
      const data = await gql<Record<string, { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor?: string } }>>(q, { filter, after })
      out.push(...data[field].nodes)
      if (!data[field].pageInfo.hasNextPage) break
      after = data[field].pageInfo.endCursor
    }
    return out
  }
  return {
    issues: (filter) => paged<LinearIssue>('issues', ISSUE_FIELDS, filter),
    comments: (filter) => paged<LinearComment>('comments', 'id body createdAt updatedAt url user { name } issue { identifier }', filter),
    async issuesWithComments(ids) {
      const out: LinearIssue[] = []
      for (const id of ids) {
        const data = await gql<{ issue: LinearIssue | null }>(
          `query($id: String!) { issue(id: $id) { id identifier description createdAt creator { name } comments(first: 100) { nodes { id body createdAt user { name } } } } }`,
          { id },
        ).catch((err) => {
          if (err instanceof LinearError && err.status < 500) return { issue: null }
          throw err
        })
        if (data.issue) out.push(data.issue)
      }
      return out
    },
  }
}

// ---- helpers ----

function iso(s: string | null | undefined): string {
  return s ? new Date(s).toISOString() : new Date(0).toISOString()
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? value : fallback
}
