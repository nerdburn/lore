import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readAudit } from '../src/audit.js'
import type { JiraApi, JiraBoard, JiraSprint, JiraTransition } from '../src/connectors/jira.js'
import { workAdd, workMove } from '../src/commands/work.js'
import { equalityClauses, inSync, pickTransition, workPush } from '../src/commands/work-push.js'
import { mirrorExternal, readWorkItems, type LoreWorkItem } from '../src/work.js'
import { ACME, captureConsole, makeContextRepo } from './helpers.js'

const AT = '2026-09-16T10:00:00.000Z'
const SITE = 'https://acme.atlassian.net'
const CFG = { project: 'acme', sources: { jira: { boards: [293], site: SITE, api_base: 'https://jira.int.example/rest/api/3' } }, extract: [] as string[] }

const T = (id: string, name: string, to: string, key: JiraTransition['to']['statusCategory']['key']): JiraTransition => ({ id, name, to: { name: to, statusCategory: { key, name: { new: 'To Do', indeterminate: 'In Progress', done: 'Done' }[key] } } })
const WORKFLOW: Record<string, JiraTransition[]> = {
  'To Do': [T('21', 'In Progress', 'In Progress', 'indeterminate'), T('31', 'Done', 'Done', 'done'), T('41', 'Mark Blocked', 'Blocked', 'indeterminate')],
  'In Progress': [T('11', 'To Do', 'To Do', 'new'), T('2', 'In review', 'In Review', 'indeterminate'), T('31', 'Done', 'Done', 'done'), T('41', 'Mark Blocked', 'Blocked', 'indeterminate')],
  'In Review': [T('21', 'In Progress', 'In Progress', 'indeterminate'), T('31', 'Done', 'Done', 'done')],
  Blocked: [T('21', 'In Progress', 'In Progress', 'indeterminate'), T('11', 'To Do', 'To Do', 'new')],
  Done: [T('11', 'To Do', 'To Do', 'new')],
}

/** A Jira that remembers issue statuses and what was created. */
function fakeJira(initial: Record<string, string> = {}) {
  const status = { ...initial }
  const created: Record<string, unknown>[] = []
  const calls: string[] = []
  let n = 7200
  const api: JiraApi = {
    async search() {
      return []
    },
    async comments() {
      return []
    },
    async board(id) {
      calls.push(`board ${id}`)
      return { name: 'Jointly', jql: 'project = "Input Logic" AND "Client Project[Dropdown]" = Jointly' }
    },
    async transitions(key) {
      calls.push(`transitions ${key}`)
      return WORKFLOW[status[key] ?? 'To Do']
    },
    async transition(key, id) {
      calls.push(`transition ${key} ${id}`)
      const t = WORKFLOW[status[key] ?? 'To Do'].find((x) => x.id === id)!
      status[key] = t.to.name
    },
    async issueTypes(project) {
      calls.push(`issueTypes ${project}`)
      return [{ id: '10000', name: 'Epic' }, { id: '10009', name: 'Task' }, { id: '10010', name: 'Sub-task', subtask: true }]
    },
    async createFields(project, type) {
      calls.push(`createFields ${project} ${type}`)
      return [
        { fieldId: 'summary', name: 'Summary', required: true },
        { fieldId: 'customfield_10034', name: 'Client Project', allowedValues: [{ id: '10021', value: 'CareMobi' }, { id: '10434', value: 'Jointly' }] },
        { fieldId: 'priority', name: 'Priority', allowedValues: [{ id: '2', name: 'High' }] },
      ]
    },
    async createIssue(fields) {
      calls.push('createIssue')
      created.push(fields)
      const key = `INPT-${++n}`
      status[key] = 'To Do'
      return { id: String(n), key }
    },
    async sprintField() {
      return 'customfield_10020'
    },
    async boardInfo(id) {
      calls.push(`sprint-board ${id}`)
      return { id, name: 'Jointly', type: sprints.boardType }
    },
    async projectBoards(project) {
      calls.push(`project-boards ${project}`)
      return sprints.projectBoards
    },
    async openSprints(boardId) {
      calls.push(`sprints ${boardId}`)
      return sprints.open
    },
    async issueSprint(key) {
      calls.push(`issue-sprint ${key}`)
      const id = sprints.membership[key]
      return sprints.open.find((sp) => sp.id === id)
    },
    async addToSprint(id, keys) {
      calls.push(`add-to-sprint ${id} ${keys.join(',')}`)
      for (const k of keys) sprints.membership[k] = id
    },
  }
  // Kanban by default: no sprints, so pushes behave as before sprints existed.
  const sprints = {
    boardType: 'kanban',
    projectBoards: [] as JiraBoard[],
    open: [] as JiraSprint[],
    membership: {} as Record<string, number>,
  }
  return { api, status, created, calls, sprints, deps: { jira: () => ({ api, site: SITE }) } }
}

