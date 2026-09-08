import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { check } from '../src/commands/check.js'
import { sync } from '../src/commands/sync.js'
import type { Connector, Doc } from '../src/types.js'
import { captureConsole, makeContextRepo } from './helpers.js'

const doc = (id: string, text = 'hi'): Doc => ({
  id,
  source: 'fake',
  channel: '#acme',
  author: 'a',
  timestamp: '2026-08-03T10:00:00.000Z',
  text,
})

/** A connector whose behaviour each test scripts. */
function fake(impl: Connector['fetch']): Connector {
  return { name: 'fake', fetch: impl }
}

const config = (sources: Record<string, unknown>) => ({ project: 'acme', sources, backfill: { months: 1 } })

test('sync: a healthy source writes docs, advances its cursor, records lastSuccess', async () => {
  process.env.FAKE_TOKEN = 't'
  const root = makeContextRepo({}, config({ fake: { token: 'env:FAKE_TOKEN' } }))
  let seen: unknown
  const registry = {
    fake: fake(async (ctx) => {
      seen = ctx
      return { docs: [doc('fake-1'), doc('fake-2')], nextCursor: { pos: 2 } }
    }),
  }
  const { result, err } = await captureConsole(() => sync(root, registry))
  assert.equal(result.ok, true)
  assert.deepEqual(result.sources.fake, { status: 'ok', written: 2, errors: [] })
  assert.equal(err, '')
  assert.equal((seen as { config: { token: string } }).config.token, 't')
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
  assert.deepEqual(state.cursors.fake, { pos: 2 })
  assert.ok(state.sources.fake.lastSuccess)
  assert.equal(state.sources.fake.lastError, undefined)
  assert.ok(state.lastSync)
})

test('sync: a configured source with no connector fails the run and is recorded', async () => {
  const root = makeContextRepo({}, config({ linear: { teams: ['ACME'] } }))
  const { result, err } = await captureConsole(() => sync(root, {}))
  assert.equal(result.ok, false)
  assert.equal(result.sources.linear.status, 'failed')
  assert.match(result.sources.linear.errors[0], /no such connector "linear"/)
  assert.match(err, /sync failed: linear/)
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
  assert.match(state.sources.linear.lastError.message, /no such connector/)
  assert.equal(state.sources.linear.lastSuccess, undefined)
})

test('sync: disabled sources are skipped without failing', async () => {
  const root = makeContextRepo({}, config({ linear: { teams: ['x'], disabled: true } }))
  const { result, out } = await captureConsole(() => sync(root, {}))
  assert.equal(result.ok, true)
  assert.equal(result.sources.linear.status, 'disabled')
  assert.match(out, /linear: disabled — skipped/)
})

test('sync: missing env vars fail the source', async () => {
  delete process.env.NOPE_TOKEN
  const root = makeContextRepo({}, config({ fake: { token: 'env:NOPE_TOKEN' } }))
  const { result } = await captureConsole(() => sync(root, { fake: fake(async () => ({ docs: [], nextCursor: {} })) }))
  assert.equal(result.ok, false)
  assert.match(result.sources.fake.errors[0], /missing env vars: NOPE_TOKEN/)
})

test('sync: a thrown fetch fails the source but other sources still complete', async () => {
  const root = makeContextRepo({}, config({ bad: {}, good: {} }))
  const registry = {
    bad: { name: 'bad', fetch: async () => { throw new Error('boom') } },
    good: fake(async () => ({ docs: [doc('g-1')], nextCursor: { ok: 1 } })),
  }
  const { result } = await captureConsole(() => sync(root, registry))
  assert.equal(result.ok, false)
  assert.equal(result.sources.bad.status, 'failed')
  assert.deepEqual(result.sources.bad.errors, ['boom'])
  assert.deepEqual(result.sources.good, { status: 'ok', written: 1, errors: [] })
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
  assert.deepEqual(state.cursors.good, { ok: 1 })
  assert.equal(state.cursors.bad, undefined)
})

