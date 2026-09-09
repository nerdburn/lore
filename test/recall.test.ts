import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recall } from '../src/commands/recall.js'
import { resolveContext } from '../src/context.js'
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

test('recall: work tables are summarised — open items in full, the rest as counts, with the file to read', () => {
  const root = makeContextRepo({
    'context/work/github/acme__web.yaml': `# Source-owned by GitHub
- number: 3
  type: pr
  title: Open PR
  state: open
  merged: false
- number: 2
  type: pr
  title: Merged PR
  state: closed
  merged: true
- number: 1
  type: issue
  title: Closed issue
  state: closed
`,
  })
  const r = recallData(root, ACME)
  const w = r.work['github/acme__web']
  assert.equal(w.file, 'context/work/github/acme__web.yaml')
  assert.deepEqual(w.counts, { open: 1, closed: 1, merged: 1 })
  assert.deepEqual(w.open.map((i) => (i as { number: number }).number), [3])
  assert.deepEqual(Object.keys(recallData(root, ACME, 'work').work), ['github/acme__web'])
  assert.deepEqual(recallData(root, ACME, 'requests').work, {})
})

test('recall: carries the client block when configured', () => {
  const root = makeContextRepo({}, { project: 'x', client: { name: 'Acme', domains: ['acme.com'], contacts: [] } })
  const r = recallData(root, resolveContext(root).config)
  assert.equal(r.client?.name, 'Acme')
  assert.deepEqual(r.client?.domains, ['acme.com'])
  assert.equal(recallData(root, ACME).client, undefined)
})