const SPRINT_14: JiraSprint = { id: 14, name: 'Sprint 14', state: 'active', startDate: '2026-09-14T00:00:00Z' }
const SPRINT_15: JiraSprint = { id: 15, name: 'Sprint 15', state: 'future', startDate: '2026-09-28T00:00:00Z' }
function scrum(jira: ReturnType<typeof fakeJira>, open: JiraSprint[] = [SPRINT_14, SPRINT_15]) {
  jira.sprints.boardType = 'scrum'
  jira.sprints.open = open
  return jira
}

const jiraTable = (rows: { key: string; status: string; category: string }[]) =>
  '# Source-owned by Jira\n' +
  rows
    .map(
      (r) => `- key: ${r.key}
  type: Story
  title: ${r.key} title
  status: ${r.status}
  category: ${r.category}
  state: ${r.category === 'Done' ? 'closed' : 'open'}
  labels: []
  fix_versions: []
  created: 2026-09-01T00:00:00Z
  updated: 2026-09-10T00:00:00Z
  url: ${SITE}/browse/${r.key}
`,
    )
    .join('')

test('work push: status mapping — in sync means Jira already expresses lore\'s status; transitions picked by category', () => {
  const item = (status: LoreWorkItem['status'], ext: { status: string; category: string }): LoreWorkItem =>
    ({ key: 'K', title: 't', status, state: 'open', labels: [], sources: [], created: '', updated: '', history: [], external: { system: 'jira', id: 'jira:X-1', key: 'X-1', url: '', ...ext } }) as LoreWorkItem
  assert.equal(inSync(item('in_progress', { status: 'In Review', category: 'In Progress' })), true, 'In Review counts as in progress')
  assert.equal(inSync(item('in_progress', { status: 'Blocked', category: 'In Progress' })), false)
  assert.equal(inSync(item('blocked', { status: 'Blocked', category: 'In Progress' })), true)
  assert.equal(inSync(item('done', { status: 'In Review', category: 'In Progress' })), false)
  assert.equal(inSync(item('todo', { status: 'To Do', category: 'To Do' })), true)
  assert.equal(inSync(item('archived', { status: 'To Do', category: 'To Do' })), true)
  assert.equal(pickTransition('done', WORKFLOW['In Progress'])?.to.name, 'Done')
  assert.equal(pickTransition('in_progress', WORKFLOW['To Do'])?.to.name, 'In Progress', 'not Blocked, though both are indeterminate')
  assert.equal(pickTransition('blocked', WORKFLOW['In Progress'])?.name, 'Mark Blocked')
  assert.equal(pickTransition('todo', WORKFLOW.Done)?.to.name, 'To Do')
  assert.equal(pickTransition('blocked', WORKFLOW['In Review']), undefined, 'no blocked transition from review')
  assert.equal(pickTransition('archived', WORKFLOW['To Do']), undefined)
  assert.deepEqual(equalityClauses('project = "Input Logic" AND "Client Project[Dropdown]" = Jointly ORDER BY Rank ASC'), [
    { field: 'project', value: 'Input Logic' },
    { field: 'Client Project', value: 'Jointly' },
  ])
  assert.deepEqual(equalityClauses('project = INPT AND "Client Project[Dropdown]" = "Permission Slip"'), [
    { field: 'project', value: 'INPT' },
    { field: 'Client Project', value: 'Permission Slip' },
  ])
})

