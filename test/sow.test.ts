import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readAudit } from '../src/audit.js'
import { createServer } from '../src/commands/mcp.js'
import { pdfText, sowAdd, sowList } from '../src/commands/sow.js'
import { resolveContext } from '../src/context.js'
import { isEmpty, recallData } from '../src/recall.js'
import { readSows, sowSlug, splitFrontmatter, stripCommercials, summarizeSow } from '../src/sow.js'
import { ACME, captureConsole, makeContextRepo } from './helpers.js'

const DOC = `# Statement of Work 4 — Jointly

Inputlogic will provide a product team for the period below.

Budget: 12 human-weeks.
Rate: $4,500 per week, total $54,000 CAD.
Payment: net 30.

## Scope
- Agreement builder v2
- Onboarding flow

Slack token for the integration: ${['xoxb', '0'.repeat(12), '0'.repeat(12), 'ABCDEFGHIJKLMNOPQRSTUVWX'].join('-')}
`

const META = { name: 'Jointly SOW 4', weeks: 12, start: '2026-09-01', end: '2026-12-15' }

test('sow: slug, frontmatter, commercial stripping, summary carries no derived progress', () => {
  assert.equal(sowSlug('Jointly SOW 4'), 'jointly-sow-4')
  assert.equal(sowSlug('  Coffee & Contracts: Phase II '), 'coffee-contracts-phase-ii')
  const stripped = stripCommercials(DOC)
  assert.equal(stripped.removed, 1)
  assert.doesNotMatch(stripped.text, /\$4,500|54,000/)
  assert.match(stripped.text, /Budget: 12 human-weeks/)
  assert.equal(stripCommercials('12 weeks over 16 weeks\nno money here').removed, 0)
  assert.equal(stripCommercials('Total: 12,000 USD\nEUR 900').removed, 2)
  const fm = splitFrontmatter('---\nname: x\nweeks: 3\n---\nbody here\n')
  assert.deepEqual(fm, { meta: { name: 'x', weeks: 3 }, body: 'body here\n' })
  const s = summarizeSow({ id: 'a', file: 'f', body: 'text', added: '', added_by: 'u', status: 'active', ...META })
  assert.deepEqual(s, { id: 'a', file: 'f', added: '', added_by: 'u', status: 'active', ...META })
  assert.ok(!('period_elapsed_pct' in s) && !('days_left' in s), 'calendar time is never a burn proxy')
})

test('sow add: the end date is optional — most SOWs only state weeks and an effective date', async () => {
  const root = makeContextRepo()
  const { end: _end, ...noEnd } = META
  const { result, out } = await captureConsole(() => sowAdd(root, { ...noEnd, text: 'Sixteen weeks of work.' }, { context: root }))
  assert.equal(result.end, undefined)
  assert.match(out, /12 weeks, effective 2026-09-01\s*$/m)
  assert.doesNotMatch(readFileSync(join(root, 'context/sow/jointly-sow-4.md'), 'utf8'), /^end:/m)
  const [sow] = readSows(root)
  assert.equal(sow.end, undefined)
})

test('sow add: writes context/sow/<slug>.md with frontmatter, strips amounts, scrubs secrets, audits', async () => {
  const root = makeContextRepo()
  const file = join(root, 'sow4.md')
  writeFileSync(file, DOC)
  const { result, out } = await captureConsole(() =>
    sowAdd(root, { ...META, file, signed: '2026-08-28', source: 'https://docs.google.com/document/d/abc', scope: ['Agreement builder v2', ' Onboarding flow '] }, { context: root }),
  )
  assert.match(out, /added context\/sow\/jointly-sow-4\.md: Jointly SOW 4 — 12 weeks, effective 2026-09-01 to 2026-12-15 \(1 line\(s\) with amounts stripped, secrets redacted\)/)
  assert.equal(result.id, 'jointly-sow-4')
  assert.equal(result.added_by, userInfo().username)
  assert.deepEqual(result.scope, ['Agreement builder v2', 'Onboarding flow'])

  const text = readFileSync(join(root, 'context/sow/jointly-sow-4.md'), 'utf8')
  assert.match(text, /^---\nname: Jointly SOW 4\nweeks: 12\nstart: 2026-09-01\nend: 2026-12-15\nstatus: active\nsigned: 2026-08-28\nsource: https:\/\/docs\.google\.com\/document\/d\/abc\nscope:\n\s*- Agreement builder v2\n\s*- Onboarding flow\nadded_by: /)
  assert.match(text, /Budget: 12 human-weeks/)
  assert.doesNotMatch(text, /54,000/)
  assert.doesNotMatch(text, /xoxb-0000/)

  const [sow] = readSows(root)
  assert.equal(sow.name, 'Jointly SOW 4')
  assert.equal(sow.weeks, 12)
  assert.match(sow.body, /^# Statement of Work 4/)

  const audit = readAudit(root)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].action, 'sow')
  assert.equal(audit[0].id, 'jointly-sow-4')
  assert.equal(audit[0].source, 'https://docs.google.com/document/d/abc')
})

