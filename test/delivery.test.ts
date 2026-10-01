import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { stringify } from 'yaml'
import { loadConfig } from '../src/config.js'
import { explicitPrReference, reconcileDelivery } from '../src/delivery.js'
import { alwaysFolds, type Fetch } from '../src/gate.js'
import { describeWorkForPrompt, mirrorExternal, readWorkItems, writeWorkItems, type LoreWorkItem } from '../src/work.js'
import { recallData } from '../src/recall.js'
import { extract, streamFiles } from '../src/commands/extract.js'
import { captureConsole, makeContextRepo } from './helpers.js'

const AT = '2026-10-01T12:00:00.000Z'
const ticket = (key = 'ACM-1', extra: Partial<LoreWorkItem> = {}): LoreWorkItem => ({
  key, title: 'Allow customers to recover their account', description: 'Reset endpoint, email and reset screen.',
  status: 'todo', state: 'open', labels: [], sources: [], created: '2026-08-01', updated: '2026-08-01', history: [], ...extra,
})
const pr = (number = 42, extra = {}) => ({
  repo: 'acme/web', number, type: 'pr' as const, title: 'Password reset endpoint', body: 'Implements ACM-1 backend. UI and email remain.',
  state: 'open' as const, draft: true, merged: false, labels: [], assignees: [], author: 'developer',
  created_at: '2026-09-28T10:00:00Z', updated_at: '2026-09-29T10:00:00Z', url: `https://github.com/acme/web/pull/${number}`, ...extra,
})
function fixture(items = [ticket()], prs = [pr()]) {
  const root = makeContextRepo({ 'context/work/github/acme__web.yaml': stringify(prs) }, {
    project: 'acme', work: { prefix: 'ACM' }, extract: ['requests', 'decisions', 'roadmap'], sources: { github: { repos: ['acme/web'], api_base: 'https://api.github.com' } },
  })
  writeWorkItems(root, 'ACM', items)
  return { root, config: loadConfig(root) }
}
const rows = (root: string) => readWorkItems(root, 'ACM')
function fakeJev(related = 0.95, coverage = 0.2, onCall?: () => void) {
  let calls = 0
  const fetch = (async (_url: unknown, init: RequestInit) => {
    calls++
    onCall?.()
    const input = JSON.parse(String(init.body))
    assert.ok(Array.isArray(input.state))
    assert.ok(input.state[0].ticket.description)
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(input.questions).map(key =>
      [key, { noul: key.startsWith('related') ? related : coverage }])) }))
  }) as Fetch
  return { fetch, get calls() { return calls } }
}

test('delivery: references are bounded and issue numbers are repository-scoped', () => {
  assert.ok(explicitPrReference(ticket(), pr()))
  assert.equal(explicitPrReference(ticket(), pr(42, { body: 'ACM-10 and NOT-ACM-1' })), undefined)
  const linked = ticket('ACM-2', { external: { system: 'github', id: 'github:acme/api#12', key: '#12', url: 'https://github.com/acme/api/issues/12', status: 'open', category: 'open' } })
  assert.equal(explicitPrReference(linked, pr(42, { body: 'Fixes #12' })), undefined)
  assert.ok(explicitPrReference(linked, pr(42, { body: 'Fixes acme/api#12' })))
  assert.equal(explicitPrReference(linked, pr(42, { body: 'Fixes acme/api#123' })), undefined)
  assert.equal(explicitPrReference(linked, pr(42, { body: 'Fixes https://github.com/acme/api/issues/123' })), undefined)
  assert.ok(explicitPrReference(linked, pr(42, { repo: 'acme/api', body: 'Fixes #12' })))
})

