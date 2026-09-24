import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { parse, stringify } from 'yaml'
import { appendAudit } from './audit.js'
import { MAX_ATTACHMENT_BYTES, TooLarge, writeHashed, type BlobStore } from './blobs.js'
import { commitWork, type WorkWriteOptions } from './commands/work.js'
import type { LoreConfig } from './config.js'
import { resolveContext } from './context.js'
import type { Connector, RemoteAttachment } from './types.js'
import { authorizeWrite } from './write.js'
import { applyChange, findItem, readWorkItems, workPrefix, writeWorkItems, type ExternalRef } from './work.js'

/**
 * Files on tickets — screenshots, recordings, PDFs — from the board or
 * imported from the linked Jira / GitHub / Linear issue.
 *
 * Git holds only the record (`context/attachments.yaml`, one entry per file
 * per ticket); the bytes live in the asset store (blobs.ts), keyed by
 * sha256. A file too large to import is still recorded, as a link to where
 * it lives, so the board can say it exists.
 */

export const ATTACHMENTS_FILE = 'context/attachments.yaml'

export interface AttachmentRecord {
  /** Absent when the file was not imported (too large, unreachable). */
  sha256?: string
  ticket: string
  name: string
  type: string
  size?: number
  source: 'board' | ExternalRef['system']
  /** For imports: the source's own id for the file, so a re-scan knows it has it. */
  source_id?: string
  /** For imports: where the file lives (the issue, or the file itself). */
  source_url?: string
  by: string
  at: string
  /** Why it was not imported. */
  skipped?: string
  /**
   * Taken off the ticket. The record stays (a tombstone) so a re-scan of the
   * external issue does not import the file again; the board hides it and
   * no longer serves it.
   */
  removed?: { by: string; at: string }
}

/** Records the board shows and serves: not removed. */
export function liveAttachments(records: AttachmentRecord[]): AttachmentRecord[] {
  return records.filter((r) => !r.removed)
}

