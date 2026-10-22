import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { configSchema } from '../src/config.js'
import { makeContextRepo } from './helpers.js'
import { writeDocs } from '../src/streams.js'
import { readLoadInputs } from '../src/load/inputs.js'
import { semanticChunks, semanticPrompt, emptySemantic } from '../src/load/semantic-events.js'
import { screenChunks, checkpointMatches, skippedCheckpoint } from '../src/load/gate.js'
import { extractSemanticLoad } from '../src/load/semantic-extract.js'
import { readLoad } from '../src/load/store.js'
import type { Fetch } from '../src/jev.js'

const cache = () => mkdtempSync(join(tmpdir(), 'lore-jev-test-'))
function fixture(mode: 'shadow' | 'filter' = 'filter') {
  const config = configSchema.parse({ project: 'test', load: { enabled: true, semantic: { enabled: true, gate: { mode, threshold: 0.1 } } } })
  const root = makeContextRepo({}, config)
  writeDocs(root, [
    { source: 'slack', channel: 'test', id: 'hello', author: 'Sam', timestamp: '2026-10-01T12:00:00Z', text: 'Hello everyone. Nice weather today.' },
    { source: 'slack', channel: 'test', id: 'ask', author: 'Sam', timestamp: '2026-10-01T12:01:00Z', text: 'Please add the export button for our report.' },
  ])
  return { root, config, chunks: semanticChunks(readLoadInputs(root), config) }
}
function mock(score: (text: string) => number) {
  let calls = 0
  const fetch = (async (_url, init) => {
    calls++
    const body = JSON.parse(init!.body as string)
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { noul: score(body.state[Number(key.split('_').at(-1))].text) }])), usage: { input_tokens: 50 } }))
  }) as Fetch
  return { fetch, calls: () => calls }
}

test('Load Jev caches by content/model/version across project paths; changed evidence reclassifies', async () => {
  const { chunks } = fixture(), cacheDir = cache(), api = mock(() => 0.01)
  const opts = { apiKey: 'test', cacheDir, fetch: api.fetch, model: 'pinned-model' }
  const first = await screenChunks(chunks, opts)
  assert.equal(first.inputTokens, 50)
  const shared = chunks.map(c => ({ ...c, path: 'other-project/' + c.path }))
  assert.equal((await screenChunks(shared, opts)).cacheHits, 2)
  assert.equal(api.calls(), 1)
  assert.equal((await screenChunks([{ ...chunks[0], text: chunks[0].text + ' Updated.' }], opts)).cacheHits, 0)
  assert.equal((await screenChunks(chunks, { ...opts, model: 'changed-model' })).cacheHits, 0)
  assert.equal((await screenChunks(chunks, { ...opts, apiKey: undefined })).judgments.size, 0)
})

test('Load filtering retains signal, records reversible skip checkpoints and reports actual usage', async () => {
  const { root, config, chunks } = fixture(), api = mock(text => text.includes('Please') ? 0.9 : 0.01)
  const metrics: Record<string, unknown>[] = []
  await extractSemanticLoad(root, { log: () => {}, screening: { apiKey: 'test', cacheDir: cache(), fetch: api.fetch }, metrics: m => metrics.push(m), complete: async (_system, user) => {
    const data = JSON.parse(user); assert.equal(data.documents.length, 1); assert.match(data.documents[0].text, /Please/)
    return { value: { events: [] }, model: 'test', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30 } }
  } })
  const snapshot = readLoad(root), hello = chunks.find(c => c.doc.fields.id === 'hello')!
  assert.equal(snapshot.semanticCoverage!.pending, 0)
  assert.equal(snapshot.semanticCoverage!.screened, 1)
  assert.equal(snapshot.semantic!.checkpoints[hello.key], skippedCheckpoint(hello.hash, config))
  assert.equal(metrics[0].skipped, 1); assert.equal(metrics[0].inputTokens, 100); assert.equal(metrics[0].jevInputTokens, 50)
  const changed = structuredClone(config); changed.load!.semantic!.gate!.threshold = 0.05
  assert.equal(checkpointMatches(hello.hash, snapshot.semantic!.checkpoints[hello.key], changed), false)
  changed.load!.semantic!.gate!.mode = 'off'
  assert.equal(checkpointMatches(hello.hash, snapshot.semantic!.checkpoints[hello.key], changed), false)
  writeFileSync(join(root, 'lore.json'), JSON.stringify(changed))
  let replayed = false
  await extractSemanticLoad(root, { log: () => {}, metrics: () => {}, complete: async (_s, user) => {
    assert.equal(JSON.parse(user).documents.length, 1); replayed = true; return { value: { events: [] }, model: 'test' }
  } })
  assert.equal(replayed, true)
})

