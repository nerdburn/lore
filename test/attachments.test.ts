import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, test } from 'node:test'
import { importAttachments, readAttachments, removeAttachment } from '../src/attachments.js'
import { createBlobStore, writeHashed } from '../src/blobs.js'
import { parseStreamFile, ticketThread } from '../src/comments.js'
import { embeddedMedia } from '../src/connectors/github.js'
import { linear, readWorkTable as readLinearTable, uploadLinks } from '../src/connectors/linear.js'
import type { Connector, RemoteAttachment } from '../src/types.js'
import { mirrorExternal, readWorkItems } from '../src/work.js'
import { ACME, captureConsole, makeContextRepo } from './helpers.js'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// ---- the store ----

test('blobs: the R2 tier is written through the Worker once, and a cold cache refills from it, verified', async () => {
  const remote = new Map<string, Buffer>()
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const key = url.pathname.replace('/b/', '')
    calls.push(`${init?.method ?? 'GET'} ${key.slice(0, 6)}`)
    if (init?.method === 'HEAD') return new Response(null, { status: remote.has(key) ? 200 : 404 })
    if (init?.method === 'PUT') {
      const chunks: Buffer[] = []
      for await (const c of init.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c))
      remote.set(key, Buffer.concat(chunks))
      return new Response(null, { status: 201 })
    }
    const b = remote.get(key)
    return b ? new Response(b) : new Response('nf', { status: 404 })
  }) as typeof fetch

  const bytes = Buffer.from('a recording, notionally')
  const a = createBlobStore({ dir: mkdtempSync(join(tmpdir(), 'lore-blobs-')), api: 'https://r2.int.example', fetchImpl })
  const got = await writeHashed(Readable.from([bytes]), a.dir)
  assert.equal(got.sha, sha(bytes))
  await a.put(got.tmp, got.sha, 'video/mp4')
  assert.deepEqual(remote.get(got.sha), bytes)
  assert.ok(existsSync((await a.path(got.sha))!))

  // Another host (or a wiped cache): the file comes back from R2.
  const b = createBlobStore({ dir: mkdtempSync(join(tmpdir(), 'lore-blobs-')), api: 'https://r2.int.example', fetchImpl })
  assert.deepEqual(readFileSync((await b.path(got.sha))!), bytes)
  // A second put of the same bytes does not upload again.
  const again = await writeHashed(Readable.from([bytes]), b.dir)
  await b.put(again.tmp, again.sha, 'video/mp4')
  assert.equal(calls.filter((c) => c.startsWith('PUT')).length, 1)

  // What comes back must be what the name says.
  remote.set('f'.repeat(64), Buffer.from('not what you asked for'))
  await assert.rejects(b.path('f'.repeat(64)), /different content/)
  assert.equal(await b.path('../../etc/passwd'), undefined)
})

test('blobs: a stream past the cap is refused and leaves nothing behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-blobs-'))
  await assert.rejects(writeHashed(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), dir, 1000), /larger than/)
})

// ---- import on sync ----

function fakeTracker(files: Record<string, { name: string; bytes?: Buffer; size?: number; mime?: string }[]>): Connector & { downloads: string[] } {
  const downloads: string[] = []
  return {
    name: 'jira',
    downloads,
    async fetch() {
      return { docs: [], nextCursor: {} }
    },
    async attachments(_ctx, refs) {
      const out: RemoteAttachment[] = []
      for (const ref of refs) for (const [i, f] of (files[ref] ?? []).entries()) out.push({ ref, sourceId: `${ref}-${i}`, name: f.name, url: `https://jira.example/att/${ref}/${i}`, size: f.size ?? f.bytes?.length, mime: f.mime, author: 'Priya' })
      return out
    },
    async download(_ctx, att) {
      downloads.push(att.name)
      const [ref, i] = att.sourceId.split(/-(?=\d+$)/)
      return new Response(files[ref][Number(i)].bytes!)
    },
  } as Connector & { downloads: string[] }
}

const jiraTable = (rows: { key: string; category: string }[]) =>
  rows
    .map(
      (r) => `- key: ${r.key}
  type: Story
  title: ${r.key} title
  status: ${r.category}
  category: ${r.category}
  state: ${r.category === 'Done' ? 'closed' : 'open'}
  labels: []
  fix_versions: []
  created: 2026-09-01T00:00:00Z
  updated: 2026-09-10T00:00:00Z
  url: https://acme.atlassian.net/browse/${r.key}
`,
    )
    .join('')

