import { resolveContext, type ResolveOptions } from '../context.js'
import { buildLoad } from '../load/build.js'
import { queryLoad, type LoadQuery } from '../load/query.js'
import { LOAD_FILE, readLoad, rebuildLoad, loadFreshness, optionalLoad } from '../load/store.js'
import { extractSemanticLoad } from '../load/semantic-extract.js'
import { authorizeWrite } from '../write.js'
import { appendAudit } from '../audit.js'
import { commitWork } from './work.js'

export type LoadOptions = ResolveOptions & LoadQuery & { json?: boolean; preview?: boolean; by?: string; maxBatches?: number }

export function loadQuery(cwd: string, opts: LoadOptions = {}) {
  const ctx = resolveContext(cwd, opts)
  const snapshot = readLoad(ctx.root)
  const result = { ...queryLoad(snapshot, opts), freshness: loadFreshness(ctx.root, snapshot) }
  if (result.freshness !== 'current') result.warnings.push(`Projection freshness: ${result.freshness}; rebuild to include newer source data or role mappings.`)
  printLoad(result, opts.json)
  return result
}

export function loadRebuild(cwd: string, opts: LoadOptions = {}) {
  const ctx = resolveContext(cwd, opts)
  if (opts.preview) {
    const result = queryLoad(buildLoad(ctx.root, undefined, optionalLoad(ctx.root)?.semantic), opts)
    printLoad(result, opts.json)
    return result
  }
  const actor = authorizeWrite(ctx, opts, 'Load rebuild')
  const snapshot = rebuildLoad(ctx.root)
  appendAudit(ctx.root, { at: new Date().toISOString(), action: 'load', actor, via: 'cli', id: snapshot.fingerprint })
  commitWork(ctx, LOAD_FILE, 'lore: rebuild activity counts')
  const result = queryLoad(snapshot, opts)
  printLoad(result, opts.json)
  return result
}

export async function loadExtract(cwd: string, opts: LoadOptions = {}) {
  const ctx = resolveContext(cwd, opts)
  const actor = authorizeWrite(ctx, opts, 'Load semantic extraction')
  try {
    await extractSemanticLoad(ctx.root, { maxBatches: opts.maxBatches, log: opts.json ? message => console.error(message) : console.log })
  } finally {
    // A later failed batch must not discard earlier validated checkpoints.
    appendAudit(ctx.root, { at: new Date().toISOString(), action: 'load', actor, via: 'cli', id: 'semantic-extraction' })
    commitWork(ctx, LOAD_FILE, 'lore: extract decisions, requests and commitments')
  }
  return loadQuery(cwd, opts)
}

function printLoad(result: ReturnType<typeof queryLoad>, json = false): void {
  if (json) { console.log(JSON.stringify(result, null, 2)); return }
  console.log(`${result.project}: observed activity (${result.range.timezone}; end date exclusive)`)
  console.log(`Built ${result.projection.builtAt}${result.projection.inputRevision ? ` from ${result.projection.inputRevision.slice(0, 12)}` : ''}`)
  for (const row of result.groups) console.log(`${row.key}: ${row.accepted} accepted${row.candidates ? `; ${row.candidates} candidate events` : ''}`)
  if (result.completionBySurface.length) console.log(`Completions recorded via: ${result.completionBySurface.map(r => `${r.surface}: ${r.accepted} accepted${r.candidates ? `; ${r.candidates} candidates` : ''}`).join(', ')} (recorder, not necessarily implementer)`)
  if (!result.groups.length) console.log('No dated matches in retained evidence. Check coverage below.')
  if (result.events) for (const e of result.events) console.log(`${e.id} | ${e.occurred_at ?? e.occurred_on ?? 'unknown date'} | ${e.type} | ${e.method} | ${e.status} | ${e.summary}\n  ${e.evidence.map(v => `${v.path}#${v.doc_id ?? v.history_id}${v.quote ? `\n    ${v.quote}` : ''}`).join('\n  ')}`)
  if (result.semanticCoverage) console.log(`Semantic coverage: ${result.semanticCoverage.processed}/${result.semanticCoverage.chunks} chunks processed; ${result.semanticCoverage.pending} pending${result.semanticCoverage.error ? `; ${result.semanticCoverage.error}` : ''}`)
  for (const c of result.coverage) console.log(`${c.source}: ${c.status}; ${c.documents} source records${c.error ? `; ${c.error}` : ''}`)
  console.log(`Attribution: ${result.attribution.eventsWithoutKnownRole} matching events without known roles; ${result.undatedExcluded} undated events excluded.`)
  for (const warning of result.warnings) console.log(`Note: ${warning}`)
}
