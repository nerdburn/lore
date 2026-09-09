import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { accessToken, deviceFlow, discover, type GranolaAuthFile } from '../src/granola-auth.js'

const AS = 'https://mcp-auth.example'
const RESOURCE = 'https://mcp.example/mcp'

/** Scripted OAuth server: metadata, DCR, device authorization, token polling, refresh. */
function fakeServer(opts: { pendingPolls?: number; slowDown?: boolean; deny?: boolean } = {}) {
  const calls: { url: string; body: Record<string, string> | Record<string, unknown> }[] = []
  let polls = 0
  let refreshes = 0
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    let body: Record<string, string> | Record<string, unknown> = {}
    if (init?.body instanceof URLSearchParams) body = Object.fromEntries(init.body)
    else if (typeof init?.body === 'string') body = JSON.parse(init.body)
    calls.push({ url, body })
    if (url.endsWith('/.well-known/oauth-protected-resource')) return json({ resource: RESOURCE, authorization_servers: [AS] })
    if (url.endsWith('/.well-known/oauth-authorization-server'))
      return json({ issuer: AS, token_endpoint: `${AS}/token`, device_authorization_endpoint: `${AS}/device`, registration_endpoint: `${AS}/register` })
    if (url === `${AS}/register`) return json({ client_id: 'client_123', grant_types: ['authorization_code', 'refresh_token'] })
    if (url === `${AS}/device`) return json({ device_code: 'dev_abc', user_code: 'ABCD-EFGH', verification_uri_complete: `${AS}/device?user_code=ABCD-EFGH`, expires_in: 300, interval: 5 })
    if (url === `${AS}/token`) {
      const b = body as Record<string, string>
      if (b.grant_type === 'refresh_token') {
        refreshes++
        if (b.refresh_token !== 'rt_1' && b.refresh_token !== 'rt_2') return json({ error: 'invalid_grant', error_description: 'unknown refresh token' }, 400)
        return json({ access_token: `at_refreshed_${refreshes}`, refresh_token: 'rt_2', expires_in: 3600 })
      }
      polls++
      if (opts.deny) return json({ error: 'access_denied', error_description: 'user said no' }, 400)
      if (opts.slowDown && polls === 1) return json({ error: 'slow_down' }, 400)
      if (polls <= (opts.pendingPolls ?? 1)) return json({ error: 'authorization_pending' }, 400)
      return json({ access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600 })
    }
    return json({ error: 'not_found' }, 404)
  }) as typeof fetch
  return { fetchFn, calls, get polls() { return polls }, get refreshes() { return refreshes } }
}

const noSleep = async () => {}

test('granola-auth: discovery follows protected-resource → authorization-server metadata', async () => {
  const s = fakeServer()
  const md = await discover(RESOURCE, s.fetchFn)
  assert.equal(md.issuer, AS)
  assert.equal(md.device_authorization_endpoint, `${AS}/device`)
})

test('granola-auth: device flow registers a client, prompts the user, polls until approved, writes the token file', async () => {
  const s = fakeServer({ pendingPolls: 2, slowDown: true })
  const path = join(mkdtempSync(join(tmpdir(), 'lore-auth-')), 'granola-auth.json')
  let prompted: [string, string] | undefined
  let t = 1_000_000
  const file = await deviceFlow(path, { prompt: (uri, code) => (prompted = [uri, code]), sleep: noSleep, fetchFn: s.fetchFn, now: () => (t += 1000) }, RESOURCE)
  assert.deepEqual(prompted, [`${AS}/device?user_code=ABCD-EFGH`, 'ABCD-EFGH'])
  assert.equal(file.client_id, 'client_123')
  assert.equal(file.tokens.access_token, 'at_1')
  assert.equal(file.tokens.refresh_token, 'rt_1')
  assert.equal(file.resource, RESOURCE)
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as GranolaAuthFile
  assert.equal(onDisk.tokens.access_token, 'at_1')
  const reg = s.calls.find((c) => c.url.endsWith('/register'))!
  assert.deepEqual((reg.body as Record<string, unknown>).grant_types, ['authorization_code', 'refresh_token'])
  const dev = s.calls.find((c) => c.url.endsWith('/device'))!
  assert.equal((dev.body as Record<string, string>).resource, RESOURCE)
  assert.equal(s.polls, 3, 'slow_down, pending, success')
})

