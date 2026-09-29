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

/**
 * Who a ticket may be assigned to on the board: everyone already assigned
 * somewhere in the project (Jira/GitHub/Linear names included) and the
 * people in lore.json `client.contacts`. The board offers only these — no
 * free text — so a typo can't create a phantom assignee.
 */
export function assigneeOptions(config: LoreConfig, items: Pick<LoreWorkItem, 'assignee'>[], people: string[] = []): string[] {
  const names = new Set<string>()
  for (const i of items) if (i.assignee?.trim()) names.add(i.assignee.trim())
  for (const c of config.client?.contacts ?? []) if (c.name.trim()) names.add(c.name.trim())
  for (const p of people) if (p.trim()) names.add(p.trim())
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * How a board member appears as an assignee: their name in the project's
 * contacts when they're listed there (so it matches what Jira/Linear
 * mirrored in), else their profile name, else their email.
 */
export function assigneeName(config: LoreConfig, email: string, profileName?: string | null): string {
  const id = email.trim().toLowerCase()
  const contact = config.client?.contacts.find((c) => [c.email, ...(c.aliases ?? [])].some(e => e.trim().toLowerCase() === id))
  return contact?.name.trim() || profileName?.trim() || id
}

/** Resolve explicit identity links only; never guess a person from an email's local part. */
export function assigneeResolver(config: LoreConfig, profiles: Record<string, { name?: string }>, shared: LoreConfig[] = []): (who: string) => string {
  const contacts = [config, ...shared].flatMap(c => c.client?.contacts ?? [])
  const emails = new Set([...Object.keys(profiles), ...contacts.flatMap(c => [c.email, ...(c.aliases ?? [])])].map(e => e.trim().toLowerCase()))
  const byEmail = new Map<string, string>()
  for (const email of emails) {
    const matches = contacts.filter(c => [c.email, ...(c.aliases ?? [])].some(e => e.trim().toLowerCase() === email))
    const names = [...new Set(matches.map(c => c.name.trim()).filter(Boolean))]
    const primaryEmails = [...new Set(matches.map(c => c.email.trim().toLowerCase()))]
    const primary = primaryEmails.length === 1 ? primaryEmails[0] : email
    byEmail.set(email, assigneeName(config, primary, profiles[primary]?.name || (names.length === 1 ? names[0] : undefined)))
  }
  // Names are aliases only when they identify one email, so two people with
  // the same display name aren't silently merged.
  const aliases = new Map<string, Set<string>>()
  const add = (name: string | undefined, email: string) => {
    if (!name?.trim()) return
    const key = name.trim().toLowerCase()
    const ids = aliases.get(key) ?? new Set<string>()
    ids.add(email.trim().toLowerCase())
    aliases.set(key, ids)
  }
  for (const c of contacts) add(c.name, c.email)
  for (const [email, p] of Object.entries(profiles)) add(p.name, email)
  return who => {
    const key = who.trim().toLowerCase()
    if (byEmail.has(key)) return byEmail.get(key)!
    const ids = aliases.get(key)
    return ids?.size === 1 ? byEmail.get([...ids][0])! : who.trim()
  }
}

/** The tracker table at HEAD of the bare repo — always current, no clone involved. */
export function bareWorkItems(reposDir: string, p: BareProject): { prefix: string; items: LoreWorkItem[] } {
  const prefix = workPrefix(p.config)
  return { prefix, items: parseWorkItems(gitShow(join(reposDir, `${p.context}.git`), workFile(prefix), true)) }
}
