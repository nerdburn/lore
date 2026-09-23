import { parse as parseYaml, stringify } from 'yaml'
import type { Connector, ConnectorContext, Doc } from '../types.js'

/**
 * Jira Cloud connector (backlog §10/§11 — Jira as the canonical tracker).
 *
 * Per configured scope — a project key, or a board (Jira Agile board id,
 * resolved to its saved filter's JQL, for workspaces that run many clients
 * as boards in one big project) — deterministic and incremental via the REST
 * v3 API (`/search/jql`, `/issue/{key}/comment`). Two kinds of output, like
 * GitHub:
 *
 * - Stream docs (append-only events): an issue when first seen and again
 *   whenever its delivery state changes (status, assignee, priority,
 *   summary, resolution, labels, fix versions); every comment once.
 *   Descriptions and comments arrive as Atlassian Document Format and are
 *   rendered to markdown.
 * - A source-owned work table, context/work/jira/<PROJECT>.yaml — the current
 *   issue list with Jira's own status and status category (`state: open` =
 *   status category not Done). Seeded with every unresolved issue on the
 *   first sync; `recall` reads it as authoritative.
 *
 * Auth: Jira Cloud API tokens are HTTP Basic (email:token) — set `email` and
 * `token` as env refs, or point `api_base` at a proxy that injects the
 * header. `site` (https://x.atlassian.net) is needed for permalinks when the
 * API is reached through a proxy; otherwise it is derived from the API base.
 */

interface ProjectCursor {
  since: string
  fingerprints: Record<string, string>
}
type JiraCursor = Record<string, ProjectCursor>

const DEFAULT_OVERLAP_DAYS = 1
const DAY_MS = 86_400_000
const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'created', 'updated', 'resolutiondate', 'labels', 'fixVersions', 'parent', 'description']

export interface JiraWorkItem {
  key: string
  type: string
  title: string
  /** Jira's status name, e.g. "In Review". */
  status: string
  /** "To Do" | "In Progress" | "Done" — Jira's status category. */
  category: string
  /** open unless the status category is Done — what recall counts. */
  state: 'open' | 'closed'
  priority?: string
  assignee?: string
  reporter?: string
  labels: string[]
  fix_versions: string[]
  parent?: string
  created: string
  updated: string
  resolved?: string
  /** The sprint the issue is in now (active, else the next future one) — Jira's planning, mirrored as evidence; lore's own tickets carry no sprints. */
  sprint?: string
  sprint_state?: 'active' | 'future'
  url: string
}

