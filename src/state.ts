import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tryLock } from './lock.js'
import type { Cursor } from './types.js'

export const STATE_FILE = 'state.json'

/** Per-source sync health. Operators read this; `lore check` prints it. */
export interface SourceHealth {
  /** ISO 8601 of the last time sync tried this source. */
  lastAttempt: string
  /** ISO 8601 of the last fully successful sync (no errors). */
  lastSuccess?: string
  /** The most recent failure, cleared on the next full success. */
  lastError?: { at: string; message: string }
}

export interface LoreState {
  cursors: Record<string, Cursor>
  sources?: Record<string, SourceHealth>
  lastSync?: string
  lastExtract?: string
  /**
   * Stream files the fold has already consumed, by path relative to the
   * context root → byte length when folded. A file whose length differs is
   * new material (appended docs, a late thread reply, a source added with
   * older dates). Replaces the old day-window, which missed all of those.
   */
  extracted?: Record<string, number>
}

export function loadState(root: string): LoreState {
  const path = join(root, STATE_FILE)
  if (!existsSync(path)) return { cursors: {} }
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function saveState(root: string, state: LoreState): void {
  const path = join(root, STATE_FILE)
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2) + '\n')
  renameSync(`${path}.tmp`, path)
}

/**
 * Write only the keys this caller owns, re-reading the file first so a
 * concurrent writer's keys survive. sync owns cursors/sources/lastSync and
 * extract owns extracted/lastExtract; run-all lets a sync-now run overlap an
 * in-flight fold on the same clone, and this is what keeps them from
 * clobbering each other's half of state.json. A short lock serialises the
 * read-modify-write itself. Returns the merged state.
 */
export function updateState(root: string, patch: Partial<LoreState>): LoreState {
  const lockPath = join(root, `${STATE_FILE}.lock`)
  const deadline = Date.now() + 10_000
  let lock = tryLock(lockPath)
  while (!lock) {
    if (Date.now() > deadline) throw new Error(`state.json is locked (${lockPath})`)
    spin(50)
    lock = tryLock(lockPath)
  }
  try {
    const merged = { ...loadState(root), ...patch }
    saveState(root, merged)
    return merged
  } finally {
    lock.release()
  }
}

function spin(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
