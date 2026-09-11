import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { accessToken, defaultAuthFile, readAuthFile } from '../granola-auth.js'
import { hasDoc, streamRelPath } from '../streams.js'
import type { Connector, ConnectorContext, Doc } from '../types.js'

/**
 * Granola connector (backlog §12).
 *
 * Granola's official integration surface is its MCP server
 * (https://mcp.granola.ai/mcp), so this connector is an MCP *client*: it
 * calls `list_meeting_folders`, `list_meetings`, `get_meetings` and
 * `get_meeting_transcript` exactly as an agent would, and turns the results
 * into stream docs. Granola's tools return XML-ish text (listings, notes,
 * summaries) and JSON (transcripts); the parsers below are fixture-tested
 * against captured responses.
 *
 * Scoping a client's meetings (a workspace holds every client's):
 * - `folders`: Granola folder titles or ids — meetings filed there belong
 *   to this client;
 * - `attendee_domains`: any attendee at one of these email domains.
 * Either or both; the union is synced.
 *
 * Per meeting, two docs: notes (title, attendees with emails, private notes,
 * AI summary) and, unless `transcripts: false`, the verbatim transcript as a
 * threaded reply. Attendee emails are kept in `meta` so a later contact
 * model can resolve identities without re-querying.
 *
 * Meetings are synced only once they are `settle_hours` old (default 1) so
 * Granola has finished the summary; each sync re-lists `overlap_days`
 * (default 2) and stream dedup absorbs the repeats.
 *
 * Pacing. Granola rate-limits `get_meeting_transcript` per account on a
 * tight budget — measured at roughly one success every two minutes
 * sustained, with a small burst allowance — while listing and notes calls
 * are effectively free. So a run has two phases. Notes first: every settled
 * meeting in range gets its notes doc (batched `get_meetings`) and the
 * cursor advances, so summaries are available to the fold right away.
 * Transcripts second: meetings whose transcript is still owed sit in a
 * pending list carried in the cursor, and each run works through it
 * oldest-first for at most `transcript_seconds` (default 300), then stops
 * and leaves the rest for the next run — a deferral, not an error. Every
 * client in a `run-all` shares the one Granola account, so all calls go
 * through a process-wide pacer: a second between any two calls, and an
 * adaptive gap between transcript calls that doubles on every "slow down"
 * reply, which also holds every client off transcripts for a minute.
 * Transcripts already in the stream are never fetched again, so the overlap
 * re-read costs nothing. If a notes-phase call fails mid-run, the docs
 * gathered so far are returned with a cursor at the last completed meeting
 * plus the error, so the next run resumes rather than restarting.
 *
 * Auth, in order: a static `token` (env ref); a proxy `endpoint` that injects
 * one; otherwise the OAuth token file from `lore auth granola` (`auth_file`,
 * default ~/.lore/granola-auth.json), refreshed automatically and retried
 * once on 401. Meeting content is evidence, never authoritative work or
 * facts (§12).
 */

/** The four Granola tools, as a function — injectable so tests never hit the network. */
export type GranolaCall = (tool: string, args: Record<string, unknown>) => Promise<string>

/**
 * Clock + gate shared by every Granola call in the process. Injectable so
 * tests run on a fake clock; the default export uses one process-wide
 * instance, which is what makes concurrent clients take turns.
 */
export interface GranolaPacing {
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Epoch ms of the most recently reserved call slot (any tool). */
  lastSlot: number
  /** Epoch ms of the most recently reserved transcript slot. */
  lastTranscriptSlot: number
  /** Current minimum gap between transcript calls; doubles on every rate-limit reply. */
  transcriptGapMs: number
  /** No transcript call before this epoch ms — set while a refused call backs off, so other clients wait too. */
  transcriptHoldUntil: number
}

export function newPacing(): GranolaPacing {
  return {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    lastSlot: 0,
    lastTranscriptSlot: 0,
    transcriptGapMs: TRANSCRIPT_GAP_MS,
    transcriptHoldUntil: 0,
  }
}

