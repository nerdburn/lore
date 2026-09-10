import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { buildQuery, gmail, htmlToText, normalizeMessageId, parseAddress, signJwt, splitAddresses, trimQuoted, type GmailMessage } from '../src/connectors/gmail.js'
import type { ConnectorContext } from '../src/types.js'

// One RSA key pair for the whole file (generation is the slow part).
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const SA = { client_email: 'lore@lore-sync.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }
const TOKEN_URL = 'https://oauth2.test/token'
const API = 'https://gmail.test'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function msg(id: string, over: { from?: string; to?: string; cc?: string; subject?: string; messageId?: string; references?: string; date?: string; text?: string; html?: string; attachments?: string[] } = {}): GmailMessage {
  const headers = [
    { name: 'From', value: over.from ?? 'Priya Patel <priya@acme.com>' },
    { name: 'To', value: over.to ?? 'Shawn Adrian <shawn@inputlogic.ca>' },
    ...(over.cc ? [{ name: 'Cc', value: over.cc }] : []),
    { name: 'Subject', value: over.subject ?? 'Launch timing' },
    { name: 'Message-ID', value: over.messageId ?? `<${id}@mail.acme.com>` },
    ...(over.references ? [{ name: 'References', value: over.references }] : []),
  ]
  const parts = [
    ...(over.text !== undefined || over.html === undefined ? [{ mimeType: 'text/plain', body: { data: b64(over.text ?? 'Can we move launch to the 14th?') } }] : []),
    ...(over.html ? [{ mimeType: 'text/html', body: { data: b64(over.html) } }] : []),
    ...(over.attachments ?? []).map((f) => ({ mimeType: 'application/pdf', filename: f, body: { attachmentId: `att-${f}`, size: 10 } })),
  ]
  return { id, threadId: `t-${id}`, internalDate: String(Date.parse(over.date ?? '2026-08-10T10:00:00Z')), payload: { mimeType: 'multipart/mixed', headers, parts } }
}

/** A fake Google: the OAuth token endpoint (verifies the JWT) and Gmail's list/get. */
function fakeGoogle() {
  const state = {
    mailboxes: {} as Record<string, GmailMessage[]>,
    /** mailboxes the admin has NOT delegated */
    undelegated: new Set<string>(),
    calls: [] as string[],
    queries: [] as string[],
    tokensMinted: [] as string[],
    rateLimitOnce: false,
  }
  const json = (b: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    state.calls.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`)
    if (`${url.origin}${url.pathname}` === TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body))
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')
      const [h, c, sig] = form.get('assertion')!.split('.')
      const header = JSON.parse(Buffer.from(h, 'base64url').toString())
      const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
      assert.equal(header.alg, 'RS256')
      const v = createVerify('RSA-SHA256')
      v.update(`${h}.${c}`)
      assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')), 'JWT signed by the service account key')
      assert.equal(claims.iss, SA.client_email)
      assert.equal(claims.aud, TOKEN_URL)
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/gmail.readonly')
      if (state.undelegated.has(claims.sub)) return json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' }, { status: 401 })
      state.tokensMinted.push(claims.sub)
      return json({ access_token: `tok-${claims.sub}`, expires_in: 3600, token_type: 'Bearer' })
    }
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? ''
    const user = /^Bearer tok-(.+)$/.exec(auth)?.[1]
    if (!user) return json({ error: { code: 401, message: 'Invalid Credentials' } }, { status: 401 })
    if (state.rateLimitOnce) {
      state.rateLimitOnce = false
      return json({ error: { code: 429, message: 'Too many concurrent requests' } }, { status: 429, headers: { 'retry-after': '0' } })
    }
    const path = url.pathname
    if (path === '/gmail/v1/users/me/messages') {
      state.queries.push(`${user}: ${url.searchParams.get('q')}`)
      const after = Number(/after:(\d+)/.exec(url.searchParams.get('q') ?? '')?.[1] ?? 0) * 1000
      const all = (state.mailboxes[user] ?? []).filter((m) => Number(m.internalDate) >= after)
      const page = Number(url.searchParams.get('pageToken') ?? 0)
      const size = 2
      const slice = all.slice(page * size, page * size + size)
      return json({ messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })), ...(all.length > (page + 1) * size ? { nextPageToken: String(page + 1) } : {}), resultSizeEstimate: all.length })
    }
    const m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path)
    if (m) {
      const found = (state.mailboxes[user] ?? []).find((x) => x.id === m[1])
      return found ? json(found) : json({ error: { code: 404, message: 'Not Found' } }, { status: 404 })
    }
    return json({ error: { code: 404, message: `no route ${path}` } }, { status: 404 })
  }) as typeof fetch
  return state
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function ctx(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    config: { key: JSON.stringify(SA), api_base: API, token_url: TOKEN_URL },
    cursor: {},
    since: Date.parse('2026-07-01T00:00:00Z'),
    client: {
      name: 'Acme',
      domains: ['acme.com'],
      contacts: [
        { name: 'Priya Patel', email: 'priya@acme.com', side: 'client' },
        { name: 'Shawn Adrian', email: 'shawn@inputlogic.ca', role: 'Account lead', side: 'team' },
        { name: 'Kaity', email: 'kaity@inputlogic.ca', role: 'PM', side: 'team' },
      ],
    },
    log: () => {},
    readFile: () => undefined,
    ...over,
  }
}

test('gmail: helpers — addresses, message ids, query, html, quoted history', () => {
  assert.deepEqual(parseAddress('"Patel, Priya" <Priya@Acme.com>'), { name: 'Patel, Priya', email: 'priya@acme.com' })
  assert.deepEqual(parseAddress('priya@acme.com'), { name: '', email: 'priya@acme.com' })
  assert.deepEqual(
    splitAddresses('"Patel, Priya" <priya@acme.com>, shawn@inputlogic.ca, Kaity <kaity@inputlogic.ca>').map((a) => a.email),
    ['priya@acme.com', 'shawn@inputlogic.ca', 'kaity@inputlogic.ca'],
  )
  assert.equal(normalizeMessageId(' <ABC.123@Mail.Acme.com> '), 'abc.123@mail.acme.com')
  assert.equal(
    buildQuery(['acme.com', 'bob@partner.org'], Date.parse('2026-07-01T00:00:00Z'), '-label:newsletters'),
    '{from:acme.com to:acme.com cc:acme.com from:bob@partner.org to:bob@partner.org cc:bob@partner.org} after:1782864000 -label:chats -label:newsletters',
  )
  assert.equal(htmlToText('<div>Hi<br>there &amp; <b>you</b></div><p>Bye</p>'), 'Hi\nthere & you\nBye')
  assert.equal(
    trimQuoted('Sounds good, the 14th works.\n\nOn Mon, Aug 10, 2026 at 9:00 AM Shawn <shawn@inputlogic.ca> wrote:\n> Can we move launch?\n> Thanks'),
    'Sounds good, the 14th works.',
  )
  assert.equal(trimQuoted('Yes.\n\n-- \nPriya Patel\nHead of Product'), 'Yes.')
  assert.equal(trimQuoted('See below.\n\nFrom: Shawn Adrian\nSent: Monday\nTo: Priya\nSubject: Re: launch\n\nold text'), 'See below.')
  assert.equal(trimQuoted('Inline reply\n> quoted line\nmore of mine'), 'Inline reply\nmore of mine')
})

test('gmail: signJwt impersonates the mailbox with the read-only scope', () => {
  const jwt = signJwt(SA, 'kaity@inputlogic.ca', TOKEN_URL, Date.parse('2026-09-10T00:00:00Z'))
  const [h, c, sig] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
  assert.equal(claims.sub, 'kaity@inputlogic.ca')
  assert.equal(claims.exp - claims.iat, 3600)
  const v = createVerify('RSA-SHA256')
  v.update(`${h}.${c}`)
  assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')))
})

test('gmail: reads every team mailbox, scopes by client domain, dedups a thread seen in two inboxes on Message-ID', async () => {
  const g = fakeGoogle()
  const shared = msg('s1', { to: 'shawn@inputlogic.ca, kaity@inputlogic.ca', attachments: ['SOW-v2.pdf'] })
  const reply = msg('r1', {
    from: 'Kaity <kaity@inputlogic.ca>',
    to: 'priya@acme.com',
    subject: 'Re: Launch timing',
    references: '<s1@mail.acme.com>',
    date: '2026-08-11T09:30:00Z',
    text: 'Yes, the 14th works for us.\n\nOn Mon, Aug 10, 2026 Priya Patel <priya@acme.com> wrote:\n> Can we move launch to the 14th?',
  })
  const htmlOnly = msg('h1', { from: 'Dev <dev@acme.com>', subject: 'Staging creds', html: '<p>Staging is <b>up</b>.<br>Login with SSO.</p>', text: undefined, date: '2026-08-12T08:00:00Z' })
  g.mailboxes['shawn@inputlogic.ca'] = [shared, { ...shared, id: 's1-dup-in-other-label' }, htmlOnly]
  g.mailboxes['kaity@inputlogic.ca'] = [{ ...shared, id: 'k-s1' }, reply]

  const { docs, nextCursor, errors } = await gmail.fetch(ctx())
  assert.equal(errors, undefined)
  assert.deepEqual(g.tokensMinted.sort(), ['kaity@inputlogic.ca', 'shawn@inputlogic.ca'], 'one token per mailbox, from the team-side contacts')
  assert.equal(g.tokensMinted.length, 2, 'tokens are cached across list + get calls')
  for (const q of g.queries) assert.match(q, /\{from:acme\.com to:acme\.com cc:acme\.com\} after:1782864000 -label:chats$/)

  const byId = new Map(docs.map((d) => [d.meta?.message_id, d]))
  assert.equal(docs.length, 3, 'shared thread starter counted once across mailboxes and labels')
  const starter = byId.get('s1@mail.acme.com')!
  assert.equal(starter.channel, 'acme.com')
  assert.equal(starter.author, 'Priya Patel')
  assert.equal(starter.timestamp, '2026-08-10T10:00:00.000Z')
  assert.equal(starter.meta?.mailboxes, 'shawn@inputlogic.ca,kaity@inputlogic.ca')
  assert.equal(starter.meta?.from, 'priya@acme.com')
  assert.equal(starter.meta?.to, 'shawn@inputlogic.ca,kaity@inputlogic.ca')
  assert.equal(starter.permalink, 'https://mail.google.com/mail/#search/rfc822msgid:s1%40mail.acme.com')
  assert.equal(starter.thread, undefined)
  assert.match(starter.text, /^\*\*Launch timing\*\*\n\nFrom: Priya Patel <priya@acme.com>\nTo: shawn@inputlogic.ca, kaity@inputlogic.ca\n\nCan we move launch to the 14th\?\n\nAttachments: SOW-v2\.pdf$/)

  const rep = byId.get('r1@mail.acme.com')!
  assert.equal(rep.thread, starter.id, 'replies chain on the first References id, stable across inboxes')
  assert.equal(rep.author, 'Kaity')
  assert.match(rep.text, /Yes, the 14th works for us\.$/, 'quoted history trimmed')
  assert.ok(!rep.text.includes('wrote:'))

  const html = byId.get('h1@mail.acme.com')!
  assert.match(html.text, /Staging is up\.\nLogin with SSO\.$/)

  assert.equal((nextCursor as { since: string }).since, '2026-08-12T08:00:00.000Z')
  for (const d of docs) for (const v of Object.values(d.meta ?? {})) assert.ok(!/\s/.test(v), `meta values are single tokens: ${v}`)
})

test('gmail: users/exclude override the contacts; a mailbox without delegation is an error but the rest still sync', async () => {
  const g = fakeGoogle()
  g.mailboxes['shawn@inputlogic.ca'] = [msg('a')]
  g.mailboxes['nick@inputlogic.ca'] = [msg('b', { messageId: '<b@mail.acme.com>' })]
  g.undelegated.add('nick@inputlogic.ca')

  const r = await gmail.fetch(ctx({ config: { ...ctx().config, users: ['shawn@inputlogic.ca', 'nick@inputlogic.ca', 'kaity@inputlogic.ca'], exclude: ['kaity@inputlogic.ca'] } }))
  assert.equal(r.docs.length, 1)
  assert.equal(r.errors?.length, 1)
  assert.match(r.errors![0], /^mailbox nick@inputlogic\.ca: token for nick@inputlogic\.ca: unauthorized_client .*domain-wide delegation/)
  assert.ok(!g.queries.some((q) => q.startsWith('kaity@')), 'excluded mailbox never queried')
})

test('gmail: incremental — after: comes from the cursor minus overlap; 429 is retried; pagination followed', async () => {
  const g = fakeGoogle()
  g.rateLimitOnce = true
  g.mailboxes['shawn@inputlogic.ca'] = ['1', '2', '3', '4', '5'].map((i) => msg(`m${i}`, { messageId: `<m${i}@mail.acme.com>`, date: `2026-08-1${i}T10:00:00Z` }))
  const r = await gmail.fetch(ctx({ config: { ...ctx().config, users: ['shawn@inputlogic.ca'] }, cursor: { since: '2026-08-13T00:00:00.000Z' } }))
  // since - 2d overlap = 2026-08-11 → m1 (Aug 11) onward
  assert.match(g.queries[0], /after:1786406400/)
  assert.deepEqual(r.docs.map((d) => d.meta?.message_id).sort(), ['m1@mail.acme.com', 'm2@mail.acme.com', 'm3@mail.acme.com', 'm4@mail.acme.com', 'm5@mail.acme.com'])
  assert.ok(g.calls.filter((c) => c.endsWith('/gmail/v1/users/me/messages')).length >= 3, 'followed nextPageToken')
  assert.equal((r.nextCursor as { since: string }).since, '2026-08-15T10:00:00.000Z')
})

test('gmail: key_file on disk works; missing key, no mailboxes, and no scope are clear errors', async () => {
  fakeGoogle()
  const dir = mkdtempSync(join(tmpdir(), 'lore-gmail-'))
  const keyFile = join(dir, 'sa.json')
  writeFileSync(keyFile, JSON.stringify(SA))
  const ok = await gmail.fetch(ctx({ config: { key_file: keyFile, api_base: API, token_url: TOKEN_URL } }))
  assert.deepEqual(ok.docs, [])

  await assert.rejects(gmail.fetch(ctx({ config: { key_file: join(dir, 'nope.json'), api_base: API } })), /no service account key — put the JSON key at .*nope\.json/)
  await assert.rejects(gmail.fetch(ctx({ config: { key: '{"client_email":"x"}', api_base: API } })), /needs client_email and private_key/)
  const noTeam = ctx()
  noTeam.client = { ...noTeam.client!, contacts: noTeam.client!.contacts.filter((c) => c.side !== 'team') }
  await assert.rejects(gmail.fetch(noTeam), /no mailboxes to read/)
  const noScope = ctx({ config: { ...ctx().config, users: ['shawn@inputlogic.ca'] } })
  noScope.client = { name: 'Acme', domains: [], contacts: [] }
  await assert.rejects(gmail.fetch(noScope), /nothing scopes mail to this client/)
})
