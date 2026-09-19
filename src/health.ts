import type { LoreConfig } from './config.js'
import type { LoreState, SourceHealth } from './state.js'

/**
 * What a source is currently worth as evidence.
 *
 * - `ok`       — its last attempt succeeded; memory is current for it.
 * - `stale`    — it has synced before but its last attempt failed, so
 *                everything since `lastSuccess` is missing.
 * - `never`    — enabled and has never once succeeded; there is no memory
 *                from it at all, which is not the same as having nothing to say.
 * - `disabled` — configured but deliberately skipped.
 */
export type SourceState = 'ok' | 'stale' | 'never' | 'disabled'

export interface SourceStatus {
  source: string
  state: SourceState
  lastSuccess?: string
  lastAttempt?: string
  /** Hours since the last success — how wide the gap in memory is. */
  staleHours?: number
  /** The most recent failure, when the source is not healthy. */
  error?: string
}

/**
 * Per-source freshness, the same answer for every surface that reports it:
 * `lore source list` and `lore check` for a human, `lore_recall` for an
 * agent, the host page for an operator.
 *
 * This exists because sync no longer refuses to run when one source fails.
 * A partial sync that reported itself as simply "synced 2 minutes ago"
 * would let an agent present incomplete memory as complete — so the run
 * continues, and the gap is stated instead of prevented.
 */
export function sourceStatuses(config: Pick<LoreConfig, 'sources'>, state: LoreState, now = Date.now()): SourceStatus[] {
  return Object.entries(config.sources).map(([source, cfg]) => {
    if (cfg.disabled) return { source, state: 'disabled' as const }
    const health: SourceHealth | undefined = state.sources?.[source]
    const failing = Boolean(health?.lastError) && (!health?.lastSuccess || health.lastError!.at > health.lastSuccess)
    const base = {
      source,
      ...(health?.lastSuccess ? { lastSuccess: health.lastSuccess } : {}),
      ...(health?.lastAttempt ? { lastAttempt: health.lastAttempt } : {}),
    }
    if (!failing) return { ...base, state: 'ok' as const }
    return {
      ...base,
      state: health?.lastSuccess ? ('stale' as const) : ('never' as const),
      ...(health?.lastSuccess ? { staleHours: Math.floor((now - Date.parse(health.lastSuccess)) / 3_600_000) } : {}),
      error: health!.lastError!.message,
    }
  })
}

/** Hours, in the unit a person reads without arithmetic: "19h", "12d". */
export function formatStale(hours: number): string {
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** The sources an answer should be hedged on — everything not `ok` or deliberately off. */
export function degraded(statuses: SourceStatus[]): SourceStatus[] {
  return statuses.filter((s) => s.state === 'stale' || s.state === 'never')
}

/** One line a human or an agent can repeat: "github stale 19h, notion never synced". */
export function describeDegraded(statuses: SourceStatus[]): string {
  return degraded(statuses)
    .map((s) => (s.state === 'never' ? `${s.source} never synced` : `${s.source} stale ${formatStale(s.staleHours ?? 0)}`))
    .join(', ')
}