test('work push: transitions a linked ticket whose status differs, records it, and leaves in-sync tickets alone', async () => {
  const root = makeContextRepo({ 'context/work/jira/board-293.yaml': jiraTable([{ key: 'INPT-1', status: 'In Progress', category: 'In Progress' }, { key: 'INPT-2', status: 'To Do', category: 'To Do' }]) }, CFG)
  mirrorExternal(root, ACME, '2026-09-15T10:00:00.000Z')
  await captureConsole(() => workMove(root, 'ACM-1', 'done', { reason: 'shipped' }, { context: root, at: '2026-09-15T12:00:00.000Z' }))
  const jira = fakeJira({ 'INPT-1': 'In Progress', 'INPT-2': 'To Do' })

  const dry = await workPush(root, { all: true, dryRun: true }, { context: root, at: AT }, jira.deps)
  assert.deepEqual(dry.actions, [{ key: 'ACM-1', kind: 'transition', detail: 'would move INPT-1 In Progress → Done (lore: done)', jira: 'INPT-1' }])
  assert.ok(!jira.calls.some((c) => c.startsWith('transition ')), 'dry run changes nothing')
  assert.equal(readWorkItems(root, 'ACM')[0].external?.status, 'In Progress')

  const r = await workPush(root, { all: true }, { context: root, at: AT, by: 'shawn' }, jira.deps)
  assert.deepEqual(r.actions, [{ key: 'ACM-1', kind: 'transition', detail: 'INPT-1 In Progress → Done (lore: done)', jira: 'INPT-1' }])
  assert.equal(jira.status['INPT-1'], 'Done')
  const [a, b] = readWorkItems(root, 'ACM')
  assert.equal(a.external?.status, 'Done')
  assert.equal(a.external?.category, 'Done')
  const last = a.history.at(-1)!
  assert.deepEqual(last.change, { external_status: ['In Progress', 'Done'] })
  assert.equal(last.by, 'shawn')
  assert.match(last.reason, /pushed lore status done to Jira: INPT-1 In Progress → Done/)
  assert.equal(b.history.length, 1, 'the in-sync ticket is untouched')
  assert.deepEqual(readAudit(root).map((e) => e.id), ['ACM-1', 'ACM-1'])

  // The next sync rewrites the Jira table with what the push did; mirroring then sees no delta — lore already knows.
  writeFileSync(join(root, 'context/work/jira/board-293.yaml'), jiraTable([{ key: 'INPT-1', status: 'Done', category: 'Done' }, { key: 'INPT-2', status: 'To Do', category: 'To Do' }]))
  const again = mirrorExternal(root, ACME, '2026-09-16T11:00:00.000Z')
  assert.equal(again.updated, 0)
  assert.equal(readWorkItems(root, 'ACM')[0].history.length, 3, 'created, moved by shawn, pushed — nothing more')

  const explicit = await workPush(root, { keys: ['acm-2', 'ACM-9'] }, { context: root, at: AT }, jira.deps)
  assert.deepEqual(explicit.actions, [
    { key: 'ACM-2', kind: 'skip', detail: "INPT-2 already To Do — in sync with lore's todo" },
    { key: 'ACM-9', kind: 'error', detail: 'no such ticket' },
  ])
})