export const jira: Connector = {
  name: 'jira',

  async fetch(ctx: ConnectorContext) {
    const email = ctx.config.email as string | undefined
    const token = ctx.config.token as string | undefined
    const site = ((ctx.config.site as string | undefined) ?? '').replace(/\/$/, '')
    const apiBase = ((ctx.config.api_base as string | undefined) ?? (site ? `${site}/rest/api/3` : '')).replace(/\/$/, '')
    if (!apiBase) throw new Error('jira: set site (https://x.atlassian.net) or api_base')
    if (!(email && token) && ctx.config.api_base === undefined) throw new Error('jira: no credentials (set email + token, or api_base to a proxy that injects them)')
    const projects = (ctx.config.projects as string[] | undefined) ?? []
    const boards = (ctx.config.boards as number[] | undefined) ?? []
    if (projects.length === 0 && boards.length === 0) throw new Error('jira: no projects or boards configured')
    const includeComments = !((ctx.config.include as string[] | undefined)?.length) || (ctx.config.include as string[]).includes('comments')
    const overlapMs = numberOr(ctx.config.overlap_days, DEFAULT_OVERLAP_DAYS) * DAY_MS

    const api: JiraApi = jiraClient(apiBase, email && token ? { email, token } : undefined)
    // Sites without Jira Software have no Sprint field; that just means no sprints.
    const sprintField = await api.sprintField().catch(() => undefined)
    const extraFields = sprintField ? [sprintField] : []
    const cursor = { ...(ctx.cursor as JiraCursor) }
    const docs: Doc[] = []
    const errors: string[] = []
    const files: Record<string, string> = {}
    let browseBase = site

    // Scopes: projects as-is; boards resolved to their saved filter's JQL.
    const scopes: { name: string; channel: string; jql: string }[] = projects.map((p) => ({ name: p, channel: p, jql: `project = "${p}"` }))
    for (const id of boards) {
      try {
        const b = await api.board(id)
        scopes.push({ name: `board-${id}`, channel: b.name, jql: `(${b.jql})` })
      } catch (err) {
        errors.push(`board ${id}: ${err instanceof Error ? err.message : err} — check the id and that the account can see the board`)
      }
    }

    for (const scope of scopes) {
      const project = scope.name
      const prev = cursor[project]
      const sinceMs = prev ? Math.max(new Date(prev.since).getTime() - overlapMs, ctx.since) : ctx.since
      const sinceJql = jqlDate(sinceMs)
      const startedAt = new Date().toISOString()
      const fingerprints = { ...(prev?.fingerprints ?? {}) }
      const workPath = `context/work/jira/${project}.yaml`
      const table = new Map<string, JiraWorkItem>()
      for (const item of readWorkTable(ctx.readFile(workPath))) table.set(item.key, item)

      try {
        const updated = await api.search(`${scope.jql} AND updated >= "${sinceJql}" ORDER BY updated ASC`, extraFields)
        const seed = prev ? [] : await api.search(`${scope.jql} AND statusCategory != Done ORDER BY created ASC`, extraFields)
        if (!browseBase && (updated[0] ?? seed[0])?.self) browseBase = new URL((updated[0] ?? seed[0]).self).origin
        const seen = new Set<string>()
        for (const issue of [...seed, ...updated]) {
          const item = toWorkItem(issue, browseBase, sprintField)
          table.set(issue.key, item)
          if (seen.has(issue.key)) continue
          seen.add(issue.key)
          const fp = fingerprint(issue, item)
          if (fingerprints[issue.key] === fp) continue
          if (sameBeforeSprints(fingerprints[issue.key], fp)) {
            // A fingerprint from before sprints were tracked: upgrade it
            // quietly rather than emit a "changed" doc for every issue in a sprint.
            fingerprints[issue.key] = fp
            continue
          }
          docs.push(fingerprints[issue.key] ? stateChangeDoc(scope.channel, issue, item) : openedDoc(scope.channel, issue, item))
          fingerprints[issue.key] = fp
        }
        if (includeComments) {
          for (const issue of updated) {
            const comments = await api.comments(issue.key)
            for (const c of comments) {
              if (new Date(c.created).getTime() < sinceMs) continue
              docs.push(commentDoc(scope.channel, issue, c, browseBase))
            }
          }
        }
        files[workPath] = renderWorkTable(scope.channel === project ? project : `${scope.channel} (${project})`, [...table.values()])
        cursor[project] = { since: startedAt, fingerprints }
        ctx.log(`jira: ${scope.channel} → ${docs.length} docs so far, ${table.size} work items`)
      } catch (err) {
        if (err instanceof JiraError && (err.status === 400 || err.status === 404)) {
          errors.push(`${project}: ${err.message} — check the key/board and the account's project access`)
          continue
        }
        throw err
      }
    }
    return { docs, nextCursor: cursor, files, ...(errors.length ? { errors } : {}) }
  },
}

// ---- docs ----

function person(u: JiraUser | null | undefined): string | undefined {
  return u?.displayName ?? u?.emailAddress ?? undefined
}

function statusLine(item: JiraWorkItem): string {
  const bits = [`${item.status}`]
  if (item.priority) bits.push(`priority: ${item.priority}`)
  if (item.assignee) bits.push(`assignee: ${item.assignee}`)
  if (item.labels.length) bits.push(`labels: ${item.labels.join(', ')}`)
  if (item.fix_versions.length) bits.push(`fix: ${item.fix_versions.join(', ')}`)
  if (item.sprint) bits.push(`sprint: ${item.sprint}${item.sprint_state === 'future' ? ' (planned)' : ''}`)
  return bits.join(' · ')
}

