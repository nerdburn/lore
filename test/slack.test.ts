import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { slack } from '../src/connectors/slack.js'
import type { ConnectorContext } from '../src/types.js'

/**
 * A fake Slack Web API behind globalThis.fetch. Messages live in `history`
 * (channel → parent messages) and `replies` (parent ts → replies). Tests
 * mutate these between syncs to simulate new traffic.
 */
interface Msg {
  ts: string
  user?: string
  text?: string
  subtype?: string
  reply_count?: number
  edited?: { ts: string }
  files?: { id: string; name?: string; mimetype?: string; size?: number; url_private?: string }[]
}

function fakeSlack() {
  const state = {
    history: {} as Record<string, Msg[]>,
    replies: {} as Record<string, Msg[]>,
    channels: [{ id: 'C0ACME', name: 'acme' }, { id: 'C0DEV', name: 'acme-dev' }],
    calls: [] as { method: string; params: Record<string, string> }[],
    rateLimitOnce: false,
    /** Thread parents that have been deleted: conversations.replies → thread_not_found. */
    deleted: new Set<string>(),
    /** Channels whose history call fails outright. */
    failing: new Set<string>(),
  }
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const method = url.pathname.replace('/api/', '')
    const params = Object.fromEntries(url.searchParams)
    state.calls.push({ method, params })
    if (state.rateLimitOnce) {
      state.rateLimitOnce = false
      return json({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'Retry-After': '0' } })
    }
    switch (method) {
      case 'auth.test':
        return json({ ok: true, team_id: 'T0TEAM' })
      case 'users.list':
        return json({
          ok: true,
          members: [
            { id: 'U0PRIYA', profile: { display_name: 'Priya' } },
            { id: 'U0SHAWN', profile: { display_name: '', real_name: 'Shawn Adrian' } },
          ],
        })
      case 'conversations.list':
        return json({ ok: true, channels: state.channels })
      case 'conversations.history': {
        if (state.failing.has(params.channel)) return json({ ok: false, error: 'internal_error' })
        const oldest = Number(params.oldest ?? 0)
        const msgs = (state.history[params.channel] ?? []).filter((m) => Number(m.ts) > oldest)
        return json({ ok: true, messages: msgs })
      }
      case 'conversations.replies': {
        if (state.deleted.has(params.ts)) return json({ ok: false, error: 'thread_not_found' })
        const parent = (state.history[params.channel] ?? []).find((m) => m.ts === params.ts)
        const oldest = Number(params.oldest ?? 0)
        const all = [...(parent ? [parent] : []), ...(state.replies[params.ts] ?? [])]
        return json({ ok: true, messages: all.filter((m) => Number(m.ts) > oldest || m.ts === params.ts) })
      }
      default:
        return json({ ok: false, error: `unknown_method ${method}` })
    }
  }) as typeof fetch
  return state
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const NOW_S = Math.floor(Date.now() / 1000)
const daysAgo = (d: number, frac = '000100') => `${NOW_S - d * 86_400}.${frac}`

function ctx(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    config: { token: 'xoxb-test', channels: ['#acme'] },
    cursor: {},
    since: (NOW_S - 30 * 86_400) * 1000,
    log: () => {},
    readFile: () => undefined,
    ...over,
  }
}

test('slack: first sync backfills from `since`, maps users, keeps machine ids', async () => {
  const s = fakeSlack()
  s.history.C0ACME = [
    { ts: daysAgo(40), user: 'U0PRIYA', text: 'too old' },
    { ts: daysAgo(5), user: 'U0PRIYA', text: 'Can we ship before Black Friday?', edited: { ts: daysAgo(4) } },
    { ts: daysAgo(4), user: 'U0SHAWN', text: 'joined', subtype: 'channel_join' },
    { ts: daysAgo(3), user: 'U0BOT', text: 'from someone not in users.list' },
  ]
  const { docs, nextCursor, errors } = await slack.fetch(ctx())
  assert.equal(errors, undefined)
  assert.deepEqual(
    docs.map((d) => d.text),
    ['Can we ship before Black Friday?', 'from someone not in users.list'],
  )
  const first = docs[0]
  assert.equal(first.id, `slack-C0ACME-${daysAgo(5)}`)
  assert.equal(first.author, 'Priya')
  assert.equal(first.channel, '#acme')
  assert.equal(first.permalink, `https://slack.com/archives/C0ACME/p${daysAgo(5).replace('.', '')}`)
  assert.deepEqual(first.meta, { team: 'T0TEAM', channel: 'C0ACME', user: 'U0PRIYA', edited: daysAgo(4) })
  assert.equal(docs[1].author, 'U0BOT')
  const c = nextCursor.C0ACME as { ts: string; threads: Record<string, string> }
  assert.equal(c.ts, daysAgo(3))
  assert.deepEqual(c.threads, {})
})

