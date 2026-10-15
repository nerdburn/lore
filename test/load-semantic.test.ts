import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { configSchema } from '../src/config.js'
import { writeDocs } from '../src/streams.js'
import { makeContextRepo } from './helpers.js'
import { readLoadInputs } from '../src/load/inputs.js'
import { buildLoad } from '../src/load/build.js'
import { queryLoad } from '../src/load/query.js'
import { acceptSemantic, emptySemantic, mergeSemantic, semanticChunks, semanticPrompt } from '../src/load/semantic-events.js'
import { extractSemanticLoad } from '../src/load/semantic-extract.js'
import { LOAD_FILE, readLoad, rebuildLoad, saveLoad } from '../src/load/store.js'

const config = configSchema.parse({ project: 'acme', sources: {}, load: { enabled: true, timezone: 'America/Vancouver', semantic: { enabled: true }, actors: [
  { id: 'dev', name: 'Developer', kind: 'human', identities: ['name:Developer', 'email:dev@team.com'], roles: [{ role: 'technical_lead' }] },
  { id: 'client', name: 'Customer', kind: 'human', identities: ['name:Customer', 'email:client@acme.com'], roles: [{ role: 'customer' }] },
] } })

function fixture() {
  const root = makeContextRepo({}, config)
  writeDocs(root, [
    { source: 'slack', channel: 'acme', id: 'slack-one', author: 'Developer', timestamp: '2026-10-01T17:00:00Z', text: 'I decided to use the existing database. I will implement the migration on Friday.' },
    { source: 'gmail', channel: 'acme', id: 'gmail-one', author: 'Customer', timestamp: '2026-10-01T18:00:00Z', meta: { from: 'client@acme.com', to: 'dev@team.com', message_id: 'one', mailboxes: 'dev@team.com' }, text: 'Please add a CSV export for the monthly report.' },
  ])
  return root
}
const propose = (key: string, quote = 'I decided to use the existing database.') => ({ existing_id: null, type: 'decision.made', summary: 'Use the existing database', actor_keys: ['name:Developer'], occurred_on: '2026-10-01', confidence: 'high', evidence: [{ chunk: key, quote }], related: [] })

test('semantic activities require quoted evidence, temporal actors and separate source/inferred totals', () => {
  const root = fixture(), input = readLoadInputs(root), chunks = semanticChunks(input, config)
  const slack = chunks.find(c => c.source === 'slack')!, email = chunks.find(c => c.source === 'gmail')!
  const state = acceptSemantic(emptySemantic(), chunks, { events: [propose(slack.key),
    { ...propose(slack.key, 'I will implement the migration on Friday.'), type: 'human.committed', summary: 'Implement the migration' },
    { ...propose(email.key, 'Please add a CSV export for the monthly report.'), type: 'client.requested', summary: 'Add CSV export', actor_keys: ['email:client@acme.com'] },
  ] }, 'test-model')
  const snapshot = buildLoad(root, input, state)
  const q = queryLoad(snapshot, { from: '2026-10-01', to: '2026-10-02', method: 'inferred', events: true })
  assert.equal(q.matchedEvents, 3)
  assert.equal(q.byMethod.find(x => x.method === 'inferred')!.accepted, 3)
  assert.equal(queryLoad(snapshot, { role: 'technical_lead', method: 'inferred' }).matchedEvents, 2)
  assert.equal(snapshot.semanticCoverage!.pending, 0)
  assert.equal(q.events![0].time_precision, 'day')
  assert.ok(q.events!.every(e => e.evidence[0].quote))
  assert.equal(queryLoad(snapshot, { from: '2026-10-02', method: 'inferred' }).matchedEvents, 0)
})

test('repeat mentions and exact anchor replay attach evidence without adding another event; reversals stay separate', () => {
  const root = fixture()
  writeDocs(root, [{ source: 'granola', channel: 'acme', id: 'notes', author: 'Customer', timestamp: '2026-10-02T18:00:00Z', text: 'Developer confirmed the existing database decision.' }])
  const chunks = semanticChunks(readLoadInputs(root), config), first = chunks.find(c => c.source === 'slack')!, recap = chunks.find(c => c.source === 'granola')!
  let state = acceptSemantic(emptySemantic(), [first], { events: [propose(first.key)] }, 'test')
  const id = state.records[0].id
  state = acceptSemantic(state, [recap], { events: [{ ...propose(recap.key, 'Developer confirmed the existing database decision.'), existing_id: id }] }, 'test')
  state = acceptSemantic(state, [first], { events: [propose(first.key)] }, 'test')
  assert.equal(state.records.length, 1)
  assert.equal(state.records[0].evidence.length, 2)
  assert.equal(state.records[0].occurred_on, '2026-10-01')
  assert.equal(buildLoad(root, undefined, state).events.find(e => e.id === id)!.status, 'accepted')
  const reversal = { ...propose(first.key, 'I will implement the migration on Friday.'), summary: 'A different act', type: 'human.committed', related: [id] }
  state = acceptSemantic(state, [first], { events: [reversal] }, 'test')
  assert.equal(state.records.length, 2)
  assert.deepEqual(state.records[1].related, [id])
})

