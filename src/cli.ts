#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import { archive } from './commands/archive.js'
import { auth } from './commands/auth.js'
import { check } from './commands/check.js'
import { extract } from './commands/extract.js'
import { grep } from './commands/grep.js'
import { init } from './commands/init.js'
import { link } from './commands/link.js'
import { manifest } from './commands/manifest.js'
import { mcp } from './commands/mcp.js'
import { recall } from './commands/recall.js'
import { refresh } from './commands/refresh.js'
import { remember } from './commands/remember.js'
import { runAll } from './commands/run-all.js'
import { setup } from './commands/setup.js'
import { sync } from './commands/sync.js'
import { www } from './commands/www.js'

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
  .option('--github <repos>', 'comma-separated GitHub repos to sync, e.g. "acme/web,acme/mobile"')
  .option('--granola <folders>', 'comma-separated Granola folder titles holding this client\'s meetings, e.g. "Acme"')
  .option('--notion <roots>', 'comma-separated Notion page/database ids or URLs scoping this client\'s docs')
  .option('--jira <scopes>', 'comma-separated Jira project keys and/or board:<id> entries, e.g. "JNT" or "board:293"')
  .option('--jira-site <url>', 'https://<site>.atlassian.net (permalinks; the API too when no proxy)')
  .option('--client <name>', 'client display name (default: project name)')
  .option('--domains <list>', 'comma-separated client email domains, e.g. "acme.com,acme.ca" — scopes Granola meetings and tells extract who the client is')
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
  .action(async () => {
    const summary = await sync(root)
    if (!summary.ok) process.exitCode = 1
  })

program
  .command('extract')
  .description('LLM fold: streams → derived artifacts (requests, decisions, roadmap, weekly report)')
  .option('--report', 'generate the weekly report now, regardless of the configured day')
  .action((opts) => extract(root, opts))

program
  .command('run-all')
  .description('self-hosted scheduler: sync (+ extract) every context repo under --repos, commit, push (run from a timer on the host)')
  .requiredOption('--repos <dir>', 'directory of bare context repos, <name>.git each')
  .requiredOption('--work <dir>', 'directory for working clones')
  .option('--extract', 'run extract after sync (needs LLM credentials in the environment)')
  .option('--report', 'force the weekly report')
  .option('--concurrency <n>', 'clients to run at once (default 3)', '3')
  .action(async (opts) => {
    const summary = await runAll({ ...opts, concurrency: Number(opts.concurrency) })
    if (!summary.ok) process.exitCode = 1
  })

program
  .command('auth')
  .description('authorise a source that needs OAuth (granola): device-code flow, tokens saved to a file the connector refreshes')
  .argument('<source>', 'granola')
  .option('--file <path>', 'token file (default ~/.lore/granola-auth.json)')
  .action((source, opts) => auth(source, opts))

program
  .command('www')
  .description('serve the onboarding playbook + live client status for a self-hosted lore host')
  .requiredOption('--repos <dir>', 'directory of bare context repos')
  .option('--port <n>', 'port (default 8000)', '8000')
  .option('--host <addr>', 'bind address (default 0.0.0.0)')
  .action((opts) => www({ repos: opts.repos, port: Number(opts.port), host: opts.host }))

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
).action((fact, opts) => {
  remember(root, fact, opts)
})

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
    .command('archive')
    .description('end an engagement: mark the context repo archived (sync/extract stop, writes refused, reads labelled), archive it on GitHub, drop the local cache')
    .option('--restore', 'reopen an archived client')
    .option('--keep-local', 'keep the ~/.lore cache clone and registry entry'),
).action((opts) => archive(root, opts))

contextual(
  program
    .command('refresh')
    .description('pull the latest synced memory; --trigger asks the self-hosted host to sync now and waits (~a minute; the fold stays on the hourly timer), or waits out a run already in flight')
    .option('--trigger', 'run the host sync service now (SSH to the configured remote)')
    .option('--force', 're-run even if the host synced within 10 minutes'),
).action((opts) => {
  const r = refresh(root, opts)
  console.log(`host: ${r.host}${r.outcome ? ` (${r.outcome})` : ''}${r.note ? ` — ${r.note}` : ''}`)
  console.log(`synced: ${r.before.lastSync ?? 'never'} → ${r.after.lastSync ?? 'never'}; extracted: ${r.before.lastExtract ?? 'never'} → ${r.after.lastExtract ?? 'never'}`)
})

contextual(
  program
    .command('mcp')
    .description('serve the query surface as MCP tools over stdio (lore_grep/lore_read/lore_recall/lore_remember)'),
).action((opts) => mcp(root, opts))

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