test('slack: thread replies are fetched and attributed to their parent', async () => {
  const s = fakeSlack()
  const parent = daysAgo(5)
  s.history.C0ACME = [{ ts: parent, user: 'U0PRIYA', text: 'parent', reply_count: 2 }]
  s.replies[parent] = [
    { ts: daysAgo(5, '000200'), user: 'U0SHAWN', text: 'reply one' },
    { ts: daysAgo(2), user: 'U0PRIYA', text: 'reply two' },
  ]
  const { docs, nextCursor } = await slack.fetch(ctx())
  assert.deepEqual(docs.map((d) => [d.text, d.thread]), [
    ['parent', undefined],
    ['reply one', parent],
    ['reply two', parent],
  ])
  const c = nextCursor.C0ACME as { ts: string; threads: Record<string, string> }
  assert.equal(c.ts, parent, 'channel cursor tracks top-level messages; replies are tracked per thread')
  assert.deepEqual(c.threads, { [parent]: daysAgo(2) })
})

test('slack: a late reply to a thread whose parent left the window still syncs', async () => {
  const s = fakeSlack()
  const parent = daysAgo(20)
  s.history.C0ACME = [
    { ts: parent, user: 'U0PRIYA', text: 'old parent', reply_count: 1 },
    { ts: daysAgo(10), user: 'U0SHAWN', text: 'later top-level' },
  ]
  s.replies[parent] = [{ ts: daysAgo(19), user: 'U0SHAWN', text: 'old reply' }]
  const first = await slack.fetch(ctx())
  assert.equal(first.docs.length, 3)
  assert.equal((first.nextCursor.C0ACME as { ts: string }).ts, daysAgo(10))

  // Time passes: a new channel message and a late reply to the old thread,
  // whose parent (20d) is now outside the 1d overlap from the cursor (10d).
  s.history.C0ACME.push({ ts: daysAgo(1), user: 'U0PRIYA', text: 'new message' })
  s.replies[parent].push({ ts: daysAgo(0, '000900'), user: 'U0PRIYA', text: 'late reply' })
  s.calls.length = 0
  const second = await slack.fetch(ctx({ cursor: first.nextCursor }))

  assert.deepEqual(
    second.docs.map((d) => d.text).sort(),
    ['late reply', 'later top-level', 'new message'],
    'the old parent is outside the overlap and not refetched; its late reply is; the 10d message is re-read by the overlap (deduped downstream)',
  )
  assert.equal(second.docs.find((d) => d.text === 'late reply')?.thread, parent)
  const replyCalls = s.calls.filter((c) => c.method === 'conversations.replies')
  assert.equal(replyCalls.length, 1)
  assert.equal(replyCalls[0].params.oldest, daysAgo(19), 'asks only for replies after the last one seen')
  const c = second.nextCursor.C0ACME as { ts: string; threads: Record<string, string> }
  assert.equal(c.threads[parent], daysAgo(0, '000900'))
  assert.equal(c.ts, daysAgo(1))
})

test('slack: threads older than thread_window_days are dropped from tracking', async () => {
  const s = fakeSlack()
  const parent = daysAgo(45)
  s.history.C0ACME = []
  const cursor = { C0ACME: { ts: daysAgo(2), threads: { [parent]: daysAgo(44) } } }
  const { nextCursor } = await slack.fetch(ctx({ cursor }))
  const c = nextCursor.C0ACME as { ts: string; threads: Record<string, string> }
  assert.deepEqual(c.threads, {})
  assert.equal(s.calls.filter((k) => k.method === 'conversations.replies').length, 0)
})

test('slack: incremental sync re-reads the overlap window (dedup happens downstream)', async () => {
  const s = fakeSlack()
  s.history.C0ACME = [
    { ts: daysAgo(10), user: 'U0PRIYA', text: 'ten days ago' },
    { ts: daysAgo(3), user: 'U0PRIYA', text: 'three days ago' },
  ]
  const { nextCursor } = await slack.fetch(ctx())
  s.calls.length = 0
  const again = await slack.fetch(ctx({ cursor: nextCursor, config: { token: 't', channels: ['#acme'], overlap_days: 5 } }))
  const hist = s.calls.find((c) => c.method === 'conversations.history')!
  assert.equal(Number(hist.params.oldest), Number(daysAgo(3)) - 5 * 86_400)
  assert.deepEqual(again.docs.map((d) => d.text), ['three days ago'])
  assert.equal((again.nextCursor.C0ACME as { ts: string }).ts, daysAgo(3), 'cursor never moves backwards')
})