test('an original statement fills a recap’s missing occurrence date without overwriting a known date', () => {
  const chunks = semanticChunks(readLoadInputs(fixture()), config), c = chunks.find(c => c.source === 'slack')!
  let state = acceptSemantic(emptySemantic(), [c], { events: [{ ...propose(c.key), occurred_on: null, actor_keys: [], confidence: 'medium' }] }, 'test')
  state = acceptSemantic(state, [c], { events: [{ ...propose(c.key), existing_id: state.records[0].id }] }, 'test')
  assert.equal(state.records.length, 1)
  assert.equal(state.records[0].occurred_on, '2026-10-01')
  assert.equal(state.records[0].confidence, 'medium', 'new evidence does not silently promote an uncertain interpretation')
  assert.deepEqual(state.records[0].actor_keys, ['name:Developer'])
  state = acceptSemantic(state, [c], { events: [{ ...propose(c.key), existing_id: state.records[0].id, occurred_on: '2026-10-02' }] }, 'test')
  assert.equal(state.records[0].occurred_on, '2026-10-01')
})

test('workspace-scoped Slack IDs resolve known customers despite changing display names', () => {
  const root = fixture()
  const cfg = structuredClone(config)
  cfg.load!.actors[1].identities.push('slack:T1:U1')
  writeFileSync(join(root, 'lore.json'), JSON.stringify(cfg))
  writeDocs(root, [{ source: 'slack', channel: 'acme', id: 'slack-customer', author: 'U1', timestamp: '2026-10-01T17:00:00Z', meta: { team: 'T1', user: 'U1' }, text: 'Please add CSV export for the finance team.' }])
  const input = readLoadInputs(root), c = semanticChunks(input, cfg).find(c => c.doc.fields.id === 'slack-customer')!
  const state = acceptSemantic(emptySemantic(), [c], { events: [{ ...propose(c.key, c.text), type: 'client.requested', actor_keys: ['slack:T1:U1'] }] }, 'test')
  const e = buildLoad(root, input, state).events.find(e => e.method === 'inferred')!
  assert.equal(e.actor!.id, 'client')
  assert.equal(e.status, 'accepted')
})

test('hallucinated quotes, links and invalid dates cannot consume checkpoints', () => {
  const chunks = semanticChunks(readLoadInputs(fixture()), config), c = chunks.find(c => c.source === 'slack')!
  const state = emptySemantic()
  assert.throws(() => acceptSemantic(state, [c], { events: [propose(c.key, 'This invented sentence is not present.')] }, 'test'), /quote/)
  assert.throws(() => acceptSemantic(state, [c], { events: [{ ...propose(c.key), existing_id: 'invented-id' }] }, 'test'), /target/)
  assert.throws(() => acceptSemantic(state, [c], { events: [{ ...propose(c.key), occurred_on: '2026-02-30' }] }, 'test'))
  assert.deepEqual(state, emptySemantic())
})

test('unknown actors, non-customers and uncertain historical dates remain candidates', () => {
  const root = fixture(), chunks = semanticChunks(readLoadInputs(root), config), c = chunks.find(c => c.source === 'slack')!
  for (const patch of [{ actor_keys: ['name:Unknown'] }, { type: 'client.requested' }, { occurred_on: '2026-09-01' }, { confidence: 'medium' }]) {
    const state = acceptSemantic(emptySemantic(), [c], { events: [{ ...propose(c.key), ...patch }] }, 'test')
    const event = buildLoad(root, undefined, state).events.find(e => e.method === 'inferred')!
    assert.equal(event.status, 'candidate')
    assert.ok((event.attributes.candidateReasons as string[]).length)
  }
})