test('delivery: explicit relationships refresh without Jev, preserve descriptions/status, and are idempotent', async () => {
  const { root, config } = fixture()
  assert.equal((await reconcileDelivery(root, config, { at: AT })).changed, 1)
  const first = rows(root)[0]
  assert.equal(first.related_prs?.[0].status, 'draft')
  assert.equal(first.related_prs?.[0].matched_by, 'reference')
  assert.equal(first.status, 'todo')
  assert.equal(first.description, ticket().description)
  assert.equal(first.history.length, 1)
  assert.equal((await reconcileDelivery(root, config, { at: AT })).changed, 0)
  assert.equal(rows(root)[0].history.length, 1)
  const streams = streamFiles(root)
  assert.equal(streams.length, 1)
  assert.ok(alwaysFolds(streams[0].path))
  assert.match(streams[0].text, /UI and email remain/)
  assert.match(describeWorkForPrompt(rows(root), '2026-10-01'), /Description: Reset endpoint/)
  const recalled = recallData(root, config, 'work').work['lore/ACM'].open[0] as LoreWorkItem
  assert.equal(recalled.related_prs?.[0].url, pr().url)

  writeFileSync(join(root, 'context/work/github/acme__web.yaml'), stringify([pr(42, { state: 'closed', merged: true, merged_at: AT, updated_at: AT })]))
  assert.equal((await reconcileDelivery(root, config, { at: AT })).changed, 1)
  assert.equal(rows(root)[0].related_prs?.[0].status, 'merged')
  assert.equal(rows(root)[0].status, 'todo', 'a partial merge is evidence for the fold, not automatic completion')
  assert.equal(rows(root)[0].history.length, 2)
})

test('delivery: Jev matches different wording, assesses coverage separately and caches positive/negative results', async () => {
  const { root, config } = fixture([ticket()], [pr(42, { body: 'Adds a password reset endpoint. UI and email remain.' })])
  const jev = fakeJev()
  await reconcileDelivery(root, config, { at: AT, apiKey: 'test', fetch: jev.fetch })
  const linked = rows(root)[0]
  assert.equal(linked.related_prs?.[0].matched_by, 'jev')
  assert.equal(linked.related_prs?.[0].coverage, 0.2)
  assert.equal(linked.status, 'todo')
  await reconcileDelivery(root, config, { at: AT, apiKey: 'test', fetch: jev.fetch })
  assert.equal(jev.calls, 1)
  await reconcileDelivery(root, config, { at: AT })
  assert.equal(rows(root)[0].history.length, 1, 'sync preserves cached judgments without rewriting links')
  assert.equal(rows(root)[0].related_prs?.[0].matched_by, 'jev', 'an inferred source URL must not become an explicit reference')

  const other = fixture([ticket()], [pr(42, { body: 'Changes unrelated account analytics.' })])
  const negative = fakeJev(0.1, 0.01)
  await reconcileDelivery(other.root, other.config, { at: AT, apiKey: 'test', fetch: negative.fetch })
  await reconcileDelivery(other.root, other.config, { at: AT, apiKey: 'test', fetch: negative.fetch })
  assert.equal(negative.calls, 1)
  assert.equal(rows(other.root)[0].related_prs, undefined)
})

test('delivery: requirement edits invalidate cached coverage and trigger reassessment', async () => {
  const { root, config } = fixture()
  const jev = fakeJev(0.99, 0.99)
  await reconcileDelivery(root, config, { at: AT, apiKey: 'test', fetch: jev.fetch })
  const items = rows(root)
  items[0].description = 'Also implement two-factor recovery.'
  writeWorkItems(root, 'ACM', items)
  await reconcileDelivery(root, config, { at: AT })
  assert.equal(rows(root)[0].related_prs?.[0].coverage, undefined, 'outdated coverage must not survive a scope change')
  await reconcileDelivery(root, config, { at: AT, apiKey: 'test', fetch: jev.fetch })
  assert.equal(jev.calls, 2)
})

test('delivery: concurrent ticket edits are kept and stale Jev judgments are discarded', async () => {
  const { root, config } = fixture()
  const jev = fakeJev(0.99, 0.99, () => {
    const items = rows(root)
    items[0].description = 'A different scope, edited while Jev was running.'
    items[0].priority = 'P1'
    writeWorkItems(root, 'ACM', items)
  })
  const result = await reconcileDelivery(root, config, { at: AT, apiKey: 'test', fetch: jev.fetch })
  assert.equal(result.changed, 0)
  assert.equal(rows(root)[0].priority, 'P1')
  assert.equal(rows(root)[0].related_prs, undefined)
})

