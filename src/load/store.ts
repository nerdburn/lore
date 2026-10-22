import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tryLock } from '../lock.js'
import { buildLoad } from './build.js'
import type { LoadSnapshot } from './schema.js'
import { LOAD_FRESHNESS_PATHS } from './inputs.js'

export const LOAD_FILE = 'context/derived/load.json'
const cache = new Map<string, { signature: string; snapshot: LoadSnapshot }>()

/** One envelope contains events, input checkpoints and coverage: no partial publication. */
export function saveLoad(root: string, snapshot: LoadSnapshot): void {
  const file = join(root, LOAD_FILE)
  mkdirSync(dirname(file), { recursive: true })
  const temp = join(root, `.load-${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(snapshot) + '\n', { mode: 0o600 })
    renameSync(temp, file)
  } finally { rmSync(temp, { force: true }) }
  cache.delete(resolve(file))
}

export function readLoad(root: string): LoadSnapshot {
  const file = resolve(root, LOAD_FILE)
  let stat
  try { stat = statSync(file) } catch { throw new Error('Load has not been built. Run lore load rebuild (or preview historical evidence with lore load rebuild --preview --json).') }
  const signature = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
  const previous = cache.get(file)
  if (previous?.signature === signature) return previous.snapshot
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as LoadSnapshot
  if (snapshot.version !== 1 || ![1, 2, 3].includes(snapshot.extractor) || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.coverage)) throw new Error('Unsupported Load snapshot; use a compatible version of Lore.')
  if (snapshot.semantic && (snapshot.semantic.version !== 1 || !Array.isArray(snapshot.semantic.records) || !snapshot.semantic.checkpoints || typeof snapshot.semantic.checkpoints !== 'object')) throw new Error('Invalid semantic ledger; restore a valid snapshot before rebuilding.')
  cache.delete(file)
  // Queries only retain small snapshots; larger files are read without retaining.
  if (stat.size <= 8 * 1024 * 1024) cache.set(file, { signature, snapshot })
  while (cache.size > 4) cache.delete(cache.keys().next().value!)
  return snapshot
}

export function rebuildLoad(root: string): LoadSnapshot {
  const lock = tryLock(join(root, '.load.lock'))
  if (!lock) throw new Error('Load is already rebuilding for this context')
  try {
    const previous = optionalLoad(root)
    const result = buildLoad(root, undefined, previous?.semantic)
    if (previous?.fingerprint === result.fingerprint && previous.extractor === result.extractor) return previous
    saveLoad(root, result)
    return result
  } finally { lock.release() }
}

/** Corrupt snapshots must not silently discard the semantic ledger. */
export const optionalLoad = (root: string): LoadSnapshot | undefined => existsSync(join(root, LOAD_FILE)) ? readLoad(root) : undefined

/** Freshness checks never parse source history or rebuild on the query path. */
export function loadFreshness(root: string, snapshot: LoadSnapshot): 'current' | 'stale' | 'unknown' {
  if (snapshot.extractor !== 3) return 'stale'
  if (!snapshot.input_revision) return 'unknown'
  try {
    const changed = execFileSync('git', ['-C', root, 'diff', '--name-only', snapshot.input_revision, '--', ...LOAD_FRESHNESS_PATHS], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    // Includes working-tree edits; the projection records the committed input.
    return changed.trim() ? 'stale' : 'current'
  } catch { return 'unknown' }
}
