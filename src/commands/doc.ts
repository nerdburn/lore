import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { AUDIT_FILE, appendAudit } from '../audit.js'
import { git, resolveContext, readGlobalConfig, type ResolveOptions } from '../context.js'
import { readDocument } from '../document.js'
import { googleDocId, resolveGoogleDoc, type GoogleDoc } from '../gdoc.js'
import { writeDocs } from '../streams.js'
import { buildStreamDoc, DOCS_SOURCE } from '../docs-stream.js'
import { authorizeWrite } from '../write.js'

/**
 * Documents as a stream. A spec, a brief, a deck, a handoff package — a
 * client sends all manner of documents, and they are evidence the same way
 * a Slack message or an email is: raw material under `context/streams/`,
 * grep-able, folded by extract into requests, decisions, and roadmap, each
 * item citing the document's link. Unlike an SOW nothing about a document is
 * authoritative, so it gets no layer of its own — it is one more doc in a
 * stream, `docs`, whose channel is the document's slug.
 *
 * `lore doc add` is the human-driven connector for this stream: an
 * explicit, audited write like `remember` (a document lands because someone
 * said so, not because a sync found it), but the material it writes is a
 * stream doc, not a pin.
 */

export { DOCS_SOURCE }

export interface DocAddInput {
  /** Path to a .md/.txt/.pdf on this machine, or a Docs/Drive link (read via the Workspace service account). */
  file?: string
  /** The document's text, when the caller already has it. Exactly one of `text` / `file`. */
  text?: string
  /** Title; defaults to the Google Doc's name or the file name. Becomes the stream channel slug. */
  title?: string
  /** Who sent or authored the document — the stream heading's author. Defaults to the Drive owner, then the actor. */
  from?: string
  /** YYYY-MM-DD the document belongs to (default today — the day it reached lore). */
  date?: string
  /** Where the document lives; defaults to the Google link. Becomes the permalink every derived item cites. */
  source?: string
  /** For a Google link: the teammate the service account reads as (default `client.owner`). */
  as?: string
}

export interface DocAddOptions extends ResolveOptions {
  /** CLI only: who is attaching this. MCP callers can never set it. */
  by?: string
  via?: 'cli' | 'mcp'
  /** Test seam: how a Google link becomes text. */
  exportDoc?: (url: string, as: string) => Promise<GoogleDoc>
}

export interface DocAdded {
  id: string
  title: string
  /** Stream file, relative to the context root. */
  file: string
  from: string
  date: string
  source?: string
  /** Characters of text stored. */
  chars: number
  /** False when this exact content was already in the stream. */
  written: boolean
}

