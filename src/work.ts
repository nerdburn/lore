import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { LoreConfig } from './config.js'
import { readWorkTable as readGithubTable, type WorkItem as GithubItem } from './connectors/github.js'
import { readWorkTable as readJiraTable, type JiraWorkItem } from './connectors/jira.js'

/**
 * The lore work tracker — `context/work/lore/<PREFIX>.yaml`.
 *
 * Lore is the tracker of record for every project. Jira and GitHub Issues
 * are inputs: `lore sync` mirrors their open issues into this table
 * (`mirrorExternal`) and records each later tracker change as evidence; the
 * fold then reviews items against the whole conversation and may move,
 * reprioritise or re-rank them when the evidence is unambiguous
 * (`applyFoldChanges`); people and agents write through `lore work` and the
 * MCP tools. Whoever moves an item, the move lands in its `history` with
 * who, when, through which surface, why, and the evidence — the paper trail
 * that makes an inferred status trustworthy and, later, lets `lore push`
 * write lore's state back to the external tracker.
 *
 * File order is rank. `state` is derived from `status` so recall's counts
 * (open vs closed) work on this table exactly as on the external ones.
 * Deliberately absent: estimates and SOW weeks — tickets are delivery
 * tracking, not capacity burn.
 */

export const WORK_DIR = 'context/work/lore'

export type WorkStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'archived'
export const WORK_STATUSES: WorkStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'archived']
export type WorkPriority = 'P1' | 'P2' | 'P3'
export const WORK_PRIORITIES: WorkPriority[] = ['P1', 'P2', 'P3']
/** The surface a change came through. `web` = the board (`lore www`); `sync` = mirrored from a tracker; `fold` = the LLM's inference. */
export type WorkVia = 'cli' | 'mcp' | 'web' | 'sync' | 'fold'
export type WorkState = 'open' | 'closed'

export interface ExternalRef {
  system: 'jira' | 'github'
  /** Stable identity for matching: "jira:INPT-123", "github:owner/repo#42". */
  id: string
  /** The tracker's own key: "INPT-123", "#42". */
  key: string
  url: string
  /** The tracker's status name as last seen ("In Review", "open"). */
  status: string
  /** The tracker's coarse state: Jira status category, GitHub open/closed. */
  category: string
  /** The tracker's own labels as last mirrored — so sync can tell them from labels added in lore. */
  labels?: string[]
}

export interface WorkHistoryEntry {
  /** ISO 8601. */
  at: string
  /** OS user / --by; "lore-sync" for mirroring; "lore-extract" for the fold. */
  by: string
  via: WorkVia
  /** What changed: `{created: true}` or `{field: [from, to]}` per field. */
  change: Record<string, unknown>
  reason: string
  sources?: string[]
  confidence?: 'high'
  /** For fold changes: the date of the evidence, so a later human decision is not overridden. */
  evidence_date?: string
}

export interface LoreWorkItem {
  key: string
  title: string
  /** Optional markdown body — what the ticket is, for people reading it on the board. */
  description?: string
  status: WorkStatus
  state: WorkState
  priority?: WorkPriority
  assignee?: string
  labels: string[]
  /** The derived request this was promoted from. */
  request?: string
  external?: ExternalRef
  sources: string[]
  /** ISO dates. */
  created: string
  updated: string
  history: WorkHistoryEntry[]
}

/** Recall's compact view: no history, just who last touched it and why. */
export interface WorkItemSummary extends Omit<LoreWorkItem, 'history'> {
  last?: { at: string; by: string; via: WorkVia; reason: string }
  /** Lore and the external tracker disagree on done-ness — what a write-back would act on. */
  drift?: boolean
}

export const HUMAN_VIAS: WorkVia[] = ['cli', 'mcp', 'web']

// ---- prefix / file ----

/** "CareMobi" → "CAR", "Coffee Contracts" → "CC", "Jointly" → "JOI". */
export function deriveWorkPrefix(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  let p = (words.length >= 2 ? words.map((w) => w[0]).join('').slice(0, 6) : (words[0] ?? '').slice(0, 3)).toUpperCase()
  p = p.replace(/^[^A-Z]+/, '')
  while (p.length < 2) p += 'L'
  return p.slice(0, 6)
}

