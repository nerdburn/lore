import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { appendAudit } from './audit.js'
import { commitWork, type WorkWriteOptions } from './commands/work.js'
import { resolveContext } from './context.js'
import { authorizeWrite } from './write.js'

export const REQUESTS_FILE = 'context/derived/requests.yaml'

/**
 * Requests are derived by the fold, with one exception: a person may put a
 * request aside. `archived` hides it until someone asks to see it; `deleted`
 * hides it for good (the record stays, so its id is never handed to a new
 * request and the change can be undone). The fold neither sees nor changes
 * a request in either state.
 */
export const HUMAN_CLOSED = ['archived', 'deleted'] as const
export type RequestAction = 'archive' | 'delete' | 'restore'

export function isHumanClosed(item: unknown): boolean {
  return (HUMAN_CLOSED as readonly string[]).includes(String((item as { status?: unknown } | null)?.status ?? ''))
}

const idNumber = (id: unknown): number => Number(/(\d+)$/.exec(String(id ?? ''))?.[1] ?? 0)

/**
 * The fold cannot see requests a person closed, so it may hand one of their
 * ids to a new request. Give any such proposal the next free id instead, so
 * it lands as the new request it is and the closed one stays closed.
 */
export function reidAroundClosed(previous: unknown[], proposed: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(proposed)) return proposed
  const closed = new Set(previous.filter(isHumanClosed).map((i) => String((i as { id?: unknown }).id)))
  if (closed.size === 0) return proposed
  let next = Math.max(0, ...[...previous, ...proposed].map((i) => idNumber((i as { id?: unknown } | null)?.id)))
  return proposed.map((item) => {
    const id = (item as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !closed.has(id)) return item
    return { ...(item as object), id: `req-${String(++next).padStart(4, '0')}` }
  })
}

export interface RequestsSetResult {
  changed: string[]
  unchanged: string[]
}

/**
 * Archive, delete or restore requests: one write, one commit. `restore`
 * returns a request to `open`; the next fold re-reads it and may mark it
 * done or stale from what it knows. Every id must exist or nothing is written.
 */
export function requestsSet(cwd: string, ids: string[], action: RequestAction, opts: WorkWriteOptions = {}): RequestsSetResult {
  const wanted = [...new Set(ids.map((i) => i.trim()).filter(Boolean))]
  if (wanted.length === 0) throw new Error('requests: give at least one request id')
  const ctx = resolveContext(cwd, opts)
  const via = opts.via ?? 'cli'
  const actor = authorizeWrite(ctx, opts, 'request change')
  const at = opts.at ?? new Date().toISOString()
  const path = join(ctx.root, REQUESTS_FILE)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const header = /^(#.*\n)+/.exec(text)?.[0] ?? '# Derived by `lore extract` — regenerable; do not hand-edit.\n'
  const list = (parse(text) as Record<string, unknown>[] | null) ?? []
  const missing = wanted.filter((id) => !list.some((r) => r.id === id))
  if (missing.length) throw new Error(`requests: no request ${missing.join(', ')} — nothing changed`)
  const to = action === 'archive' ? 'archived' : action === 'delete' ? 'deleted' : 'open'
  const result: RequestsSetResult = { changed: [], unchanged: [] }
  for (const r of list) {
    if (!wanted.includes(String(r.id))) continue
    // Restoring only applies to what a person closed; a request the fold marked done or stale stays as it is.
    if (r.status === to || (action === 'restore' && !isHumanClosed(r))) {
      result.unchanged.push(String(r.id))
      continue
    }
    r.status = to
    result.changed.push(String(r.id))
  }
  if (result.changed.length === 0) return result
  writeFileSync(path, header + stringify(list))
  for (const id of result.changed) appendAudit(ctx.root, { at, action: 'work', actor, via, id })
  const listed = result.changed.length > 8 ? `${result.changed.length} requests` : result.changed.join(', ')
  commitWork(ctx, REQUESTS_FILE, `lore: requests ${action} ${listed}`)
  return result
}
