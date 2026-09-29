import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configSchema, loadConfig } from '../src/config.js'
import { githubProjects, projectConfigs } from '../src/connectors/github-projects.js'
import { bodyHash, fieldDirection, reconcileProjects } from '../src/projects.js'
import { projectItemAdd, projectItemMove, workAdd, workSet, workMove } from '../src/commands/project.js'
import { workAdd as addLocal, workSet as setLocal } from '../src/commands/work.js'
import { applyFoldChanges, mirrorExternal, readWorkItems, writeWorkItems } from '../src/work.js'
import { loadState } from '../src/state.js'
import { statusView } from '../src/status.js'
import { sync } from '../src/commands/sync.js'
import { createServer } from '../src/commands/mcp.js'
import { resolveContext } from '../src/context.js'
import { makeContextRepo, captureConsole } from './helpers.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const mapping = { Todo: 'todo', Doing: 'in_progress', Review: 'review', Done: 'done' }
const projectConfig = { owner: 'acme', number: 8, status_map: mapping, api_base: 'https://fixture.test/graphql' }
function repo() { return makeContextRepo({}, { project: 'acme', work: { prefix: 'ACM' }, sources: { github_projects: [projectConfig] } }) }
function rows(root: string) { return readWorkItems(root, 'ACM') }
function save(root: string, items = rows(root)) { writeWorkItems(root, 'ACM', items) }
function fake() {
  const items: any[] = []
  const calls: { query: string; variables: any }[] = []
  const state = { items, calls, fail: '', pageSize: 100, failPage: false, pageFields: false }
  const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
  const page = (nodes: any[], more = false, end: string | null = null) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: end } })
  globalThis.fetch = async (_url, init) => {
    const { query, variables: v } = JSON.parse(String(init?.body))
    calls.push({ query, variables: v })
    if (state.fail && query.includes(state.fail)) return new Response(JSON.stringify({ errors: [{ message: 'permission denied' }] }))
    if (query.includes('query ProjectIdentity')) return response({ repositoryOwner: { projectV2: { id: `P${v.number}`, title: 'Delivery', url: `https://github.com/orgs/acme/projects/${v.number}`, field: { id: 'STATUS', name: 'Status', options: Object.keys(mapping).map((name, n) => ({ name, id: String(n) })) } } } })
    if (query.includes('query ProjectItemFields')) return response({ node: { fieldValues: page([{ name: 'Team A', field: { name: 'Team' } }]) } })
    if (query.includes('query ProjectItems')) {
      assert.match(query, /archivedStates:\[ARCHIVED, NOT_ARCHIVED\]/)
      assert.doesNotMatch(query, /UPDATED_AT/)
      if (v.after && state.failPage) return new Response(JSON.stringify({ errors: [{ message: 'page failed' }] }))
      const offset = Number(v.after ?? 0)
      const projectItems = items.filter(i => (i.project ?? 'P8') === v.id)
      const selected = projectItems.slice(offset, offset + state.pageSize).map(i => ({ ...i, fieldValues: page([{ name: i.status, field: { name: 'Status' } }], state.pageFields, state.pageFields ? 'fields2' : null) }))
      const more = offset + state.pageSize < projectItems.length
      return response({ node: { items: page(selected, more, more ? String(offset + state.pageSize) : null) } })
    }
    if (query.includes('mutation AddProjectDraft')) {
      const item = makeItem(String(items.length + 1), v.title, v.body)
      item.project = v.project
      item.status = undefined // GitHub drafts start without a selected column
      items.push(item)
      assert.match(query, /projectItem \{ id \}/)
      return response({ addProjectV2DraftIssue: { projectItem: { id: item.id } } })
    }
    if (query.includes('query ProjectContent')) return response({ repository: { issueOrPullRequest: { id: 'I42' } } })
    if (query.includes('mutation AddProjectIssue')) {
      const existing = items.find(i => i.content?.id === v.content)
      const item = existing ?? makeItem('issue', 'Issue', 'Issue body', true)
      if (!existing) items.push(item)
      return response({ addProjectV2ItemById: { item: { id: item.id } } })
    }
    if (query.includes('mutation MoveProjectItem')) {
      const item = items.find(i => i.id === v.item)!
      item.status = Object.keys(mapping)[Number(v.option)]
      return response({ updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } })
    }
    if (query.includes('mutation EditProjectContent')) {
      const id = v.input.id ?? v.input.draftIssueId ?? v.input.pullRequestId
      const item = items.find(i => i.content?.id === id)!
      if (v.input.title !== undefined) item.content.title = v.input.title
      if (v.input.body !== undefined) item.content.body = v.input.body
      return response({ updated: { clientMutationId: null } })
    }
    throw new Error(`Unexpected query ${query}`)
  }
  return state
}
function makeItem(id: string, title = 'Task', body = 'Body', issue = false): any {
  return { id: `PVTI_${id}`, fullDatabaseId: id, type: issue ? 'ISSUE' : 'DRAFT_ISSUE', updatedAt: '2026-09-29T00:00:00Z', status: 'Todo',
    content: { id: issue ? 'I42' : `DI_${id}`, title, body, updatedAt: '2026-09-29T00:00:00Z', assignees: { nodes: [{ login: 'sam' }] },
      ...(issue ? { number: 42, url: 'https://github.com/acme/web/issues/42', repository: { nameWithOwner: 'acme/web' } } : {}) } }
}
async function reconcile(root: string) { await reconcileProjects(root, loadConfig(root)) }

