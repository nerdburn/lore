import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { parse } from 'yaml'
import { boardRole, principalMatches } from '../src/board/access.js'
import { CodeStore, SessionSigner } from '../src/board/auth.js'
import type { MailMessage } from '../src/board/email.js'
import { boardAdd, boardEnable, boardRemove } from '../src/commands/board.js'
import { www } from '../src/commands/www.js'
import { createBlobStore } from '../src/blobs.js'
import { configSchema } from '../src/config.js'
import { writeGlobalConfig } from '../src/context.js'
import { captureConsole, makeContextRepo } from './helpers.js'

/**
 * The board end to end: a temp LORE_HOME whose remote is a directory of
 * bare repos (the host's layout), `lore www` with the board on, a fake
 * mailer that keeps the codes, and plain fetch as the browser.
 */
const home = mkdtempSync(join(tmpdir(), 'lore-board-'))
const bares = join(home, 'repos')
const webDir = join(home, 'web')
const mail: MailMessage[] = []
let base = ''
/** The board's clock: each sign-in steps it a minute past the per-address throttle. */
let clock = Date.parse('2026-09-23T12:00:00Z')
let host: { close(): Promise<void> }

const TRACKER = `- key: ACM-1
  title: Black Friday landing page
  status: in_progress
  state: open
  priority: P1
  labels: [launch]
  sources: []
  created: 2026-08-04
  updated: 2026-08-20
  history: []
- key: ACM-2
  title: Checkout copy
  status: todo
  state: open
  labels: []
  sources: []
  created: 2026-08-04
  updated: 2026-08-04
  history: []
- key: ACM-3
  title: Old promo
  status: done
  state: closed
  labels: []
  sources: []
  created: 2026-08-01
  updated: 2026-08-02
  history: []
`

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
}

function pushContext(name: string, config: Record<string, unknown>, files: Record<string, string> = {}): string {
  const bare = join(bares, `${name}.git`)
  execFileSync('git', ['init', '--quiet', '--bare', bare])
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const src = makeContextRepo(files, config)
  execFileSync('git', ['init', '--quiet', '-b', 'main', src])
  git(src, 'add', '-A')
  git(src, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '--quiet', '-m', 'fixture')
  git(src, 'push', '--quiet', bare, 'main')
  return bare
}

const acmeConfig = {
  project: 'acme',
  client: { name: 'Acme', domains: ['acme.com'] },
  sources: {},
  board: { enabled: true, members: ['jane@acme.com'], viewers: ['@viewers.io'] },
}

before(async () => {
  process.env.LORE_HOME = home
  writeGlobalConfig({ remote: bares })
  mkdirSync(bares, { recursive: true })
  mkdirSync(join(webDir, 'assets'), { recursive: true })
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>')
  writeFileSync(join(webDir, 'assets', 'app-abc.js'), 'console.log(1)')
  pushContext('lore-acme', acmeConfig, { 'context/work/lore/ACM.yaml': TRACKER })
  pushContext('lore-beta', { project: 'beta', sources: {}, board: { enabled: false, members: ['jane@acme.com'], viewers: [] } })
  const h = www({
    repos: bares,
    port: 0,
    host: '127.0.0.1',
    mcp: false,
    board: { cwd: home, admins: ['boss@inputlogic.ca'], secret: 'test-secret', webDir, now: () => clock, store: createBlobStore({ dir: join(home, 'assets') }), profilesFile: join(home, 'profiles.json'), sendMail: async (m) => void mail.push(m), log: () => {} },
  })
  host = h
  base = `http://127.0.0.1:${await h.ready}`
})

after(async () => {
  await host.close()
  delete process.env.LORE_HOME
  rmSync(home, { recursive: true, force: true })
})

