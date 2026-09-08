import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { parse } from 'yaml'
import { github, nextLink, readWorkTable, type WorkItem } from '../src/connectors/github.js'
import type { ConnectorContext } from '../src/types.js'

/** A fake GitHub REST API. Tests fill `repos[owner/repo]` with fixtures. */
interface Repo {
  issues: Record<string, unknown>[]
  comments?: Record<string, unknown>[]
  reviewComments?: Record<string, unknown>[]
  reviews?: Record<number, Record<string, unknown>[]>
  commits?: Record<string, unknown>[]
  releases?: Record<string, unknown>[]
}

function fakeGithub() {
  const state = {
    repos: {} as Record<string, Repo>,
    calls: [] as string[],
    rateLimitOnce: false,
    unauthorized: false,
  }
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
  const sinceFilter = (items: Record<string, unknown>[], since: string | null, field = 'updated_at') =>
    since ? items.filter((i) => String(i[field]) >= since) : items

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    state.calls.push(url.pathname + url.search)
    const auth = (init?.headers as Record<string, string>)?.Authorization
    if (state.unauthorized || auth !== 'Bearer ghp_test') return json({ message: 'Bad credentials' }, { status: 401 })
    if (state.rateLimitOnce) {
      state.rateLimitOnce = false
      return json({ message: 'rate limited' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '0' } })
    }
    const m = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(url.pathname)
    if (!m) return json({ message: 'Not Found' }, { status: 404 })
    const repo = state.repos[m[1]]
    if (!repo) return json({ message: 'Not Found' }, { status: 404 })
    const since = url.searchParams.get('since')
    const page = Number(url.searchParams.get('page') ?? '1')
    const per = Number(url.searchParams.get('per_page') ?? '30')
    const paged = (items: Record<string, unknown>[]) => {
      const slice = items.slice((page - 1) * per, page * per)
      const headers: Record<string, string> = {}
      if (items.length > page * per) {
        const next = new URL(url)
        next.searchParams.set('page', String(page + 1))
        headers.link = `<${next}>; rel="next", <${next}>; rel="last"`
      }
      return json(slice, { headers })
    }
    switch (true) {
      case m[2] === 'issues': {
        const st = url.searchParams.get('state')
        let items = repo.issues
        if (st === 'open') items = items.filter((i) => i.state === 'open')
        return paged(sinceFilter(items, since))
      }
      case m[2] === 'issues/comments':
        return paged(sinceFilter(repo.comments ?? [], since))
      case m[2] === 'pulls/comments':
        return paged(sinceFilter(repo.reviewComments ?? [], since))
      case /^pulls\/\d+\/reviews$/.test(m[2]):
        return paged(repo.reviews?.[Number(m[2].split('/')[1])] ?? [])
      case m[2] === 'commits':
        return paged(sinceFilter(repo.commits ?? [], since, 'committed'))
      case m[2] === 'releases':
        return json(repo.releases ?? [])
      default:
        return json({ message: 'Not Found' }, { status: 404 })
    }
  }) as typeof fetch
  return state
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const user = (login: string, id = 1) => ({ login, id })
const issue = (n: number, over: Record<string, unknown> = {}) => ({
  number: n,
  node_id: `I_${n}`,
  title: `Issue ${n}`,
  body: `Body of ${n}`,
  state: 'open',
  user: user('priya', 10),
  labels: [],
  assignees: [],
  milestone: null,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  closed_at: null,
  html_url: `https://github.com/acme/web/issues/${n}`,
  ...over,
})
const pr = (n: number, over: Record<string, unknown> = {}) =>
  issue(n, { title: `PR ${n}`, pull_request: { merged_at: null }, html_url: `https://github.com/acme/web/pull/${n}`, ...over })

function ctx(over: Partial<ConnectorContext> = {}, files: Record<string, string> = {}): ConnectorContext {
  return {
    config: { token: 'ghp_test', repos: ['acme/web'] },
    cursor: {},
    since: Date.parse('2026-07-01T00:00:00Z'),
    log: () => {},
    readFile: (rel) => files[rel],
    ...over,
  }
}