// Pure comparison tests are backed by the end-to-end mutation tests below.
test('three-way comparison and normalized body hash', () => {
  assert.equal(fieldDirection('a', 'a', 'a'), 'none')
  assert.equal(fieldDirection('a', 'b', 'a'), 'pull')
  assert.equal(fieldDirection('b', 'a', 'a'), 'push')
  assert.equal(fieldDirection('b', 'c', 'a'), 'conflict')
  assert.equal(fieldDirection('b', 'b', 'a'), 'none')
  assert.equal(bodyHash('one  \r\n\r\n\r\ntwo\n'), bodyHash('one\n\ntwo'))
  assert.notEqual(bodyHash('- [ ] task'), bodyHash('- [x] task'))
  assert.notEqual(bodyHash('    code'), bodyHash('code'))
})

test('config accepts the brief array, validates unique mappings/projects, and requires explicit mapping', () => {
  const cfg = loadConfig(repo())
  assert.equal(projectConfigs(cfg.sources.github_projects)[0].status_field, 'Status')
  const parse = (projects: unknown) => configSchema.parse({ project: 'acme', sources: { github_projects: projects } })
  assert.throws(() => parse([{ owner: 'acme', number: 8 }]), /status_map/)
  assert.throws(() => parse([{ ...projectConfig, status_map: { A: 'todo', B: 'todo' } }]), /unique/)
  assert.throws(() => parse([{ ...projectConfig, status_map: { A: 'unknown' } }]))
  assert.throws(() => parse([projectConfig, projectConfig]), /duplicate/)
  assert.throws(() => parse([{ ...projectConfig, owner: '../../x' }]))
})

test('connector paginates items and fields, tracks content edits without timestamp changes', async () => {
  const api = fake(); api.pageSize = 1; api.pageFields = true
  api.items.push(makeItem('1'), makeItem('2'))
  const config = loadConfig(repo()).sources.github_projects
  const ctx = { config, cursor: {}, since: Date.now(), log: () => {}, readFile: () => undefined }
  const first = await githubProjects.fetch(ctx)
  assert.equal(first.docs.length, 2)
  assert.match(first.docs[0].text, /Team A/)
  assert.match(first.docs[0].text, /sam/)
  const second = await githubProjects.fetch({ ...ctx, cursor: first.nextCursor })
  assert.equal(second.docs.length, 0)
  api.items[0].content.body = 'changed without item timestamp'
  const third = await githubProjects.fetch({ ...ctx, cursor: second.nextCursor })
  assert.equal(third.docs.length, 1)
  assert.match(third.docs[0].text, /changed without/)
  assert.ok((third.nextCursor['acme/8'] as any).item_updated_ats.PVTI_1)
})

