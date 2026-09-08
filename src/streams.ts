import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

  for (const doc of sorted) {
    const day = doc.timestamp.slice(0, 10)
    const channelDir = doc.channel.replace(/[^a-zA-Z0-9#@_-]/g, '_')
    const path = join(root, 'context', 'streams', doc.source, channelDir, `${day}.md`)

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
