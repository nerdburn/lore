import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { officeKind, officeText, unzip } from '../src/office.js'
import { readDocument } from '../src/document.js'
import { DOCX_XML, zipStored } from './helpers.js'
import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('office: kind from MIME or extension', () => {
  assert.equal(officeKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx')
  assert.equal(officeKind('Merrin Spec.DOCX'), 'docx')
  assert.equal(officeKind('deck.pptx'), 'pptx')
  assert.equal(officeKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx')
  assert.equal(officeKind('application/pdf'), undefined)
})

test('office: unzip reads stored and deflated entries and skips junk', () => {
  const stored = zipStored({ 'a.txt': 'hello', 'dir/b.txt': 'world' })
  const files = unzip(stored)
  assert.equal(files.get('a.txt')?.toString(), 'hello')
  assert.equal(files.get('dir/b.txt')?.toString(), 'world')
  // Deflated: patch one entry to method 8 with deflated bytes.
  const d = deflateRawSync(Buffer.from('compressed text'))
  const z = zipStored({ 'c.txt': 'x'.repeat(d.length) })
  z.writeUInt16LE(8, 8) // local method
  d.copy(z, 30 + 'c.txt'.length)
  const cdStart = z.readUInt32LE(z.length - 22 + 16)
  z.writeUInt16LE(8, cdStart + 10)
  assert.equal(unzip(z).get('c.txt')?.toString(), 'compressed text')
  assert.throws(() => unzip(Buffer.from('not a zip')), /not a zip/)
})

test('office: docx → headings, runs joined, list items, tables as rows', () => {
  const text = officeText('docx', zipStored({ 'word/document.xml': DOCX_XML }))
  assert.equal(
    text,
    ['# Product Spec', 'Merrin helps parents.', '- SMS first & app later', 'After the table.', '', '| Phase | Weeks |', '| Alpha | 6 |'].join('\n'),
  )
  assert.throws(() => officeText('docx', zipStored({ 'x.xml': '<a/>' })), /no word\/document\.xml/)
})

test('office: pptx → slides in order with notes; xlsx → sheets with shared strings and values', () => {
  const pptx = zipStored({
    'ppt/slides/slide2.xml': '<p:sld xmlns:a="a"><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:a="a"><a:p><a:r><a:t>Merrin </a:t></a:r><a:r><a:t>Vision</a:t></a:r></a:p><a:p><a:r><a:t>Tagline</a:t></a:r></a:p></p:sld>',
    'ppt/notesSlides/notesSlide1.xml': '<p:notes xmlns:a="a"><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>',
  })
  assert.equal(officeText('pptx', pptx), ['## Slide 1', 'Merrin Vision', 'Tagline', '', 'Notes:', 'Speaker note', '', '## Slide 2', 'Second'].join('\n'))

  const xlsx = zipStored({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Metrics" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; Qs" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Metric</t></si><si><t>Target</t></si><si><r><t>Weekly </t></r><r><t>actives</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>500</v></c><c r="C2"/></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Open question</t></is></c></row></sheetData></worksheet>',
  })
  assert.equal(officeText('xlsx', xlsx), ['## Metrics', 'Metric, Target', 'Weekly actives, 500', '', '## Notes & Qs', 'Open question'].join('\n'))
})

test('office: readDocument handles local .docx files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-office-'))
  const file = join(dir, 'spec.docx')
  writeFileSync(file, zipStored({ 'word/document.xml': DOCX_XML }))
  assert.match(await readDocument(file), /^# Product Spec\n/)
  writeFileSync(join(dir, 'x.zip'), 'zzz')
  await assert.rejects(readDocument(join(dir, 'x.zip')), /unsupported file type ".zip" — give a .md, .txt, .csv, .pdf, .docx/)
})