test('auto-link preserves the issue ref, seeds missing body and pushes Lore status', async () => {
  const root = repo(); const api = fake()
  api.items.push(makeItem('issue', 'Task', 'Original body', true))
  addLocal(root, { title: 'Task', status: 'review', external: 'github:acme/web#42' }, { via: 'mcp' })
  await reconcile(root)
  const row = rows(root)[0]
  assert.equal(row.external?.id, 'github:acme/web#42')
  assert.equal(row.project_items?.[0].ref, 'PVTI_issue')
  assert.equal(row.description, 'Original body')
  assert.equal(row.project_items?.[0].last_sync.body_hash, bodyHash('Original body'))
  assert.equal(api.items[0].status, 'Review')
  assert.match(statusView(root, loadConfig(root)), /1 in review/)
  assert.match(statusView(root, loadConfig(root)), /In review[\s\S]*Task/)
  assert.equal(loadState(root).conflicts?.length ?? 0, 0)
  assert.ok(row.history.some(h => h.change.project_link))
})

test('pulls project-only edits, pushes local-only edits, Lore wins conflicts with a durable ledger', async () => {
  const root = repo(); const api = fake()
  const added = await projectItemAdd(root, { project: 'acme/8', title: 'Task', body: 'Body' }, { via: 'mcp', actor: 'agent' })
  const item = api.items[0]
  const before = api.calls.filter(c => c.query.startsWith('mutation')).length
  await reconcile(root)
  assert.equal(api.calls.filter(c => c.query.startsWith('mutation')).length, before)
  item.content.title = 'Project title'; item.content.body = 'Project body'; item.status = 'Doing'
  await reconcile(root)
  assert.equal(rows(root)[0].title, 'Project title')
  assert.equal(rows(root)[0].description, 'Project body')
  assert.equal(rows(root)[0].status, 'in_progress')
  await workSet(root, added.work_id, { title: 'Lore title', description: 'Lore body' }, { reason: 'change' }, { via: 'mcp' })
  assert.equal(item.content.title, 'Lore title')
  assert.equal(item.content.body, 'Lore body')
  item.content.body = 'Their conflicting body'
  setLocal(root, added.work_id, { description: 'Our conflicting body' }, { reason: 'offline change' }, { via: 'mcp' })
  await reconcile(root)
  assert.equal(item.content.body, 'Our conflicting body')
  const conflict = loadState(root).conflicts![0]
  assert.deepEqual({ ...conflict, at: 'now' }, { at: 'now', kind: 'field-drift', project: 'acme/8', item_node_id: added.item_node_id,
    field: 'body', lore_value: 'Our conflicting body', project_value: 'Their conflicting body', resolved: 'lore' })
  await reconcile(root)
  assert.equal(loadState(root).conflicts!.length, 1)
})

test('whitespace does not cause writes; a deliberate empty body clears GitHub', async () => {
  const root = repo(); const api = fake()
  const added = await projectItemAdd(root, { project: 'acme/8', title: 'Task', body: 'one\n\ntwo' }, { via: 'mcp' })
  api.items[0].content.body = 'one  \r\n\r\n\r\ntwo\n'
  const writes = api.calls.filter(c => c.query.startsWith('mutation')).length
  await reconcile(root)
  assert.equal(api.calls.filter(c => c.query.startsWith('mutation')).length, writes)
  await workSet(root, added.work_id, { description: '' }, { reason: 'clear' }, { via: 'mcp' })
  assert.equal(api.items[0].content.body, '')
})

