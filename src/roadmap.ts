import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { parseRequests, readWorkItems, type DerivedRequest, type LoreWorkItem } from './work.js'

/** Goals live above delivery tickets. Legacy task-shaped entries stay readable. */
export interface RoadmapGoal {
  id: string
  item: string
  kind?: 'goal' | 'work'
  horizon?: 'short_term' | 'long_term' | 'unspecified'
  timeframe?: { period: string; stated_on: string }
  why?: string
  success?: string
  priority?: string
  priority_reason?: string
  status: string
  edited_by?: string
  edited_at?: string
  source?: string
  work_items?: string[]
}

export const MANAGED_GOALS = 'context/goals.yaml'
export const DERIVED_ROADMAP = 'context/derived/roadmap.yaml'

export function activeGoal(g: RoadmapGoal): boolean {
  return g.kind === 'goal' && g.status !== 'done' && g.status !== 'retired'
}

export function readRoadmapRecords(root: string): unknown[] {
  const file = existsSync(join(root, MANAGED_GOALS)) ? join(root, MANAGED_GOALS) : join(root, DERIVED_ROADMAP)
  if (!existsSync(file)) return []
  const value: unknown = parse(readFileSync(file, 'utf8'))
  if (value == null && file.endsWith(DERIVED_ROADMAP)) return []
  if (!Array.isArray(value)) throw new Error('Unreadable project roadmap: expected a list of entries.')
  return value
}

export function readRoadmap(root: string): RoadmapGoal[] {
  return roadmapGoals(readRoadmapRecords(root))
}

export function roadmapGoals(value: unknown): RoadmapGoal[] {
  return Array.isArray(value) ? value.filter((g): g is RoadmapGoal => g && typeof g.id === 'string' && typeof g.item === 'string').map(normalizeGoalTimeframe) : []
}

/** A calendar period is anchored to the dated decision, even when read in a later quarter. */
export function normalizeGoalTimeframe(goal: RoadmapGoal): RoadmapGoal {
  if (!goal.timeframe) return goal
  const { timeframe, ...rest } = goal
  const { period, stated_on } = timeframe
  if (typeof period !== 'string' || typeof stated_on !== 'string') return rest
  const match = /^(\d{4})(?:-(?:Q([1-4])|(0[1-9]|1[0-2])))?$/.exec(period)
  if (goal.kind !== 'goal' || goal.horizon === 'long_term' || !match || !/^\d{4}-\d{2}-\d{2}$/.test(stated_on)) return rest
  const stated = new Date(stated_on)
  if (!Number.isFinite(stated.getTime()) || stated.toISOString().slice(0, 10) !== stated_on) return rest
  const endMonth = match[2] ? Number(match[2]) * 3 : Number(match[3] ?? 12)
  const end = new Date(Date.UTC(Number(match[1]), endMonth, 0))
  stated.setUTCFullYear(stated.getUTCFullYear() + 1)
  if (end > stated) return { ...rest, horizon: 'long_term' }
  return { ...goal, horizon: 'short_term' }
}

export function goalTiming(goal: RoadmapGoal): string {
  if (goal.timeframe) return goal.timeframe.period
  if (goal.horizon === 'short_term') return 'short term'
  if (goal.horizon === 'long_term') return 'long term'
  return 'timing not established'
}

const plain = (s: string) => s.replace(/\s+/g, ' ').trim()
const sentence = (s: string) => /[.!?]$/.test(s) ? s : `${s}.`
const priorities: Record<string, string> = { P1: 'High priority', P2: 'Medium priority', P3: 'Lower priority' }
const statuses: Record<string, string> = { planned: 'Planned', in_progress: 'In progress', done: 'Achieved' }

export function renderRoadmap(goals: RoadmapGoal[], work: LoreWorkItem[] = [], requests: DerivedRequest[] = []): string {
  const current = goals.filter(activeGoal)
  const ticketed = new Set(work.map(i => i.request))
  const lines: string[] = []
  const groups = [
    ['short_term', 'Short-term goals'],
    ['long_term', 'Long-term goals'],
    ['unspecified', 'Goals with timing not yet established'],
  ] as const
  for (const [horizon, label] of groups) {
    const entries = current.filter(g => (g.horizon || 'unspecified') === horizon)
      .sort((a, b) => (a.priority || 'P9').localeCompare(b.priority || 'P9'))
    if (!entries.length) continue
    lines.push(`## ${label}`, '')
    for (const g of entries) {
      lines.push(sentence(plain(g.item)))
      if (g.timeframe) lines.push(`Target period: ${g.timeframe.period}.`)
      if (g.why) lines.push(`Why it matters: ${sentence(plain(g.why))}`)
      if (g.success) lines.push(`Success means: ${sentence(plain(g.success))}`)
      lines.push(`${statuses[g.status] || 'Status not established'}${priorities[g.priority || ''] ? `; ${priorities[g.priority!].toLowerCase()}` : ''}.`)
      if (g.priority_reason) lines.push(`What this means for work priorities: ${sentence(plain(g.priority_reason))}`)
      const linked = requests.filter(r => r.goal_ids?.includes(g.id) && r.status !== 'archived')
      const linkedIds = new Set(linked.map(r => r.id))
      const related = work.filter(i => i.status !== 'archived' && (g.work_items?.includes(i.key) || (i.request && linkedIds.has(i.request))))
      const intake = linked.filter(r => !ticketed.has(r.id) && (r.status === 'open' || r.status === 'in_progress'))
      if (intake.length) lines.push(`Related requests awaiting a ticket: ${intake.map(r => plain(r.request)).join('; ')}.`)
      if (related.length) lines.push(`Supporting work: ${related.map(i => `${plain(i.title)} [${i.key}] (${i.status.replaceAll('_', ' ')})`).join('; ')}.`)
      if (g.source && /^https?:\/\//.test(g.source)) lines.push(`Evidence: ${g.source}`)
      lines.push('')
    }
  }
  if (!current.length) lines.push('No active overarching goals have been established in the roadmap yet.', '')
  const achieved = goals.filter(g => g.kind === 'goal' && g.status === 'done')
  if (achieved.length) lines.push('## Achieved goals', '', ...achieved.map(g => `- ${plain(g.item)}`), '')
  const retired = goals.filter(g => g.kind === 'goal' && g.status === 'retired')
  if (retired.length) lines.push('## Retired goals', '', ...retired.map(g => `- ${plain(g.item)}`), '')
  const legacy = goals.filter(g => !g.kind && g.status !== 'done')
  if (legacy.length) lines.push(`${legacy.length} earlier roadmap ${legacy.length === 1 ? 'entry still needs' : 'entries still need'} review to distinguish overarching goals from delivery tasks. No time horizon or strategic rationale has been inferred for them.`, '')
  return lines.join('\n').trim()
}

/** Resolve supporting descriptions from Lore, never from stale external tables. */
export function roadmapRecall(root: string, raw: unknown): { text: string; goals: RoadmapGoal[]; legacy_count: number } {
  const goals = roadmapGoals(raw)
  const dir = join(root, 'context/work/lore')
  const work = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.yaml')).flatMap(f => readWorkItems(root, f.slice(0, -5))) : []
  const path = join(root, 'context/derived/requests.yaml')
  const requests = existsSync(path) ? parseRequests(readFileSync(path, 'utf8')) : []
  return { text: renderRoadmap(goals, work, requests), goals: goals.filter(g => g.kind === 'goal'), legacy_count: goals.filter(g => !g.kind).length }
}
