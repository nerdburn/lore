import { z } from 'zod'
import { selectLoadEvents } from './query.js'
import { dateSchema, LOAD_TYPES, timezoneSchema, type LoadSnapshot, type LoadType } from './schema.js'

/**
 * Cross-project filters. Actor and role filters stay per project: actor IDs
 * are project-local mappings, so they mean nothing across projects.
 */
export const portfolioQuerySchema = z.object({
  from: dateSchema.optional(), to: dateSchema.optional(), tz: timezoneSchema.optional(),
  type: z.enum(LOAD_TYPES).optional(), method: z.enum(['source', 'inferred']).optional(), status: z.enum(['accepted', 'candidate']).optional(),
}).refine(q => !q.from || !q.to || q.from < q.to, 'date range must be [from, to)')
export type PortfolioQuery = z.input<typeof portfolioQuerySchema>

export interface PortfolioEntry {
  project: string
  snapshot?: LoadSnapshot
  freshness?: 'current' | 'stale' | 'unknown'
  archived?: boolean
  /** Why this project has no counts (no snapshot yet, clone failed). */
  error?: string
}

type Counts = Partial<Record<LoadType, { accepted: number; candidates: number }>>

/**
 * One table across projects from their prebuilt snapshots. Event IDs are
 * derived from the native entity (a PR, a message, a meeting), so a repo or
 * mailbox two projects both sync yields the same event in each: totals count
 * it once, and `shared` names where that happened.
 */
export function portfolioLoad(entries: PortfolioEntry[], input: PortfolioQuery = {}) {
  const q = portfolioQuerySchema.parse(input)
  const seen = new Map<string, { type: LoadType; accepted: boolean; projects: string[] }>()
  const projects = entries.filter(e => !e.archived).map(entry => {
    if (!entry.snapshot) return { project: entry.project, error: entry.error ?? 'no activity counts built' }
    const { events, undated } = selectLoadEvents(entry.snapshot, q)
    const counts: Counts = {}
    for (const e of events) {
      const row = counts[e.type] ??= { accepted: 0, candidates: 0 }
      if (e.status === 'accepted') row.accepted++; else row.candidates++
      const prior = seen.get(e.id)
      if (prior) { prior.projects.push(entry.project); prior.accepted ||= e.status === 'accepted' }
      else seen.set(e.id, { type: e.type, accepted: e.status === 'accepted', projects: [entry.project] })
    }
    const semantic = entry.snapshot.semanticCoverage
    return {
      project: entry.project, freshness: entry.freshness ?? 'unknown', builtAt: entry.snapshot.built_at, counts, undatedExcluded: undated,
      sourcesUnavailable: entry.snapshot.coverage.filter(c => c.status === 'unavailable').map(c => c.source),
      ...(semantic?.pending ? { semanticPending: semantic.pending } : {}),
      ...(semantic?.error ? { semanticError: semantic.error } : {}),
    }
  })
  const totals: Counts = {}
  const shared = new Map<string, { type: LoadType; projects: string[]; events: number }>()
  for (const e of seen.values()) {
    const row = totals[e.type] ??= { accepted: 0, candidates: 0 }
    if (e.accepted) row.accepted++; else row.candidates++
    if (e.projects.length < 2) continue
    const key = `${e.type}\0${e.projects.join('\0')}`
    const group = shared.get(key) ?? { type: e.type, projects: e.projects, events: 0 }
    group.events++
    shared.set(key, group)
  }
  const stale = projects.filter(p => 'freshness' in p && p.freshness !== 'current').map(p => p.project)
  return {
    range: { from: q.from ?? null, to: q.to ?? null, timezone: q.tz ?? 'each project\'s Load timezone', endExclusive: true },
    projects, totals,
    shared: [...shared.values()].sort((a, b) => b.events - a.events || a.type.localeCompare(b.type)),
    archived: entries.filter(e => e.archived).map(e => e.project),
    warnings: [
      'Totals count each event once, even when several projects retain it; per-project rows count it in each.',
      'Counts describe retained evidence, not hours or effort. Missing types are zero observed matches, not proof of zero activity; check sourcesUnavailable.',
      ...(stale.length ? [`Not current: ${stale.join(', ')}. Their counts predate the newest synced evidence.`] : []),
    ],
  }
}