function baseMeta(scope: string, issue: JiraIssue, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const meta: Record<string, string> = { project: issue.key.replace(/-\d+$/, ''), scope: scope.replace(/\s+/g, '_'), key: issue.key, issue_id: issue.id }
  for (const [k, v] of Object.entries(extra)) if (v) meta[k] = v
  return meta
}

function openedDoc(project: string, issue: JiraIssue, item: JiraWorkItem): Doc {
  const f = issue.fields
  return {
    id: `jira-${issue.key}`,
    source: 'jira',
    channel: project,
    author: person(f.reporter) ?? 'unknown',
    timestamp: iso(f.created),
    permalink: item.url,
    meta: baseMeta(project, issue, { type: item.type, status: item.status, account: f.reporter?.accountId }),
    text: `**${item.type} ${issue.key}: ${item.title}** (${statusLine(item)})\n\n${adfToMarkdown(f.description).trim() || '(no description)'}`,
  }
}

function stateChangeDoc(project: string, issue: JiraIssue, item: JiraWorkItem): Doc {
  return {
    id: `jira-${issue.key}@${iso(issue.fields.updated)}`,
    source: 'jira',
    channel: project,
    author: 'jira',
    timestamp: iso(issue.fields.updated),
    permalink: item.url,
    thread: issue.key,
    meta: baseMeta(project, issue, { type: item.type, status: item.status }),
    text: `${item.type} ${issue.key} "${item.title}" is now: ${statusLine(item)}`,
  }
}

function commentDoc(project: string, issue: JiraIssue, c: JiraComment, browseBase: string): Doc {
  return {
    id: `jira-${issue.key}-comment-${c.id}`,
    source: 'jira',
    channel: project,
    author: person(c.author) ?? 'unknown',
    timestamp: iso(c.created),
    permalink: `${browseBase}/browse/${issue.key}?focusedCommentId=${c.id}`,
    thread: issue.key,
    meta: baseMeta(project, issue, { comment: c.id, account: c.author?.accountId, edited: c.updated && c.updated !== c.created ? iso(c.updated) : undefined }),
    text: adfToMarkdown(c.body).trim(),
  }
}

// ---- work table ----

function toWorkItem(issue: JiraIssue, browseBase: string, sprintField?: string): JiraWorkItem {
  const f = issue.fields
  const category = f.status?.statusCategory?.name ?? 'To Do'
  const item: JiraWorkItem = {
    key: issue.key,
    type: f.issuetype?.name ?? 'Issue',
    title: f.summary ?? '',
    status: f.status?.name ?? 'Unknown',
    category,
    state: category === 'Done' ? 'closed' : 'open',
    labels: [...(f.labels ?? [])].sort(),
    fix_versions: (f.fixVersions ?? []).map((v) => v.name).sort(),
    created: iso(f.created),
    updated: iso(f.updated),
    url: `${browseBase}/browse/${issue.key}`,
  }
  if (f.priority?.name) item.priority = f.priority.name
  const a = person(f.assignee)
  if (a) item.assignee = a
  const r = person(f.reporter)
  if (r) item.reporter = r
  if (f.parent?.key) item.parent = f.parent.key
  if (f.resolutiondate) item.resolved = iso(f.resolutiondate)
  const sprint = sprintField ? currentSprint(f[sprintField as `customfield_${string}`]) : undefined
  if (sprint) {
    item.sprint = sprint.name
    item.sprint_state = sprint.state as 'active' | 'future'
  }
  return item
}

function fingerprint(issue: JiraIssue, item: Pick<JiraWorkItem, 'sprint'>): string {
  const f = issue.fields
  return JSON.stringify([
    f.status?.name,
    f.summary,
    f.priority?.name ?? null,
    f.assignee?.accountId ?? null,
    f.resolutiondate ?? null,
    [...(f.labels ?? [])].sort(),
    (f.fixVersions ?? []).map((v) => v.name).sort(),
    item.sprint ?? null,
  ])
}

