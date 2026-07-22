import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE } from '../config.js'
import { resolveContext } from '../context.js'

const AGENTS_SECTION = (repo: string, project: string) => `## Project context (lore)

Project memory for ${project} lives in a separate context repo
([${repo}](https://github.com/${repo})), synced from Slack daily and queried
through the [lore](https://github.com/nerdburn/lore) CLI — never by reading
files from this repo:

- \`npx lore grep "<pattern>"\` — search the raw history (Slack messages, decisions)
- \`npx lore recall [category]\` — pinned facts + derived artifacts
- \`npx lore remember "<fact>"\` — pin a fact, on explicit instruction only
- \`npx lore mcp\` — the same three as MCP tools over stdio

The \`lore.json\` here is just the pointer; the CLI clones/pulls the context
repo into \`~/.lore/cache\` automatically.
`

/**
 * Point a project repo at its context repo. The whole install is one small
 * file — no context/, no workflow, no secrets; those live with the data.
 */
export function link(cwd: string, repo: string): void {
  const configPath = join(cwd, CONFIG_FILE)
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    if (raw.sources) {
      console.error(`${CONFIG_FILE} here is a full config (this looks like a context repo) — not overwriting`)
      process.exitCode = 1
      return
    }
  }

  // Validate the pointer by resolving it (clones into the cache as a side effect).
  const ctx = resolveContext(cwd, { context: repo })

  writeFileSync(configPath, JSON.stringify({ context: repo }, null, 2) + '\n')

  const agentsPath = join(cwd, 'AGENTS.md')
  const section = AGENTS_SECTION(repo, ctx.config.project)
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, section)
  } else if (!readFileSync(agentsPath, 'utf8').includes('## Project context (lore)')) {
    appendFileSync(agentsPath, '\n' + section)
  }

  console.log(`linked → ${repo} (project: ${ctx.config.project})`)
  console.log(`wrote ${CONFIG_FILE} pointer and an AGENTS.md section — commit both`)
}
