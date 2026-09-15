import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readAudit } from '../src/audit.js'
import { createServer } from '../src/commands/mcp.js'
import { sync } from '../src/commands/sync.js'
import { workAdd, workList, workMove, workPromote, workRank, workSet, workShow } from '../src/commands/work.js'
import { resolveContext } from '../src/context.js'
import { recallData } from '../src/recall.js'
import {
  applyFoldChanges,
  applyFoldCreations,
  deriveWorkPrefix,
  mirrorExternal,
  readWorkItems,
  summarizeForRecall,
  titleSimilarity,
  workPrefix,
  writeWorkItems,
  type LoreWorkItem,
} from '../src/work.js'
import { ACME, captureConsole, FIXTURE_REQUESTS, makeContextRepo } from './helpers.js'

const AT = '2026-09-15T10:00:00.000Z'
const me = userInfo().username
const opts = (root: string, at = AT) => ({ context: root, at })

const GITHUB_TABLE = `# Source-owned by GitHub (acme/web)
- number: 42
  type: pr
  title: Black Friday landing page
  state: open
  merged: false
  labels: [launch]
  assignees: [shawn]
  author: shawn
  created_at: 2026-08-20T18:30:00Z
  updated_at: 2026-08-20T18:30:00Z
  url: https://github.com/acme/web/pull/42
- number: 40
  type: issue
  title: Checkout shows USD to Canadian visitors
  state: open
  labels: [bug, P1]
  assignees: [mara]
  author: priya
  created_at: 2026-08-04T09:00:00Z
  updated_at: 2026-08-20T19:12:00Z
  url: https://github.com/acme/web/issues/40
- number: 39
  type: issue
  title: Old closed thing
  state: closed
  labels: []
  assignees: []
  author: priya
  created_at: 2026-07-04T09:00:00Z
  updated_at: 2026-07-20T19:12:00Z
  closed_at: 2026-07-20T19:12:00Z
  url: https://github.com/acme/web/issues/39
`

const jiraTable = (status: string, category: string) => `# Source-owned by Jira (ACM)
- key: ACM-7
  type: Story
  title: Agreement builder v2
  status: ${status}
  category: ${category}
  state: ${category === 'Done' ? 'closed' : 'open'}
  priority: High
  assignee: Cory
  labels: []
  fix_versions: []
  created: 2026-09-01T09:00:00Z
  updated: 2026-09-10T09:00:00Z
  url: https://acme.atlassian.net/browse/ACM-7
`

test('work: prefix derives from the client name, or the project, unless configured', () => {
  assert.equal(deriveWorkPrefix('CareMobi'), 'CAR')
  assert.equal(deriveWorkPrefix('Coffee Contracts'), 'CC')
  assert.equal(deriveWorkPrefix('Jointly'), 'JOI')
  assert.equal(deriveWorkPrefix('x'), 'XL')
  assert.equal(deriveWorkPrefix('3rd Wave Coffee'), 'WC')
  assert.equal(workPrefix({ project: 'acme' }), 'ACM')
  assert.equal(workPrefix({ project: 'acme', client: { name: 'Acme Widgets', domains: [], contacts: [] } }), 'AW')
  assert.equal(workPrefix({ project: 'acme', client: { name: 'Acme Widgets', domains: [], contacts: [] }, work: { prefix: 'ACME' } }), 'ACME')
})

