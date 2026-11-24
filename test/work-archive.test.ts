import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workAdd, workArchive, workList, workMove, workUnarchive } from '../src/commands/work.js'
import { canonicalLabel } from '../src/work.js'
import { captureConsole, makeContextRepo } from './helpers.js'

async function fixture() {
  const root = makeContextRepo({})
  const o = (at: string) => ({ context: root, at })
  await captureConsole(async () => {
    await workAdd(root, { title: 'Imported one', external: 'linear:OLD-1' }, o('2026-09-20T10:00:00.000Z'))
    await workAdd(root, { title: 'Imported two', external: 'linear:OLD-2' }, o('2026-09-20T10:01:00.000Z'))
    await workAdd(root, { title: 'Imported and shipped', external: 'linear:OLD-3' }, o('2026-09-20T10:02:00.000Z'))
    await workAdd(root, { title: 'Born here' }, o('2026-09-20T10:03:00.000Z'))
    await workMove(root, 'ACM-2', 'blocked', { reason: 'waiting' }, o('2026-09-21T09:00:00.000Z'))
    await workMove(root, 'ACM-3', 'done', { reason: 'shipped' }, o('2026-09-21T09:05:00.000Z'))
  })
  return { root, o }
}

const statuses = (root: string) => Object.fromEntries(workList(root, { context: root, all: true, json: true }).map((i) => [i.key, i.status]))

test('work archive: a filter covers open tickets of that origin only, and unarchive puts each back where it was', async () => {
  const { root, o } = await fixture()
  await captureConsole(async () => {
    const dry = await workArchive(root, [], { origin: 'linear' }, { reason: 'fresh start' }, { ...o('2026-09-22T09:00:00.000Z'), dryRun: true })
    assert.deepEqual(dry.changed.map((c) => c.key), ['ACM-1', 'ACM-2'])
    assert.equal(statuses(root)['ACM-1'], 'todo', 'a dry run writes nothing')

    const res = await workArchive(root, [], { origin: 'linear' }, { reason: 'fresh start' }, o('2026-09-22T09:00:00.000Z'))
    assert.deepEqual(res.changed.map((c) => [c.key, c.from]), [['ACM-1', 'todo'], ['ACM-2', 'blocked']])
    assert.deepEqual(statuses(root), { 'ACM-1': 'archived', 'ACM-2': 'archived', 'ACM-3': 'done', 'ACM-4': 'todo' })

    const back = await workUnarchive(root, [], { origin: 'linear' }, { reason: 'changed our minds' }, o('2026-09-23T09:00:00.000Z'))
    assert.deepEqual(back.changed.map((c) => [c.key, c.to]), [['ACM-1', 'todo'], ['ACM-2', 'blocked']])
    assert.deepEqual(statuses(root), { 'ACM-1': 'todo', 'ACM-2': 'blocked', 'ACM-3': 'done', 'ACM-4': 'todo' })
  })
})

test('work archive: keys archive exactly those tickets; a missing key or no selection changes nothing', async () => {
  const { root, o } = await fixture()
  await captureConsole(async () => {
    await assert.rejects(workArchive(root, [], {}, { reason: 'x' }, o('2026-09-22T09:00:00.000Z')), /give ticket keys, or a filter/)
    await assert.rejects(workArchive(root, ['ACM-4', 'ACM-99'], {}, { reason: 'x' }, o('2026-09-22T09:00:00.000Z')), /no item ACM-99/)
    assert.equal(statuses(root)['ACM-4'], 'todo')
    await workArchive(root, ['acm-3', 'ACM-4'], {}, { reason: 'tidy' }, o('2026-09-22T09:00:00.000Z'))
    assert.deepEqual(statuses(root), { 'ACM-1': 'todo', 'ACM-2': 'blocked', 'ACM-3': 'archived', 'ACM-4': 'archived' })
    await workUnarchive(root, ['ACM-3'], {}, { reason: 'back', to: 'review' }, o('2026-09-23T09:00:00.000Z'))
    assert.equal(statuses(root)['ACM-3'], 'review')
  })
})

test('labels: live tickets set the spelling of a label; an archived spelling only counts when nothing live uses it', () => {
  const items = [
    { labels: ['Admin Panel'], status: 'archived' as const },
    { labels: ['admin panel', 'Old Theme'], status: 'todo' as const },
    { labels: ['Legacy Only'], status: 'archived' as const },
  ]
  assert.equal(canonicalLabel(items, 'ADMIN  panel'), 'admin panel')
  assert.equal(canonicalLabel(items, 'legacy only'), 'Legacy Only')
  assert.equal(canonicalLabel(items, ' brand  new '), 'brand new')
})