test('failed writes retain the local value and old ledger, then retry successfully', async () => {
  const root = repo(); const api = fake()
  const added = await projectItemAdd(root, { project: 'acme/8', title: 'Task' }, { via: 'mcp' })
  api.fail = 'mutation MoveProjectItem'
  await assert.rejects(workMove(root, added.work_id, 'done', { reason: 'ship' }, { via: 'mcp' }), /saved.*retry on sync/)
  assert.equal(rows(root)[0].status, 'done')
  assert.equal(rows(root)[0].project_items![0].last_sync.status, 'todo')
  api.fail = ''
  await reconcile(root)
  assert.equal(api.items[0].status, 'Done')
  assert.equal(rows(root)[0].project_items![0].last_sync.status, 'done')
})

test('unmapped remote status stays metadata; unmapped Lore writes fail visibly', async () => {
  const root = repo(); const api = fake()
  const added = await projectItemAdd(root, { project: 'acme/8', title: 'Task' }, { via: 'mcp' })
  api.items[0].status = 'Unmapped'
  await reconcile(root)
  assert.equal(rows(root)[0].status, 'todo')
  const files = readdirSync(join(root, 'context/streams/github-projects/acme-8'))
  assert.match(readFileSync(join(root, 'context/streams/github-projects/acme-8', files[0]), 'utf8'), /status_raw: Unmapped/)
  await assert.rejects(workMove(root, added.work_id, 'blocked', { reason: 'blocked' }, { via: 'mcp' }), /no column.*blocked/)
  assert.equal(rows(root)[0].project_items![0].last_sync.status, 'todo')
})

test('deletion only unlinks; redaction and incomplete pagination never look like deletion', async () => {
  const root = repo(); const api = fake()
  await projectItemAdd(root, { project: 'acme/8', title: 'Task' }, { via: 'mcp' })
  const original = api.items[0].content
  api.items[0].content = null
  await reconcile(root)
  assert.equal(rows(root)[0].project_items!.length, 1)
  assert.equal(rows(root)[0].title, 'Task')
  api.items[0].content = original
  api.items.push(makeItem('2')); api.pageSize = 1; api.failPage = true
  await assert.rejects(reconcile(root), /page failed/)
  assert.equal(rows(root)[0].project_items!.length, 1)
  api.failPage = false; api.items.shift()
  await reconcile(root)
  assert.equal(rows(root)[0].project_items!.length, 0)
  assert.equal(rows(root)[0].status, 'todo')
})

test('interrupted adds persist the item id and reuse the draft on retry', async () => {
  const root = repo(); const api = fake()
  api.fail = 'mutation MoveProjectItem'
  await assert.rejects(projectItemAdd(root, { project: 'acme/8', title: 'Task', status: 'done' }, { via: 'mcp' }), /link_work=ACM-1/)
  assert.equal(rows(root)[0].project_items![0].ref, 'PVTI_1')
  api.fail = ''
  const retry = await projectItemAdd(root, { project: 'acme/8', title: 'Task', status: 'done', link_work: 'ACM-1' }, { via: 'mcp' })
  assert.equal(retry.item_node_id, 'PVTI_1')
  assert.equal(api.items.length, 1)
  assert.equal(api.items[0].status, 'Done')
})

test('work-add project column, existing issue add, move by node id, and fold write-back', async () => {
  const root = repo(); const api = fake()
  const added = await workAdd(root, { title: 'Issue', external: 'github:acme/web#42', project: { owner: 'acme', number: 8, column: 'Review' } }, { via: 'mcp' })
  assert.equal(added.status, 'review')
  assert.equal(api.items[0].type, 'ISSUE')
  assert.ok(api.calls.some(c => c.query.includes('mutation AddProjectIssue')))
  await projectItemMove(root, { item: added.project_items![0].ref, status: 'done' }, { via: 'mcp' })
  assert.equal(api.items[0].status, 'Done')
  const items = rows(root)
  const result = applyFoldChanges(items, [{ key: added.key, status: 'in_progress', reason: 'reopened', sources: ['https://evidence'], confidence: 'high', evidence_date: '2099-01-01' }])
  assert.equal(result.applied.length, 1)
  save(root, items)
  await reconcile(root)
  assert.equal(api.items[0].status, 'Doing')
})

