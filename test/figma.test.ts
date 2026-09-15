import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { figma, figmaFileKey, nodeUrl, renderIndex, slug, walkFile, type FigmaFile, type FigmaNode } from '../src/connectors/figma.js'
import type { ConnectorContext } from '../src/types.js'

const KEY = '8KDHUykKTwbvIXqqUcedIg'
const API = 'https://figma.test/v1'

const text = (id: string, characters: string, visible = true): FigmaNode => ({ id, name: characters.slice(0, 20), type: 'TEXT', characters, visible })
const frame = (id: string, name: string, children: FigmaNode[], type = 'FRAME', extra: Partial<FigmaNode> = {}): FigmaNode => ({ id, name, type, children, ...extra })

function file(version = '101', over: Partial<FigmaFile> = {}): FigmaFile {
  return {
    name: 'Merrin App',
    version,
    lastModified: '2026-09-10T15:00:00Z',
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: [
        frame('1:1', 'Onboarding', [
          frame('1:10', 'Welcome', [text('1:11', 'Welcome to Merrin'), text('1:12', 'Your parenting co-pilot'), frame('1:13', 'CTA', [text('1:14', 'Get started')], 'INSTANCE'), frame('1:15', 'Footer', [frame('1:16', 'Legal', [text('1:17', 'By continuing you agree…')])])], 'FRAME', { absoluteBoundingBox: { width: 390, height: 844 } }),
          frame('1:20', 'Six questions', [text('1:21', 'How old is your child?'), text('1:22', 'hidden draft', false), frame('1:23', 'Button/Primary', [], 'INSTANCE')]),
          text('1:30', 'Loose page note'),
        ], 'CANVAS'),
        frame('2:1', 'Archive', [frame('2:10', 'Old', [text('2:11', 'gone')])], 'CANVAS', { visible: false }),
        frame('3:1', 'Home', [frame('3:10', 'Empty state', [text('3:11', 'Nothing here yet — ask Merrin anything')])], 'CANVAS'),
        frame('4:1', 'Flows', [
          frame('4:10', 'For Launch', [
            frame('4:11', 'Section Headers', [], 'INSTANCE'),
            text('4:12', 'Launch scope — v1'),
            frame('4:20', 'Sign in', [text('4:21', 'Sign in to Jointly')]),
            frame('4:30', 'Dashboard', [text('4:31', 'Your agreements')]),
            frame('4:40', 'Later', [frame('4:41', 'Paywall', [text('4:42', 'Unlock the full agreement')])], 'SECTION'),
          ], 'SECTION'),
        ], 'CANVAS'),
      ],
    },
    ...over,
  }
}

function fakeFigma() {
  const state = { file: file(), comments: [] as object[], versions: [{ user: { handle: 'Julie' } }], calls: [] as string[], projectFiles: [] as { key: string; name: string }[], deny: false, rateLimitOnce: false }
  const json = (b: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    state.calls.push(url.pathname.replace(/^\/(v1|proxy)/, '') + url.search)
    if ((init?.headers as Record<string, string>)?.['X-Figma-Token'] !== 'figd_test' && !url.pathname.startsWith('/proxy')) return json({ err: 'Invalid token' }, { status: 403 })
    if (state.rateLimitOnce) {
      state.rateLimitOnce = false
      return json({}, { status: 429, headers: { 'retry-after': '0' } })
    }
    const path = url.pathname.replace(/^\/(v1|proxy)/, '')
    if (state.deny) return json({ status: 403, err: 'Not allowed' }, { status: 403 })
    if (path === `/files/${KEY}`) {
      if (url.searchParams.get('depth') === '1') return json({ ...state.file, document: { ...state.file.document, children: state.file.document.children!.map((c) => ({ ...c, children: undefined })) } })
      return json(state.file)
    }
    if (path === `/files/${KEY}/comments`) return json({ comments: state.comments })
    if (path === `/files/${KEY}/versions`) return json({ versions: state.versions })
    if (path === '/projects/77/files') return json({ files: state.projectFiles })
    if (path === '/files/NOPE12345') return json({ status: 404, err: 'Not found' }, { status: 404 })
    if (path === '/files/DECK1234567') return json({ status: 400, err: 'File type not supported by this endpoint' }, { status: 400 })
    return json({ err: `no route ${path}` }, { status: 404 })
  }) as typeof fetch
  return state
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function ctx(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return { config: { files: [`https://www.figma.com/design/${KEY}/Merrin-App?node-id=1-1`], token: 'figd_test', api_base: API }, cursor: {}, since: Date.parse('2026-08-01T00:00:00Z'), log: () => {}, readFile: () => undefined, ...over }
}

