import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { MailMessage } from '../src/board/email.js'
import { www } from '../src/commands/www.js'
import { writeGlobalConfig } from '../src/context.js'
import { allowedRedirect, sameRedirect } from '../src/oauth.js'
import { makeContextRepo } from './helpers.js'

/**
 * MCP over OAuth, end to end, the way Claude Code does it: discover →
 * register → authorize (the board's sign-in + consent) → token (PKCE) →
 * MCP with the bearer → refresh. Access follows board roles.
 */
const home = mkdtempSync(join(tmpdir(), 'lore-oauth-'))
const bares = join(home, 'repos')
const mail: MailMessage[] = []
let base = ''
let host: { close(): Promise<void> }
let clock = Date.parse('2026-09-24T12:00:00Z')

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
}

function pushContext(name: string, config: Record<string, unknown>) {
  const bare = join(bares, `${name}.git`)
  execFileSync('git', ['init', '--quiet', '--bare', bare])
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const src = makeContextRepo({}, config)
  execFileSync('git', ['init', '--quiet', '-b', 'main', src])
  git(src, 'add', '-A')
  git(src, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '--quiet', '-m', 'fixture')
  git(src, 'push', '--quiet', bare, 'main')
}

before(async () => {
  process.env.LORE_HOME = home
  writeGlobalConfig({ remote: bares })
  mkdirSync(bares, { recursive: true })
  mkdirSync(join(home, 'web'), { recursive: true })
  writeFileSync(join(home, 'web', 'index.html'), '<div id="root"></div>')
  writeFileSync(join(home, 'agents.json'), '{}')
  pushContext('lore-acme', { project: 'acme', client: { name: 'Acme' }, sources: {}, board: { enabled: true, members: ['jane@acme.com'], viewers: ['vic@acme.com'] } })
  pushContext('lore-beta', { project: 'beta', sources: {}, board: { enabled: true, members: ['bea@beta.com'], viewers: [] } })
  const h = www({
    repos: bares,
    port: 0,
    host: '127.0.0.1',
    agents: join(home, 'agents.json'),
    board: {
      cwd: home,
      admins: [],
      secret: 'test-secret',
      webDir: join(home, 'web'),
      now: () => clock,
      oauthFile: join(home, 'oauth.json'),
      sendMail: async (m) => void mail.push(m),
      log: () => {},
    },
  })
  host = h
  base = `http://127.0.0.1:${await h.ready}`
})

after(async () => {
  await host.close()
  delete process.env.LORE_HOME
  rmSync(home, { recursive: true, force: true })
})

async function boardSession(email: string): Promise<string> {
  clock += 3_600_000
  await fetch(`${base}/api/board/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
  const code = /\b(\d{6})\b/.exec(mail.filter((m) => m.to === email).at(-1)!.subject)![1]
  const res = await fetch(`${base}/api/board/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) })
  return res.headers.get('set-cookie')!.split(';')[0]
}

const sessions = new Map<string, string>()
async function session(email: string): Promise<string> {
  if (!sessions.has(email)) sessions.set(email, await boardSession(email))
  return sessions.get(email)!
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function register(redirect = 'http://localhost:33418/callback') {
  const res = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

/** The whole browser leg: authorize → consent (as `email`) → code. */
async function authorize(clientId: string, email: string, opts: { resource?: string; redirect?: string; approve?: boolean } = {}) {
  const cookie = await session(email)
  const { verifier, challenge } = pkce()
  const redirect = opts.redirect ?? 'http://localhost:33418/callback'
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', ...(opts.resource ? { resource: opts.resource } : {}) })
  const a = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual' })
  assert.equal(a.status, 302)
  const request = new URL(a.headers.get('location')!, base).searchParams.get('request')!
  assert.match(a.headers.get('location')!, /^\/board\/authorize\?request=/)
  const shown = await fetch(`${base}/api/board/oauth/request/${request}`, { headers: { cookie } })
  const decided = await fetch(`${base}/api/board/oauth/request/${request}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ approve: opts.approve ?? true }) })
  const d = (await decided.json()) as { redirect?: string; error?: string }
  return { verifier, redirect, cookie, shown: (await shown.json()) as Record<string, any>, decided: decided.status, back: d.redirect ? new URL(d.redirect) : undefined, error: d.error }
}

async function token(params: Record<string, string>) {
  const res = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

async function connect(context: string, accessToken: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/${context}`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } })
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(transport)
  return client
}

