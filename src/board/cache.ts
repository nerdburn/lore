import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// One parsed value per file, bounded across all repos. Raw byte size is a
// conservative bookkeeping proxy, not a measurement of parsed heap usage.
const MAX_FILES = 128
const MAX_BYTES = 16 * 1024 * 1024
const cache = new Map<string, { oid: string; value: unknown; bytes: number }>()
let bytes = 0

/**
 * Read a parsed file by its current Git blob ID. Checking on every read keeps
 * access revocations and writes immediate, while unrelated commits reuse the
 * parsed value. Read the pinned blob so a concurrent push cannot mislabel it.
 * Returned values are shared: callers must not mutate them.
 */
export function cachedBoardFile<T>(dir: string, path: string, parse: (text: string) => T): T {
  const key = JSON.stringify([resolve(dir), path])
  const previous = cache.get(key)
  try {
    const oid = execFileSync('git', ['-C', dir, 'rev-parse', '--verify', `HEAD:${path}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    if (previous?.oid === oid) {
      cache.delete(key)
      cache.set(key, previous)
      return previous.value as T
    }
    const raw = execFileSync('git', ['-C', dir, 'cat-file', 'blob', oid], {
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    })
    const value = parse(raw.toString())
    if (previous) { cache.delete(key); bytes -= previous.bytes }
    if (raw.length <= MAX_BYTES) {
      cache.set(key, { oid, value, bytes: raw.length })
      bytes += raw.length
      while (cache.size > MAX_FILES || bytes > MAX_BYTES) {
        const oldest = cache.keys().next().value!
        bytes -= cache.get(oldest)!.bytes
        cache.delete(oldest)
      }
    }
    return value
  } catch (err) {
    // Never serve stale permissions or tickets when a file disappears or fails.
    if (cache.delete(key)) bytes -= previous!.bytes
    throw err
  }
}
