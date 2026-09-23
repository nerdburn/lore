import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendAudit } from '../audit.js'
import { boardPrincipal, CONFIG_FILE, configSchema, type LoreConfig } from '../config.js'
import { resolveContext, type ResolveOptions } from '../context.js'
import { authorizeWrite } from '../write.js'
import { commitWork } from './work.js'

/**
 * `lore board` — the per-project switch and guest list for the web board
 * (`lore www` with LORE_BOARD=1). Edits lore.json `board`, commits, pushes;
 * the host reads lore.json at HEAD on every request, so no restart.
 *
 *   lore board enable  --context lore-acme
 *   lore board add jane@acme.com @acme.com --viewer --context lore-acme
 *   lore board add dev@inputlogic.ca --context lore-acme          # member (default)
 *   lore board remove jane@acme.com --context lore-acme
 *   lore board show --context lore-acme
 */
export interface BoardCommandOptions extends ResolveOptions {
  by?: string
  json?: boolean
}

type Board = NonNullable<LoreConfig['board']>

export function boardEnable(cwd: string, enabled: boolean, opts: BoardCommandOptions = {}): Board {
  return edit(cwd, opts, enabled ? 'enable' : 'disable', (b) => {
    b.enabled = enabled
  })
}

export function boardAdd(cwd: string, entries: string[], role: 'member' | 'viewer', opts: BoardCommandOptions = {}): Board {
  const clean = parseEntries(entries)
  return edit(cwd, opts, `add ${role} ${clean.join(', ')}`, (b) => {
    // One role per person: adding as a viewer takes them off members, and vice versa.
    const other = role === 'member' ? 'viewers' : 'members'
    b[other] = b[other].filter((e) => !clean.includes(e))
    const list = role === 'member' ? 'members' : 'viewers'
    b[list] = [...new Set([...b[list], ...clean])].sort()
  })
}

export function boardRemove(cwd: string, entries: string[], opts: BoardCommandOptions = {}): Board {
  const clean = parseEntries(entries)
  return edit(cwd, opts, `remove ${clean.join(', ')}`, (b) => {
    const before = b.members.length + b.viewers.length
    b.members = b.members.filter((e) => !clean.includes(e))
    b.viewers = b.viewers.filter((e) => !clean.includes(e))
    if (b.members.length + b.viewers.length === before) throw new Error(`board: ${clean.join(', ')} not on the board`)
  })
}

export function boardShow(cwd: string, opts: BoardCommandOptions = {}): Board {
  const ctx = resolveContext(cwd, opts)
  const b = ctx.config.board ?? { enabled: false, members: [], viewers: [] }
  if (opts.json) console.log(JSON.stringify(b, null, 2))
  else {
    console.log(`${ctx.config.project}: board ${b.enabled ? 'enabled' : 'disabled'}`)
    console.log(`members: ${b.members.join(', ') || '(none — host admins only)'}`)
    console.log(`viewers: ${b.viewers.join(', ') || '(none)'}`)
  }
  return b
}

function parseEntries(entries: string[]): string[] {
  const out = entries.flatMap((e) => e.split(',')).map((e) => e.trim()).filter(Boolean)
  if (out.length === 0) throw new Error('board: give at least one email or @domain')
  return out.map((e) => {
    const r = boardPrincipal.safeParse(e)
    if (!r.success) throw new Error(`board: "${e}" is not an email or @domain`)
    return r.data
  })
}

function edit(cwd: string, opts: BoardCommandOptions, what: string, fn: (b: Board) => void): Board {
  const ctx = resolveContext(cwd, opts)
  const actor = authorizeWrite(ctx, { ...opts, via: 'cli' }, 'board change')
  const path = join(ctx.root, CONFIG_FILE)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const board = configSchema.parse(raw).board ?? { enabled: false, members: [], viewers: [] }
  fn(board)
  raw.board = board
  configSchema.parse(raw)
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n')
  appendAudit(ctx.root, { at: new Date().toISOString(), action: 'board', actor, via: 'cli', id: what })
  commitWork(ctx, CONFIG_FILE, `lore: board ${what}`)
  console.log(`${ctx.config.project}: board ${what}${ctx.repo ? ` → ${ctx.repo}` : ''}`)
  return board
}