export function workPrefix(config: Pick<LoreConfig, 'project' | 'client' | 'work'>): string {
  return config.work?.prefix ?? deriveWorkPrefix(config.client?.name ?? config.project)
}

export function workFile(prefix: string): string {
  return `${WORK_DIR}/${prefix}.yaml`
}

export function stateFor(status: WorkStatus): WorkState {
  return status === 'done' || status === 'archived' ? 'closed' : 'open'
}

export function readWorkItems(root: string, prefix: string): LoreWorkItem[] {
  const path = join(root, workFile(prefix))
  return existsSync(path) ? parseWorkItems(readFileSync(path, 'utf8')) : []
}

/** A tracker table's text → items, tolerating a missing or malformed file (e.g. read from an old commit). */
export function parseWorkItems(text: string): LoreWorkItem[] {
  let parsed: unknown
  try {
    parsed = parse(text.replace(/^(#.*\n)+/, ''))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return (parsed as Partial<LoreWorkItem>[])
    .filter((i) => typeof i?.key === 'string' && typeof i.title === 'string')
    .map((i) => {
      const status = (WORK_STATUSES as string[]).includes(String(i.status)) ? (i.status as WorkStatus) : 'todo'
      return {
        ...i,
        key: i.key!,
        title: i.title!,
        status,
        state: stateFor(status),
        labels: Array.isArray(i.labels) ? i.labels.map(String) : [],
        sources: Array.isArray(i.sources) ? i.sources.map(String) : [],
        history: Array.isArray(i.history) ? (i.history as WorkHistoryEntry[]) : [],
        created: String(i.created ?? ''),
        updated: String(i.updated ?? ''),
      }
    })
}

export function writeWorkItems(root: string, prefix: string, items: LoreWorkItem[]): string {
  const rel = workFile(prefix)
  mkdirSync(join(root, WORK_DIR), { recursive: true })
  for (const i of items) i.state = stateFor(i.status)
  writeFileSync(
    join(root, rel),
    `# Lore work tracker (${prefix}) — the tracker of record. Written by \`lore work\`, by \`lore sync\` (mirroring Jira/GitHub) and by the fold.\n` +
      `# Never hand-edit: every change goes through a command so it lands in the item's history. File order is rank.\n` +
      stringify(items),
  )
  return rel
}

/** CAR-1, CAR-2… continuing from the highest existing key; a deleted or archived key is never reused. */
export function nextKey(items: LoreWorkItem[], prefix: string): string {
  let max = 0
  for (const i of items) {
    const n = Number(new RegExp(`^${prefix}-(\\d+)$`).exec(i.key)?.[1])
    if (n > max) max = n
  }
  return `${prefix}-${max + 1}`
}

export function findItem(items: LoreWorkItem[], key: string): LoreWorkItem | undefined {
  const k = key.trim().toUpperCase()
  return items.find((i) => i.key.toUpperCase() === k)
}

// ---- changes ----

export type WorkFields = Partial<Pick<LoreWorkItem, 'status' | 'priority' | 'title' | 'description' | 'assignee' | 'labels'>>

export interface ChangeMeta {
  at: string
  by: string
  via: WorkVia
  reason: string
  sources?: string[]
  confidence?: 'high'
  evidence_date?: string
}

/**
 * Apply field changes and record them as one history entry. Returns the
 * `{field: [from, to]}` record actually applied — empty when nothing
 * differed, in which case no history is written.
 */
export function applyChange(item: LoreWorkItem, fields: WorkFields, meta: ChangeMeta, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const change: Record<string, unknown> = { ...extra }
  for (const [field, to] of Object.entries(fields) as [keyof WorkFields, unknown][]) {
    if (to === undefined) continue
    const from = item[field]
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) continue
    change[field] = [from ?? null, to]
    ;(item as unknown as Record<string, unknown>)[field] = to
  }
  if (Object.keys(change).length === 0) return change
  if (fields.status) item.state = stateFor(fields.status)
  for (const s of meta.sources ?? []) if (!item.sources.includes(s)) item.sources.push(s)
  item.updated = meta.at.slice(0, 10)
  item.history.push({
    at: meta.at,
    by: meta.by,
    via: meta.via,
    change,
    reason: meta.reason,
    ...(meta.sources?.length ? { sources: meta.sources } : {}),
    ...(meta.confidence ? { confidence: meta.confidence } : {}),
    ...(meta.evidence_date ? { evidence_date: meta.evidence_date } : {}),
  })
  return change
}

export interface RankTarget {
  above?: string
  top?: boolean
  bottom?: boolean
}

/** Move `key` in the rank (file order); records `{rank: [from, to]}` (1-based). */
export function rankItem(items: LoreWorkItem[], key: string, target: RankTarget, meta: ChangeMeta): Record<string, unknown> {
  const from = items.findIndex((i) => i.key.toUpperCase() === key.trim().toUpperCase())
  if (from < 0) throw new Error(`work: no item ${key}`)
  const [item] = items.splice(from, 1)
  let to: number
  if (target.top) to = 0
  else if (target.bottom) to = items.length
  else if (target.above) {
    to = items.findIndex((i) => i.key.toUpperCase() === target.above!.trim().toUpperCase())
    if (to < 0) {
      items.splice(from, 0, item)
      throw new Error(`work: no item ${target.above} to rank above`)
    }
  } else {
    items.splice(from, 0, item)
    throw new Error('work: give --above <key>, --top, or --bottom')
  }
  items.splice(to, 0, item)
  if (to === from) return {}
  return applyChange(item, {}, meta, { rank: [from + 1, to + 1] })
}

/** When a person (CLI/MCP) last changed `field` on this item, if ever. */
export function lastHumanChange(item: LoreWorkItem, field: string): string | undefined {
  let at: string | undefined
  for (const h of item.history) {
    if (!HUMAN_VIAS.includes(h.via)) continue
    if (!(field in h.change) && !h.change.created) continue
    if (!at || h.at > at) at = h.at
  }
  return at
}

export function summarizeForRecall(item: LoreWorkItem): WorkItemSummary {
  const { history: hist, ...rest } = item
  const history = Array.isArray(hist) ? hist : []
  const last = history[history.length - 1]
  const drift = item.external ? externalDone(item.external) !== (item.status === 'done') && item.status !== 'archived' : false
  return {
    ...rest,
    ...(last ? { last: { at: last.at, by: last.by, via: last.via, reason: last.reason } } : {}),
    ...(drift ? { drift: true } : {}),
  }
}

// ---- mirroring external trackers ----

function externalDone(ext: Pick<ExternalRef, 'system' | 'category'>): boolean {
  return ext.system === 'github' ? ext.category === 'closed' : /^done$/i.test(ext.category)
}

/** Tracker state → lore status. A status named "Blocked" or a "blocked" label wins while the item is open. */
export function mapExternalStatus(ext: Pick<ExternalRef, 'system' | 'category' | 'status'>, labels: string[]): WorkStatus {
  if (externalDone(ext)) return 'done'
  if (/block/i.test(ext.status) || labels.some((l) => /^blocked$/i.test(l))) return 'blocked'
  if (ext.system === 'jira' && /in progress/i.test(ext.category)) return 'in_progress'
  return 'todo'
}

export function mapPriority(raw: string | undefined, labels: string[] = []): WorkPriority | undefined {
  const label = labels.find((l) => /^p[123]$/i.test(l))
  if (label) return label.toUpperCase() as WorkPriority
  if (!raw) return undefined
  if (/^(highest|high|urgent|critical|blocker)$/i.test(raw)) return 'P1'
  if (/^(medium|normal)$/i.test(raw)) return 'P2'
  if (/^(low|lowest|minor|trivial)$/i.test(raw)) return 'P3'
  return undefined
}

interface ExternalIssue {
  ref: ExternalRef
  title: string
  labels: string[]
  assignee?: string
  priority?: WorkPriority
}

/** Every issue the external tables currently hold (GitHub issues, not PRs; every Jira issue). */
export function readExternalIssues(root: string): ExternalIssue[] {
  const out: ExternalIssue[] = []
  const ghDir = join(root, 'context/work/github')
  if (existsSync(ghDir)) {
    for (const entry of readdirSync(ghDir).sort()) {
      if (!/\.ya?ml$/.test(entry)) continue
      const repo = entry.replace(/\.ya?ml$/, '').replace('__', '/')
      for (const i of readGithubTable(readFileSync(join(ghDir, entry), 'utf8')) as GithubItem[]) {
        if (i.type !== 'issue') continue
        out.push({
          ref: { system: 'github', id: `github:${repo}#${i.number}`, key: `#${i.number}`, url: i.url, status: i.state, category: i.state },
          title: i.title,
          labels: i.labels ?? [],
          assignee: i.assignees?.[0],
          priority: mapPriority(undefined, i.labels ?? []),
        })
      }
    }
  }
  const jiraDir = join(root, 'context/work/jira')
  if (existsSync(jiraDir)) {
    for (const entry of readdirSync(jiraDir).sort()) {
      if (!/\.ya?ml$/.test(entry)) continue
      for (const i of readJiraTable(readFileSync(join(jiraDir, entry), 'utf8')) as JiraWorkItem[]) {
        out.push({
          ref: { system: 'jira', id: `jira:${i.key}`, key: i.key, url: i.url, status: i.status, category: i.category },
          title: i.title,
          labels: i.labels ?? [],
          assignee: i.assignee,
          priority: mapPriority(i.priority, i.labels ?? []),
        })
      }
    }
  }
  return out
}

export interface MirrorResult {
  prefix: string
  file?: string
  created: number
  updated: number
}

/**
 * Mirror the external trackers into the lore table. New open issues become
 * lore items (status mapped from the tracker); closed issues lore never
 * tracked are skipped — no import of years of history. For a known item,
 * a change in the tracker's status is a new event: lore's status follows
 * it (a fold or human decision stands until the tracker itself moves, and
 * a later tracker move is newer evidence). Title, assignee and labels follow
 * the tracker unless a person set them in lore.
 */
export function mirrorExternal(root: string, config: Pick<LoreConfig, 'project' | 'client' | 'work'>, at = new Date().toISOString()): MirrorResult {
  const prefix = workPrefix(config)
  const issues = readExternalIssues(root)
  const items = readWorkItems(root, prefix)
  if (issues.length === 0 && items.length === 0) return { prefix, created: 0, updated: 0 }
  const byExternal = new Map(items.filter((i) => i.external).map((i) => [i.external!.id, i]))
  let created = 0
  let updated = 0
  for (const issue of issues) {
    const label = `${issue.ref.system === 'jira' ? 'Jira' : 'GitHub'} ${issue.ref.key}`
    const known = byExternal.get(issue.ref.id)
    if (!known) {
      if (externalDone(issue.ref)) continue
      const status = mapExternalStatus(issue.ref, issue.labels)
      const item: LoreWorkItem = {
        key: nextKey(items, prefix),
        title: issue.title,
        status,
        state: stateFor(status),
        ...(issue.priority ? { priority: issue.priority } : {}),
        ...(issue.assignee ? { assignee: issue.assignee } : {}),
        labels: issue.labels,
        external: { ...issue.ref, labels: issue.labels },
        sources: [issue.ref.url],
        created: at.slice(0, 10),
        updated: at.slice(0, 10),
        history: [{ at, by: 'lore-sync', via: 'sync', change: { created: true }, reason: `mirrored from ${label} (${issue.ref.status})`, sources: [issue.ref.url] }],
      }
      items.push(item)
      byExternal.set(issue.ref.id, item)
      created++
      continue
    }
    const fields: WorkFields = {}
    const extra: Record<string, unknown> = {}
    const ext = known.external!
    const moved = ext.status !== issue.ref.status || ext.category !== issue.ref.category
    const mapped = mapExternalStatus(issue.ref, issue.labels)
    if (moved) {
      extra.external_status = [ext.status, issue.ref.status]
      if (mapped !== known.status && known.status !== 'archived') fields.status = mapped
    } else if (mapped !== known.status && known.history.every((h) => h.via === 'sync')) {
      // Lore has never formed its own opinion on this ticket (only sync has
      // touched it), so it simply follows the tracker — this is how a
      // mapping fix reaches tickets mirrored before it.
      fields.status = mapped
    }
    if (issue.title !== known.title && !lastHumanChange(known, 'title')) fields.title = issue.title
    if ((issue.assignee ?? undefined) !== (known.assignee ?? undefined) && !lastHumanChange(known, 'assignee')) fields.assignee = issue.assignee
    const labels = mergeTrackerLabels(known, issue.labels)
    if (JSON.stringify(labels) !== JSON.stringify(known.labels)) fields.labels = labels
    if (issue.priority && issue.priority !== known.priority && !lastHumanChange(known, 'priority')) fields.priority = issue.priority
    known.external = { ...ext, ...issue.ref, labels: issue.labels }
    const reason = moved ? `${label} moved ${ext.status} → ${issue.ref.status}` : `${label} updated`
    const change = applyChange(known, fields, { at, by: 'lore-sync', via: 'sync', reason, sources: [issue.ref.url] }, extra)
    if (Object.keys(change).length > 0) updated++
  }
  if (created === 0 && updated === 0 && existsSync(join(root, workFile(prefix)))) return { prefix, file: workFile(prefix), created, updated }
  return { prefix, file: writeWorkItems(root, prefix, items), created, updated }
}

/**
 * The tracker's labels plus the ones lore added (project labels like
 * "stripe integration" that Jira/GitHub never had). The tracker owns its own
 * labels — one it drops goes — and lore's survive every sync. Items mirrored
 * before `external.labels` was recorded: with no human label change every
 * label came from the tracker; with one, keep them all rather than guess.
 */
export function mergeTrackerLabels(item: Pick<LoreWorkItem, 'labels' | 'history' | 'external'>, tracker: string[]): string[] {
  const before = item.external?.labels ?? (lastHumanChange(item as LoreWorkItem, 'labels') ? [] : item.labels)
  const own = item.labels.filter((l) => !hasLabel(before, l) && !hasLabel(tracker, l))
  return [...tracker, ...own]
}

/** Labels compare case- and space-insensitively: "Stripe Integration" is "stripe  integration". */
export function labelKey(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function hasLabel(labels: string[], label: string): boolean {
  const k = labelKey(label)
  return labels.some((l) => labelKey(l) === k)
}

/** A label as the project already spells it, or cleaned up if it is new. */
export function canonicalLabel(items: Pick<LoreWorkItem, 'labels'>[], label: string): string {
  const k = labelKey(label)
  for (const i of items) for (const l of i.labels) if (labelKey(l) === k) return l
  return label.trim().replace(/\s+/g, ' ')
}

/** Every label in the table with how many open and closed items carry it — the project's themes at a glance. */
export function labelCounts(items: Pick<LoreWorkItem, 'labels' | 'state'>[]): Record<string, { open: number; closed: number }> {
  const out: Record<string, { open: number; closed: number }> = {}
  for (const i of items)
    for (const l of i.labels) {
      const c = (out[l] ??= { open: 0, closed: 0 })
      if (i.state === 'open') c.open++
      else c.closed++
    }
  return out
}

// ---- fold inference ----

export interface WorkChangeProposal {
  key: string
  status?: string
  priority?: string
  rank_above?: string
  reason: string
  sources: string[]
  confidence: string
  evidence_date: string
}

export interface FoldWorkResult {
  applied: string[]
  skipped: string[]
}

/**
 * Apply the fold's proposed changes under the guardrails: only status,
 * priority and rank; high confidence with at least one source; never
 * `archived`; and never over a person's more recent call on the same field
 * (a human change newer than the evidence stands). Returns one line per
 * applied and per skipped proposal for the log.
 */
export function applyFoldChanges(items: LoreWorkItem[], proposals: WorkChangeProposal[] | undefined, at = new Date().toISOString()): FoldWorkResult {
  const applied: string[] = []
  const skipped: string[] = []
  for (const p of proposals ?? []) {
    const item = p.key ? findItem(items, p.key) : undefined
    if (!item) {
      skipped.push(`${p.key ?? '?'}: unknown item`)
      continue
    }
    if (p.confidence !== 'high') {
      skipped.push(`${item.key}: confidence ${p.confidence ?? 'unset'} — only high applies`)
      continue
    }
    if (!Array.isArray(p.sources) || p.sources.length === 0) {
      skipped.push(`${item.key}: no source cited`)
      continue
    }
    if (p.status === 'archived' || item.status === 'archived') {
      skipped.push(`${item.key}: archiving is a human decision`)
      continue
    }
    if (p.status !== undefined && !(WORK_STATUSES as string[]).includes(p.status)) {
      skipped.push(`${item.key}: unknown status ${p.status}`)
      continue
    }
    if (p.priority !== undefined && !(WORK_PRIORITIES as string[]).includes(p.priority)) {
      skipped.push(`${item.key}: unknown priority ${p.priority}`)
      continue
    }
    const evidence = /^\d{4}-\d{2}-\d{2}$/.test(p.evidence_date ?? '') ? p.evidence_date : at.slice(0, 10)
    const fields: WorkFields = {}
    const overruled: string[] = []
    for (const field of ['status', 'priority'] as const) {
      if (p[field] === undefined) continue
      const human = lastHumanChange(item, field)
      if (human && human.slice(0, 10) > evidence) overruled.push(field)
      else (fields as Record<string, unknown>)[field] = p[field]
    }
    const meta: ChangeMeta = { at, by: 'lore-extract', via: 'fold', reason: p.reason || 'fold', sources: p.sources, confidence: 'high', evidence_date: evidence }
    const change = applyChange(item, fields, meta)
    let ranked: Record<string, unknown> = {}
    if (p.rank_above) {
      const human = lastHumanChange(item, 'rank')
      if (human && human.slice(0, 10) > evidence) overruled.push('rank')
      else if (findItem(items, p.rank_above) && p.rank_above.toUpperCase() !== item.key.toUpperCase()) ranked = rankItem(items, item.key, { above: p.rank_above }, meta)
    }
    const changed = [...Object.keys(change), ...Object.keys(ranked)]
    if (changed.length > 0) applied.push(`${item.key}: ${changed.map((f) => `${f} → ${JSON.stringify((change[f] ?? ranked[f]) as unknown)}`).join(', ')} — ${p.reason}`)
    if (overruled.length > 0) skipped.push(`${item.key}: ${overruled.join(', ')} set by a person after ${evidence} — kept`)
    if (changed.length === 0 && overruled.length === 0) skipped.push(`${item.key}: no change`)
  }
  return { applied, skipped }
}

export interface WorkCreateProposal {
  title: string
  /** The derived request this tracks, when there is one (req-0007). */
  request?: string
  status?: string
  priority?: string
  assignee?: string
  reason: string
  sources: string[]
  confidence: string
  evidence_date: string
}

export interface FoldCreateResult {
  created: string[]
  skipped: string[]
}

/** Word-set overlap, for "is this already tracked under other words". */
export function titleSimilarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))
  const A = words(a)
  const B = words(b)
  if (A.size === 0 || B.size === 0) return 0
  let both = 0
  for (const w of A) if (B.has(w)) both++
  return both / Math.max(A.size, B.size)
}
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'its', 'our', 'their', 'before', 'after', 'about'])

