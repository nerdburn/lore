import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { normalizeId, notion, propertyText, renderBlock, richText, titleOf, type NotionBlock, type NotionObject } from '../src/connectors/notion.js'
import type { ConnectorContext } from '../src/types.js'

const rt = (text: string, extra: Record<string, unknown> = {}) => [{ plain_text: text, ...extra }]

function page(id: string, over: Partial<NotionObject> & { title?: string } = {}): NotionObject {
  const { title = `Page ${id}`, ...rest } = over
  return {
    object: 'page',
    id,
    url: `https://www.notion.so/${id.replace(/-/g, '')}`,
    created_time: '2026-08-01T10:00:00.000Z',
    last_edited_time: '2026-08-10T10:00:00.000Z',
    last_edited_by: { id: 'U1' },
    parent: { type: 'workspace', workspace: true },
    properties: { Name: { type: 'title', title: rt(title) } },
    ...rest,
  }
}

/** A fake Notion REST API: search, pages/databases retrieve, block children, users. */
function fakeNotion() {
  const state = {
    objects: [] as NotionObject[],
    blocks: {} as Record<string, NotionBlock[]>,
    /** Container blocks retrievable by id (a column, a column_list) — parents of pages laid out inside them. */
    blockObjects: {} as Record<string, NotionObject>,
    users: { U1: 'Priya Patel', U2: 'Shawn Adrian' } as Record<string, string>,
    calls: [] as string[],
    rateLimitOnce: false,
  }
  const json = (b: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    state.calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    const auth = (init?.headers as Record<string, string>)?.Authorization
    if (auth !== 'Bearer ntn_test') return json({ message: 'unauthorized' }, { status: 401 })
    if (state.rateLimitOnce) {
      state.rateLimitOnce = false
      return json({ message: 'rate limited' }, { status: 429, headers: { 'retry-after': '0' } })
    }
    const path = url.pathname.replace(/^\/v1/, '')
    if (path === '/search') {
      const sorted = [...state.objects].sort((a, b) => b.last_edited_time.localeCompare(a.last_edited_time))
      return json({ results: sorted, has_more: false, next_cursor: null })
    }
    let m = /^\/(pages|databases)\/([^/]+)$/.exec(path)
    if (m) {
      const o = state.objects.find((x) => x.id.replace(/-/g, '') === m![2].replace(/-/g, ''))
      return o ? json(o) : json({ message: 'not found' }, { status: 404 })
    }
    m = /^\/blocks\/([^/]+)\/children$/.exec(path)
    if (m) return json({ results: state.blocks[m[1]] ?? [], has_more: false, next_cursor: null })
    m = /^\/blocks\/([^/]+)$/.exec(path)
    if (m) return state.blockObjects[m[1]] ? json(state.blockObjects[m[1]]) : json({ message: 'not found' }, { status: 404 })
    m = /^\/users\/([^/]+)$/.exec(path)
    if (m) return state.users[m[1]] ? json({ name: state.users[m[1]] }) : json({ message: 'nf' }, { status: 404 })
    return json({ message: 'not found' }, { status: 404 })
  }) as typeof fetch
  return state
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function ctx(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    config: { token: 'ntn_test' },
    cursor: {},
    since: Date.parse('2026-07-01T00:00:00Z'),
    log: () => {},
    readFile: () => undefined,
    ...over,
  }
}

test('notion: rich text, properties, titles, ids', () => {
  assert.equal(richText([{ plain_text: 'a ', annotations: { bold: true } }, { plain_text: 'b', href: 'https://x' }, { plain_text: 'c', annotations: { code: true } }]), '**a **[b](https://x)`c`')
  assert.equal(propertyText({ type: 'status', status: { name: 'In progress' } }), 'In progress')
  assert.equal(propertyText({ type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] }), 'a, b')
  assert.equal(propertyText({ type: 'date', date: { start: '2026-09-15', end: null } }), '2026-09-15')
  assert.equal(propertyText({ type: 'people', people: [{ id: 'U1', name: 'Priya' }] }), 'Priya')
  assert.equal(propertyText({ type: 'checkbox', checkbox: true }), 'yes')
  assert.equal(titleOf(page('p1', { title: 'Launch plan' })), 'Launch plan')
  assert.equal(titleOf({ object: 'database', id: 'd', url: '', created_time: '', last_edited_time: '', title: rt('Roadmap') }), 'Roadmap')
  assert.equal(normalizeId('https://www.notion.so/acme/Launch-plan-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'), '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d')
  assert.equal(normalizeId('1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d'), '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d')
  assert.equal(normalizeId('not an id'), '')
})