test('work add: keys count up per prefix, history records who and why, audit line written, keys never reused', async () => {
  const root = makeContextRepo()
  const { result: a, out } = await captureConsole(() =>
    workAdd(root, { title: 'Onboarding email sequence', priority: 'P2', labels: ['email', ' '], sources: ['https://slack.com/archives/C1/p1'] }, opts(root)),
  )
  assert.equal(a.key, 'ACM-1')
  assert.equal(a.status, 'todo')
  assert.equal(a.state, 'open')
  assert.deepEqual(a.labels, ['email'])
  assert.deepEqual(a.history, [{ at: AT, by: me, via: 'cli', change: { created: true }, reason: 'added', sources: ['https://slack.com/archives/C1/p1'] }])
  assert.match(out, /add ACM-1: Onboarding email sequence/)

  const b = await captureConsole(() => workAdd(root, { title: 'Second', reason: 'client asked in the call' }, opts(root)))
  assert.equal(b.result.key, 'ACM-2')
  assert.equal(b.result.history[0].reason, 'client asked in the call')

  const text = readFileSync(join(root, 'context/work/lore/ACM.yaml'), 'utf8')
  assert.match(text, /^# Lore work tracker \(ACM\)/)
  assert.match(text, /^- key: ACM-1\n  title: Onboarding email sequence\n  status: todo\n  state: open\n  priority: P2/m)

  await captureConsole(() => workMove(root, 'ACM-2', 'archived', { reason: 'duplicate' }, opts(root)))
  const c = await captureConsole(() => workAdd(root, { title: 'Third' }, opts(root)))
  assert.equal(c.result.key, 'ACM-3', 'an archived key is not reused')

  const audit = readAudit(root)
  assert.equal(audit.length, 4)
  assert.deepEqual(audit[0], { at: AT, action: 'work', actor: me, via: 'cli', id: 'ACM-1', source: 'https://slack.com/archives/C1/p1' })
  assert.equal(audit[2].id, 'ACM-2')
})

test('work promote: a derived request becomes a ticket with its evidence; promoting twice is refused', async () => {
  const root = makeContextRepo({ 'context/derived/requests.yaml': FIXTURE_REQUESTS })
  const { result } = await captureConsole(() => workPromote(root, 'req-0001', { priority: 'P1' }, opts(root)))
  assert.equal(result.key, 'ACM-1')
  assert.equal(result.title, 'Black Friday landing page live before Nov 20')
  assert.equal(result.request, 'req-0001')
  assert.equal(result.priority, 'P1')
  assert.deepEqual(result.sources, ['https://slack.com/archives/C0ACME/p1754229720000100'])
  assert.match(result.history[0].reason, /promoted from req-0001 \(asked by Priya, 2026-08-03\)/)
  await assert.rejects(
    captureConsole(() => workPromote(root, 'req-0001', {}, opts(root))),
    /already tracked as ACM-1/,
  )
  await assert.rejects(captureConsole(() => workPromote(root, 'req-0099', {}, opts(root))), /no derived request req-0099/)
})

test('work move / set / rank: every change needs a reason and lands in history; state follows status; rank is file order', async () => {
  const root = makeContextRepo()
  await captureConsole(() => workAdd(root, { title: 'A' }, opts(root)))
  await captureConsole(() => workAdd(root, { title: 'B' }, opts(root)))
  await captureConsole(() => workAdd(root, { title: 'C' }, opts(root)))

  await assert.rejects(captureConsole(() => workMove(root, 'ACM-1', 'done', { reason: '  ' }, opts(root))), /--reason is required/)
  await assert.rejects(captureConsole(() => workMove(root, 'ACM-1', 'finished', { reason: 'x' }, opts(root))), /status must be one of/)
  await assert.rejects(captureConsole(() => workMove(root, 'ACM-9', 'done', { reason: 'x' }, opts(root))), /no item ACM-9/)

  const later = '2026-09-16T09:00:00.000Z'
  const { result: moved, out } = await captureConsole(() =>
    workMove(root, 'acm-1', 'in_progress', { reason: 'Cory started on it', sources: ['https://slack.com/archives/C1/p2'] }, { ...opts(root, later), by: 'shawn' }),
  )
  assert.equal(moved.status, 'in_progress')
  assert.equal(moved.updated, '2026-09-16')
  assert.deepEqual(moved.history[1], { at: later, by: 'shawn', via: 'cli', change: { status: ['todo', 'in_progress'] }, reason: 'Cory started on it', sources: ['https://slack.com/archives/C1/p2'] })
  assert.deepEqual(moved.sources, ['https://slack.com/archives/C1/p2'], 'evidence given with a move is kept on the item')
  assert.match(out, /move ACM-1 todo → in_progress \(Cory started on it\)/)
  await assert.rejects(captureConsole(() => workMove(root, 'ACM-1', 'in_progress', { reason: 'again' }, opts(root))), /already in_progress/)

  const done = await captureConsole(() => workMove(root, 'ACM-3', 'done', { reason: 'shipped' }, opts(root)))
  assert.equal(done.result.state, 'closed')

  const set = await captureConsole(() =>
    workSet(root, 'ACM-2', { priority: 'p1', assignee: 'cory', labels: ['builder'], external: 'jira:acm-7' }, { reason: 'Priya called it urgent' }, opts(root)),
  )
  assert.equal(set.result.priority, 'P1')
  assert.equal(set.result.assignee, 'cory')
  assert.deepEqual(set.result.external, { system: 'jira', id: 'jira:ACM-7', key: 'ACM-7', url: '', status: 'unknown', category: 'unknown' })
  assert.deepEqual(set.result.history[1].change, { external: [null, 'jira:ACM-7'], priority: [null, 'P1'], assignee: [null, 'cory'], labels: [[], ['builder']] })
  await assert.rejects(captureConsole(() => workSet(root, 'ACM-2', { priority: 'P1' }, { reason: 'same' }, opts(root))), /nothing changed/)
  await assert.rejects(captureConsole(() => workSet(root, 'ACM-1', { external: 'jira:ACM-7' }, { reason: 'dup' }, opts(root))), /already linked to ACM-2/)

  const ranked = await captureConsole(() => workRank(root, 'ACM-3', { top: true }, { reason: 'ship first' }, opts(root)))
  assert.deepEqual(ranked.result.history.at(-1)!.change, { rank: [3, 1] })
  assert.deepEqual(readWorkItems(root, 'ACM').map((i) => i.key), ['ACM-3', 'ACM-1', 'ACM-2'])
  await captureConsole(() => workRank(root, 'ACM-2', { above: 'ACM-1' }, { reason: 'urgent' }, opts(root)))
  assert.deepEqual(readWorkItems(root, 'ACM').map((i) => i.key), ['ACM-3', 'ACM-2', 'ACM-1'])
  await assert.rejects(captureConsole(() => workRank(root, 'ACM-3', { top: true }, { reason: 'x' }, opts(root))), /already there/)
  await assert.rejects(captureConsole(() => workRank(root, 'ACM-3', {}, { reason: 'x' }, opts(root))), /--above/)

  const { out: list } = await captureConsole(() => workList(root, { context: root }))
  assert.match(list, /^ACM-2\s+todo\s+P1\s+B\s+@cory\s+\[jira ACM-7: unknown\]$/m)
  assert.doesNotMatch(list, /ACM-3/, 'done items are hidden without --all')
  const { out: all } = await captureConsole(() => workList(root, { context: root, all: true }))
  assert.match(all, /ACM-3\s+done/)
  const { out: show } = await captureConsole(() => workShow(root, 'ACM-1', { context: root }))
  assert.match(show, /status: \['todo', 'in_progress'\]|status: todo → in_progress/)
  assert.match(show, /Cory started on it\s+\[cli: shawn\]/)
})

test('work: writes are refused on archived clients and by write.allow', async () => {
  const archived = makeContextRepo({}, { project: 'acme', lifecycle: 'archived', archived_at: '2026-09-01T00:00:00Z', sources: {}, extract: [] })
  await assert.rejects(captureConsole(() => workAdd(archived, { title: 'x' }, opts(archived))), /archived/)
  const gated = makeContextRepo({}, { project: 'acme', sources: {}, extract: [], write: { allow: ['someone-else'] } })
  await assert.rejects(captureConsole(() => workAdd(gated, { title: 'x' }, opts(gated))), /not in lore.json write.allow — work item change refused/)
})

test('work mirror: open Jira/GitHub issues become lore items; PRs and never-tracked closed issues do not', () => {
  const root = makeContextRepo({
    'context/work/github/acme__web.yaml': GITHUB_TABLE,
    'context/work/jira/ACM.yaml': jiraTable('In Review', 'In Progress'),
  })
  const m = mirrorExternal(root, ACME, AT)
  assert.equal(m.created, 2)
  assert.equal(m.updated, 0)
  assert.equal(m.file, 'context/work/lore/ACM.yaml')
  const items = readWorkItems(root, 'ACM')
  assert.deepEqual(items.map((i) => i.key), ['ACM-1', 'ACM-2'])
  const gh = items[0]
  assert.equal(gh.title, 'Checkout shows USD to Canadian visitors')
  assert.equal(gh.status, 'todo')
  assert.equal(gh.priority, 'P1', 'a P1 label maps to priority')
  assert.equal(gh.assignee, 'mara')
  assert.deepEqual(gh.external, { system: 'github', id: 'github:acme/web#40', key: '#40', url: 'https://github.com/acme/web/issues/40', status: 'open', category: 'open' })
  assert.deepEqual(gh.history, [{ at: AT, by: 'lore-sync', via: 'sync', change: { created: true }, reason: 'mirrored from GitHub #40 (open)', sources: ['https://github.com/acme/web/issues/40'] }])
  const jira = items[1]
  assert.equal(jira.status, 'in_progress')
  assert.equal(jira.priority, 'P1')
  assert.equal(jira.assignee, 'Cory')
  assert.equal(jira.external?.id, 'jira:ACM-7')

  // Same tables again: nothing to do, table untouched.
  const before = readFileSync(join(root, 'context/work/lore/ACM.yaml'), 'utf8')
  const again = mirrorExternal(root, ACME, '2026-09-15T11:00:00.000Z')
  assert.deepEqual([again.created, again.updated], [0, 0])
  assert.equal(readFileSync(join(root, 'context/work/lore/ACM.yaml'), 'utf8'), before)
})

test('work mirror: a tracker move is one history event that moves lore once; fold and human decisions stand until the tracker itself moves', async () => {
  const root = makeContextRepo({ 'context/work/jira/ACM.yaml': jiraTable('In Review', 'In Progress') })
  mirrorExternal(root, ACME, AT)

  // The fold decides it shipped before Jira caught up.
  const items = readWorkItems(root, 'ACM')
  const fold = applyFoldChanges(items, [{ key: 'ACM-1', status: 'done', reason: 'Cory posted the merged build', sources: ['https://slack.com/x'], confidence: 'high', evidence_date: '2026-09-15' }], '2026-09-15T12:00:00.000Z')
  assert.equal(fold.applied.length, 1)
  writeWorkItems(root, 'ACM', items)
  assert.equal(summarizeForRecall(items[0]).drift, true, 'lore says done, Jira says In Progress')

  // Jira unchanged → lore's done stands.
  const same = mirrorExternal(root, ACME, '2026-09-15T13:00:00.000Z')
  assert.equal(same.updated, 0)
  assert.equal(readWorkItems(root, 'ACM')[0].status, 'done')

  // A human renames it in lore, then Jira renames + moves it: the human title survives, the tracker move is recorded and followed.
  await captureConsole(() => workSet(root, 'ACM-1', { title: 'Agreement builder v2 (clause library)' }, { reason: 'clearer' }, opts(root, '2026-09-16T09:00:00.000Z')))
  writeFileSync(join(root, 'context/work/jira/ACM.yaml'), jiraTable('Selected for Development', 'To Do').replace('Agreement builder v2', 'Renamed in Jira'))
  const moved = mirrorExternal(root, ACME, '2026-09-16T10:00:00.000Z')
  assert.equal(moved.updated, 1)
  const item = readWorkItems(root, 'ACM')[0]
  assert.equal(item.title, 'Agreement builder v2 (clause library)')
  assert.equal(item.status, 'todo', 'Jira reopened it → lore follows the newer evidence')
  assert.equal(item.external?.status, 'Selected for Development')
  const last = item.history.at(-1)!
  assert.equal(last.via, 'sync')
  assert.deepEqual(last.change, { external_status: ['In Review', 'Selected for Development'], status: ['done', 'todo'] })
  assert.equal(last.reason, 'Jira ACM-7 moved In Review → Selected for Development')
  assert.equal(summarizeForRecall(item).drift, undefined)

  // Archived in lore: a tracker move is recorded but never un-archives.
  await captureConsole(() => workMove(root, 'ACM-1', 'archived', { reason: 'out of scope' }, opts(root, '2026-09-17T09:00:00.000Z')))
  writeFileSync(join(root, 'context/work/jira/ACM.yaml'), jiraTable('Done', 'Done'))
  mirrorExternal(root, ACME, '2026-09-17T10:00:00.000Z')
  const archived = readWorkItems(root, 'ACM')[0]
  assert.equal(archived.status, 'archived')
  assert.deepEqual(archived.history.at(-1)!.change, { external_status: ['Selected for Development', 'Done'] })
})

test('work mirror: a status named Blocked maps to blocked; a ticket only sync has touched follows a corrected mapping without a tracker move', () => {
  const root = makeContextRepo({ 'context/work/jira/ACM.yaml': jiraTable('Blocked', 'In Progress') })
  mirrorExternal(root, ACME, AT)
  assert.equal(readWorkItems(root, 'ACM')[0].status, 'blocked')
  // Simulate a ticket mirrored by an older build that recorded in_progress: same tracker state, no human/fold history.
  const items = readWorkItems(root, 'ACM')
  items[0].status = 'in_progress'
  writeWorkItems(root, 'ACM', items)
  const m = mirrorExternal(root, ACME, '2026-09-15T11:00:00.000Z')
  assert.equal(m.updated, 1)
  const fixed = readWorkItems(root, 'ACM')[0]
  assert.equal(fixed.status, 'blocked')
  assert.deepEqual(fixed.history.at(-1)!.change, { status: ['in_progress', 'blocked'] })
  assert.equal(fixed.history.at(-1)!.reason, 'Jira ACM-7 updated')
  // Once a person has weighed in, the tracker no longer overrides without a move.
  items.length = 0
  const again = readWorkItems(root, 'ACM')
  again[0].status = 'in_progress'
  again[0].history.push({ at: '2026-09-15T12:00:00.000Z', by: 'shawn', via: 'cli', change: { status: ['blocked', 'in_progress'] }, reason: 'unblocked in the call' })
  writeWorkItems(root, 'ACM', again)
  assert.equal(mirrorExternal(root, ACME, '2026-09-15T13:00:00.000Z').updated, 0)
  assert.equal(readWorkItems(root, 'ACM')[0].status, 'in_progress')
})

test('work fold: guardrails — high confidence with a source only, never archived, never over a newer human call', () => {
  const base = (): LoreWorkItem[] => [
    { key: 'ACM-1', title: 'a', status: 'todo', state: 'open', labels: [], sources: [], created: '2026-09-01', updated: '2026-09-01', history: [] },
    { key: 'ACM-2', title: 'b', status: 'in_progress', state: 'open', priority: 'P2', labels: [], sources: [], created: '2026-09-01', updated: '2026-09-01', history: [
      { at: '2026-09-14T10:00:00.000Z', by: 'shawn', via: 'cli', change: { status: ['todo', 'in_progress'] }, reason: 'Shawn: keep going' },
    ] },
    { key: 'ACM-3', title: 'c', status: 'archived', state: 'closed', labels: [], sources: [], created: '2026-09-01', updated: '2026-09-01', history: [] },
  ]
  const ok = { reason: 'r', sources: ['s'], confidence: 'high', evidence_date: '2026-09-15' }
  const items = base()
  const r = applyFoldChanges(items, [
    { key: 'ACM-1', status: 'done', ...ok },
    { key: 'ACM-1', status: 'done', ...ok }, // second time: no change
    { key: 'ACM-9', status: 'done', ...ok },
    { key: 'ACM-1', priority: 'P1', ...ok, confidence: 'medium' },
    { key: 'ACM-1', priority: 'P1', ...ok, sources: [] },
    { key: 'ACM-1', status: 'archived', ...ok },
    { key: 'ACM-3', status: 'todo', ...ok },
    { key: 'ACM-1', status: 'wontfix', ...ok },
    { key: 'ACM-2', status: 'todo', priority: 'P1', ...ok, evidence_date: '2026-09-13' },
    { key: 'ACM-2', status: 'blocked', ...ok, evidence_date: '2026-09-15' },
  ], '2026-09-15T12:00:00.000Z')
  assert.deepEqual(r.applied, [
    'ACM-1: status → ["todo","done"] — r',
    'ACM-2: priority → ["P2","P1"] — r',
    'ACM-2: status → ["in_progress","blocked"] — r',
  ])
  assert.deepEqual(r.skipped, [
    'ACM-1: no change',
    'ACM-9: unknown item',
    'ACM-1: confidence medium — only high applies',
    'ACM-1: no source cited',
    'ACM-1: archiving is a human decision',
    'ACM-3: archiving is a human decision',
    'ACM-1: unknown status wontfix',
    'ACM-2: status set by a person after 2026-09-13 — kept',
  ])
  assert.equal(items[0].status, 'done')
  assert.equal(items[0].state, 'closed')
  assert.deepEqual(items[0].history, [{ at: '2026-09-15T12:00:00.000Z', by: 'lore-extract', via: 'fold', change: { status: ['todo', 'done'] }, reason: 'r', sources: ['s'], confidence: 'high', evidence_date: '2026-09-15' }])
  assert.equal(items[1].status, 'blocked')
  assert.equal(items[1].priority, 'P1')

  // Rank: above another key, recorded as a rank change.
  const ranked = base()
  const rr = applyFoldChanges(ranked, [{ key: 'ACM-2', rank_above: 'ACM-1', ...ok }], '2026-09-15T12:00:00.000Z')
  assert.deepEqual(rr.applied, ['ACM-2: rank → [2,1] — r'])
  assert.deepEqual(ranked.map((i) => i.key), ['ACM-2', 'ACM-1', 'ACM-3'])
})

test('work recall: the lore table comes first, items carry `last` and no history, counts follow state', async () => {
  const root = makeContextRepo({ 'context/work/github/acme__web.yaml': GITHUB_TABLE })
  mirrorExternal(root, ACME, AT)
  await captureConsole(() => workAdd(root, { title: 'Manual', reason: 'Priya asked' }, opts(root, '2026-09-15T11:00:00.000Z')))
  await captureConsole(() => workMove(root, 'ACM-2', 'done', { reason: 'shipped' }, opts(root, '2026-09-15T12:00:00.000Z')))
  const r = recallData(root, ACME)
  assert.deepEqual(Object.keys(r.work), ['lore/ACM', 'github/acme__web'])
  const lore = r.work['lore/ACM']
  assert.deepEqual(lore.counts, { open: 1, closed: 1, merged: 0 })
  const open = lore.open[0] as Record<string, unknown>
  assert.equal(open.key, 'ACM-1')
  assert.equal('history' in open, false)
  assert.deepEqual(open.last, { at: AT, by: 'lore-sync', via: 'sync', reason: 'mirrored from GitHub #40 (open)' })
  assert.equal(open.drift, undefined)
  const only = recallData(root, ACME, 'work')
  assert.deepEqual(Object.keys(only.work), ['lore/ACM', 'github/acme__web'])
  assert.deepEqual(only.pins, [])
})

test('work sync: mirroring runs after the connectors and reports what it did', async () => {
  const root = makeContextRepo({ 'context/work/github/acme__web.yaml': GITHUB_TABLE }, { project: 'acme', sources: {}, backfill: { months: 1 } })
  const { result, out } = await captureConsole(() => sync(root, {}))
  assert.equal(result.ok, true)
  assert.match(out, /work: 1 mirrored, 0 updated → context\/work\/lore\/ACM\.yaml/)
  assert.equal(readWorkItems(root, 'ACM').length, 1)
})

test('work mcp: the four tools write with via mcp and never take an actor; a move needs a reason', async () => {
  const root = makeContextRepo({ 'context/derived/requests.yaml': FIXTURE_REQUESTS })
  const ctx = resolveContext(root, { context: root })
  const server = createServer(ctx, { cwd: root, opts: { context: root } })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientT)
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args })
    return { isError: res.isError === true, text: (res.content as { text: string }[])[0]?.text ?? '' }
  }

  const added = await call('lore_work_add', { title: 'From Slack', reason: 'Priya asked in #acme', sources: ['https://slack.com/archives/C0ACME/p1'], priority: 'P2' })
  assert.equal(added.isError, false, added.text)
  assert.match(added.text, /added ACM-1: From Slack \[todo\]/)
  const promoted = await call('lore_work_promote', { request_id: 'req-0001' })
  assert.match(promoted.text, /promoted req-0001 → ACM-2/)

  const noReason = await call('lore_work_move', { key: 'ACM-1', status: 'done' })
  assert.equal(noReason.isError, true)
  const emptyReason = await call('lore_work_move', { key: 'ACM-1', status: 'done', reason: '' })
  assert.equal(emptyReason.isError, true)
  const moved = await call('lore_work_move', { key: 'ACM-1', status: 'in_progress', reason: 'Cory said he started', sources: ['https://slack.com/archives/C0ACME/p2'] })
  assert.equal(moved.isError, false, moved.text)
  const set = await call('lore_work_set', { key: 'ACM-2', assignee: 'cory', rank_above: 'top', reason: 'launch first' })
  assert.equal(set.isError, false, set.text)
  assert.match(set.text, /updated ACM-2; ranked ACM-2 top/)
  const nothing = await call('lore_work_set', { key: 'ACM-2', reason: 'x' })
  assert.equal(nothing.isError, true)

  const items = readWorkItems(root, 'ACM')
  assert.deepEqual(items.map((i) => i.key), ['ACM-2', 'ACM-1'])
  const one = items.find((i) => i.key === 'ACM-1')!
  assert.equal(one.history[1].via, 'mcp')
  assert.equal(one.history[1].by, me)
  assert.equal(one.history[1].reason, 'Cory said he started')
  assert.ok(readAudit(root).every((a) => a.action === 'work' && a.via === 'mcp' && a.actor === me))
  await Promise.all([client.close(), server.close()])
})