/**
 * The fold may open tickets for work the material shows is committed —
 * someone on the team agreed to do it, it is scheduled, or it is planned
 * roadmap — under the same guardrails as a move (high confidence, a cited
 * source) plus two of its own: a request that already has a ticket, or a
 * title that is essentially an existing ticket's, is not tracked twice; and
 * a ticket is never born done or archived — finished work is a request
 * marked done, not a ticket.
 */
export function applyFoldCreations(items: LoreWorkItem[], prefix: string, proposals: WorkCreateProposal[] | undefined, at = new Date().toISOString()): FoldCreateResult {
  const created: string[] = []
  const skipped: string[] = []
  for (const p of proposals ?? []) {
    const title = p.title?.trim()
    if (!title) {
      skipped.push('(untitled): no title')
      continue
    }
    if (p.confidence !== 'high') {
      skipped.push(`"${title}": confidence ${p.confidence ?? 'unset'} — only high applies`)
      continue
    }
    if (!Array.isArray(p.sources) || p.sources.length === 0) {
      skipped.push(`"${title}": no source cited`)
      continue
    }
    const status = p.status ?? 'todo'
    if (!(['todo', 'in_progress', 'blocked'] as string[]).includes(status)) {
      skipped.push(`"${title}": a ticket is not created as ${status}`)
      continue
    }
    const request = p.request?.trim()
    const byRequest = request ? items.find((i) => i.request === request) : undefined
    if (byRequest) {
      skipped.push(`"${title}": ${request} is already ${byRequest.key}`)
      continue
    }
    const similar = items.find((i) => i.status !== 'archived' && titleSimilarity(i.title, title) >= 0.7)
    if (similar) {
      skipped.push(`"${title}": reads like ${similar.key} "${similar.title}"`)
      continue
    }
    const evidence = /^\d{4}-\d{2}-\d{2}$/.test(p.evidence_date ?? '') ? p.evidence_date : at.slice(0, 10)
    const priority = (WORK_PRIORITIES as string[]).includes(String(p.priority)) ? (p.priority as WorkPriority) : undefined
    const sources = p.sources.map(String).filter(Boolean)
    const item: LoreWorkItem = {
      key: nextKey(items, prefix),
      title,
      status: status as WorkStatus,
      state: stateFor(status as WorkStatus),
      ...(priority ? { priority } : {}),
      ...(p.assignee?.trim() ? { assignee: p.assignee.trim() } : {}),
      labels: [],
      ...(request ? { request } : {}),
      sources,
      created: at.slice(0, 10),
      updated: at.slice(0, 10),
      history: [{ at, by: 'lore-extract', via: 'fold', change: { created: true }, reason: p.reason || 'fold', sources, confidence: 'high', evidence_date: evidence }],
    }
    items.push(item)
    created.push(`${item.key}: "${title}"${request ? ` (${request})` : ''} [${status}] — ${p.reason}`)
  }
  return { created, skipped }
}

