import { createHash } from 'node:crypto'
import type { Connector, ConnectorContext, Doc } from '../types.js'

/**
 * Figma connector — the design as evidence an agent can check work against.
 *
 * For every configured file (design file or FigJam board — the REST API does
 * not serve Slides decks) it writes:
 * - one doc per top-level frame on each page — the frame's text layers in
 *   reading order under its nested frame headings, component instances by
 *   name, and a deep link to the node — re-emitted only when that frame's
 *   content changes (per-frame fingerprints in the cursor), so a file with
 *   two hundred screens costs two hundred docs once and a handful per edit;
 * - one index doc per file version listing pages and frames;
 * - comments as threaded docs, like Slack messages, anchored to the frame
 *   they were left on.
 *
 * What an agent gets: "what does the design say the empty state reads",
 * "is there a screen for X", "what did Julie comment on the onboarding
 * flow" — grep-able text with a node link to open in Figma. It is design
 * intent, not the shipped UI; the skill says so.
 *
 * Auth: a personal access token as `token` (env ref) sent as X-Figma-Token,
 * or an `api_base` proxy that injects it (exe.dev http-proxy).
 */

const API = 'https://api.figma.com/v1'
const DEFAULT_OVERLAP_DAYS = 1
const DAY_MS = 86_400_000
const MAX_DEPTH = 4
const MAX_ATTEMPTS = 5

interface FileCursor {
  version?: string
  lastModified?: string
  /** top-level node id → content fingerprint */
  frames?: Record<string, string>
  commentsSince?: string
}
type FigmaCursor = Record<string, FileCursor>