test('sync reports project mutation failures in source health and retains other progress', async () => {
  const root = repo(); const api = fake()
  await projectItemAdd(root, { project: 'acme/8', title: 'Task' }, { via: 'mcp' })
  const items = rows(root); items[0].status = 'done'; save(root, items)
  api.fail = 'mutation MoveProjectItem'
  const { result } = await captureConsole(() => sync(root))
  assert.equal(result.ok, false)
  assert.equal(result.sources.github_projects.status, 'failed')
  assert.match(loadState(root).sources!.github_projects.lastError!.message, /permission denied/)
  api.fail = ''
  assert.equal((await captureConsole(() => sync(root))).result.ok, true)
  assert.equal(rows(root)[0].project_items![0].last_sync.status, 'done')
})

test('MCP project add/move and work edits persist authenticated history; viewers cannot write', async () => {
  const root = repo(); const api = fake()
  const ctx = resolveContext(root)
  const server = createServer(ctx, { cwd: root, opts: { actor: 'midas' } })
  const client = new Client({ name: 'test', version: '0' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st); await client.connect(ct)
  try {
    const added = await client.callTool({ name: 'lore_project_item_add', arguments: { project: 'acme/8', title: 'MCP task', body: 'description' } })
    assert.notEqual(added.isError, true)
    const payload = JSON.parse((added.content as any[])[0].text)
    assert.equal(payload.work_id, 'ACM-1')
    const moved = await client.callTool({ name: 'lore_project_item_move', arguments: { item: payload.item_node_id, status: 'review' } })
    assert.notEqual(moved.isError, true)
    assert.equal(api.items[0].status, 'Review')
    const changed = await client.callTool({ name: 'lore_work_set', arguments: { key: 'ACM-1', title: 'Edited', reason: 'requested' } })
    assert.notEqual(changed.isError, true)
    assert.equal(api.items[0].content.title, 'Edited')
    assert.ok(rows(root)[0].history.some(h => h.by === 'midas' && h.via === 'mcp'))
  } finally { await client.close(); await server.close() }
  const readOnly = createServer(ctx, { cwd: root, opts: {} }, { readOnly: true })
  const viewer = new Client({ name: 'viewer', version: '0' }); const [vct, vst] = InMemoryTransport.createLinkedPair()
  await readOnly.connect(vst); await viewer.connect(vct)
  try { assert.ok(!(await viewer.listTools()).tools.some(t => t.name.startsWith('lore_project_'))) }
  finally { await viewer.close(); await readOnly.close() }
})

test('explicit same-status moves override remote drift and daily streams replace earlier item entries', async () => {
  const root = repo(); const api = fake()
  const added = await projectItemAdd(root, { project: 'acme/8', title: 'Initial title', status: 'todo' }, { via: 'mcp' })
  assert.equal(api.items[0].status, 'Todo')
  api.items[0].status = 'Done'
  await projectItemMove(root, { item: added.work_id, status: 'todo' }, { via: 'mcp' })
  assert.equal(api.items[0].status, 'Todo')
  assert.equal(rows(root)[0].status, 'todo')
  await workSet(root, added.work_id, { title: 'Current title' }, { reason: 'rename' }, { via: 'mcp' })
  const dir = join(root, 'context/streams/github-projects/acme-8')
  const stream = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')
  assert.equal((stream.match(/<!-- id: github-project-PVTI_1 /g) ?? []).length, 1)
  assert.match(stream, /Current title/)
  assert.doesNotMatch(stream, /Initial title/)
})

test('a concurrent tracker write survives an in-flight project mutation', async () => {
  const root = repo(); const api = fake()
  const added = await projectItemAdd(root, { project: 'acme/8', title: 'Task' }, { via: 'mcp' })
  const items = rows(root); items[0].status = 'done'; save(root, items)
  const fetchProject = globalThis.fetch
  let interrupted = false
  globalThis.fetch = async (url, init) => {
    if (!interrupted && String(init?.body).includes('mutation MoveProjectItem')) {
      interrupted = true
      setLocal(root, added.work_id, { description: 'Concurrent change' }, { reason: 'new evidence' }, { via: 'mcp' })
    }
    return fetchProject(url, init)
  }
  await assert.rejects(reconcile(root), /work changed during reconciliation/)
  assert.equal(rows(root)[0].description, 'Concurrent change')
  await reconcile(root)
  assert.equal(api.items[0].content.body, 'Concurrent change')
  assert.equal(rows(root)[0].project_items![0].last_sync.status, 'done')
})

test('stale GitHub issue mirrors cannot undo project title/status', async () => {
  const root = repo(); const api = fake()
  api.items.push(makeItem('issue', 'Issue title', 'Body', true))
  addLocal(root, { title: 'Issue title', external: 'github:acme/web#42' }, { via: 'mcp' })
  await reconcile(root)
  api.items[0].content.title = 'Changed on board'; api.items[0].status = 'Review'
  await reconcile(root)
  // The issue mirror was read before the board and still has an old open title.
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(root, 'context/work/github'), { recursive: true })
  writeFileSync(join(root, 'context/work/github/acme__web.yaml'), '- number: 42\n  kind: issue\n  title: Issue title\n  state: open\n  labels: []\n  url: https://github.com/acme/web/issues/42\n')
  mirrorExternal(root, loadConfig(root))
  assert.equal(rows(root)[0].status, 'review')
  assert.equal(rows(root)[0].title, 'Changed on board')
})

