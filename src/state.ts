import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Cursor } from './types.js'

export const STATE_FILE = 'state.json'

export interface LoreState {
  cursors: Record<string, Cursor>
  lastSync?: string
  lastExtract?: string
}

export function loadState(root: string): LoreState {
  const path = join(root, STATE_FILE)
  if (!existsSync(path)) return { cursors: {} }
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function saveState(root: string, state: LoreState): void {
  writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2) + '\n')
}
