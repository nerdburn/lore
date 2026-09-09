import type { Connector, ConnectorContext, Doc } from '../types.js'

/**
 * Notion connector.
 *
 * Reads pages and databases an *internal integration* has been given access
 * to (Notion → page ··· → Connections → add the integration). Sharing is the
 * consent model, as invitations are for Slack. Scope a client's material with
 * `roots`: page or database ids/URLs — anything whose parent chain reaches a
 * root is in; with no roots, everything shared with the integration is in.
 *
 * Output: one stream doc per page per edit, id `notion-<page>@<last_edited>`,
 * containing the page rendered to markdown (title, properties for database
 * rows, then blocks, nested up to a few levels). Append-only history of the
 * documentation, grep-able and foldable like every other source. Pages
 * edited within `settle_minutes` (default 30) are left for the next run so
 * a page mid-edit doesn't produce a snapshot per keystroke-hour.
 *
 * Incremental via `last_edited_time` with a one-day overlap; dedup by id.
 * Rate-limit aware (Notion: ~3 req/s, 429 + Retry-After). `api_base` lets a
 * header-injecting proxy hold the token.
 */

interface NotionCursor {
  since?: string
}

const API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const DEFAULT_OVERLAP_DAYS = 1
const DEFAULT_SETTLE_MINUTES = 30
const MAX_DEPTH = 4
const DAY_MS = 86_400_000

export const notion: Connector = {
  name: 'notion',

  async fetch(ctx: ConnectorContext) {
    const token = ctx.config.token as string | undefined
    const apiBase = ((ctx.config.api_base as string | undefined) ?? API).replace(/\/$/, '')
    if (!token && ctx.config.api_base === undefined) throw new Error('notion: no token resolved (set token, or api_base to a proxy that injects one)')
    const roots = new Set(((ctx.config.roots as string[] | undefined) ?? []).map(normalizeId).filter(Boolean))
    const overlapMs = numberOr(ctx.config.overlap_days, DEFAULT_OVERLAP_DAYS) * DAY_MS
    const settleMs = numberOr(ctx.config.settle_minutes, DEFAULT_SETTLE_MINUTES) * 60_000

    const api = notionClient(apiBase, token)
    const prev = ctx.cursor as NotionCursor
    const sinceMs = prev.since ? Math.max(new Date(prev.since).getTime() - overlapMs, ctx.since) : ctx.since
    const cutoffMs = Date.now() - settleMs

    // Everything the integration can see, newest edits first, until we pass `since`.
    const objects = await api.searchSince(sinceMs)
    const byId = new Map(objects.map((o) => [normalizeId(o.id), o]))

    // Scope: walk parent chains to a root (fetching parents outside the
    // search window on demand, cached).
    const inScope = async (o: NotionObject): Promise<boolean> => {
      if (roots.size === 0) return true
      let cur: NotionObject | undefined = o
      for (let hops = 0; cur && hops < 20; hops++) {
        const id = normalizeId(cur.id)
        if (roots.has(id)) return true
        const parentId = parentIdOf(cur)
        if (!parentId) return false
        if (roots.has(parentId)) return true
        cur = byId.get(parentId) ?? (await api.retrieve(parentId, cur.parent?.type === 'database_id' ? 'database' : 'page'))
        if (cur) byId.set(parentId, cur)
      }
      return false
    }

    const docs: Doc[] = []
    const errors: string[] = []
    const users = new Map<string, string>()
    const userName = async (id: string | undefined): Promise<string> => {
      if (!id) return 'unknown'
      if (!users.has(id)) users.set(id, (await api.user(id)) ?? id)
      return users.get(id)!
    }

    let newest = prev.since ? new Date(prev.since).getTime() : 0
    let considered = 0
    for (const o of objects) {
      if (o.object !== 'page') continue
      const editedMs = new Date(o.last_edited_time).getTime()
      if (editedMs < sinceMs) continue
      if (editedMs > cutoffMs) continue // still settling
      if (!(await inScope(o))) continue
      considered++
      try {
        const body = await api.blocksMarkdown(o.id, 0)
        const title = titleOf(o)
        const props = o.parent?.type === 'database_id' ? renderProperties(o.properties ?? {}) : ''
        const author = await userName(o.last_edited_by?.id)
        docs.push({
          id: `notion-${normalizeId(o.id)}@${o.last_edited_time}`,
          source: 'notion',
          channel: await channelFor(o, byId, api),
          author,
          timestamp: o.last_edited_time,
          permalink: o.url,
          meta: {
            page: normalizeId(o.id),
            ...(parentIdOf(o) ? { parent: parentIdOf(o)! } : {}),
            ...(o.last_edited_by?.id ? { user: o.last_edited_by.id } : {}),
            created: o.created_time,
          },
          text: `**${title}**${props ? `\n\n${props}` : ''}\n\n${body.trim() || '(empty page)'}`,
        })
        if (editedMs > newest) newest = editedMs
      } catch (err) {
        errors.push(`page ${o.id}: ${err instanceof Error ? err.message : err}`)
      }
    }
    ctx.log(`notion: ${objects.length} object(s) edited in window, ${considered} in scope → ${docs.length} docs`)
    return {
      docs,
      nextCursor: { since: new Date(newest || sinceMs).toISOString() } as Record<string, unknown>,
      ...(errors.length ? { errors } : {}),
    }
  },
}