test('attachments import: files on open linked tickets are stored and recorded once; oversize ones are linked; closed tickets are left alone', async () => {
  const root = makeContextRepo({ 'context/work/jira/ACM.yaml': jiraTable([{ key: 'ACM-7', category: 'To Do' }, { key: 'ACM-8', category: 'In Progress' }]) }, { ...ACME, sources: { jira: { projects: ['ACM'], site: 'https://acme.atlassian.net' } } })
  mirrorExternal(root, ACME)
  const shot = Buffer.from('screenshot bytes')
  const tracker = fakeTracker({
    'jira:ACM-7': [{ name: 'shot.png', bytes: shot, mime: 'image/png' }, { name: 'walkthrough.mov', size: 500 * 1024 * 1024 }],
    'jira:ACM-8': [{ name: 'notes.txt', bytes: Buffer.from('hello') }],
  })
  const store = createBlobStore({ dir: mkdtempSync(join(tmpdir(), 'lore-blobs-')) })
  const cfg = () => ({})
  const r = await importAttachments(root, ACME as never, { jira: tracker }, store, cfg)
  assert.deepEqual(r, { imported: 2, skipped: 1, errors: [] })
  const recs = readAttachments(root)
  const byName = Object.fromEntries(recs.map((x) => [x.name, x]))
  assert.equal(byName['shot.png'].sha256, sha(shot))
  assert.equal(byName['shot.png'].source, 'jira')
  assert.equal(byName['shot.png'].by, 'Priya')
  assert.equal(byName['shot.png'].source_url, 'https://acme.atlassian.net/browse/ACM-7')
  assert.equal(byName['notes.txt'].type, 'text/plain')
  assert.equal(byName['walkthrough.mov'].sha256, undefined)
  assert.match(byName['walkthrough.mov'].skipped!, /larger than 100 MB/)
  assert.ok(existsSync((await store.path(sha(shot)))!))

  // A re-scan downloads nothing new.
  const again = await importAttachments(root, ACME as never, { jira: tracker }, store, cfg)
  assert.deepEqual(again, { imported: 0, skipped: 0, errors: [] })
  assert.deepEqual(tracker.downloads, ['shot.png', 'notes.txt'])

  // Closed in the tracker → closed in lore → not scanned.
  writeFileSync(join(root, 'context/work/jira/ACM.yaml'), jiraTable([{ key: 'ACM-7', category: 'Done' }, { key: 'ACM-8', category: 'Done' }]))
  mirrorExternal(root, ACME)
  const closed = fakeTracker({ 'jira:ACM-7': [{ name: 'late.png', bytes: Buffer.from('x') }] })
  assert.deepEqual(await importAttachments(root, ACME as never, { jira: closed }, store, cfg), { imported: 0, skipped: 0, errors: [] })
})

test('attachments import: a file someone removed from the ticket is not imported again', async () => {
  const root = makeContextRepo({ 'context/work/jira/ACM.yaml': jiraTable([{ key: 'ACM-7', category: 'To Do' }]) }, { ...ACME, sources: { jira: { projects: ['ACM'], site: 'https://acme.atlassian.net', api_base: 'https://jira.int.example/rest/api/3' } } })
  mirrorExternal(root, ACME)
  const tracker = fakeTracker({ 'jira:ACM-7': [{ name: 'noise.png', bytes: Buffer.from('noise') }] })
  const store = createBlobStore({ dir: mkdtempSync(join(tmpdir(), 'lore-blobs-')) })
  await importAttachments(root, ACME as never, { jira: tracker }, store, () => ({}))
  const [rec] = readAttachments(root)
  await captureConsole(() => removeAttachment(root, 'ACM-1', { sha256: rec.sha256 }, { context: root, by: 'shawn' }))
  assert.deepEqual(readAttachments(root)[0].removed?.by, 'shawn')
  const again = await importAttachments(root, ACME as never, { jira: tracker }, store, () => ({}))
  assert.deepEqual(again, { imported: 0, skipped: 0, errors: [] })
  assert.equal(readAttachments(root).length, 1)
  assert.deepEqual(readWorkItems(root, 'ACM')[0].history.at(-1)!.change, { detached: ['noise.png', null] })
})

test('attachments import: a failed download is reported and retried next time, never fatal', async () => {
  const root = makeContextRepo({ 'context/work/jira/ACM.yaml': jiraTable([{ key: 'ACM-7', category: 'To Do' }]) }, { ...ACME, sources: { jira: { projects: ['ACM'], site: 'https://acme.atlassian.net' } } })
  mirrorExternal(root, ACME)
  const tracker = fakeTracker({ 'jira:ACM-7': [{ name: 'shot.png', bytes: Buffer.from('x') }] })
  tracker.download = async () => new Response('gone', { status: 502 })
  const store = createBlobStore({ dir: mkdtempSync(join(tmpdir(), 'lore-blobs-')) })
  const r = await importAttachments(root, ACME as never, { jira: tracker }, store, () => ({}))
  assert.equal(r.imported, 0)
  assert.match(r.errors[0], /ACM-1 shot.png: download 502/)
  assert.deepEqual(readAttachments(root), [], 'nothing recorded, so the next sync tries again')
})

