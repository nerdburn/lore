import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { readAudit } from '../src/audit.js'
import { remember } from '../src/commands/remember.js'
import type { Pin } from '../src/types.js'
import { captureConsole, FIXTURE_FACTS, makeContextRepo } from './helpers.js'

test('remember: appends a pin with the OS user by default and audits it', async () => {
  const root = makeContextRepo()
  const { result: pin, out } = await captureConsole(() => remember(root, 'Client prefers Tuesday demos', { context: root, category: 'client' }))
  assert.equal(pin.id, 'pin-0001')
  assert.equal(pin.authorized_by, userInfo().username)
  assert.match(out, /pinned pin-0001/)
  const pins = parse(readFileSync(join(root, 'context/facts.yaml'), 'utf8')) as Pin[]
  assert.deepEqual(pins.map((p) => [p.id, p.fact, p.category]), [['pin-0001', 'Client prefers Tuesday demos', 'client']])
  const audit = readAudit(root)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].via, 'cli')
  assert.equal(audit[0].actor, userInfo().username)
})

test('remember: --by names the authorizer on the CLI, and category defaults to general', async () => {
  const root = makeContextRepo()
  const { result } = await captureConsole(() => remember(root, 'x', { context: root, by: 'priya' }))
  assert.equal(result.authorized_by, 'priya')
  assert.equal(result.category, 'general')
  assert.equal(readAudit(root)[0].actor, 'priya')
})

test('remember: ids continue from the highest existing pin, never reuse', async () => {
  const root = makeContextRepo({ 'context/facts.yaml': FIXTURE_FACTS.replace(/- id: pin-0001[\s\S]*?date: 2026-08-04\n/, '') })
  const { result } = await captureConsole(() => remember(root, 'third', { context: root }))
  assert.equal(result.id, 'pin-0003')
})

test('remember: write.allow gates by actor', async () => {
  const root = makeContextRepo({}, { project: 'acme', write: { allow: ['priya'] } })
  await assert.rejects(
    captureConsole(() => remember(root, 'x', { context: root })),
    /not in lore.json write.allow/,
  )
  const { result } = await captureConsole(() => remember(root, 'x', { context: root, by: 'priya' }))
  assert.equal(result.authorized_by, 'priya')
})

test('remember: the source link is kept on the pin and the audit entry', async () => {
  const root = makeContextRepo()
  const { result } = await captureConsole(() => remember(root, 'x', { context: root, source: 'https://slack.com/p1' }))
  assert.equal(result.source, 'https://slack.com/p1')
  assert.equal(readAudit(root)[0].source, 'https://slack.com/p1')
})
