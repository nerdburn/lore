// The board API (src/board/http.ts on the host). Same origin, cookie session.

export type Status = 'todo' | 'in_progress' | 'blocked' | 'done' | 'archived'
export type Priority = 'P1' | 'P2' | 'P3'
export type Role = 'member' | 'viewer'

export const STATUS_LABEL: Record<Status, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  archived: 'Archived',
}

export const BOARD_COLUMNS: Status[] = ['todo', 'in_progress', 'blocked', 'done']
/** Every status, in workflow order. */
export const WORK_ORDER: Status[] = ['todo', 'in_progress', 'blocked', 'done', 'archived']
export const PRIORITIES: Priority[] = ['P1', 'P2', 'P3']

export interface HistoryEntry {
  at: string
  by: string
  via: 'cli' | 'mcp' | 'web' | 'sync' | 'fold'
  change: Record<string, unknown>
  reason: string
  sources?: string[]
  confidence?: string
}

export interface ExternalRef {
  system: 'jira' | 'github'
  key: string
  url: string
  status: string
}

export interface Item {
  key: string
  title: string
  description?: string
  status: Status
  state: 'open' | 'closed'
  priority?: Priority
  assignee?: string
  labels: string[]
  request?: string
  external?: ExternalRef
  sources: string[]
  created: string
  updated: string
  last?: { at: string; by: string; via: string; reason: string }
  drift?: boolean
  history?: HistoryEntry[]
}

export interface ProjectSummary {
  context: string
  project: string
  client?: string
  prefix: string
  role: Role
  archived: boolean
  counts: Record<Status, number>
}

export interface Board {
  context: string
  project: string
  client?: string
  prefix: string
  role: Role
  archived: boolean
  labels: string[]
  assignees: string[]
  items: Item[]
}

export interface SourceState {
  source: string
  /** "ok" when healthy; "stale" / "never" / … otherwise. */
  state: string
  lastSuccess?: string
  staleHours?: number
  error?: string
}

export interface ClientStatus {
  name: string
  project?: string
  client?: string
  lifecycle?: string
  sources: string[]
  lastSync?: string
  lastExtract?: string
  health: Record<string, { lastSuccess?: string; lastError?: string }>
  sourceStates: SourceState[]
  lastCommit?: string
  error?: string
}

export interface HostStatus {
  generated: string
  clients: ClientStatus[]
  sessions: { agent: string; context: string; idleMs: number }[]
  /** The onboarding playbook, rendered to HTML on the host. */
  playbook: string
}

export interface Me {
  email: string
  admin: boolean
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/board${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!res.ok) throw new ApiError(res.status, typeof data.error === 'string' ? data.error : `request failed (${res.status})`)
  return data as T
}

const enc = encodeURIComponent

export const api = {
  me: () => call<Me>('/me'),
  login: (email: string) => call<{ ok: true }>('/login', { body: { email } }),
  verify: (email: string, code: string) => call<Me>('/verify', { body: { email, code } }),
  logout: () => call<{ ok: true }>('/logout', { body: {} }),
  projects: () => call<{ projects: ProjectSummary[] }>('/projects'),
  host: () => call<HostStatus>('/host'),
  board: (context: string) => call<Board>(`/p/${enc(context)}`),
  item: (context: string, key: string) => call<{ item: Item }>(`/p/${enc(context)}/items/${enc(key)}`),
  add: (context: string, fields: Partial<Pick<Item, 'title' | 'description' | 'status' | 'priority' | 'assignee' | 'labels'>>) =>
    call<{ item: Item }>(`/p/${enc(context)}/items`, { body: fields }),
  update: (context: string, key: string, fields: Partial<Pick<Item, 'title' | 'description' | 'priority' | 'assignee' | 'labels'>> & { note?: string }) =>
    call<{ item: Item }>(`/p/${enc(context)}/items/${enc(key)}`, { method: 'PATCH', body: fields }),
  move: (context: string, key: string, body: { status?: Status; above?: string; below?: string; note?: string }) =>
    call<{ item: Item }>(`/p/${enc(context)}/items/${enc(key)}/move`, { body }),
}