test('Load shadow mode never filters and records would-be lost event evidence', async () => {
  const { root } = fixture('shadow'), api = mock(() => 0.01), metrics: Record<string, unknown>[] = []
  await extractSemanticLoad(root, { log: () => {}, screening: { apiKey: 'test', cacheDir: cache(), fetch: api.fetch }, metrics: m => metrics.push(m), complete: async (_s, user) => {
    const docs = JSON.parse(user).documents; assert.equal(docs.length, 2)
    const ask = docs.find((d: { text: string }) => d.text.includes('Please'))
    return { model: 'test', value: { events: [{ existing_id: null, type: 'client.requested', summary: 'Export button', actor_keys: ['name:Sam'], occurred_on: '2026-10-01', confidence: 'high', evidence: [{ chunk: ask.chunk, quote: ask.text }], related: [] }] } }
  } })
  assert.equal(metrics[0].skipped, 0); assert.equal(metrics[0].shadowMisses, 1)
  assert.equal(readLoad(root).semantic!.records.length, 1)
})

test('Load Jev failures retain evidence and long documents bypass negative filtering', async () => {
  const { root } = fixture()
  writeDocs(root, [{ source: 'slack', channel: 'test', id: 'long', author: 'Sam', timestamp: '2026-10-01T12:00:00Z', text: 'Long discussion. '.repeat(800) }])
  const api = mock(() => 0.01); let lengths: number[] = []
  await extractSemanticLoad(root, { log: () => {}, screening: { apiKey: 'test', cacheDir: cache(), fetch: api.fetch }, metrics: () => {}, complete: async (_s, user) => {
    lengths = JSON.parse(user).documents.map((d: { text: string }) => d.text.length)
    return { model: 'test', value: { events: [] } }
  } })
  assert.equal(lengths.length, 2); assert.ok(lengths.some(n => n === 10000))
  const second = fixture()
  await extractSemanticLoad(second.root, { log: () => {}, screening: { apiKey: 'test', cacheDir: cache(), fetch: (async () => new Response('unavailable', { status: 503 })) as Fetch }, metrics: () => {}, complete: async (_s, user) => {
    assert.equal(JSON.parse(user).documents.length, 2); return { model: 'test', value: { events: [] } }
  } })
  assert.equal(readLoad(second.root).semanticCoverage!.screened, 0)
})

test('compact catalog preserves all candidate fields without repeated JSON keys', () => {
  const { config, chunks } = fixture(), state = emptySemantic()
  state.records.push({ id: 'event', type: 'decision.made', summary: 'Use export', actor_keys: ['name:Sam'], occurred_on: '2026-10-01', confidence: 'high', evidence: [], model: 'test', extracted_at: '2026-10-01', related: [] })
  const data = JSON.parse(semanticPrompt(config, chunks, state).user)
  assert.deepEqual(Object.fromEntries(data.existing_events.columns.map((k: string, i: number) => [k, data.existing_events.rows[0][i]])), { id: 'event', type: 'decision.made', summary: 'Use export', occurred_on: '2026-10-01', actor_keys: ['name:Sam'] })
})

test('prompt contact deduplication preserves explicit roles and contact email aliases', () => {
  const { config, chunks } = fixture()
  const cfg = configSchema.parse({ ...config, load: { ...config.load, actors: [{ id: 'sam', name: 'Sam', kind: 'human', identities: ['email:sam@team.com'], roles: [{ role: 'technical_lead' }] }] }, client: { name: 'Test', contacts: [{ name: 'Sam Smith', email: 'sam@team.com', side: 'team', aliases: ['old@team.com'] }] } })
  const data = JSON.parse(semanticPrompt(cfg, chunks, emptySemantic()).user)
  assert.equal(data.people.length, 1)
  assert.deepEqual(data.people[0].roles, [{ role: 'technical_lead' }])
  assert.ok(data.people[0].identities.includes('email:old@team.com'))
})

test('an entirely negative batch makes no Claude call and replay uses its reversible checkpoints', async () => {
  const { root } = fixture(), api = mock(() => 0.01), metrics: Record<string, unknown>[] = []
  const opts = { log: () => {}, screening: { apiKey: 'test', cacheDir: cache(), fetch: api.fetch }, metrics: (m: Record<string, unknown>) => metrics.push(m), complete: async () => { throw Error('Claude must not run') } }
  await extractSemanticLoad(root, opts)
  assert.equal(readLoad(root).semanticCoverage!.screened, 2)
  assert.equal(metrics[0].claudeCalls, 0)
  const calls = api.calls()
  await extractSemanticLoad(root, opts)
  assert.equal(api.calls(), calls)
})