const TRANSCRIPT_TOOL = 'get_meeting_transcript'
const MIN_GAP_MS = 1_000
/** Initial spacing between transcript calls; adaptive from here (see GranolaPacing). */
export const TRANSCRIPT_GAP_MS = 30_000
const TRANSCRIPT_GAP_MAX_MS = 240_000
/** How long every client stays off transcripts after a "slow down" reply. */
export const TRANSCRIPT_HOLD_MS = 60_000
/** Retry waits for the other (never observed limited) tools. */
const BACKOFF_MS = [5_000, 15_000, 45_000]
const RATE_LIMITED = /rate limit/i
const sharedPacing = newPacing()

/** When the next transcript call may go, given the shared pacing state. */
function nextTranscriptSlot(pacing: GranolaPacing): number {
  return Math.max(pacing.now(), pacing.lastSlot + MIN_GAP_MS, pacing.lastTranscriptSlot + pacing.transcriptGapMs, pacing.transcriptHoldUntil)
}

/**
 * Space calls process-wide: MIN_GAP_MS between any two, the adaptive
 * transcript gap (and hold) before a transcript call. Slot reservation is
 * synchronous (read + write before any await), so concurrent callers never
 * grab the same slot. A refused transcript call widens the gap, sets the
 * hold, and throws RateLimited for the caller to schedule around; a refused
 * call on any other tool is retried here with a short backoff.
 */
function paced(call: GranolaCall, pacing: GranolaPacing, log: (msg: string) => void): GranolaCall {
  return async (tool, args) => {
    const transcript = tool === TRANSCRIPT_TOOL
    for (let attempt = 0; ; attempt++) {
      const now = pacing.now()
      const slot = transcript ? nextTranscriptSlot(pacing) : Math.max(now, pacing.lastSlot + MIN_GAP_MS)
      pacing.lastSlot = slot
      if (transcript) pacing.lastTranscriptSlot = slot
      if (slot > now) await pacing.sleep(slot - now)
      try {
        return await call(tool, args)
      } catch (err) {
        if (!RATE_LIMITED.test(String(err))) throw err
        if (transcript) {
          pacing.transcriptGapMs = Math.min(pacing.transcriptGapMs * 2, TRANSCRIPT_GAP_MAX_MS)
          pacing.transcriptHoldUntil = Math.max(pacing.transcriptHoldUntil, pacing.now() + TRANSCRIPT_HOLD_MS)
          throw new RateLimited(err instanceof Error ? err.message : String(err))
        }
        if (attempt >= BACKOFF_MS.length) throw err
        const wait = BACKOFF_MS[attempt]
        log(`granola: rate limited on ${tool} — waiting ${wait / 1000}s before retry ${attempt + 1}/${BACKOFF_MS.length}`)
        await pacing.sleep(wait)
        pacing.lastSlot = Math.max(pacing.lastSlot, pacing.now())
      }
    }
  }
}

interface GranolaCursor {
  since?: string
  /** Meetings whose notes are synced but whose transcript is still owed; drained oldest-first within each run's transcript budget. */
  transcripts?: PendingTranscript[]
}

export interface PendingTranscript {
  id: string
  dateMs: number
  title: string
  folder?: string
}

/** A "slow down" reply on a transcript call; the pacer has already widened the gap and set the hold. */
export class RateLimited extends Error {}

const DEFAULT_ENDPOINT = 'https://mcp.granola.ai/mcp'
const DEFAULT_OVERLAP_DAYS = 2
const DEFAULT_SETTLE_HOURS = 1
const DAY_MS = 86_400_000
const LIST_WINDOW_DAYS = 30
const GET_BATCH = 10
const DEFAULT_MEETINGS_PER_RUN = 50
const DEFAULT_TRANSCRIPT_SECONDS = 300

/** How the connector obtains a bearer for each connection attempt. */
export interface TokenSource {
  /** `force` after a 401: refresh even if the cached token looks valid. */
  get(force: boolean): Promise<string | undefined>
}

