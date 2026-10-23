import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { configSchema } from '../src/config.js'
import { buildLoad } from '../src/load/build.js'
import { actorResolver } from '../src/load/actors.js'
import { queryLoad } from '../src/load/query.js'
import { LOAD_FILE, loadFreshness, readLoad, rebuildLoad } from '../src/load/store.js'
import { readLoadInputs } from '../src/load/inputs.js'
import { workAdd, workMove, workRank } from '../src/commands/work.js'
import { writeDocs } from '../src/streams.js'
import { captureConsole, makeContextRepo } from './helpers.js'

const config = {
  project: 'acme', sources: {},
  client: { name: 'Acme', contacts: [{ name: 'Customer', email: 'customer@acme.com', side: 'client' }] },
  load: { enabled: true, timezone: 'America/Vancouver', actors: [
    { id: 'dev', name: 'Developer', kind: 'human', identities: ['email:dev@team.com', 'github:dev', 'name:Developer'], roles: [
      { role: 'software_developer', from: '2026-01-01', to: '2026-10-01' },
      { role: 'technical_lead', from: '2026-10-01' },
      { role: 'client_strategist', from: '2026-10-01' },
    ] },
    { id: 'bot', name: 'Agent', kind: 'agent', identities: ['github:agent'], roles: [] },
  ] },
}
function fixture() {
  const root = makeContextRepo({}, config)
  writeDocs(root, [
    { source: 'github', channel: 'acme_web', id: 'github-acme/web-pr-1', author: 'dev', timestamp: '2026-09-30T15:00:00Z', meta: { repo: 'acme/web', number: '1', type: 'pr', login: 'dev' }, text: '**First PR**' },
    { source: 'github', channel: 'other', id: 'github-acme/web-pr-1', author: 'dev', timestamp: '2026-09-30T15:00:00Z', meta: { repo: 'acme/web', number: '1', type: 'pr', login: 'dev' }, text: '**First PR**' },
    { source: 'github', channel: 'acme_web', id: 'github-acme/web-pr-1@update', author: 'github', timestamp: '2026-10-01T15:00:00Z', meta: { repo: 'acme/web', number: '1', type: 'pr' }, text: 'merged' },
    { source: 'github', channel: 'acme_web', id: 'github-acme/web-pr-2', author: 'agent', timestamp: '2026-10-01T15:00:00Z', meta: { repo: 'acme/web', number: '2', type: 'pr', login: 'agent' }, text: '**Agent PR**' },
    ...['inbox', 'second-mailbox'].map(channel => ({ source: 'gmail', channel, id: 'gmail-one', author: 'Customer', timestamp: '2026-10-01T15:00:00Z', meta: { message_id: 'one@acme.com', from: 'customer@acme.com', to: 'dev@team.com', mailboxes: 'dev@team.com' }, text: '**A question**' })),
    { source: 'gmail', channel: 'inbox', id: 'gmail-two', author: 'Developer', timestamp: '2026-10-01T16:00:00Z', meta: { message_id: 'two@team.com', from: 'dev@team.com', to: 'customer@acme.com', mailboxes: 'dev@team.com' }, text: '**An answer**' },
    { source: 'granola', channel: 'meetings', id: 'granola-one', author: 'Developer', timestamp: '2026-10-01T17:00:00Z', meta: { meeting: 'one', creator: 'dev@team.com', attendees: 'dev@team.com,customer@acme.com' }, text: '**Planning**' },
    { source: 'granola', channel: 'meetings', id: 'granola-one-transcript', author: 'transcript', timestamp: '2026-10-01T17:00:01Z', meta: { meeting: 'one' }, text: 'Transcript' },
  ])
  return root
}

test('Load deduplicates native identities, preserves evidence, and counts source events without an LLM', () => {
  const root = fixture()
  const snapshot = buildLoad(root)
  assert.equal(snapshot.events.length, 5)
  assert.deepEqual(queryLoad(snapshot).byType.filter(t => t.accepted).map(t => [t.type, t.accepted]), [
    ['pr.created', 2], ['email.sent', 1], ['email.received', 1], ['meeting.held', 1],
  ])
  assert.equal(snapshot.events.find(e => e.type === 'meeting.held')!.evidence.length, 2)
  assert.equal(snapshot.events.find(e => e.type === 'email.received')!.evidence.length, 2)
  assert.equal(snapshot.events.find(e => e.type === 'meeting.held')!.actor, undefined)
  assert.deepEqual(buildLoad(root).events, snapshot.events)
  assert.equal(queryLoad(snapshot, { actorKind: 'agent', participation: 'performed' }).matchedEvents, 1)
})

