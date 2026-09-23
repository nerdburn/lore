import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { LoreConfig } from './config.js'
import { degraded, sourceStatuses } from './health.js'
import { loadState } from './state.js'
import { describeWorkHistory, readWorkItems, workPrefix, type LoreWorkItem } from './work.js'

/**
 * The status page — `context/derived/status.md`: the answer to "what's
 * outstanding on this project", written ahead of time so an agent relays it
 * instead of reading all of memory to compose one.
 *
 * Two parts with two authors:
 * - the summary: a few lines of prose written by the fold's model after a
 *   fold that changed something (what moved, what's blocked and on whom,
 *   what's waiting on the client), stamped with when it was written;
 * - the outstanding list: rendered by code from the tracker and the derived
 *   artifacts — open tickets by status in rank order, open requests nobody
 *   has ticketed, unfinished roadmap. Exact by construction.
 *
 * The file is rewritten by the fold and by sync, so it lands with the sync
 * commit. `lore_status` re-renders the list live at read time (a ticket
 * moved through MCP five minutes ago shows as moved) and lists what the
 * tracker recorded after the summary was written, so the prose is never
 * presented as newer than it is.
 */

export const STATUS_FILE = 'context/derived/status.md'
/** Per-section caps: the page is read in one breath; the full tables are one recall away. */
const CAP = { todo: 25, requests: 20, roadmap: 20 }
const TEXT_CHARS = 140

interface DerivedItem {
  id?: string
  request?: string
  item?: string
  requested_by?: string
  date?: string
  status?: string
  priority?: string
}

export interface StatusParts {
  summary?: string
  /** ISO — when the summary was written. */
  summaryAt?: string
}

/** The summary and its stamp from an existing status.md, if any. */
export function readStatusParts(root: string): StatusParts {
  const path = join(root, STATUS_FILE)
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf8')
  const summary = /<!-- summary -->\n([\s\S]*?)\n<!-- \/summary -->/.exec(text)?.[1].trim()
  const summaryAt = /<!-- summary_at: (\S+) -->/.exec(text)?.[1]
  return { ...(summary ? { summary } : {}), ...(summaryAt ? { summaryAt } : {}) }
}

function one(text: string | undefined, max = TEXT_CHARS): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function readList(root: string, name: string): DerivedItem[] {
  const path = join(root, `context/derived/${name}.yaml`)
  if (!existsSync(path)) return []
  const parsed = parse(readFileSync(path, 'utf8')) as DerivedItem[] | null
  return Array.isArray(parsed) ? parsed : []
}

function ticketLine(i: LoreWorkItem): string {
  const last = i.history[i.history.length - 1]
  const bits = [
    i.priority,
    i.assignee ? `@${i.assignee}` : undefined,
    i.labels.length ? i.labels.map((l) => `#${l}`).join(' ') : undefined,
    i.external ? `${i.external.system} ${i.external.key}` : undefined,
  ].filter(Boolean)
  const why = i.status === 'blocked' && last?.reason ? ` — ${one(last.reason, 100)}` : ''
  return `- **${i.key}** ${one(i.title)}${bits.length ? ` · ${bits.join(' · ')}` : ''}${why}`
}

function section(title: string, lines: string[], cap: number, more: string): string[] {
  if (lines.length === 0) return []
  const shown = lines.slice(0, cap)
  const rest = lines.length - shown.length
  return [`## ${title} (${lines.length})`, ...shown, ...(rest > 0 ? [`- …and ${rest} more (${more})`] : []), '']
}

/** The outstanding list, rendered from what is on disk now. */
export function renderOutstanding(root: string, config: Pick<LoreConfig, 'project' | 'client' | 'work'>): string {
  const items = readWorkItems(root, workPrefix(config))
  const open = items.filter((i) => i.state === 'open')
  const ticketed = new Set(items.map((i) => i.request).filter(Boolean))
  const requests = readList(root, 'requests')
    .filter((r) => (r.status === 'open' || r.status === 'in_progress') && !ticketed.has(r.id))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
  const stale = readList(root, 'requests').filter((r) => r.status === 'stale').length
  const roadmap = readList(root, 'roadmap')
    .filter((r) => r.status !== 'done')
    .sort((a, b) => String(a.priority ?? 'P9').localeCompare(String(b.priority ?? 'P9')))
  const byStatus = (s: string) => open.filter((i) => i.status === s).map(ticketLine)
  const counts = `${open.length} open ticket${open.length === 1 ? '' : 's'} (${byStatus('blocked').length} blocked, ${byStatus('in_progress').length} in progress, ${byStatus('todo').length} to do) · ${requests.length} untracked request${requests.length === 1 ? '' : 's'} · ${roadmap.length} roadmap item${roadmap.length === 1 ? '' : 's'} not done`
  return [
    counts,
    '',
    ...section('Blocked', byStatus('blocked'), Infinity, ''),
    ...section('In progress', byStatus('in_progress'), Infinity, ''),
    ...section('To do', byStatus('todo'), CAP.todo, 'lore_recall category work'),
    ...section(
      'Requests not yet ticketed',
      requests.map((r) => `- ${r.id} ${one(r.request)}${r.requested_by ? ` — ${one(r.requested_by, 40)}` : ''}${r.date ? `, ${r.date}` : ''}${r.status === 'in_progress' ? ' (in progress)' : ''}`),
      CAP.requests,
      'lore_recall category requests',
    ),
    ...section('Roadmap not done', roadmap.map((r) => `- ${r.id} ${one(r.item)}${r.priority ? ` (${r.priority}${r.status ? `, ${r.status}` : ''})` : ''}`), CAP.roadmap, 'lore_recall category roadmap'),
    ...(stale ? [`_${stale} stale request${stale === 1 ? '' : 's'} (no activity in ~30 days) not listed._`, ''] : []),
  ]
    .join('\n')
    .trimEnd()
}

