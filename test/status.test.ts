import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/commands/mcp.js'
import { sync } from '../src/commands/sync.js'
import { workAdd, workLabel, workMove } from '../src/commands/work.js'
import { resolveContext } from '../src/context.js'
import { readStatusParts, renderOutstanding, STATUS_FILE, statusSummaryInput, statusView, writeStatus } from '../src/status.js'
import { ACME, captureConsole, makeContextRepo } from './helpers.js'

const REQUESTS = `# Derived
- id: req-0001
  request: Black Friday landing page
  requested_by: Priya Patel (client)
  date: 2026-09-01
  status: open
- id: req-0002
  request: CAD pricing
  requested_by: Priya Patel (client)
  date: 2026-09-10
  status: in_progress
- id: req-0003
  request: Old thing
  date: 2026-07-01
  status: stale
- id: req-0004
  request: Shipped thing
  date: 2026-08-01
  status: done
`
const ROADMAP = `# Derived
- id: rm-0001
  item: Launch campaign
  priority: P2
  status: planned
- id: rm-0002
  item: Checkout revamp
  priority: P1
  status: in_progress
- id: rm-0003
  item: Done work
  priority: P1
  status: done
`

async function fixture() {
  const root = makeContextRepo({ 'context/derived/requests.yaml': REQUESTS, 'context/derived/roadmap.yaml': ROADMAP })
  const o = (at: string) => ({ context: root, at })
  await captureConsole(async () => {
    await workAdd(root, { title: 'Stripe webhooks', priority: 'P1', assignee: 'cory' }, o('2026-09-20T10:00:00.000Z'))
    await workAdd(root, { title: 'Welcome email' }, o('2026-09-20T10:01:00.000Z'))
    await workAdd(root, { title: 'Apple Pay' }, o('2026-09-20T10:02:00.000Z'))
    await workAdd(root, { title: 'Old launch' }, o('2026-09-20T10:03:00.000Z'))
    await workMove(root, 'ACM-1', 'in_progress', { reason: 'Cory started' }, o('2026-09-21T09:00:00.000Z'))
    await workMove(root, 'ACM-3', 'blocked', { reason: 'waiting on Priya for the Apple merchant ID' }, o('2026-09-21T09:05:00.000Z'))
    await workMove(root, 'ACM-4', 'done', { reason: 'shipped' }, o('2026-09-21T09:10:00.000Z'))
    await workLabel(root, ['ACM-1'], { add: ['stripe integration'] }, { reason: 'theme' }, o('2026-09-21T09:15:00.000Z'))
  })
  // ACM-2 tracks req-0001, so that request is not listed again as untracked.
  const file = join(root, 'context/work/lore/ACM.yaml')
  writeFileSync(file, readFileSync(file, 'utf8').replace('title: Welcome email\n', 'title: Welcome email\n  request: req-0001\n'))
  return root
}

test('status: the outstanding list — tickets by status in rank order, untracked open requests, unfinished roadmap by priority', async () => {
  const root = await fixture()
  const list = renderOutstanding(root, ACME)
  assert.equal(
    list,
    [
      '3 open tickets (1 blocked, 1 in progress, 1 to do) · 1 untracked request · 2 roadmap items not done',
      '',
      '## Blocked (1)',
      '- **ACM-3** Apple Pay — waiting on Priya for the Apple merchant ID',
      '',
      '## In progress (1)',
      '- **ACM-1** Stripe webhooks · P1 · @cory · #stripe integration',
      '',
      '## To do (1)',
      '- **ACM-2** Welcome email',
      '',
      '## Requests not yet ticketed (1)',
      '- req-0002 CAD pricing — Priya Patel (client), 2026-09-10 (in progress)',
      '',
      '## Roadmap not done (2)',
      '- rm-0002 Checkout revamp (P1, in_progress)',
      '- rm-0001 Launch campaign (P2, planned)',
      '',
      '_1 stale request (no activity in ~30 days) not listed._',
    ].join('\n'),
  )
})