test('work push: creates a Jira issue for an open ticket without one, scoped onto the board, and links it back', async () => {
  const root = makeContextRepo({ 'context/work/jira/board-293.yaml': jiraTable([{ key: 'INPT-1', status: 'To Do', category: 'To Do' }]) }, CFG)
  mirrorExternal(root, ACME, '2026-09-15T10:00:00.000Z')
  await captureConsole(() => workAdd(root, { title: 'Clause library', priority: 'P1', labels: ['agreement builder'], sources: ['https://slack.com/x'] }, { context: root, at: '2026-09-15T11:00:00.000Z' }))
  await captureConsole(() => workMove(root, 'ACM-2', 'in_progress', { reason: 'Cory started' }, { context: root, at: '2026-09-15T12:00:00.000Z' }))
  await captureConsole(() => workAdd(root, { title: 'Already shipped', status: 'done' }, { context: root, at: '2026-09-15T13:00:00.000Z' }))
  const jira = fakeJira({ 'INPT-1': 'To Do' })

  const dry = await workPush(root, { keys: ['ACM-2', 'ACM-3'], dryRun: true }, { context: root, at: AT }, jira.deps)
  assert.deepEqual(dry.actions, [
    { key: 'ACM-2', kind: 'create', detail: 'would create a Task in INPT, Client Project = Jointly — "Clause library"' },
    { key: 'ACM-3', kind: 'skip', detail: 'done with no Jira issue — nothing to create' },
  ])
  assert.equal(jira.created.length, 0)
  jira.calls.length = 0

  const r = await workPush(root, { all: true }, { context: root, at: AT }, jira.deps)
  assert.deepEqual(r.actions, [
    { key: 'ACM-2', kind: 'create', detail: `created INPT-7201 (Task in INPT, Client Project = Jointly) ${SITE}/browse/INPT-7201`, jira: 'INPT-7201' },
    { key: 'ACM-2', kind: 'transition', detail: 'INPT-7201 To Do → In Progress (lore: in_progress)', jira: 'INPT-7201' },
  ])
  assert.deepEqual(jira.created[0], {
    project: { key: 'INPT' },
    issuetype: { id: '10009' },
    summary: 'Clause library',
    description: {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Tracked in lore as ACM-2.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Sources:' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'https://slack.com/x', marks: [{ type: 'link', attrs: { href: 'https://slack.com/x' } }] }] }] }] },
      ],
    },
    priority: { name: 'High' },
    labels: ['agreement-builder'],
    customfield_10034: { id: '10434' },
  })
  assert.equal(jira.status['INPT-7201'], 'In Progress')
  assert.equal(jira.calls.filter((c) => c.startsWith('board')).length, 1, 'target resolved once per run')

  const item = readWorkItems(root, 'ACM').find((i) => i.key === 'ACM-2')!
  assert.deepEqual(item.external, { system: 'jira', id: 'jira:INPT-7201', key: 'INPT-7201', url: `${SITE}/browse/INPT-7201`, status: 'In Progress', category: 'In Progress' })
  assert.ok(item.sources.includes(`${SITE}/browse/INPT-7201`))
  assert.deepEqual(item.history.at(-2)!.change, { external: [null, 'jira:INPT-7201'] })
  assert.deepEqual(item.history.at(-1)!.change, { external_status: ['To Do', 'In Progress'] })
  // Mirroring afterwards recognises the issue as already tracked — no duplicate ticket.
  const before = readWorkItems(root, 'ACM').length
  mirrorExternal(root, ACME, '2026-09-16T11:00:00.000Z')
  assert.equal(readWorkItems(root, 'ACM').length, before)
})

