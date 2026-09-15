import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { officeKind, officeText } from './office.js'

/**
 * Local documents as text. Shared by `sow add` and `doc add`: a Markdown or
 * text file as-is, a PDF through pdf.js text extraction, Word/PowerPoint/
 * Excel through the Office reader. `verb` prefixes
 * error messages so each command reads naturally.
 */
export async function readDocument(file: string, verb = 'doc'): Promise<string> {
  if (!existsSync(file)) throw new Error(`${verb}: file not found: ${file}`)
  const ext = extname(file).toLowerCase()
  if (ext === '.pdf') return pdfText(readFileSync(file))
  if (ext === '.md' || ext === '.txt' || ext === '.markdown' || ext === '.csv' || ext === '') return readFileSync(file, 'utf8')
  const office = officeKind(ext)
  if (office) return officeText(office, readFileSync(file))
  throw new Error(`${verb}: unsupported file type "${ext}" — give a .md, .txt, .csv, .pdf, .docx, .pptx, or .xlsx (Google Docs: File → Download → Markdown)`)
}

/** One paragraph per line run; runs joined by their real horizontal gap. */
export async function pdfText(data: Buffer | Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, disableFontFace: true }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    // Runs are joined by their real horizontal gap, not blindly with a
    // space: a ligature ("fi", "fl") arrives as its own run flush against
    // its neighbours, while a word gap shows as a visible offset.
    let line = ''
    let prevEnd: number | undefined
    const lines: string[] = []
    for (const item of content.items as { str: string; hasEOL?: boolean; width?: number; transform?: number[] }[]) {
      const x = item.transform?.[4]
      const size = Math.abs(item.transform?.[0] ?? 10) || 10
      if (line && x !== undefined && prevEnd !== undefined && !line.endsWith(' ') && !item.str.startsWith(' ') && x - prevEnd > size * 0.12) line += ' '
      line += item.str
      prevEnd = x !== undefined ? x + (item.width ?? 0) : undefined
      if (item.hasEOL) {
        lines.push(line.trimEnd())
        line = ''
        prevEnd = undefined
      }
    }
    if (line.trim()) lines.push(line.trimEnd())
    pages.push(lines.join('\n'))
  }
  await doc.cleanup()
  return pages.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
}

/** "Merrin Product Spec v1" → "merrin-product-spec-v1". */
export function slugify(name: string, fallback = 'doc'): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  )
}
