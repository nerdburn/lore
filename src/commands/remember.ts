import { readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { git, resolveContext, type ResolveOptions } from '../context.js'
import type { Pin } from '../types.js'

const FACTS_HEADER = '# Pinned facts. Written only via `lore remember`.\n'

/**
 * The single write verb (SPEC §6). Appends to context/facts.yaml.
 * Everything else in context/ is derived and regenerable; this file is the
 * only place information lives that exists nowhere else. In cache mode the
 * pin is committed and pushed immediately — a fact that only exists in a
 * local cache clone isn't remembered, it's misplaced.
 */
export function remember(
  cwd: string,
  fact: string,
  opts: ResolveOptions & { category?: string; by?: string; source?: string },
): void {
  const ctx = resolveContext(cwd, opts)
  const path = join(ctx.root, 'context', 'facts.yaml')
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

  if (ctx.mode === 'cache') {
    git(ctx.root, 'add', 'context/facts.yaml')
    git(ctx.root, 'commit', '--quiet', '-m', `lore: remember ${pin.id} (${pin.category})`)
    try {
      git(ctx.root, 'push', '--quiet')
    } catch {
      throw new Error(`pinned ${pin.id} and committed to the cache, but push to ${ctx.repo} failed — check access, then run \`git -C ${ctx.root} push\``)
    }
  }

  console.log(`pinned ${pin.id}: ${fact}${ctx.repo ? ` → ${ctx.repo}` : ''}`)
}
