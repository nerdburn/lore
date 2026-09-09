import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readAudit } from '../src/audit.js'
import { createServer } from '../src/commands/mcp.js'
import { resolveContext } from '../src/context.js'
import { recallData } from '../src/recall.js'
import { ACME, fullFixtureRepo, makeContextRepo } from './helpers.js'

async function connect(root: string) {
  const ctx = resolveContext(root, { context: root })
  const server = createServer(ctx, { cwd: root, opts: { context: root } })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientT)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args })
    const content = res.content as { type: string; text: string }[]
    return { isError: res.isError === true, text: content[0]?.text ?? '' }
  }
  return { client, call, close: () => Promise.all([client.close(), server.close()]) }
}

test('mcp: exposes the five tools', async () => {
  const s = await connect(fullFixtureRepo())
  const tools = (await s.client.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(tools, ['lore_grep', 'lore_read', 'lore_recall', 'lore_remember', 'lore_sync_now'])
  await s.close()
})

test('mcp: lore_recall with no category matches the CLI recall surface exactly', async () => {
  const root = fullFixtureRepo()
  const s = await connect(root)
  const { text } = await s.call('lore_recall')
  assert.deepEqual(JSON.parse(text), recallData(root, ACME))
  const parsed = JSON.parse(text)
  assert.equal(parsed.pins.length, 2)
  assert.deepEqual(Object.keys(parsed.derived), ['decisions', 'requests', 'roadmap'])
  assert.equal(parsed.reports.length, 2)
  assert.ok(parsed.synced.lastSync)
  await s.close()
})

test('mcp: lore_recall category filter returns that derived artifact', async () => {
  const root = fullFixtureRepo()
  const s = await connect(root)
  const requests = JSON.parse((await s.call('lore_recall', { category: 'requests' })).text)
  assert.deepEqual(Object.keys(requests.derived), ['requests'])
  assert.equal(requests.derived.requests[0].id, 'req-0001')
  assert.deepEqual(requests.pins, [])
  const decisions = JSON.parse((await s.call('lore_recall', { category: 'decisions' })).text)
  assert.deepEqual(Object.keys(decisions.derived), ['decisions'])
  assert.deepEqual(JSON.parse((await s.call('lore_recall', { category: 'decisions' })).text), recallData(root, ACME, 'decisions'))
  await s.close()
})

test('mcp: lore_grep finds stream lines; lore_read returns the file', async () => {
  const s = await connect(fullFixtureRepo())
  const matches = JSON.parse((await s.call('lore_grep', { pattern: 'black friday' })).text) as { file: string; line: number }[]
  const hit = matches.find((m) => m.file.startsWith('context/streams/'))
  assert.ok(hit, JSON.stringify(matches))
  assert.equal(hit.file, 'context/streams/slack/#acme/2026-08-03.md')
  const { text } = await s.call('lore_read', { path: hit.file })
  assert.match(text, /Black Friday landing page/)
  await s.close()
})

test('mcp: lore_read refuses paths outside context/', async () => {
  const s = await connect(fullFixtureRepo())
  for (const path of ['../lore.json', 'lore.json', 'context/../state.json', '/etc/passwd']) {
    const r = await s.call('lore_read', { path })
    assert.equal(r.isError, true, path)
    assert.match(r.text, /inside context/)
  }
  await s.close()
})

test('mcp: lore_remember pins with the server identity as actor and writes an audit entry', async () => {
  const root = fullFixtureRepo()
  const s = await connect(root)
  const r = await s.call('lore_remember', { fact: 'Launch is Nov 17', category: 'decisions', source: 'https://slack.com/x' })
  assert.equal(r.isError, false)
  assert.match(r.text, /pinned pin-0003/)
  const facts = readFileSync(join(root, 'context/facts.yaml'), 'utf8')
  assert.match(facts, /Launch is Nov 17/)
  assert.match(facts, new RegExp(`authorized_by: ${userInfo().username}`))
  const audit = readAudit(root)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].action, 'remember')
  assert.equal(audit[0].via, 'mcp')
  assert.equal(audit[0].actor, userInfo().username)
  assert.equal(audit[0].id, 'pin-0003')
  assert.equal(audit[0].source, 'https://slack.com/x')
  await s.close()
})

test('mcp: lore_remember ignores any caller attempt to name the authorizer', async () => {
  const root = fullFixtureRepo()
  const s = await connect(root)
  await s.call('lore_remember', { fact: 'x', by: 'ceo', authorized_by: 'ceo' })
  const facts = readFileSync(join(root, 'context/facts.yaml'), 'utf8')
  assert.ok(!facts.includes('ceo'))
  await s.close()
})

test('mcp: lore_remember is refused when write.allow excludes the actor', async () => {
  const root = makeContextRepo({}, { project: 'acme', write: { allow: ['someone-else'] } })
  const s = await connect(root)
  const r = await s.call('lore_remember', { fact: 'nope' })
  assert.equal(r.isError, true)
  assert.match(r.text, /not in lore.json write.allow/)
  assert.equal(readFileSync(join(root, 'context/facts.yaml'), 'utf8').trim().endsWith('[]'), true)
  assert.deepEqual(readAudit(root), [])
  await s.close()
})
