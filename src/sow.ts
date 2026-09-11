import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

/**
 * Statements of work — the commitments layer (`context/sow/<slug>.md`).
 *
 * An SOW here is a *capacity commitment*: how many human-weeks were sold,
 * over what period, sometimes with a few named scope items. Written only by
 * `lore sow add` (a human, or an agent on explicit instruction), never by
 * sync or the fold — like facts.yaml, it is authoritative and irreplaceable.
 * The body is the document text rendered to markdown so it is grep-able and
 * citable; the frontmatter is what recall and extract read.
 *
 * Burn (weeks actually spent) is deliberately not here: that belongs to a
 * time-tracking source writing a work table next to this layer.
 */

export const SOW_DIR = 'context/sow'

export type SowStatus = 'active' | 'exhausted' | 'superseded' | 'closed'
export const SOW_STATUSES: SowStatus[] = ['active', 'exhausted', 'superseded', 'closed']

export interface SowMeta {
  name: string
  /** Human-weeks sold. */
  weeks: number
  /** ISO dates of the commitment period. */
  start: string
  end: string
  status: SowStatus
  signed?: string
  /** Where the document lives (Google Doc URL, Drive link…). */
  source?: string
  /** Named deliverables, when the SOW lists any. Usually few or none. */
  scope?: string[]
  added_by: string
  added: string
}

export interface Sow extends SowMeta {
  /** Slug = file stem under context/sow/. */
  id: string
  file: string
  body: string
}

/** The recall view: metadata plus how far through the period we are today. */
export interface SowSummary extends SowMeta {
  id: string
  file: string
  /** 0–100, calendar progress through start…end as of today; the only burn proxy without a time source. */
  period_elapsed_pct: number
  /** Whole days left in the period (negative when past `end`). */
  days_left: number
}

export function readSows(root: string): Sow[] {
  const dir = join(root, SOW_DIR)
  if (!existsSync(dir)) return []
  const out: Sow[] = []
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.md')) continue
    const parsed = splitFrontmatter(readFileSync(join(dir, entry), 'utf8'))
    if (!parsed) continue
    const meta = parsed.meta as Partial<SowMeta>
    if (!meta.name || typeof meta.weeks !== 'number' || !meta.start || !meta.end) continue
    out.push({
      id: entry.replace(/\.md$/, ''),
      file: `${SOW_DIR}/${entry}`,
      name: meta.name,
      weeks: meta.weeks,
      start: String(meta.start),
      end: String(meta.end),
      status: (SOW_STATUSES as string[]).includes(String(meta.status)) ? (meta.status as SowStatus) : 'active',
      ...(meta.signed ? { signed: String(meta.signed) } : {}),
      ...(meta.source ? { source: meta.source } : {}),
      ...(Array.isArray(meta.scope) && meta.scope.length ? { scope: meta.scope.map(String) } : {}),
      added_by: meta.added_by ?? 'unknown',
      added: meta.added ? String(meta.added) : '',
      body: parsed.body.replace(/^\n+/, ''),
    })
  }
  return out
}

export function summarizeSow(sow: Sow, now = Date.now()): SowSummary {
  const { body: _body, ...meta } = sow
  const startMs = Date.parse(sow.start)
  const endMs = Date.parse(sow.end)
  const span = Math.max(endMs - startMs, 1)
  const pct = Math.round(Math.min(Math.max((now - startMs) / span, 0), 1) * 100)
  return { ...meta, period_elapsed_pct: pct, days_left: Math.ceil((endMs - now) / 86_400_000) }
}

/** One line per active SOW for prompts and logs: the numbers, precomputed. */
export function describeSows(sows: SowSummary[]): string {
  return sows
    .filter((s) => s.status === 'active')
    .map(
      (s) =>
        `${s.name}: ${s.weeks} human-weeks sold, ${s.start} → ${s.end} (${s.period_elapsed_pct}% of the period elapsed, ${s.days_left} days left)${
          s.scope?.length ? `; named scope: ${s.scope.join('; ')}` : ''
        }`,
    )
    .join('\n')
}

export function splitFrontmatter(text: string): { meta: Record<string, unknown>; body: string } | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return undefined
  try {
    const meta = parse(m[1]) as Record<string, unknown> | null
    return { meta: meta ?? {}, body: m[2] }
  } catch {
    return undefined
  }
}

/** "Jointly SOW 4" → "jointly-sow-4". */
export function sowSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'sow'
  )
}

const MONEY = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:USD|CAD|EUR|GBP|AUD)\b)|(?:\b(?:USD|CAD|EUR|GBP|AUD)\s?\d[\d,]*)/i

/**
 * Drop lines carrying currency amounts. The commitment lore needs is in
 * weeks; rates and totals do not belong in a repo every agent can read.
 * Returns the text and how many lines went.
 */
export function stripCommercials(text: string): { text: string; removed: number } {
  let removed = 0
  const kept = text.split('\n').filter((line) => {
    if (MONEY.test(line)) {
      removed++
      return false
    }
    return true
  })
  return { text: kept.join('\n'), removed }
}
