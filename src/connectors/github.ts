import { parse as parseYamlList, stringify } from 'yaml'
import type { Connector, ConnectorContext, Cursor, Doc } from '../types.js'

/**
 * GitHub connector (backlog §9, §10).
 *
 * Per configured repo, deterministic and incremental via the REST API:
 * issues + pull requests, issue comments, PR reviews + review comments,
 * commits on the default branch, releases. Two kinds of output:
 *
 * - Stream docs (append-only events): an issue/PR when first seen and again
 *   whenever its delivery state changes (state, labels, assignees,
 *   milestone, merged); every comment, review, commit, release once.
 * - A source-owned work table, context/work/github/<owner>__<repo>.yaml:
 *   the current issue/PR list. GitHub is authoritative for it — sync
 *   overwrites it, the LLM never edits it. `recall work` reads it.
 *
 * Cursor per repo: { since, fingerprints }. `since` is the last successful
 * fetch time; every sync re-reads `overlap_days` (default 1) before it and
 * stream dedup absorbs the repeats. `fingerprints` (number → hash of the
 * delivery fields) is how a state change is detected without a timeline
 * call per issue.
 *
 * Auth: a fine-grained token or GitHub App installation token with
 * Contents:read, Issues:read, Pull requests:read, Metadata:read on the
 * configured repos. Rate-limit aware: waits out primary and secondary
 * limits. A 404 on a repo is a reported error (token lacks access, or the
 * name is wrong); a 401 fails the source.
 */

interface RepoCursor {
  since: string
  fingerprints: Record<string, string>
}
type GithubCursor = Record<string, RepoCursor>

const API = 'https://api.github.com'
const DEFAULT_OVERLAP_DAYS = 1
const DAY_MS = 86_400_000
const ALL_KINDS = ['issues', 'comments', 'reviews', 'commits', 'releases'] as const
type Kind = (typeof ALL_KINDS)[number]

export interface WorkItem {
  number: number
  type: 'issue' | 'pr'
  title: string
  state: 'open' | 'closed'
  /** PRs only. */
  merged?: boolean
  draft?: boolean
  labels: string[]
  assignees: string[]
  milestone?: string
  author: string
  created_at: string
  updated_at: string
  closed_at?: string
  url: string
}

