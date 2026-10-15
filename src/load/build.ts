import { configSchema } from '../config.js'
import { parseStreamFile } from '../comments.js'
import { parseWorkItems } from '../work.js'
import { parse as parseYaml } from 'yaml'
import { actorResolver } from './actors.js'
import { digest, readLoadInputs, type LoadInputs } from './inputs.js'
import type { LoadActor, LoadCoverage, LoadEvent, LoadEvidence, LoadSnapshot, LoadType, SemanticState } from './schema.js'
import { emptySemantic, materializeSemantic } from './semantic-events.js'

const instant = (s: unknown): string | undefined => typeof s === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : undefined
const title = (text: string) => (/^\*\*(.*?)\*\*/.exec(text)?.[1] ?? text.split('\n')[0]).slice(0, 240)
const list = (s?: string) => (s ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
const emailKeys = (s: string) => [s.includes('@') ? `email:${s}` : `name:${s}`]

export function buildLoad(root: string, input: LoadInputs = readLoadInputs(root), semantic?: SemanticState): LoadSnapshot {
  const config = configSchema.parse(JSON.parse(input.files.get('lore.json') ?? '{}'))
  const resolveActor = actorResolver(config)
  const inputs = Object.fromEntries([...input.files].sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => [path, digest(text)]))
  const events = new Map<string, LoadEvent>()
  const documents: Record<string, number> = { github: 0, gmail: 0, granola: 0, board: 0 }
  const warnings = new Set<string>([
    'Counts describe retained evidence, not hours, effort, or complete source activity.',
    'Contact roles without effective dates are current project mappings applied to history; verify them before interpreting role trends.',
    'Ingestion time is not available in legacy evidence. built_at is extraction time, not first observation.',
  ])
  const id = (namespace: string, entity: string) => `load-${digest(JSON.stringify([namespace, entity])).slice(0, 32)}`
  const add = (e: LoadEvent) => {
    const old = events.get(e.id)
    if (!old) { events.set(e.id, e); return }
    const evidence = [...new Map([...old.evidence, ...e.evidence].map(v => [JSON.stringify(v), v])).values()]
    // Duplicate mailbox copies and note/transcript pairs may add attribution.
    const participants = [...new Map([...old.participants, ...e.participants].map(p => [`${p.role}:${p.actor.id}`, p])).values()]
    const prefer = old.attributes.transcriptOnly && !e.attributes.transcriptOnly || old.type === 'email.unclassified' && e.type !== 'email.unclassified'
    events.set(e.id, { ...(prefer ? e : old), evidence, participants })
  }
  const make = (namespace: string, entity: string, type: LoadType, at: string | undefined, summary: string, evidence: LoadEvidence, actor?: LoadActor): LoadEvent => ({
    id: id(namespace, entity), type, entity, occurred_at: at, time_precision: at ? 'instant' : 'unknown',
    status: 'accepted', method: 'source', summary, actor, participants: [], evidence: [evidence], attributes: {},
  })
  for (const [path, raw] of [...input.files].sort(([a], [b]) => a.localeCompare(b))) {
    const source = /^context\/streams\/(github|gmail|granola)\//.exec(path)?.[1]
    if (source) for (const doc of parseStreamFile(raw)) {
      documents[source]++
      const m = doc.fields
      if (!m.id) { warnings.add(`${source}: records missing document IDs were excluded.`); continue }
      const at = instant(doc.at)
      const evidence: LoadEvidence = { path, digest: inputs[path], doc_id: m.id, url: doc.permalink }
      if (source === 'github' && m.type === 'pr' && m.repo && m.number && m.id === `github-${m.repo}-pr-${m.number}`) {
        const entity = `github:${m.repo.toLowerCase()}#${m.number}`
        const keys = [...(m.user_id ? [`github-id:${m.user_id}`] : []), ...(m.login ? [`github:${m.login}`] : [])]
        const actor = resolveActor(keys, at)
        if (actor.attribution === 'unknown' && m.login) actor.name = m.login
        const e = make('pr.created', entity, 'pr.created', at, title(doc.text), evidence, actor)
        e.attributes = { githubLogin: m.login, githubUserId: m.user_id }
        add(e)
      } else if (source === 'gmail' && m.message_id && m.from) {
        const sender = resolveActor([`email:${m.from}`], at)
        const recipients = [...new Set([...list(m.to), ...list(m.cc)])].map(e => resolveActor([`email:${e}`], at))
        const mailboxes = list(m.mailboxes)
        const fromMailbox = mailboxes.includes(m.from.toLowerCase())
        const type = fromMailbox && recipients.some(a => a.roles.includes('customer')) ? 'email.sent'
          : !fromMailbox && sender.roles.includes('customer') && mailboxes.length ? 'email.received' : 'email.unclassified'
        const e = make('email', `email:${m.message_id}`, type, at, title(doc.text), evidence, sender)
        e.participants = recipients.map(actor => ({ role: 'recipient', actor }))
        e.attributes = { mailboxes, identityQuality: m.message_id.includes('/') ? 'mailbox-fallback' : 'message-id', directionBasis: 'customer-role-and-source-mailbox' }
        if (e.attributes.identityQuality === 'mailbox-fallback') warnings.add('Some emails have mailbox-specific fallback identities; cross-mailbox deduplication is uncertain for those messages.')
        add(e)
      } else if (source === 'granola' && m.meeting) {
        const transcript = m.id.endsWith('-transcript')
        // The connector intentionally dates the transcript one second after notes.
        const occurred = transcript && at ? new Date(Date.parse(at) - 1000).toISOString() : at
        const e = make('meeting.held', `granola:${m.meeting}`, 'meeting.held', occurred, title(doc.text), evidence)
        e.attributes = { transcriptOnly: transcript }
        e.participants = list(m.attendees).map(email => ({ role: 'attendee', actor: resolveActor([`email:${email}`], occurred) }))
        // A note creator is not evidence of who performed/led a meeting.
        add(e)
      }
    }
    if (path.startsWith('context/work/lore/') && path.endsWith('.yaml')) {
      // A corrupt tracker must fail the build, never silently publish zero activity.
      if (!Array.isArray(parseYaml(raw))) throw new Error(`load: invalid tracker table ${path}`)
      for (const item of parseWorkItems(raw)) for (const h of item.history) {
        documents.board++
        const at = instant(h.at)
        const mutation = h.id ?? `legacy-${digest(JSON.stringify([item.key, h.at, h.by, h.via, h.change]))}`
        const actor = resolveActor(emailKeys(h.by), at)
        const evidence: LoadEvidence = { path, digest: inputs[path], history_id: mutation }
        if (h.via === 'web' && (h.change.status || h.change.rank)) {
          const occurrence = h.operation_id ?? mutation
          const e = make('ticket.board_moved', occurrence, 'ticket.board_moved', at, `${item.key}: ${item.title}`, evidence, actor)
          e.entity = `lore:${item.key}`
          e.attributes = { operation_id: h.operation_id, legacyMutation: !h.operation_id, surface: 'web', identityBasis: 'authenticated-account' }
          // Older status/rank entries cannot reliably be grouped into user actions.
          if (!h.operation_id) { e.status = 'candidate'; warnings.add('Legacy board entries lack operation IDs. Candidate totals count status/rank history entries, not distinct user actions.') }
          add(e)
        }
        const assignment = h.change.assignee
        if (Array.isArray(assignment) && assignment[1] && assignment[0] !== assignment[1] && h.via !== 'sync' && h.via !== 'fold') {
          const e = make('ticket.assigned', mutation, 'ticket.assigned', at, `${item.key}: assigned to ${assignment[1]}`, evidence, actor)
          e.entity = `lore:${item.key}`
          e.participants = [{ role: 'assignee', actor: resolveActor(emailKeys(String(assignment[1])), at) }]
          e.attributes = { surface: h.via, initial: Boolean(h.change.created) }
          add(e)
        }
      }
    }
  }
  const inferred = materializeSemantic(input, config, semantic ?? emptySemantic())
  for (const e of inferred.events) events.set(e.id, e)
  warnings.add('Semantic decisions, customer requests and commitments are model interpretations with validated quotations; cross-source deduplication is evaluated inference, not an exactly-once guarantee.')
  if (!inferred.coverage.enabled) warnings.add('Semantic extraction is not enabled. Zero semantic counts do not mean no decisions, requests or commitments.')
  if (inferred.coverage.pending) warnings.add(`Semantic backlog: ${inferred.coverage.pending} source chunks have not been processed at their current revision.`)
  if (inferred.coverage.screened) warnings.add(`Jev screened out ${inferred.coverage.screened} low-signal chunks; these were not extracted by Claude. Disabling or changing the gate makes them pending again.`)
  if (inferred.coverage.invalidatedEvents) warnings.add(`${inferred.coverage.invalidatedEvents} semantic events lost their supporting quotes and are excluded pending re-extraction.`)
  const all = [...events.values()].sort((a, b) => (a.occurred_at ?? a.occurred_on ?? '').localeCompare(b.occurred_at ?? b.occurred_on ?? '') || a.id.localeCompare(b.id))
  const state = JSON.parse(input.files.get('state.json') ?? '{}')
  const coverage: LoadCoverage[] = ['github', 'gmail', 'granola', 'board'].map(source => {
    const sourceEvents = all.filter(e => source === 'board' ? e.type.startsWith('ticket.') : source === 'github' ? e.type === 'pr.created' : source === 'gmail' ? e.type.startsWith('email.') : e.type === 'meeting.held')
    const dates = sourceEvents.flatMap(e => e.occurred_at ? [e.occurred_at] : []).sort()
    const cfg = config.sources[source]
    const health = state.sources?.[source]
    const limitations = ['Retained evidence only; historical completeness is unknown.']
    if (source === 'github') limitations.push('Only retained PR opening documents are counted; current snapshots and PR updates are not openings. GitHub identities need explicit mapping for human/agent roles.')
    if (source === 'gmail') limitations.push('Direction requires a configured customer contact/role and source mailbox evidence. Other emails remain unclassified.')
    if (source === 'granola') limitations.push('Notes and transcripts deduplicate by meeting ID. Attendees may be missing; transcript availability does not affect meeting counts.')
    if (source === 'board') limitations.push('Legacy actions may have separate status/rank entries. Initial assignments before instrumentation are unavailable. Sync/fold observations are excluded from assignment events.')
    return { source, status: documents[source] ? 'partial' : 'unavailable', configured: source === 'board' ? Boolean(config.board) : Boolean(cfg), enabled: source === 'board' ? Boolean(config.board?.enabled) : Boolean(cfg && !cfg.disabled), documents: documents[source], firstOccurrence: dates[0], lastOccurrence: dates.at(-1), lastSync: health?.lastSuccess, error: health?.lastError?.message, limitations }
  })
  return { version: 1, extractor: 2, project: config.project, timezone: config.load?.timezone ?? 'UTC', built_at: new Date().toISOString(), input_revision: input.revision, fingerprint: digest(JSON.stringify([inputs, semantic ?? null])), inputs, events: all, coverage, warnings: [...warnings].sort(), semantic, semanticCoverage: inferred.coverage }
}