/** Is `prev` a 7-field fingerprint (pre-sprint) that matches `next` on those fields? */
function sameBeforeSprints(prev: string | undefined, next: string): boolean {
  if (!prev) return false
  try {
    const a = JSON.parse(prev) as unknown[]
    const b = JSON.parse(next) as unknown[]
    return a.length === 7 && JSON.stringify(a) === JSON.stringify(b.slice(0, 7))
  } catch {
    return false
  }
}

export function readWorkTable(text: string | undefined): JiraWorkItem[] {
  if (!text) return []
  try {
    const parsed = parseYaml(text.replace(/^(#.*\n)+/, ''))
    return Array.isArray(parsed) ? (parsed as JiraWorkItem[]) : []
  } catch {
    return []
  }
}

function renderWorkTable(project: string, items: JiraWorkItem[]): string {
  const open = items.filter((i) => i.state === 'open').sort((a, b) => b.updated.localeCompare(a.updated))
  const closed = items.filter((i) => i.state !== 'open').sort((a, b) => b.updated.localeCompare(a.updated))
  return (
    `# Source-owned by Jira (${project}) — written by \`lore sync\`, authoritative for issue state.\n` +
    `# Never hand-edit or LLM-edit; open (status category ≠ Done) first, then done, newest activity first.\n` +
    stringify([...open, ...closed])
  )
}

// ---- ADF → markdown ----

export interface AdfNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  content?: AdfNode[]
}

export function adfToMarkdown(doc: AdfNode | string | null | undefined): string {
  if (!doc) return ''
  if (typeof doc === 'string') return doc
  return renderNodes(doc.content ?? [], '').replace(/\n{3,}/g, '\n\n')
}

function renderNodes(nodes: AdfNode[], indent: string): string {
  return nodes.map((n) => renderNode(n, indent)).join('')
}

function inlineText(nodes: AdfNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      switch (n.type) {
        case 'text': {
          let s = n.text ?? ''
          for (const m of n.marks ?? []) {
            if (m.type === 'code') s = `\`${s}\``
            else if (m.type === 'strong') s = `**${s}**`
            else if (m.type === 'em') s = `*${s}*`
            else if (m.type === 'strike') s = `~~${s}~~`
            else if (m.type === 'link') s = `[${s}](${String(m.attrs?.href ?? '')})`
          }
          return s
        }
        case 'mention':
          return `@${String(n.attrs?.text ?? n.attrs?.id ?? 'someone').replace(/^@/, '')}`
        case 'emoji':
          return String(n.attrs?.text ?? n.attrs?.shortName ?? '')
        case 'hardBreak':
          return '\n'
        case 'inlineCard':
          return String(n.attrs?.url ?? '')
        case 'date':
          return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : ''
        case 'status':
          return `[${String(n.attrs?.text ?? '')}]`
        default:
          return inlineText(n.content)
      }
    })
    .join('')
}