test('unknown occurrence dates stay out of period counts but have an explicit evidence query', () => {
  const root = fixture(), chunks = semanticChunks(readLoadInputs(root), config), c = chunks.find(c => c.source === 'slack')!
  const state = acceptSemantic(emptySemantic(), [c], { events: [{ ...propose(c.key), occurred_on: null }] }, 'test')
  const snapshot = buildLoad(root, undefined, state)
  assert.equal(queryLoad(snapshot, { method: 'inferred' }).undatedExcluded, 1)
  const q = queryLoad(snapshot, { method: 'inferred', undated: true, events: true, groupBy: 'week' })
  assert.equal(q.events!.length, 1)
  assert.equal(q.groups[0].key, 'undated')
  assert.throws(() => queryLoad(snapshot, { undated: true, from: '2026-10-01' }))
})

test('changed evidence invalidates quotes and pending digests even at identical byte length', () => {
  const root = fixture(), input = readLoadInputs(root), chunks = semanticChunks(input, config), c = chunks.find(c => c.source === 'slack')!
  const state = acceptSemantic(emptySemantic(), chunks, { events: [propose(c.key)] }, 'test')
  writeFileSync(join(root, c.path), input.files.get(c.path)!.replace('decided', 'queried'))
  const snapshot = buildLoad(root, undefined, state)
  assert.equal(snapshot.events.filter(e => e.method === 'inferred').length, 0)
  assert.equal(snapshot.semanticCoverage!.invalidatedEvents, 1)
  assert.equal(snapshot.semanticCoverage!.pending, 1)
})

test('semantic checkpoint ignores artifact gate progress, survives source rebuild, and replay makes no LLM call', async () => {
  const root = fixture(), input = readLoadInputs(root)
  writeFileSync(join(root, 'state.json'), JSON.stringify({ extracted: Object.fromEntries([...input.files].map(([p, s]) => [p, s.length])) }))
  let calls = 0
  await extractSemanticLoad(root, { log: () => {}, complete: async (_system, prompt) => {
    calls++
    const c = JSON.parse(prompt).documents.find((d: { source: string }) => d.source === 'slack')
    return { value: { events: [propose(c.chunk)] }, model: 'test' }
  } })
  assert.equal(calls, 1)
  const id = readLoad(root).semantic!.records[0].id
  rebuildLoad(root)
  assert.equal(readLoad(root).semantic!.records[0].id, id)
  await extractSemanticLoad(root, { log: () => {}, complete: async () => { throw new Error('must not call') } })
  assert.equal(readLoad(root).events.filter(e => e.method === 'inferred').length, 1)
})

test('a failed later batch preserves completed work and resumes only remaining chunks', async () => {
  const root = fixture()
  writeDocs(root, [{ source: 'slack', channel: 'acme', id: 'large', author: 'Developer', timestamp: '2026-10-03T18:00:00Z', text: 'ordinary discussion '.repeat(3500) }])
  let calls = 0
  await assert.rejects(extractSemanticLoad(root, { maxBatches: 10, log: () => {}, complete: async () => {
    if (++calls === 2) throw new Error('provider unavailable')
    return { value: { events: [] }, model: 'test' }
  } }), /unavailable/)
  const failed = readLoad(root)
  assert.ok(failed.semanticCoverage!.processed > 0)
  assert.ok(failed.semanticCoverage!.pending > 0)
  assert.match(failed.semanticCoverage!.error!, /unavailable/)
  const already = new Set(Object.keys(failed.semantic!.checkpoints))
  await extractSemanticLoad(root, { maxBatches: 10, log: () => {}, complete: async (_s, prompt) => {
    for (const d of JSON.parse(prompt).documents) assert.ok(!already.has(d.chunk))
    return { value: { events: [] }, model: 'test' }
  } })
  assert.equal(readLoad(root).semanticCoverage!.pending, 0)
  assert.equal(readLoad(root).semanticCoverage!.error, undefined)
})

test('invalid model quotation is retried once; only the corrected batch is published', async () => {
  const root = fixture(), c = semanticChunks(readLoadInputs(root), config).find(c => c.source === 'slack')!
  let calls = 0
  await extractSemanticLoad(root, { log: () => {}, complete: async (_s, prompt) => {
    calls++
    if (calls === 2) assert.match(prompt, /failed validation/)
    return { value: { events: [propose(c.key, calls === 1 ? 'This sentence does not exist.' : 'I decided to use the existing database.')] }, model: 'test' }
  } })
  assert.equal(calls, 2)
  assert.equal(readLoad(root).semantic!.records.length, 1)
  assert.equal(readLoad(root).semanticCoverage!.pending, 0)
})