// ---- comment threads ----

test('comments: a ticket\'s thread merges board comments with the linked Jira issue\'s streamed comments, leaving out state changes', () => {
  const root = makeContextRepo({
    'context/streams/board/ACM-1/2026-09-20.md': `---\nsource: board\n---\n\n### jane@acme.com — 2026-09-20T10:00:00.000Z\n<!-- id: board-ACM-1-a thread: ACM-1 ticket: ACM-1 -->\n\nCan we ship Friday?\n`,
    'context/streams/jira/Jointly/2026-09-19.md': `---\nsource: jira\n---\n\n### Priya — 2026-09-19T09:00:00.000Z\n<!-- id: jira-INPT-7-comment-1 thread: INPT-7 project: INPT comment: 1 -->\n[permalink](https://acme.atlassian.net/browse/INPT-7?focusedCommentId=1)\n\nLooks good.\n\n### jira — 2026-09-19T11:00:00.000Z\n<!-- id: jira-INPT-7@x thread: INPT-7 project: INPT -->\n\nStory INPT-7 is now: Done\n\n### Sam — 2026-09-19T12:00:00.000Z\n<!-- id: jira-INPT-70-comment-2 thread: INPT-70 comment: 2 -->\n\nother issue\n`,
  })
  const bare = join(mkdtempSync(join(tmpdir(), 'lore-bare-')), 'x.git')
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'x'])
  execFileSync('git', ['clone', '-q', '--bare', root, bare])
  const thread = ticketThread(bare, { key: 'ACM-1', external: { system: 'jira', id: 'jira:INPT-7', key: 'INPT-7', url: '', status: 'Done', category: 'Done' } })
  assert.deepEqual(
    thread.map((c) => [c.author, c.source, c.body, c.url ?? null]),
    [
      ['Priya', 'jira', 'Looks good.', 'https://acme.atlassian.net/browse/INPT-7?focusedCommentId=1'],
      ['jane@acme.com', 'board', 'Can we ship Friday?', null],
    ],
  )
  assert.equal(parseStreamFile('---\n---\n').length, 0)
})

// ---- Linear ----

function fakeLinear(state: { issues: any[]; comments: any[]; calls: { query: string; variables: any }[] }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://linear-uploads.int.example/')) return new Response(Buffer.from(`bytes of ${url.split('/').pop()}`))
    const { query, variables } = JSON.parse(String(init?.body))
    state.calls.push({ query, variables })
    if ((init?.headers as Record<string, string>).Authorization !== 'lin_api_test') return new Response(JSON.stringify({ errors: [{ message: 'auth' }] }), { status: 401 })
    const page = (nodes: any[]) => ({ nodes, pageInfo: { hasNextPage: false } })
    if (/issue\(id:/.test(query)) return Response.json({ data: { issue: state.issues.find((i) => i.identifier === variables.id) ?? null } })
    if (/comments\(filter/.test(query)) return Response.json({ data: { comments: page(state.comments) } })
    const f = variables.filter
    let items = state.issues
    if (f.state) items = items.filter((i) => !['completed', 'canceled'].includes(i.state.type))
    if (f.updatedAt) items = items.filter((i) => i.updatedAt >= f.updatedAt.gte)
    return Response.json({ data: { issues: page(items) } })
  }) as typeof fetch
}

const lin = (id: string, over: Record<string, unknown> = {}) => ({
  id: `uuid-${id}`,
  identifier: id,
  title: `Title ${id}`,
  description: `Body of ${id}`,
  url: `https://linear.app/purposely/issue/${id}`,
  priority: 2,
  priorityLabel: 'High',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  state: { name: 'Todo', type: 'unstarted' },
  assignee: { name: 'Giordano Temple' },
  creator: { name: 'Giordano Temple' },
  labels: { nodes: [{ name: 'Bug' }] },
  ...over,
})