test('notion: blocks render to markdown', () => {
  const b = (type: string, text: string, extra: Record<string, unknown> = {}): NotionBlock => ({ id: 'b', type, [type]: { rich_text: rt(text), ...extra } })
  assert.equal(renderBlock(b('heading_2', 'Scope'), ''), '## Scope')
  assert.equal(renderBlock(b('bulleted_list_item', 'one'), '  '), '  - one')
  assert.equal(renderBlock(b('numbered_list_item', 'first'), ''), '1. first')
  assert.equal(renderBlock(b('to_do', 'ship it', { checked: true }), ''), '- [x] ship it')
  assert.equal(renderBlock(b('quote', 'q'), ''), '> q')
  assert.equal(renderBlock(b('code', 'x = 1', { language: 'python' }), ''), '```python\nx = 1\n```')
  assert.equal(renderBlock({ id: 'b', type: 'divider', divider: {} }, ''), '---')
  assert.equal(renderBlock({ id: 'b', type: 'child_page', child_page: { title: 'Sub' } }, ''), '- 📄 Sub')
  assert.equal(renderBlock({ id: 'b', type: 'table_row', table_row: { cells: [rt('a'), rt('b')] } }, ''), '| a | b |')
  assert.equal(renderBlock({ id: 'b', type: 'image', image: { caption: rt('diagram'), external: { url: 'x' } } }, ''), '[image: diagram]')
  assert.equal(renderBlock({ id: 'b', type: 'table', table: {} }, ''), '')
})

test('notion: syncs edited pages in scope with rendered content, properties, author and permalink', async () => {
  const n = fakeNotion()
  const rootDb: NotionObject = { object: 'database', id: 'db000000000000000000000000000001', url: 'https://www.notion.so/db1', created_time: '2026-01-01T00:00:00Z', last_edited_time: '2026-08-09T00:00:00.000Z', title: rt('Jointly docs') }
  n.objects = [
    rootDb,
    page('aa000000000000000000000000000001', { title: 'Launch checklist', parent: { type: 'database_id', database_id: rootDb.id }, properties: { Name: { type: 'title', title: rt('Launch checklist') }, Status: { type: 'status', status: { name: 'In progress' } }, Owner: { type: 'people', people: [{ id: 'U2', name: 'Shawn' }] } } }),
    page('bb000000000000000000000000000002', { title: 'Sub page', parent: { type: 'page_id', page_id: 'aa000000000000000000000000000001' }, last_edited_time: '2026-08-11T12:00:00.000Z', last_edited_by: { id: 'U2' } }),
    page('cc000000000000000000000000000003', { title: 'Other client', last_edited_time: '2026-08-12T00:00:00.000Z' }),
    page('dd000000000000000000000000000004', { title: 'Too fresh', parent: { type: 'database_id', database_id: rootDb.id }, last_edited_time: new Date().toISOString() }),
  ]
  n.blocks['aa000000000000000000000000000001'] = [
    { id: 'h', type: 'heading_1', heading_1: { rich_text: rt('Before launch') } },
    { id: 'l', type: 'bulleted_list_item', has_children: true, bulleted_list_item: { rich_text: rt('DNS cutover') } },
  ]
  n.blocks['l'] = [{ id: 'l2', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt('TTL to 300 the day before') } }]
  n.blocks['bb000000000000000000000000000002'] = [{ id: 'p', type: 'paragraph', paragraph: { rich_text: rt('Details here.') } }]

  const { docs, nextCursor, errors } = await notion.fetch(ctx({ config: { token: 'ntn_test', roots: ['https://www.notion.so/x/Jointly-docs-db000000000000000000000000000001'] } }))
  assert.equal(errors, undefined)
  assert.deepEqual(docs.map((d) => d.id), [
    'notion-bb000000000000000000000000000002@2026-08-11T12:00:00.000Z',
    'notion-aa000000000000000000000000000001@2026-08-10T10:00:00.000Z',
  ])
  const checklist = docs[1]
  assert.equal(checklist.channel, 'Jointly docs', 'channel = top-level container title')
  assert.equal(checklist.author, 'Priya Patel')
  assert.equal(checklist.permalink, 'https://www.notion.so/aa000000000000000000000000000001')
  assert.equal(checklist.meta?.page, 'aa000000000000000000000000000001')
  assert.equal(checklist.meta?.parent, 'db000000000000000000000000000001')
  assert.equal(checklist.meta?.user, 'U1')
  assert.match(checklist.text, /^\*\*Launch checklist\*\*\n\n- \*\*Status:\*\* In progress\n- \*\*Owner:\*\* Shawn\n\n# Before launch\n- DNS cutover\n  - TTL to 300 the day before$/)
  assert.equal(docs[0].author, 'Shawn Adrian')
  assert.match(docs[0].text, /^\*\*Sub page\*\*\n\nDetails here\.$/)
  assert.equal((nextCursor as { since: string }).since, '2026-08-11T12:00:00.000Z')
  assert.ok(!docs.some((d) => d.text.includes('Other client')), 'out-of-scope page excluded')
  assert.ok(!docs.some((d) => d.text.includes('Too fresh')), 'settling page deferred')
})

