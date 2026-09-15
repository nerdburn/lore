import { inflateRawSync } from 'node:zlib'

/**
 * Office documents as text — .docx, .pptx, .xlsx — without a dependency.
 * They are zip archives of XML; this reads the archive (stored or deflated
 * entries) and pulls the visible text out of the parts that carry it:
 * paragraphs, list items and table rows for Word; slide paragraphs for
 * PowerPoint; shared strings and cell values per sheet for Excel. Enough
 * for grep, the fold, and an agent reading a spec — not a faithful render.
 */

export const OFFICE_MIMES: Record<string, 'docx' | 'pptx' | 'xlsx'> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

export type OfficeKind = 'docx' | 'pptx' | 'xlsx'

export function officeKind(mimeOrName: string): OfficeKind | undefined {
  if (OFFICE_MIMES[mimeOrName]) return OFFICE_MIMES[mimeOrName]
  const m = /\.(docx|pptx|xlsx)$/i.exec(mimeOrName)
  return m ? (m[1].toLowerCase() as OfficeKind) : undefined
}

export function officeText(kind: OfficeKind, data: Buffer | Uint8Array): string {
  const files = unzip(Buffer.isBuffer(data) ? data : Buffer.from(data))
  switch (kind) {
    case 'docx':
      return docxText(files)
    case 'pptx':
      return pptxText(files)
    case 'xlsx':
      return xlsxText(files)
  }
}

// ---- zip ----

/** Entry name → contents. Handles stored and deflated entries; ignores everything else. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  // End of central directory record: signature 0x06054b50, at most 64K of comment before EOF.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const entries = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < entries && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + compressed)
    if (method === 0) out.set(name, Buffer.from(raw))
    else if (method === 8) {
      try {
        out.set(name, inflateRawSync(raw))
      } catch {
        /* a damaged part is skipped, the rest still reads */
      }
    }
  }
  return out
}

// ---- xml helpers ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Text of every `<tag>…</tag>` in order, tags nested inside stripped. */
function collect(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  for (const m of xml.matchAll(re)) out.push(m[1])
  return out
}

function runsText(fragment: string, textTag: string, tabTag?: string, brTag?: string): string {
  let s = fragment
  if (tabTag) s = s.replace(new RegExp(`<${tabTag}\\s*/>`, 'g'), '\t')
  if (brTag) s = s.replace(new RegExp(`<${brTag}(?:\\s[^>]*)?/>`, 'g'), '\n')
  const parts: string[] = []
  const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>|\\t|\\n`, 'g')
  for (const m of s.matchAll(re)) parts.push(m[1] !== undefined ? decodeXml(m[1]) : m[0])
  return parts.join('')
}

// ---- docx ----

function docxText(files: Map<string, Buffer>): string {
  const xml = files.get('word/document.xml')?.toString('utf8')
  if (!xml) throw new Error('docx: no word/document.xml')
  const body = collect(xml, 'w:body')[0] ?? xml
  const lines: string[] = []
  // Tables first: each row becomes one line of cells; then drop them from the body so paragraphs are not repeated.
  let rest = body
  for (const tbl of collect(body, 'w:tbl')) {
    for (const row of collect(tbl, 'w:tr')) {
      const cells = collect(row, 'w:tc').map((c) => collect(c, 'w:p').map(paragraph).filter(Boolean).join(' '))
      lines.push(`| ${cells.join(' | ')} |`)
    }
    lines.push('')
    rest = rest.replace(tbl, '')
  }
  const tableText = lines.splice(0)
  for (const p of collect(rest, 'w:p')) {
    const t = paragraph(p)
    lines.push(t)
  }
  return [...lines, ...(tableText.length ? ['', ...tableText] : [])]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  function paragraph(p: string): string {
    const text = runsText(p, 'w:t', 'w:tab', 'w:br').trim()
    if (!text) return ''
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(p)?.[1] ?? ''
    const heading = /^heading\s*(\d)$/i.exec(style) ?? /^(?:title)$/i.exec(style)
    if (heading) return `${'#'.repeat(Math.min(Number(heading[1] ?? 1), 6))} ${text}`
    if (/<w:numPr>/.test(p)) return `- ${text}`
    return text
  }
}

// ---- pptx ----

function pptxText(files: Map<string, Buffer>): string {
  const slides = [...files.keys()]
    .map((k) => ({ k, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(k)?.[1]) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n)
  if (slides.length === 0) throw new Error('pptx: no slides')
  const out: string[] = []
  for (const s of slides) {
    const xml = files.get(s.k)!.toString('utf8')
    const paras = collect(xml, 'a:p')
      .map((p) => runsText(p, 'a:t', undefined, 'a:br').trim())
      .filter(Boolean)
    out.push(`## Slide ${s.n}`, ...paras, '')
    const notes = files.get(`ppt/notesSlides/notesSlide${s.n}.xml`)?.toString('utf8')
    if (notes) {
      const n = collect(notes, 'a:p')
        .map((p) => runsText(p, 'a:t').trim())
        .filter((t) => t && !/^\d+$/.test(t))
      if (n.length) out.push('Notes:', ...n, '')
    }
  }
  return out.join('\n').trim()
}

// ---- xlsx ----

function xlsxText(files: Map<string, Buffer>): string {
  const shared = collect(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '', 'si').map((si) => runsText(si, 't'))
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') ?? ''
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const relTarget = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\s[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) relTarget.set(m[1], m[2])
  for (const m of rels.matchAll(/<Relationship\s[^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"/g)) relTarget.set(m[2], m[1])
  const sheets: { name: string; path: string }[] = []
  for (const m of workbook.matchAll(/<sheet\s[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    const target = relTarget.get(m[2])
    if (target) sheets.push({ name: decodeXml(m[1]), path: target.startsWith('/') ? target.slice(1) : `xl/${target}` })
  }
  if (sheets.length === 0) for (const k of [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()) sheets.push({ name: k.replace(/^.*\/|\.xml$/g, ''), path: k })
  const out: string[] = []
  for (const sheet of sheets) {
    const xml = files.get(sheet.path)?.toString('utf8')
    if (!xml) continue
    out.push(`## ${sheet.name}`)
    for (const row of collect(xml, 'row')) {
      const cells: string[] = []
      for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]
        const inner = c[2] ?? ''
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
        let v = ''
        if (type === 's') v = shared[Number(/<v>([^<]*)<\/v>/.exec(inner)?.[1])] ?? ''
        else if (type === 'inlineStr') v = runsText(inner, 't')
        else v = decodeXml(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? '')
        cells.push(v.replace(/\s+/g, ' ').trim())
      }
      while (cells.length && cells[cells.length - 1] === '') cells.pop()
      if (cells.length) out.push(cells.join(', '))
    }
    out.push('')
  }
  return out.join('\n').trim()
}
