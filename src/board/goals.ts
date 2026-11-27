import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { z } from 'zod'
import { appendAudit } from '../audit.js'
import { commitWork } from '../commands/work.js'
import type { ResolvedContext } from '../context.js'
import { MANAGED_GOALS, normalizeGoalTimeframe, readRoadmapRecords, roadmapGoals, type RoadmapGoal } from '../roadmap.js'
import { authorizeWrite } from '../write.js'

const note = z.string().trim().max(5000)
const inputSchema = z.object({
  item: note.min(1), why: note, success: note, priority_reason: note,
  priority: z.enum(['', 'P1', 'P2', 'P3']),
  status: z.enum(['planned', 'in_progress', 'done', 'retired']),
  timing: z.string().max(24),
  source: z.string().trim().max(2000),
  revision: z.string().nullable(),
})

export class GoalConflict extends Error {}

export function goalRevision(goal: RoadmapGoal): string {
  return createHash('sha256').update(JSON.stringify(goal)).digest('hex')
}

export function saveGoal(ctx: ResolvedContext, actor: string, id: string | undefined, body: unknown) {
  authorizeWrite(ctx, { via: 'web', actor }, 'goal change')
  const parsed = inputSchema.safeParse(body)
  if (!parsed.success) throw new Error(`Check the goal field ${parsed.error.issues[0].path.join('.') || 'outcome'}.`)
  const { item, why, success, priority_reason, priority, status, timing, source, revision } = parsed.data
  // Keep all other records verbatim, including older entries awaiting classification.
  const records = readRoadmapRecords(ctx.root)
  const index = id ? records.findIndex(r => (r as { id?: string } | null)?.id === id) : -1
  const previous = roadmapGoals([records[index]]).find(g => g.kind === 'goal')
  if (id && !previous) throw new GoalConflict('This goal is no longer available. Reload goals to see the current roadmap.')
  if (revision !== (previous ? goalRevision(previous) : null)) throw new GoalConflict('Someone updated this goal. Reload goals to review their changes before editing.')
  if (source && source !== previous?.source && !/^https?:\/\//i.test(source)) throw new Error('Use an http or https link for the meeting notes.')
  const at = new Date().toISOString()
  const goal: RoadmapGoal = {
    ...previous, id: previous?.id ?? `goal-${randomUUID()}`, kind: 'goal', item, why, success,
    priority_reason, status, edited_by: actor, edited_at: at,
  }
  if (priority) goal.priority = priority
  else delete goal.priority
  if (source) goal.source = source
  else delete goal.source
  delete goal.timeframe
  if (timing === 'unspecified' || timing === 'short_term' || timing === 'long_term') goal.horizon = timing
  else {
    goal.horizon = 'short_term'
    goal.timeframe = previous?.timeframe?.period === timing ? previous.timeframe : { period: timing, stated_on: at.slice(0, 10) }
    if (!normalizeGoalTimeframe(goal).timeframe) throw new Error('Choose a month, quarter or year within one year, or select Long term.')
  }
  if (previous) records[index] = goal
  else records.push(goal)
  mkdirSync(join(ctx.root, 'context'), { recursive: true })
  const path = join(ctx.root, MANAGED_GOALS)
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temp, '# Project goals maintained on the Goals page.\n' + stringify(records))
    renameSync(temp, path)
  } finally { rmSync(temp, { force: true }) }
  appendAudit(ctx.root, { at, actor, via: 'web', action: 'goal', id: goal.id })
  commitWork(ctx, MANAGED_GOALS, `lore: ${previous ? 'edit' : 'add'} goal ${goal.id}`)
  return goal
}