export const figma: Connector = {
  name: 'figma',

  async fetch(ctx: ConnectorContext) {
    const token = ctx.config.token as string | undefined
    const apiBase = ((ctx.config.api_base as string | undefined) ?? API).replace(/\/$/, '')
    if (!token && ctx.config.api_base === undefined) throw new Error('figma: no credentials (set token to env:FIGMA_TOKEN, or api_base to a proxy that injects X-Figma-Token)')
    const include = (ctx.config.include as string[] | undefined) ?? ['frames', 'comments']
    const overlapMs = numberOr(ctx.config.overlap_days, DEFAULT_OVERLAP_DAYS) * DAY_MS

    const api = figmaClient(apiBase, token)
    const keys = new Map<string, string | undefined>() // key → hint
    for (const f of (ctx.config.files as string[] | undefined) ?? []) {
      const key = figmaFileKey(f)
      if (!key) throw new Error(`figma: "${f}" is not a Figma file URL or key`)
      keys.set(key, undefined)
    }
    const errors: string[] = []
    for (const p of (ctx.config.projects as (string | number)[] | undefined) ?? []) {
      try {
        for (const f of await api.projectFiles(String(p))) keys.set(f.key, f.name)
      } catch (err) {
        errors.push(`project ${p}: ${err instanceof Error ? err.message : err}`)
      }
    }
    if (keys.size === 0 && errors.length === 0) throw new Error('figma: no files or projects configured')

    const cursor: FigmaCursor = { ...(ctx.cursor as FigmaCursor) }
    const docs: Doc[] = []
    let frameDocs = 0
    let commentDocs = 0

    for (const [key] of keys) {
      const prev: FileCursor = cursor[key] ?? {}
      try {
        const head = await api.file(key, 1)
        const channel = slug(head.name)
        const next: FileCursor = { ...prev, version: String(head.version), lastModified: head.lastModified }
        let nodeNames = new Map<string, string>()

        if (include.includes('frames')) {
          const changed = prev.version !== String(head.version) || !prev.frames
          if (changed) {
            const full = await api.file(key)
            const editor = await api.latestEditor(key).catch(() => undefined)
            const walk = walkFile(full, key)
            nodeNames = walk.names
            const frames: Record<string, string> = {}
            for (const frame of walk.frames) {
              const fp = fingerprint(frame.text)
              frames[frame.id] = fp
              if (prev.frames?.[frame.id] === fp) continue
              docs.push({
                id: `figma-${key}-${frame.id.replace(/[^A-Za-z0-9]/g, '_')}-${fp.slice(0, 8)}`,
                source: 'figma',
                channel,
                author: editor ?? 'Figma',
                timestamp: iso(full.lastModified),
                permalink: nodeUrl(key, full.name, frame.id),
                meta: { file: key, node: frame.id, version: String(full.version), page: slug(frame.page) },
                text: frame.text,
              })
              frameDocs++
            }
            next.frames = frames
            const index = renderIndex(full, key, walk.frames)
            const ifp = fingerprint(index)
            if (prev.frames?.__index !== ifp) {
              docs.push({
                id: `figma-${key}-index-${ifp.slice(0, 8)}`,
                source: 'figma',
                channel,
                author: editor ?? 'Figma',
                timestamp: iso(full.lastModified),
                permalink: fileUrl(key, full.name),
                meta: { file: key, version: String(full.version), kind: 'index' },
                text: index,
              })
              frameDocs++
            }
            next.frames.__index = ifp
          }
        }

        if (include.includes('comments')) {
          const sinceMs = prev.commentsSince ? Math.max(new Date(prev.commentsSince).getTime() - overlapMs, ctx.since) : ctx.since
          const comments = await api.comments(key)
          if (nodeNames.size === 0 && comments.some((c) => c.client_meta?.node_id)) {
            // Names for the frames comments point at, without a full re-walk when frames didn't change.
            try {
              nodeNames = walkFile(await api.file(key), key).names
            } catch {
              /* comments still land, unanchored */
            }
          }
          let newest = prev.commentsSince ? new Date(prev.commentsSince).getTime() : 0
          for (const c of comments) {
            const ms = new Date(c.created_at).getTime()
            if (!Number.isFinite(ms) || ms < sinceMs) continue
            const nodeId = c.client_meta?.node_id
            const where = nodeId ? nodeNames.get(nodeId) : undefined
            docs.push({
              id: `figma-${key}-comment-${c.id}`,
              source: 'figma',
              channel,
              author: c.user?.handle ?? 'unknown',
              timestamp: iso(c.created_at),
              permalink: nodeId ? nodeUrl(key, head.name, nodeId) : fileUrl(key, head.name),
              ...(c.parent_id ? { thread: `figma-${key}-comment-${c.parent_id}` } : {}),
              meta: { file: key, comment: c.id, ...(nodeId ? { node: nodeId } : {}), ...(c.resolved_at ? { resolved: c.resolved_at } : {}) },
              text: `${where ? `On **${where}**${c.resolved_at ? ' (resolved)' : ''}:\n\n` : c.resolved_at ? '(resolved)\n\n' : ''}${c.message.trim()}`,
            })
            commentDocs++
            if (ms > newest) newest = ms
          }
          if (newest) next.commentsSince = new Date(newest).toISOString()
        }
        cursor[key] = next
        ctx.log(`figma: ${head.name} → ${docs.length} docs so far`)
      } catch (err) {
        if (err instanceof FigmaError && err.status === 400 && /not supported/i.test(err.message)) {
          errors.push(`file ${key}: Figma's REST API does not serve this file type (Slides decks are not available to it) — export it as PDF and \`lore doc add\` it instead`)
          continue
        }
        if (err instanceof FigmaError && (err.status === 403 || err.status === 404)) {
          errors.push(`file ${key}: ${err.message} — check the key and that the token's account can open the file`)
          continue
        }
        throw err
      }
    }
    ctx.log(`figma: ${keys.size} file(s) → ${frameDocs} frame/index docs, ${commentDocs} comments`)
    return { docs, nextCursor: cursor, ...(errors.length ? { errors } : {}) }
  },
}

// ---- URLs ----

