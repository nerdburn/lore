import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { parse } from 'yaml'
import { adfToMarkdown, jira, jqlDate, readWorkTable, type JiraIssue, type JiraWorkItem } from '../src/connectors/jira.js'
import type { ConnectorContext } from '../src/types.js'

const SITE = 'https://acme.atlassian.net'
const BASIC = 'Basic ' + Buffer.from('lore@inputlogic.ca:tok_123').toString('base64')

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const adf = (...content: object[]) => ({ type: 'doc', version: 1, content })

function issue(key: string, over: Partial<JiraIssue['fields']> = {}, id = key.replace(/\D/g, '')): JiraIssue {
  return {
    id,
    key,
    self: `${SITE}/rest/api/3/issue/${id}`,
    fields: {
      summary: `Summary ${key}`,
      description: adf(p(`Description of ${key}`)),
      status: { name: 'To Do', statusCategory: { name: 'To Do' } },
      issuetype: { name: 'Task' },
      priority: { name: 'Medium' },
      assignee: null,
      reporter: { accountId: 'acc-priya', displayName: 'Priya Patel' },
      created: '2026-08-01T10:00:00.000+0000',
      updated: '2026-08-01T10:00:00.000+0000',
      resolutiondate: null,
      labels: [],
      fixVersions: [],
      parent: null,
      ...over,
    },
  }
}

/** A fake Jira Cloud REST v3: /search/jql with tokens, /issue/{key}/comment, basic auth, 429. */
function fakeJira() {
  const state = {
    issues: [] as JiraIssue[],
    comments: {} as Record<string, { id: string; author?: { accountId: string; displayName: string }; body?: object; created: string; updated?: string }[]>,
    calls: [] as { path: string; body?: Record<string, unknown> }[],
    rateLimitOnce: false,
    pageSize: 100,
  }
  const json = (b: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    state.calls.push({ path: url.pathname + url.search, body })
    if ((init?.headers as Record<string, string>)?.Authorization !== BASIC) return json({ errorMessages: ['unauthorized'] }, { status: 401 })
    if (state.rateLimitOnce) {
      state.rateLimitOnce = false
      return json({}, { status: 429, headers: { 'retry-after': '0' } })
    }
    const path = url.pathname.replace(/^\/rest\/api\/3/, '')
    if (path === '/search/jql') {
      const jql = String(body?.jql ?? '')
      const proj = /project = "([^"]+)"/.exec(jql)?.[1]
      if (proj === 'NOPE') return json({ errorMessages: ["The value 'NOPE' does not exist for the field 'project'."] }, { status: 400 })
      let items = state.issues.filter((i) => i.key.startsWith(`${proj}-`))
      const since = /updated >= "([^"]+)"/.exec(jql)?.[1]
      if (since) items = items.filter((i) => new Date(i.fields.updated!).getTime() >= Date.parse(since.replace(' ', 'T') + ':00Z'))
      if (/statusCategory != Done/.test(jql)) items = items.filter((i) => i.fields.status?.statusCategory?.name !== 'Done')
      const start = body?.nextPageToken ? Number(body.nextPageToken) : 0
      const page = items.slice(start, start + state.pageSize)
      const isLast = start + state.pageSize >= items.length
      return json({ issues: page, isLast, ...(isLast ? {} : { nextPageToken: String(start + state.pageSize) }) })
    }
    const m = /^\/issue\/([^/]+)\/comment$/.exec(path)
    if (m) {
      const all = state.comments[m[1]] ?? []
      const startAt = Number(url.searchParams.get('startAt') ?? '0')
      return json({ comments: all.slice(startAt, startAt + 100), total: all.length, startAt, maxResults: 100 })
    }
    return json({ errorMessages: ['nf'] }, { status: 404 })
  }) as typeof fetch
  return state
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function ctx(over: Partial<ConnectorContext> = {}, files: Record<string, string> = {}): ConnectorContext {
  return {
    config: { site: SITE, email: 'lore@inputlogic.ca', token: 'tok_123', projects: ['ACM'] },
    cursor: {},
    since: Date.parse('2026-07-01T00:00:00Z'),
    log: () => {},
    readFile: (rel) => files[rel],
    ...over,
  }
}

