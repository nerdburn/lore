import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptFold, pack, parseFoldOutput } from '../src/commands/extract.js'

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

test('extract: pack keeps whole day-files and records each batch\'s last day', () => {
  const files = [
    { day: '2026-08-01', text: 'a'.repeat(60) },
    { day: '2026-08-02', text: 'b'.repeat(60) },
    { day: '2026-08-03', text: 'c'.repeat(60) },
  ]
  const batches = pack(files, 130)
  assert.equal(batches.length, 2)
  assert.equal(batches[0].lastDay, '2026-08-02')
  assert.equal(batches[1].lastDay, '2026-08-03')
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