export const github: Connector = {
  name: 'github',

  async fetch(ctx: ConnectorContext) {
    const token = ctx.config.token as string | undefined
    const apiBase = ((ctx.config.api_base as string | undefined) ?? API).replace(/\/$/, '')
    const repos = (ctx.config.repos as string[]) ?? []
    // An explicit api_base is a deliberate choice (a proxy that injects the
    // token, or the public API for public repos); only a bare config is an error.
    if (!token && ctx.config.api_base === undefined) throw new Error('github: no token resolved (set token, or api_base to a proxy that injects one)')
    if (repos.length === 0) throw new Error('github: no repos configured')
    const kinds = new Set<Kind>((ctx.config.include as Kind[] | undefined) ?? ALL_KINDS)
    const overlapMs = numberOr(ctx.config.overlap_days, DEFAULT_OVERLAP_DAYS) * DAY_MS

    const api = githubClient(apiBase, token)
    const cursor = { ...(ctx.cursor as GithubCursor) }
    const docs: Doc[] = []
    const errors: string[] = []
    const files: Record<string, string> = {}

    for (const repo of repos) {
      const prev = cursor[repo]
      const sinceMs = prev ? Math.max(new Date(prev.since).getTime() - overlapMs, ctx.since) : ctx.since
      const since = new Date(sinceMs).toISOString()
      const startedAt = new Date().toISOString()
      const fingerprints = { ...(prev?.fingerprints ?? {}) }
      const workPath = `context/work/github/${repo.replace('/', '__')}.yaml`
      const table = new Map<number, WorkItem>()
      for (const item of readWorkTable(ctx.readFile(workPath))) table.set(item.number, item)

      try {
        // Issues + PRs updated in the window. On the first sync also seed the
        // work table with every open item, however old.
        if (kinds.has('issues')) {
          const updated = await api.paginate<GhIssue>(`/repos/${repo}/issues`, {
            state: 'all', sort: 'updated', direction: 'asc', since, per_page: '100',
          })
          const seed = prev ? [] : await api.paginate<GhIssue>(`/repos/${repo}/issues`, { state: 'open', per_page: '100' })
          const seen = new Set<number>()
          for (const issue of [...seed, ...updated]) {
            table.set(issue.number, toWorkItem(issue))
            if (seen.has(issue.number)) continue
            seen.add(issue.number)
            const fp = fingerprint(issue)
            const key = String(issue.number)
            if (fingerprints[key] === fp) continue
            docs.push(fingerprints[key] ? stateChangeDoc(repo, issue) : openedDoc(repo, issue))
            fingerprints[key] = fp
          }
          // Reviews only for PRs touched in the window.
          if (kinds.has('reviews')) {
            for (const pr of updated.filter((i) => i.pull_request)) {
              const reviews = await api.paginate<GhReview>(`/repos/${repo}/pulls/${pr.number}/reviews`, { per_page: '100' })
              for (const r of reviews) {
                if (!r.submitted_at || r.submitted_at < since) continue
                if (r.state === 'COMMENTED' && !r.body) continue
                docs.push(reviewDoc(repo, pr, r))
              }
            }
          }
        }

        if (kinds.has('comments')) {
          const comments = await api.paginate<GhComment>(`/repos/${repo}/issues/comments`, {
            since, sort: 'updated', direction: 'asc', per_page: '100',
          })
          for (const c of comments) if (c.created_at >= since) docs.push(commentDoc(repo, c, 'comment'))
        }
        if (kinds.has('reviews')) {
          const rc = await api.paginate<GhComment>(`/repos/${repo}/pulls/comments`, {
            since, sort: 'updated', direction: 'asc', per_page: '100',
          })
          for (const c of rc) if (c.created_at >= since) docs.push(commentDoc(repo, c, 'review-comment'))
        }
        if (kinds.has('commits')) {
          const commits = await api.paginate<GhCommit>(`/repos/${repo}/commits`, { since, per_page: '100' })
          for (const c of commits) docs.push(commitDoc(repo, c))
        }
        if (kinds.has('releases')) {
          const releases = await api.get<GhRelease[]>(`/repos/${repo}/releases`, { per_page: '100' })
          for (const r of releases) if (r.published_at && r.published_at >= since) docs.push(releaseDoc(repo, r))
        }

        files[workPath] = renderWorkTable(repo, [...table.values()])
        cursor[repo] = { since: startedAt, fingerprints }
        ctx.log(`github: ${repo} → ${docs.length} docs so far, ${table.size} work items`)
      } catch (err) {
        if (err instanceof GithubError && err.status === 404) {
          errors.push(`repo ${repo} not found or token lacks access — check the name and the token's repository access`)
          continue
        }
        throw err
      }
    }

    return { docs, nextCursor: cursor, files, ...(errors.length ? { errors } : {}) }
  },
}

// ---- docs ----

function channel(repo: string): string {
  return repo
}

function baseMeta(repo: string, extra: Record<string, string | number | undefined>): Record<string, string> {
  const meta: Record<string, string> = { repo }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') meta[k] = String(v)
  return meta
}

function kindOf(issue: GhIssue): 'issue' | 'pr' {
  return issue.pull_request ? 'pr' : 'issue'
}

function statusLine(issue: GhIssue): string {
  const parts: string[] = []
  if (issue.pull_request?.merged_at) parts.push('merged')
  else parts.push(issue.state)
  if (issue.draft) parts.push('draft')
  const bits = [parts.join(', ')]
  if (issue.labels.length) bits.push(`labels: ${issue.labels.map((l) => l.name).join(', ')}`)
  if (issue.assignees.length) bits.push(`assignees: ${issue.assignees.map((a) => a.login).join(', ')}`)
  if (issue.milestone) bits.push(`milestone: ${issue.milestone.title}`)
  return bits.join(' · ')
}

function openedDoc(repo: string, issue: GhIssue): Doc {
  const kind = kindOf(issue)
  return {
    id: `github-${repo}-${kind}-${issue.number}`,
    source: 'github',
    channel: channel(repo),
    author: issue.user?.login ?? 'unknown',
    timestamp: issue.created_at,
    permalink: issue.html_url,
    meta: baseMeta(repo, { number: issue.number, node: issue.node_id, type: kind, state: issue.state, login: issue.user?.login, user_id: issue.user?.id }),
    text: `**${kind === 'pr' ? 'PR' : 'Issue'} #${issue.number}: ${issue.title}** (${statusLine(issue)})\n\n${issue.body?.trim() || '(no description)'}`,
  }
}