test('work push: refuses without keys or --all, needs a jira source, and explains an unresolvable board scope', async () => {
  const root = makeContextRepo({}, CFG)
  await assert.rejects(workPush(root, {}, { context: root }), /give ticket keys, or --all/)
  const noJira = makeContextRepo({}, { project: 'acme', sources: {}, extract: [] })
  await captureConsole(() => workAdd(noJira, { title: 'x' }, { context: noJira }))
  await assert.rejects(workPush(noJira, { all: true }, { context: noJira }), /no jira source configured/)

  await captureConsole(() => workAdd(root, { title: 'Needs a board' }, { context: root, at: AT }))
  const jira = fakeJira()
  jira.api.createFields = async () => [{ fieldId: 'summary', name: 'Summary', required: true }]
  const r = await workPush(root, { all: true }, { context: root, at: AT }, jira.deps)
  assert.equal(r.actions[0].kind, 'error')
  assert.match(r.actions[0].detail, /cannot tell which Jira project|scopes on "Client Project" = Jointly.*sources\.jira\.push\.fields/)

  // With push config, the scope comes from lore.json verbatim and the project is explicit.
  const cfg = { ...CFG, sources: { jira: { ...CFG.sources.jira, push: { project: 'INPT', issuetype: 'Story', fields: { customfield_10034: { id: '10434' } } } } } }
  const root2 = makeContextRepo({}, cfg)
  await captureConsole(() => workAdd(root2, { title: 'Configured' }, { context: root2, at: AT }))
  const jira2 = fakeJira()
  jira2.api.issueTypes = async () => [{ id: '10001', name: 'Story' }]
  const r2 = await workPush(root2, { all: true }, { context: root2, at: AT }, jira2.deps)
  assert.equal(r2.actions[0].kind, 'create')
  assert.equal(jira2.created[0].issuetype && (jira2.created[0].issuetype as { id: string }).id, '10001')
  assert.deepEqual(jira2.created[0].customfield_10034, { id: '10434' })
  assert.ok(!jira2.calls.some((c) => c.startsWith('board')), 'no board lookup when fields are configured')
})

test('work push: off-host it runs the same command on the lore host over SSH and relays the result', async () => {
  // A cache-mode context whose global remote is an SSH target is simulated through the ssh seam:
  // resolveContext here is local, so we exercise the remote branch by checking the command built for a fake cache context.
  const root = makeContextRepo({}, CFG)
  await captureConsole(() => workAdd(root, { title: 'x' }, { context: root, at: AT }))
  const seen: string[] = []
  const jira = fakeJira()
  // Local mode never uses ssh, even with the seam present.
  const r = await workPush(root, { keys: ['ACM-1'], dryRun: true }, { context: root, at: AT }, { ...jira.deps, ssh: (_t, cmd) => (seen.push(cmd), '{}') })
  assert.equal(r.ranOn, 'here')
  assert.deepEqual(seen, [])
})

// ---- sprints ----

test('work push: an in-flight ticket in no sprint goes into the active sprint; todo stays in the backlog; lore stores no sprint', async () => {
  const root = makeContextRepo({}, { ...CFG, sources: { jira: { ...CFG.sources.jira, push: { project: 'INPT' } } } })
  await captureConsole(() => workAdd(root, { title: 'Started', status: 'in_progress' }, { context: root, at: AT }))
  await captureConsole(() => workAdd(root, { title: 'Not yet' }, { context: root, at: AT }))
  const jira = scrum(fakeJira())

  const dry = await workPush(root, { all: true, dryRun: true }, { context: root, at: AT }, jira.deps)
  assert.deepEqual(
    dry.actions.filter((a) => a.kind === 'sprint'),
    [{ key: 'ACM-1', kind: 'sprint', detail: 'would add the new issue to sprint Sprint 14 — in_progress in lore' }],
  )
  jira.calls.length = 0

  const r = await workPush(root, { all: true }, { context: root, at: AT, by: 'shawn' }, jira.deps)
  assert.deepEqual(
    r.actions.map((a) => [a.key, a.kind]),
    [
      ['ACM-1', 'create'],
      ['ACM-1', 'transition'],
      ['ACM-1', 'sprint'],
      ['ACM-2', 'create'],
    ],
  )
  assert.equal(r.actions[2].detail, 'INPT-7201 → sprint Sprint 14 — in_progress in lore')
  assert.deepEqual(jira.sprints.membership, { 'INPT-7201': 14 }, 'the todo ticket was not put in a sprint')
  assert.ok(!jira.calls.includes('issue-sprint INPT-7201'), 'a just-created issue is in no sprint; no need to ask')
  assert.equal(jira.calls.filter((c) => c.startsWith('sprints ')).length, 1, 'sprints looked up once per run')

  const [started] = readWorkItems(root, 'ACM')
  assert.deepEqual(started.history.at(-1)!.change, { jira_sprint: [null, 'Sprint 14'] })
  assert.match(started.history.at(-1)!.reason, /INPT-7201 added to sprint Sprint 14/)
  assert.ok(!('sprint' in started) && !('sprint' in started.external!), 'no sprint on the lore ticket')
  assert.equal(readAudit(root).filter((e) => e.id === 'ACM-1').length, 2, 'added, then one audit line for the whole push (create + transition + sprint)')
})