function renderNode(n: AdfNode, indent: string): string {
  switch (n.type) {
    case 'paragraph':
      return `${indent}${inlineText(n.content)}\n\n`
    case 'heading':
      return `${indent}${'#'.repeat(Math.min(6, Number(n.attrs?.level ?? 1)))} ${inlineText(n.content)}\n\n`
    case 'bulletList':
      return (n.content ?? []).map((li) => renderListItem(li, indent, '- ')).join('') + '\n'
    case 'orderedList':
      return (n.content ?? []).map((li) => renderListItem(li, indent, '1. ')).join('') + '\n'
    case 'taskList':
      return (n.content ?? []).map((t) => `${indent}- [${t.attrs?.state === 'DONE' ? 'x' : ' '}] ${inlineText(t.content)}\n`).join('') + '\n'
    case 'codeBlock':
      return `${indent}\`\`\`${String(n.attrs?.language ?? '')}\n${inlineText(n.content)}\n${indent}\`\`\`\n\n`
    case 'blockquote':
    case 'panel':
      return renderNodes(n.content ?? [], indent)
        .trim()
        .split('\n')
        .map((l) => `${indent}> ${l}`)
        .join('\n') + '\n\n'
    case 'rule':
      return `${indent}---\n\n`
    case 'table':
      return (n.content ?? []).map((row) => `${indent}| ${(row.content ?? []).map((cell) => renderNodes(cell.content ?? [], '').trim().replace(/\n+/g, ' ')).join(' | ')} |\n`).join('') + '\n'
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return `${indent}[attachment]\n\n`
    case 'expand':
    case 'nestedExpand':
      return `${indent}**${String(n.attrs?.title ?? '')}**\n\n${renderNodes(n.content ?? [], indent)}`
    default:
      return n.content ? renderNodes(n.content, indent) : inlineText([n]) ? `${indent}${inlineText([n])}\n\n` : ''
  }
}

function renderListItem(li: AdfNode, indent: string, bullet: string): string {
  const [first, ...rest] = li.content ?? []
  const head = first?.type === 'paragraph' ? inlineText(first.content) : ''
  const tail = renderNodes(first?.type === 'paragraph' ? rest : li.content ?? [], indent + '  ')
  return `${indent}${bullet}${head}\n${tail}`
}

// ---- helpers ----

function iso(s: string | undefined): string {
  return s ? new Date(s).toISOString() : new Date(0).toISOString()
}

/** A saved filter's JQL usually ends in ORDER BY; that must go before we AND more conditions onto it. */
export function stripOrderBy(jql: string): string {
  return jql.replace(/\s+ORDER\s+BY\s[\s\S]*$/i, '').trim()
}

/** Jira JQL wants "yyyy-MM-dd HH:mm" in the account's timezone; UTC is what the API uses for `updated`. */
export function jqlDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? value : fallback
}

// ---- API client ----

export class JiraError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export interface JiraTransition {
  id: string
  name: string
  to: { name: string; statusCategory: { key: 'new' | 'indeterminate' | 'done'; name?: string } }
}

export interface JiraCreateField {
  fieldId: string
  name: string
  required?: boolean
  allowedValues?: { id?: string; value?: string; name?: string; key?: string }[]
}

export interface JiraApi {
  /** `extraFields`: custom fields to fetch as well, e.g. the Sprint field. */
  search(jql: string, extraFields?: string[]): Promise<JiraIssue[]>
  comments(key: string): Promise<JiraComment[]>
  /** Board name + the JQL of its saved filter (Jira Agile API). */
  board(id: number): Promise<{ name: string; jql: string }>
  /** Workflow transitions available from the issue's current status. */
  transitions(key: string): Promise<JiraTransition[]>
  transition(key: string, id: string): Promise<void>
  /** Issue types a project accepts (create-meta). */
  issueTypes(projectKey: string): Promise<{ id: string; name: string; subtask?: boolean }[]>
  /** The fields (with allowed values) the create screen has for one issue type. */
  createFields(projectKey: string, issueTypeId: string): Promise<JiraCreateField[]>
  createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }>
  /** The id of the site's Sprint custom field (e.g. customfield_10020), if the site has Jira Software. */
  sprintField(): Promise<string | undefined>
  /** Board metadata — `type` is scrum | kanban | simple; only scrum boards have sprints. */
  boardInfo(id: number): Promise<JiraBoard>
  /** Boards that show a project's issues. */
  projectBoards(projectKey: string): Promise<JiraBoard[]>
  /** A board's open sprints, active first then future in start order. */
  openSprints(boardId: number): Promise<JiraSprint[]>
  /** The open (active or future) sprint an issue is in, if any. */
  issueSprint(key: string): Promise<JiraSprint | undefined>
  /** Move issues into a sprint (out of the backlog or another open sprint). */
  addToSprint(sprintId: number, keys: string[]): Promise<void>
}