function stateChangeDoc(repo: string, issue: GhIssue): Doc {
  const kind = kindOf(issue)
  return {
    id: `github-${repo}-${kind}-${issue.number}@${issue.updated_at}`,
    source: 'github',
    channel: channel(repo),
    author: 'github',
    timestamp: issue.updated_at,
    permalink: issue.html_url,
    thread: `${kind}-${issue.number}`,
    meta: baseMeta(repo, { number: issue.number, node: issue.node_id, type: kind, state: issue.state }),
    text: `${kind === 'pr' ? 'PR' : 'Issue'} #${issue.number} "${issue.title}" is now: ${statusLine(issue)}`,
  }
}

function commentDoc(repo: string, c: GhComment, kind: 'comment' | 'review-comment'): Doc {
  const number = Number(/\/(\d+)$/.exec(c.issue_url ?? c.pull_request_url ?? '')?.[1])
  const parent = kind === 'review-comment' ? `pr-${number}` : `issue-${number}`
  return {
    id: `github-${repo}-${kind}-${c.id}`,
    source: 'github',
    channel: channel(repo),
    author: c.user?.login ?? 'unknown',
    timestamp: c.created_at,
    permalink: c.html_url,
    thread: Number.isFinite(number) ? parent : undefined,
    meta: baseMeta(repo, { number, node: c.node_id, login: c.user?.login, user_id: c.user?.id, edited: c.updated_at !== c.created_at ? c.updated_at : undefined }),
    text: (kind === 'review-comment' && c.path ? `\`${c.path}\`: ` : '') + (c.body?.trim() ?? ''),
  }
}

function reviewDoc(repo: string, pr: GhIssue, r: GhReview): Doc {
  return {
    id: `github-${repo}-review-${r.id}`,
    source: 'github',
    channel: channel(repo),
    author: r.user?.login ?? 'unknown',
    timestamp: r.submitted_at!,
    permalink: r.html_url,
    thread: `pr-${pr.number}`,
    meta: baseMeta(repo, { number: pr.number, node: r.node_id, state: r.state, login: r.user?.login, user_id: r.user?.id }),
    text: `Review on PR #${pr.number}: ${r.state.toLowerCase().replace('_', ' ')}${r.body?.trim() ? `\n\n${r.body.trim()}` : ''}`,
  }
}

function commitDoc(repo: string, c: GhCommit): Doc {
  return {
    id: `github-${repo}-commit-${c.sha.slice(0, 12)}`,
    source: 'github',
    channel: channel(repo),
    author: c.author?.login ?? c.commit.author?.name ?? 'unknown',
    timestamp: c.commit.committer?.date ?? c.commit.author?.date ?? new Date().toISOString(),
    permalink: c.html_url,
    meta: baseMeta(repo, { sha: c.sha, login: c.author?.login, user_id: c.author?.id }),
    text: `Commit ${c.sha.slice(0, 7)}: ${c.commit.message.trim()}`,
  }
}

function releaseDoc(repo: string, r: GhRelease): Doc {
  return {
    id: `github-${repo}-release-${r.id}`,
    source: 'github',
    channel: channel(repo),
    author: r.author?.login ?? 'unknown',
    timestamp: r.published_at!,
    permalink: r.html_url,
    meta: baseMeta(repo, { node: r.node_id, tag: r.tag_name, prerelease: r.prerelease ? 'true' : undefined }),
    text: `Release ${r.tag_name}${r.name && r.name !== r.tag_name ? ` — ${r.name}` : ''}${r.body?.trim() ? `\n\n${r.body.trim()}` : ''}`,
  }
}

// ---- work table ----

function toWorkItem(issue: GhIssue): WorkItem {
  const item: WorkItem = {
    number: issue.number,
    type: kindOf(issue),
    title: issue.title,
    state: issue.state,
    labels: issue.labels.map((l) => l.name).sort(),
    assignees: issue.assignees.map((a) => a.login).sort(),
    author: issue.user?.login ?? 'unknown',
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    url: issue.html_url,
  }
  if (issue.pull_request) {
    item.merged = Boolean(issue.pull_request.merged_at)
    if (issue.draft) item.draft = true
  }
  if (issue.milestone) item.milestone = issue.milestone.title
  if (issue.closed_at) item.closed_at = issue.closed_at
  return item
}