test('jira: ADF renders to markdown', () => {
  const doc = adf(
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'strong' }] }, { type: 'text', text: ' and ' }, { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://x' } }] }, { type: 'text', text: ' ' }, { type: 'mention', attrs: { text: '@Kaity' } }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [p('one')] }, { type: 'listItem', content: [p('two'), { type: 'bulletList', content: [{ type: 'listItem', content: [p('nested')] }] }] }] },
    { type: 'codeBlock', attrs: { language: 'sh' }, content: [{ type: 'text', text: 'npm test' }] },
    { type: 'panel', attrs: { panelType: 'info' }, content: [p('note')] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: 'shipped' }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p('A')] }, { type: 'tableHeader', content: [p('B')] }] }] },
    { type: 'rule' },
  )
  const md = adfToMarkdown(doc)
  assert.match(md, /^## Scope\n\n\*\*Bold\*\* and \[link\]\(https:\/\/x\) @Kaity\n\n- one\n- two\n  - nested\n\n```sh\nnpm test\n```\n\n> note\n\n- \[x\] shipped\n\n\| A \| B \|\n\n---/)
  assert.equal(adfToMarkdown(null), '')
  assert.equal(adfToMarkdown('plain'), 'plain')
})

test('jira: jqlDate formats UTC minutes', () => {
  assert.equal(jqlDate(Date.parse('2026-09-08T14:05:00Z')), '2026-09-08 14:05')
})

