import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { hasDoc, writeDocs } from '../src/streams.js'
import type { Doc } from '../src/types.js'
import { makeContextRepo } from './helpers.js'

const doc = (over: Partial<Doc> = {}): Doc => ({
  id: 'slack-C1-1754229720.000100',
  source: 'slack',
  channel: '#acme',
  author: 'Priya',
  timestamp: '2026-08-03T14:02:00.000Z',
  permalink: 'https://slack.com/archives/C1/p1754229720000100',
  meta: { team: 'T1', channel: 'C1', user: 'U1' },
  text: 'Can we ship before Black Friday?',
  ...over,
})

test('streams: writes a day file with frontmatter, heading, id comment, permalink', () => {
  const root = makeContextRepo()
  const r = writeDocs(root, [doc()])
  assert.deepEqual(r, { written: 1, skipped: 0, redacted: {} })
  const path = join(root, 'context/streams/slack/#acme/2026-08-03.md')
  const text = readFileSync(path, 'utf8')
  assert.ok(text.startsWith('---\nsource: slack\nchannel: "#acme"\ndate: 2026-08-03\n---\n'))
  assert.ok(text.includes('### Priya — 2026-08-03T14:02:00.000Z'))
  assert.ok(text.includes('<!-- id: slack-C1-1754229720.000100 team: T1 channel: C1 user: U1 -->'))
  assert.ok(text.includes('[permalink](https://slack.com/archives/C1/p1754229720000100)'))
  assert.ok(text.includes('\nCan we ship before Black Friday?\n'))
})

test('streams: re-writing the same doc is skipped (idempotent), new ones append', () => {
  const root = makeContextRepo()
  writeDocs(root, [doc()])
  const r = writeDocs(root, [doc(), doc({ id: 'slack-C1-1754229721.000200', text: 'second' })])
  assert.equal(r.skipped, 1)
  assert.equal(r.written, 1)
  const text = readFileSync(join(root, 'context/streams/slack/#acme/2026-08-03.md'), 'utf8')
  assert.equal(text.split('<!-- id:').length - 1, 2)
})

test('streams: dedup matches the whole id, not a prefix', () => {
  const file = '<!-- id: slack-C1-1754229720.0001 team: T1 -->\n<!-- id: slack-C1-1754229720.000100 -->'
  assert.ok(hasDoc(file, 'slack-C1-1754229720.0001'))
  assert.ok(hasDoc(file, 'slack-C1-1754229720.000100'))
  assert.ok(!hasDoc(file, 'slack-C1-1754229720.00'))
  assert.ok(!hasDoc(file, 'slack-C1-1754229720'))
})

test('streams: thread ids go in the comment; meta values with whitespace are dropped', () => {
  const root = makeContextRepo()
  writeDocs(root, [doc({ thread: '1754229720.000100', meta: { user: 'U1', bad: 'has space' } })])
  const text = readFileSync(join(root, 'context/streams/slack/#acme/2026-08-03.md'), 'utf8')
  assert.ok(text.includes('<!-- id: slack-C1-1754229720.000100 thread: 1754229720.000100 user: U1 -->'))
})

test('streams: channel names are sanitised into directory names', () => {
  const root = makeContextRepo()
  writeDocs(root, [doc({ channel: 'linear/acme project' })])
  assert.ok(existsSync(join(root, 'context/streams/slack/linear_acme_project/2026-08-03.md')))
})

test('streams: docs are written in timestamp order across days', () => {
  const root = makeContextRepo()
  writeDocs(root, [
    doc({ id: 'b', timestamp: '2026-08-04T10:00:00.000Z', text: 'later' }),
    doc({ id: 'a', timestamp: '2026-08-03T10:00:00.000Z', text: 'earlier' }),
    doc({ id: 'c', timestamp: '2026-08-03T09:00:00.000Z', text: 'earliest' }),
  ])
  const day3 = readFileSync(join(root, 'context/streams/slack/#acme/2026-08-03.md'), 'utf8')
  assert.ok(day3.indexOf('earliest') < day3.indexOf('earlier'))
  assert.ok(existsSync(join(root, 'context/streams/slack/#acme/2026-08-04.md')))
})

test('streams: secrets never reach the stream file', () => {
  const root = makeContextRepo()
  const token = ['xoxb-', '1234567890-1234567890123-', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('')
  const r = writeDocs(root, [doc({ text: `use ${token} for the bot, password: Hunter2Hunter2` })])
  assert.deepEqual(r.redacted, { 'slack-token': 1, secret: 1 })
  const text = readFileSync(join(root, 'context/streams/slack/#acme/2026-08-03.md'), 'utf8')
  assert.ok(!text.includes(token))
  assert.ok(!text.includes('Hunter2Hunter2'))
  assert.ok(text.includes('[redacted:slack-token]'))
})
