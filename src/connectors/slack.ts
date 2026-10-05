import { parse, stringify } from 'yaml'
import type { Connector, ConnectorContext, Doc, RemoteAttachment } from '../types.js'

/**
 * Slack connector.
 *
 * Requires a bot token with `channels:history`, `channels:read`, `users:read`,
 * and `files:read` for file downloads,
 * invited to every whitelisted channel. Only channels listed in config are
 * synced — never "everything the bot can see" (see SPEC §10).
 *
 * Incremental model, per channel:
 * - `ts` is the newest message seen. Each sync re-reads history from
 *   `ts - overlap_days` (default 7) so edits-in-window and delayed delivery
 *   are caught; stream writes dedupe by id, so the overlap is free.
 * - `threads` maps parent ts → newest reply ts for every thread whose parent
 *   is within `thread_window_days` (default 30). Replies to those threads are
 *   fetched every sync even when the parent has left the history window —
 *   that is how a late reply to an old thread still lands.
 *
 * Rate-limit aware: honors 429 Retry-After, which matters for backfills (new
 * non-Marketplace apps get ~1 req/min on conversations.history).
 *
 * Reactions are delivery signals: a team member's 👍 on a client's message
 * means "we've got it, it's a ticket", a ✅ means "done". The connector only
 * records them (SLACK_REACTIONS); `applySlackReactions` turns them into
 * tracker changes after sync. Reactions land after the message, so history
 * is re-read back to `reaction_window_days` (default 7) and threads active in
 * that window are re-read whole — the same calls sync already makes, with a
 * wider window. "Team" is a full member of the bot's workspace; guests
 * (single/multi-channel) and Slack Connect users are the client side.
 *
 * Failure model: a channel that fails mid-fetch (an API error other than
 * the ones handled below) is reported and keeps its previous cursor, while
 * the other channels still sync. A tracked thread whose parent was deleted
 * (`thread_not_found`) is dropped from tracking with a log line — the
 * replies already synced stay in the stream, and it is not an error.
 */

/** A Slack Web API `ok: false` reply. `code` is Slack's error string. */
export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: string,
  ) {
    super(`slack ${method}: ${code}`)
  }
}

interface ChannelCursor {
  ts: string
  threads: Record<string, string>
}

/** Pre-0.4 cursors were `{ [channelId]: ts }`; read both, write the new shape. */
type SlackCursor = Record<string, string | ChannelCursor>

const DEFAULT_API_BASE = 'https://slack.com/api'
/**
 * Top-level messages are re-read this far behind the cursor to catch late
 * deliveries; dedupe makes the re-read free of duplicates but not of API
 * calls. Thread replies are tracked separately (`thread_window_days`), so
 * this does not need to cover late replies — 1 day is plenty.
 */
const DEFAULT_OVERLAP_DAYS = 1
const DEFAULT_THREAD_WINDOW_DAYS = 30
const DEFAULT_REACTION_WINDOW_DAYS = 7
/** Reaction records older than this are dropped from the index; their tickets already exist. */
const REACTION_KEEP_DAYS = 60
const DAY_S = 86_400

export const SLACK_FILES = 'context/source-files/slack.yaml'
interface MessageFiles { channel: string; files: RemoteAttachment[] }

export const SLACK_REACTIONS = 'context/source-files/slack-reactions.yaml'
/** A client message a team member reacted to with 👍 (ticket) or ✅ (done); keyed by permalink. */
export interface ReactionSignal {
  channel: string
  /** Slack message ts. */
  ts: string
  author: string
  text: string
  /** Display names of the team members who reacted. */
  ticket?: string[]
  done?: string[]
}

const TICKET_REACTION = /^(\+1|thumbsup)(::skin-tone-\d)?$/
const DONE_REACTION = /^(white_check_mark|heavy_check_mark|ballot_box_with_check)$/