test('slack: legacy string cursors are migrated to the object shape', async () => {
  const s = fakeSlack()
  s.history.C0ACME = [{ ts: daysAgo(1), user: 'U0PRIYA', text: 'new' }]
  const { docs, nextCursor } = await slack.fetch(ctx({ cursor: { C0ACME: daysAgo(2) } }))
  assert.deepEqual(docs.map((d) => d.text), ['new'])
  assert.deepEqual(nextCursor.C0ACME, { ts: daysAgo(1), threads: {} })
})

test('slack: a configured channel the bot cannot see is a reported error, not a skip', async () => {
  const s = fakeSlack()
  s.history.C0ACME = [{ ts: daysAgo(1), user: 'U0PRIYA', text: 'fine' }]
  const { docs, errors } = await slack.fetch(ctx({ config: { token: 't', channels: ['#acme', '#acme-private'] } }))
  assert.equal(docs.length, 1, 'other channels still sync')
  assert.equal(errors?.length, 1)
  assert.match(errors![0], /#acme-private/)
  assert.match(errors![0], /invite/)
})

test('slack: honours 429 Retry-After and retries', async () => {
  const s = fakeSlack()
  s.history.C0ACME = [{ ts: daysAgo(1), user: 'U0PRIYA', text: 'after retry' }]
  s.rateLimitOnce = true
  const { docs } = await slack.fetch(ctx())
  assert.deepEqual(docs.map((d) => d.text), ['after retry'])
})

test('slack: api_base routes calls to a proxy and drops the Authorization header', async () => {
  const s = fakeSlack()
  s.history.C0ACME = [{ ts: daysAgo(1), user: 'U0PRIYA', text: 'via proxy' }]
  const seen: { url: string; auth?: string }[] = []
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), auth: (init?.headers as Record<string, string>)?.Authorization })
    return inner(input, init)
  }) as typeof fetch
  const { docs } = await slack.fetch(ctx({ config: { channels: ['#acme'], api_base: 'http://slack.int.exe.xyz/api' } }))
  assert.deepEqual(docs.map((d) => d.text), ['via proxy'])
  assert.ok(seen.every((c) => c.url.startsWith('http://slack.int.exe.xyz/api/') && c.auth === undefined), JSON.stringify(seen[0]))
})

test('slack: missing token or channels fails loudly', async () => {
  fakeSlack()
  await assert.rejects(slack.fetch(ctx({ config: { channels: ['#a'] } })), /no token/)
  await assert.rejects(slack.fetch(ctx({ config: { token: 't', channels: [] } })), /no channels/)
})

test('slack: API errors propagate with the method name', async () => {
  const s = fakeSlack()
  s.channels = []
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }))) as typeof fetch
  await assert.rejects(slack.fetch(ctx()), /slack auth\.test: invalid_auth/)
})

test('slack: a tracked thread whose parent was deleted is dropped from tracking, not a failed sync', async () => {
  const s = fakeSlack()
  const gone = daysAgo(10)
  const alive = daysAgo(9)
  s.history.C0ACME = [{ ts: daysAgo(1), user: 'U0SHAWN', text: 'today' }]
  s.deleted.add(gone)
  s.replies[alive] = [{ ts: daysAgo(0, '000500'), user: 'U0PRIYA', text: 'late reply' }]
  const cursor = { C0ACME: { ts: daysAgo(2), threads: { [gone]: daysAgo(10, '000200'), [alive]: daysAgo(9, '000200') } } }
  const logs: string[] = []
  const { docs, nextCursor, errors } = await slack.fetch(ctx({ cursor, log: (m) => logs.push(m) }))
  assert.equal(errors, undefined)
  assert.deepEqual(docs.map((d) => d.text), ['today', 'late reply'])
  const c = nextCursor.C0ACME as { ts: string; threads: Record<string, string> }
  assert.deepEqual(c.threads, { [alive]: daysAgo(0, '000500') }, 'the deleted thread is gone from the cursor; the live one keeps tracking')
  assert.equal(c.ts, daysAgo(1))
  assert.ok(logs.some((l) => l.includes(`thread ${gone} no longer exists`)))
})

