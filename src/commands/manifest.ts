import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Print a bundled app manifest so installers can create the app by pasting
 * JSON instead of clicking through scope config. Manifest JSON goes to
 * stdout (pipe-friendly: `lore manifest slack | pbcopy`); instructions go
 * to stderr.
 */
const MANIFESTS: Record<string, { file: string; instructions: string[] }> = {
  slack: {
    file: 'slack.json',
    instructions: [
      'Create the Slack app from this manifest:',
      '  1. https://api.slack.com/apps → Create New App → "From a manifest"',
      '  2. Pick your workspace, paste the JSON, create',
      '  3. Install App → copy the Bot User OAuth Token (xoxb-…) → export SLACK_TOKEN=…',
      '  4. /invite @lore in each channel listed in lore.json',
    ],
  },
}

export function manifest(source: string): void {
  const entry = MANIFESTS[source]
  if (!entry) {
    console.error(`no manifest for "${source}" (available: ${Object.keys(MANIFESTS).join(', ')})`)
    process.exitCode = 1
    return
  }
  const path = fileURLToPath(new URL(`../../manifests/${entry.file}`, import.meta.url))
  process.stdout.write(readFileSync(path, 'utf8'))
  for (const line of entry.instructions) console.error(line)
}
