import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { readWorkItems, type LoreWorkItem } from './work.js'

/** Goals live above delivery tickets. Legacy task-shaped entries stay readable. */
export interface RoadmapGoal {
  id: string
  item: string
  kind?: 'goal' | 'work'
  horizon?: 'short_term' | 'long_term' | 'unspecified'
  why?: string
  success?: string
  priority?: string
  priority_reason?: string
  status: string
  source?: string
  work_items?: string[]
}

export function readRoadmap(root: string): RoadmapGoal[] {
  const file = join(root, 'context/derived/roadmap.yaml')
  if (!existsSync(file)) return []
  return roadmapGoals(parse(readFileSync(file, 'utf8')))
}

function roadmapGoals(value: unknown): RoadmapGoal[] {
  return Array.isArray(value) ? value.filter((g): g is RoadmapGoal => g && typeof g.id === 'string' && typeof g.item === 'string') : []
}

const plain = (s: string) => s.replace(/\s+/g, ' ').trim()
const sentence = (s: string) => /[.!?]$/.test(s) ? s : `${s}.`
const priorities: Record<string, string> = { P1: 'High priority', P2: 'Medium priority', P3: 'Lower priority' }
const statuses: Record<string, string> = { planned: 'Planned', in_progress: 'In progress', done: 'Achieved' }

export function renderRoadmap(goals: RoadmapGoal[], work: LoreWorkItem[] = []): string {
  const current = goals.filter(g => g.kind === 'goal' && g.status !== 'done')
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
      if (g.why) lines.push(`Why it matters: ${sentence(plain(g.why))}`)
      if (g.success) lines.push(`Success means: ${sentence(plain(g.success))}`)
      lines.push(`${statuses[g.status] || 'Status not established'}${priorities[g.priority || ''] ? `; ${priorities[g.priority!].toLowerCase()}` : ''}.`)
      if (g.priority_reason) lines.push(`What this means for work priorities: ${sentence(plain(g.priority_reason))}`)
      const related = work.filter(i => g.work_items?.includes(i.key) && i.status !== 'archived')
      if (related.length) lines.push(`Supporting work: ${related.map(i => `${plain(i.title)} [${i.key}] (${i.status.replaceAll('_', ' ')})`).join('; ')}.`)
      if (g.source && /^https?:\/\//.test(g.source)) lines.push(`Evidence: ${g.source}`)
      lines.push('')
    }
  }
  if (!current.length) lines.push('No active overarching goals have been established in the roadmap yet.', '')
  const achieved = goals.filter(g => g.kind === 'goal' && g.status === 'done')
  if (achieved.length) lines.push('## Achieved goals', '', ...achieved.map(g => `- ${plain(g.item)}`), '')
  const legacy = goals.filter(g => !g.kind && g.status !== 'done')
  if (legacy.length) lines.push(`${legacy.length} earlier roadmap ${legacy.length === 1 ? 'entry still needs' : 'entries still need'} review to distinguish overarching goals from delivery tasks. No time horizon or strategic rationale has been inferred for them.`, '')
  return lines.join('\n').trim()
}

/** Resolve supporting descriptions from Lore, never from stale external tables. */
export function roadmapRecall(root: string, raw: unknown): { text: string; goals: RoadmapGoal[]; legacy_count: number } {
  const goals = roadmapGoals(raw)
  const dir = join(root, 'context/work/lore')
  const work = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.yaml')).flatMap(f => readWorkItems(root, f.slice(0, -5))) : []
  return { text: renderRoadmap(goals, work), goals: goals.filter(g => g.kind === 'goal'), legacy_count: goals.filter(g => !g.kind).length }
}