test('source changes during model processing remain pending in the published coherent snapshot', async () => {
  const root = fixture(), input = readLoadInputs(root), c = semanticChunks(input, config).find(c => c.source === 'slack')!
  await extractSemanticLoad(root, { log: () => {}, complete: async () => {
    writeFileSync(join(root, c.path), input.files.get(c.path)!.replace('decided', 'queried'))
    return { value: { events: [propose(c.key)] }, model: 'test' }
  } })
  assert.equal(readLoad(root).semanticCoverage!.pending, 1)
  assert.equal(readLoad(root).semanticCoverage!.invalidatedEvents, 1)
})

test('corrupt persisted projection never silently erases the semantic ledger', () => {
  const root = fixture()
  rebuildLoad(root)
  writeFileSync(join(root, LOAD_FILE), '{broken')
  assert.throws(() => rebuildLoad(root))
  assert.equal(readFileSync(join(root, LOAD_FILE), 'utf8'), '{broken')
})

test('concurrent ledgers retain all event evidence and conflicting revisions stay pending', () => {
  const root = fixture(), chunks = semanticChunks(readLoadInputs(root), config), c = chunks.find(c => c.source === 'slack')!
  const a = acceptSemantic(emptySemantic(), [c], { events: [propose(c.key)] }, 'test')
  const b = structuredClone(a)
  b.checkpoints[c.key] = 'different-digest'
  b.checkpoints.other = 'other-digest'
  b.records[0].evidence.push({ ...b.records[0].evidence[0], quote: 'I will implement the migration on Friday.' })
  const merged = mergeSemantic(a, b)
  assert.equal(merged.records.length, 1)
  assert.equal(merged.records[0].evidence.length, 2)
  assert.equal(merged.checkpoints[c.key], undefined)
  assert.equal(merged.checkpoints.other, 'other-digest')
})

test('project review excludes accepted or candidate claims across replay, merge and rebuild without deleting evidence', () => {
  for (const confidence of ['high', 'medium']) {
    const root = fixture(), chunks = semanticChunks(readLoadInputs(root), config), c = chunks.find(c => c.source === 'slack')!
    const state = acceptSemantic(emptySemantic(), [c], { events: [{ ...propose(c.key), confidence }] }, 'test')
    const id = state.records[0].id
    const cfg = structuredClone(config)
    cfg.load!.semantic!.excluded_events = [{ id, reason: 'Confirmed as a different project request.', reviewed_on: '2026-10-15' }]
    writeFileSync(join(root, 'lore.json'), JSON.stringify(cfg))
    const replayed = acceptSemantic(state, [c], { events: [propose(c.key)] }, 'test')
    const merged = mergeSemantic(replayed, state)
    saveLoad(root, buildLoad(root, undefined, merged))
    const snapshot = rebuildLoad(root)
    assert.deepEqual(snapshot.semantic, JSON.parse(JSON.stringify(merged)))
    assert.deepEqual(snapshot.semantic!.records, state.records)
    assert.equal(snapshot.events.some(e => e.id === id), false)
    assert.equal(queryLoad(snapshot, { method: 'inferred' }).matchedEvents, 0)
    assert.equal(snapshot.semanticCoverage!.excludedEvents, 1)
    assert.equal(snapshot.semanticCoverage!.invalidatedEvents, 0)
    assert.match(snapshot.warnings.join('\n'), /excluded by project review/)
    const prompt = JSON.parse(semanticPrompt(cfg, [c], state).user)
    assert.equal(prompt.reviewed_exclusions[0].id, id)
    assert.equal(prompt.reviewed_exclusions[0].summary, state.records[0].summary)
    writeFileSync(join(root, 'lore.json'), JSON.stringify(config))
    assert.equal(rebuildLoad(root).events.find(e => e.id === id)!.status, confidence === 'high' ? 'accepted' : 'candidate')
  }
})

test('project review requires a semantic ID, meaningful reason and valid review date', () => {
  const review = { id: 'load-sem-' + 'a'.repeat(32), reason: 'Different project', reviewed_on: '2026-10-15' }
  const parse = (entry: unknown) => configSchema.parse({ project: 'acme', load: { semantic: { excluded_events: [entry] } } })
  assert.doesNotThrow(() => parse(review))
  for (const patch of [{ id: 'unknown' }, { reason: ' ' }, { reviewed_on: '2026-02-30' }]) assert.throws(() => parse({ ...review, ...patch }))
})