/** Write status.md: the given summary (or the existing one) over a fresh list. */
export function writeStatus(root: string, config: Pick<LoreConfig, 'project' | 'client' | 'work'>, parts: StatusParts = readStatusParts(root)): string {
  const name = config.client?.name ?? config.project
  const text = [
    `# ${name} — status`,
    '',
    `<!-- Derived by lore (summary: the fold; list: rendered from the tracker). Regenerable; do not hand-edit. -->`,
    ...(parts.summaryAt ? [`<!-- summary_at: ${parts.summaryAt} -->`] : []),
    '',
    '<!-- summary -->',
    parts.summary?.trim() || '_No summary yet — written after the next fold that changes something._',
    '<!-- /summary -->',
    '',
    renderOutstanding(root, config),
    '',
  ].join('\n')
  mkdirSync(join(root, 'context/derived'), { recursive: true })
  writeFileSync(join(root, STATUS_FILE), text)
  return STATUS_FILE
}

export const STATUS_SUMMARY_SYSTEM = `You write the top of a client project's status page: 3 to 5 short lines of plain markdown, at most 80 words in all (no heading, no preamble, no bullet per ticket) — a person reads it in ten seconds. Say what moved since the previous summary, what is blocked and on whom, and what is waiting on the client — naming tickets by key and people by name. Use only what the input states; never invent dates, owners or causes. If little changed, say so in one line and carry forward what still matters from the previous summary. No permalinks, no list of every ticket — the outstanding list follows below the summary.`

/** The summary prompt: the list as it stands, what moved since the last summary, and the last summary. */
export function statusSummaryInput(root: string, config: Pick<LoreConfig, 'project' | 'client' | 'work'>, today: string, foldChanges: string[]): string {
  const prev = readStatusParts(root)
  const items = readWorkItems(root, workPrefix(config))
  const since = prev.summaryAt?.slice(0, 10) ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  return [
    `Today is ${today}. Project: ${config.client?.name ?? config.project}.`,
    `\n# Previous summary (${prev.summaryAt ?? 'none'})\n${prev.summary ?? '(none)'}`,
    `\n# Tracker moves since ${since}\n${describeWorkHistory(items, since) || '(none)'}`,
    `\n# What this fold changed\n${foldChanges.join('\n') || '(nothing)'}`,
    `\n# Outstanding now\n${renderOutstanding(root, config)}`,
  ].join('\n')
}

/**
 * What `lore_status` returns: the summary with its age, anything the tracker
 * recorded after it, the live list, and source freshness — ready to relay.
 */
export function statusView(root: string, config: Pick<LoreConfig, 'project' | 'client' | 'work' | 'sources'>, now = new Date()): string {
  const parts = readStatusParts(root)
  const items = readWorkItems(root, workPrefix(config))
  const after = parts.summaryAt
    ? items
        .flatMap((i) => i.history.filter((h) => h.at > parts.summaryAt!).map((h) => ({ i, h })))
        .sort((a, b) => a.h.at.localeCompare(b.h.at))
        .map(({ i, h }) => {
          const what = Object.entries(h.change)
            .map(([f, v]) => (f === 'created' ? 'created' : `${f} ${Array.isArray(v) ? `${fmt(v[0])} → ${fmt(v[1])}` : fmt(v)}`))
            .join(', ')
          return `- ${h.at.slice(0, 16).replace('T', ' ')} **${i.key}** ${what} — ${one(h.reason, 100)} (${h.via}${h.by ? `, ${h.by}` : ''})`
        })
    : []
  const state = loadState(root)
  const down = degraded(sourceStatuses(config, state, now.getTime())).map((d) => d.source)
  const age = parts.summaryAt ? ago(parts.summaryAt, now) : undefined
  return [
    `# ${config.client?.name ?? config.project} — status`,
    '',
    parts.summary ? `${parts.summary}\n\n_Summary written ${age} (${parts.summaryAt!.slice(0, 16).replace('T', ' ')} UTC)._` : '_No summary yet — the list below is current._',
    ...(after.length ? ['', `## Since the summary (${after.length})`, ...after.slice(-15)] : []),
    '',
    renderOutstanding(root, config),
    '',
    `_Synced ${state.lastSync ? ago(state.lastSync, now) : 'never'}${down.length ? ` · not current: ${down.join(', ')}` : ''}._`,
  ].join('\n')
}

function fmt(v: unknown): string {
  return v === null || v === undefined ? '—' : Array.isArray(v) ? v.join(', ') || '(none)' : String(v)
}

function ago(iso: string, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000))
  if (min < 60) return `${min} min ago`
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`
  return `${Math.round(min / 1440)} days ago`
}
