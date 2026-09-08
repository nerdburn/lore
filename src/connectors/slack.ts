import type { Connector, ConnectorContext, Cursor, Doc } from '../types.js'

/**
 * Slack connector.
 *
 * Requires a bot token with `channels:history`, `channels:read`, `users:read`,
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
 */

interface ChannelCursor {
  ts: string
  threads: Record<string, string>
}

/** Pre-0.4 cursors were `{ [channelId]: ts }`; read both, write the new shape. */
type SlackCursor = Record<string, string | ChannelCursor>

const DEFAULT_API_BASE = 'https://slack.com/api'
const DEFAULT_OVERLAP_DAYS = 7
const DEFAULT_THREAD_WINDOW_DAYS = 30
const DAY_S = 86_400

export const slack: Connector = {
  name: 'slack',

  async fetch(ctx: ConnectorContext) {
    const token = ctx.config.token as string | undefined
    const apiBase = ((ctx.config.api_base as string | undefined) ?? DEFAULT_API_BASE).replace(/\/$/, '')
    const wanted = (ctx.config.channels as string[]) ?? []
    if (!token && ctx.config.api_base === undefined) throw new Error('slack: no token resolved (set token, or api_base to a proxy that injects one)')
    if (wanted.length === 0) throw new Error('slack: no channels whitelisted in config')
    const overlapS = numberOr(ctx.config.overlap_days, DEFAULT_OVERLAP_DAYS) * DAY_S
    const threadWindowS = numberOr(ctx.config.thread_window_days, DEFAULT_THREAD_WINDOW_DAYS) * DAY_S

    const api = slackClient(apiBase, token)
    const team = await teamId(api)
    const users = await userMap(api)
    const channels = await channelMap(api)
    const cursor = { ...(ctx.cursor as SlackCursor) }
    const docs: Doc[] = []
    const errors: string[] = []
    const nowS = Date.now() / 1000

    for (const name of wanted) {
      const channel = channels.get(name.replace(/^#/, ''))
      if (!channel) {
        errors.push(`channel ${name} not found or bot not a member — /invite @lore, and check the exact name`)
        continue
      }
      const prev = readCursor(cursor[channel.id])
      const meta = { team, channel: channel.id }
      const mkDoc = (msg: SlackMessage, thread?: string) => toDoc(msg, name, channel.id, users, meta, thread)

      // No cursor (first sync, or channel newly added to config) → start at
      // the backfill window. Otherwise back off by the overlap so late edits
      // and deliveries are re-read; dedupe makes the re-read harmless.
      const oldest = prev ? String(Math.max(Number(prev.ts) - overlapS, ctx.since / 1000)) : String(ctx.since / 1000)
      let latestSeen = prev?.ts ?? oldest
      const threads: Record<string, string> = {}
      const seenParents = new Set<string>()
      let pageCursor: string | undefined

      do {
        const res = await api('conversations.history', {
          channel: channel.id,
          oldest,
          limit: '200',
          ...(pageCursor ? { cursor: pageCursor } : {}),
        })
        const messages = (res.messages as SlackMessage[]) ?? []

        for (const msg of messages) {
          if (!msg.text || msg.subtype === 'channel_join') continue
          docs.push(mkDoc(msg))
          if (msg.ts > latestSeen) latestSeen = msg.ts

          if (msg.reply_count && msg.reply_count > 0) {
            seenParents.add(msg.ts)
            const known = prev?.threads[msg.ts]
            const newest = await pullReplies(api, channel.id, msg.ts, known, (r) => docs.push(mkDoc(r, msg.ts)))
            threads[msg.ts] = newest ?? known ?? msg.ts
          }
        }
        pageCursor = (res.response_metadata as { next_cursor?: string })?.next_cursor || undefined
      } while (pageCursor)

      // Threads we track whose parent has aged out of the history window:
      // ask only for replies newer than the last one we saw.
      for (const [parentTs, lastReply] of Object.entries(prev?.threads ?? {})) {
        if (seenParents.has(parentTs)) continue
        if (nowS - Number(parentTs) > threadWindowS) continue
        const newest = await pullReplies(api, channel.id, parentTs, lastReply, (r) => docs.push(mkDoc(r, parentTs)))
        threads[parentTs] = newest ?? lastReply
      }

      cursor[channel.id] = { ts: latestSeen, threads }
      ctx.log(`slack: ${name} → ${docs.length} docs so far`)
    }

    return { docs, nextCursor: cursor, ...(errors.length ? { errors } : {}) }
  },
}

/** Fetch replies to one thread, newer than `after` when given (exclusive).
 * Returns the newest reply ts seen, or undefined when there were none. */
async function pullReplies(
  api: SlackApi,
  channel: string,
  parentTs: string,
  after: string | undefined,
  emit: (reply: SlackMessage) => void,
): Promise<string | undefined> {
  let newest: string | undefined
  let pageCursor: string | undefined
  do {
    const res = await api('conversations.replies', {
      channel,
      ts: parentTs,
      limit: '200',
      ...(after ? { oldest: after } : {}),
      ...(pageCursor ? { cursor: pageCursor } : {}),
    })
    for (const reply of (res.messages as SlackMessage[]) ?? []) {
      if (reply.ts === parentTs || !reply.text) continue
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
    if (!body.ok) throw new Error(`slack ${method}: ${body.error}`)
    return body
  }
}

async function teamId(api: SlackApi): Promise<string> {
  const res = await api('auth.test', {})
  return (res.team_id as string) ?? 'unknown'
}

async function userMap(api: SlackApi): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let cursor: string | undefined
  do {
    const res = await api('users.list', { limit: '200', ...(cursor ? { cursor } : {}) })
    for (const u of (res.members as { id: string; profile?: { display_name?: string; real_name?: string } }[]) ?? []) {
      map.set(u.id, u.profile?.display_name || u.profile?.real_name || u.id)
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
  users: Map<string, string>,
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
    author: (msg.user && users.get(msg.user)) || msg.user || 'unknown',
    timestamp: new Date(Number(msg.ts) * 1000).toISOString(),
    permalink: `https://slack.com/archives/${channelId}/p${msg.ts.replace('.', '')}`,
    thread,
    meta,
    text: msg.text ?? '',
  }
}
