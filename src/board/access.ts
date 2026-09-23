import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gitShow } from '../bare.js'
import { configSchema, type LoreConfig } from '../config.js'
import { parseWorkItems, workFile, workPrefix, type LoreWorkItem } from '../work.js'

/**
 * Who may see which board. Two roles per project, from lore.json `board`:
 * members create, edit and move tickets; viewers only look. Host admins
 * (LORE_BOARD_ADMINS) are members of every project whose board is enabled —
 * a disabled board has no web view for anyone. An archived client's board
 * is read-only for everybody, as its memory is.
 */
export type BoardRole = 'member' | 'viewer'

export function principalMatches(entry: string, email: string): boolean {
  const e = entry.trim().toLowerCase()
  return e.startsWith('@') ? email.endsWith(e) : e === email
}

export function boardRole(config: LoreConfig, email: string, admins: string[] = []): BoardRole | undefined {
  const board = config.board
  if (!board?.enabled) return undefined
  let role: BoardRole | undefined
  if (admins.includes(email) || board.members.some((m) => principalMatches(m, email))) role = 'member'
  else if (board.viewers.some((v) => principalMatches(v, email))) role = 'viewer'
  if (role && config.lifecycle === 'archived') role = 'viewer'
  return role
}

export const CONTEXT_RE = /^[\w.-]+$/

export interface BareProject {
  context: string
  config: LoreConfig
}

/** Every context repo on the host with a readable lore.json at HEAD. */
export function bareProjects(reposDir: string): BareProject[] {
  if (!existsSync(reposDir)) return []
  const out: BareProject[] = []
  for (const entry of readdirSync(reposDir).sort()) {
    if (!entry.endsWith('.git')) continue
    const p = bareProject(reposDir, basename(entry, '.git'))
    if (p) out.push(p)
  }
  return out
}

export function bareProject(reposDir: string, context: string): BareProject | undefined {
  if (!CONTEXT_RE.test(context)) return undefined
  const dir = join(reposDir, `${context}.git`)
  if (!existsSync(dir)) return undefined
  try {
    return { context, config: configSchema.parse(JSON.parse(gitShow(dir, 'lore.json'))) }
  } catch {
    return undefined
  }
}

/** The tracker table at HEAD of the bare repo — always current, no clone involved. */
export function bareWorkItems(reposDir: string, p: BareProject): { prefix: string; items: LoreWorkItem[] } {
  const prefix = workPrefix(p.config)
  return { prefix, items: parseWorkItems(gitShow(join(reposDir, `${p.context}.git`), workFile(prefix), true)) }
}
