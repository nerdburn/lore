import { backfillSince, loadConfig, resolveEnvRefs } from '../config.js'
import { connectors } from '../connectors/index.js'
import { loadState, saveState } from '../state.js'
import { writeDocs } from '../streams.js'

/**
 * Deterministic sync: connectors → context/streams/. No LLM involved.
 * Backfill is just cursor seeding, per channel: any channel without a
 * cursor — first sync or newly whitelisted — starts at now minus the
 * configured backfill months; after that, cursors rule. To re-backfill a
 * channel, delete its cursor from state.json.
 */
export async function sync(root: string): Promise<void> {
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

    const since = backfillSince(config, name)

    console.log(`syncing ${name} (new channels since ${new Date(since).toISOString().slice(0, 10)})…`)
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
