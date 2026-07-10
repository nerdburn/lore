import { readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { Pin } from '../types.js'

const FACTS_HEADER = '# Pinned facts. Written only via `lore remember`.\n'

/**
 * The single write verb (SPEC §6). Appends to context/facts.yaml.
 * Everything else in context/ is derived and regenerable; this file is the
 * only place information lives that exists nowhere else.
 */
export function remember(
  root: string,
  fact: string,
  opts: { category?: string; by?: string; source?: string },
): void {
  const path = join(root, 'context', 'facts.yaml')
  const pins: Pin[] = (parse(readFileSync(path, 'utf8')) as Pin[] | null) ?? []

  const pin: Pin = {
    id: `pin-${String(pins.length + 1).padStart(4, '0')}`,
    fact,
    category: opts.category ?? 'general',
    authorized_by: opts.by ?? userInfo().username,
    date: new Date().toISOString().slice(0, 10),
    ...(opts.source ? { source: opts.source } : {}),
  }
  pins.push(pin)

  writeFileSync(path, FACTS_HEADER + stringify(pins))
  console.log(`pinned ${pin.id}: ${fact}`)
}
