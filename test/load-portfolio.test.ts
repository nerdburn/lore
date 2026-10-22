import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { portfolioLoad } from '../src/load/portfolio.js'
import { rebuildLoad } from '../src/load/store.js'
import { portfolioEntries } from '../src/commands/load.js'
import { createServer, PORTFOLIO_TOOLS, registerPortfolioTools } from '../src/commands/mcp.js'
import { resolveContext } from '../src/context.js'
import { writeDocs } from '../src/streams.js'
import { makeContextRepo } from './helpers.js'

process.env.LORE_HOME = mkdtempSync(join(tmpdir(), 'lore-portfolio-home-'))

const pr = (repo: string, number: number, timestamp: string) => ({
  source: 'github', channel: repo.replace('/', '_'), id: `github-${repo}-pr-${number}`, author: 'dev', timestamp,
  meta: { repo, number: String(number), type: 'pr', login: 'dev' }, text: `**PR ${number}**`,
})

/** A brand project syncing the shared repo, plus one PR of its own. */
function project(name: string, own: string, extra: Record<string, unknown> = {}) {
  const root = makeContextRepo({}, { project: name, sources: {}, load: { enabled: true, timezone: 'UTC' }, ...extra })
  writeDocs(root, [
    pr('acme/shared', 1, '2026-10-02T12:00:00Z'),
    pr('acme/shared', 2, '2026-09-20T12:00:00Z'),
    pr(own, 7, '2026-10-03T12:00:00Z'),
  ])
  rebuildLoad(root)
  return root
}

test('portfolio: per-project rows count shared evidence in each, totals count it once and name the overlap', () => {
  const a = rebuildLoad(project('brand-a', 'acme/a'))
  const b = rebuildLoad(project('brand-b', 'acme/b'))
  const r = portfolioLoad([
    { project: 'brand-a', snapshot: a, freshness: 'current' },
    { project: 'brand-b', snapshot: b, freshness: 'stale' },
    { project: 'old', archived: true },
    { project: 'broken', error: 'Load has not been built.' },
  ], { from: '2026-10-01', to: '2026-11-01' })
  const rows = Object.fromEntries(r.projects.map(p => [p.project, p]))
  assert.deepEqual('counts' in rows['brand-a'] && rows['brand-a'].counts['pr.created'], { accepted: 2, candidates: 0 })
  assert.deepEqual('counts' in rows['brand-b'] && rows['brand-b'].counts['pr.created'], { accepted: 2, candidates: 0 })
  // shared #1 once + each brand's own PR; shared #2 is outside the range
  assert.deepEqual(r.totals['pr.created'], { accepted: 3, candidates: 0 })
  assert.deepEqual(r.shared, [{ type: 'pr.created', projects: ['brand-a', 'brand-b'], events: 1 }])
  assert.deepEqual(r.archived, ['old'])
  assert.equal(rows.old, undefined)
  assert.equal(rows.broken && 'error' in rows.broken && rows.broken.error, 'Load has not been built.')
  assert.ok(r.warnings.some(w => w.includes('Not current: brand-b')))
  assert.throws(() => portfolioLoad([], { from: '2026-11-01', to: '2026-10-01' }))
})

test('portfolio: entries resolve every registered project by repo, even from inside another linked context', () => {
  const a = project('brand-a', 'acme/a')
  const b = project('brand-b', 'acme/b')
  const old = project('old', 'acme/old', { lifecycle: 'archived' })
  const unbuilt = makeContextRepo({}, { project: 'unbuilt', sources: {} })
  mkdirSync(process.env.LORE_HOME!, { recursive: true })
  writeFileSync(join(process.env.LORE_HOME!, 'registry.json'), JSON.stringify({ 'brand-b': b, 'brand-a': a, old, unbuilt }))
  const entries = portfolioEntries(a, { pull: false })
  assert.deepEqual(entries.map(e => e.project), ['brand-a', 'brand-b', 'old', 'unbuilt'])
  assert.deepEqual(entries.map(e => e.snapshot?.project), ['brand-a', 'brand-b', undefined, undefined])
  assert.equal(entries[2].archived, true)
  assert.match(entries[3].error!, /not been built/)
})

test('mcp: lore_load_all is served only when registered for an operator session', async () => {
  const a = project('brand-a', 'acme/a')
  writeFileSync(join(process.env.LORE_HOME!, 'registry.json'), JSON.stringify({ 'brand-a': a, 'brand-b': project('brand-b', 'acme/b') }))
  const connect = async (portfolio: boolean) => {
    const server: McpServer = createServer(resolveContext(a, { context: a }), { cwd: a, opts: { context: a } })
    if (portfolio) registerPortfolioTools(server, a)
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    return { client, close: () => Promise.all([client.close(), server.close()]) }
  }
  const plain = await connect(false)
  assert.ok(!(await plain.client.listTools()).tools.some(t => t.name === 'lore_load_all'))
  await plain.close()
  const operator = await connect(true)
  try {
    const names = (await operator.client.listTools()).tools.map(t => t.name)
    for (const t of PORTFOLIO_TOOLS) assert.ok(names.includes(t.name))
    const res = await operator.client.callTool({ name: 'lore_load_all', arguments: { from: '2026-10-01', to: '2026-11-01' } })
    const body = JSON.parse((res.content as { text: string }[])[0].text)
    assert.deepEqual(body.projects.map((p: { project: string }) => p.project), ['brand-a', 'brand-b'])
    assert.deepEqual(body.totals['pr.created'], { accepted: 3, candidates: 0 })
  } finally {
    await operator.close()
  }
})