test('oauth: discovery — a bare MCP request gets a 401 pointing at resource metadata, which points at the authorization server', async () => {
  const res = await fetch(`${base}/mcp/lore-acme`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
  assert.equal(res.status, 401)
  const wa = res.headers.get('www-authenticate')!
  assert.match(wa, /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp\/lore-acme"/)
  const prm = (await (await fetch(/resource_metadata="([^"]+)"/.exec(wa)![1])).json()) as Record<string, any>
  assert.equal(prm.resource, `${base}/mcp/lore-acme`)
  const as = (await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>
  assert.equal(as.token_endpoint, `${base}/oauth/token`)
  assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
})

test('oauth: a member signs in on the board, approves, and gets every tool; writes are theirs', async () => {
  const reg = await register()
  assert.equal(reg.status, 201)
  const auth = await authorize(reg.body.client_id, 'jane@acme.com', { resource: `${base}/mcp/lore-acme` })
  assert.equal(auth.shown.client, 'Claude Code')
  assert.equal(auth.shown.role, 'member')
  assert.equal(auth.back!.searchParams.get('state'), 'st8')
  const code = auth.back!.searchParams.get('code')!

  const wrong = await token({ grant_type: 'authorization_code', code, client_id: reg.body.client_id, redirect_uri: auth.redirect, code_verifier: 'x'.repeat(43) })
  assert.equal(wrong.status, 400)
  assert.equal(wrong.body.error, 'invalid_grant')
  // …and the code died with that attempt: codes are single use.
  const reused = await token({ grant_type: 'authorization_code', code, client_id: reg.body.client_id, redirect_uri: auth.redirect, code_verifier: auth.verifier })
  assert.equal(reused.status, 400)

  const again = await authorize(reg.body.client_id, 'jane@acme.com', { resource: `${base}/mcp/lore-acme`, redirect: 'http://localhost:51999/callback' })
  const t = await token({ grant_type: 'authorization_code', code: again.back!.searchParams.get('code')!, client_id: reg.body.client_id, redirect_uri: again.redirect, code_verifier: again.verifier })
  assert.equal(t.status, 200, JSON.stringify(t.body))
  assert.equal(t.body.token_type, 'Bearer')
  assert.match(t.body.refresh_token, /^lrt_/)

  const client = await connect('lore-acme', t.body.access_token)
  const tools = (await client.listTools()).tools.map((x) => x.name)
  assert.ok(tools.includes('lore_work_add') && tools.includes('lore_grep'))
  const added = await client.callTool({ name: 'lore_work_add', arguments: { title: 'From my laptop', reason: 'testing oauth' } })
  assert.ok(!added.isError, JSON.stringify(added))
  const tracker = git(join(bares, 'lore-acme.git'), 'show', 'HEAD:context/work/lore/ACM.yaml')
  assert.match(tracker, /by: jane@acme\.com/)
  await client.close()

  // Bound to lore-acme: it opens nothing else.
  const other = await fetch(`${base}/mcp/lore-beta`, { method: 'POST', headers: { authorization: `Bearer ${t.body.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
  assert.equal(other.status, 403)

  // Refresh rotates: the old refresh token is dead after one use.
  const r1 = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: reg.body.client_id })
  assert.equal(r1.status, 200)
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: reg.body.client_id })).status, 400)

  // Revoked from the board: the refresh stops working.
  const list = (await (await fetch(`${base}/api/board/oauth/connections`, { headers: { cookie: again.cookie } })).json()) as { connections: { id: string; client_name: string }[] }
  assert.equal(list.connections.length, 1)
  const rv = await fetch(`${base}/api/board/oauth/connections/${list.connections[0].id}/revoke`, { method: 'POST', headers: { cookie: again.cookie, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(rv.status, 200)
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: reg.body.client_id })).status, 400)
})

test('oauth: a viewer gets only read tools; someone not on the board is refused', async () => {
  const reg = await register()
  const v = await authorize(reg.body.client_id, 'vic@acme.com')
  const t = await token({ grant_type: 'authorization_code', code: v.back!.searchParams.get('code')!, client_id: reg.body.client_id, redirect_uri: v.redirect, code_verifier: v.verifier })
  const client = await connect('lore-acme', t.body.access_token)
  const tools = (await client.listTools()).tools.map((x) => x.name)
  assert.ok(tools.includes('lore_grep') && tools.includes('lore_recall'))
  assert.ok(!tools.some((n) => /work_add|work_move|remember|comment|push/.test(n)), `viewer saw ${tools.join(', ')}`)
  await client.close()
  // An unbound token still only opens boards the person is on.
  const beta = await fetch(`${base}/mcp/lore-beta`, { method: 'POST', headers: { authorization: `Bearer ${t.body.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
  assert.equal(beta.status, 403)

  const outsider = await authorize(reg.body.client_id, 'bea@beta.com', { resource: `${base}/mcp/lore-acme` })
  assert.equal(outsider.shown.role, null)
  assert.equal(outsider.decided, 403, 'cannot approve access to a board you are not on')
})

test('oauth: a mistyped MCP URL is called out as no such project, not "no access"', async () => {
  const reg = await register()
  const typo = await authorize(reg.body.client_id, 'jane@acme.com', { resource: `${base}/mcp/lore-acm` })
  assert.match(typo.shown.error, /no project called "lore-acm" on this host — check the URL/)
  assert.equal(typo.decided, 404)
})

test('oauth: denied consent goes back as access_denied; junk tokens and bad registrations are refused', async () => {
  const reg = await register()
  const d = await authorize(reg.body.client_id, 'jane@acme.com', { approve: false })
  assert.equal(d.back!.searchParams.get('error'), 'access_denied')
  assert.equal(d.back!.searchParams.get('code'), null)

  const forged = await fetch(`${base}/mcp/lore-acme`, { method: 'POST', headers: { authorization: 'Bearer lat_eyJlbWFpbCI6ImphbmVAYWNtZS5jb20iLCJleHAiOjk5OTk5OTk5OTl9.bad', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(forged.status, 401)
  assert.match(forged.headers.get('www-authenticate')!, /error="invalid_token"/)

  assert.equal((await register('http://evil.example/cb')).status, 400, 'plain http only to loopback')
  const unknown = await fetch(`${base}/oauth/authorize?client_id=nope&redirect_uri=http://localhost:1/cb&response_type=code`, { redirect: 'manual' })
  assert.equal(unknown.status, 400, 'an unknown client is not redirected anywhere')
})

test('oauth: redirect rules — https or loopback, loopback may change port', () => {
  assert.ok(allowedRedirect('http://localhost:33418/callback'))
  assert.ok(allowedRedirect('http://127.0.0.1:1/x'))
  assert.ok(allowedRedirect('https://app.example/cb'))
  assert.ok(!allowedRedirect('http://app.example/cb'))
  assert.ok(!allowedRedirect('javascript:alert(1)'))
  assert.ok(sameRedirect('http://localhost:1/callback', 'http://localhost:2/callback'))
  assert.ok(!sameRedirect('http://localhost:1/callback', 'http://localhost:2/other'))
  assert.ok(!sameRedirect('https://a.example/cb', 'https://a.example:444/cb'))
})
