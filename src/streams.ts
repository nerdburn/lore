import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Doc } from './types.js'

/**
 * Write docs into context/streams/<source>/<channel>/<YYYY-MM-DD>.md.
 * Append-only and idempotent: a doc whose id already appears in the
 * target file is skipped, so re-syncing an overlapping window is safe.
 */
export function writeDocs(root: string, docs: Doc[]): { written: number; skipped: number } {
  let written = 0
  let skipped = 0
  const sorted = [...docs].sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  for (const doc of sorted) {
    const day = doc.timestamp.slice(0, 10)
    const channelDir = doc.channel.replace(/[^a-zA-Z0-9#@_-]/g, '_')
    const path = join(root, 'context', 'streams', doc.source, channelDir, `${day}.md`)

    if (existsSync(path)) {
      if (readFileSync(path, 'utf8').includes(`id: ${doc.id}`)) {
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

    appendFileSync(path, formatDoc(doc))
    written++
  }
  return { written, skipped }
}

function formatDoc(doc: Doc): string {
  const lines = [
    '',
    `### ${doc.author} — ${doc.timestamp}`,
    `<!-- id: ${doc.id}${doc.thread ? ` thread: ${doc.thread}` : ''} -->`,
  ]
  if (doc.permalink) lines.push(`[permalink](${doc.permalink})`)
  lines.push('', doc.text, '')
  return lines.join('\n')
}
