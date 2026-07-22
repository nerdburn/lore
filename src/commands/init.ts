import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_FILE } from '../config.js'

const TEMPLATE_CONFIG = {
  project: 'my-project',
  sources: {
    slack: { channels: ['#my-project'], token: 'env:SLACK_TOKEN' },
  },
  backfill: { months: 0 },
  extract: ['requests', 'decisions', 'roadmap', 'weekly-report'],
}

const WORKFLOW_PATH = '.github/workflows/lore-sync.yml'

const AGENTS_POINTER = `## Project context (lore)

This is a standalone [lore](https://github.com/nerdburn/lore) context repo:
project memory synced from Slack daily by GitHub Actions. It is usually kept
separate from the project's code repo — Slack history has a different
audience than code. Project repos point here via \`lore link\`.

- \`context/facts.yaml\` — pinned facts, explicitly stored. Trust these; they win over derived data.
- \`context/derived/\` — roadmap, decisions, outstanding requests, weekly reports. Every item links to its source.
- \`context/streams/\` — raw synced Slack/email/meeting history.
- \`state.json\` — the sync cursor. Committed on purpose; never edit by hand.

Query with \`npx lore grep "<pattern>"\` / \`npx lore recall\`; pin facts on
explicit instruction with \`npx lore remember "<fact>"\`.
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

  // Scheduled deployment: daily cron in this repo, committing straight to
  // the default branch — a context repo has no CI or deploys to protect.
  const workflowPath = join(root, WORKFLOW_PATH)
  if (!existsSync(workflowPath)) {
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(
      workflowPath,
      readFileSync(fileURLToPath(new URL('../../manifests/lore-sync.yml', import.meta.url)), 'utf8'),
    )
  }

  console.log(`Scaffolded ${CONFIG_FILE}, context/, AGENTS.md, and ${WORKFLOW_PATH}.`)
  console.log('Next:')
  console.log('  1. edit lore.json (project name, channels, backfill)')
  console.log('  2. `lore manifest slack` — create the Slack app from the printed manifest')
  console.log('  3. export SLACK_TOKEN=…, then `lore check` and `lore sync`')
  console.log('  4. push this repo + add SLACK_TOKEN to its Actions secrets — the workflow syncs daily')
  console.log('  5. in each project repo: `npx lore link <owner>/<this-repo>`')
}