export interface JiraBoard {
  id: number
  name: string
  type: string
}

export interface JiraSprint {
  id: number
  name: string
  state: 'active' | 'future' | 'closed'
  startDate?: string
  originBoardId?: number
}

const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint'

/** A Sprint field value (the issue's sprints, closed ones included) → the one it is in now: active, else the earliest future. */
export function currentSprint(value: unknown): JiraSprint | undefined {
  if (!Array.isArray(value)) return undefined
  const open = (value as JiraSprint[]).filter((v) => v && typeof v.name === 'string' && (v.state === 'active' || v.state === 'future'))
  return open.find((v) => v.state === 'active') ?? open.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.id - b.id)[0]
}

/** Build a client from a resolved `sources.jira` config (env refs already resolved). */
export function jiraApiFromConfig(cfg: Record<string, unknown>): { api: JiraApi; site: string } {
  const email = cfg.email as string | undefined
  const token = cfg.token as string | undefined
  const site = ((cfg.site as string | undefined) ?? '').replace(/\/$/, '')
  const apiBase = ((cfg.api_base as string | undefined) ?? (site ? `${site}/rest/api/3` : '')).replace(/\/$/, '')
  if (!apiBase) throw new Error('jira: set site (https://x.atlassian.net) or api_base')
  if (!(email && token) && cfg.api_base === undefined) throw new Error('jira: no credentials (set email + token, or api_base to a proxy that injects them)')
  return { api: jiraClient(apiBase, email && token ? { email, token } : undefined), site }
}

