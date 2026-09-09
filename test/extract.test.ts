import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptFold, pack, parseFoldOutput, streamFiles, withRetry } from '../src/commands/extract.js'
import { makeContextRepo } from './helpers.js'

const VALID = { requests: [], decisions: [{ id: 'dec-0001' }], roadmap: [], contradictions: [] }

test('extract: parses bare JSON, JSON in prose, and fenced JSON', () => {
  const s = JSON.stringify(VALID)
  assert.deepEqual(parseFoldOutput(s), VALID)
  assert.deepEqual(parseFoldOutput(`Here are the artifacts:\n${s}\nDone.`), VALID)
  assert.deepEqual(parseFoldOutput('```json\n' + s + '\n```'), VALID)
})

test('extract: rejects output with no JSON, invalid JSON, or missing arrays', () => {
  assert.throws(() => parseFoldOutput('I could not do that.'), /no JSON/)
  assert.throws(() => parseFoldOutput('{"requests": [,]}'), /not valid JSON/)
  assert.throws(() => parseFoldOutput(JSON.stringify({ requests: [], decisions: [] })), /missing array "roadmap"/)
  assert.throws(() => parseFoldOutput(JSON.stringify({ ...VALID, contradictions: 'none' })), /missing array "contradictions"/)
})

test('extract: pack keeps whole day-files and records each batch\'s last day and members', () => {
  const files = [
    { path: 'a.md', day: '2026-08-01', text: 'a'.repeat(60) },
    { path: 'b.md', day: '2026-08-02', text: 'b'.repeat(60) },
    { path: 'c.md', day: '2026-08-03', text: 'c'.repeat(60) },
  ]
  const batches = pack(files, 130)
  assert.equal(batches.length, 2)
  assert.equal(batches[0].lastDay, '2026-08-02')
  assert.equal(batches[1].lastDay, '2026-08-03')
  assert.deepEqual(batches[0].files, [{ path: 'a.md', length: 60 }, { path: 'b.md', length: 60 }])
  assert.deepEqual(batches[1].files, [{ path: 'c.md', length: 60 }])
  assert.ok(batches[0].text.includes('a'.repeat(60)) && batches[0].text.includes('b'.repeat(60)))
  assert.ok(!batches[0].text.includes('c'))
})

test('extract: pack never splits a single oversized file', () => {
  const batches = pack([{ day: '2026-08-01', text: 'x'.repeat(500) }], 100)
  assert.equal(batches.length, 1)
  assert.equal(batches[0].lastDay, '2026-08-01')
})

test('extract: acceptFold keeps the previous list when the model drops items', () => {
  const prev = [{ id: 'dec-0001', decision: 'a' }, { id: 'dec-0002', decision: 'b' }]
  assert.deepEqual(acceptFold('decisions', prev, []), { items: prev, rejected: '0 item(s) for 2 existing, missing dec-0001, dec-0002' })
  assert.equal(acceptFold('decisions', prev, [{ id: 'dec-0002', decision: 'b' }]).rejected, '1 item(s) for 2 existing, missing dec-0001')
  const renamed = [{ id: 'dec-0001', decision: 'a' }, { id: 'dec-0003', decision: 'c' }]
  assert.match(acceptFold('decisions', prev, renamed).rejected!, /missing dec-0002/)
  assert.equal(acceptFold('decisions', prev, undefined).rejected, 'no "decisions" array')
})

test('extract: acceptFold accepts growth and in-place updates, and anything when starting from empty', () => {
  const prev = [{ id: 'req-0001', status: 'open' }]
  const updated = [{ id: 'req-0001', status: 'done' }, { id: 'req-0002', status: 'open' }]
  assert.deepEqual(acceptFold('requests', prev, updated), { items: updated })
  assert.deepEqual(acceptFold('requests', [], []), { items: [] })
  assert.deepEqual(acceptFold('requests', [], updated), { items: updated })
})

test('extract: streamFiles lists every source in day order with root-relative paths', () => {
  const root = makeContextRepo({
    'context/streams/slack/#acme/2026-08-03.md': 'slack aug 3',
    'context/streams/granola/Acme/2026-06-10.md': 'meeting june 10',
    'context/streams/github/acme_web/2026-08-03.md': 'gh aug 3',
    'context/streams/slack/#acme/notes.txt': 'ignored',
  })
  const files = streamFiles(root)
  assert.deepEqual(
    files.map((f) => [f.day, f.path]),
    [
      ['2026-06-10', 'context/streams/granola/Acme/2026-06-10.md'],
      ['2026-08-03', 'context/streams/github/acme_web/2026-08-03.md'],
      ['2026-08-03', 'context/streams/slack/#acme/2026-08-03.md'],
    ],
  )
})

test('extract: new material is any file whose length differs from state.extracted — old-dated files included', () => {
  const root = makeContextRepo({
    'context/streams/slack/#acme/2026-08-03.md': 'day file',
    'context/streams/granola/Acme/2026-06-10.md': 'old meeting added today',
  })
  const files = streamFiles(root)
  const extracted: Record<string, number> = { 'context/streams/slack/#acme/2026-08-03.md': 'day file'.length }
  const fresh = files.filter((f) => extracted[f.path] !== f.text.length)
  assert.deepEqual(fresh.map((f) => f.path), ['context/streams/granola/Acme/2026-06-10.md'])
  extracted['context/streams/slack/#acme/2026-08-03.md'] = 3 // a reply was appended → length changed
  assert.equal(files.filter((f) => extracted[f.path] !== f.text.length).length, 2)
})

test('extract: withRetry retries transient errors with backoff and gives up after the limit', async () => {
  let calls = 0
  const waits: number[] = []
  const flaky = async () => {
    calls++
    if (calls < 3) throw new Error('terminated')
    return 'ok'
  }
  assert.equal(await withRetry(flaky, 2, () => {}, async (ms) => void waits.push(ms)), 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(waits, [5000, 10000])
  calls = 0
  await assert.rejects(withRetry(async () => { calls++; throw new Error('terminated') }, 1, () => {}, async () => {}), /terminated/)
  assert.equal(calls, 2)
})

test('extract: withRetry does not retry deterministic failures', async () => {
  let calls = 0
  await assert.rejects(withRetry(async () => { calls++; throw new Error('extract: model refused the request') }, 3, () => {}, async () => {}), /refused/)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(withRetry(async () => { calls++; throw new Error('extract: output truncated — lower BATCH_CHARS') }, 3, () => {}, async () => {}), /truncated/)
  assert.equal(calls, 1)
})
