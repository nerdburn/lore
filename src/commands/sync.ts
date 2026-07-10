import { backfillSince, loadConfig, resolveEnvRefs } from '../config.js'
import { connectors } from '../connectors/index.js'
import { loadState, saveState } from '../state.js'
import { writeDocs } from '../streams.js'

/**
 * Deterministic sync: connectors → context/streams/. No LLM involved.
 * Backfill is just cursor seeding — on a source's first sync, `since` is
 * now minus the configured backfill months; after that, cursors rule.
 */
export async function sync(root: string, opts: { backfill?: boolean } = {}): Promise<void> {
  const config = loadConfig(root)
  const state = loadState(root)

  for (const [name, rawSourceConfig] of Object.entries(config.sources)) {
    const connector = connectors[name]
    if (!connector) {
      console.error(`skipping "${name}": no such connector`)
      continue
    }
    const { resolved, missing } = resolveEnvRefs(rawSourceConfig)
    if (missing.length > 0) {
      console.error(`skipping "${name}": missing env vars: ${missing.join(', ')}`)
      continue
    }

    const firstSync = !state.cursors[name]
    if (opts.backfill && !firstSync) {
      console.log(`${name}: --backfill ignored (cursor exists; delete it from state.json to re-backfill)`)
    }
    const since = firstSync ? backfillSince(config, name) : Date.now()

    console.log(`syncing ${name}${firstSync ? ` (since ${new Date(since).toISOString().slice(0, 10)})` : ''}…`)
    const { docs, nextCursor } = await connector.fetch({
      config: resolved,
      cursor: state.cursors[name] ?? {},
      since,
      log: (msg) => console.log(`  ${msg}`),
    })

    const { written, skipped } = writeDocs(root, docs)
    state.cursors[name] = nextCursor
    console.log(`${name}: ${written} new docs${skipped ? `, ${skipped} already synced` : ''}`)
  }

  state.lastSync = new Date().toISOString()
  saveState(root, state)
}