test('sow add: text input (the MCP path), re-adding the same name updates it, --keep-commercials keeps amounts', async () => {
  const root = makeContextRepo()
  await sowAdd(root, { ...META, text: DOC }, { context: root, via: 'mcp' })
  assert.equal(readAudit(root)[0].via, 'mcp')
  const again = await sowAdd(root, { ...META, text: DOC, status: 'exhausted', keepCommercials: true }, { context: root, via: 'mcp' })
  assert.equal(again.status, 'exhausted')
  assert.equal(readSows(root).length, 1, 'same slug → one file')
  assert.match(readFileSync(join(root, 'context/sow/jointly-sow-4.md'), 'utf8'), /54,000/)
  assert.equal(readAudit(root).length, 2)
})

test('sow add: validation, write.allow, archived', async () => {
  const root = makeContextRepo()
  await assert.rejects(sowAdd(root, { ...META, text: 'x', weeks: 0 }, { context: root }), /--weeks must be a positive/)
  await assert.rejects(sowAdd(root, { ...META, text: 'x', start: 'Sept 1' }, { context: root }), /--start must be an ISO date/)
  await assert.rejects(sowAdd(root, { ...META, text: 'x', end: '2026-01-01' }, { context: root }), /--end is before --start/)
  await assert.rejects(sowAdd(root, { ...META, text: 'x', status: 'paused' as never }, { context: root }), /status must be one of/)
  await assert.rejects(sowAdd(root, { ...META }, { context: root }), /file path, a Google Doc link, or as text/)
  await assert.rejects(sowAdd(root, { ...META, file: join(root, 'nope.docx') }, { context: root }), /file not found/)
  writeFileSync(join(root, 'x.docx'), 'z')
  await assert.rejects(sowAdd(root, { ...META, file: join(root, 'x.docx') }, { context: root }), /unsupported file type/)

  const gated = makeContextRepo({}, { project: 'acme', write: { allow: ['someone-else'] } })
  await assert.rejects(sowAdd(gated, { ...META, text: 'x' }, { context: gated }), /not in lore.json write.allow — sow refused/)
  await captureConsole(() => sowAdd(gated, { ...META, text: 'x' }, { context: gated, by: 'someone-else' }))

  const archived = makeContextRepo({}, { ...ACME, lifecycle: 'archived', archived_at: '2026-09-01T00:00:00Z' })
  await assert.rejects(sowAdd(archived, { ...META, text: 'x' }, { context: archived }), /archived/)
})

test('sow: recall carries the layer with progress; category "sow" isolates it; list prints it', async () => {
  const root = makeContextRepo()
  await captureConsole(() => sowAdd(root, { ...META, text: DOC }, { context: root }))
  const all = recallData(root, ACME)
  assert.equal(all.sow.length, 1)
  assert.equal(all.sow[0].name, 'Jointly SOW 4')
  assert.equal(all.sow[0].file, 'context/sow/jointly-sow-4.md')
  assert.ok(!('body' in all.sow[0]), 'recall carries metadata, not the document body')
  assert.ok(!isEmpty(all))
  const only = recallData(root, ACME, 'sow')
  assert.equal(only.sow.length, 1)
  assert.equal(only.pins.length, 0)
  assert.equal(recallData(root, ACME, 'requests').sow.length, 0)
  const { out } = await captureConsole(() => sowList(root, { context: root }))
  assert.match(out, /active\s+Jointly SOW 4: 12 weeks, effective 2026-09-01 to 2026-12-15  \[context\/sow\/jointly-sow-4\.md\]/)
})

test('sow: the lore_sow_add MCP tool writes as an MCP actor and lore_recall returns it', async () => {
  const root = makeContextRepo()
  const ctx = resolveContext(root, { context: root })
  const server = createServer(ctx, { cwd: root, opts: { context: root } })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientT)
  const res = await client.callTool({ name: 'lore_sow_add', arguments: { ...META, text: DOC, scope: ['Agreement builder v2'] } })
  const body = JSON.parse((res.content as { text: string }[])[0].text)
  assert.equal(body.id, 'jointly-sow-4')
  assert.equal(body.weeks, 12)
  const recall = await client.callTool({ name: 'lore_recall', arguments: { category: 'sow' } })
  const recalled = JSON.parse((recall.content as { text: string }[])[0].text)
  assert.equal(recalled.sow[0].name, 'Jointly SOW 4')
  assert.equal(readAudit(root)[0].via, 'mcp')
  await client.close()
})

test('sow: pdf text extraction', async () => {
  const content = 'BT /F1 14 Tf 72 720 Td (Statement of Work 4) Tj 0 -20 Td (Budget: 12 human-weeks) Tj ET'
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const text = await pdfText(Buffer.from(pdf, 'latin1'))
  assert.match(text, /Statement of Work 4/)
  assert.match(text, /Budget: 12 human-weeks/)
})
