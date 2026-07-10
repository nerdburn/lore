import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE } from '../config.js'

const TEMPLATE_CONFIG = {
  project: 'my-project',
  sources: {
    slack: { channels: ['#my-project'], token: 'env:SLACK_TOKEN' },
  },
  backfill: { months: 0 },
  extract: ['requests', 'decisions', 'roadmap', 'weekly-report'],
}

const AGENTS_POINTER = `## Project context (lore)

Structured project memory lives in \`context/\` (managed by [lore](https://github.com/nerdburn/lore)):

- \`context/facts.yaml\` — pinned facts, explicitly stored. Trust these; they win over derived data.
- \`context/derived/\` — roadmap, decisions, outstanding requests, weekly reports. Every item links to its source.
- \`context/streams/\` — raw synced Slack/email/meeting history. Grep this for anything else.

To store something on explicit instruction, run \`npx lore remember "<fact>"\`.
`

export function init(root: string): void {
  if (existsSync(join(root, CONFIG_FILE))) {
    console.log(`${CONFIG_FILE} already exists — nothing to do`)
    return
  }

  writeFileSync(join(root, CONFIG_FILE), JSON.stringify(TEMPLATE_CONFIG, null, 2) + '\n')

  for (const dir of ['context/streams', 'context/derived/reports']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  writeFileSync(join(root, 'context/facts.yaml'), '# Pinned facts. Written only via `lore remember`.\n[]\n')

  // Point agents at context/ — append to an existing AGENTS.md (common when
  // lore lives inside the project's own repo) rather than skipping it.
  // .env holds tokens and .lore/ is the derived local cache — neither
  // belongs in the project's git history.
  const gitignorePath = join(root, '.gitignore')
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
  const missing = ['.env', '.lore/'].filter(
    (entry) => !existing.split('\n').some((line) => line.trim() === entry),
  )
  if (missing.length > 0) {
    appendFileSync(gitignorePath, (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
  }

  const agentsPath = join(root, 'AGENTS.md')
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, AGENTS_POINTER)
  } else if (!readFileSync(agentsPath, 'utf8').includes('## Project context (lore)')) {
    appendFileSync(agentsPath, '\n' + AGENTS_POINTER)
  }

  console.log(`Scaffolded ${CONFIG_FILE}, context/, and AGENTS.md.`)
  console.log('Next:')
  console.log('  1. edit lore.json (project name, channels, backfill)')
  console.log('  2. `lore manifest slack` — create the Slack app from the printed manifest')
  console.log('  3. export SLACK_TOKEN=…, then `lore check` and `lore sync`')
}