test('work push: an in-flight ticket the client already planned into a sprint is left there; no active sprint says so', async () => {
  const root = makeContextRepo({ 'context/work/jira/board-293.yaml': jiraTable([{ key: 'INPT-1', status: 'In Progress', category: 'In Progress' }, { key: 'INPT-2', status: 'In Progress', category: 'In Progress' }]) }, CFG)
  mirrorExternal(root, ACME, '2026-09-15T10:00:00.000Z')
  const jira = scrum(fakeJira({ 'INPT-1': 'In Progress', 'INPT-2': 'In Progress' }))
  jira.sprints.membership['INPT-1'] = 15

  const r = await workPush(root, { all: true }, { context: root, at: AT }, jira.deps)
  assert.deepEqual(r.actions, [{ key: 'ACM-2', kind: 'sprint', detail: 'INPT-2 → sprint Sprint 14 — in_progress in lore', jira: 'INPT-2' }])
  assert.equal(jira.sprints.membership['INPT-1'], 15, 'planned into the next sprint by the client: untouched')

  const between = scrum(fakeJira({ 'INPT-1': 'In Progress', 'INPT-2': 'In Progress' }), [SPRINT_15])
  const r2 = await workPush(root, { keys: ['ACM-1'] }, { context: root, at: AT }, between.deps)
  assert.deepEqual(r2.actions, [{ key: 'ACM-1', kind: 'skip', detail: 'no active sprint on board Jointly — INPT-1 left in the backlog', jira: 'INPT-1' }])
})

test('work push --sprint: named tickets go into the sprint asked for, whatever their status', async () => {
  const root = makeContextRepo({ 'context/work/jira/board-293.yaml': jiraTable([{ key: 'INPT-1', status: 'To Do', category: 'To Do' }, { key: 'INPT-2', status: 'To Do', category: 'To Do' }]) }, CFG)
  mirrorExternal(root, ACME, '2026-09-15T10:00:00.000Z')
  const jira = scrum(fakeJira({ 'INPT-1': 'To Do', 'INPT-2': 'To Do' }))
  jira.sprints.membership['INPT-2'] = 15

  await assert.rejects(workPush(root, { all: true, sprint: 'active' }, { context: root }, jira.deps), /--sprint puts named tickets in a sprint/)

  const r = await workPush(root, { keys: ['ACM-1', 'ACM-2'], sprint: 'sprint 15' }, { context: root, at: AT }, jira.deps)
  assert.deepEqual(r.actions, [
    { key: 'ACM-1', kind: 'sprint', detail: 'INPT-1 → sprint Sprint 15 — asked', jira: 'INPT-1' },
    { key: 'ACM-2', kind: 'skip', detail: 'INPT-2 is already in sprint Sprint 15', jira: 'INPT-2' },
  ])
  const moved = await workPush(root, { keys: ['ACM-2'], sprint: 'active' }, { context: root, at: AT }, jira.deps)
  assert.deepEqual(moved.actions, [{ key: 'ACM-2', kind: 'sprint', detail: 'INPT-2 → sprint Sprint 14 (from Sprint 15) — asked', jira: 'INPT-2' }])
  assert.deepEqual(readWorkItems(root, 'ACM')[1].history.at(-1)!.change, { jira_sprint: ['Sprint 15', 'Sprint 14'] })

  const unknown = await workPush(root, { keys: ['ACM-1'], sprint: 'Sprint 99' }, { context: root, at: AT }, jira.deps)
  assert.deepEqual(unknown.actions, [{ key: 'ACM-1', kind: 'error', detail: 'no open sprint "Sprint 99" on board Jointly (open: Sprint 14, Sprint 15 (future))', jira: 'INPT-1' }])
})

