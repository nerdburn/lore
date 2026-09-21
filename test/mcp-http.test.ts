import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { parse } from 'yaml'
import { agentsAllow, agentsRevoke } from '../src/commands/agents.js'
import { writeGlobalConfig } from '../src/context.js'
import { createMcpHttpHandler, readAgentsFile, type McpHttpHandler } from '../src/mcp-http.js'
import { fullFixtureRepo } from './helpers.js'

/**
 * The hosted endpoint end to end: a temp LORE_HOME whose "remote" is a
 * directory of bare repos (how the host itself is configured), one fixture
 * client pushed into it, the handler behind a plain node server, and the
 * SDK's HTTP client calling it with the identity header the exe.dev edge
 * sets on peer requests.
 */
const home = mkdtempSync(join(tmpdir(), 'lore-mcp-http-'))
const bares = join(home, 'repos')
const agentsFile = join(home, 'agents.json')
let server: Server
let handler: McpHttpHandler
let base: string
const logs: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
}

before(async () => {
  process.env.LORE_HOME = home
  writeGlobalConfig({ remote: bares })
  mkdirSync(bares, { recursive: true })
  const bare = join(bares, 'lore-acme.git')
  execFileSync('git', ['init', '--quiet', '--bare', bare])
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const src = fullFixtureRepo()
  execFileSync('git', ['init', '--quiet', '-b', 'main', src])
  git(src, 'add', '-A')
  git(src, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '--quiet', '-m', 'fixture')
  git(src, 'push', '--quiet', bare, 'main')

  agentsAllow('accord-agent', ['lore-acme'], { file: agentsFile, as: 'accord' })
  agentsAllow('nosy-agent', ['lore-other'], { file: agentsFile })

  handler = createMcpHttpHandler({ agentsFile, cwd: home, log: (l) => logs.push(l) })
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (await handler.handle(req, res, url)) return
    res.writeHead(200).end('page')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await handler.close()
  await new Promise<void>((r) => server.close(() => r()))
  delete process.env.LORE_HOME
  rmSync(home, { recursive: true, force: true })
})