export function makeGranola(
  connect: (endpoint: string, tokens: TokenSource) => Promise<{ call: GranolaCall; close: () => Promise<void> }>,
  pacing: GranolaPacing = sharedPacing,
): Connector {
  return {
    name: 'granola',
    async fetch(ctx: ConnectorContext) {
      const staticToken = ctx.config.token as string | undefined
      const endpoint = (ctx.config.endpoint as string | undefined) ?? DEFAULT_ENDPOINT
      const authFile = (ctx.config.auth_file as string | undefined) ?? defaultAuthFile()
      let tokens: TokenSource
      if (staticToken) tokens = { get: async () => staticToken }
      else if (ctx.config.endpoint !== undefined && !readAuthFile(authFile)) tokens = { get: async () => undefined } // proxy injects it
      else if (readAuthFile(authFile)) tokens = { get: (force) => accessToken(authFile, { force }) }
      else throw new Error(`granola: no credentials — run \`lore auth granola\` on this machine (writes ${authFile}), or set token / a proxy endpoint`)
      const folders = (ctx.config.folders as string[] | undefined) ?? []
      // Scope = this source's own lists ∪ the repo's client block: any attendee
      // at a client domain, or any known client-side contact, marks a meeting.
      const domains = new Set(
        [...((ctx.config.attendee_domains as string[] | undefined) ?? []), ...(ctx.client?.domains ?? [])].map((d) => d.toLowerCase().replace(/^@/, '')),
      )
      const emails = new Set((ctx.client?.contacts ?? []).filter((c) => c.side !== 'team').map((c) => c.email.toLowerCase()))
      if (folders.length === 0 && domains.size === 0 && emails.size === 0) {
        throw new Error('granola: nothing scopes meetings to this client — set folders/attendee_domains on the source, or client.domains/contacts in lore.json')
      }
      const withTranscripts = ctx.config.transcripts !== false
      const overlapMs = numberOr(ctx.config.overlap_days, DEFAULT_OVERLAP_DAYS) * DAY_MS
      const settleMs = numberOr(ctx.config.settle_hours, DEFAULT_SETTLE_HOURS) * 3_600_000
      const perRun = Math.max(1, Math.floor(numberOr(ctx.config.meetings_per_run, DEFAULT_MEETINGS_PER_RUN)))
      const transcriptBudgetMs = numberOr(ctx.config.transcript_seconds, DEFAULT_TRANSCRIPT_SECONDS) * 1000

      const prev = ctx.cursor as GranolaCursor
      const now = Date.now()
      const startMs = prev.since ? Math.max(new Date(prev.since).getTime() - overlapMs, ctx.since) : ctx.since
      const cutoff = now - settleMs

      const { call: rawCall, close } = await connect(endpoint, tokens)
      const call = paced(rawCall, pacing, ctx.log)
      const docs: Doc[] = []
      const errors: string[] = []
      try {
        // Resolve folder titles → ids (ids pass through).
        const folderIds = new Map<string, string>() // id → title
        if (folders.length > 0) {
          const all = parseFolders(await call('list_meeting_folders', {}))
          for (const want of folders) {
            const hits = all.filter((f) => f.id === want || f.title.toLowerCase() === want.toLowerCase())
            if (hits.length === 0) errors.push(`folder "${want}" not found in Granola — check the title, or use the folder id`)
            for (const f of hits) folderIds.set(f.id, f.title)
          }
        }

        // List candidates: per folder, plus everything (for domain matching).
        const candidates = new Map<string, MeetingRef & { folder?: string }>()
        for (const [id, title] of folderIds) {
          for (const m of await listRange(call, startMs, now, id)) candidates.set(m.id, { ...m, folder: title })
        }
        if (domains.size > 0 || emails.size > 0) {
          for (const m of await listRange(call, startMs, now)) {
            const matches = m.participants.some((p) => emails.has(p.email) || domains.has(p.email.split('@')[1] ?? ''))
            if (matches && !candidates.has(m.id)) candidates.set(m.id, m)
          }
        }

        const prevSince = prev.since ? new Date(prev.since).getTime() : 0
        const settled = [...candidates.values()].filter((m) => m.dateMs <= cutoff).sort((a, b) => a.dateMs - b.dateMs)
        // Overlap re-reads (≤ the cursor) always go; the per-run cap applies to
        // meetings past the cursor, so a run always moves the cursor forward.
        const overlap = settled.filter((m) => m.dateMs <= prevSince)
        const fresh = settled.filter((m) => m.dateMs > prevSince)
        const ready = [...overlap, ...fresh.slice(0, perRun)]
        const deferred = fresh.length - Math.min(fresh.length, perRun)

        // Transcripts owed from earlier runs, plus whatever this run adds.
        const pending = new Map<string, PendingTranscript>()
        for (const p of prev.transcripts ?? []) pending.set(p.id, p)

        // Phase 1 — notes for every ready meeting (cheap, batched).
        let newest = prevSince
        let notes = 0
        try {
          for (let i = 0; i < ready.length; i += GET_BATCH) {
            const batch = ready.slice(i, i + GET_BATCH)
            const details = parseMeetings(await call('get_meetings', { meeting_ids: batch.map((m) => m.id) }))
            for (const ref of batch) {
              docs.push(notesDoc(ref, details.find((d) => d.id === ref.id)))
              notes++
              if (withTranscripts && !hasTranscript(ctx, ref)) pending.set(ref.id, { id: ref.id, dateMs: ref.dateMs, title: ref.title, ...(ref.folder ? { folder: ref.folder } : {}) })
              if (ref.dateMs > newest) newest = ref.dateMs
            }
          }
        } catch (err) {
          // Keep what was gathered: sync writes these docs and advances the
          // cursor to the last completed meeting, then records the error.
          const resume = new Date(newest || startMs).toISOString().slice(0, 10)
          errors.push(`${err instanceof Error ? err.message : String(err)} — synced notes for ${notes} of ${ready.length} meeting(s) this run; the rest resume from ${resume} next run`)
        }

        // Phase 2 — transcripts, oldest first, until the run's budget is spent.
        // A "slow down" is a deferral (the meeting stays pending), not an error.
        let fetched = 0
        let limited = 0
        if (!withTranscripts) pending.clear()
        else {
          const deadline = pacing.now() + transcriptBudgetMs
          queue: for (const p of [...pending.values()].sort((a, b) => a.dateMs - b.dateMs)) {
            for (;;) {
              if (nextTranscriptSlot(pacing) > deadline) break queue
              try {
                const transcript = parseTranscript(await call(TRANSCRIPT_TOOL, { meeting_id: p.id }))
                if (transcript) docs.push(transcriptDoc(p, transcript))
                pending.delete(p.id)
                fetched++
                break
              } catch (err) {
                if (err instanceof RateLimited) {
                  limited++
                  ctx.log(`granola: transcript rate limited — holding ${TRANSCRIPT_HOLD_MS / 1000}s, gap now ${pacing.transcriptGapMs / 1000}s`)
                  continue
                }
                errors.push(`transcript for "${p.title}" (${p.id}): ${err instanceof Error ? err.message : String(err)}`)
                pending.delete(p.id)
                break
              }
            }
          }
        }

        const parts = [`${settled.length} meeting(s) in scope → ${notes} notes, ${fetched} transcript(s)`]
        if (pending.size) parts.push(`${pending.size} transcript(s) pending${limited ? ' (rate limited)' : ''} — next run continues`)
        if (deferred) parts.push(`${deferred} meeting(s) past the per-run cap`)
        ctx.log(`granola: ${parts.join('; ')}`)
        const nextCursor: GranolaCursor = {
          since: new Date(newest || startMs).toISOString(),
          ...(pending.size ? { transcripts: [...pending.values()].sort((a, b) => a.dateMs - b.dateMs) } : {}),
        }
        docs.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        return { docs, nextCursor: nextCursor as Record<string, unknown>, ...(errors.length ? { errors } : {}) }
      } finally {
        await close()
      }
    },
  }
}

