import type { Connector, ConnectorContext, Cursor, Doc } from '../types.js'

/**
 * Slack connector.
 *
 * Requires a bot token with `channels:history`, `channels:read`, `users:read`,
 * invited to every whitelisted channel. Only channels listed in config are
 * synced — never "everything the bot can see" (see SPEC §10).
 *
 * Cursor: { [channelId]: lastSeenTs }. Rate-limit aware: honors 429
 * Retry-After, which matters for backfills (new non-Marketplace apps get
 * ~1 req/min on conversations.history).
 */

interface SlackCursor extends Cursor {
  [channelId: string]: string
}

export const slack: Connector = {
  name: 'slack',

  async fetch(ctx: ConnectorContext) {
    const token = ctx.config.token as string
    const wanted = (ctx.config.channels as string[]) ?? []
    if (!token) throw new Error('slack: no token resolved')
    if (wanted.length === 0) throw new Error('slack: no channels whitelisted in config')

    const api = slackClient(token)
    const users = await userMap(api)
    const channels = await channelMap(api)
    const cursor = { ...(ctx.cursor as SlackCursor) }
    const docs: Doc[] = []

    for (const name of wanted) {
      const channel = channels.get(name.replace(/^#/, ''))
      if (!channel) {
        ctx.log(`slack: channel ${name} not found or bot not a member — skipping`)
        continue
      }
      // No cursor (first sync, or channel newly added to config) → start at
      // the backfill window. Seed latestSeen at the window start too, so an
      // empty window doesn't write a bogus cursor.
      const oldest = cursor[channel.id] ?? String(ctx.since / 1000)
      let latestSeen = oldest
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
          docs.push(toDoc(msg, name, channel.id, users, token))
          if (msg.ts > latestSeen) latestSeen = msg.ts

          // Pull thread replies for any message that started a thread.
          if (msg.reply_count && msg.reply_count > 0) {
            const thread = await api('conversations.replies', {
              channel: channel.id,
              ts: msg.ts,
              limit: '200',
            })
            for (const reply of (thread.messages as SlackMessage[]) ?? []) {
              if (reply.ts === msg.ts || !reply.text) continue
              docs.push(toDoc(reply, name, channel.id, users, token, msg.ts))
              if (reply.ts > latestSeen) latestSeen = reply.ts
            }
          }
        }
        pageCursor = (res.response_metadata as { next_cursor?: string })?.next_cursor || undefined
      } while (pageCursor)

      cursor[channel.id] = latestSeen
      ctx.log(`slack: ${name} → ${docs.length} docs so far`)
    }

    return { docs, nextCursor: cursor }
  },
}

interface SlackMessage {
  ts: string
  user?: string
  text?: string
  subtype?: string
  reply_count?: number
}

type SlackApi = (method: string, params: Record<string, string>) => Promise<Record<string, unknown>>

function slackClient(token: string): SlackApi {
  return async function call(method, params) {
    const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
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
  _token: string,
  thread?: string,
): Doc {
  return {
    id: `slack-${channelId}-${msg.ts}`,
    source: 'slack',
    channel: channelName,
    author: (msg.user && users.get(msg.user)) || msg.user || 'unknown',
    timestamp: new Date(Number(msg.ts) * 1000).toISOString(),
    permalink: `https://slack.com/archives/${channelId}/p${msg.ts.replace('.', '')}`,
    thread,
    text: msg.text ?? '',
  }
}
