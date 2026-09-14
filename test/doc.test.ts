import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readAudit } from '../src/audit.js'
import { docAdd, docList, readDocIndex } from '../src/commands/doc.js'
import { streamFiles } from '../src/commands/extract.js'
import { createServer } from '../src/commands/mcp.js'
import { resolveContext } from '../src/context.js'
import { slugify } from '../src/document.js'
import { grepContext } from '../src/search.js'
import { ACME, captureConsole, makeContextRepo } from './helpers.js'

// Isolate from the developer's ~/.lore (a saved global `owner` and service-account key would turn the no-owner case into a live Drive call).
process.env.LORE_HOME = mkdtempSync(join(tmpdir(), 'lore-home-doc-'))

const DOC_ID = '1DNMt4pUJPRqU7vj3dPo6U0icWuNO_2RbZAcEKnATaqg'
const URL = `https://docs.google.com/document/d/${DOC_ID}/edit`
const SPEC = `## Overview

Merrin helps parents plan. Users must be able to save a plan offline.

### Open questions
- Which regions at launch?

Slack token for the integration: ${['xoxb', '0'.repeat(12), '0'.repeat(12), 'ABCDEFGHIJKLMNOPQRSTUVWX'].join('-')}
`

const gdoc = (over: Record<string, unknown> = {}) => async (_url: string, as: string) => ({
  id: DOC_ID,
  name: 'Merrin Product Spec v1',
  url: `https://docs.google.com/document/d/${DOC_ID}`,
  markdown: SPEC,
  mimeType: 'application/vnd.google-apps.document',
  modified: '2026-09-09T17:03:00.000Z',
  owner: 'Julie Harsh',
  ...over,
  _as: as,
})

test('doc: slugify', () => {
  assert.equal(slugify('Merrin Product Spec v1'), 'merrin-product-spec-v1')
  assert.equal(slugify('  ¯\\_(ツ)_/¯ '), 'doc')
})