test('project roles are temporal, multiple, explicit; overlapping role totals never duplicate an event', () => {
  const snapshot = buildLoad(fixture())
  assert.equal(queryLoad(snapshot, { role: 'software_developer', type: 'pr.created' }).matchedEvents, 1)
  assert.equal(queryLoad(snapshot, { role: 'technical_lead', type: 'meeting.held' }).matchedEvents, 1)
  assert.equal(queryLoad(snapshot, { role: 'technical_lead', type: 'meeting.held', participation: 'performed' }).matchedEvents, 0)
  assert.equal(queryLoad(snapshot, { role: 'technical_lead', participation: 'attendee' }).matchedEvents, 1)
  assert.equal(queryLoad(snapshot, { role: 'technical_lead', participation: 'recipient' }).matchedEvents, 1)
  assert.equal(queryLoad(snapshot, { participation: 'attendee' }).matchedEvents, 1)
  const q = queryLoad(snapshot, { type: 'meeting.held', groupBy: 'role' })
  assert.equal(q.matchedEvents, 1)
  assert.deepEqual(q.groups.map(g => [g.key, g.accepted]), [['client_strategist', 1], ['customer', 1], ['technical_lead', 1]])
  const resolve = actorResolver(configSchema.parse(config))
  assert.equal(resolve(['github:unlisted']).kind, 'unknown')
  assert.deepEqual(resolve(['email:dev@team.com'], '2025-01-01T00:00:00Z').roles, [])
})

test('identity collisions are rejected, and explicit project role mappings override contacts', () => {
  assert.throws(() => configSchema.parse({ ...config, load: { actors: [config.load.actors[0], { ...config.load.actors[1], identities: ['github:dev'] }] } }))
  const cfg = configSchema.parse({ ...config, load: { actors: [{ id: 'customer', name: 'Customer', kind: 'human', identities: ['email:customer@acme.com'], roles: [] }] } })
  assert.deepEqual(actorResolver(cfg)(['email:customer@acme.com']).roles, [])
})

test('timezone boundaries and Monday weeks use local calendar dates through daylight saving', () => {
  const snapshot = buildLoad(fixture())
  const example = snapshot.events[0]
  snapshot.events = ['2026-11-01T06:59:59Z', '2026-11-01T07:00:00Z', '2026-11-02T07:59:59Z', '2026-11-02T08:00:00Z'].map((at, i) => ({ ...example, id: String(i), occurred_at: at }))
  // Los Angeles, not the fixture's Vancouver: tzdata 2026c keeps British
  // Columbia on daylight time from November 2026, so its fall-back is gone.
  const q = queryLoad(snapshot, { from: '2026-11-01', to: '2026-11-02', groupBy: 'week', tz: 'America/Los_Angeles' })
  assert.equal(q.matchedEvents, 2)
  assert.equal(q.groups[0].key, '2026-10-26')
  assert.throws(() => queryLoad(snapshot, { from: '2026-02-30' }))
  assert.throws(() => queryLoad(snapshot, { from: '2026-10-02', to: '2026-10-01' }))
  assert.throws(() => queryLoad(snapshot, { tz: 'bad/timezone' }))
})

test('new board status/rank writes share an operation, no-ops do not count, creation retains assignment', async () => {
  const root = fixture()
  await captureConsole(async () => {
    const first = workAdd(root, { title: 'First', assignee: 'Developer' }, { via: 'web', actor: 'dev@team.com', at: '2026-10-01T12:00:00Z' })
    const second = workAdd(root, { title: 'Second' }, { via: 'web', actor: 'dev@team.com' })
    workMove(root, first.key, 'in_progress', { reason: 'start' }, { via: 'web', actor: 'dev@team.com', operationId: 'one-drag', at: '2026-10-01T13:00:00Z' })
    workRank(root, first.key, { bottom: true }, { reason: 'move below second' }, { via: 'web', actor: 'dev@team.com', operationId: 'one-drag', at: '2026-10-01T13:00:01Z' })
    assert.ok(second.key)
    assert.throws(() => workMove(root, first.key, 'in_progress', { reason: 'noop' }, { via: 'web', actor: 'dev@team.com' }))
  })
  const snapshot = buildLoad(root)
  const moves = snapshot.events.filter(e => e.type === 'ticket.board_moved')
  assert.equal(moves.length, 1)
  assert.equal(moves[0].evidence.length, 2)
  assert.equal(moves[0].status, 'accepted')
  assert.equal(snapshot.events.filter(e => e.type === 'ticket.assigned').length, 1)
})

test('legacy moves are candidate entries and sync changes do not become human actions', () => {
  const root = makeContextRepo({ 'context/work/lore/ACM.yaml': JSON.stringify([{ key: 'ACM-1', title: 'Task', history: [
    { at: '2026-10-01T12:00:00Z', by: 'dev@team.com', via: 'web', change: { status: ['todo', 'done'] } },
    { at: '2026-10-01T12:00:01Z', by: 'dev@team.com', via: 'web', change: { rank: [2, 1] } },
    { at: '2026-10-01T12:00:00Z', by: 'lore-sync', via: 'sync', change: { assignee: ['', 'Developer'], status: ['todo', 'done'] } },
  ] }]) }, config)
  const q = queryLoad(buildLoad(root))
  assert.deepEqual(q.groups, [{ key: 'ticket.board_moved', accepted: 0, candidates: 2 }, { key: 'ticket.completed', accepted: 1, candidates: 0 }])
})