test('delivery: concurrent GitHub updates cannot be overwritten by an older snapshot', async () => {
  const { root, config } = fixture()
  const jev = fakeJev(0.99, 0.99, () => {
    writeFileSync(join(root, 'context/work/github/acme__web.yaml'), stringify([pr(42, { state: 'closed', merged: true, updated_at: AT })]))
  })
  assert.equal((await reconcileDelivery(root, config, { at: AT, apiKey: 'test', fetch: jev.fetch })).changed, 0)
  await reconcileDelivery(root, config, { at: AT })
  assert.equal(rows(root)[0].related_prs?.[0].status, 'merged')
})

test('delivery: Jev failures and invalid probabilities retry, while explicit references still work', async () => {
  const { root, config } = fixture()
  const logs: string[] = []
  const bad = fakeJev(2, 0.5)
  await reconcileDelivery(root, config, { at: AT, apiKey: 'test', fetch: bad.fetch, log: s => logs.push(s) })
  assert.equal(rows(root)[0].related_prs?.[0].matched_by, 'reference')
  assert.equal(rows(root)[0].related_prs?.[0].coverage, undefined)
  assert.ok(logs.some(line => line.includes('retrying next extract')))
  const good = fakeJev()
  assert.equal((await reconcileDelivery(root, config, { at: AT, apiKey: 'test', fetch: good.fetch })).evaluated, 1)
})

test('delivery: multiple PRs and tickets stay separate; closed-unmerged never becomes merged', async () => {
  const { root, config } = fixture([ticket(), ticket('ACM-2')], [pr(42, { body: 'ACM-1 and ACM-2' }), pr(43, { state: 'closed' })])
  await reconcileDelivery(root, config, { at: AT })
  assert.equal(rows(root)[0].related_prs?.length, 2)
  assert.equal(rows(root)[1].related_prs?.length, 1)
  assert.equal(rows(root)[0].related_prs?.[1].status, 'closed')
  assert.ok(rows(root).every(item => item.status === 'todo'))
})

test('delivery: archived tickets and disabled/unconfigured repositories are excluded', async () => {
  const { root, config } = fixture([ticket('ACM-1', { status: 'archived' })])
  assert.equal((await reconcileDelivery(root, config, { at: AT })).changed, 0)
  writeWorkItems(root, 'ACM', [ticket()])
  config.sources.github.disabled = true
  assert.equal((await reconcileDelivery(root, config, { at: AT })).changed, 0)
  config.sources.github.disabled = false
  config.sources.github.repos = ['acme/other']
  assert.equal((await reconcileDelivery(root, config, { at: AT })).changed, 0)
})

test('delivery: a failed GitHub source is deferred, and a successful sync immediately recovers', async () => {
  const { root, config } = fixture()
  writeFileSync(join(root, 'state.json'), JSON.stringify({ cursors: {}, sources: { github: { lastAttempt: AT, lastError: { at: AT, message: 'offline' } } } }))
  assert.equal((await reconcileDelivery(root, config, { at: AT })).changed, 0)
  assert.equal((await reconcileDelivery(root, config, { at: AT, freshSync: true })).changed, 1)
})

test('delivery: mirrored GitHub descriptions inform matching and preserve human edits', () => {
  const { root, config } = fixture([], [pr(7, { type: 'issue', title: 'Account recovery', body: 'Endpoint, email and UI.' })])
  mirrorExternal(root, config, AT)
  assert.equal(rows(root)[0].description, 'Endpoint, email and UI.')
  const items = rows(root)
  items[0].description = 'Human clarified acceptance requirements.'
  items[0].history.push({ at: AT, by: 'person', via: 'web', reason: 'clarified scope', change: { description: ['Endpoint, email and UI.', items[0].description] } })
  writeWorkItems(root, 'ACM', items)
  writeFileSync(join(root, 'context/work/github/acme__web.yaml'), stringify([pr(7, { type: 'issue', body: 'Upstream description edit.' })]))
  mirrorExternal(root, config, AT)
  assert.equal(rows(root)[0].description, 'Human clarified acceptance requirements.')
})

