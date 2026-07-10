import { loadConfig, resolveEnvRefs } from '../config.js'
import { connectors } from '../connectors/index.js'

export function check(root: string): boolean {
  let ok = true
  let config
  try {
    config = loadConfig(root)
    console.log(`✓ lore.json valid (project: ${config.project})`)
  } catch (err) {
    console.error(`✗ lore.json: ${err instanceof Error ? err.message : err}`)
    return false
  }

  for (const [name, sourceConfig] of Object.entries(config.sources)) {
    if (!connectors[name]) {
      console.error(`✗ source "${name}": no such connector (available: ${Object.keys(connectors).join(', ')})`)
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
  }
  return ok
}
