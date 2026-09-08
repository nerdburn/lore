import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recall } from '../src/commands/recall.js'
import { isEmpty, recallData } from '../src/recall.js'
import { ACME, captureConsole, fullFixtureRepo, makeContextRepo } from './helpers.js'

test('recall: with no category returns pins, every derived artifact, reports, freshness', () => {
  const root = fullFixtureRepo()
  const r = recallData(root, ACME)
  assert.equal(r.project, 'acme')
  assert.equal(r.lifecycle, 'active')
  assert.equal(r.archived_at, undefined)
  assert.deepEqual(r.synced, { lastSync: '2026-08-14T06:23:00.000Z', lastExtract: '2026-08-14T06:30:00.000Z' })
  assert.deepEqual(r.pins.map((p) => p.id), ['pin-0001', 'pin-0002'])
  assert.deepEqual(Object.keys(r.derived), ['decisions', 'requests', 'roadmap'])
  assert.equal((r.derived.requests as { id: string }[])[0].id, 'req-0001')
  assert.deepEqual(r.reports.map((x) => x.date), ['2026-08-14', '2026-08-07'], 'newest first')
  assert.match(r.reports[0].text, /week 2/)
})

test('recall: category filters pins, derived and reports consistently', () => {
  const root = fullFixtureRepo()
  const requests = recallData(root, ACME, 'requests')
  assert.deepEqual(requests.pins, [])
  assert.deepEqual(Object.keys(requests.derived), ['requests'])
  assert.deepEqual(requests.reports, [])

  const decisions = recallData(root, ACME, 'decisions')
  assert.deepEqual(Object.keys(decisions.derived), ['decisions'])

  const deployment = recallData(root, ACME, 'deployment')
  assert.deepEqual(deployment.pins.map((p) => p.id), ['pin-0001'])
  assert.deepEqual(deployment.derived, {})

  const reports = recallData(root, ACME, 'reports')
  assert.equal(reports.reports.length, 2)
  assert.deepEqual(reports.derived, {})

  assert.ok(isEmpty(recallData(root, ACME, 'nonexistent')))
})

test('recall: reportLimit caps the reports returned', () => {
  const root = fullFixtureRepo()
  assert.equal(recallData(root, ACME, undefined, { reportLimit: 1 }).reports.length, 1)
})

test('recall: an empty repo recalls nothing without throwing', () => {
  const root = makeContextRepo()
  const r = recallData(root, ACME)
  assert.ok(isEmpty(r))
  assert.deepEqual(r.synced, {})
})

test('recall CLI: --json output is exactly recallData', async () => {
  const root = fullFixtureRepo()
  const { out } = await captureConsole(() => recall(root, undefined, { context: root, json: true }))
  assert.deepEqual(JSON.parse(out), recallData(root, ACME))
})

test('recall CLI: human output lists pins, derived sections and reports', async () => {
  const root = fullFixtureRepo()
  const { out, err } = await captureConsole(() => recall(root, undefined, { context: root }))
  assert.match(out, /\[deployment\] Deploys are manual/)
  assert.match(out, /## requests/)
  assert.match(out, /## report 2026-08-14/)
  assert.match(err, /synced 2026-08-14/)
  const none = await captureConsole(() => recall(root, 'nothing-here', { context: root }))
  assert.match(none.out, /nothing recalled for category "nothing-here"/)
})