async function api(path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  const res = await fetch(`${base}/api/board${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {}, setCookie: res.headers.get('set-cookie') ?? '' }
}

const sessions = new Map<string, string>()
/** A session for this address — fresh sign-in the first time, the same cookie after (the per-address limit is 5 an hour). */
async function session(email: string): Promise<string> {
  if (!sessions.has(email)) {
    clock += 3_600_000 // a new hour: the per-address window has passed
    sessions.set(email, await signIn(email))
  }
  return sessions.get(email)!
}

async function signIn(email: string): Promise<string> {
  clock += 60_000
  const before = mail.length
  assert.equal((await api('/login', { body: { email } })).status, 200)
  const msg = mail.slice(before).find((m) => m.to === email)
  assert.ok(msg, `a code was mailed to ${email}`)
  const code = /\b(\d{6})\b/.exec(msg.subject)![1]
  const res = await api('/verify', { body: { email, code } })
  assert.equal(res.status, 200)
  return res.setCookie.split(';')[0]
}

function headTracker(): Record<string, any>[] {
  return parse(git(join(bares, 'lore-acme.git'), 'show', 'HEAD:context/work/lore/ACM.yaml').replace(/^(#.*\n)+/, ''))
}

// ---- units ----

test('board: @domain entries match the whole domain only', () => {
  assert.ok(principalMatches('@acme.com', 'jane@acme.com'))
  assert.ok(!principalMatches('@acme.com', 'jane@notacme.com'))
  assert.ok(!principalMatches('@acme.com', 'jane@acme.com.evil.io'))
  assert.ok(principalMatches('Jane@Acme.com', 'jane@acme.com'))
})

test('board: roles — members, viewers, admins; disabled means nobody; archived means read-only', () => {
  const cfg = configSchema.parse(acmeConfig)
  assert.equal(boardRole(cfg, 'jane@acme.com'), 'member')
  assert.equal(boardRole(cfg, 'ann@viewers.io'), 'viewer')
  assert.equal(boardRole(cfg, 'boss@inputlogic.ca', ['boss@inputlogic.ca']), 'member')
  assert.equal(boardRole(cfg, 'rando@else.com'), undefined)
  assert.equal(boardRole({ ...cfg, board: { ...cfg.board!, enabled: false } }, 'boss@inputlogic.ca', ['boss@inputlogic.ca']), undefined)
  assert.equal(boardRole({ ...cfg, lifecycle: 'archived' }, 'jane@acme.com'), 'viewer')
})

test('board: sessions — tampering, expiry and a new epoch all fail', () => {
  const s = new SessionSigner('k', '0')
  const { value } = s.issue('jane@acme.com', 1000)
  assert.equal(s.verify(value, 2000)?.email, 'jane@acme.com')
  const [payload, mac] = value.split('.')
  const forged = Buffer.from(JSON.stringify({ email: 'boss@inputlogic.ca', iat: 1000, exp: 9e15 })).toString('base64url')
  assert.equal(s.verify(`${forged}.${mac}`, 2000), undefined)
  assert.equal(s.verify(`${payload}.${mac}x`, 2000), undefined)
  assert.equal(s.verify(value, 1000 + 91 * 86_400_000), undefined)
  assert.equal(new SessionSigner('k', '1').verify(value, 2000), undefined)
})

test('board: a code works once, and five wrong guesses burn it', () => {
  const codes = new CodeStore('k')
  const code = codes.create('a@b.co', 0)
  assert.equal(codes.check('a@b.co', code, 1), 'ok')
  assert.equal(codes.check('a@b.co', code, 2), 'expired')
  const next = codes.create('a@b.co', 0)
  const wrong = next === '000000' ? '000001' : '000000'
  for (let i = 0; i < 5; i++) assert.equal(codes.check('a@b.co', wrong, 1), 'wrong')
  assert.equal(codes.check('a@b.co', next, 1), 'expired')
  const late = codes.create('a@b.co', 0)
  assert.equal(codes.check('a@b.co', late, 11 * 60_000), 'expired')
})

// ---- over HTTP ----

test('board: an address with no access gets the same answer and no email', async () => {
  const before = mail.length
  const res = await api('/login', { body: { email: 'stranger@nowhere.com' } })
  assert.equal(res.status, 200)
  assert.equal(mail.length, before)
  assert.equal((await api('/login', { body: { email: 'not-an-email' } })).status, 400)
})

test('board: a wrong code is refused; the right one sets a long-lived HttpOnly cookie', async () => {
  clock += 60_000
  await api('/login', { body: { email: 'jane@acme.com' } })
  const code = /\b(\d{6})\b/.exec(mail.at(-1)!.subject)![1]
  assert.equal((await api('/verify', { body: { email: 'jane@acme.com', code: code === '123456' ? '654321' : '123456' } })).status, 401)
  const ok = await api('/verify', { body: { email: 'jane@acme.com', code } })
  assert.equal(ok.status, 200)
  assert.match(ok.setCookie, /lore_board=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=7776000/)
  const me = await api('/me', { cookie: ok.setCookie.split(';')[0] })
  assert.deepEqual(me.body, { email: 'jane@acme.com', admin: false, name: null, avatar: null })
})

test('board: a wrong code reads the same whether or not a code was ever sent', async () => {
  clock += 60_000
  await api('/login', { body: { email: 'jane@acme.com' } })
  const withCode = await api('/verify', { body: { email: 'jane@acme.com', code: '999999' } })
  const noCode = await api('/verify', { body: { email: 'stranger@nowhere.com', code: '999999' } })
  assert.equal(withCode.status, 401)
  assert.deepEqual(withCode.body, noCode.body)
})

test('board: asking for codes too fast is throttled', async () => {
  await signIn('ann@viewers.io')
  assert.equal((await api('/login', { body: { email: 'ann@viewers.io' } })).status, 429)
})

test('board: no session, no data', async () => {
  assert.equal((await api('/projects')).status, 401)
  assert.equal((await api('/p/lore-acme')).status, 401)
})

test('board: projects list only enabled boards the person is on, with their role', async () => {
  const boss = await signIn('boss@inputlogic.ca')
  const res = await api('/projects', { cookie: boss })
  assert.deepEqual(
    res.body.projects.map((p: any) => [p.context, p.role, p.prefix, p.counts.todo]),
    [['lore-acme', 'member', 'ACM', 1]],
  )
  assert.equal((await api('/p/lore-beta', { cookie: boss })).status, 404, 'a disabled board is invisible, even to admins')
})

test('board: a viewer can read the board but not change it', async () => {
  const bob = await signIn('bob@viewers.io')
  const board = await api('/p/lore-acme', { cookie: bob })
  assert.equal(board.status, 200)
  assert.equal(board.body.role, 'viewer')
  assert.deepEqual(board.body.items.map((i: any) => i.key), ['ACM-1', 'ACM-2', 'ACM-3'])
  assert.equal((await api('/p/lore-acme/items/ACM-2/move', { cookie: bob, body: { status: 'done' } })).status, 403)
})

test('board: a member moves, ranks, edits and adds — each change is a web history entry signed with the email, pushed to the host repo', async () => {
  const jane = await signIn('jane@acme.com')
  const moved = await api('/p/lore-acme/items/ACM-2/move', { cookie: jane, body: { status: 'in_progress', above: 'ACM-1' } })
  assert.equal(moved.status, 200, JSON.stringify(moved.body))
  let table = headTracker()
  assert.deepEqual(table.map((i) => i.key), ['ACM-2', 'ACM-1', 'ACM-3'])
  const acm2 = table[0]
  assert.equal(acm2.status, 'in_progress')
  assert.deepEqual(
    acm2.history.map((h: any) => [h.via, h.by, Object.keys(h.change)[0], h.reason]),
    [
      ['web', 'jane@acme.com', 'status', 'moved to in_progress on the board'],
      ['web', 'jane@acme.com', 'rank', 'reordered on the board'],
    ],
  )

  // Dropped at the end of the in_progress column: below ACM-1, i.e. above ACM-3.
  assert.equal((await api('/p/lore-acme/items/ACM-2/rank', { cookie: jane, body: { below: 'ACM-1' } })).status, 200)
  assert.deepEqual(headTracker().map((i) => i.key), ['ACM-1', 'ACM-2', 'ACM-3'])

  const edited = await api('/p/lore-acme/items/ACM-2', { method: 'PATCH', cookie: jane, body: { description: 'Rewrite the **checkout** copy.', priority: 'P2', note: 'agreed on the call' } })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  table = headTracker()
  assert.equal(table[1].description, 'Rewrite the **checkout** copy.')
  assert.equal(table[1].history.at(-1).reason, 'agreed on the call')

  const added = await api('/p/lore-acme/items', { cookie: jane, body: { title: 'Gift card banner', labels: ['launch'] } })
  assert.equal(added.status, 201)
  assert.equal(added.body.item.key, 'ACM-4')
  assert.equal(headTracker().at(-1).history[0].by, 'jane@acme.com')

  const audit = git(join(bares, 'lore-acme.git'), 'show', 'HEAD:context/audit.jsonl')
  assert.match(audit, /"via":"web".*"id":"ACM-4"/)
})

test('board: a bad move is a 4xx with the reason, not a crash', async () => {
  const jane = await signIn('jane@acme.com')
  const res = await api('/p/lore-acme/items/ACM-99/move', { cookie: jane, body: { status: 'done' } })
  assert.equal(res.status, 404)
})

test('board: cross-origin writes are refused, and JSON is required', async () => {
  assert.equal((await api('/login', { body: { email: 'jane@acme.com' }, origin: 'https://evil.example' })).status, 403)
  const res = await fetch(`${base}/api/board/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"email":"jane@acme.com"}' })
  assert.equal(res.status, 400)
})