export function jiraClient(apiBase: string, basic: { email: string; token: string } | undefined): JiraApi {
  const headers: Record<string, string> = { Accept: 'application/json', 'content-type': 'application/json' }
  if (basic) headers.Authorization = `Basic ${Buffer.from(`${basic.email}:${basic.token}`).toString('base64')}`
  async function request<T>(path: string, init: RequestInit = {}, base = apiBase): Promise<T> {
    for (;;) {
      const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } })
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? '5')
        await new Promise((r) => setTimeout(r, Math.min(wait, 120) * 1000))
        continue
      }
      if (!res.ok) throw new JiraError(res.status, `jira ${res.status} ${path.split('?')[0]}: ${(await res.text()).slice(0, 200)}`)
      if (res.status === 204) return undefined as T
      return (await res.json()) as T
    }
  }
  // The Agile API lives beside the REST API: /rest/api/3 → /rest/agile/1.0.
  const agileBase = apiBase.replace(/\/rest\/api\/\d+$/, '/rest/agile/1.0')
  let sprintFieldId: Promise<string | undefined> | undefined
  return {
    async board(id) {
      const b = await request<{ name?: string; filter?: { id: string } }>(`/board/${id}/configuration`, {}, agileBase)
      if (!b.filter?.id) throw new JiraError(404, `board ${id} has no saved filter`)
      const f = await request<{ jql?: string }>(`/filter/${b.filter.id}`)
      if (!f.jql) throw new JiraError(404, `filter ${b.filter.id} has no JQL`)
      return { name: b.name ?? `board-${id}`, jql: stripOrderBy(f.jql) }
    },
    async search(jql, extraFields = []) {
      const out: JiraIssue[] = []
      let nextPageToken: string | undefined
      do {
        const page = await request<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>('/search/jql', {
          method: 'POST',
          body: JSON.stringify({ jql, fields: [...FIELDS, ...extraFields], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }),
        })
        out.push(...(page.issues ?? []))
        nextPageToken = page.isLast === false ? page.nextPageToken : undefined
      } while (nextPageToken)
      return out
    },
    async transitions(key) {
      const r = await request<{ transitions?: JiraTransition[] }>(`/issue/${key}/transitions`)
      return r.transitions ?? []
    },
    async transition(key, id) {
      await request<unknown>(`/issue/${key}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id } }) })
    },
    async issueTypes(projectKey) {
      const r = await request<{ issueTypes?: { id: string; name: string; subtask?: boolean }[]; values?: { id: string; name: string; subtask?: boolean }[] }>(
        `/issue/createmeta/${projectKey}/issuetypes?maxResults=100`,
      )
      return r.issueTypes ?? r.values ?? []
    },
    async createFields(projectKey, issueTypeId) {
      const r = await request<{ fields?: JiraCreateField[]; values?: JiraCreateField[] }>(`/issue/createmeta/${projectKey}/issuetypes/${issueTypeId}?maxResults=200`)
      return r.fields ?? r.values ?? []
    },
    async createIssue(fields) {
      return request<{ id: string; key: string }>('/issue', { method: 'POST', body: JSON.stringify({ fields }) })
    },
    async sprintField() {
      sprintFieldId ??= request<{ id: string; schema?: { custom?: string } }[]>('/field').then(
        (fields) => fields.find((f) => f.schema?.custom === SPRINT_SCHEMA)?.id,
        () => undefined,
      )
      return sprintFieldId
    },
    async boardInfo(id) {
      const b = await request<{ id: number; name?: string; type?: string }>(`/board/${id}`, {}, agileBase)
      return { id: b.id, name: b.name ?? `board-${id}`, type: b.type ?? 'unknown' }
    },
    async projectBoards(projectKey) {
      const r = await request<{ values?: { id: number; name?: string; type?: string }[] }>(`/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`, {}, agileBase)
      return (r.values ?? []).map((b) => ({ id: b.id, name: b.name ?? `board-${b.id}`, type: b.type ?? 'unknown' }))
    },
    async openSprints(boardId) {
      const out: JiraSprint[] = []
      let startAt = 0
      for (;;) {
        const page = await request<{ values?: JiraSprint[]; isLast?: boolean }>(`/board/${boardId}/sprint?state=active,future&startAt=${startAt}&maxResults=50`, {}, agileBase)
        out.push(...(page.values ?? []))
        startAt += page.values?.length ?? 0
        if (page.isLast !== false || !page.values?.length) break
      }
      const rank = (s: JiraSprint) => (s.state === 'active' ? 0 : 1)
      return out.sort((a, b) => rank(a) - rank(b) || (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.id - b.id)
    },
    async issueSprint(key) {
      const r = await request<{ fields?: { sprint?: JiraSprint | null } }>(`/issue/${encodeURIComponent(key)}?fields=sprint`, {}, agileBase)
      const s = r.fields?.sprint
      return s && (s.state === 'active' || s.state === 'future') ? s : undefined
    },
    async addToSprint(sprintId, keys) {
      await request<unknown>(`/sprint/${sprintId}/issue`, { method: 'POST', body: JSON.stringify({ issues: keys }) }, agileBase)
    },
    async comments(key) {
      const out: JiraComment[] = []
      let startAt = 0
      for (;;) {
        const page = await request<{ comments: JiraComment[]; total: number; startAt: number; maxResults: number }>(`/issue/${key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`)
        out.push(...(page.comments ?? []))
        startAt = page.startAt + (page.comments?.length ?? 0)
        if (!page.comments?.length || startAt >= page.total) break
      }
      return out
    },
  }
}

// ---- API shapes (only what is used) ----

interface JiraUser {
  accountId?: string
  displayName?: string
  emailAddress?: string
}
export interface JiraIssue {
  id: string
  key: string
  self: string
  fields: {
    summary?: string
    description?: AdfNode | null
    status?: { name: string; statusCategory?: { name: string } }
    issuetype?: { name: string }
    priority?: { name: string } | null
    assignee?: JiraUser | null
    reporter?: JiraUser | null
    created?: string
    updated?: string
    resolutiondate?: string | null
    labels?: string[]
    fixVersions?: { name: string }[]
    parent?: { key: string } | null
    /** Custom fields asked for by id (the Sprint field). */
    [custom: `customfield_${string}`]: unknown
  }
}
export interface JiraComment {
  id: string
  author?: JiraUser
  body?: AdfNode | null
  created: string
  updated?: string
}