// ---- channel: the root/top-level container's title ----

async function channelFor(o: NotionObject, byId: Map<string, NotionObject>, api: Api): Promise<string> {
  let cur: NotionObject | undefined = o
  let top: NotionObject = o
  for (let hops = 0; cur && hops < 20; hops++) {
    const parentId = parentIdOf(cur)
    if (!parentId) break
    const parent: NotionObject | undefined = byId.get(parentId) ?? (await api.retrieve(parentId, cur.parent?.type === 'database_id' ? 'database' : 'page'))
    if (!parent) break
    byId.set(parentId, parent)
    top = parent
    cur = parent
  }
  return titleOf(top) || 'notion'
}

// ---- rendering ----

export function renderProperties(props: Record<string, NotionProperty>): string {
  const rows: string[] = []
  for (const [name, p] of Object.entries(props)) {
    if (p.type === 'title') continue
    const v = propertyText(p)
    if (v) rows.push(`- **${name}:** ${v}`)
  }
  return rows.join('\n')
}

export function propertyText(p: NotionProperty): string {
  switch (p.type) {
    case 'rich_text':
      return richText(p.rich_text ?? [])
    case 'number':
      return p.number == null ? '' : String(p.number)
    case 'select':
      return p.select?.name ?? ''
    case 'status':
      return p.status?.name ?? ''
    case 'multi_select':
      return (p.multi_select ?? []).map((s) => s.name).join(', ')
    case 'date':
      return p.date ? `${p.date.start}${p.date.end ? ` → ${p.date.end}` : ''}` : ''
    case 'people':
      return (p.people ?? []).map((u) => u.name ?? u.id).join(', ')
    case 'checkbox':
      return p.checkbox ? 'yes' : 'no'
    case 'url':
      return p.url ?? ''
    case 'email':
      return p.email ?? ''
    case 'relation':
      return (p.relation ?? []).map((r) => r.id).join(', ')
    case 'created_time':
      return p.created_time ?? ''
    case 'last_edited_time':
      return p.last_edited_time ?? ''
    default:
      return ''
  }
}

export function richText(rt: RichText[]): string {
  return rt
    .map((t) => {
      let s = t.plain_text ?? ''
      if (!s) return ''
      if (t.annotations?.code) s = `\`${s}\``
      if (t.annotations?.bold) s = `**${s}**`
      if (t.annotations?.italic) s = `*${s}*`
      if (t.href) s = `[${s}](${t.href})`
      return s
    })
    .join('')
}

/** One block → markdown line(s); children rendered by the caller with indent. */
export function renderBlock(b: NotionBlock, indent: string): string {
  const text = (key: string) => richText((b[key] as { rich_text?: RichText[] } | undefined)?.rich_text ?? [])
  switch (b.type) {
    case 'paragraph':
      return `${indent}${text('paragraph')}`
    case 'heading_1':
      return `${indent}# ${text('heading_1')}`
    case 'heading_2':
      return `${indent}## ${text('heading_2')}`
    case 'heading_3':
      return `${indent}### ${text('heading_3')}`
    case 'bulleted_list_item':
      return `${indent}- ${text('bulleted_list_item')}`
    case 'numbered_list_item':
      return `${indent}1. ${text('numbered_list_item')}`
    case 'to_do':
      return `${indent}- [${(b.to_do as { checked?: boolean } | undefined)?.checked ? 'x' : ' '}] ${text('to_do')}`
    case 'toggle':
      return `${indent}- ${text('toggle')}`
    case 'quote':
      return `${indent}> ${text('quote')}`
    case 'callout':
      return `${indent}> ${text('callout')}`
    case 'code': {
      const lang = (b.code as { language?: string } | undefined)?.language ?? ''
      return `${indent}\`\`\`${lang}\n${text('code')}\n${indent}\`\`\``
    }
    case 'divider':
      return `${indent}---`
    case 'child_page':
      return `${indent}- 📄 ${(b.child_page as { title?: string } | undefined)?.title ?? 'page'}`
    case 'child_database':
      return `${indent}- 🗄 ${(b.child_database as { title?: string } | undefined)?.title ?? 'database'}`
    case 'bookmark':
    case 'embed':
    case 'link_preview': {
      const url = (b[b.type] as { url?: string } | undefined)?.url ?? ''
      return `${indent}${url}`
    }
    case 'image':
    case 'file':
    case 'pdf':
    case 'video': {
      const f = b[b.type] as { caption?: RichText[]; external?: { url: string }; file?: { url: string } } | undefined
      const cap = richText(f?.caption ?? [])
      return `${indent}[${b.type}${cap ? `: ${cap}` : ''}]`
    }
    case 'table_row':
      return `${indent}| ${((b.table_row as { cells?: RichText[][] } | undefined)?.cells ?? []).map((c) => richText(c)).join(' | ')} |`
    case 'table':
    case 'column_list':
    case 'column':
    case 'synced_block':
      return '' // structural; children carry the content
    default:
      return text(b.type) ? `${indent}${text(b.type)}` : ''
  }
}