test('linear: open issues seed the table and the tracker; comments and state changes stream; status maps like Jira', async () => {
  const state = {
    issues: [lin('PRP-1'), lin('PRP-2', { state: { name: 'In Progress', type: 'started' } }), lin('PRP-3', { state: { name: 'Done', type: 'completed' } })],
    comments: [{ id: 'c1', body: 'Ship it', createdAt: '2026-09-02T10:00:00.000Z', url: 'https://linear.app/purposely/issue/PRP-1#comment-c1', user: { name: 'Sam' }, issue: { identifier: 'PRP-1' } }],
    calls: [] as { query: string; variables: any }[],
  }
  fakeLinear(state)
  const cfg = { teams: ['PRP'], token: 'lin_api_test' }
  const files: Record<string, string> = {}
  const r = await linear.fetch({ config: cfg, cursor: {}, since: Date.parse('2026-08-01'), log: () => {}, readFile: (p) => files[p] })
  const table = readLinearTable(r.files!['context/work/linear/PRP.yaml'])
  assert.deepEqual(
    table.map((i) => [i.key, i.status, i.category, i.state, i.priority, i.assignee]),
    [
      ['PRP-1', 'Todo', 'unstarted', 'open', 'High', 'Giordano Temple'],
      ['PRP-2', 'In Progress', 'started', 'open', 'High', 'Giordano Temple'],
      ['PRP-3', 'Done', 'completed', 'closed', 'High', 'Giordano Temple'],
    ],
  )
  assert.ok(r.docs.find((d) => d.id === 'linear-PRP-1')!.text.startsWith('**PRP-1: Title PRP-1**'))
  assert.equal(r.docs.find((d) => d.id === 'linear-comment-c1')!.thread, 'PRP-1')

  const root = makeContextRepo({ 'context/work/linear/PRP.yaml': r.files!['context/work/linear/PRP.yaml'] }, { project: 'purposely', client: { name: 'Purposely', domains: [] }, sources: {} })
  mirrorExternal(root, { project: 'purposely', client: { name: 'Purposely', domains: [], contacts: [] } })
  const items = readWorkItems(root, 'PUR')
  assert.deepEqual(
    items.map((i) => [i.title, i.status, i.priority, i.external?.id]),
    [
      ['Title PRP-1', 'todo', 'P1', 'linear:PRP-1'],
      ['Title PRP-2', 'in_progress', 'P1', 'linear:PRP-2'],
    ],
    'open issues only; started → in_progress',
  )

  // Next sync: PRP-1 moves to started — one state-change doc.
  state.issues[0] = lin('PRP-1', { state: { name: 'In Progress', type: 'started' }, updatedAt: '2026-09-03T10:00:00.000Z' })
  state.comments = []
  const cursor = structuredClone(r.nextCursor) as any
  cursor.PRP.since = '2026-09-02T12:00:00.000Z'
  const next = await linear.fetch({ config: cfg, cursor, since: Date.parse('2026-08-01'), log: () => {}, readFile: (p) => r.files![p] })
  assert.deepEqual(next.docs.map((d) => d.text), ['PRP-1 "Title PRP-1" is now: In Progress · priority: High · assignee: Giordano Temple · labels: Bug'])
})

test('linear: uploads pasted into issues and comments are found and fetched through the uploads proxy', async () => {
  const state = {
    issues: [lin('PRP-4', { description: 'See ![broken form](https://uploads.linear.app/org/abc/def/form.png) and https://uploads.linear.app/org/x/y/clip.mp4', comments: { nodes: [{ id: 'c', body: 'again ![](https://uploads.linear.app/org/abc/def/form.png)', createdAt: '2026-09-02T00:00:00Z', user: { name: 'Sam' } }] } })],
    comments: [],
    calls: [] as { query: string; variables: any }[],
  }
  fakeLinear(state)
  const cfg = { teams: ['PRP'], token: 'lin_api_test', uploads_base: 'https://linear-uploads.int.example' }
  const atts = await linear.attachments!({ config: cfg, log: () => {} }, ['linear:PRP-4'])
  assert.deepEqual(atts.map((a) => [a.name, a.url]), [
    ['broken form', 'https://uploads.linear.app/org/abc/def/form.png'],
    ['clip.mp4', 'https://uploads.linear.app/org/x/y/clip.mp4'],
  ])
  const res = await linear.download!({ config: cfg, log: () => {} }, atts[1])
  assert.equal(await res.text(), 'bytes of clip.mp4')
  assert.deepEqual(uploadLinks('nothing here'), [])
})

test('github: media in an issue\'s rendered HTML — signed private-user-images, not plain links', () => {
  const html = `<p>Repro:</p><img src="https://private-user-images.githubusercontent.com/1/abc-123.png?jwt=eyJ&amp;x=1" alt="login screen"><p><a href="https://example.com">x</a></p><video src="https://private-user-images.githubusercontent.com/1/vid-9.mov?jwt=zz"></video><img src="https://example.com/badge.svg">`
  assert.deepEqual(embeddedMedia(html), [
    { url: 'https://private-user-images.githubusercontent.com/1/abc-123.png?jwt=eyJ&x=1', sourceId: 'https://private-user-images.githubusercontent.com/1/abc-123.png', name: 'login screen.png' },
    { url: 'https://private-user-images.githubusercontent.com/1/vid-9.mov?jwt=zz', sourceId: 'https://private-user-images.githubusercontent.com/1/vid-9.mov', name: 'vid-9.mov' },
  ])
})