test('jira: first sync seeds the work table, emits issue and comment docs with permalinks and ADF text', async () => {
  const j = fakeJira()
  j.issues = [
    issue('ACM-1', { labels: ['launch'], assignee: { accountId: 'acc-shawn', displayName: 'Shawn Adrian' }, fixVersions: [{ name: 'v1.2' }] }),
    issue('ACM-2', { status: { name: 'Done', statusCategory: { name: 'Done' } }, resolutiondate: '2026-06-01T00:00:00.000+0000', created: '2026-05-01T00:00:00.000+0000', updated: '2026-06-01T00:00:00.000+0000' }),
    issue('ACM-3', { status: { name: 'In Review', statusCategory: { name: 'In Progress' } }, updated: '2026-08-05T09:00:00.000+0000', created: '2026-05-02T00:00:00.000+0000', parent: { key: 'ACM-1' } }),
  ]
  j.comments['ACM-1'] = [
    { id: '901', author: { accountId: 'acc-kaity', displayName: 'Kaity' }, body: adf(p('On it')), created: '2026-08-02T10:00:00.000+0000' },
    { id: '900', author: { accountId: 'acc-kaity', displayName: 'Kaity' }, body: adf(p('old')), created: '2026-06-02T10:00:00.000+0000' },
  ]
  const { docs, files, nextCursor, errors } = await jira.fetch(ctx())
  assert.equal(errors, undefined)
  assert.deepEqual(docs.map((d) => d.id), ['jira-ACM-1', 'jira-ACM-3', 'jira-ACM-1-comment-901'])
  const first = docs[0]
  assert.equal(first.channel, 'ACM')
  assert.equal(first.author, 'Priya Patel')
  assert.equal(first.timestamp, '2026-08-01T10:00:00.000Z')
  assert.equal(first.permalink, `${SITE}/browse/ACM-1`)
  assert.equal(first.meta?.key, 'ACM-1')
  assert.equal(first.meta?.account, 'acc-priya')
  assert.match(first.text, /^\*\*Task ACM-1: Summary ACM-1\*\* \(To Do · priority: Medium · assignee: Shawn Adrian · labels: launch · fix: v1\.2\)\n\nDescription of ACM-1$/)
  assert.equal(docs[2].thread, 'ACM-1')
  assert.equal(docs[2].text, 'On it')
  assert.equal(docs[2].permalink, `${SITE}/browse/ACM-1?focusedCommentId=901`)
  assert.ok(!docs.some((d) => d.id.includes('comment-900')), 'comments before the window are skipped')

  const table = parse(files!['context/work/jira/ACM.yaml'].replace(/^(#.*\n)+/, '')) as JiraWorkItem[]
  assert.deepEqual(table.map((i) => [i.key, i.status, i.category, i.state]), [
    ['ACM-3', 'In Review', 'In Progress', 'open'],
    ['ACM-1', 'To Do', 'To Do', 'open'],
  ])
  assert.equal(table[0].parent, 'ACM-1')
  assert.ok(!table.some((i) => i.key === 'ACM-2'), 'done issues outside the window are not seeded')
  const c = nextCursor.ACM as { since: string; fingerprints: Record<string, string> }
  assert.deepEqual(Object.keys(c.fingerprints).sort(), ['ACM-1', 'ACM-3'])
  assert.match(files!['context/work/jira/ACM.yaml'], /^# Source-owned by Jira \(ACM\)/)
})

test('jira: a status change emits an event and updates the table; unchanged emits nothing', async () => {
  const j = fakeJira()
  j.issues = [issue('ACM-1')]
  const first = await jira.fetch(ctx())
  j.issues = [issue('ACM-1', { status: { name: 'Done', statusCategory: { name: 'Done' } }, resolutiondate: '2026-09-01T10:00:00.000+0000', updated: '2026-09-01T10:00:00.000+0000' })]
  const cursor = { ACM: { ...(first.nextCursor.ACM as object), since: '2026-08-15T00:00:00Z' } }
  const second = await jira.fetch(ctx({ cursor }, first.files!))
  assert.deepEqual(second.docs.map((d) => d.id), ['jira-ACM-1@2026-09-01T10:00:00.000Z'])
  assert.match(second.docs[0].text, /^Task ACM-1 "Summary ACM-1" is now: Done · priority: Medium$/)
  const table = parse(second.files!['context/work/jira/ACM.yaml'].replace(/^(#.*\n)+/, '')) as JiraWorkItem[]
  assert.deepEqual(table.map((i) => [i.key, i.state, i.resolved]), [['ACM-1', 'closed', '2026-09-01T10:00:00.000Z']])
  const third = await jira.fetch(ctx({ cursor: { ACM: { ...(second.nextCursor.ACM as object), since: '2026-08-15T00:00:00Z' } } }, second.files!))
  assert.deepEqual(third.docs, [])
  assert.equal((parse(third.files!['context/work/jira/ACM.yaml'].replace(/^(#.*\n)+/, '')) as unknown[]).length, 1, 'table carried over')
})

test('jira: pagination via nextPageToken; include narrows to issues; 429 is retried', async () => {
  const j = fakeJira()
  j.pageSize = 2
  j.issues = [issue('ACM-1'), issue('ACM-2'), issue('ACM-3'), issue('ACM-4'), issue('ACM-5')]
  j.comments['ACM-1'] = [{ id: '1', body: adf(p('x')), created: '2026-08-02T00:00:00.000+0000' }]
  j.rateLimitOnce = true
  const { docs } = await jira.fetch(ctx({ config: { site: SITE, email: 'lore@inputlogic.ca', token: 'tok_123', projects: ['ACM'], include: ['issues'] } }))
  assert.equal(docs.length, 5)
  assert.ok(!j.calls.some((c) => c.path.includes('/comment')))
})

test('jira: api_base proxy without credentials; site kept for permalinks', async () => {
  const j = fakeJira()
  j.issues = [issue('ACM-1')]
  const inner = globalThis.fetch
  const seen: { url: string; auth?: string }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), auth: (init?.headers as Record<string, string>)?.Authorization })
    return inner(String(input).replace('https://jira.int.exe.xyz/rest/api/3', `${SITE}/rest/api/3`), { ...init, headers: { ...(init?.headers as Record<string, string>), Authorization: BASIC } })
  }) as typeof fetch
  const { docs } = await jira.fetch(ctx({ config: { api_base: 'https://jira.int.exe.xyz/rest/api/3', projects: ['ACM'], include: ['issues'] } }))
  assert.equal(docs[0].permalink, `${SITE}/browse/ACM-1`, 'derived from the issue self URL when no site is configured')
  assert.ok(seen.every((c) => c.url.startsWith('https://jira.int.exe.xyz/rest/api/3/') && c.auth === undefined))
  await assert.rejects(jira.fetch(ctx({ config: { site: SITE, projects: ['ACM'] } })), /no credentials/)
  await assert.rejects(jira.fetch(ctx({ config: { email: 'e', token: 't', projects: ['ACM'] } })), /set site/)
})

test('jira: an unknown project is a reported error; other projects still sync; bad auth fails the source', async () => {
  const j = fakeJira()
  j.issues = [issue('ACM-1')]
  const { docs, errors } = await jira.fetch(ctx({ config: { site: SITE, email: 'lore@inputlogic.ca', token: 'tok_123', projects: ['ACM', 'NOPE'], include: ['issues'] } }))
  assert.equal(docs.length, 1)
  assert.equal(errors?.length, 1)
  assert.match(errors![0], /project NOPE: jira 400/)
  await assert.rejects(jira.fetch(ctx({ config: { site: SITE, email: 'x', token: 'wrong', projects: ['ACM'] } })), /jira 401/)
  assert.deepEqual(readWorkTable(undefined), [])
  assert.deepEqual(readWorkTable('not: a list'), [])
})
