import { loadConfig, resolveEnvRefs } from '../config.js'
import { connectors } from '../connectors/index.js'
import { loadState } from '../state.js'
import type { Connector } from '../types.js'

/**
 * Validate a context repo before syncing: config shape, every configured
 * source has a connector and its env refs resolve. A source that is
 * configured but unusable is a failure — a sync that quietly collects
 * nothing from a required source is worse than one that refuses to run.
 * Also prints each source's last success / last error from state.json.
 */
export function check(root: string, registry: Record<string, Connector> = connectors): boolean {
  let ok = true
  let config
  try {
    config = loadConfig(root)
    console.log(`✓ lore.json valid (project: ${config.project})`)
  } catch (err) {
    console.error(`✗ lore.json: ${err instanceof Error ? err.message : err}`)
    return false
  }

  const health = loadState(root).sources ?? {}

  for (const [name, sourceConfig] of Object.entries(config.sources)) {
    if (sourceConfig.disabled) {
      console.log(`– source "${name}": disabled`)
      continue
    }
    if (!registry[name]) {
      console.error(
        `✗ source "${name}": no such connector (available: ${Object.keys(registry).join(', ')}) — set "disabled": true to keep it configured but skipped`,
      )
      ok = false
      continue
    }
    const { missing } = resolveEnvRefs(sourceConfig)
    if (missing.length > 0) {
      console.error(`✗ source "${name}": missing env vars: ${missing.join(', ')}`)
      ok = false
    } else {
      console.log(`✓ source "${name}": connector found, env refs resolve`)
    }
    const h = health[name]
    if (h) {
      console.log(`    last success: ${h.lastSuccess ?? 'never'}`)
      if (h.lastError) console.log(`    last error:   ${h.lastError.at} — ${h.lastError.message}`)
    }
  }
  return ok
}