test('atomic snapshots replay unchanged, queries paginate, same-length source changes invalidate', () => {
  const root = fixture()
  const first = rebuildLoad(root)
  const before = readFileSync(join(root, LOAD_FILE), 'utf8')
  rebuildLoad(root)
  assert.equal(readFileSync(join(root, LOAD_FILE), 'utf8'), before)
  const page = queryLoad(readLoad(root), { events: true, limit: 2 })
  assert.equal(page.events?.length, 2)
  assert.equal(page.nextOffset, 2)
  const input = readLoadInputs(root)
  const path = [...input.files.keys()].find(p => p.includes('/github/'))!
  writeFileSync(join(root, path), input.files.get(path)!.replace('First PR', 'Other PR'))
  assert.notEqual(rebuildLoad(root).fingerprint, first.fingerprint)
})

test('Git builds pin committed input and queries report newer evidence as stale', () => {
  const root = fixture()
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'evidence')
  const snapshot = rebuildLoad(root)
  assert.ok(snapshot.input_revision)
  assert.equal(loadFreshness(root, snapshot), 'current')
  writeFileSync(join(root, 'lore.json'), JSON.stringify({ ...config, project: 'changed' }))
  assert.equal(loadFreshness(root, snapshot), 'stale')
  assert.equal(buildLoad(root).project, 'acme')
})

