#!/usr/bin/env node
import { Command } from 'commander'
import { check } from './commands/check.js'
import { extract } from './commands/extract.js'
import { init } from './commands/init.js'
import { manifest } from './commands/manifest.js'
import { remember } from './commands/remember.js'
import { sync } from './commands/sync.js'

const program = new Command()
const root = process.cwd()

program
  .name('lore')
  .description('Git-native project memory for agents. Everything derived, except what you explicitly remember.')
  .version('0.1.0')

program
  .command('init')
  .description('scaffold lore.json, context/, and an AGENTS.md pointer')
  .action(() => init(root))

program
  .command('check')
  .description('validate config, connectors, and env key references')
  .action(() => {
    if (!check(root)) process.exitCode = 1
  })

program
  .command('sync')
  .description('pull new docs from all configured sources into context/streams/ (no LLM)')
  .option('--backfill', 'seed first sync from the configured backfill window')
  .action((opts) => sync(root, opts))

program
  .command('extract')
  .description('LLM fold: streams → derived artifacts (roadmap, decisions, requests, report)')
  .action(() => extract(root))

program
  .command('manifest')
  .description('print a bundled app manifest for a source (e.g. `lore manifest slack | pbcopy`)')
  .argument('<source>', 'source to print the manifest for')
  .action((source) => manifest(source))

program
  .command('remember')
  .description('pin a fact to context/facts.yaml — the only explicit write path')
  .argument('<fact>', 'the fact to store')
  .option('-c, --category <category>', 'e.g. client, deployment, decisions')
  .option('--by <who>', 'who authorized this (defaults to OS username)')
  .option('--source <url>', 'optional source link')
  .action((fact, opts) => remember(root, fact, opts))

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