test('unconfigured projects and archived contexts refuse project writes before API calls', async () => {
  const root = repo(); const api = fake()
  await assert.rejects(projectItemAdd(root, { project: 'other/9', title: 'Task' }), /not an enabled project/)
  assert.equal(api.calls.length, 0)
  const config = JSON.parse(readFileSync(join(root, 'lore.json'), 'utf8'))
  config.lifecycle = 'archived'
  writeFileSync(join(root, 'lore.json'), JSON.stringify(config))
  await assert.rejects(projectItemAdd(root, { project: 'acme/8', title: 'Task' }), /archived/)
  assert.equal(api.calls.length, 0)
})

test('multiple boards keep independent links and ledgers while projecting one Lore row', async () => {
  const root = repo(); const api = fake()
  const config = JSON.parse(readFileSync(join(root, 'lore.json'), 'utf8'))
  config.sources.github_projects.push({ ...projectConfig, number: 9 })
  writeFileSync(join(root, 'lore.json'), JSON.stringify(config))
  const first = await projectItemAdd(root, { project: 'acme/8', title: 'Shared ticket' }, { via: 'mcp' })
  await projectItemAdd(root, { project: 'acme/9', title: 'Shared ticket', link_work: first.work_id }, { via: 'mcp' })
  assert.equal(rows(root).length, 1)
  assert.equal(rows(root)[0].project_items!.length, 2)
  await workMove(root, first.work_id, 'review', { reason: 'ready' }, { via: 'mcp' })
  assert.deepEqual(api.items.map(i => i.status), ['Review', 'Review'])
  assert.deepEqual(rows(root)[0].project_items!.map(i => i.last_sync.status), ['review', 'review'])
  assert.deepEqual(Object.keys(loadState(root).cursors.github_projects).sort(), ['acme/8', 'acme/9'])
})