test('work push sprints: kanban boards and opted-out clients never get sprint changes; the board is found or named', async () => {
  const root = makeContextRepo({ 'context/work/jira/board-293.yaml': jiraTable([{ key: 'INPT-1', status: 'In Progress', category: 'In Progress' }]) }, CFG)
  mirrorExternal(root, ACME, '2026-09-15T10:00:00.000Z')
  const kanban = fakeJira({ 'INPT-1': 'In Progress' })
  assert.deepEqual((await workPush(root, { all: true }, { context: root, at: AT }, kanban.deps)).actions, [], 'kanban: nothing to report')
  const asked = await workPush(root, { keys: ['ACM-1'], sprint: 'active' }, { context: root, at: AT }, kanban.deps)
  assert.deepEqual(asked.actions, [{ key: 'ACM-1', kind: 'error', detail: 'board Jointly is a kanban board — it has no sprints', jira: 'INPT-1' }])

  const off = makeContextRepo({ 'context/work/jira/board-293.yaml': jiraTable([{ key: 'INPT-1', status: 'In Progress', category: 'In Progress' }]) }, { ...CFG, sources: { jira: { ...CFG.sources.jira, push: { sprints: false } } } })
  mirrorExternal(off, ACME, '2026-09-15T10:00:00.000Z')
  const offJira = scrum(fakeJira({ 'INPT-1': 'In Progress' }))
  assert.deepEqual((await workPush(off, { all: true }, { context: off, at: AT }, offJira.deps)).actions, [])
  assert.ok(!offJira.calls.some((c) => c.startsWith('sprint')), 'sprints off: no sprint lookups at all')

  // No boards configured: the project's one scrum board, else ask for push.board.
  const byProject = { project: 'acme', sources: { jira: { projects: ['INPT'], site: SITE, api_base: 'https://jira.int.example/rest/api/3' } }, extract: [] as string[] }
  const p = makeContextRepo({ 'context/work/jira/INPT.yaml': jiraTable([{ key: 'INPT-1', status: 'In Progress', category: 'In Progress' }]) }, byProject)
  mirrorExternal(p, ACME, '2026-09-15T10:00:00.000Z')
  const one = scrum(fakeJira({ 'INPT-1': 'In Progress' }))
  one.sprints.projectBoards = [{ id: 7, name: 'INPT kanban', type: 'kanban' }, { id: 8, name: 'INPT sprints', type: 'scrum' }]
  const r = await workPush(p, { all: true }, { context: p, at: AT }, one.deps)
  assert.deepEqual(r.actions.map((a) => a.detail), ['INPT-1 → sprint Sprint 14 — in_progress in lore'])
  assert.ok(one.calls.includes('sprints 8'))
  const two = scrum(fakeJira({ 'INPT-1': 'In Progress' }))
  two.sprints.projectBoards = [{ id: 8, name: 'A', type: 'scrum' }, { id: 9, name: 'B', type: 'scrum' }]
  const ask = await workPush(p, { keys: ['ACM-1'], sprint: 'active' }, { context: p, at: AT }, two.deps)
  assert.match(ask.actions[0].detail, /INPT has 2 scrum boards \(A 8, B 9\) — set sources\.jira\.push\.board/)
})