test('granola-auth: a saved client_id is reused instead of registering again', async () => {
  const s = fakeServer()
  const path = join(mkdtempSync(join(tmpdir(), 'lore-auth-')), 'granola-auth.json')
  await deviceFlow(path, { prompt: () => {}, sleep: noSleep, fetchFn: s.fetchFn }, RESOURCE)
  const before = s.calls.filter((c) => c.url.endsWith('/register')).length
  await deviceFlow(path, { prompt: () => {}, sleep: noSleep, fetchFn: s.fetchFn }, RESOURCE)
  assert.equal(s.calls.filter((c) => c.url.endsWith('/register')).length, before, 'no second registration')
})

test('granola-auth: denial and expiry surface as errors', async () => {
  const denied = fakeServer({ deny: true })
  const path = join(mkdtempSync(join(tmpdir(), 'lore-auth-')), 'granola-auth.json')
  await assert.rejects(deviceFlow(path, { prompt: () => {}, sleep: noSleep, fetchFn: denied.fetchFn }, RESOURCE), /access_denied: user said no/)
  const never = fakeServer({ pendingPolls: 1000 })
  let t = 0
  await assert.rejects(
    deviceFlow(path, { prompt: () => {}, sleep: noSleep, fetchFn: never.fetchFn, now: () => (t += 60_000) }, RESOURCE),
    /device code expired/,
  )
})

test('granola-auth: accessToken returns the cached token while fresh, refreshes near expiry, rotates the refresh token', async () => {
  const s = fakeServer()
  const path = join(mkdtempSync(join(tmpdir(), 'lore-auth-')), 'granola-auth.json')
  let t = 1_000_000_000
  await deviceFlow(path, { prompt: () => {}, sleep: noSleep, fetchFn: s.fetchFn, now: () => t }, RESOURCE)
  assert.equal(await accessToken(path, { fetchFn: s.fetchFn, now: () => t }), 'at_1')
  assert.equal(s.refreshes, 0)
  t += 3600_000 - 60_000 // within the 2-minute skew
  assert.equal(await accessToken(path, { fetchFn: s.fetchFn, now: () => t }), 'at_refreshed_1')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tokens.refresh_token, 'rt_2', 'rotated refresh token persisted')
  assert.equal(await accessToken(path, { fetchFn: s.fetchFn, now: () => t }), 'at_refreshed_1', 'fresh again → cached')
  assert.equal(await accessToken(path, { force: true, fetchFn: s.fetchFn, now: () => t }), 'at_refreshed_2', 'force → refresh (after a 401)')
})

test('granola-auth: missing file and failed refresh tell the user to re-run lore auth', async () => {
  await assert.rejects(accessToken('/nonexistent/granola-auth.json'), /run `lore auth granola`/)
  const s = fakeServer()
  const path = join(mkdtempSync(join(tmpdir(), 'lore-auth-')), 'granola-auth.json')
  let t = 0
  await deviceFlow(path, { prompt: () => {}, sleep: noSleep, fetchFn: s.fetchFn, now: () => t }, RESOURCE)
  const file = JSON.parse(readFileSync(path, 'utf8')) as GranolaAuthFile
  file.tokens.refresh_token = 'rt_bogus'
  writeFileSync(path, JSON.stringify(file))
  t += 10_000_000
  await assert.rejects(accessToken(path, { fetchFn: s.fetchFn, now: () => t }), /token refresh failed \(invalid_grant\).*run `lore auth granola`/)
})