async function connect(agent: string, context = 'lore-acme') {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/${context}`), {
    requestInit: { headers: { 'x-exedev-source-vm': agent } },
  })
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(transport)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args })
    const content = res.content as { type: string; text: string }[]
    return { isError: res.isError === true, text: content[0]?.text ?? '' }
  }
  return { client, transport, call, close: () => client.close() }
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }

test('mcp-http: paths outside /mcp are left to the page', async () => {
  const res = await fetch(`${base}/status.json`)
  assert.equal(await res.text(), 'page')
})

test('mcp-http: no identity header → 401, never a session', async () => {
  const res = await fetch(`${base}/mcp/lore-acme`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init) })
  assert.equal(res.status, 401)
  assert.match((await res.json()).error.message, /peer integration/)
  // A forged header is the platform's problem to strip; here the header IS the
  // identity, so the test for "someone else" is an agent the file doesn't grant.
})

test('mcp-http: an agent not granted the context → 403 (and the refusal is logged)', async () => {
  const res = await fetch(`${base}/mcp/lore-acme`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-exedev-source-vm': 'nosy-agent' },
    body: JSON.stringify(init),
  })
  assert.equal(res.status, 403)
  const unknown = await fetch(`${base}/mcp/lore-acme`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-exedev-source-vm': 'stranger' },
    body: JSON.stringify(init),
  })
  assert.equal(unknown.status, 403)
  assert.ok(logs.some((l) => l.includes('nosy-agent → lore-acme: refused (context not granted)')))
  assert.ok(logs.some((l) => l.includes('stranger → lore-acme: refused (agent not in agents file)')))
})

test('mcp-http: a context that is not on the host → 404', async () => {
  const res = await fetch(`${base}/mcp/lore-nope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-exedev-source-vm': 'ops' },
    body: JSON.stringify(init),
  })
  // "ops" is not granted anything: refused before the clone is even tried.
  assert.equal(res.status, 403)
  agentsAllow('ops', ['*'], { file: agentsFile })
  const res2 = await fetch(`${base}/mcp/lore-nope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-exedev-source-vm': 'ops' },
    body: JSON.stringify(init),
  })
  assert.equal(res2.status, 404)
  agentsRevoke('ops', [], { file: agentsFile })
})

test('mcp-http: a granted agent gets the full tool set over HTTP, and writes are attributed to it', async () => {
  const s = await connect('accord-agent')
  const tools = (await s.client.listTools()).tools.map((t) => t.name)
  assert.equal(tools.length, 14)
  assert.ok(tools.includes('lore_recall'))
  assert.deepEqual(handler.sessions().map((x) => [x.agent, x.context]), [['accord-agent', 'lore-acme']])

  const recall = JSON.parse((await s.call('lore_recall')).text)
  assert.equal(recall.pins.length, 2)

  const pinned = await s.call('lore_remember', { fact: 'the hosted endpoint works', category: 'ops' })
  assert.equal(pinned.isError, false, pinned.text)
  assert.match(pinned.text, /^pinned pin-\d+/)

  // The write reached the bare repo (the origin), attributed to the agents-file actor, not the OS user.
  const bare = join(bares, 'lore-acme.git')
  assert.match(git(bare, 'log', '-1', '--format=%s'), /^lore: remember pin-/)
  const facts = parse(execFileSync('git', ['-C', bare, 'show', 'HEAD:context/facts.yaml']).toString()) as { fact: string; authorized_by: string }[]
  const pin = facts.find((f) => f.fact === 'the hosted endpoint works')
  assert.ok(pin)
  assert.equal(pin.authorized_by, 'accord')

  // An explicit DELETE ends the session; a client that just drops the
  // connection is reaped after the idle timeout instead.
  await s.transport.terminateSession()
  await s.close()
  assert.deepEqual(handler.sessions(), [])
})

test('mcp-http: a session id cannot be reused by another caller or on another context', async () => {
  const s = await connect('accord-agent')
  await s.client.listTools()
  const id = s.transport.sessionId
  assert.ok(id)
  const ping = { jsonrpc: '2.0', id: 9, method: 'ping' }
  const other = await fetch(`${base}/mcp/lore-acme`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-exedev-source-vm': 'nosy-agent', 'mcp-session-id': id },
    body: JSON.stringify(ping),
  })
  assert.equal(other.status, 403)
  const elsewhere = await fetch(`${base}/mcp/lore-other`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-exedev-source-vm': 'accord-agent', 'mcp-session-id': id },
    body: JSON.stringify(ping),
  })
  assert.equal(elsewhere.status, 403)
  const noSession = await fetch(`${base}/mcp/lore-acme`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-exedev-source-vm': 'accord-agent' },
    body: JSON.stringify(ping),
  })
  assert.equal(noSession.status, 400)
  await s.close()
})

test('mcp-http: concurrent writes from two sessions on one context land in order, none lost', async () => {
  const a = await connect('accord-agent')
  const b = await connect('accord-agent')
  const results = await Promise.all([
    a.call('lore_work_add', { title: 'from a', reason: 'test' }),
    b.call('lore_work_add', { title: 'from b', reason: 'test' }),
    a.call('lore_remember', { fact: 'parallel pin', category: 'ops' }),
  ])
  for (const r of results) assert.equal(r.isError, false, r.text)
  const bare = join(bares, 'lore-acme.git')
  const log = git(bare, 'log', '--format=%s')
  assert.equal(log.split('\n').filter((l) => /work|remember/.test(l)).length >= 4, true, log)
  await Promise.all([a.close(), b.close()])
})

test('agents: allow merges, "*" widens, revoke narrows and removes', () => {
  const file = join(home, 'agents-unit.json')
  agentsAllow('x-agent', ['lore-a'], { file })
  agentsAllow('x-agent', ['lore-b', 'lore-a'], { file, as: 'x' })
  assert.deepEqual(readAgentsFile(file), { 'x-agent': { contexts: ['lore-a', 'lore-b'], actor: 'x' } })
  assert.deepEqual(agentsRevoke('x-agent', ['lore-a'], { file }), { contexts: ['lore-b'], actor: 'x' })
  agentsAllow('x-agent', ['*'], { file })
  assert.equal(readAgentsFile(file)['x-agent'].contexts, '*')
  assert.equal(agentsRevoke('x-agent', [], { file }), undefined)
  assert.deepEqual(readAgentsFile(file), {})
  writeFileSync(file, JSON.stringify({ bad: { contexts: 'some' } }))
  assert.throws(() => readAgentsFile(file), /contexts must be/)
  assert.equal(readFileSync(agentsFile, 'utf8').includes('accord-agent'), true)
})