/** Team 👍/✅ reactions on a message by someone outside the team; undefined when there are none. */
export function reactionSignal(msg: Pick<SlackMessage, 'ts' | 'user' | 'text' | 'reactions'>, channel: string, users: Map<string, SlackUser>): ReactionSignal | undefined {
  if (!msg.reactions?.length || (msg.user && users.get(msg.user)?.team)) return
  const by = (pattern: RegExp) => [...new Set(msg.reactions!.filter((r) => pattern.test(r.name)).flatMap((r) => r.users ?? [])
    .filter((u) => users.get(u)?.team).map((u) => users.get(u)!.name))]
  const ticket = by(TICKET_REACTION)
  const done = by(DONE_REACTION)
  if (!ticket.length && !done.length) return
  return { channel, ts: msg.ts, author: (msg.user && users.get(msg.user)?.name) || msg.user || 'unknown', text: msg.text ?? '',
    ...(ticket.length ? { ticket } : {}), ...(done.length ? { done } : {}) }
}

/** Workspace URLs and generic permalinks identify the same message; query strings do not. */
export function slackMessageRef(raw: string): string | undefined {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || !(u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com'))) return
    const m = /^\/archives\/([A-Z0-9]+)\/p(\d{16,})\/?$/.exec(u.pathname)
    if (m) return `https://slack.com/archives/${m[1]}/p${m[2]}`
  } catch { /* not a URL */ }
}

