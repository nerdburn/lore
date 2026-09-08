import { readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { AUDIT_FILE, appendAudit } from '../audit.js'
import { git, resolveContext, type ResolveOptions } from '../context.js'
import type { Pin } from '../types.js'

const FACTS_HEADER = '# Pinned facts. Written only via `lore remember`.\n'

export interface RememberOptions extends ResolveOptions {
  category?: string
  /** CLI only: who authorized this. MCP callers can never set it. */
  by?: string
  source?: string
  via?: 'cli' | 'mcp'
}

/**
 * The single write verb (SPEC §6). Appends to context/facts.yaml and records
 * an audit entry. Everything else in context/ is derived and regenerable;
 * this file is the only place information lives that exists nowhere else.
 * In cache mode the pin is committed and pushed immediately — a fact that
 * only exists in a local cache clone isn't remembered, it's misplaced.
 *
 * Write access: when lore.json has `write.allow`, the actor must be listed.
 * That is an honesty check on a shared machine, not authentication — the
 * actor is the OS identity, and anyone who can push to the context repo can
 * bypass it. Real authorization is a remote-MCP concern (backlog §16).
 */
export function remember(cwd: string, fact: string, opts: RememberOptions): Pin {
  const ctx = resolveContext(cwd, opts)
  if (ctx.config.lifecycle === 'archived') {
    throw new Error(`${ctx.config.project} is archived — its memory is read-only (\`lore archive --restore\` to reopen)`)
  }
  const via = opts.via ?? 'cli'
  const actor = via === 'cli' && opts.by ? opts.by : userInfo().username

  const allow = ctx.config.write?.allow
  if (allow && !allow.includes(actor)) {
    throw new Error(`"${actor}" is not in lore.json write.allow — pin refused`)
  }

  const path = join(ctx.root, 'context', 'facts.yaml')
  const pins: Pin[] = (parse(readFileSync(path, 'utf8')) as Pin[] | null) ?? []

  const pin: Pin = {
    id: nextPinId(pins),
    fact,
    category: opts.category ?? 'general',
    authorized_by: actor,
    date: new Date().toISOString().slice(0, 10),
    ...(opts.source ? { source: opts.source } : {}),
  }
  pins.push(pin)

  writeFileSync(path, FACTS_HEADER + stringify(pins))
  appendAudit(ctx.root, {
    at: new Date().toISOString(),
    action: 'remember',
    actor,
    via,
    id: pin.id,
    ...(opts.source ? { source: opts.source } : {}),
  })

  if (ctx.mode === 'cache') {
    git(ctx.root, 'add', 'context/facts.yaml', AUDIT_FILE)
    git(ctx.root, 'commit', '--quiet', '-m', `lore: remember ${pin.id} (${pin.category})`)
    try {
      git(ctx.root, 'push', '--quiet')
    } catch {
      throw new Error(`pinned ${pin.id} and committed to the cache, but push to ${ctx.repo} failed — check access, then run \`git -C ${ctx.root} push\``)
    }
  }

  if (via === 'cli') console.log(`pinned ${pin.id}: ${fact}${ctx.repo ? ` → ${ctx.repo}` : ''}`)
  return pin
}

/** pin-0001, pin-0002… continuing from the highest existing id, so a deleted
 * pin never causes an id to be reused. */
function nextPinId(pins: Pin[]): string {
  let max = 0
  for (const p of pins) {
    const n = Number(/^pin-(\d+)$/.exec(p.id)?.[1])
    if (n > max) max = n
  }
  return `pin-${String(max + 1).padStart(4, '0')}`
}
