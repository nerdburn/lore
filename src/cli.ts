#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import { check } from './commands/check.js'
import { extract } from './commands/extract.js'
import { grep } from './commands/grep.js'
import { init } from './commands/init.js'
import { link } from './commands/link.js'
import { manifest } from './commands/manifest.js'
import { mcp } from './commands/mcp.js'
import { recall } from './commands/recall.js'
import { remember } from './commands/remember.js'
import { setup } from './commands/setup.js'
import { sync } from './commands/sync.js'

/** Options shared by every command that reads or writes a context repo. */
function contextual(cmd: Command): Command {
  return cmd
    .option('--context <repo>', 'context repo ("owner/repo" or path), overriding lore.json resolution')
    .option('-p, --project <name>', 'resolve the context repo from ~/.lore/registry.json by project name')
    .option('--no-pull', 'skip pulling the cache clone (offline / hot loop)')
}

const program = new Command()
const root = process.cwd()

// Load .env from the context repo so tokens don't need exporting per-session.
// Real env vars win over .env values (Node's loadEnvFile semantics).
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'))

program
  .name('lore')
  .description('Git-native project memory for agents. Everything derived, except what you explicitly remember.')
  .version('0.3.0')

program
  .command('init')
  .description('scaffold lore.json, context/, and an AGENTS.md pointer')
  .action(() => init(root))

program
  .command('setup')
  .description('wizard: create + scaffold + push a context repo, set the secret, dispatch the first sync, link this repo')
  .argument('[repo]', 'context repo name or "owner/name" (derived from cwd/channels if omitted)')
  .option('--channels <list>', 'comma-separated Slack channels, e.g. "#acme,#acme-dev"')
  .option('--backfill <months>', 'backfill window for the first sync (default 3)')
  .option('--org <org>', 'GitHub org for context repos (asked once and saved to ~/.lore/config.json)')
  .option('-y, --yes', 'no prompts: accept derived defaults (for agents and scripts)')
  .action((repo, opts) => setup(root, repo, opts))

program
  .command('check')
  .description('validate config, connectors, and env key references')
  .action(() => {
    if (!check(root)) process.exitCode = 1
  })

program
  .command('sync')
  .description('pull new docs from all configured sources into context/streams/ (no LLM; new channels backfill automatically)')
  .action(() => sync(root))

program
  .command('extract')
  .description('LLM fold: streams → derived artifacts (requests, decisions, roadmap, weekly report)')
  .option('--report', 'generate the weekly report now, regardless of the configured day')
  .action((opts) => extract(root, opts))

program
  .command('manifest')
  .description('print a bundled app manifest for a source (e.g. `lore manifest slack | pbcopy`)')
  .argument('<source>', 'source to print the manifest for')
  .action((source) => manifest(source))

contextual(
  program
    .command('remember')
    .description('pin a fact — the only explicit write path (pushes immediately in pointer mode)')
    .argument('<fact>', 'the fact to store')
    .option('-c, --category <category>', 'e.g. client, deployment, decisions')
    .option('--by <who>', 'who authorized this (defaults to OS username)')
    .option('--source <url>', 'optional source link'),
).action((fact, opts) => remember(root, fact, opts))

program
  .command('link')
  .description('point this project repo at a context repo (writes a one-line lore.json pointer + AGENTS.md section)')
  .argument('<repo>', 'context repo, e.g. "inputlogic/lore-acme"')
  .action((repo) => link(root, repo))

contextual(
  program
    .command('grep')
    .description('search project memory (streams, facts, derived) — works from any linked repo, or anywhere with -p/--context')
    .argument('<pattern>', 'regex (falls back to literal)')
    .option('-i, --ignore-case', 'case-insensitive')
    .option('--channel <name>', 'filter by path substring, e.g. a channel name')
    .option('--limit <n>', 'max matches (default 100)')
    .option('--json', 'machine-readable output'),
).action((pattern, opts) => grep(root, pattern, opts))

contextual(
  program
    .command('recall')
    .description('pinned facts + derived artifacts — "what do we know" without a search term')
    .argument('[category]', 'filter, e.g. deployment, decisions')
    .option('--json', 'machine-readable output'),
).action((category, opts) => recall(root, category, opts))

contextual(
  program
    .command('mcp')
    .description('serve the query surface as MCP tools over stdio (lore_grep/lore_read/lore_recall/lore_remember)'),
).action((opts) => mcp(root, opts))

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