function readFileIndex<T = MessageFiles>(text: string | undefined): Record<string, T> {
  const value = text ? parse(text) : {}
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export const slack: Connector = {
  name: 'slack',

  async attachments(ctx, refs) {
    const index = readFileIndex(ctx.readFile?.(SLACK_FILES))
    const allowed = new Set(((ctx.config.channels as string[]) ?? []).map((c) => c.replace(/^#/, '')))
    return [...new Set(refs)].flatMap((ref) => {
      const entry = index[ref]
      return entry && allowed.has(entry.channel.replace(/^#/, '')) ? entry.files : []
    })
  },

  async download(ctx, att) {
    const token = ctx.config.token as string | undefined
    const base = ctx.config.files_base as string | undefined
    if (!token && !base) throw new Error('slack files: set files_base to a files.slack.com token-injecting proxy, or supply a token with files:read')
    let fileUrl = att.url
    if (!fileUrl) {
      const api = slackClient(((ctx.config.api_base as string | undefined) ?? DEFAULT_API_BASE).replace(/\/$/, ''), token)
      const result = await api('files.info', { file: att.sourceId })
      const file = result.file as SlackFile | undefined
      fileUrl = file?.url_private_download || file?.url_private || ''
      if (!fileUrl) throw new Error('slack files: no downloadable file; check files:read and channel access')
    }
    let url = new URL(fileUrl)
    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.username || url.password || url.port) {
      throw new Error('slack files: refused a download outside files.slack.com')
    }
    if (base) url = new URL(`${base.replace(/\/$/, '')}${url.pathname}${url.search}`)
    const res = await fetch(url, { headers: !base && token ? { Authorization: `Bearer ${token}` } : {} })
    // A missing/expired token can produce a login page with HTTP 200.
    if (res.ok && res.headers.get('content-type')?.includes('text/html') && att.mime !== 'text/html') {
      await res.body?.cancel()
      throw new Error('slack files: received a login page; check files:read and file proxy authentication')
    }
    return res
  },

  async fetch(ctx: ConnectorContext) {
    const token = ctx.config.token as string | undefined
    const apiBase = ((ctx.config.api_base as string | undefined) ?? DEFAULT_API_BASE).replace(/\/$/, '')
    const wanted = (ctx.config.channels as string[]) ?? []
    if (!token && ctx.config.api_base === undefined) throw new Error('slack: no token resolved (set token, or api_base to a proxy that injects one)')
    if (wanted.length === 0) throw new Error('slack: no channels whitelisted in config')
    const overlapS = numberOr(ctx.config.overlap_days, DEFAULT_OVERLAP_DAYS) * DAY_S
    const threadWindowS = numberOr(ctx.config.thread_window_days, DEFAULT_THREAD_WINDOW_DAYS) * DAY_S
    const reactionWindowS = numberOr(ctx.config.reaction_window_days, DEFAULT_REACTION_WINDOW_DAYS) * DAY_S

    const api = slackClient(apiBase, token)
    const team = await teamId(api)
    const users = await userMap(api, team)
    const channels = await channelMap(api)
    const cursor = { ...(ctx.cursor as SlackCursor) }
    const docs: Doc[] = []
    const errors: string[] = []
    const nowS = Date.now() / 1000
    const fileIndex = readFileIndex(ctx.readFile(SLACK_FILES))
    const reactionIndex = readFileIndex<ReactionSignal>(ctx.readFile(SLACK_REACTIONS))
    const reactionFrom = nowS - reactionWindowS

    for (const name of wanted) {
      const channel = channels.get(name.replace(/^#/, ''))
      if (!channel) {
        errors.push(`channel ${name} not found or bot not a member — /invite @lore, and check the exact name`)
        continue
      }
      const prev = readCursor(cursor[channel.id])
      const meta = { team, channel: channel.id }
      const channelFiles: Record<string, MessageFiles> = {}
      const channelReactions: Record<string, ReactionSignal> = {}
      const mkDoc = (msg: SlackMessage, thread?: string) => {
        const doc = toDoc(msg, name, channel.id, users, meta, thread)
        channelFiles[doc.permalink!] = { channel: name, files: messageFiles(msg, doc.permalink!, doc.author) }
        return doc
      }
      const noteReactions = (msg: SlackMessage) => {
        if (Number(msg.ts) < reactionFrom) return
        const signal = reactionSignal(msg, name, users)
        if (signal) channelReactions[permalinkFor(channel.id, msg.ts)] = signal
      }
      /** Replies for one thread; a deleted parent means "stop tracking it", not a failed sync. A thread
       * active inside the reaction window is re-read whole so reactions on earlier replies are seen. */
      const replies = async (parentTs: string, after: string | undefined): Promise<string | undefined | null> => {
        try {
          const whole = after === undefined || Number(after) >= reactionFrom
          return await pullReplies(api, channel.id, parentTs, after, (r) => docs.push(mkDoc(r, parentTs)), whole ? noteReactions : undefined)
        } catch (err) {
          if (err instanceof SlackApiError && err.code === 'thread_not_found') {
            ctx.log(`slack: ${name} thread ${parentTs} no longer exists — dropped from tracking`)
            return null
          }
          throw err
        }
      }
      const before = docs.length

      // No cursor (first sync, or channel newly added to config) → start at
      // the backfill window. Otherwise back off by the overlap so late edits
      // and deliveries are re-read; dedupe makes the re-read harmless.
      const oldest = prev ? String(Math.max(Math.min(Number(prev.ts) - overlapS, reactionFrom), ctx.since / 1000)) : String(ctx.since / 1000)
      let latestSeen = prev?.ts ?? oldest
      const threads: Record<string, string> = {}
      const seenParents = new Set<string>()
      let pageCursor: string | undefined

      try {
        do {
          const res = await api('conversations.history', {
            channel: channel.id,
            oldest,
            limit: '200',
            ...(pageCursor ? { cursor: pageCursor } : {}),
          })
          const messages = (res.messages as SlackMessage[]) ?? []

          for (const msg of messages) {
            if ((!msg.text && !msg.files?.length) || msg.subtype === 'channel_join') continue
            docs.push(mkDoc(msg))
            noteReactions(msg)
            if (msg.ts > latestSeen) latestSeen = msg.ts

            if (msg.reply_count && msg.reply_count > 0) {
              seenParents.add(msg.ts)
              const known = prev?.threads[msg.ts]
              const newest = await replies(msg.ts, known)
              if (newest !== null) threads[msg.ts] = newest ?? known ?? msg.ts
            }
          }
          pageCursor = (res.response_metadata as { next_cursor?: string })?.next_cursor || undefined
        } while (pageCursor)

        // Threads we track whose parent has aged out of the history window:
        // ask only for replies newer than the last one we saw.
        for (const [parentTs, lastReply] of Object.entries(prev?.threads ?? {})) {
          if (seenParents.has(parentTs)) continue
          if (nowS - Number(parentTs) > threadWindowS) continue
          const newest = await replies(parentTs, lastReply)
          if (newest !== null) threads[parentTs] = newest ?? lastReply
        }

        cursor[channel.id] = { ts: latestSeen, threads }
        for (const [ref, entry] of Object.entries(channelFiles)) {
          if (entry.files.length) fileIndex[ref] = entry
          else delete fileIndex[ref]
        }
        // This channel's window was re-read: what it holds now replaces what the index had.
        for (const [ref, entry] of Object.entries(reactionIndex)) {
          if (entry.channel === name && Number(entry.ts) >= reactionFrom) delete reactionIndex[ref]
        }
        Object.assign(reactionIndex, channelReactions)
        ctx.log(`slack: ${name} → ${docs.length} docs so far`)
      } catch (err) {
        // This channel keeps its previous cursor and is retried next run;
        // drop its half-read docs so nothing lands ahead of the cursor.
        docs.length = before
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    for (const [ref, entry] of Object.entries(reactionIndex)) if (Number(entry.ts) < nowS - REACTION_KEEP_DAYS * DAY_S) delete reactionIndex[ref]
    return {
      docs,
      nextCursor: cursor,
      files: { [SLACK_FILES]: stringify(fileIndex), [SLACK_REACTIONS]: stringify(reactionIndex) },
      ...(errors.length ? { errors } : {}),
    }
  },
}

/** Fetch replies to one thread, newer than `after` when given (exclusive).
 * Returns the newest reply ts seen, or undefined when there were none.
 * With `scan`, the whole thread is read and every reply passed to it;
 * only replies newer than `after` are still emitted. */
async function pullReplies(
  api: SlackApi,
  channel: string,
  parentTs: string,
  after: string | undefined,
  emit: (reply: SlackMessage) => void,
  scan?: (reply: SlackMessage) => void,
): Promise<string | undefined> {
  let newest: string | undefined
  let pageCursor: string | undefined
  do {
    const res = await api('conversations.replies', {
      channel,
      ts: parentTs,
      limit: '200',
      ...(after && !scan ? { oldest: after } : {}),
      ...(pageCursor ? { cursor: pageCursor } : {}),
    })
    for (const reply of (res.messages as SlackMessage[]) ?? []) {
      if (reply.ts === parentTs || (!reply.text && !reply.files?.length)) continue
      scan?.(reply)
      if (after && reply.ts <= after) continue
      emit(reply)
      if (!newest || reply.ts > newest) newest = reply.ts
    }
    pageCursor = (res.response_metadata as { next_cursor?: string })?.next_cursor || undefined
  } while (pageCursor)
  return newest
}

function readCursor(raw: string | ChannelCursor | undefined): ChannelCursor | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string') return { ts: raw, threads: {} }
  return { ts: raw.ts, threads: raw.threads ?? {} }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? value : fallback
}

interface SlackMessage {
  ts: string
  user?: string
  bot_id?: string
  text?: string
  subtype?: string
  reply_count?: number
  edited?: { user?: string; ts: string }
  files?: SlackFile[]
  reactions?: { name: string; users?: string[]; count?: number }[]
}

/** `team`: a full member of the bot's workspace — not a guest, bot, deactivated or Slack Connect user. */
interface SlackUser { name: string; team: boolean }

interface SlackFile {
  id: string
  name?: string
  title?: string
  mimetype?: string
  size?: number
  url_private?: string
  url_private_download?: string
}

function messageFiles(msg: SlackMessage, ref: string, author: string): RemoteAttachment[] {
  return (msg.files ?? []).map((f) => {
    const url = f.url_private_download || f.url_private || ''
    return { ref, sourceId: f.id, name: f.name || f.title || f.id, mime: f.mimetype, size: f.size, url,
      author, created: new Date(Number(msg.ts) * 1000).toISOString() }
  })
}

type SlackApi = (method: string, params: Record<string, string>) => Promise<Record<string, unknown>>

function slackClient(apiBase: string, token: string | undefined): SlackApi {
  return async function call(method, params) {
    const res = await fetch(`${apiBase}/${method}?${new URLSearchParams(params)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After') ?? '30')
      await new Promise((r) => setTimeout(r, wait * 1000))
      return call(method, params)
    }
    const body = (await res.json()) as Record<string, unknown>
    if (!body.ok) throw new SlackApiError(method, String(body.error))
    return body
  }
}

async function teamId(api: SlackApi): Promise<string> {
  const res = await api('auth.test', {})
  return (res.team_id as string) ?? 'unknown'
}

interface SlackMember {
  id: string
  team_id?: string
  deleted?: boolean
  is_bot?: boolean
  is_restricted?: boolean
  is_ultra_restricted?: boolean
  profile?: { display_name?: string; real_name?: string }
}

async function userMap(api: SlackApi, team: string): Promise<Map<string, SlackUser>> {
  const map = new Map<string, SlackUser>()
  let cursor: string | undefined
  do {
    const res = await api('users.list', { limit: '200', ...(cursor ? { cursor } : {}) })
    for (const u of (res.members as SlackMember[]) ?? []) {
      map.set(u.id, {
        name: u.profile?.display_name || u.profile?.real_name || u.id,
        team: !u.deleted && !u.is_bot && !u.is_restricted && !u.is_ultra_restricted && u.id !== 'USLACKBOT' && (!u.team_id || u.team_id === team),
      })
    }
    cursor = (res.response_metadata as { next_cursor?: string })?.next_cursor || undefined
  } while (cursor)
  return map
}

async function channelMap(api: SlackApi): Promise<Map<string, { id: string }>> {
  const map = new Map<string, { id: string }>()
  let cursor: string | undefined
  do {
    const res = await api('conversations.list', {
      types: 'public_channel,private_channel',
      limit: '200',
      ...(cursor ? { cursor } : {}),
    })
    for (const c of (res.channels as { id: string; name: string }[]) ?? []) {
      map.set(c.name, { id: c.id })
    }
    cursor = (res.response_metadata as { next_cursor?: string })?.next_cursor || undefined
  } while (cursor)
  return map
}

function toDoc(
  msg: SlackMessage,
  channelName: string,
  channelId: string,
  users: Map<string, SlackUser>,
  ids: { team: string; channel: string },
  thread?: string,
): Doc {
  const meta: Record<string, string> = { team: ids.team, channel: ids.channel }
  if (msg.user) meta.user = msg.user
  else if (msg.bot_id) meta.bot = msg.bot_id
  if (msg.edited) meta.edited = msg.edited.ts
  return {
    id: `slack-${channelId}-${msg.ts}`,
    source: 'slack',
    channel: channelName,
    author: (msg.user && users.get(msg.user)?.name) || msg.user || 'unknown',
    timestamp: new Date(Number(msg.ts) * 1000).toISOString(),
    permalink: permalinkFor(channelId, msg.ts),
    thread,
    meta,
    text: [msg.text ?? '', ...(msg.files ?? []).map((f) => `Attachment: ${JSON.stringify(f.name || f.title || f.id)} (${f.mimetype || 'file'}; Slack file ${f.id})`)].filter(Boolean).join('\n\n'),
  }
}

function permalinkFor(channelId: string, ts: string): string {
  return `https://slack.com/archives/${channelId}/p${ts.replace('.', '')}`
}
