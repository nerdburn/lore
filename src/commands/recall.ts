import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { resolveContext, type ResolveOptions } from '../context.js'
import type { Pin } from '../types.js'

/**
 * Read back the structured layers: pinned facts plus whatever derived
 * artifacts exist (requests, decisions, roadmap). Streams are for `grep`;
 * this is for "what do we know" without a search term.
 */
export function recall(cwd: string, category: string | undefined, opts: ResolveOptions & { json?: boolean }): void {
  const ctx = resolveContext(cwd, opts)

  const pins = ((parse(readFileSync(join(ctx.root, 'context/facts.yaml'), 'utf8')) as Pin[] | null) ?? []).filter(
    (p) => !category || p.category === category,
  )

  const derived: Record<string, unknown> = {}
  const derivedDir = join(ctx.root, 'context/derived')
  if (existsSync(derivedDir)) {
    for (const entry of readdirSync(derivedDir)) {
      if (!/\.ya?ml$/.test(entry)) continue
      const name = entry.replace(/\.ya?ml$/, '')
      if (category && name !== category) continue
      derived[name] = parse(readFileSync(join(derivedDir, entry), 'utf8'))
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ project: ctx.config.project, pins, derived }, null, 2))
    return
  }

  if (pins.length === 0 && Object.keys(derived).length === 0) {
    console.log(category ? `nothing recalled for category "${category}"` : 'nothing pinned or derived yet')
    return
  }
  for (const pin of pins) {
    console.log(`[${pin.category}] ${pin.fact}  (${pin.id}, ${pin.authorized_by}, ${pin.date})`)
  }
  for (const [name, items] of Object.entries(derived)) {
    console.log(`\n## ${name}`)
    console.log(typeof items === 'string' ? items : JSON.stringify(items, null, 2))
  }
}