test('board: the SPA is served under /board with a fallback to index.html', async () => {
  const deep = await fetch(`${base}/board/p/lore-acme`)
  assert.equal(deep.status, 200)
  assert.match(await deep.text(), /id="root"/)
  const asset = await fetch(`${base}/board/assets/app-abc.js`)
  assert.match(asset.headers.get('cache-control')!, /immutable/)
  const escape = await fetch(`${base}/board/..%2f..%2frepos`)
  assert.match(await escape.text(), /id="root"/)
})

test('board: with the board on, the host pages need an admin', async () => {
  const home = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(home.status, 302)
  assert.equal(home.headers.get('location'), '/board/')
  assert.equal((await fetch(`${base}/status.json`)).status, 401)
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  const boss = await signIn('boss@inputlogic.ca')
  assert.equal((await fetch(`${base}/status.json`, { headers: { cookie: boss } })).status, 200)
  const adminHome = await fetch(`${base}/`, { redirect: 'manual', headers: { cookie: boss } })
  assert.equal(adminHome.headers.get('location'), '/board/host', 'admins land on the HeroUI host page')
  const host = await api('/host', { cookie: boss })
  assert.equal(host.status, 200)
  assert.deepEqual(host.body.clients.map((c: any) => c.name), ['lore-acme', 'lore-beta'])
  assert.equal(host.body.playbook, undefined, 'the playbook lives on Help now')
  assert.match((await api('/help', { cookie: boss })).body.playbook, /<h1/)
  assert.equal((await api('/help', { cookie: await session('jane@acme.com') })).body.playbook, null, 'members get the board guide, not the playbook')
  assert.equal((await api('/host', { cookie: await signIn('jane@acme.com') })).status, 403, 'members are not host admins')
})