test('github: first sync emits issue/PR/comment/review/commit/release docs with stable ids', async () => {
  const g = fakeGithub()
  g.repos['acme/web'] = {
    issues: [
      issue(1, { labels: [{ name: 'bug' }], assignees: [user('shawn', 20)], milestone: { title: 'Launch' } }),
      pr(2, { draft: true, updated_at: '2026-08-02T10:00:00Z' }),
    ],
    comments: [{ id: 501, node_id: 'IC_501', user: user('shawn', 20), body: 'On it', created_at: '2026-08-01T11:00:00Z', updated_at: '2026-08-01T11:00:00Z', html_url: 'https://github.com/acme/web/issues/1#issuecomment-501', issue_url: 'https://api.github.com/repos/acme/web/issues/1' }],
    reviewComments: [{ id: 601, node_id: 'PRRC_601', user: user('priya', 10), body: 'nit', path: 'src/a.ts', created_at: '2026-08-02T11:00:00Z', updated_at: '2026-08-02T11:00:00Z', html_url: 'https://github.com/acme/web/pull/2#discussion_r601', pull_request_url: 'https://api.github.com/repos/acme/web/pulls/2' }],
    reviews: { 2: [
      { id: 701, node_id: 'PRR_701', user: user('priya', 10), body: 'LGTM', state: 'APPROVED', submitted_at: '2026-08-02T12:00:00Z', html_url: 'https://github.com/acme/web/pull/2#pullrequestreview-701' },
      { id: 702, node_id: 'PRR_702', user: user('priya', 10), body: '', state: 'COMMENTED', submitted_at: '2026-08-02T12:01:00Z', html_url: 'x' },
    ] },
    commits: [{ sha: 'abcdef1234567890', html_url: 'https://github.com/acme/web/commit/abcdef1', author: user('shawn', 20), commit: { message: 'fix: thing\n\ndetails', author: { name: 'Shawn', date: '2026-08-03T09:00:00Z' }, committer: { date: '2026-08-03T09:00:00Z' } }, committed: '2026-08-03T09:00:00Z' }],
    releases: [
      { id: 801, node_id: 'RE_801', tag_name: 'v1.2.0', name: 'Launch', body: 'notes', prerelease: false, published_at: '2026-08-04T09:00:00Z', html_url: 'https://github.com/acme/web/releases/tag/v1.2.0', author: user('shawn', 20) },
      { id: 800, node_id: 'RE_800', tag_name: 'v1.1.0', prerelease: false, published_at: '2026-06-01T09:00:00Z', html_url: 'old' },
    ],
  }
  const { docs, nextCursor, errors, files } = await github.fetch(ctx())
  assert.equal(errors, undefined)
  assert.deepEqual(
    docs.map((d) => d.id),
    [
      'github-acme/web-issue-1',
      'github-acme/web-pr-2',
      'github-acme/web-review-701',
      'github-acme/web-comment-501',
      'github-acme/web-review-comment-601',
      'github-acme/web-commit-abcdef123456',
      'github-acme/web-release-801',
    ],
  )
  const first = docs[0]
  assert.equal(first.channel, 'acme/web')
  assert.equal(first.author, 'priya')
  assert.equal(first.timestamp, '2026-08-01T10:00:00Z')
  assert.equal(first.permalink, 'https://github.com/acme/web/issues/1')
  assert.deepEqual(first.meta, { repo: 'acme/web', number: '1', node: 'I_1', type: 'issue', state: 'open', login: 'priya', user_id: '10' })
  assert.match(first.text, /^\*\*Issue #1: Issue 1\*\* \(open · labels: bug · assignees: shawn · milestone: Launch\)\n\nBody of 1$/)
  assert.match(docs[1].text, /^\*\*PR #2: PR 2\*\* \(open, draft\)/)
  assert.equal(docs[2].thread, 'pr-2')
  assert.match(docs[2].text, /approved\n\nLGTM/)
  assert.equal(docs[3].thread, 'issue-1')
  assert.equal(docs[4].thread, 'pr-2')
  assert.match(docs[4].text, /^`src\/a\.ts`: nit$/)
  assert.match(docs[5].text, /^Commit abcdef1: fix: thing/)
  assert.equal(docs[5].meta?.sha, 'abcdef1234567890')
  assert.match(docs[6].text, /^Release v1\.2\.0 — Launch\n\nnotes$/)

  const c = nextCursor['acme/web'] as { since: string; fingerprints: Record<string, string> }
  assert.ok(Date.parse(c.since) > Date.now() - 60_000)
  assert.deepEqual(Object.keys(c.fingerprints), ['1', '2'])

  const table = parse(files!['context/work/github/acme__web.yaml'].replace(/^(#.*\n)+/, '')) as WorkItem[]
  assert.deepEqual(table.map((i) => [i.number, i.type, i.state, i.merged]), [[2, 'pr', 'open', false], [1, 'issue', 'open', undefined]])
  assert.deepEqual(table[1].labels, ['bug'])
  assert.equal(table[1].milestone, 'Launch')
  assert.match(files!['context/work/github/acme__web.yaml'], /^# Source-owned by GitHub/)
})

test('github: first sync seeds the work table with old open issues outside the backfill window', async () => {
  const g = fakeGithub()
  g.repos['acme/web'] = {
    issues: [issue(1, { created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' }), issue(2, { updated_at: '2026-08-01T00:00:00Z' })],
  }
  const { docs, files } = await github.fetch(ctx())
  const table = parse(files!['context/work/github/acme__web.yaml'].replace(/^(#.*\n)+/, '')) as WorkItem[]
  assert.deepEqual(table.map((i) => i.number).sort(), [1, 2])
  assert.deepEqual(docs.map((d) => d.id).sort(), ['github-acme/web-issue-1', 'github-acme/web-issue-2'], 'seeded items get an opened doc too')
})

test('github: a state change emits an event doc and updates the table; unchanged items emit nothing', async () => {
  const g = fakeGithub()
  g.repos['acme/web'] = { issues: [issue(1), pr(2)] }
  const first = await github.fetch(ctx())
  assert.equal(first.docs.length, 2)

  g.repos['acme/web'].issues = [
    issue(1, { state: 'closed', closed_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z', labels: [{ name: 'done' }] }),
    pr(2, { state: 'closed', updated_at: '2026-09-02T10:00:00Z', pull_request: { merged_at: '2026-09-02T10:00:00Z' } }),
  ]
  const files = first.files!
  // The connector stamps the cursor with the real clock; pin it so the fixture dates fall inside the window.
  const cursor = { 'acme/web': { ...(first.nextCursor['acme/web'] as object), since: '2026-08-15T00:00:00Z' } }
  const second = await github.fetch(ctx({ cursor }, files))
  assert.deepEqual(second.docs.map((d) => d.id), ['github-acme/web-issue-1@2026-09-01T10:00:00Z', 'github-acme/web-pr-2@2026-09-02T10:00:00Z'])
  assert.equal(second.docs[0].thread, 'issue-1')
  assert.match(second.docs[0].text, /^Issue #1 "Issue 1" is now: closed · labels: done$/)
  assert.match(second.docs[1].text, /^PR #2 "PR 2" is now: merged$/)
  const table = parse(second.files!['context/work/github/acme__web.yaml'].replace(/^(#.*\n)+/, '')) as WorkItem[]
  assert.deepEqual(table.map((i) => [i.number, i.state, i.merged]), [[2, 'closed', true], [1, 'closed', undefined]])

  // Nothing changed → no docs, table preserved from file.
  const cursor2 = { 'acme/web': { ...(second.nextCursor['acme/web'] as object), since: '2026-08-15T00:00:00Z' } }
  const third = await github.fetch(ctx({ cursor: cursor2 }, second.files!))
  assert.deepEqual(third.docs, [])
  const kept = parse(third.files!['context/work/github/acme__web.yaml'].replace(/^(#.*\n)+/, '')) as WorkItem[]
  assert.equal(kept.length, 2, 'items not returned by the API are carried over from the previous table')
})

test('github: reopened issue is reflected', async () => {
  const g = fakeGithub()
  g.repos['acme/web'] = { issues: [issue(1, { state: 'closed', closed_at: '2026-08-01T10:00:00Z' })] }
  const first = await github.fetch(ctx())
  g.repos['acme/web'].issues = [issue(1, { state: 'open', closed_at: null, updated_at: '2026-09-01T00:00:00Z' })]
  const cursor = { 'acme/web': { ...(first.nextCursor['acme/web'] as object), since: '2026-08-15T00:00:00Z' } }
  const second = await github.fetch(ctx({ cursor }, first.files!))
  assert.match(second.docs[0].text, /is now: open$/)
  const table = parse(second.files!['context/work/github/acme__web.yaml'].replace(/^(#.*\n)+/, '')) as WorkItem[]
  assert.equal(table[0].state, 'open')
  assert.equal(table[0].closed_at, undefined)
})

test('github: incremental sync asks for updates since cursor minus overlap', async () => {
  const g = fakeGithub()
  g.repos['acme/web'] = { issues: [] }
  const cursor = { 'acme/web': { since: '2026-09-05T00:00:00.000Z', fingerprints: {} } }
  await github.fetch(ctx({ cursor, config: { token: 'ghp_test', repos: ['acme/web'], overlap_days: 2 } }))
  const issuesCall = g.calls.find((c) => c.startsWith('/repos/acme/web/issues?'))!
  assert.match(issuesCall, /since=2026-09-03T00%3A00%3A00\.000Z/)
  assert.ok(!g.calls.some((c) => c.includes('state=open')), 'no seed pass after the first sync')
})

test('github: include narrows what is fetched', async () => {
  const g = fakeGithub()
  g.repos['acme/web'] = { issues: [issue(1)], commits: [] }
  await github.fetch(ctx({ config: { token: 'ghp_test', repos: ['acme/web'], include: ['commits'] } }))
  assert.ok(g.calls.every((c) => c.includes('/commits')), g.calls.join('\n'))
})

test('github: pagination follows Link headers', async () => {
  const g = fakeGithub()
  g.repos['acme/web'] = { issues: Array.from({ length: 250 }, (_, i) => issue(i + 1)) }
  const { docs } = await github.fetch(ctx({ config: { token: 'ghp_test', repos: ['acme/web'], include: ['issues'] } }))
  assert.equal(docs.length, 250)
  assert.equal(nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'), 'https://api.github.com/x?page=2')
  assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), undefined)
  assert.equal(nextLink(null), undefined)
})

test('github: an inaccessible repo is a reported error; other repos still sync', async () => {
  const g = fakeGithub()
  g.repos['acme/web'] = { issues: [issue(1)] }
  const { docs, errors, nextCursor } = await github.fetch(ctx({ config: { token: 'ghp_test', repos: ['acme/web', 'acme/missing'] } }))
  assert.equal(docs.length, 1)
  assert.equal(errors?.length, 1)
  assert.match(errors![0], /acme\/missing not found or token lacks access/)
  assert.equal(nextCursor['acme/missing'], undefined)
})

test('github: bad credentials fail the whole source', async () => {
  const g = fakeGithub()
  g.repos['acme/web'] = { issues: [] }
  await assert.rejects(github.fetch(ctx({ config: { token: 'wrong', repos: ['acme/web'] } })), /github 401/)
})

test('github: waits out a rate limit and retries', async () => {
  const g = fakeGithub()
  g.repos['acme/web'] = { issues: [issue(1)] }
  g.rateLimitOnce = true
  const { docs } = await github.fetch(ctx({ config: { token: 'ghp_test', repos: ['acme/web'], include: ['issues'] } }))
  assert.equal(docs.length, 1)
})

test('github: readWorkTable tolerates missing or malformed files', () => {
  assert.deepEqual(readWorkTable(undefined), [])
  assert.deepEqual(readWorkTable('# header only\n'), [])
  assert.deepEqual(readWorkTable('not: a list'), [])
  assert.equal(readWorkTable('# h\n- number: 3\n  title: x\n')[0].number, 3)
})
