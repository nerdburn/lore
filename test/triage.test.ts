import assert from 'node:assert/strict'
import { test } from 'node:test'
import { triageRequest } from '../src/triage.js'
import { parseWorkItems } from '../src/work.js'
import type { RoadmapGoal } from '../src/roadmap.js'

const goals: RoadmapGoal[] = [
  { id: 'one', item: 'Improve checkout completion', kind: 'goal', status: 'in_progress' },
  { id: 'two', item: 'Increase renewals', kind: 'goal', status: 'planned' },
  { id: 'old', item: 'Grow referrals', kind: 'goal', status: 'done' },
  { id: 'legacy', item: 'Build a new banner', status: 'planned' },
]
const work = parseWorkItems(`
- { key: ACM-1, title: Build receipts, status: todo, claim: {holder: athena, since: now, renewed: now} }
- { key: ACM-2, title: Update billing, status: review }
- { key: ACM-3, title: Fix layout, status: todo }
`)

test('Jev scores direct fit independently of the queue, and only against active goals', async () => {
  let sent: any
  const result = await triageRequest('Show alternate payment methods', goals, work, { apiKey: 'fixture', fetch: async (_, opts) => {
    const call = JSON.parse(String(opts?.body))
    if (call.state.goals) sent = call
    return Response.json({ answers: { goal_0: { noul: 0.96 }, goal_1: { noul: 0.32 } } })
  } })
  assert.equal(sent.state.goals.length, 2)
  assert.deepEqual(Object.keys(sent.questions), ['goal_0', 'goal_1'])
  assert.equal(result.disposition, 'intake')
  assert.deepEqual(result.suggested_goals.map(g => g.id), ['one'])
  assert.deepEqual(result.in_flight.map(i => i.key), ['ACM-1', 'ACM-2'])
  assert.deepEqual(result.next_queued.map(i => i.key), ['ACM-3'])
})

test('triage remains usable with missing goals, missing credentials or incomplete model output', async () => {
  assert.equal((await triageRequest('Export orders', [], work)).classification, 'no_active_goals')
  for (const opts of [{}, { apiKey: 'fixture', fetch: async () => Response.json({ answers: {} }) }]) {
    const result = await triageRequest('Export orders', goals, work, opts)
    assert.equal(result.classification, 'needs_review')
    assert.deepEqual(result.active_goals?.map(g => g.id), ['one', 'two'])
    assert.deepEqual(result.suggested_goals, [])
    assert.equal(result.disposition, 'intake')
  }
})