/** figma.com/{design,file,board,deck,slides,proto}/<key>/… or a bare key → key. */
export function figmaFileKey(s: string): string | undefined {
  const m = /^(?:https?:\/\/)?(?:www\.)?figma\.com\/(?:design|file|board|deck|slides|proto)\/([A-Za-z0-9]{8,})(?:[/?#]|$)/.exec(s.trim())
  if (m) return m[1]
  return /^[A-Za-z0-9]{8,}$/.test(s.trim()) ? s.trim() : undefined
}

export function fileUrl(key: string, name: string): string {
  return `https://www.figma.com/design/${key}/${slug(name)}`
}

/** API node ids are "1:1654"; the URL wants "1-1654". */
export function nodeUrl(key: string, name: string, nodeId: string): string {
  return `${fileUrl(key, name)}?node-id=${nodeId.replace(/:/g, '-')}`
}

// ---- rendering ----

export interface FigmaNode {
  id: string
  name: string
  type: string
  visible?: boolean
  characters?: string
  children?: FigmaNode[]
  absoluteBoundingBox?: { width?: number; height?: number }
  componentId?: string
}

export interface FigmaFile {
  name: string
  version: string | number
  lastModified: string
  document: FigmaNode
}

export interface FrameDoc {
  id: string
  page: string
  name: string
  text: string
}

/** Text nodes are leaves; anything else with children is a container worth a heading. */
const CONTAINERS = new Set(['FRAME', 'SECTION', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SLIDE', 'SLIDE_ROW', 'TABLE', 'SHAPE_WITH_TEXT', 'STICKY', 'BOOLEAN_OPERATION'])

/**
 * Every screen on every page as a markdown doc, plus node id → "Page / …"
 * names for anchoring comments. A screen is a top-level frame — or, inside a
 * SECTION (designers group a flow's screens in one), each frame the section
 * holds, with the section in its path; a section's own loose text and
 * headers become one short notes doc.
 */
export function walkFile(file: FigmaFile, key: string): { frames: FrameDoc[]; names: Map<string, string> } {
  const frames: FrameDoc[] = []
  const names = new Map<string, string>()
  const emit = (node: FigmaNode, page: string, path: string, heading: string) => {
    names.set(node.id, path)
    for (const [id, p] of descendants(node, path)) names.set(id, p)
    const lines: string[] = [`# ${file.name} › ${heading}`, `Figma node ${node.id}${dims(node)} — ${nodeUrl(key, file.name, node.id)}`, '']
    renderChildren(node, lines, 2)
    frames.push({ id: node.id, page, name: path.slice(page.length + 3), text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() })
  }
  const visit = (node: FigmaNode, page: string, path: string, heading: string) => {
    if (node.visible === false) return
    if (node.type === 'SECTION') {
      names.set(node.id, path)
      const loose: FigmaNode[] = []
      for (const c of node.children ?? []) {
        if (c.visible === false) continue
        if (c.type === 'SECTION' || CONTAINERS.has(c.type) || c.children?.length) {
          if (c.type === 'INSTANCE' && !(c.children ?? []).some(hasText)) loose.push(c)
          else visit(c, page, `${path} / ${c.name}`, `${heading} › ${c.name}`)
        } else if (c.type === 'TEXT') loose.push(c)
      }
      if (loose.some((n) => n.type === 'TEXT' && n.characters?.trim())) {
        const lines: string[] = [`# ${file.name} › ${heading} (section notes)`, `Figma node ${node.id} — ${nodeUrl(key, file.name, node.id)}`, '']
        renderChildren({ ...node, children: loose }, lines, 2)
        frames.push({ id: node.id, page, name: `${path.slice(page.length + 3)} (section notes)`, text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() })
      }
      return
    }
    if (node.type === 'TEXT' || !(CONTAINERS.has(node.type) || node.children?.length)) return
    emit(node, page, path, heading)
  }
  for (const page of file.document.children ?? []) {
    if (page.type !== 'CANVAS' || page.visible === false) continue
    for (const top of page.children ?? []) visit(top, page.name, `${page.name} / ${top.name}`, `${page.name} › ${top.name}`)
  }
  return { frames, names }
}

function descendants(node: FigmaNode, path: string): [string, string][] {
  const out: [string, string][] = []
  for (const c of node.children ?? []) {
    if (c.type === 'TEXT') continue
    const p = `${path} / ${c.name}`
    out.push([c.id, p], ...descendants(c, p))
  }
  return out
}

function renderChildren(node: FigmaNode, lines: string[], depth: number): void {
  for (const c of node.children ?? []) {
    if (c.visible === false) continue
    if (c.type === 'TEXT') {
      const t = (c.characters ?? '').replace(/\s+/g, ' ').trim()
      if (t) lines.push(`- ${t}`)
      continue
    }
    if (c.type === 'INSTANCE' && !(c.children ?? []).some(hasText)) {
      lines.push(`- [component: ${c.name}]`)
      continue
    }
    if (CONTAINERS.has(c.type) || c.children?.length) {
      if (depth <= MAX_DEPTH) {
        lines.push('', `${'#'.repeat(depth)} ${c.name}${c.type === 'INSTANCE' ? ' [component]' : ''}`)
        renderChildren(c, lines, depth + 1)
      } else {
        // Too deep for headings: flatten the remaining text.
        const texts: string[] = []
        collectText(c, texts)
        for (const t of texts) lines.push(`- ${t}`)
      }
    }
  }
}

function hasText(n: FigmaNode): boolean {
  return n.type === 'TEXT' ? Boolean(n.characters?.trim()) : (n.children ?? []).some(hasText)
}

function collectText(n: FigmaNode, out: string[]): void {
  if (n.visible === false) return
  if (n.type === 'TEXT') {
    const t = (n.characters ?? '').replace(/\s+/g, ' ').trim()
    if (t) out.push(t)
    return
  }
  for (const c of n.children ?? []) collectText(c, out)
}

function dims(n: FigmaNode): string {
  const b = n.absoluteBoundingBox
  return b?.width && b?.height ? ` (${Math.round(b.width)}×${Math.round(b.height)})` : ''
}

export function renderIndex(file: FigmaFile, key: string, frames: FrameDoc[]): string {
  // No version or date in the body: the index is re-emitted only when the set of pages/frames changes, not on every save.
  const lines = [`# ${file.name} — pages and frames`, `Figma file ${key} — ${fileUrl(key, file.name)}`, '']
  let page = ''
  for (const f of frames) {
    if (f.page !== page) {
      page = f.page
      lines.push('', `## ${page}`)
    }
    lines.push(`- ${f.name} — ${nodeUrl(key, file.name, f.id)}`)
  }
  return lines.join('\n').trim()
}

// ---- helpers ----

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'figma'
  )
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function iso(s: string | undefined): string {
  const ms = s ? new Date(s).getTime() : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString()
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? value : fallback
}

// ---- API client ----

export class FigmaError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export interface FigmaComment {
  id: string
  message: string
  created_at: string
  resolved_at?: string | null
  parent_id?: string
  user?: { handle?: string }
  client_meta?: { node_id?: string } | null
}

export interface FigmaApi {
  /** The file tree; `depth` 1 = pages only (cheap: name, version, lastModified). */
  file(key: string, depth?: number): Promise<FigmaFile>
  comments(key: string): Promise<FigmaComment[]>
  projectFiles(projectId: string): Promise<{ key: string; name: string }[]>
  /** Handle of whoever saved the latest version, when the API says. */
  latestEditor(key: string): Promise<string | undefined>
}

export function figmaClient(apiBase: string, token: string | undefined): FigmaApi {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers['X-Figma-Token'] = token
  async function request<T>(path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${apiBase}${path}`, { headers })
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) throw new FigmaError(res.status, `figma ${res.status} ${path.split('?')[0]} after ${attempt} attempts`)
        const wait = Number(res.headers.get('retry-after'))
        await new Promise((r) => setTimeout(r, (Number.isFinite(wait) && wait > 0 ? Math.min(wait, 120) : Math.min(2 ** attempt, 30)) * 1000))
        continue
      }
      if (!res.ok) throw new FigmaError(res.status, `figma ${res.status} ${path.split('?')[0]}: ${(await res.text()).slice(0, 200)}`)
      return (await res.json()) as T
    }
  }
  return {
    file: (key, depth) => request<FigmaFile>(`/files/${key}${depth ? `?depth=${depth}` : ''}`),
    async comments(key) {
      const r = await request<{ comments?: FigmaComment[] }>(`/files/${key}/comments`)
      return r.comments ?? []
    },
    async projectFiles(projectId) {
      const r = await request<{ files?: { key: string; name: string }[] }>(`/projects/${projectId}/files`)
      return r.files ?? []
    },
    async latestEditor(key) {
      const r = await request<{ versions?: { user?: { handle?: string } }[] }>(`/files/${key}/versions`)
      return r.versions?.[0]?.user?.handle
    },
  }
}
