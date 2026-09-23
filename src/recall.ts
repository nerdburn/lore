import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { readSows, summarizeSow, type SowSummary } from './sow.js'
import { hasLabel, labelCounts, summarizeForRecall, type LoreWorkItem } from './work.js'
import { degraded, sourceStatuses, type SourceStatus } from './health.js'
import { loadState } from './state.js'
import type { Client, Lifecycle, LoreConfig } from './config.js'
import type { Pin } from './types.js'

/** Everything `recall` knows, in trust order: pins first, then derived. */
export interface Recalled {
  project: string
  /** "archived" clients are read-only history; answers from them are not current. */
  lifecycle: Lifecycle
  archived_at?: string
  /** Who the client is — name, email domains, known contacts. */
  client?: Client
  /**
   * How fresh this memory is. `lastSync`/`lastExtract` are the run-level
   * timestamps; `sources` is per-source, and it is the one that matters
   * when answering. A sync that partly failed still updates `lastSync`, so
   * "synced 2 minutes ago" alone can hide a source that has been down for
   * days — `degraded` names those, and an answer drawing on them says so.
   */
  synced: { lastSync?: string; lastExtract?: string; sources: SourceStatus[]; degraded: string[] }
  pins: Pin[]
  /** Derived YAML artifacts keyed by file stem: requests, decisions, roadmap, contradictions… */
  derived: Record<string, unknown>
  /**
   * Work tables (context/work/<source>/<scope>.yaml), keyed "source/scope".
   * "lore/<PREFIX>" is the lore tracker — the tracker of record, listed
   * first; each open item carries `last` (who moved it, via what, why) and
   * `drift` when lore and the external tracker disagree. "github/…" and
   * "jira/…" are the external trackers' own tables, written by sync: what
   * the tracker says, mirrored into lore's. Compact by design: open items
   * in full, closed ones as counts — a real repo has hundreds of closed
   * items and recall is the "what's outstanding" call. The full table is one
   * `lore_read` of `file` away.
   */
  work: Record<string, WorkSummary>
  /** Most recent weekly reports, newest first. */
  reports: { date: string; text: string }[]
  /**
   * Statements of work (context/sow/*.md): human-attached capacity
   * commitments — weeks sold over a period — with calendar progress. As
   * authoritative as pins; never written by sync or the fold.
   */
  sow: SowSummary[]
}

export interface WorkSummary {
  file: string
  counts: { open: number; closed: number; merged: number }
  open: unknown[]
  /** Lore tracker only: every project label with its open/closed counts. */
  labels?: Record<string, { open: number; closed: number }>
  /** With a label filter: the closed items carrying it too, so "how is <theme> going" sees what shipped. */
  closed?: unknown[]
}

export const REPORTS_CATEGORY = 'reports'
export const WORK_CATEGORY = 'work'
export const SOW_CATEGORY = 'sow'
const DEFAULT_REPORT_LIMIT = 3

/**
 * The one recall implementation. Both the CLI (`lore recall`) and the MCP
 * tool (`lore_recall`) call this, so they can never drift apart again.
 *
 * `category` filters everything at once: pins by their category, derived
 * artifacts by file stem ("requests", "decisions", …), and "reports" selects
 * the weekly reports. Unknown categories return empty layers, not errors.
 */
export function recallData(
  root: string,
  config: Pick<LoreConfig, 'project' | 'lifecycle' | 'archived_at' | 'client' | 'sources'>,
  category?: string,
  opts: { reportLimit?: number; label?: string } = {},
): Recalled {
  const factsPath = join(root, 'context/facts.yaml')
  const allPins = existsSync(factsPath) ? ((parse(readFileSync(factsPath, 'utf8')) as Pin[] | null) ?? []) : []
  const pins = allPins.filter((p) => !category || p.category === category)

  const derived: Record<string, unknown> = {}
  const derivedDir = join(root, 'context/derived')
  if (existsSync(derivedDir)) {
    for (const entry of readdirSync(derivedDir).sort()) {
      if (!/\.ya?ml$/.test(entry)) continue
      const name = entry.replace(/\.ya?ml$/, '')
      if (category && name !== category) continue
      derived[name] = parse(readFileSync(join(derivedDir, entry), 'utf8'))
    }
  }

  const work: Record<string, WorkSummary> = {}
  const workDir = join(root, 'context/work')
  if ((!category || category === WORK_CATEGORY) && existsSync(workDir)) {
    // The lore tracker first — it is the tracker of record; external tables are what Jira/GitHub say.
    for (const source of readdirSync(workDir).sort((a, b) => (a === 'lore' ? -1 : b === 'lore' ? 1 : a.localeCompare(b)))) {
      const dir = join(workDir, source)
      if (!statSync(dir).isDirectory()) continue
      for (const entry of readdirSync(dir).sort()) {
        if (!/\.ya?ml$/.test(entry)) continue
        const rel = `context/work/${source}/${entry}`
        const items = (parse(readFileSync(join(dir, entry), 'utf8')) as Record<string, unknown>[] | null) ?? []
        const raw = Array.isArray(items) ? items : []
        const all = source === 'lore' ? raw.map((i) => summarizeForRecall(i as unknown as LoreWorkItem) as unknown as Record<string, unknown>) : raw
        const list = opts.label ? all.filter((i) => Array.isArray(i.labels) && hasLabel(i.labels.map(String), opts.label!)) : all
        if (opts.label && list.length === 0) continue
        const open = list.filter((i) => i.state === 'open')
        const closed = list.filter((i) => i.state !== 'open')
        work[`${source}/${entry.replace(/\.ya?ml$/, '')}`] = {
          file: rel,
          counts: {
            open: open.length,
            closed: list.filter((i) => i.state !== 'open' && !i.merged).length,
            merged: list.filter((i) => i.merged === true).length,
          },
          open,
          ...(opts.label ? { closed } : {}),
          ...(source === 'lore' && !opts.label ? { labels: labelCounts(all as unknown as LoreWorkItem[]) } : {}),
        }
      }
    }
  }

  const reports: Recalled['reports'] = []
  const reportsDir = join(derivedDir, 'reports')
  if ((!category || category === REPORTS_CATEGORY) && existsSync(reportsDir)) {
    const files = readdirSync(reportsDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, opts.reportLimit ?? DEFAULT_REPORT_LIMIT)
    for (const f of files) reports.push({ date: f.slice(0, 10), text: readFileSync(join(reportsDir, f), 'utf8') })
  }

  const state = loadState(root)
  const statuses = sourceStatuses(config, state)
  const synced: Recalled['synced'] = { sources: statuses, degraded: degraded(statuses).map((d) => d.source) }
  if (state.lastSync) synced.lastSync = state.lastSync
  if (state.lastExtract) synced.lastExtract = state.lastExtract

  return {
    project: config.project,
    lifecycle: config.lifecycle,
    ...(config.archived_at ? { archived_at: config.archived_at } : {}),
    ...(config.client ? { client: config.client } : {}),
    synced,
    pins,
    derived,
    work,
    sow: !category || category === SOW_CATEGORY ? readSows(root).map((s) => summarizeSow(s)) : [],
    reports,
  }
}

export function isEmpty(r: Recalled): boolean {
  return (
    r.pins.length === 0 && Object.keys(r.derived).length === 0 && Object.keys(r.work).length === 0 && r.reports.length === 0 && r.sow.length === 0
  )
}
