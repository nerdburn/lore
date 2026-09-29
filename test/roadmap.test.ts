import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { recall } from '../src/commands/recall.js'
import { createServer } from '../src/commands/mcp.js'
import { resolveContext } from '../src/context.js'
import { recallData } from '../src/recall.js'
import { renderOutstanding } from '../src/status.js'
import { ACME, captureConsole, makeContextRepo } from './helpers.js'

const roadmap = `
- id: road-1
  kind: goal
  item: Make paid onboarding reliable before expanding acquisition
  horizon: short_term
  why: Customers must be able to complete a purchase
  success: New customers can reach their purchased agreement
  priority: P1
  priority_reason: Resolve payment blockers before cosmetic changes
  status: in_progress
  work_items: [ACM-1, ACM-999]
  source: https://example.com/decision
- id: road-2
  kind: goal
  item: Expand access across provinces
  horizon: long_term
  status: planned
  priority: P2
- id: road-3
  kind: goal
  item: Improve support capacity
  status: planned
- id: road-4
  item: Change a button colour
  status: planned
- id: road-5
  kind: work
  item: Build a modal
  status: in_progress
`

function fixture() {
  return makeContextRepo({
    'context/derived/roadmap.yaml': roadmap,
    'context/work/lore/ACM.yaml': `
- key: ACM-1
  title: Fix payment retries
  status: done
  state: closed
  labels: []
  sources: []
  history: []
`,
  })
}

test('roadmap recall explains goals, horizons and priority implications using live Lore descriptions', () => {
  const r = recallData(fixture(), ACME, 'roadmap')
  const text = r.roadmap!.text
  assert.match(text, /Short-term goals[\s\S]*Make paid onboarding reliable/)
  assert.match(text, /Why it matters: Customers must/)
  assert.match(text, /Success means: New customers/)
  assert.match(text, /work priorities: Resolve payment blockers before cosmetic changes/)
  assert.match(text, /Fix payment retries \[ACM-1\] \(done\)/)
  assert.match(text, /In progress; high priority/, 'closing linked work does not achieve the goal')
  assert.match(text, /Long-term goals[\s\S]*Expand access across provinces/)
  assert.match(text, /timing not yet established[\s\S]*Improve support capacity/)
  assert.match(text, /1 earlier roadmap entry still needs review/)
  assert.doesNotMatch(text, /ACM-999|road-1|Build a modal|Change a button colour/)
  assert.equal((r.derived.roadmap as unknown[]).length, 5, 'legacy data remains available')
  assert.deepEqual(r.work, {}, 'goal queries do not dump the backlog')
  assert.equal(recallData(fixture(), ACME, 'work').roadmap, undefined)
})

test('roadmap CLI and MCP return English; CLI JSON preserves structured access', async () => {
  const root = fixture()
  const output = await captureConsole(() => recall(root, 'roadmap', { context: root }))
  assert.match(output.out, /Short-term goals/)
  assert.match(output.out, /Sources last synced: never/)
  assert.doesNotMatch(output.out, /"kind"|"work_items"/)
  const json = await captureConsole(() => recall(root, 'roadmap', { context: root, json: true }))
  assert.equal(JSON.parse(json.out).derived.roadmap.length, 5)
  const server = createServer(resolveContext(root), { cwd: root, opts: { context: root } })
  const client = new Client({ name: 'roadmap-test', version: '1' })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  await client.connect(clientT)
  try {
    const result = await client.callTool({ name: 'lore_recall', arguments: { category: 'roadmap' } })
    const text = (result.content as { text: string }[])[0].text
    assert.equal(text, output.out)
  } finally { await Promise.all([client.close(), server.close()]) }
})

test('status counts goals separately from old task-shaped roadmap entries', () => {
  const text = renderOutstanding(fixture(), ACME)
  assert.match(text, /3 active roadmap goals/)
  assert.match(text, /Resolve payment blockers before cosmetic changes/)
  assert.doesNotMatch(text, /Build a modal|Change a button colour/)
})
