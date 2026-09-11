import { resolveContext, type ResolveOptions } from '../context.js'
import { isEmpty, recallData } from '../recall.js'

/**
 * Read back the structured layers: pinned facts plus whatever derived
 * artifacts exist (requests, decisions, roadmap, contradictions, reports).
 * Streams are for `grep`; this is for "what do we know" without a search
 * term. Shares its implementation with the MCP `lore_recall` tool.
 */
export function recall(cwd: string, category: string | undefined, opts: ResolveOptions & { json?: boolean }): void {
  const ctx = resolveContext(cwd, opts)
  const recalled = recallData(ctx.root, ctx.config, category)

  if (opts.json) {
    console.log(JSON.stringify(recalled, null, 2))
    return
  }

  if (recalled.lifecycle === 'archived') {
    console.error(`ARCHIVED — ${recalled.project} was archived ${recalled.archived_at?.slice(0, 10) ?? ''}; this is history, not current state.`)
  }
  if (isEmpty(recalled)) {
    console.log(category ? `nothing recalled for category "${category}"` : 'nothing pinned or derived yet')
    return
  }
  for (const pin of recalled.pins) {
    console.log(`[${pin.category}] ${pin.fact}  (${pin.id}, ${pin.authorized_by}, ${pin.date})`)
  }
  for (const [name, items] of Object.entries(recalled.derived)) {
    console.log(`\n## ${name}`)
    console.log(typeof items === 'string' ? items : JSON.stringify(items, null, 2))
  }
  for (const [name, table] of Object.entries(recalled.work)) {
    const c = table.counts
    console.log(`\n## work: ${name} (source-owned) — ${c.open} open, ${c.merged} merged, ${c.closed} closed; full table: ${table.file}`)
    console.log(JSON.stringify(table.open, null, 2))
  }
  for (const s of recalled.sow) {
    console.log(`\n## sow: ${s.name} [${s.status}] — ${s.weeks} human-weeks, effective ${s.start}${s.end ? ` to ${s.end}` : ''}${s.scope?.length ? `; scope: ${s.scope.join('; ')}` : ''}; document: ${s.file}`)
  }
  for (const report of recalled.reports) {
    console.log(`\n## report ${report.date}\n${report.text.trimEnd()}`)
  }
  const { lastSync, lastExtract } = recalled.synced
  if (lastSync || lastExtract) {
    console.error(`\n(synced ${lastSync ?? 'never'}, extracted ${lastExtract ?? 'never'})`)
  }
}