test('work fold: creates tickets for committed work — high confidence, cited, never done, never a duplicate of a request or a similar title', () => {
  const items: LoreWorkItem[] = [
    { key: 'ACM-1', title: 'Start 10DLC carrier registration', status: 'todo', state: 'open', labels: [], request: 'req-0021', sources: [], created: '2026-09-01', updated: '2026-09-01', history: [] },
    { key: 'ACM-2', title: 'Family portal login', status: 'in_progress', state: 'open', labels: [], external: { system: 'jira', id: 'jira:INPT-5', key: 'INPT-5', url: '', status: 'In Progress', category: 'In Progress' }, sources: [], created: '2026-09-01', updated: '2026-09-01', history: [] },
  ]
  const ok = { reason: 'Shawn agreed in the 09-14 kickoff', sources: ['https://slack.com/x'], confidence: 'high', evidence_date: '2026-09-14' }
  const r = applyFoldCreations(items, 'ACM', [
    { title: 'Run a 10–20 parent friends-and-family alpha', request: 'req-0024', priority: 'P1', ...ok },
    { title: 'Register with the 10DLC carriers', request: 'req-0021', ...ok }, // request already tracked
    { title: 'Login for the family portal', ...ok }, // reads like ACM-2 (mirrored from Jira)
    { title: 'Ship the SMS opening flow', status: 'done', ...ok },
    { title: 'Cost the trial model', ...ok, confidence: 'medium' },
    { title: 'Clinical sign-off before launch', ...ok, sources: [] },
    { title: '  ', ...ok },
    { title: 'Instrument product metrics from day one', status: 'in_progress', assignee: 'Cory', priority: 'P9', ...ok },
  ], '2026-09-15T12:00:00.000Z')
  assert.deepEqual(r.created, [
    'ACM-3: "Run a 10–20 parent friends-and-family alpha" (req-0024) [todo] — Shawn agreed in the 09-14 kickoff',
    'ACM-4: "Instrument product metrics from day one" [in_progress] — Shawn agreed in the 09-14 kickoff',
  ])
  assert.deepEqual(r.skipped, [
    '"Register with the 10DLC carriers": req-0021 is already ACM-1',
    '"Login for the family portal": reads like ACM-2 "Family portal login"',
    '"Ship the SMS opening flow": a ticket is not created as done',
    '"Cost the trial model": confidence medium — only high applies',
    '"Clinical sign-off before launch": no source cited',
    '(untitled): no title',
  ])
  const alpha = items.find((i) => i.key === 'ACM-3')!
  assert.equal(alpha.request, 'req-0024')
  assert.equal(alpha.priority, 'P1')
  assert.deepEqual(alpha.history, [{ at: '2026-09-15T12:00:00.000Z', by: 'lore-extract', via: 'fold', change: { created: true }, reason: 'Shawn agreed in the 09-14 kickoff', sources: ['https://slack.com/x'], confidence: 'high', evidence_date: '2026-09-14' }])
  const metrics = items.find((i) => i.key === 'ACM-4')!
  assert.equal(metrics.assignee, 'Cory')
  assert.equal(metrics.priority, undefined, 'an unknown priority is dropped, not invented')
  assert.equal(metrics.state, 'open')
  assert.ok(titleSimilarity('Family portal login', 'Login for the family portal') >= 0.7)
  assert.ok(titleSimilarity('Family portal login', 'Run a parent alpha') < 0.3)
})