test('board: `lore board` edits lore.json in the context repo', async () => {
  const opts = { context: 'lore-beta', by: 'shawn' }
  await captureConsole(() => {
    boardEnable(home, true, opts)
    boardAdd(home, ['Priya@Beta.com', '@beta.com'], 'viewer', opts)
    boardAdd(home, ['priya@beta.com'], 'member', opts)
    boardRemove(home, ['@beta.com'], opts)
  })
  const cfg = JSON.parse(git(join(bares, 'lore-beta.git'), 'show', 'HEAD:lore.json'))
  assert.deepEqual(cfg.board, { enabled: true, members: ['jane@acme.com', 'priya@beta.com'], viewers: [] })
  assert.throws(() => boardAdd(home, ['nope'], 'member', opts), /not an email or @domain/)
})

// ---- files and comments ----

async function upload(cookie: string, key: string, name: string, bytes: Buffer, type: string, context = 'lore-acme') {
  const res = await fetch(`${base}/api/board/p/${context}/items/${key}/files`, {
    method: 'POST',
    headers: { cookie, 'content-type': type, 'x-file-name': encodeURIComponent(name) },
    body: bytes,
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

test('board files: a member uploads, the record lands in git, the bytes in the store; anyone on the board can fetch it, with ranges', async () => {
  const jane = await session('jane@acme.com')
  const png = Buffer.from('\x89PNG\r\n\x1a\n fake image bytes '.repeat(50))
  const up = await upload(jane, 'ACM-1', 'hero shot.png', png, 'image/png')
  assert.equal(up.status, 201, JSON.stringify(up.body))
  const sha = up.body.attachment.sha256
  assert.match(sha, /^[a-f0-9]{64}$/)

  const records = parse(git(join(bares, 'lore-acme.git'), 'show', 'HEAD:context/attachments.yaml').replace(/^(#.*\n)+/, ''))
  assert.deepEqual(
    records.map((r: any) => [r.ticket, r.name, r.type, r.size, r.source, r.by]),
    [['ACM-1', 'hero shot.png', 'image/png', png.length, 'board', 'jane@acme.com']],
  )
  assert.equal(headTracker().find((i) => i.key === 'ACM-1')!.history.at(-1).reason, 'attached hero shot.png')
  assert.ok(!git(join(bares, 'lore-acme.git'), 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').some((f) => f.endsWith('.png')), 'no bytes in git')

  // The same file again: recorded once.
  assert.equal((await upload(jane, 'ACM-1', 'again.png', png, 'image/png')).body.attachment.name, 'hero shot.png')

  const bob = await session('bob2@viewers.io')
  const got = await fetch(`${base}/api/board/p/lore-acme/files/${sha}`, { headers: { cookie: bob } })
  assert.equal(got.status, 200)
  assert.equal(got.headers.get('content-type'), 'image/png')
  assert.match(got.headers.get('content-disposition')!, /^inline; filename\*=UTF-8''hero%20shot\.png/)
  assert.match(got.headers.get('content-security-policy')!, /sandbox/)
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png)
  const part = await fetch(`${base}/api/board/p/lore-acme/files/${sha}`, { headers: { cookie: bob, range: 'bytes=0-3' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), `bytes 0-3/${png.length}`)
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), png.subarray(0, 4))

  assert.equal((await upload(bob, 'ACM-1', 'x.png', png, 'image/png')).status, 403, 'viewers cannot upload')
  assert.equal((await fetch(`${base}/api/board/p/lore-acme/files/${sha}`)).status, 401, 'no session, no file')
  assert.equal((await fetch(`${base}/api/board/p/lore-acme/files/${'0'.repeat(64)}`, { headers: { cookie: bob } })).status, 404, 'a hash no record names opens nothing')
})

test('board files: script-capable types download instead of rendering; oversize uploads are refused', async () => {
  const jane = await session('jane@acme.com')
  const svg = await upload(jane, 'ACM-2', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')
  const res = await fetch(`${base}/api/board/p/lore-acme/files/${svg.body.attachment.sha256}`, { headers: { cookie: jane } })
  assert.match(res.headers.get('content-disposition')!, /^attachment;/)

  const big = await fetch(`${base}/api/board/p/lore-acme/items/ACM-2/files`, {
    method: 'POST',
    headers: { cookie: jane, 'content-type': 'video/mp4', 'x-file-name': 'huge.mp4', 'content-length': String(200 * 1024 * 1024) },
    body: Buffer.alloc(10),
  }).catch((err) => ({ status: 413, err }))
  assert.equal(big.status, 413)
})

test('board comments: a member comments; the thread merges the board comment with the linked Jira issue\'s comments', async () => {
  const jane = await session('jane@acme.com')
  const posted = await api('/p/lore-acme/items/ACM-3/comments', { cookie: jane, body: { body: 'Is the **promo** code still live?' } })
  assert.equal(posted.status, 201, JSON.stringify(posted.body))
  const files = git(join(bares, 'lore-acme.git'), 'ls-tree', '-r', '--name-only', 'HEAD', 'context/streams/board')
  assert.match(files, /^context\/streams\/board\/ACM-3\/\d{4}-\d{2}-\d{2}\.md$/)

  const thread = await api('/p/lore-acme/items/ACM-3/thread', { cookie: jane })
  assert.deepEqual(
    thread.body.comments.map((c: any) => [c.author, c.source, c.body]),
    [['jane@acme.com', 'board', 'Is the **promo** code still live?']],
  )
  assert.deepEqual(thread.body.attachments, [])
  assert.equal((await api('/p/lore-acme/items/ACM-3/comments', { cookie: await session('bob3@viewers.io'), body: { body: 'hi' } })).status, 403)
  assert.equal((await api('/p/lore-acme/items/ACM-3/comments', { cookie: jane, body: { body: '   ' } })).status, 400)
})

test('board assignees: offered from the project, and nothing else is accepted', async () => {
  const jane = await session('jane@acme.com')
  const board = await api('/p/lore-acme', { cookie: jane })
  assert.ok(Array.isArray(board.body.assignees))
  const bad = await api('/p/lore-acme/items/ACM-2', { method: 'PATCH', cookie: jane, body: { assignee: 'Somebody Made Up' } })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /not someone on this project/)
  assert.equal((await api('/p/lore-acme/items', { cookie: jane, body: { title: 'x', assignee: 'Nope' } })).status, 400)
  // Clearing is always allowed.
  const cleared = await api('/p/lore-acme/items/ACM-2', { method: 'PATCH', cookie: jane, body: { assignee: '', priority: 'P3' } })
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
})

test('board files: a member removes a file — it leaves the ticket and is no longer served; history says so', async () => {
  const jane = await session('jane@acme.com')
  const bytes = Buffer.from('a file to remove '.repeat(20))
  const up = await upload(jane, 'ACM-2', 'remove-me.txt', bytes, 'text/plain')
  const sha = up.body.attachment.sha256
  assert.equal((await fetch(`${base}/api/board/p/lore-acme/files/${sha}`, { headers: { cookie: jane } })).status, 200)

  assert.equal((await api('/p/lore-acme/items/ACM-2/detach', { cookie: await session('bob4@viewers.io'), body: { sha256: sha } })).status, 403, 'viewers cannot remove')
  const gone = await api('/p/lore-acme/items/ACM-2/detach', { cookie: jane, body: { sha256: sha } })
  assert.equal(gone.status, 200, JSON.stringify(gone.body))
  const thread = await api('/p/lore-acme/items/ACM-2/thread', { cookie: jane })
  assert.ok(!thread.body.attachments.some((a: any) => a.sha256 === sha))
  assert.equal((await fetch(`${base}/api/board/p/lore-acme/files/${sha}`, { headers: { cookie: jane } })).status, 404)
  const item = headTracker().find((i) => i.key === 'ACM-2')!
  assert.deepEqual(item.history.at(-1).change, { detached: ['remove-me.txt', null] })
  assert.equal((await api('/p/lore-acme/items/ACM-2/detach', { cookie: jane, body: { sha256: sha } })).status, 400, 'already removed')

  // Attaching the same file again brings it back.
  const again = await upload(jane, 'ACM-2', 'remove-me.txt', bytes, 'text/plain')
  assert.equal(again.status, 201)
  assert.equal((await fetch(`${base}/api/board/p/lore-acme/files/${sha}`, { headers: { cookie: jane } })).status, 200)
})

test('board profiles: a name and a photo, seen only by people who share a board', async () => {
  const jane = await session('jane@acme.com')
  const named = await api('/profile', { method: 'PATCH', cookie: jane, body: { name: '  Jane   Doe ' } })
  assert.deepEqual(named.body, { name: 'Jane Doe', avatar: null })

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from('fake png body')])
  const up = await fetch(`${base}/api/board/profile/avatar`, { method: 'POST', headers: { cookie: jane, 'content-type': 'image/png' }, body: png })
  assert.equal(up.status, 200)
  const { avatar } = (await up.json()) as { avatar: string }
  assert.match(avatar, /^[a-f0-9]{64}$/)
  const svg = await fetch(`${base}/api/board/profile/avatar`, { method: 'POST', headers: { cookie: jane, 'content-type': 'image/svg+xml' }, body: '<svg/>' })
  assert.equal(svg.status, 415)

  const me = await api('/me', { cookie: jane })
  assert.equal(me.body.name, 'Jane Doe')
  assert.equal(me.body.avatar, avatar)

  // A viewer of the same board sees Jane and her photo; the contacts map names to emails.
  const vic = await session('vic5@viewers.io')
  const people = await api('/people', { cookie: vic })
  assert.deepEqual(people.body.people.find((p: any) => p.email === 'jane@acme.com'), { email: 'jane@acme.com', name: 'Jane Doe', avatar })
  const pic = await fetch(`${base}/api/board/avatars/${avatar}`, { headers: { cookie: vic } })
  assert.equal(pic.status, 200)
  assert.equal(pic.headers.get('content-type'), 'image/png')

  // Host admins see everyone. (Someone on no board can't sign in at all.)
  const boss = await session('boss@inputlogic.ca')
  assert.ok((await api('/people', { cookie: boss })).body.people.some((p: any) => p.email === 'jane@acme.com'), 'admins see everyone')

  await api('/profile/avatar/remove', { cookie: jane, body: {} })
  assert.equal((await fetch(`${base}/api/board/avatars/${avatar}`, { headers: { cookie: vic } })).status, 404, 'a removed photo is not served')
})

test('board assignees: "assign to me" — the signed-in member is offered and accepted as an assignee', async () => {
  const jane = await session('jane@acme.com')
  const board = await api('/p/lore-acme', { cookie: jane })
  assert.ok(board.body.me_assignee, 'the board says who "me" is')
  assert.ok(board.body.assignees.includes(board.body.me_assignee), 'members are assignable')
  const made = await api('/p/lore-acme/items', { cookie: jane, body: { title: 'Mine', assignee: board.body.me_assignee } })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  assert.equal(made.body.item.assignee, board.body.me_assignee)
})