test('doc add: a Google link lands in the docs stream as one stream doc — title, owner as author, link as permalink, scrubbed, audited', async () => {
  const root = makeContextRepo({}, { ...ACME, client: { name: 'Merrin', domains: ['getmerrin.com'], contacts: [], owner: 'shawn@inputlogic.ca' } })
  const seen: string[] = []
  const exportDoc = async (url: string, as: string) => {
    seen.push(`${as} ${url}`)
    return gdoc()(url, as)
  }
  const { result, out } = await captureConsole(() => docAdd(root, { file: URL, date: '2026-09-14' }, { context: root, exportDoc }))
  assert.deepEqual(seen, [`shawn@inputlogic.ca ${URL}`])
  assert.equal(result.file, 'context/streams/docs/merrin-product-spec-v1/2026-09-14.md')
  assert.equal(result.title, 'Merrin Product Spec v1')
  assert.equal(result.from, 'Julie Harsh')
  assert.equal(result.source, `https://docs.google.com/document/d/${DOC_ID}`)
  assert.equal(result.written, true)
  assert.match(out, /added context\/streams\/docs\/merrin-product-spec-v1\/2026-09-14\.md: Merrin Product Spec v1 — [\d,]+ chars from Julie Harsh \(secrets redacted\)/)

  const text = readFileSync(join(root, result.file), 'utf8')
  assert.ok(text.startsWith('---\nsource: docs\nchannel: "merrin-product-spec-v1"\ndate: 2026-09-14\n---\n'))
  assert.match(text, /### Julie Harsh — 2026-09-14T00:00:00\.000Z\n<!-- id: doc-1DNMt4pUJPRqU7vj3dPo6U0icWuNO_2RbZAcEKnATaqg-[0-9a-f]{12} title: merrin-product-spec-v1 gdoc: 1DNMt4pUJPRqU7vj3dPo6U0icWuNO_2RbZAcEKnATaqg modified: 2026-09-09T17:03:00\.000Z mime: application\/vnd\.google-apps\.document added_by: \S+ -->\n\[permalink\]\(https:\/\/docs\.google\.com\/document\/d\/1DNMt4pUJPRqU7vj3dPo6U0icWuNO_2RbZAcEKnATaqg\)\n\n# Merrin Product Spec v1\n\n## Overview/)
  assert.match(text, /save a plan offline/)
  assert.doesNotMatch(text, /xoxb-0000/, 'the stream scrubber ran')

  // It is ordinary stream material: the fold sees it and grep finds it.
  assert.deepEqual(streamFiles(root).map((f) => f.path), [result.file])
  assert.ok(grepContext(root, 'offline').some((m) => m.file === result.file))

  const [entry] = readAudit(root)
  assert.equal(entry.action, 'doc')
  assert.equal(entry.actor, userInfo().username)
  assert.equal(entry.via, 'cli')
  assert.equal(entry.id, result.id)
  assert.equal(entry.source, result.source)
})

test('doc add: identical content is a no-op; changed content is a new version in the same channel; --title/--from/--source/--as override', async () => {
  const root = makeContextRepo({}, { ...ACME, client: { name: 'Merrin', domains: [], contacts: [], owner: 'shawn@inputlogic.ca' } })
  const first = await captureConsole(() => docAdd(root, { file: URL, date: '2026-09-14' }, { context: root, exportDoc: gdoc() }))
  const again = await captureConsole(() => docAdd(root, { file: URL, date: '2026-09-14' }, { context: root, exportDoc: gdoc() }))
  assert.equal(again.result.written, false)
  assert.match(again.out, /^unchanged: Merrin Product Spec v1 is already in /)
  assert.equal(readAudit(root).length, 1, 'a no-op is not audited')

  const seen: string[] = []
  const v2 = await captureConsole(() =>
    docAdd(
      root,
      { file: URL, date: '2026-09-15', title: 'Merrin Product Spec v1', from: 'Julie (via email)', source: 'https://mail.google.com/x', as: 'cory@inputlogic.ca' },
      {
        context: root,
        exportDoc: async (url, as) => {
          seen.push(as)
          return gdoc({ markdown: SPEC + '\n\nAlso: dark mode.' })(url, as)
        },
      },
    ),
  )
  assert.deepEqual(seen, ['cory@inputlogic.ca'])
  assert.equal(v2.result.written, true)
  assert.notEqual(v2.result.id, first.result.id)
  assert.equal(v2.result.file, 'context/streams/docs/merrin-product-spec-v1/2026-09-15.md')
  assert.equal(v2.result.from, 'Julie (via email)')
  assert.equal(v2.result.source, 'https://mail.google.com/x')

  const index = readDocIndex(root)
  assert.deepEqual(
    index.map((d) => [d.date, d.title, d.from, d.source]),
    [
      ['2026-09-15', 'Merrin Product Spec v1', 'Julie (via email)', 'https://mail.google.com/x'],
      ['2026-09-14', 'Merrin Product Spec v1', 'Julie Harsh', `https://docs.google.com/document/d/${DOC_ID}`],
    ],
  )
  assert.equal(index[0].id, v2.result.id)
  const { out } = await captureConsole(() => docList(root, { context: root }))
  assert.match(out, /^2026-09-15  Merrin Product Spec v1 — from Julie \(via email\), [\d,]+ chars  https:\/\/mail\.google\.com\/x  \[context\/streams\/docs\/merrin-product-spec-v1\/2026-09-15\.md\]\n2026-09-14  /)
})

test('doc add: a local file or text works without Google; validation, write.allow, archived', async () => {
  const root = makeContextRepo()
  const file = join(root, 'Alpha GTM brief.md')
  writeFileSync(file, '# Brief\n\nLaunch alpha to 50 families in October.\n')
  const { result } = await captureConsole(() => docAdd(root, { file, from: 'Matthew', date: '2026-09-10' }, { context: root }))
  assert.equal(result.title, 'Alpha GTM brief')
  assert.equal(result.file, 'context/streams/docs/alpha-gtm-brief/2026-09-10.md')
  assert.equal(result.source, undefined)
  assert.match(result.id, /^doc-[0-9a-f]{12}$/)
  assert.doesNotMatch(readFileSync(join(root, result.file), 'utf8'), /\[permalink\]/)

  const asText = await captureConsole(() => docAdd(root, { text: 'Competitive landscape: three incumbents.', title: 'Competitive landscape' }, { context: root, by: 'julie' }))
  assert.equal(asText.result.from, 'julie', 'author falls back to the actor')
  assert.equal(readAudit(root).at(-1)?.actor, 'julie')

  await assert.rejects(docAdd(root, { text: 'x' }, { context: root }), /--title is required/)
  await assert.rejects(docAdd(root, { text: '   ', title: 't' }, { context: root }), /document is empty/)
  await assert.rejects(docAdd(root, {}, { context: root }), /file path, a Google Docs\/Drive link, or as text/)
  await assert.rejects(docAdd(root, { text: 'x', title: 't', date: '14/09/2026' }, { context: root }), /--date must be an ISO date/)
  await assert.rejects(docAdd(root, { file: join(root, 'nope.docx') }, { context: root }), /doc: file not found/)
  await assert.rejects(docAdd(root, { file: URL }, { context: root }), /needs --as/)

  const gated = makeContextRepo({}, { ...ACME, write: { allow: ['someone-else'] } })
  await assert.rejects(docAdd(gated, { text: 'x', title: 't' }, { context: gated }), /not in lore.json write.allow — doc refused/)
  const archived = makeContextRepo({}, { ...ACME, lifecycle: 'archived', archived_at: '2026-09-01T00:00:00Z' })
  await assert.rejects(docAdd(archived, { text: 'x', title: 't' }, { context: archived }), /archived/)
})

test('doc add: a document whose own headings look like stream headings is still one indexed entry', async () => {
  const root = makeContextRepo()
  await captureConsole(() => docAdd(root, { text: '### Notes — 2026-01-01\n\nbody\n\n### More — 2026-02-02T00:00:00.000Z\n\nend', title: 'Odd headings', date: '2026-09-14' }, { context: root }))
  assert.equal(readDocIndex(root).length, 1)
})

test('mcp: lore_doc_add adds a document as the OS user, never a caller-supplied actor', async () => {
  const root = makeContextRepo({}, { ...ACME, client: { name: 'Merrin', domains: [], contacts: [], owner: 'shawn@inputlogic.ca' } })
  const ctx = resolveContext(root, { context: root })
  const server = createServer(ctx, { cwd: root, opts: { context: root } })
  const client = new Client({ name: 't', version: '0' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  const res = await client.callTool({ name: 'lore_doc_add', arguments: { text: 'Vision: every parent has a plan.', title: 'Vision deck notes', from: 'Julie', date: '2026-09-14', by: 'root' } })
  const d = JSON.parse((res.content as { text: string }[])[0].text)
  assert.equal(d.file, 'context/streams/docs/vision-deck-notes/2026-09-14.md')
  assert.equal(d.from, 'Julie')
  const [entry] = readAudit(root)
  assert.equal(entry.via, 'mcp')
  assert.equal(entry.actor, userInfo().username)
  await Promise.all([client.close(), server.close()])
})