export async function docAdd(cwd: string, input: DocAddInput, opts: DocAddOptions = {}): Promise<DocAdded> {
  const ctx = resolveContext(cwd, opts)
  const via = opts.via ?? 'cli'
  const actor = authorizeWrite(ctx, opts, 'doc')
  if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error(`doc: --date must be an ISO date (YYYY-MM-DD), got "${input.date}"`)

  let body = input.text
  let title = input.title?.trim()
  let source = input.source
  let from = input.from?.trim()
  const meta: Record<string, string> = {}
  if (body === undefined && input.file && googleDocId(input.file)) {
    const as = input.as ?? ctx.config.client?.owner ?? readGlobalConfig().owner
    if (!as) throw new Error('doc: a Google link needs --as <teammate email> (or client.owner in lore.json, or owner in ~/.lore/config.json) — the service account reads the document as that person')
    const doc = await (opts.exportDoc ?? resolveGoogleDoc)(input.file, as)
    body = doc.markdown
    title ||= doc.name
    source ??= doc.url
    from ||= doc.owner
    meta.gdoc = doc.id
    if (doc.modified) meta.modified = doc.modified
    if (doc.mimeType) meta.mime = doc.mimeType
  } else if (body === undefined && input.file) {
    body = await readDocument(input.file, 'doc')
    title ||= basename(input.file, extname(input.file))
  }
  if (body === undefined) throw new Error('doc: give the document as a file path, a Google Docs/Drive link, or as text')
  if (!body.trim()) throw new Error('doc: the document is empty')
  if (!title) throw new Error('doc: --title is required when the document is given as text')
  from ||= actor

  const date = input.date ?? new Date().toISOString().slice(0, 10)
  const { gdoc: gdocId, ...restMeta } = meta
  const { doc, rel, slug, id } = buildStreamDoc({ title, body, from, date, source, gdocId, meta: restMeta, addedBy: actor })
  const text = doc.text
  const result = writeDocs(ctx.root, [doc])
  const written = result.written === 1
  if (written) {
    appendAudit(ctx.root, {
      at: new Date().toISOString(),
      action: 'doc',
      actor,
      via,
      id,
      ...(source ? { source } : {}),
    })
    if (ctx.mode === 'cache') {
      git(ctx.root, 'add', rel, AUDIT_FILE)
      git(ctx.root, 'commit', '--quiet', '-m', `lore: doc add ${slug} (${Math.round(text.length / 1000)}k chars)`)
      try {
        git(ctx.root, 'push', '--quiet')
      } catch {
        throw new Error(`wrote ${rel} and committed to the cache, but push to ${ctx.repo} failed — check access, then run \`git -C ${ctx.root} push\``)
      }
    }
  }

  const summary: DocAdded = { id, title, file: rel, from, date, ...(source ? { source } : {}), chars: text.length, written }
  if (via === 'cli') {
    const notes = [Object.keys(result.redacted).length ? 'secrets redacted' : ''].filter(Boolean)
    console.log(
      written
        ? `added ${rel}: ${title} — ${summary.chars.toLocaleString()} chars from ${from}${notes.length ? ` (${notes.join(', ')})` : ''}${ctx.repo ? ` → ${ctx.repo}` : ''}`
        : `unchanged: ${title} is already in ${rel} with this exact content`,
    )
  }
  return summary
}

export interface DocEntry {
  id: string
  title: string
  slug: string
  file: string
  from: string
  date: string
  source?: string
  chars: number
}

/** Every document in the `docs` stream, newest first — read from the stream files themselves. */
export function readDocIndex(root: string): DocEntry[] {
  const base = join(root, 'context/streams', DOCS_SOURCE)
  if (!existsSync(base)) return []
  const entries: DocEntry[] = []
  for (const dir of readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    for (const f of readdirSync(join(base, dir.name))) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue
      const rel = join('context/streams', DOCS_SOURCE, dir.name, f)
      const text = readFileSync(join(root, rel), 'utf8')
      // Split on stream headings only — a document's own `### ` headings
      // are body text and carry no id comment.
      const parts = text.split(/\n(?=### [^\n]* — \d{4}-\d{2}-\d{2}T[^\n]*\n<!-- id: doc-)/).slice(1)
      for (const part of parts) {
        const heading = /^### (.*?) — (\d{4}-\d{2}-\d{2})/.exec(part)
        const idm = /^<!-- id: (\S+)/m.exec(part)
        const link = /^\[permalink\]\((\S+)\)$/m.exec(part)
        const titleLine = /\n# (.+)\n/.exec(part)
        if (!heading || !idm) continue
        entries.push({ id: idm[1], title: titleLine?.[1] ?? dir.name, slug: dir.name, file: rel, from: heading[1], date: heading[2], ...(link ? { source: link[1] } : {}), chars: part.length })
      }
    }
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title))
}

export function docList(cwd: string, opts: ResolveOptions & { json?: boolean } = {}): DocEntry[] {
  const ctx = resolveContext(cwd, opts)
  const docs = readDocIndex(ctx.root)
  if (opts.json) console.log(JSON.stringify(docs, null, 2))
  else if (docs.length === 0) console.log('no documents attached — `lore doc add <file-or-link> [--title …] [--from …]`')
  else for (const d of docs) console.log(`${d.date}  ${d.title} — from ${d.from}, ${d.chars.toLocaleString()} chars${d.source ? `  ${d.source}` : ''}  [${d.file}]`)
  return docs
}
