import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { scrub } from './scrub.js'
import type { Doc } from './types.js'

export interface WriteResult {
  written: number
  skipped: number
  /** Secrets redacted before writing, by kind. */
  redacted: Record<string, number>
}

/**
 * Write docs into context/streams/<source>/<channel>/<YYYY-MM-DD>.md.
 * Append-only and idempotent: a doc whose id already appears in the
 * target file is skipped, so re-syncing an overlapping window is safe.
 * Every doc passes through the secrets scrubber first — this is the single
 * choke point between connectors and git.
 */
export function writeDocs(root: string, docs: Doc[]): WriteResult {
  let written = 0
  let skipped = 0
  const redacted: Record<string, number> = {}
  const sorted = [...docs].sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  let docsStreamIds: Set<string> | undefined

  for (const doc of sorted) {
    const day = doc.timestamp.slice(0, 10)
    const path = join(root, streamRelPath(doc.source, doc.channel, doc.timestamp))

    // The docs stream dedupes across the whole stream, not per day file: the
    // same document reaches lore by several routes (a person filing it, the
    // email that linked it, a reply quoting that email) under different
    // titles and dates, and its id is content-derived — one copy is enough.
    if (doc.source === DOCS_STREAM) {
      docsStreamIds ??= docStreamIds(root)
      if (docsStreamIds.has(doc.id)) {
        skipped++
        continue
      }
      docsStreamIds.add(doc.id)
    }

    if (existsSync(path)) {
      if (hasDoc(readFileSync(path, 'utf8'), doc.id)) {
        skipped++
        continue
      }
    } else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        path,
        `---\nsource: ${doc.source}\nchannel: "${doc.channel}"\ndate: ${day}\n---\n`,
      )
    }

    const clean = scrub(doc.text)
    for (const [kind, n] of Object.entries(clean.redacted)) redacted[kind] = (redacted[kind] ?? 0) + n
    appendFileSync(path, formatDoc({ ...doc, text: clean.text }))
    written++
  }
  return { written, skipped, redacted }
}

const DOCS_STREAM = 'docs'

/** Every doc id already in the docs stream, across channels and days. */
export function docStreamIds(root: string): Set<string> {
  const ids = new Set<string>()
  const dir = join(root, 'context', 'streams', DOCS_STREAM)
  if (!existsSync(dir)) return ids
  for (const channel of readdirSync(dir, { withFileTypes: true })) {
    if (!channel.isDirectory()) continue
    for (const f of readdirSync(join(dir, channel.name))) {
      if (!f.endsWith('.md')) continue
      for (const m of readFileSync(join(dir, channel.name, f), 'utf8').matchAll(/<!-- id: (doc-[A-Za-z0-9_-]+)(?: |-->)/g)) ids.add(m[1])
    }
  }
  return ids
}

/** Context-relative path of the stream file a doc with this source/channel/timestamp lands in. */
export function streamRelPath(source: string, channel: string, timestamp: string): string {
  const channelDir = channel.replace(/[^a-zA-Z0-9#@_-]/g, '_')
  return join('context', 'streams', source, channelDir, `${timestamp.slice(0, 10)}.md`)
}

/** Whether a stream file already carries a doc with this exact id. */
export function hasDoc(fileText: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<!-- id: ${escaped}(?: |-->)`).test(fileText)
}

/**
 * Doc header: a heading for humans, then one HTML comment carrying every
 * machine field as `key: value` tokens. `id` is always first; `meta` keys
 * follow `thread`. Parsers split on whitespace.
 */
function formatDoc(doc: Doc): string {
  const fields: [string, string][] = [['id', doc.id]]
  if (doc.thread) fields.push(['thread', doc.thread])
  for (const [k, v] of Object.entries(doc.meta ?? {})) {
    if (v && !/\s/.test(v)) fields.push([k, v])
  }
  const lines = ['', `### ${doc.author} — ${doc.timestamp}`, `<!-- ${fields.map(([k, v]) => `${k}: ${v}`).join(' ')} -->`]
  if (doc.permalink) lines.push(`[permalink](${doc.permalink})`)
  lines.push('', doc.text, '')
  return lines.join('\n')
}