test('sync: connector-reported errors keep the docs but fail the run', async () => {
  const root = makeContextRepo({}, config({ fake: {} }))
  const registry = {
    fake: fake(async () => ({ docs: [doc('f-1')], nextCursor: { a: 1 }, errors: ['channel #x not found'] })),
  }
  const { result } = await captureConsole(() => sync(root, registry))
  assert.equal(result.ok, false)
  assert.equal(result.sources.fake.written, 1)
  assert.deepEqual(result.sources.fake.errors, ['channel #x not found'])
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
  assert.deepEqual(state.cursors.fake, { a: 1 }, 'partial progress is kept')
  assert.match(state.sources.fake.lastError.message, /#x not found/)
})

test('sync: a later success clears lastError but keeps the history of lastSuccess', async () => {
  const root = makeContextRepo({}, config({ fake: {} }))
  let fail = true
  const registry = {
    fake: fake(async () => (fail ? { docs: [], nextCursor: {}, errors: ['nope'] } : { docs: [], nextCursor: {} })),
  }
  await captureConsole(() => sync(root, registry))
  fail = false
  await captureConsole(() => sync(root, registry))
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
  assert.ok(state.sources.fake.lastSuccess)
  assert.equal(state.sources.fake.lastError, undefined)
})

test('sync: connector files are written under context/ and readable back next run', async () => {
  const root = makeContextRepo({}, config({ fake: {} }))
  let sawPrevious: string | undefined = 'unset'
  const registry = {
    fake: fake(async (ctx) => {
      sawPrevious = ctx.readFile('context/work/fake/acme.yaml')
      return { docs: [], nextCursor: {}, files: { 'context/work/fake/acme.yaml': '- number: 1\n' } }
    }),
  }
  await captureConsole(() => sync(root, registry))
  assert.equal(sawPrevious, undefined)
  assert.equal(readFileSync(join(root, 'context/work/fake/acme.yaml'), 'utf8'), '- number: 1\n')
  await captureConsole(() => sync(root, registry))
  assert.equal(sawPrevious, '- number: 1\n')
})

test('sync: connector file paths outside context/ are rejected', async () => {
  const root = makeContextRepo({}, config({ fake: {} }))
  const registry = { fake: fake(async () => ({ docs: [], nextCursor: {}, files: { '../evil.yaml': 'x' } })) }
  const { result } = await captureConsole(() => sync(root, registry))
  assert.equal(result.ok, false)
  assert.match(result.sources.fake.errors[0], /inside context/)
})

test('sync: redaction count is reported', async () => {
  const root = makeContextRepo({}, config({ fake: {} }))
  const registry = { fake: fake(async () => ({ docs: [doc('f-1', ['AKIA', 'IOSFODNN7EXAMPLE'].join(''))], nextCursor: {} })) }
  const { out } = await captureConsole(() => sync(root, registry))
  assert.match(out, /1 secret\(s\) redacted/)
})

test('check: fails for an unsupported configured source, passes when it is disabled', async () => {
  const bad = makeContextRepo({}, config({ linear: { teams: ['x'] } }))
  const r1 = await captureConsole(() => check(bad, {}))
  assert.equal(r1.result, false)
  assert.match(r1.err, /no such connector/)
  assert.match(r1.err, /"disabled": true/)

  const disabled = makeContextRepo({}, config({ linear: { teams: ['x'], disabled: true } }))
  const r2 = await captureConsole(() => check(disabled, {}))
  assert.equal(r2.result, true)
  assert.match(r2.out, /linear": disabled/)
})

test('check: reports missing env and shows source health from state.json', async () => {
  delete process.env.NOPE_TOKEN
  const root = makeContextRepo(
    {
      'state.json': JSON.stringify({
        cursors: {},
        sources: { fake: { lastAttempt: 'A', lastSuccess: '2026-09-01T00:00:00Z', lastError: { at: '2026-09-02T00:00:00Z', message: 'kaboom' } } },
      }),
    },
    config({ fake: { token: 'env:NOPE_TOKEN' } }),
  )
  const r = await captureConsole(() => check(root, { fake: fake(async () => ({ docs: [], nextCursor: {} })) }))
  assert.equal(r.result, false)
  assert.match(r.err, /missing env vars: NOPE_TOKEN/)
  assert.match(r.out, /last success: 2026-09-01/)
  assert.match(r.out, /last error: +2026-09-02.*kaboom/)
})

test('check: invalid lore.json is a failure', async () => {
  const root = makeContextRepo({ 'lore.json': '{"project": ""}' })
  const r = await captureConsole(() => check(root, {}))
  assert.equal(r.result, false)
  assert.match(r.err, /lore\.json/)
})