// ---- helpers ----

export function normalizeId(idOrUrl: string): string {
  const m = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(idOrUrl)
  if (!m) return ''
  return m[1].toLowerCase().replace(/-/g, '')
}

function parentIdOf(o: NotionObject): string | undefined {
  const p = o.parent
  if (!p) return undefined
  if (p.type === 'page_id') return normalizeId(p.page_id ?? '')
  if (p.type === 'database_id') return normalizeId(p.database_id ?? '')
  if (p.type === 'block_id') return normalizeId(p.block_id ?? '')
  return undefined
}

export function titleOf(o: NotionObject): string {
  if (o.object === 'database') return richText(o.title ?? []) || 'Untitled database'
  for (const p of Object.values(o.properties ?? {})) {
    if (p.type === 'title') return richText(p.title ?? []) || 'Untitled'
  }
  return 'Untitled'
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? value : fallback
}

// ---- API client ----

interface Api {
  searchSince(sinceMs: number): Promise<NotionObject[]>
  retrieve(id: string, kind: 'page' | 'database'): Promise<NotionObject | undefined>
  blocksMarkdown(blockId: string, depth: number): Promise<string>
  user(id: string): Promise<string | undefined>
}

function notionClient(apiBase: string, token: string | undefined): Api {
  const headers: Record<string, string> = { 'Notion-Version': NOTION_VERSION, 'content-type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (;;) {
      const res = await fetch(`${apiBase}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } })
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? '1')
        await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000))
        continue
      }
      if (!res.ok) throw new Error(`notion ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`)
      return (await res.json()) as T
    }
  }

  return {
    async searchSince(sinceMs) {
      const out: NotionObject[] = []
      let cursor: string | undefined
      do {
        const page = await request<{ results: NotionObject[]; next_cursor?: string | null; has_more: boolean }>('/search', {
          method: 'POST',
          body: JSON.stringify({ sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
        })
        let passed = false
        for (const o of page.results) {
          out.push(o)
          if (new Date(o.last_edited_time).getTime() < sinceMs) passed = true
        }
        cursor = page.has_more && !passed ? (page.next_cursor ?? undefined) : undefined
      } while (cursor)
      return out
    },
    async retrieve(id, kind) {
      try {
        return await request<NotionObject>(`/${kind === 'database' ? 'databases' : 'pages'}/${id}`)
      } catch {
        return undefined
      }
    },
    async blocksMarkdown(blockId, depth) {
      if (depth > MAX_DEPTH) return ''
      const lines: string[] = []
      let cursor: string | undefined
      do {
        const page = await request<{ results: NotionBlock[]; next_cursor?: string | null; has_more: boolean }>(
          `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`,
        )
        for (const b of page.results) {
          const line = renderBlock(b, '  '.repeat(depth))
          if (line) lines.push(line)
          if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database') {
            const nested = await this.blocksMarkdown(b.id, b.type === 'table' || b.type === 'column_list' || b.type === 'column' ? depth : depth + 1)
            if (nested) lines.push(nested)
          }
        }
        cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
      } while (cursor)
      return lines.join('\n')
    },
    async user(id) {
      try {
        const u = await request<{ name?: string }>(`/users/${id}`)
        return u.name || undefined
      } catch {
        return undefined
      }
    },
  }
}

// ---- API shapes (only what is used) ----

export interface RichText {
  plain_text?: string
  href?: string | null
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean }
}
export interface NotionProperty {
  type: string
  title?: RichText[]
  rich_text?: RichText[]
  number?: number | null
  select?: { name: string } | null
  status?: { name: string } | null
  multi_select?: { name: string }[]
  date?: { start: string; end?: string | null } | null
  people?: { id: string; name?: string }[]
  checkbox?: boolean
  url?: string | null
  email?: string | null
  relation?: { id: string }[]
  created_time?: string
  last_edited_time?: string
}
export interface NotionObject {
  object: 'page' | 'database'
  id: string
  url: string
  created_time: string
  last_edited_time: string
  last_edited_by?: { id: string }
  parent?: { type: string; page_id?: string; database_id?: string; block_id?: string; workspace?: boolean }
  properties?: Record<string, NotionProperty>
  title?: RichText[]
}
export interface NotionBlock {
  id: string
  type: string
  has_children?: boolean
  [key: string]: unknown
}
