import { z } from 'zod'
import { localDay } from './actors.js'
import { ACTOR_KINDS, dateSchema, LOAD_ROLES, LOAD_TYPES, timezoneSchema, type LoadActor, type LoadEvent, type LoadSnapshot } from './schema.js'

export const loadQuerySchema = z.object({
  from: dateSchema.optional(), to: dateSchema.optional(), tz: timezoneSchema.optional(),
  type: z.enum(LOAD_TYPES).optional(), role: z.enum(LOAD_ROLES).optional(), actorKind: z.enum(ACTOR_KINDS).optional(), actor: z.string().optional(),
  participation: z.enum(['performed', 'involved', 'attendee', 'recipient', 'assignee', 'contributor']).default('involved'),
  method: z.enum(['source', 'inferred']).optional(), status: z.enum(['accepted', 'candidate']).optional(),
  undated: z.boolean().default(false),
  groupBy: z.enum(['type', 'role', 'actor-kind', 'actor', 'day', 'week', 'month']).default('type'),
  events: z.boolean().default(false), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50),
}).refine(q => (!q.from || !q.to || q.from < q.to) && !(q.undated && (q.from || q.to)), 'date range must be [from, to); undated queries cannot have date boundaries')
export type LoadQuery = z.input<typeof loadQuerySchema>
const involved = (e: LoadEvent, participation: NonNullable<LoadQuery['participation']>): LoadActor[] => [...new Map([
  ...((participation === 'performed' || participation === 'involved') && e.actor ? [e.actor] : []),
  ...e.participants.filter(p => participation === 'involved' || p.role === participation).map(p => p.actor),
].map(a => [a.id, a])).values()]

/** Pure shared CLI/MCP query. Dates are local calendar boundaries, [from,to). */
export function queryLoad(snapshot: LoadSnapshot, input: LoadQuery = {}) {
  const q = loadQuerySchema.parse(input)
  const timezone = q.tz ?? snapshot.timezone
  const eventDay = (e: LoadEvent) => e.occurred_on ?? (e.occurred_at ? localDay(e.occurred_at, timezone) : undefined)
  const qualifyingActors = (e: LoadEvent) => involved(e, q.participation).filter(a => (!q.role || a.roles.includes(q.role)) && (!q.actorKind || a.kind === q.actorKind) && (!q.actor || a.id === q.actor))
  const matches = (e: LoadEvent) => (!q.type || e.type === q.type) && (!q.method || e.method === q.method) && (!q.status || e.status === q.status)
    && (!(q.role || q.actorKind || q.actor || ['attendee', 'recipient', 'assignee', 'contributor'].includes(q.participation)) || qualifyingActors(e).length > 0)
  const undated = snapshot.events.filter(e => !eventDay(e) && matches(e)).length
  const events = snapshot.events.filter(e => {
    const day = eventDay(e)
    if (!matches(e)) return false
    if (q.undated) return !day
    if (!day) return false
    return (!q.from || day >= q.from) && (!q.to || day < q.to)
  })
  const groups = new Map<string, { key: string; accepted: number; candidates: number }>()
  for (const e of events) {
    const actors = qualifyingActors(e)
    const day = eventDay(e) ?? 'undated'
    let keys: string[]
    switch (q.groupBy) {
      case 'role': keys = actors.flatMap(a => a.roles.length ? a.roles : ['unknown']); break
      case 'actor-kind': keys = actors.length ? actors.map(a => a.kind) : ['unknown']; break
      case 'actor': keys = actors.length ? actors.map(a => a.id) : ['unknown']; break
      case 'day': keys = [day]; break
      case 'month': keys = [day === 'undated' ? day : day.slice(0, 7)]; break
      case 'week': { if (day === 'undated') { keys = [day]; break }; const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); keys = [d.toISOString().slice(0, 10)]; break }
      default: keys = [e.type]
    }
    for (const key of new Set(keys)) {
      const row = groups.get(key) ?? { key, accepted: 0, candidates: 0 }
      if (e.status === 'accepted') row.accepted++; else row.candidates++
      groups.set(key, row)
    }
  }
  const byType = LOAD_TYPES.map(type => ({ type, accepted: events.filter(e => e.type === type && e.status === 'accepted').length, candidates: events.filter(e => e.type === type && e.status === 'candidate').length }))
  const actors = [...new Map(events.flatMap(e => involved(e, q.participation)).map(a => [a.id, { id: a.id, name: a.name, kind: a.kind, attribution: a.attribution }])).values()]
  return {
    project: snapshot.project, range: { from: q.from ?? null, to: q.to ?? null, timezone, endExclusive: true },
    projection: { builtAt: snapshot.built_at, inputRevision: snapshot.input_revision, fingerprint: snapshot.fingerprint },
    participation: q.participation, groupBy: q.groupBy, groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)), byType,
    matchedEvents: events.length, undatedExcluded: q.undated ? 0 : undated, undatedOnly: q.undated,
    attribution: { eventsWithoutKnownActor: events.filter(e => !involved(e, q.participation).some(a => a.kind !== 'unknown')).length, eventsWithoutKnownRole: events.filter(e => !involved(e, q.participation).some(a => a.roles.length)).length },
    actors, coverage: snapshot.coverage, semanticCoverage: snapshot.semanticCoverage,
    completionBySurface: [...new Set(events.filter(e => e.type === 'ticket.completed').map(e => String(e.attributes.surface ?? 'unknown')))].sort().map(surface => ({
      surface,
      accepted: events.filter(e => e.type === 'ticket.completed' && e.attributes.surface === surface && e.status === 'accepted').length,
      candidates: events.filter(e => e.type === 'ticket.completed' && e.attributes.surface === surface && e.status === 'candidate').length,
    })),
    byMethod: ['source', 'inferred'].map(method => ({ method, accepted: events.filter(e => e.method === method && e.status === 'accepted').length, candidates: events.filter(e => e.method === method && e.status === 'candidate').length })),
    warnings: [...snapshot.warnings, 'Missing groups are zero observed matches, not proof of zero activity. Check source coverage.', 'Role and actor groups can overlap. Counts across activity types are not units of effort.', ...(q.tz && q.tz !== snapshot.timezone && events.some(e => e.time_precision === 'day') ? ['Day-precision events retain their project-local date; their unknown time cannot be converted to another timezone.'] : [])],
    ...(q.events ? { events: events.slice(q.offset, q.offset + q.limit), nextOffset: q.offset + q.limit < events.length ? q.offset + q.limit : null } : {}),
  }
}