/** Default transport: MCP over streamable HTTP with a bearer token; one
 * forced refresh + reconnect if the first connection is rejected as
 * unauthorised (an access token that expired between checks). */
export const granola = makeGranola(async (endpoint, tokens) => {
  const open = async (force: boolean) => {
    const token = await tokens.get(force)
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    })
    const client = new Client({ name: 'lore', version: '0.3.0' })
    await client.connect(transport)
    return client
  }
  let client: Client
  try {
    client = await open(false)
  } catch (err) {
    if (!/401|unauthori[sz]ed/i.test(String(err))) throw err
    client = await open(true)
  }
  return {
    call: async (tool, args) => {
      const res = await client.callTool({ name: tool, arguments: args })
      if (res.isError) throw new Error(`granola ${tool}: ${textOf(res.content)}`)
      return textOf(res.content)
    },
    close: () => client.close(),
  }
})

function textOf(content: unknown): string {
  return ((content as { type: string; text?: string }[]) ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
}

// ---- listing in windows (list_meetings has no pagination; keep ranges short) ----

async function listRange(call: GranolaCall, startMs: number, endMs: number, folderId?: string): Promise<MeetingRef[]> {
  const out = new Map<string, MeetingRef>()
  for (let from = startMs; from < endMs; from += LIST_WINDOW_DAYS * DAY_MS) {
    const to = Math.min(from + LIST_WINDOW_DAYS * DAY_MS, endMs)
    const text = await call('list_meetings', {
      time_range: 'custom',
      custom_start: new Date(from).toISOString().slice(0, 10),
      custom_end: new Date(to).toISOString().slice(0, 10),
      ...(folderId ? { folder_id: folderId } : {}),
    })
    for (const m of parseMeetings(text)) if (m.dateMs >= startMs) out.set(m.id, m)
  }
  return [...out.values()]
}

// ---- docs ----

function notesDoc(ref: MeetingRef & { folder?: string }, detail: MeetingRef | undefined): Doc {
  const m = detail ?? ref
  const creator = m.participants.find((p) => p.creator) ?? m.participants[0]
  const lines = [`**${m.title}**`, `Attendees: ${m.participants.map((p) => `${p.name}${p.org ? ` (${p.org})` : ''} <${p.email}>`).join(', ') || 'unknown'}`]
  if (m.notes) lines.push('', '### Notes', m.notes.trim())
  if (m.summary) lines.push('', '### Summary', m.summary.trim())
  if (!m.notes && !m.summary) lines.push('', '(no notes or summary yet)')
  return {
    id: `granola-${m.id}`,
    source: 'granola',
    channel: ref.folder ?? 'meetings',
    author: creator?.name ?? 'unknown',
    timestamp: new Date(m.dateMs).toISOString(),
    permalink: `https://notes.granola.ai/d/${m.id}`,
    meta: {
      meeting: m.id,
      ...(creator ? { creator: creator.email } : {}),
      attendees: m.participants.map((p) => p.email).join(','),
    },
    text: lines.join('\n'),
  }
}

/** Transcript already in the stream from an earlier run (overlap re-read)? Then don't spend a rate-limited call on it. */
function hasTranscript(ctx: ConnectorContext, ref: PendingTranscript): boolean {
  const probe = transcriptDoc(ref, '')
  const file = ctx.readFile(streamRelPath(probe.source, probe.channel, probe.timestamp))
  return file !== undefined && hasDoc(file, probe.id)
}

function transcriptDoc(ref: PendingTranscript, transcript: string): Doc {
  return {
    id: `granola-${ref.id}-transcript`,
    source: 'granola',
    channel: ref.folder ?? 'meetings',
    author: 'transcript',
    timestamp: new Date(ref.dateMs + 1000).toISOString(),
    permalink: `https://notes.granola.ai/d/${ref.id}`,
    thread: ref.id,
    meta: { meeting: ref.id },
    text: `### Transcript — ${ref.title}\n\n${formatTranscript(transcript)}`,
  }
}

/** "Me: … Them: …" run-ons → one speaker turn per line. Speakers are
 * `Me`, `Them`, or a short capitalised name (1–3 words), always followed by
 * ": " — sentence text never matches because it contains punctuation. */
export function formatTranscript(raw: string): string {
  return raw
    .replace(/(?:^|\s+)(Me|Them|[A-Z][a-z]+(?: [A-Z][a-z]+){0,2}):\s/g, '\n$1: ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
}

// ---- parsers for Granola's tool output ----

export interface Participant {
  name: string
  email: string
  org?: string
  creator: boolean
}

export interface MeetingRef {
  id: string
  title: string
  dateMs: number
  participants: Participant[]
  notes?: string
  summary?: string
}

export function parseFolders(text: string): { id: string; title: string }[] {
  const json = JSON.parse(text.slice(text.indexOf('{'))) as { folders?: { id: string; title: string }[] }
  return (json.folders ?? []).map((f) => ({ id: f.id, title: f.title }))
}

export function parseMeetings(text: string): MeetingRef[] {
  const out: MeetingRef[] = []
  const re = /<meeting\s+([^>]*)>([\s\S]*?)<\/meeting>/g
  for (const m of text.matchAll(re)) {
    const attrs = parseAttrs(m[1])
    const body = m[2]
    if (!attrs.id) continue
    out.push({
      id: attrs.id,
      title: decode(attrs.title ?? ''),
      dateMs: parseGranolaDate(attrs.date ?? ''),
      participants: parseParticipants(decode(inner(body, 'known_participants'))),
      notes: decode(inner(body, 'private_notes')).trim() || undefined,
      summary: decode(inner(body, 'summary')).trim() || undefined,
    })
  }
  return out
}

export function parseTranscript(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    const json = JSON.parse(text.slice(start)) as { transcript?: string }
    return json.transcript?.trim() || undefined
  } catch {
    return undefined
  }
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}

function inner(body: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)
  return m?.[1] ?? ''
}

