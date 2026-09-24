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
  system: 'jira' | 'github' | 'linear'
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

export interface Attachment {
  sha256?: string
  ticket: string
  name: string
  type: string
  size?: number
  source: 'board' | 'jira' | 'github' | 'linear'
  source_id?: string
  source_url?: string
  by: string
  at: string
  skipped?: string
}

/** Select value for "nobody". */
export const UNASSIGNED = '__unassigned'

export interface Comment {
  id: string
  author: string
  at: string
  body: string
  source: 'board' | 'jira' | 'github' | 'linear'
  url?: string
}

export const SOURCE_NAME: Record<string, string> = { board: 'Board', jira: 'Jira', github: 'GitHub', linear: 'Linear' }

export interface OAuthRequest {
  client: string
  redirect: string
  context: string | null
  role: Role | null
  projects: { context: string; name: string; role: Role }[]
}

export interface Connection {
  id: string
  client_id: string
  client_name: string
  resource?: string
  created: string
  last_used: string
  expires: string
}

export interface Me {
  email: string
  admin: boolean
  name?: string | null
  avatar?: string | null
}

export interface Person {
  email: string
  name: string | null
  avatar: string | null
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
  people: () => call<{ people: Person[]; contacts: Record<string, string> }>('/people'),
  setName: (name: string) => call<{ name: string | null; avatar: string | null }>('/profile', { method: 'PATCH', body: { name } }),
  removeAvatar: () => call<{ name: string | null; avatar: string | null }>('/profile/avatar/remove', { body: {} }),
  async setAvatar(image: Blob): Promise<{ name: string | null; avatar: string | null }> {
    const res = await fetch('/api/board/profile/avatar', { method: 'POST', headers: { 'content-type': image.type }, body: image, credentials: 'same-origin' })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new ApiError(res.status, typeof data.error === 'string' ? data.error : `upload failed (${res.status})`)
    return data as { name: string | null; avatar: string | null }
  },
  avatarUrl: (sha: string) => `/api/board/avatars/${sha}`,
  oauthRequest: (id: string) => call<OAuthRequest>(`/oauth/request/${enc(id)}`),
  oauthDecide: (id: string, approve: boolean) => call<{ redirect: string }>(`/oauth/request/${enc(id)}`, { body: { approve } }),
  connections: () => call<{ connections: Connection[] }>('/oauth/connections'),
  revokeConnection: (id: string) => call<{ ok: true }>(`/oauth/connections/${enc(id)}/revoke`, { body: {} }),
  board: (context: string) => call<Board>(`/p/${enc(context)}`),
  item: (context: string, key: string) => call<{ item: Item }>(`/p/${enc(context)}/items/${enc(key)}`),
  add: (context: string, fields: Partial<Pick<Item, 'title' | 'description' | 'status' | 'priority' | 'assignee' | 'labels'>>) =>
    call<{ item: Item }>(`/p/${enc(context)}/items`, { body: fields }),
  update: (context: string, key: string, fields: Partial<Pick<Item, 'title' | 'description' | 'priority' | 'assignee' | 'labels'>> & { note?: string }) =>
    call<{ item: Item }>(`/p/${enc(context)}/items/${enc(key)}`, { method: 'PATCH', body: fields }),
  thread: (context: string, key: string) => call<{ comments: Comment[]; attachments: Attachment[] }>(`/p/${enc(context)}/items/${enc(key)}/thread`),
  detach: (context: string, key: string, which: { sha256?: string; source_id?: string }) =>
    call<{ attachment: Attachment }>(`/p/${enc(context)}/items/${enc(key)}/detach`, { body: which }),
  comment: (context: string, key: string, body: string) => call<{ comment: Comment }>(`/p/${enc(context)}/items/${enc(key)}/comments`, { body: { body } }),
  fileUrl: (context: string, sha: string) => `/api/board/p/${enc(context)}/files/${sha}`,
  /** Raw upload with progress (fetch can't report upload progress). */
  upload(context: string, key: string, file: File, onProgress?: (fraction: number) => void): Promise<{ attachment: Attachment }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/board/p/${enc(context)}/items/${enc(key)}/files`)
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || 'pasted image.png'))
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
      xhr.onload = () => {
        let data: Record<string, unknown> = {}
        try {
          data = JSON.parse(xhr.responseText || '{}')
        } catch {
          /* not JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as { attachment: Attachment })
        else reject(new ApiError(xhr.status, typeof data.error === 'string' ? data.error : `upload failed (${xhr.status})`))
      }
      xhr.onerror = () => reject(new ApiError(0, 'upload failed — check your connection'))
      xhr.send(file)
    })
  },
  move: (context: string, key: string, body: { status?: Status; above?: string; below?: string; note?: string }) =>
    call<{ item: Item }>(`/p/${enc(context)}/items/${enc(key)}/move`, { body }),
}
