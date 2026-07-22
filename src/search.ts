import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface Match {
  /** Path relative to the context root, e.g. "context/streams/slack/#acme/2026-07-01.md" */
  file: string
  line: number
  text: string
}

export interface GrepOptions {
  ignoreCase?: boolean
  /** Substring filter on the file path (e.g. a channel name). */
  path?: string
  /** Stop after this many matches. */
  limit?: number
}

/**
 * Search every text file under context/. Pattern is a JS regex; if it
 * doesn't compile, it's treated as a literal string. No index — at lore's
 * scale (thousands of small markdown files) a linear scan is instant.
 */
export function grepContext(root: string, pattern: string, opts: GrepOptions = {}): Match[] {
  const flags = opts.ignoreCase ? 'i' : ''
  let re: RegExp
  try {
    re = new RegExp(pattern, flags)
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  }

  const limit = opts.limit ?? 100
  const matches: Match[] = []
  for (const file of walk(join(root, 'context'))) {
    const rel = relative(root, file)
    if (opts.path && !rel.toLowerCase().includes(opts.path.toLowerCase())) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push({ file: rel, line: i + 1, text: lines[i].trim() })
        if (matches.length >= limit) return matches
      }
    }
  }
  return matches
}

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries.sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (/\.(md|ya?ml)$/.test(entry)) yield path
  }
}
