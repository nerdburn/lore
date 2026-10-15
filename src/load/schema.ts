import { z } from 'zod'

export const LOAD_ROLES = ['customer', 'account_manager', 'client_strategist', 'technical_lead', 'software_developer', 'designer'] as const
export const ACTOR_KINDS = ['human', 'agent', 'service', 'unknown'] as const
export const SEMANTIC_TYPES = ['decision.made', 'client.requested', 'human.committed'] as const
export const LOAD_TYPES = ['pr.created', 'email.sent', 'email.received', 'email.unclassified', 'meeting.held', 'ticket.board_moved', 'ticket.assigned', 'ticket.completed', ...SEMANTIC_TYPES] as const
export type LoadRole = typeof LOAD_ROLES[number]
export type ActorKind = typeof ACTOR_KINDS[number]
export type LoadType = typeof LOAD_TYPES[number]
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'must be a calendar date')
export const timezoneSchema = z.string().refine(tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true } catch { return false } }, 'unknown timezone')
export const actorSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), kind: z.enum(ACTOR_KINDS),
  identities: z.array(z.string().regex(/^(email|github|github-id|slack|name):\S.*$/)).min(1),
  roles: z.array(z.object({ role: z.enum(LOAD_ROLES), from: dateSchema.optional(), to: dateSchema.optional() })
    .refine(r => !r.from || !r.to || r.from < r.to, 'role interval must be [from, to)')).default([]),
})
export const loadConfigSchema = z.object({
  enabled: z.boolean().default(false), timezone: timezoneSchema.default('UTC'),
  semantic: z.object({
    enabled: z.boolean().default(false),
    sources: z.array(z.enum(['slack', 'gmail', 'granola', 'board', 'github', 'jira', 'linear', 'docs', 'figma', 'notion'])).default(['slack', 'gmail', 'granola', 'board', 'github', 'jira', 'linear', 'docs', 'figma', 'notion']),
    from: dateSchema.optional(), to: dateSchema.optional(),
    max_batches: z.number().int().min(1).max(100).default(1),
    gate: z.object({ mode: z.enum(['off', 'shadow', 'filter']).default('shadow'), threshold: z.number().gt(0).lt(1).default(0.1) }).optional(),
  }).refine(s => !s.from || !s.to || s.from < s.to, 'semantic range must be [from, to)').optional(),
  actors: z.array(actorSchema).default([]),
}).superRefine((cfg, ctx) => {
  const ids = new Set<string>(), identities = new Map<string, string>()
  for (const a of cfg.actors) {
    if (ids.has(a.id)) ctx.addIssue({ code: 'custom', message: `duplicate actor ID: ${a.id}` })
    ids.add(a.id)
    for (const key of a.identities.map(s => s.trim().toLowerCase())) {
      if (identities.has(key) && identities.get(key) !== a.id) ctx.addIssue({ code: 'custom', message: `identity belongs to multiple actors: ${key}` })
      identities.set(key, a.id)
    }
  }
})
export type ActorDefinition = z.infer<typeof actorSchema>
export interface LoadActor { id: string; name: string; kind: ActorKind; roles: LoadRole[]; attribution: 'explicit' | 'contact' | 'unknown'; roleDatesKnown: boolean }
export interface LoadEvidence { path: string; digest: string; doc_id?: string; history_id?: string; url?: string; quote?: string }
export interface LoadEvent {
  id: string; type: LoadType; entity: string; occurred_at?: string; occurred_on?: string; time_precision: 'instant' | 'day' | 'unknown'
  status: 'accepted' | 'candidate'; method: 'source' | 'inferred'; summary: string
  actor?: LoadActor; participants: Array<{ role: 'attendee' | 'recipient' | 'assignee' | 'contributor'; actor: LoadActor }>
  evidence: LoadEvidence[]; attributes: Record<string, unknown>
}
export interface LoadCoverage {
  source: string; status: 'partial' | 'unavailable'; configured: boolean; enabled: boolean
  documents: number; firstOccurrence?: string; lastOccurrence?: string; lastSync?: string; error?: string; limitations: string[]
}
export interface LoadSnapshot {
  version: 1; extractor: 1 | 2 | 3; project: string; timezone: string; built_at: string; input_revision?: string
  fingerprint: string; inputs: Record<string, string>; events: LoadEvent[]; coverage: LoadCoverage[]; warnings: string[]
  semantic?: SemanticState
  semanticCoverage?: { enabled: boolean; sources: string[]; from?: string; to?: string; chunks: number; processed: number; pending: number; screened?: number; invalidatedEvents: number; lastSuccess?: string; error?: string }
}

export interface SemanticClaim {
  id: string; type: typeof SEMANTIC_TYPES[number]; summary: string; actor_keys: string[]; occurred_on?: string
  confidence: 'high' | 'medium' | 'low'; evidence: Array<{ path: string; doc_id: string; quote: string }>
  model: string; extracted_at: string; related: string[]
}
export interface SemanticState {
  version: 1; checkpoints: Record<string, string>; records: SemanticClaim[]; lastSuccess?: string; error?: string
}