test('figma: file keys from every URL form; node links use dashes; slugs', () => {
  for (const kind of ['design', 'file', 'board', 'deck', 'slides', 'proto']) assert.equal(figmaFileKey(`https://www.figma.com/${kind}/${KEY}/Merrin-Vision-Deck?node-id=1-1654&t=abc`), KEY)
  assert.equal(figmaFileKey(KEY), KEY)
  assert.equal(figmaFileKey('https://www.figma.com/files/team/123'), undefined)
  assert.equal(figmaFileKey('not a key!'), undefined)
  assert.equal(nodeUrl(KEY, 'Merrin App', '1:10'), `https://www.figma.com/design/${KEY}/merrin-app?node-id=1-10`)
  assert.equal(slug('Merrin — App (v2)'), 'merrin-app-v2')
})

test('figma: a frame renders as headings + text in order, components by name, hidden and loose text skipped, invisible pages skipped', () => {
  const { frames, names } = walkFile(file(), KEY)
  assert.deepEqual(frames.map((f) => `${f.page} / ${f.name}`), [
    'Onboarding / Welcome',
    'Onboarding / Six questions',
    'Home / Empty state',
    'Flows / For Launch / Sign in',
    'Flows / For Launch / Dashboard',
    'Flows / For Launch / Later / Paywall',
    'Flows / For Launch (section notes)',
  ])
  const signIn = frames.find((f) => f.name === 'For Launch / Sign in')!
  assert.match(signIn.text, /^# Merrin App › Flows › For Launch › Sign in\nFigma node 4:20 — .*node-id=4-20\n\n- Sign in to Jointly$/)
  assert.equal(names.get('4:41'), 'Flows / For Launch / Later / Paywall')
  assert.equal(names.get('4:10'), 'Flows / For Launch')
  const notes = frames.find((f) => f.name.endsWith('(section notes)'))!
  assert.match(notes.text, /\(section notes\)\n.*\n\n- \[component: Section Headers\]\n- Launch scope — v1$/)
  assert.equal(
    frames[0].text,
    [
      '# Merrin App › Onboarding › Welcome',
      `Figma node 1:10 (390×844) — https://www.figma.com/design/${KEY}/merrin-app?node-id=1-10`,
      '',
      '- Welcome to Merrin',
      '- Your parenting co-pilot',
      '',
      '## CTA [component]',
      '- Get started',
      '',
      '## Footer',
      '',
      '### Legal',
      '- By continuing you agree…',
    ].join('\n'),
  )
  assert.match(frames[1].text, /- How old is your child\?\n- \[component: Button\/Primary\]$/)
  assert.doesNotMatch(frames[1].text, /hidden draft/)
  assert.equal(names.get('1:16'), 'Onboarding / Welcome / Footer / Legal')
  assert.equal(names.get('3:10'), 'Home / Empty state')
  const index = renderIndex(file(), KEY, frames)
  assert.match(index, /^# Merrin App — pages and frames\n/)
  assert.match(index, /## Onboarding\n- Welcome — https:\/\/www\.figma\.com\/design\/.*node-id=1-10\n- Six questions/)
  assert.match(index, /## Home\n- Empty state/)
  assert.match(index, /## Flows\n- For Launch \/ Sign in — /)
})

test('figma: first sync emits every frame + an index; an unchanged version emits nothing; an edited frame emits only itself', async () => {
  const g = fakeFigma()
  const r1 = await figma.fetch(ctx())
  assert.deepEqual(r1.docs.map((d) => d.meta?.node ?? d.meta?.kind), ['1:10', '1:20', '3:10', '4:20', '4:30', '4:41', '4:10', 'index'])
  const welcome = r1.docs[0]
  assert.equal(welcome.channel, 'merrin-app')
  assert.equal(welcome.author, 'Julie')
  assert.equal(welcome.timestamp, '2026-09-10T15:00:00.000Z')
  assert.equal(welcome.permalink, `https://www.figma.com/design/${KEY}/merrin-app?node-id=1-10`)
  assert.match(welcome.id, new RegExp(`^figma-${KEY}-1_10-[0-9a-f]{8}$`))
  assert.deepEqual(welcome.meta, { file: KEY, node: '1:10', version: '101', page: 'onboarding' })
  assert.ok(g.calls.some((c) => c === `/files/${KEY}?depth=1`) && g.calls.some((c) => c === `/files/${KEY}`), 'cheap head, then the full tree')
  const cursor1 = r1.nextCursor as Record<string, { version: string; frames: Record<string, string> }>
  assert.equal(cursor1[KEY].version, '101')
  assert.deepEqual(Object.keys(cursor1[KEY].frames).sort(), ['1:10', '1:20', '3:10', '4:10', '4:20', '4:30', '4:41', '__index'])

  // Same version: only the head request, no docs.
  g.calls.length = 0
  const r2 = await figma.fetch(ctx({ cursor: r1.nextCursor }))
  assert.equal(r2.docs.length, 0)
  assert.deepEqual(g.calls, [`/files/${KEY}?depth=1`, `/files/${KEY}/comments`])

  // New version, one frame's copy changed: that frame (new id) + a new index only if the frame list changed (it didn't).
  g.file = file('102')
  ;(g.file.document.children![0].children![0].children![0] as FigmaNode).characters = 'Welcome to Merrin, Julie'
  const r3 = await figma.fetch(ctx({ cursor: r2.nextCursor }))
  assert.deepEqual(r3.docs.map((d) => d.meta?.node ?? d.meta?.kind), ['1:10'])
  assert.match(r3.docs[0].text, /Welcome to Merrin, Julie/)
  assert.notEqual(r3.docs[0].id, welcome.id, 'a changed frame is a new entry, the old stays in history')
  assert.equal((r3.nextCursor as Record<string, { version: string }>)[KEY].version, '102')
})

test('figma: comments arrive as threaded docs anchored to their frame, incrementally; resolved ones say so', async () => {
  const g = fakeFigma()
  g.comments = [
    { id: 'c1', message: 'Can the CTA say "Start" instead?', created_at: '2026-09-11T10:00:00Z', user: { handle: 'Julie' }, client_meta: { node_id: '1:13' } },
    { id: 'c2', message: 'Yes — changing it.', created_at: '2026-09-11T11:00:00Z', user: { handle: 'Cory' }, parent_id: 'c1', client_meta: null },
    { id: 'c0', message: 'ancient', created_at: '2026-07-01T00:00:00Z', user: { handle: 'x' } },
    { id: 'c3', message: 'Empty state copy approved', created_at: '2026-09-12T09:00:00Z', resolved_at: '2026-09-12T10:00:00Z', user: { handle: 'Julie' }, client_meta: { node_id: '3:10' } },
  ]
  const r = await figma.fetch(ctx({ config: { ...ctx().config, include: ['comments'] } }))
  const comments = r.docs.filter((d) => d.meta?.comment)
  assert.deepEqual(comments.map((d) => d.meta!.comment), ['c1', 'c2', 'c3'], 'the one before the window is skipped')
  assert.equal(comments[0].text, 'On **Onboarding / Welcome / CTA**:\n\nCan the CTA say "Start" instead?')
  assert.equal(comments[0].permalink, `https://www.figma.com/design/${KEY}/merrin-app?node-id=1-13`)
  assert.equal(comments[1].thread, `figma-${KEY}-comment-c1`)
  assert.equal(comments[1].text, 'Yes — changing it.')
  assert.equal(comments[2].text, 'On **Home / Empty state** (resolved):\n\nEmpty state copy approved')
  assert.equal(comments[2].meta?.resolved, '2026-09-12T10:00:00Z')
  assert.equal(r.docs.some((d) => d.meta?.kind === 'index'), false, 'frames excluded by include')
  const next = r.nextCursor as Record<string, { commentsSince: string }>
  assert.equal(next[KEY].commentsSince, '2026-09-12T09:00:00.000Z')
  // Next run: only what is newer than the cursor (the default one-day overlap re-reads recent ones, which writeDocs then skips by id).
  g.comments.push({ id: 'c4', message: 'later', created_at: '2026-09-13T09:00:00Z', user: { handle: 'Julie' } })
  const r2 = await figma.fetch(ctx({ config: { ...ctx().config, include: ['comments'], overlap_days: 0 }, cursor: r.nextCursor }))
  assert.deepEqual(r2.docs.map((d) => d.meta!.comment), ['c3', 'c4'], 'the cursor is inclusive: the boundary comment re-reads, ids keep it idempotent')
  const r3 = await figma.fetch(ctx({ config: { ...ctx().config, include: ['comments'] }, cursor: r.nextCursor }))
  assert.deepEqual(r3.docs.map((d) => d.meta!.comment), ['c1', 'c2', 'c3', 'c4'], 'overlap window re-reads a day; ids keep it idempotent')
})

test('figma: projects list files; a missing file is a reported error, not a crash; 429 retries; a proxy needs no token', async () => {
  const g = fakeFigma()
  g.projectFiles = [{ key: KEY, name: 'Merrin App' }]
  const r = await figma.fetch(ctx({ config: { projects: [77], files: ['NOPE12345', 'https://www.figma.com/deck/DECK1234567/Vision'], token: 'figd_test', api_base: API } }))
  assert.equal(r.docs.filter((d) => d.meta?.kind === 'index').length, 1)
  assert.equal(r.errors?.length, 2)
  assert.match(r.errors![0], /file NOPE12345: figma 404 .* — check the key/)
  assert.match(r.errors![1], /file DECK1234567: Figma's REST API does not serve this file type .*export it as PDF/)
  g.rateLimitOnce = true
  const r2 = await figma.fetch(ctx({ cursor: r.nextCursor }))
  assert.equal(r2.errors, undefined)
  await assert.rejects(figma.fetch(ctx({ config: { files: [KEY] } })), /no credentials/)
  await assert.rejects(figma.fetch(ctx({ config: { files: ['garbage!'], token: 'figd_test' } })), /not a Figma file URL or key/)
  const viaProxy = await figma.fetch(ctx({ config: { files: [KEY], api_base: 'https://figma.test/proxy' } }))
  assert.ok(viaProxy.docs.length > 0, 'api_base alone is enough when the proxy injects the token')
})
