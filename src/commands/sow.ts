import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { AUDIT_FILE, appendAudit } from '../audit.js'
import { git, gitCommit, resolveContext, type ResolveOptions } from '../context.js'
import { googleDocId, resolveGoogleDoc, type GoogleDoc } from '../gdoc.js'
import { pdfText, readDocument as readDocumentFile } from '../document.js'
import { scrub } from '../scrub.js'
import { authorizeWrite } from '../write.js'
import { readGlobalConfig } from '../context.js'
import { readSows, SOW_DIR, SOW_STATUSES, sowSlug, stripCommercials, summarizeSow, type SowMeta, type SowStatus, type SowSummary } from '../sow.js'

export interface SowAddInput {
  name: string
  weeks: number
  start: string
  end?: string
  /** Document text (markdown). Exactly one of `text` / `file`. */
  text?: string
  /** Path to a .md/.txt/.pdf on this machine, or a docs.google.com link (exported via the Workspace service account). */
  file?: string
  /** For a Google Doc link: the teammate the service account reads as (default `client.owner`). */
  as?: string
  signed?: string
  source?: string
  scope?: string[]
  status?: SowStatus
  /** Keep lines carrying currency amounts (default: strip them). */
  keepCommercials?: boolean
}

export interface SowAddOptions extends ResolveOptions {
  /** CLI only: who is attaching this. MCP callers can never set it. */
  by?: string
  via?: 'cli' | 'mcp'
  /** Hosted MCP only: the platform-attested caller; see WriteGateOptions. */
  actor?: string
| 'mcp'
  /** Test seam: how a Google Doc link becomes markdown. */
  exportDoc?: (url: string, as: string) => Promise<GoogleDoc>
}

/**
 * Attach a statement of work to project memory (`context/sow/<slug>.md`).
 * A write verb in the `remember` family: explicit, audited, gated by
 * `write.allow`, committed and pushed at once in cache mode. The body is
 * scrubbed like every stream doc and, by default, stripped of lines with
 * currency amounts — the commitment lore tracks is in weeks.
 */
export async function sowAdd(cwd: string, input: SowAddInput, opts: SowAddOptions = {}): Promise<SowSummary> {
  const ctx = resolveContext(cwd, opts)
  const via = opts.via ?? 'cli'
  const actor = authorizeWrite(ctx, opts, 'sow')

  if (!input.name.trim()) throw new Error('sow: --name is required')
  if (!(input.weeks > 0)) throw new Error('sow: --weeks must be a positive number of human-weeks')
  for (const [k, v] of [['start', input.start], ['end', input.end], ['signed', input.signed]] as const) {
    if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`sow: --${k} must be an ISO date (YYYY-MM-DD), got "${v}"`)
  }
  if (input.end && input.end < input.start) throw new Error('sow: --end is before --start')
  const status = input.status ?? 'active'
  if (!SOW_STATUSES.includes(status)) throw new Error(`sow: status must be one of ${SOW_STATUSES.join(', ')}`)

  let body = input.text
  let source = input.source
  if (body === undefined && input.file && googleDocId(input.file)) {
    const as = input.as ?? ctx.config.client?.owner ?? readGlobalConfig().owner
    if (!as) throw new Error('sow: a Google Doc link needs --as <teammate email> (or client.owner in lore.json, or owner in ~/.lore/config.json) — the service account reads the doc as that person')
    const doc = await (opts.exportDoc ?? resolveGoogleDoc)(input.file, as)
    body = doc.markdown
    source ??= doc.url
  } else if (body === undefined && input.file) body = await readDocument(input.file)
  if (body === undefined) throw new Error('sow: give the document as a file path, a Google Doc link, or as text')
  let removed = 0
  if (!input.keepCommercials) ({ text: body, removed } = stripCommercials(body))
  const clean = scrub(body)
  body = clean.text.trim()

  const slug = sowSlug(input.name)
  const rel = `${SOW_DIR}/${slug}.md`
  const path = join(ctx.root, rel)
  const existed = existsSync(path)
  const meta: SowMeta = {
    name: input.name.trim(),
    weeks: input.weeks,
    start: input.start,
    ...(input.end ? { end: input.end } : {}),
    status,
    ...(input.signed ? { signed: input.signed } : {}),
    ...(source ? { source } : {}),
    ...(input.scope?.length ? { scope: input.scope.map((s) => s.trim()).filter(Boolean) } : {}),
    added_by: actor,
    added: new Date().toISOString().slice(0, 10),
  }
  mkdirSync(join(ctx.root, SOW_DIR), { recursive: true })
  writeFileSync(path, `---\n${stringify(meta).trimEnd()}\n---\n\n${body}\n`)
  appendAudit(ctx.root, {
    at: new Date().toISOString(),
    action: 'sow',
    actor,
    via,
    id: slug,
    ...(source ? { source } : {}),
  })

  if (ctx.mode === 'cache') {
    git(ctx.root, 'add', rel, AUDIT_FILE)
    gitCommit(ctx.root, '--quiet', '-m', `lore: sow ${existed ? 'update' : 'add'} ${slug} (${meta.weeks} weeks, effective ${meta.start})`)
    try {
      git(ctx.root, 'push', '--quiet')
    } catch {
      throw new Error(`wrote ${rel} and committed to the cache, but push to ${ctx.repo} failed — check access, then run \`git -C ${ctx.root} push\``)
    }
  }

  const summary = summarizeSow(readSows(ctx.root).find((s) => s.id === slug)!)
  if (via === 'cli') {
    const notes = [removed ? `${removed} line(s) with amounts stripped` : '', Object.keys(clean.redacted).length ? 'secrets redacted' : ''].filter(Boolean)
    console.log(`${existed ? 'updated' : 'added'} ${rel}: ${meta.name} — ${meta.weeks} weeks, effective ${meta.start}${meta.end ? ` to ${meta.end}` : ''}${notes.length ? ` (${notes.join(', ')})` : ''}${ctx.repo ? ` → ${ctx.repo}` : ''}`)
  }
  return summary
}

export function sowList(cwd: string, opts: ResolveOptions & { json?: boolean } = {}): SowSummary[] {
  const ctx = resolveContext(cwd, opts)
  const sows = readSows(ctx.root).map((s) => summarizeSow(s))
  if (opts.json) console.log(JSON.stringify(sows, null, 2))
  else if (sows.length === 0) console.log('no statements of work attached — `lore sow add <file-or-link> --name … --weeks … --start …`')
  else for (const s of sows) console.log(`${s.status.padEnd(10)} ${s.name}: ${s.weeks} weeks, effective ${s.start}${s.end ? ` to ${s.end}` : ''}${s.scope?.length ? ` — scope: ${s.scope.join('; ')}` : ''}  [${s.file}]`)
  return sows
}

/** .md/.txt as-is; .pdf via pdf.js text extraction (shared with `doc add`). */
export function readDocument(file: string): Promise<string> {
  return readDocumentFile(file, 'sow')
}

export { pdfText }