export function parseAttachments(text: string | undefined): AttachmentRecord[] {
  if (!text) return []
  try {
    const parsed = parse(text.replace(/^(#.*\n)+/, ''))
    return Array.isArray(parsed) ? (parsed as AttachmentRecord[]).filter((r) => r && typeof r.ticket === 'string' && typeof r.name === 'string') : []
  } catch {
    return []
  }
}

export function readAttachments(root: string): AttachmentRecord[] {
  const p = join(root, ATTACHMENTS_FILE)
  return existsSync(p) ? parseAttachments(readFileSync(p, 'utf8')) : []
}

function writeAttachments(root: string, records: AttachmentRecord[]): void {
  writeFileSync(
    join(root, ATTACHMENTS_FILE),
    `# Files on lore tickets — the record; the bytes are in the asset store, by sha256. Written by the board and \`lore sync\`, never by hand.\n` + stringify(records),
  )
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
}

export function guessType(name: string, given?: string | null): string {
  const g = given?.split(';')[0].trim().toLowerCase()
  if (g && g !== 'application/octet-stream' && g !== 'binary/octet-stream') return g
  return TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** A file name safe to store and to put in a header. */
export function cleanName(name: string): string {
  const base = name.replace(/[\\/]+/g, '_').replace(/[\u0000-\u001f"<>|]+/g, '').trim()
  return (base || 'file').slice(0, 180)
}

// ---- the board ----

export interface NewUpload {
  tmp: string
  sha: string
  size: number
  name: string
  type: string
}

/**
 * Attach an uploaded file (already hashed into a temp file under the store's
 * directory) to a ticket: store it, record it, note it in the ticket's
 * history, audit, commit and push — like any other board write. The same
 * file twice on one ticket is recorded once.
 */
export async function attachUpload(cwd: string, key: string, upload: NewUpload, store: BlobStore, opts: WorkWriteOptions = {}): Promise<AttachmentRecord> {
  const ctx = resolveContext(cwd, opts)
  const actor = authorizeWrite(ctx, opts, 'attachment')
  const prefix = workPrefix(ctx.config)
  const items = readWorkItems(ctx.root, prefix)
  const item = findItem(items, key)
  if (!item) {
    rmSync(upload.tmp, { force: true })
    throw new Error(`work: no item ${key}`)
  }
  const records = readAttachments(ctx.root)
  const existing = records.find((r) => r.ticket === item.key && r.sha256 === upload.sha)
  if (existing && !existing.removed) {
    rmSync(upload.tmp, { force: true })
    return existing
  }
  await store.put(upload.tmp, upload.sha, upload.type)
  const at = new Date().toISOString()
  const record: AttachmentRecord = { sha256: upload.sha, ticket: item.key, name: cleanName(upload.name), type: upload.type, size: upload.size, source: 'board', by: actor, at }
  // Re-attaching a file that was removed replaces its tombstone.
  if (existing) records.splice(records.indexOf(existing), 1)
  records.push(record)
  writeAttachments(ctx.root, records)
  applyChange(item, {}, { at, by: actor, via: opts.via ?? 'cli', reason: `attached ${record.name}` }, { attached: [null, record.name] })
  const rel = writeWorkItems(ctx.root, prefix, items)
  appendAudit(ctx.root, { at, action: 'attach', actor, via: opts.via ?? 'cli', id: item.key, source: `sha256:${upload.sha}` })
  commitWork(ctx, [rel, ATTACHMENTS_FILE], `lore: attach ${record.name} to ${item.key}`)
  return record
}

/**
 * Take a file off a ticket — by its sha256, or (a too-large import that was
 * only ever a link) by its source id. Recorded in the ticket's history;
 * the bytes stay in the store, where another ticket may use them.
 */
export function removeAttachment(cwd: string, key: string, which: { sha256?: string; source_id?: string }, opts: WorkWriteOptions = {}): AttachmentRecord {
  if (!which.sha256 && !which.source_id) throw new Error('attachment: say which file (sha256 or source_id)')
  const ctx = resolveContext(cwd, opts)
  const actor = authorizeWrite(ctx, opts, 'attachment removal')
  const prefix = workPrefix(ctx.config)
  const items = readWorkItems(ctx.root, prefix)
  const item = findItem(items, key)
  if (!item) throw new Error(`work: no item ${key}`)
  const records = readAttachments(ctx.root)
  const record = records.find(
    (r) => r.ticket === item.key && !r.removed && (which.sha256 ? r.sha256 === which.sha256 : r.source_id === which.source_id),
  )
  if (!record) throw new Error(`attachment: no such file on ${item.key}`)
  const at = new Date().toISOString()
  record.removed = { by: actor, at }
  writeAttachments(ctx.root, records)
  applyChange(item, {}, { at, by: actor, via: opts.via ?? 'cli', reason: `removed ${record.name}` }, { detached: [record.name, null] })
  const rel = writeWorkItems(ctx.root, prefix, items)
  appendAudit(ctx.root, { at, action: 'attach', actor, via: opts.via ?? 'cli', id: item.key, source: `removed ${record.sha256 ? `sha256:${record.sha256}` : record.source_id}` })
  commitWork(ctx, [rel, ATTACHMENTS_FILE], `lore: remove ${record.name} from ${item.key}`)
  return record
}

// ---- sync ----

const SOURCE_OF: Record<ExternalRef['system'], string> = { jira: 'jira', github: 'github', linear: 'linear' }

export interface ImportResult {
  imported: number
  skipped: number
  errors: string[]
}

/**
 * Import the files on the external issues behind open lore tickets.
 * Runs after mirroring in `lore sync`. Only open tickets; a file over the
 * size cap is recorded as a link, not downloaded; a file already recorded
 * (by source id) is left alone. Failures are reported, never fatal: the
 * next sync retries what is still missing.
 */
export async function importAttachments(
  root: string,
  config: Pick<LoreConfig, 'project' | 'client' | 'work' | 'sources'>,
  registry: Record<string, Connector>,
  store: BlobStore,
  resolved: (source: string) => Record<string, unknown> | undefined,
  log: (line: string) => void = () => {},
  max = MAX_ATTACHMENT_BYTES,
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] }
  const items = readWorkItems(root, workPrefix(config)).filter((i) => i.state === 'open' && i.external)
  if (items.length === 0) return result
  const records = readAttachments(root)
  const have = new Set(records.filter((r) => r.source_id).map((r) => `${r.source}|${r.ticket}|${r.source_id}`))
  const byRef = new Map(items.map((i) => [i.external!.id, i]))
  let changed = false

  for (const system of Object.keys(SOURCE_OF) as ExternalRef['system'][]) {
    const source = SOURCE_OF[system]
    const connector = registry[source]
    const cfg = resolved(source)
    const refs = items.filter((i) => i.external!.system === system).map((i) => i.external!.id)
    if (!connector?.attachments || !connector.download || !cfg || refs.length === 0) continue
    let remote: RemoteAttachment[]
    try {
      remote = await connector.attachments({ config: cfg, log }, refs)
    } catch (err) {
      result.errors.push(`${source} attachments: ${err instanceof Error ? err.message : err}`)
      continue
    }
    for (const att of remote) {
      const item = byRef.get(att.ref)
      if (!item) continue
      const id = `${system}|${item.key}|${att.sourceId}`
      if (have.has(id)) continue
      const base: AttachmentRecord = {
        ticket: item.key,
        name: cleanName(att.name),
        type: guessType(att.name, att.mime),
        ...(att.size !== undefined ? { size: att.size } : {}),
        source: system,
        source_id: att.sourceId,
        source_url: item.external!.url || att.url,
        by: att.author ?? system,
        at: att.created ?? new Date().toISOString(),
      }
      if (att.size !== undefined && att.size > max) {
        records.push({ ...base, skipped: `larger than ${Math.round(max / 1024 / 1024)} MB` })
        have.add(id)
        changed = true
        result.skipped++
        continue
      }
      try {
        const res = await connector.download({ config: cfg, log }, att)
        if (!res.ok || !res.body) throw new Error(`download ${res.status}`)
        const length = Number(res.headers.get('content-length'))
        if (length > max) throw new TooLarge(max)
        const got = await writeHashed(Readable.fromWeb(res.body as never), store.dir, max)
        const type = guessType(att.name, att.mime ?? res.headers.get('content-type'))
        await store.put(got.tmp, got.sha, type)
        records.push({ ...base, sha256: got.sha, type, size: got.size })
        result.imported++
      } catch (err) {
        if (err instanceof TooLarge) {
          records.push({ ...base, skipped: `larger than ${Math.round(max / 1024 / 1024)} MB` })
          result.skipped++
        } else {
          result.errors.push(`${item.key} ${att.name}: ${err instanceof Error ? err.message : err}`)
          continue
        }
      }
      have.add(id)
      changed = true
    }
  }
  if (changed) writeAttachments(root, records)
  if (result.imported || result.skipped) log(`attachments: ${result.imported} imported${result.skipped ? `, ${result.skipped} too large (linked)` : ''}`)
  return result
}