/** The tracker as the fold and the report see it: open items plus anything touched in the last two weeks. */
export function describeWorkForPrompt(items: LoreWorkItem[], today: string): string {
  const cutoff = new Date(new Date(today).getTime() - 14 * 86_400_000).toISOString().slice(0, 10)
  return items
    .map((i, idx) => ({ i, idx }))
    .filter(({ i }) => i.state === 'open' || i.updated >= cutoff)
    .map(
      ({ i, idx }) =>
        `${i.key} | rank ${idx + 1} | ${i.status}${i.priority ? ` | ${i.priority}` : ''}${i.assignee ? ` | ${i.assignee}` : ''} | ${i.title}${
          i.external ? ` | ${i.external.system} ${i.external.key}: ${i.external.status}` : ''
        }${i.request ? ` | from ${i.request}` : ''}`,
    )
    .join('\n')
}

/** History entries since `since` (ISO date) — what moved this week, for the report. */
export function describeWorkHistory(items: LoreWorkItem[], since: string): string {
  const lines: string[] = []
  for (const i of items) {
    for (const h of i.history) {
      if (h.at.slice(0, 10) < since) continue
      const what = Object.entries(h.change)
        .map(([f, v]) => (f === 'created' ? 'created' : `${f} ${Array.isArray(v) ? `${v[0] ?? '—'} → ${v[1]}` : String(v)}`))
        .join(', ')
      lines.push(`${h.at.slice(0, 10)} ${i.key} (${i.title}): ${what} — ${h.reason} [${h.via}${h.by ? `: ${h.by}` : ''}]`)
    }
  }
  return lines.join('\n')
}
