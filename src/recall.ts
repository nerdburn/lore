import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
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
  /** ISO timestamps from state.json — lets a caller say how fresh this is. */
  synced: { lastSync?: string; lastExtract?: string }
  pins: Pin[]
  /** Derived YAML artifacts keyed by file stem: requests, decisions, roadmap, contradictions… */
  derived: Record<string, unknown>
  /**
   * Source-owned work tables (context/work/<source>/<scope>.yaml), keyed
   * "source/scope". The source system is authoritative for these — GitHub
   * Issues state, not an LLM's reading of it. Compact by design: open items
   * in full, closed ones as counts — a real repo has hundreds of closed
   * items and recall is the "what's outstanding" call. The full table is one
   * `lore_read` of `file` away.
   */
  work: Record<string, WorkSummary>
  /** Most recent weekly reports, newest first. */
  reports: { date: string; text: string }[]
}

export interface WorkSummary {
  file: string
  counts: { open: number; closed: number; merged: number }
  open: unknown[]
}

export const REPORTS_CATEGORY = 'reports'
export const WORK_CATEGORY = 'work'
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
  config: Pick<LoreConfig, 'project' | 'lifecycle' | 'archived_at' | 'client'>,
  category?: string,
  opts: { reportLimit?: number } = {},
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
    for (const source of readdirSync(workDir).sort()) {
      const dir = join(workDir, source)
      if (!statSync(dir).isDirectory()) continue
      for (const entry of readdirSync(dir).sort()) {
        if (!/\.ya?ml$/.test(entry)) continue
        const rel = `context/work/${source}/${entry}`
        const items = (parse(readFileSync(join(dir, entry), 'utf8')) as Record<string, unknown>[] | null) ?? []
        const list = Array.isArray(items) ? items : []
        const open = list.filter((i) => i.state === 'open')
        work[`${source}/${entry.replace(/\.ya?ml$/, '')}`] = {
          file: rel,
          counts: {
            open: open.length,
            closed: list.filter((i) => i.state !== 'open' && !i.merged).length,
            merged: list.filter((i) => i.merged === true).length,
          },
          open,
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

  const synced: Recalled['synced'] = {}
  const statePath = join(root, 'state.json')
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { lastSync?: string; lastExtract?: string }
    if (state.lastSync) synced.lastSync = state.lastSync
    if (state.lastExtract) synced.lastExtract = state.lastExtract
  }

  return {
    project: config.project,
    lifecycle: config.lifecycle,
    ...(config.archived_at ? { archived_at: config.archived_at } : {}),
    ...(config.client ? { client: config.client } : {}),
    synced,
    pins,
    derived,
    work,
    reports,
  }
}

export function isEmpty(r: Recalled): boolean {
  return (
    r.pins.length === 0 && Object.keys(r.derived).length === 0 && Object.keys(r.work).length === 0 && r.reports.length === 0
  )
}