test('notion: a root page scopes pages laid out inside its columns (block parents in the chain)', async () => {
  // CareMobi's real shape: root page → column_list → column → "Hub" page → Roadmap database → PRD pages.
  const n = fakeNotion()
  const root = page('aa000000000000000000000000000000', { title: 'CareMobi', last_edited_time: '2025-01-24T00:00:00.000Z' })
  const block = (id: string, type: string, parent: NotionObject['parent']): NotionObject =>
    ({ object: 'block', id, url: '', created_time: '2025-01-24T00:00:00.000Z', last_edited_time: '2025-01-24T00:00:00.000Z', parent, type } as NotionObject)
  n.blockObjects['c1000000000000000000000000000001'] = block('c1000000000000000000000000000001', 'column_list', { type: 'page_id', page_id: root.id })
  n.blockObjects['c0000000000000000000000000000002'] = block('c0000000000000000000000000000002', 'column', { type: 'block_id', block_id: 'c1000000000000000000000000000001' })
  const hub = page('bb000000000000000000000000000003', { title: 'CareMobi Hub', parent: { type: 'block_id', block_id: 'c0000000000000000000000000000002' }, last_edited_time: '2026-06-04T00:00:00.000Z' })
  const roadmap: NotionObject = { object: 'database', id: 'db000000000000000000000000000004', url: 'https://www.notion.so/db4', created_time: '2026-01-01T00:00:00Z', last_edited_time: '2026-06-04T00:00:00.000Z', title: rt('Roadmap'), parent: { type: 'page_id', page_id: hub.id } }
  const prd = page('cc000000000000000000000000000005', { title: 'PRD: Apple Health Integration', parent: { type: 'database_id', database_id: roadmap.id }, properties: { Name: { type: 'title', title: rt('PRD: Apple Health Integration') } } })
  n.objects = [root, hub, roadmap, prd, page('dd000000000000000000000000000006', { title: 'Other client' })]
  n.blocks[prd.id] = [{ id: 'p', type: 'paragraph', paragraph: { rich_text: rt('Read HealthKit steps.') } }]

  const { docs, errors } = await notion.fetch(ctx({ config: { token: 'ntn_test', roots: [`https://app.notion.com/p/x/CareMobi-${root.id}`] } }))
  assert.equal(errors, undefined)
  assert.deepEqual(docs.map((d) => d.meta?.page), [prd.id], 'the PRD under the column-nested hub is in scope; the unrelated page is not')
  assert.equal(docs[0].channel, 'CareMobi', 'channel walks through the blocks to the root page title')
  assert.ok(n.calls.some((c) => c === 'GET /v1/blocks/c0000000000000000000000000000002'), 'block parents are retrieved as blocks, not pages')
})

test('notion: with no roots everything shared is in scope; api_base routes to a proxy without a token', async () => {
  const n = fakeNotion()
  n.objects = [page('aa000000000000000000000000000001', { title: 'A' }), page('bb000000000000000000000000000002', { title: 'B' })]
  const all = await notion.fetch(ctx())
  assert.equal(all.docs.length, 2)

  const seen: { url: string; auth?: string }[] = []
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), auth: (init?.headers as Record<string, string>)?.Authorization })
    const real = String(input).replace('https://notion.int.exe.xyz/v1', 'https://api.notion.com/v1')
    return inner(real, { ...init, headers: { ...(init?.headers as Record<string, string>), Authorization: 'Bearer ntn_test' } })
  }) as typeof fetch
  const viaProxy = await notion.fetch(ctx({ config: { api_base: 'https://notion.int.exe.xyz/v1' } }))
  assert.equal(viaProxy.docs.length, 2)
  assert.ok(seen.every((c) => c.url.startsWith('https://notion.int.exe.xyz/v1/') && c.auth === undefined))
  await assert.rejects(notion.fetch(ctx({ config: {} })), /no token resolved/)
})

test('notion: incremental — only pages edited after cursor minus overlap; cursor is the newest edit', async () => {
  const n = fakeNotion()
  n.objects = [
    page('aa000000000000000000000000000001', { last_edited_time: '2026-08-01T00:00:00.000Z' }),
    page('bb000000000000000000000000000002', { last_edited_time: '2026-08-20T00:00:00.000Z' }),
  ]
  const { docs, nextCursor } = await notion.fetch(ctx({ cursor: { since: '2026-08-10T00:00:00.000Z' } }))
  assert.deepEqual(docs.map((d) => d.meta?.page), ['bb000000000000000000000000000002'])
  assert.equal((nextCursor as { since: string }).since, '2026-08-20T00:00:00.000Z')
})

test('notion: honours 429 and reports per-page failures without failing the source', async () => {
  const n = fakeNotion()
  n.objects = [page('aa000000000000000000000000000001')]
  n.rateLimitOnce = true
  const ok = await notion.fetch(ctx())
  assert.equal(ok.docs.length, 1)
  // a page whose blocks endpoint errors
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/blocks/')) return new Response('{"message":"boom"}', { status: 500 })
    return realFetch === globalThis.fetch ? new Response('{}') : (fakeNotionFetch as typeof fetch)(input, init)
  }) as typeof fetch
  const fakeNotionFetch = (() => { const s = fakeNotion(); s.objects = [page('aa000000000000000000000000000001')]; return globalThis.fetch })()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/blocks/')) return new Response('{"message":"boom"}', { status: 500 })
    return fakeNotionFetch(input, init)
  }) as typeof fetch
  const bad = await notion.fetch(ctx())
  assert.equal(bad.docs.length, 0)
  assert.equal(bad.errors?.length, 1)
  assert.match(bad.errors![0], /notion 500/)
})