test('sync bookkeeping in state.json alone does not make a projection stale', () => {
  const root = fixture()
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const commit = (message: string) => { git('add', '.'); git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', message) }
  writeFileSync(join(root, 'state.json'), JSON.stringify({ cursors: { github: 1 }, lastSync: '2026-10-01T00:00:00Z' }))
  git('init', '--quiet'); commit('evidence')
  const snapshot = rebuildLoad(root)
  writeFileSync(join(root, 'state.json'), JSON.stringify({ cursors: { github: 2 }, lastSync: '2026-10-01T00:05:00Z' }))
  commit('chore(lore): heartbeat')
  assert.equal(loadFreshness(root, snapshot), 'current')
  writeDocs(root, [{ source: 'github', channel: 'acme_web', id: 'github-acme/web-pr-3', author: 'dev', timestamp: '2026-10-02T15:00:00Z', meta: { repo: 'acme/web', number: '3', type: 'pr', login: 'dev' }, text: '**Third PR**' }])
  commit('chore(lore): sync')
  assert.equal(loadFreshness(root, snapshot), 'stale')
})

test('a failed rebuild preserves the last complete snapshot', () => {
  const root = fixture()
  rebuildLoad(root)
  const before = readFileSync(join(root, LOAD_FILE), 'utf8')
  mkdirSync(join(root, 'context/work/lore'), { recursive: true })
  writeFileSync(join(root, 'context/work/lore/BAD.yaml'), 'broken: [')
  assert.throws(() => rebuildLoad(root))
  assert.equal(readFileSync(join(root, LOAD_FILE), 'utf8'), before)
})

test('completions count the first recorded done transition once, even after reopening, in its original period', () => {
  const history = [
    { at: '2026-10-01T12:00:00Z', by: 'Developer', via: 'cli', change: { status: ['review', 'done'] } },
    { at: '2026-09-30T12:00:00Z', by: 'dev@team.com', via: 'web', change: { status: ['todo', 'done'] } },
    { at: '2026-09-30T13:00:00Z', by: 'Developer', via: 'cli', change: { status: ['done', 'review'] } },
  ]
  const path = 'context/work/lore/ACM.yaml'
  const rows = [
    { key: 'ACM-1', title: 'Recompleted', status: 'review', history },
    { key: 'ACM-2', title: 'Only archived', status: 'archived', history: [{ at: '2026-10-01T12:00:00Z', by: 'Developer', via: 'cli', change: { status: ['todo', 'archived'] } }] },
    { key: 'ACM-3', title: 'Created done without a transition', status: 'done', history: [{ at: '2026-10-01T12:00:00Z', by: 'lore-extract', via: 'fold', change: { created: true } }] },
    { key: 'ACM-4', title: 'No-op done', status: 'done', history: [{ at: '2026-10-01T12:00:00Z', by: 'Developer', via: 'cli', change: { status: ['done', 'done'] } }] },
    { key: 'ACM-5', title: 'Archived after done', status: 'archived', history },
  ]
  const root = makeContextRepo({ [path]: JSON.stringify(rows) }, config)
  const snapshot = buildLoad(root)
  const events = snapshot.events.filter(e => e.type === 'ticket.completed')
  assert.equal(events.length, 1)
  assert.equal(events[0].occurred_at, '2026-09-30T12:00:00.000Z')
  assert.equal(events[0].actor?.id, 'dev')
  assert.deepEqual(events[0].actor?.roles, ['software_developer'])
  assert.equal(events[0].attributes.surface, 'web')
  assert.equal(queryLoad(snapshot, { type: 'ticket.completed', from: '2026-09-01', to: '2026-10-01' }).matchedEvents, 1)
  assert.equal(queryLoad(snapshot, { type: 'ticket.completed', from: '2026-10-01', to: '2026-11-01' }).matchedEvents, 0)
  rows[0].history.reverse()
  writeFileSync(join(root, path), JSON.stringify(rows))
  const rebuilt = buildLoad(root).events.find(e => e.type === 'ticket.completed')!
  assert.equal(rebuilt.id, events[0].id)
  assert.equal(rebuilt.occurred_at, events[0].occurred_at)
  assert.equal(rebuilt.evidence[0].history_id, events[0].evidence[0].history_id)
})

test('completion counts preserve manual, Slack, inferred fold and tracker-sync recording provenance', () => {
  const surfaces = ['web', 'cli', 'mcp', 'slack', 'fold', 'sync']
  const rows = surfaces.map((via, i) => ({ key: `ACM-${i + 1}`, title: via, status: 'done', assignee: 'Developer', history: [
    { id: `h-${i}`, operation_id: `op-${i}`, at: '2026-10-01T12:00:00Z', by: via === 'fold' ? 'lore-extract' : via === 'sync' ? 'lore-sync' : 'Developer', via, change: { status: ['in_progress', 'done'] } },
  ] }))
  const root = makeContextRepo({ 'context/work/lore/ACM.yaml': JSON.stringify(rows) }, config)
  const q = queryLoad(buildLoad(root), { type: 'ticket.completed', events: true })
  assert.equal(q.matchedEvents, 6)
  assert.deepEqual(q.completionBySurface, [...surfaces].sort().map(surface => ({ surface, accepted: 1, candidates: 0 })))
  const inferred = q.events!.find(e => e.attributes.surface === 'fold')!
  assert.equal(inferred.attributes.completionBasis, 'fold-inference')
  assert.equal(inferred.attributes.recordedBy, 'lore-extract')
  assert.equal(inferred.actor?.kind, 'unknown')
  assert.deepEqual(inferred.participants, [], 'current assignee is not evidence of who completed the work')
  assert.equal(inferred.method, 'source', 'reads recorded history without another inference pass')
  assert.equal(q.events!.find(e => e.attributes.surface === 'slack')!.attributes.completionBasis, 'slack-reaction')
  assert.equal(q.events!.find(e => e.attributes.surface === 'sync')!.attributes.completionBasis, 'tracker-sync')
})

test('an undated completion stays a candidate and cannot borrow a later completion date', () => {
  const root = makeContextRepo({ 'context/work/lore/ACM.yaml': JSON.stringify([{ key: 'ACM-1', title: 'Unknown first date', history: [
    { at: '2026-10-01T12:00:00Z', by: 'Developer', via: 'cli', change: { status: ['review', 'done'] } },
    { at: 'unknown', by: 'Developer', via: 'cli', change: { status: ['todo', 'done'] } },
  ] }]) }, config)
  const snapshot = buildLoad(root)
  const q = queryLoad(snapshot, { type: 'ticket.completed', undated: true, events: true })
  assert.equal(q.matchedEvents, 1)
  assert.equal(q.events![0].status, 'candidate')
  assert.deepEqual(q.events![0].attributes.candidateReasons, ['first completion date unknown'])
  assert.equal(queryLoad(snapshot, { type: 'ticket.completed' }).matchedEvents, 0)
  assert.equal(queryLoad(snapshot, { type: 'ticket.completed' }).undatedExcluded, 1)
})

test('rebuild upgrades old projections even with unchanged inputs and preserves semantic checkpoints', () => {
  const root = fixture()
  const first = rebuildLoad(root)
  first.extractor = 2
  first.semantic = { version: 1, checkpoints: { historical: 'digest' }, records: [] }
  writeFileSync(join(root, LOAD_FILE), JSON.stringify(first))
  assert.equal(loadFreshness(root, readLoad(root)), 'stale')
  const next = rebuildLoad(root)
  assert.equal(next.extractor, 3)
  assert.deepEqual(next.semantic, first.semantic)
  const saved = readFileSync(join(root, LOAD_FILE), 'utf8')
  rebuildLoad(root)
  assert.equal(readFileSync(join(root, LOAD_FILE), 'utf8'), saved)
})