/** "Shawn Adrian (note creator) from Inputlogic <shawn@x.ca>, Aimee from Jointly <aimee@y.ca>, Amanda <a@z.ca>" */
export function parseParticipants(s: string): Participant[] {
  const out: Participant[] = []
  for (const m of s.matchAll(/([^<>,]+?)\s*<([^<>]+@[^<>]+)>/g)) {
    let name = m[1].trim()
    const creator = /\(note creator\)/.test(name)
    name = name.replace(/\(note creator\)/, '').trim()
    let org: string | undefined
    const from = / from (.+)$/.exec(name)
    if (from) {
      org = from[1].trim()
      name = name.slice(0, from.index).trim()
    }
    out.push({ name, email: m[2].trim().toLowerCase(), ...(org ? { org } : {}), creator })
  }
  return out
}

const TZ_OFFSETS: Record<string, number> = {
  UTC: 0, GMT: 0, PST: -8, PDT: -7, MST: -7, MDT: -6, CST: -6, CDT: -5, EST: -5, EDT: -4, AST: -4, ADT: -3, NST: -3.5, NDT: -2.5,
  BST: 1, CET: 1, CEST: 2, IST: 5.5, JST: 9, AEST: 10, AEDT: 11,
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Sep 8, 2026 11:00 AM PDT" → epoch ms. Falls back to Date.parse. */
export function parseGranolaDate(s: string): number {
  const m = /^([A-Za-z]{3})\w*\s+(\d{1,2}),\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?(?:\s+([A-Z]{2,5}))?$/.exec(s.trim())
  if (m) {
    const month = MONTHS.indexOf(m[1].toLowerCase())
    let hour = m[4] ? Number(m[4]) % 12 : 0
    if (m[6]?.toUpperCase() === 'PM') hour += 12
    const minute = m[5] ? Number(m[5]) : 0
    const offset = m[7] ? (TZ_OFFSETS[m[7].toUpperCase()] ?? 0) : 0
    if (month >= 0) return Date.UTC(Number(m[3]), month, Number(m[2]), hour, minute) - offset * 3_600_000
  }
  const fallback = Date.parse(s)
  return Number.isNaN(fallback) ? 0 : fallback
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? value : fallback
}
