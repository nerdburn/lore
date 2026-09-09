import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2) + '\n')
}
