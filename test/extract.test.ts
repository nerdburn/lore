import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptFold, cliModelAlias, pack, parseFoldOutput, pickModel, reportExcerpt, streamFiles, withRetry } from '../src/commands/extract.js'
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

test('extract: pack splits a single oversized file at paragraph breaks, restating the heading, and records it only with its last part', () => {
  const header = '### Julie — 2026-09-14T00:00:00.000Z\n<!-- id: doc-abc-123 title: spec -->\n[permalink](https://docs.google.com/document/d/abc)\n'
  const body = Array.from({ length: 12 }, (_, i) => `para ${i} ${'x'.repeat(40)}`).join('\n\n')
  const text = `${header}\n# Spec\n\n${body}`
  const batches = pack([{ path: 'context/streams/docs/spec/2026-09-14.md', day: '2026-09-14', text }, { path: 'b.md', day: '2026-09-15', text: 'small' }], 260)
  assert.ok(batches.length >= 3, `expected the big file in several parts, got ${batches.length}`)
  const parts = batches.slice(0, -1)
  assert.ok(parts.every((b) => b.text.length <= 260 + header.length + 40 && b.lastDay === '2026-09-14'))
  assert.deepEqual(parts.slice(0, -1).flatMap((b) => b.files), [], 'earlier parts do not mark the file consumed')
  assert.deepEqual(parts.at(-1)!.files, [{ path: 'context/streams/docs/spec/2026-09-14.md', length: text.length }])
  assert.ok(parts.slice(1).every((b) => b.text.startsWith(header.trimEnd() + '\n\n(…continued)')), 'continuations carry the heading and permalink')
  assert.equal(parts.map((b) => b.text.replace(/^### [\s\S]*?\(…continued\)\n\n/, '')).join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''), 'nothing is lost')
  assert.deepEqual(batches.at(-1)!.files, [{ path: 'b.md', length: 5 }])
  // A file that fits is never split.
  assert.equal(pack([{ day: '2026-08-01', text: 'x'.repeat(100) }], 100).length, 1)
})

test('extract: the weekly report excerpts long documents but never other streams', () => {
  const doc = { path: 'context/streams/docs/spec/2026-09-14.md', day: '2026-09-14', text: 'd'.repeat(50) }
  assert.match(reportExcerpt(doc, 20), /^d{20}\n\n\[… document truncated for the report: 30 more characters in context\/streams\/docs\/spec\/2026-09-14\.md\]$/)
  assert.equal(reportExcerpt({ ...doc, text: 'short' }, 20), 'short')
  const mail = { path: 'context/streams/gmail/x/2026-09-14.md', day: '2026-09-14', text: 'm'.repeat(50) }
  assert.equal(reportExcerpt(mail, 20), mail.text)
})

test('extract: acceptFold applies a delta — omitted items are kept silently, returned ids update, new ids append', () => {
  const prev = [{ id: 'dec-0001', decision: 'a' }, { id: 'dec-0002', decision: 'b' }]
  const empty = acceptFold('decisions', prev, [])
  assert.deepEqual(empty, { items: prev, added: 0, updated: 0 }, 'an empty delta is the normal "nothing new" case, not a defect')

  const partial = acceptFold('decisions', prev, [{ id: 'dec-0002', decision: 'b (updated)' }, { id: 'dec-0003', decision: 'c' }])
  assert.deepEqual(partial.items, [{ id: 'dec-0001', decision: 'a' }, { id: 'dec-0002', decision: 'b (updated)' }, { id: 'dec-0003', decision: 'c' }])
  assert.equal(partial.added, 1)
  assert.equal(partial.updated, 1)
  assert.equal(partial.rejected, undefined)

  const same = acceptFold('decisions', prev, [{ id: 'dec-0001', decision: 'a' }])
  assert.equal(same.updated, 0, 'returning an unchanged item is not counted as an update')
  assert.equal(acceptFold('decisions', prev, undefined).rejected, 'no "decisions" array')
  assert.deepEqual(acceptFold('decisions', prev, undefined).items, prev)
})

test('extract: acceptFold starting from empty takes the proposal as-is; id-less items are appended', () => {
  const proposed = [{ id: 'req-0001', status: 'open' }, { status: 'open', request: 'no id' }]
  assert.deepEqual(acceptFold('requests', [], proposed), { items: proposed, added: 2, updated: 0 })
  assert.deepEqual(acceptFold('requests', [], []), { items: [], added: 0, updated: 0 })
  assert.deepEqual(acceptFold('requests', [{ id: 'req-0001', status: 'open' }], [{ status: 'x' }]).items.length, 2)
})

test('extract: pickModel — one batch onto existing artifacts is incremental, anything else is the full model', () => {
  const env = { LORE_MODEL: 'full-model', LORE_MODEL_INCREMENTAL: 'delta-model' }
  assert.equal(pickModel(1, 120, env), 'delta-model')
  assert.equal(pickModel(1, 0, env), 'full-model', 'a first fold, even if it fits one batch')
  assert.equal(pickModel(24, 120, env), 'full-model', 'a multi-batch re-fold')
  assert.equal(pickModel(1, 120, {}), 'claude-sonnet-5')
  assert.equal(pickModel(3, 0, {}), 'claude-opus-4-8')
  assert.equal(pickModel(1, 5, { LORE_MODEL: 'x', LORE_MODEL_INCREMENTAL: 'x' }), 'x', 'same id on both sides opts out')
  assert.equal(pickModel(1, 120, env, 40_000), 'delta-model', 'an hourly trickle stays incremental')
  assert.equal(pickModel(1, 120, env, 219_000), 'full-model', 'a new source backfilled into one batch is not a delta — the full model reads it')
  assert.equal(cliModelAlias('claude-sonnet-5'), 'sonnet')
  assert.equal(cliModelAlias('claude-opus-4-8'), 'opus')
  assert.equal(cliModelAlias('claude-haiku-4-5'), 'haiku')
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