test('slack: a channel that fails mid-fetch is reported and keeps its cursor; the other channel still syncs', async () => {
  const s = fakeSlack()
  s.history.C0ACME = [{ ts: daysAgo(1), user: 'U0SHAWN', text: 'acme message' }]
  s.history.C0DEV = [{ ts: daysAgo(1), user: 'U0SHAWN', text: 'dev message' }]
  s.failing.add('C0DEV')
  const cursor = { C0ACME: { ts: daysAgo(3), threads: {} }, C0DEV: { ts: daysAgo(3), threads: {} } }
  const { docs, nextCursor, errors } = await slack.fetch(ctx({ cursor, config: { token: 't', channels: ['#acme', '#acme-dev'] } }))
  assert.deepEqual(docs.map((d) => d.text), ['acme message'])
  assert.deepEqual(errors, ['#acme-dev: slack conversations.history: internal_error'])
  assert.equal((nextCursor.C0ACME as { ts: string }).ts, daysAgo(1))
  assert.deepEqual(nextCursor.C0DEV, { ts: daysAgo(3), threads: {} }, 'the failed channel is retried from its old cursor next run')
})

test('slack: retains file-only messages and replies, and keeps file metadata across incremental syncs', async () => {
  const s = fakeSlack()
  const parent = daysAgo(5)
  const reply = daysAgo(4)
  const file = { id: 'F1', name: 'banner.png', mimetype: 'image/png', size: 12, url_private: 'https://files.slack.com/files-pri/T-F1/banner.png' }
  s.history.C0ACME = [{ ts: parent, user: 'U0PRIYA', files: [file], reply_count: 1 }]
  s.replies[parent] = [{ ts: reply, files: [{ ...file, id: 'F2' }], text: '' }]
  const first = await slack.fetch(ctx())
  assert.equal(first.docs.length, 2)
  assert.match(first.docs[0].text, /Attachment: "banner.png"/)
  assert.equal(first.docs[1].thread, parent)
  assert.equal((first.nextCursor.C0ACME as { threads: Record<string, string> }).threads[parent], reply)
  const refs = first.docs.map((d) => d.permalink!)
  const attachmentCtx = { config: ctx().config, log: () => {}, readFile: (p: string) => first.files?.[p] }
  const files = await slack.attachments!(attachmentCtx, refs)
  assert.deepEqual(files.map((f) => [f.sourceId, f.ref]), [['F1', refs[0]], ['F2', refs[1]]])
  assert.equal(files[0].author, 'Priya')
  s.history.C0ACME = [{ ts: daysAgo(0), text: 'new text' }]
  const second = await slack.fetch(ctx({ cursor: first.nextCursor, readFile: attachmentCtx.readFile }))
  const later = await slack.attachments!({ ...attachmentCtx, readFile: (p) => second.files?.[p] }, refs)
  assert.deepEqual(later, files, 'old files remain available when a ticket is created after the message left the overlap')
  assert.deepEqual(await slack.attachments!({ ...attachmentCtx, config: { channels: ['#different'] } }, refs), [])
})

test('slack: a failed channel cannot publish partial file metadata', async () => {
  const s = fakeSlack()
  const parent = daysAgo(1)
  s.history.C0ACME = [{ ts: parent, files: [{ id: 'F1', name: 'image.png', url_private: 'https://files.slack.com/x' }], reply_count: 1 }]
  const inner = globalThis.fetch
  globalThis.fetch = (async (input, init) => String(input).includes('conversations.replies')
    ? new Response(JSON.stringify({ ok: false, error: 'internal_error' })) : inner(input, init)) as typeof fetch
  const result = await slack.fetch(ctx())
  assert.equal(result.docs.length, 0)
  assert.equal(result.errors?.length, 1)
  assert.deepEqual(await slack.attachments!({ config: ctx().config, log: () => {}, readFile: (p) => result.files?.[p] }, [`https://slack.com/archives/C0ACME/p${parent.replace('.', '')}`]), [])
})

test('slack: downloads use the file token or file proxy and refuse unrelated hosts and login pages', async () => {
  const calls: { url: string; auth: string | null }[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') })
    return new Response('image bytes', { headers: { 'content-type': 'image/png' } })
  }) as typeof fetch
  const att = { ref: 'r', sourceId: 'F1', name: 'image.png', mime: 'image/png', url: 'https://files.slack.com/files-pri/T-F1/image.png' }
  const ac = { config: { token: 'test-token' }, log: () => {} }
  await slack.download!(ac, att)
  await slack.download!({ ...ac, config: { token: 'test-token', files_base: 'https://slack-files.int.example' } }, att)
  assert.deepEqual(calls, [
    { url: att.url, auth: 'Bearer test-token' },
    { url: 'https://slack-files.int.example/files-pri/T-F1/image.png', auth: null },
  ])
  await assert.rejects(slack.download!(ac, { ...att, url: 'https://evil.example/image.png' }), /outside files.slack.com/)
  await assert.rejects(slack.download!({ ...ac, config: { api_base: 'https://slack.int.example/api' } }, att), /files_base/)
  assert.equal(calls.length, 2)
  globalThis.fetch = (async () => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch
  await assert.rejects(slack.download!(ac, att), /login page/)
})