/** The delivery fields whose change is worth a stream event. */
function fingerprint(issue: GhIssue): string {
  return JSON.stringify([
    issue.state,
    issue.title,
    issue.draft ?? false,
    issue.pull_request?.merged_at ?? null,
    issue.labels.map((l) => l.name).sort(),
    issue.assignees.map((a) => a.login).sort(),
    issue.milestone?.title ?? null,
  ])
}

export function readWorkTable(text: string | undefined): WorkItem[] {
  if (!text) return []
  const body = text.replace(/^(#.*\n)+/, '')
  try {
    const parsed = parseYamlList(body)
    return Array.isArray(parsed) ? (parsed as WorkItem[]) : []
  } catch {
    return []
  }
}

function renderWorkTable(repo: string, items: WorkItem[]): string {
  const open = items.filter((i) => i.state === 'open').sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const closed = items.filter((i) => i.state !== 'open').sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return (
    `# Source-owned by GitHub (${repo}) — written by \`lore sync\`, authoritative for issue/PR state.\n` +
    `# Never hand-edit or LLM-edit; open items first, then closed, newest activity first.\n` +
    stringify([...open, ...closed])
  )
}

// ---- API client ----

class GithubError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

interface Api {
  get<T>(path: string, params: Record<string, string>): Promise<T>
  paginate<T>(path: string, params: Record<string, string>): Promise<T[]>
}

function githubClient(apiBase: string, token: string | undefined): Api {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'lore',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  async function request(url: string): Promise<Response> {
    for (;;) {
      const res = await fetch(url, { headers })
      if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
        const retryAfter = Number(res.headers.get('retry-after'))
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.max(reset - Date.now(), 1000)
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 15 * 60_000)))
        continue
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200)
        throw new GithubError(res.status, `github ${res.status} ${new URL(url).pathname}: ${body}`)
      }
      return res
    }
  }
  return {
    async get<T>(path: string, params: Record<string, string>) {
      const res = await request(`${apiBase}${path}?${new URLSearchParams(params)}`)
      return (await res.json()) as T
    },
    async paginate<T>(path: string, params: Record<string, string>) {
      const out: T[] = []
      let url: string | undefined = `${apiBase}${path}?${new URLSearchParams(params)}`
      while (url) {
        const res = await request(url)
        out.push(...((await res.json()) as T[]))
        url = nextPage(nextLink(res.headers.get('link')), `${apiBase}${path}`)
      }
      return out
    },
  }
}

/**
 * Next-page URL for a paginated request. GitHub's Link header points at
 * api.github.com and often at the id form (/repositories/<id>/issues), which
 * a proxy (exe.dev's GitHub integration, an http-proxy) either can't reach
 * or refuses. Only the query string carries pagination state, so keep our
 * own base + path and adopt the link's query.
 */
export function nextPage(link: string | undefined, base: string): string | undefined {
  if (!link) return undefined
  try {
    return `${base}${new URL(link).search}`
  } catch {
    return undefined
  }
}

export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim())
    if (m) return m[1]
  }
  return undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? value : fallback
}

// ---- API shapes (only the fields used) ----

interface GhUser {
  login: string
  id: number
}
interface GhIssue {
  number: number
  node_id: string
  title: string
  body?: string | null
  state: 'open' | 'closed'
  draft?: boolean
  user?: GhUser
  labels: { name: string }[]
  assignees: GhUser[]
  milestone?: { title: string } | null
  created_at: string
  updated_at: string
  closed_at?: string | null
  html_url: string
  pull_request?: { merged_at?: string | null }
}
interface GhComment {
  id: number
  node_id: string
  user?: GhUser
  body?: string
  created_at: string
  updated_at: string
  html_url: string
  issue_url?: string
  pull_request_url?: string
  path?: string
}
interface GhReview {
  id: number
  node_id: string
  user?: GhUser
  body?: string
  state: string
  submitted_at?: string
  html_url: string
}
interface GhCommit {
  sha: string
  html_url: string
  author?: GhUser | null
  commit: { message: string; author?: { name: string; date: string }; committer?: { date: string } }
}
interface GhRelease {
  id: number
  node_id: string
  tag_name: string
  name?: string | null
  body?: string | null
  prerelease: boolean
  published_at?: string | null
  html_url: string
  author?: GhUser
}