test('delivery: catches historical matches without new streams, including explicit older PRs', async () => {
  const { root, config } = fixture([ticket()], [pr(42, { state: 'closed', merged: true, updated_at: '2025-01-01T00:00:00Z' })])
  assert.equal(streamFiles(root).length, 0)
  await reconcileDelivery(root, config, { at: AT })
  assert.equal(rows(root)[0].related_prs?.[0].status, 'merged')
  assert.equal(streamFiles(root).length, 1)
  assert.match(streamFiles(root)[0].text, /2025-01-01/)
})

test('delivery: bounded catch-up continues automatically without repeating evaluated pairs', async () => {
  const { root, config } = fixture(Array.from({ length: 241 }, (_, n) => ticket(`ACM-${n + 1}`)), [pr(42, { body: 'Different wording' })])
  const jev = fakeJev(0.01, 0.01)
  const first = await reconcileDelivery(root, config, { at: AT, apiKey: 'test', fetch: jev.fetch })
  assert.equal(first.evaluated, 240)
  assert.equal(first.pending, 1)
  const second = await reconcileDelivery(root, config, { at: AT, apiKey: 'test', fetch: jev.fetch })
  assert.equal(second.evaluated, 1)
  assert.equal(second.pending, 0)
})

test('extract: historical delivery evidence bypasses a negative gate and reaches the fold with descriptions', async () => {
  const { root } = fixture([ticket()], [pr(42, { state: 'closed', merged: true, draft: false })])
  writeFileSync(join(root, 'context/derived/requests.yaml'), '- id: req-0001\n  request: Account recovery\n  status: open\n')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const promptFile = join(root, 'fold-prompt.txt')
  // A local fake Claude executable validates plumbing, never calls a model.
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
if (prompt.includes('# New material')) {
  fs.writeFileSync(${JSON.stringify(promptFile)}, prompt);
  console.log(JSON.stringify({result: JSON.stringify({requests: [], decisions: [], roadmap: [], contradictions: [], work_new: [], work_changes: [{key: 'ACM-1', status: 'in_progress', reason: 'Backend merged, UI and email remain', sources: ['https://github.com/acme/web/pull/42'], confidence: 'high', evidence_date: '2026-09-29'}]})}));
} else console.log(JSON.stringify({result: 'Backend merged; UI and email remain.'}));
`, { mode: 0o755 })
  const names = ['PATH', 'LORE_LLM', 'TYPESAFE_API_KEY', 'LORE_PR_MATCHING', 'LORE_GATE'] as const
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]))
  const realFetch = globalThis.fetch
  let gateCalls = 0
  try {
    process.env.PATH = `${bin}:${process.env.PATH}`
    process.env.LORE_LLM = 'cli'
    process.env.TYPESAFE_API_KEY = 'test'
    process.env.LORE_PR_MATCHING = 'off'
    delete process.env.LORE_GATE
    globalThis.fetch = (async () => { gateCalls++; throw new Error('Delivery must bypass the gate') }) as Fetch
    await captureConsole(() => extract(root))
    assert.equal(gateCalls, 0, 'the fold must run without consulting the chatter gate')
    const prompt = readFileSync(promptFile, 'utf8')
    assert.match(prompt, /Related PR acme\/web#42/)
    assert.match(prompt, /Reset endpoint, email and reset screen/)
    assert.match(prompt, /UI and email remain/)
    assert.match(prompt, /Jev's relevance\/coverage/)
    assert.equal(rows(root)[0].status, 'in_progress')
    assert.equal(rows(root)[0].related_prs?.[0].status, 'merged')
    assert.equal(rows(root)[0].history.at(-1)?.via, 'fold')
  } finally {
    globalThis.fetch = realFetch
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name]
      else process.env[name] = old[name]
    }
  }
})