test('status: long sections are capped with a pointer to the full table; long text is cut to one line', async () => {
  const root = makeContextRepo()
  await captureConsole(async () => {
    for (let i = 1; i <= 30; i++) await workAdd(root, { title: i === 1 ? `A very long title ${'x'.repeat(200)}` : `Ticket ${i}` }, { context: root })
  })
  const list = renderOutstanding(root, ACME)
  assert.match(list, /^## To do \(30\)$/m)
  assert.match(list, /^- …and 5 more \(lore_recall category work\)$/m)
  assert.match(list, /^- \*\*ACM-1\*\* A very long title x+…$/m)
  assert.ok(list.split('\n').every((l) => l.length < 200))
})

test('status: writeStatus keeps the summary across list rewrites and is byte-stable when nothing changed', async () => {
  const root = await fixture()
  writeStatus(root, ACME, { summary: 'Stripe webhooks in progress (Cory). Apple Pay blocked on Priya.', summaryAt: '2026-09-21T09:30:00.000Z' })
  const first = readFileSync(join(root, STATUS_FILE), 'utf8')
  assert.match(first, /^# acme — status\n/)
  assert.deepEqual(readStatusParts(root), { summary: 'Stripe webhooks in progress (Cory). Apple Pay blocked on Priya.', summaryAt: '2026-09-21T09:30:00.000Z' })
  writeStatus(root, ACME)
  assert.equal(readFileSync(join(root, STATUS_FILE), 'utf8'), first, 'no render timestamp: a quiet run is not a diff')

  await captureConsole(() => workMove(root, 'ACM-2', 'in_progress', { reason: 'started' }, { context: root, at: '2026-09-22T08:00:00.000Z' }))
  writeStatus(root, ACME)
  const second = readFileSync(join(root, STATUS_FILE), 'utf8')
  assert.match(second, /Apple Pay blocked on Priya\./, 'summary survives')
  assert.match(second, /^## In progress \(2\)$/m, 'list follows the tracker')
})

test('status: the view flags what moved after the summary, renders the list live, and states freshness', async () => {
  const root = await fixture()
  writeStatus(root, ACME, { summary: 'Apple Pay blocked on Priya.', summaryAt: '2026-09-21T09:30:00.000Z' })
  await captureConsole(() => workMove(root, 'ACM-3', 'in_progress', { reason: 'Priya sent the merchant ID' }, { context: root, at: '2026-09-22T08:00:00.000Z' }))
  const view = statusView(root, ACME, new Date('2026-09-22T09:00:00.000Z'))
  assert.match(view, /^Apple Pay blocked on Priya\.\n\n_Summary written 24 h ago \(2026-09-21 09:30 UTC\)\._$/m)
  assert.match(view, /^## Since the summary \(1\)\n- 2026-09-22 08:00 \*\*ACM-3\*\* status blocked → in_progress — Priya sent the merchant ID \(cli, /m)
  assert.match(view, /^## In progress \(2\)$/m, 'live, not the file')
  assert.doesNotMatch(view, /^## Blocked/m)
  assert.match(view, /_Synced never\._$/)

  const bare = makeContextRepo()
  assert.match(statusView(bare, ACME), /_No summary yet — the list below is current\._/)
})

test('status: the summary prompt carries the previous summary, tracker moves since it, and the fold changes', async () => {
  const root = await fixture()
  writeStatus(root, ACME, { summary: 'Earlier summary.', summaryAt: '2026-09-21T00:00:00.000Z' })
  const input = statusSummaryInput(root, ACME, '2026-09-22', ['requests: {"id":"req-0005"}'])
  assert.match(input, /# Previous summary \(2026-09-21T00:00:00.000Z\)\nEarlier summary\./)
  assert.match(input, /# Tracker moves since 2026-09-21\n[\s\S]*ACM-3 \(Apple Pay\): status todo → blocked/)
  assert.match(input, /# What this fold changed\nrequests: \{"id":"req-0005"\}/)
  assert.match(input, /# Outstanding now\n3 open tickets/)
})

test('status: sync rewrites the list after mirroring, so a tracker move lands with the sync commit', async () => {
  const table = `- number: 40
  type: issue
  title: Checkout shows USD
  state: open
  labels: []
  assignees: []
  author: priya
  created_at: 2026-08-04T09:00:00Z
  updated_at: 2026-08-20T19:12:00Z
  url: https://github.com/acme/web/issues/40
`
  const root = makeContextRepo({ 'context/work/github/acme__web.yaml': table }, { project: 'acme', sources: {}, backfill: { months: 1 } })
  await captureConsole(() => sync(root, {}))
  assert.match(readFileSync(join(root, STATUS_FILE), 'utf8'), /^- \*\*ACM-1\*\* Checkout shows USD · github #40$/m)
})

test('status: lore_status returns the view over MCP', async () => {
  const root = await fixture()
  const server = createServer(resolveContext(root, { context: root }), { cwd: root, opts: { context: root } })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientT)
  const res = await client.callTool({ name: 'lore_status', arguments: {} })
  const text = (res.content as { text: string }[])[0].text
  assert.match(text, /^# acme — status/)
  assert.match(text, /^## Blocked \(1\)$/m)
  await Promise.all([client.close(), server.close()])
})
