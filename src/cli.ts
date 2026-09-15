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
import { sowAdd, sowList } from './commands/sow.js'
import { docAdd, docList } from './commands/doc.js'
import { workAdd, workList, workMove, workPromote, workRank, workSet, workShow } from './commands/work.js'
import { printPush, workPush } from './commands/work-push.js'
import { exportGoogleDoc } from './gdoc.js'

function splitList(value: unknown): string[] | undefined {
  return value === undefined ? undefined : String(value).split(/[;,]/).map((s) => s.trim()).filter(Boolean)
}

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
  .option('--gmail [mailboxes]', 'sync client email from the team\'s Gmail inboxes: comma-separated teammate addresses, "all" for every Workspace mailbox, or no value for the team-side contacts')
  .option('--client <name>', 'client display name (default: project name)')
  .option('--owner <email>', 'team-side account lead → client.owner (default: saved once in ~/.lore/config.json)')
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

const sow = program.command('sow').description('statements of work — the commitments layer: human-weeks sold over a period (human-attached, never LLM-written)')
contextual(
  sow
    .command('add')
    .description('attach an SOW: the document (Markdown/text/PDF; Google Docs: File → Download → Markdown) plus its budget and period; commits and pushes')
    .argument('<file>', 'path to the SOW as .md, .txt, or .pdf — or a docs.google.com link (read via the Workspace service account)')
    .requiredOption('--name <name>', 'e.g. "Jointly SOW 4" (becomes the file slug)')
    .requiredOption('--weeks <n>', 'human-weeks sold', Number)
    .requiredOption('--start <date>', 'effective date, YYYY-MM-DD')
    .option('--end <date>', 'period end, YYYY-MM-DD — only when the SOW states one')
    .option('--signed <date>', 'date signed, YYYY-MM-DD')
    .option('--source <url>', 'where the document lives (Google Doc link)')
    .option('--scope <items>', 'named deliverables, comma- or semicolon-separated, when the SOW lists any')
    .option('--status <s>', 'active | exhausted | superseded | closed (default active)')
    .option('--as <email>', 'for a Google Doc link: the teammate the service account reads it as (default client.owner)')
    .option('--by <who>', 'who is attaching this (defaults to OS username)')
    .option('--keep-commercials', 'keep lines with currency amounts (default: strip them — the repo is readable by every agent)'),
).action(async (file: string, o) => {
  await sowAdd(
    root,
    {
      file,
      name: o.name,
      weeks: o.weeks,
      start: o.start,
      end: o.end,
      signed: o.signed,
      source: o.source,
      scope: o.scope ? String(o.scope).split(/[;,]/) : undefined,
      status: o.status,
      as: o.as,
      keepCommercials: o.keepCommercials,
    },
    o,
  )
})
program
  .command('gdoc')
  .description('Google Docs helpers (need the Workspace service account key on this machine)')
  .command('export')
  .description('export a Google Doc as Markdown via the service account, acting as a teammate')
  .argument('<url>', 'docs.google.com link')
  .requiredOption('--as <email>', 'the Workspace user to read as')
  .option('--json', 'emit {id, name, url, markdown} instead of the markdown')
  .action(async (url: string, o) => {
    const doc = await exportGoogleDoc(url, o.as)
    console.log(o.json ? JSON.stringify(doc) : doc.markdown)
  })
contextual(sow.command('list').description('list attached SOWs').option('--json', 'machine-readable output')).action((o) => void sowList(root, o))

const doc = program.command('doc').description('documents as a stream — specs, briefs, decks, handoff packages: raw material folded like Slack or email, never authoritative')
contextual(
  doc
    .command('add')
    .description('add a document to the `docs` stream: a Google Docs/Drive link (Doc, Slides, Sheet, uploaded Word/PowerPoint/Excel, PDF, text — read via the Workspace service account) or a local .md/.txt/.csv/.pdf/.docx/.pptx/.xlsx; commits and pushes')
    .argument('<file>', 'path to a .md, .txt, .csv, .pdf, .docx, .pptx, or .xlsx — or a docs.google.com / drive.google.com link')
    .option('--title <title>', 'document title (default: the Google Doc name or the file name); becomes the stream channel')
    .option('--from <who>', 'who sent or authored it (default: the Drive owner, else you)')
    .option('--date <date>', 'YYYY-MM-DD the document belongs to (default today)')
    .option('--source <url>', 'where the document lives (default: the Google link) — the permalink derived items cite')
    .option('--as <email>', 'for a Google link: the teammate the service account reads it as (default client.owner)')
    .option('--by <who>', 'who is adding this (defaults to OS username)'),
).action(async (file: string, o) => {
  await docAdd(root, { file, title: o.title, from: o.from, date: o.date, source: o.source, as: o.as }, o)
})
contextual(doc.command('list').description('list documents in the `docs` stream').option('--json', 'machine-readable output')).action((o) => void docList(root, o))

const work = program.command('work').description('the work tracker of record: tickets mirrored from Jira/GitHub, moved by people, agents, and the fold — every move recorded with who and why')
contextual(
  work
    .command('add')
    .description('add a work item; commits and pushes')
    .argument('<title>', 'what the work is')
    .option('--status <s>', `${['todo', 'in_progress', 'blocked', 'done', 'archived'].join(' | ')} (default todo)`)
    .option('--priority <p>', 'P1 | P2 | P3')
    .option('--assignee <who>', 'who is on it')
    .option('--labels <list>', 'comma-separated labels')
    .option('--source <urls>', 'comma-separated evidence links (a Slack permalink, an email)')
    .option('--external <ref>', 'link an existing tracker issue: "jira:INPT-9" or "github:owner/repo#42"')
    .option('--reason <why>', 'why this is being tracked (recorded in history)')
    .option('--by <who>', 'who is adding this (defaults to OS username)'),
).action((title: string, o) => {
  workAdd(root, { title, status: o.status, priority: o.priority, assignee: o.assignee, labels: splitList(o.labels), sources: splitList(o.source), external: o.external, reason: o.reason }, o)
})
contextual(
  work
    .command('promote')
    .description('turn a derived request (req-0007) into a tracked item, keeping its evidence')
    .argument('<request-id>', 'id from `lore recall requests`')
    .option('--title <title>', 'ticket title (default: the request text)')
    .option('--priority <p>', 'P1 | P2 | P3')
    .option('--reason <why>', 'why now (recorded in history)')
    .option('--by <who>', 'who is promoting this'),
).action((id: string, o) => {
  workPromote(root, id, { title: o.title, priority: o.priority, reason: o.reason }, o)
})
contextual(
  work
    .command('move')
    .description('change an item\'s status')
    .argument('<key>', 'e.g. CAR-3')
    .argument('<status>', 'todo | in_progress | blocked | done | archived')
    .requiredOption('--reason <why>', 'why it moved — recorded in history')
    .option('--source <urls>', 'comma-separated evidence links')
    .option('--by <who>', 'who is moving it'),
).action((key: string, status: string, o) => {
  workMove(root, key, status, { reason: o.reason, sources: splitList(o.source) }, o)
})
contextual(
  work
    .command('set')
    .description('change title, priority, assignee, labels, evidence, or the linked tracker issue')
    .argument('<key>', 'e.g. CAR-3')
    .option('--title <title>')
    .option('--priority <p>', 'P1 | P2 | P3')
    .option('--assignee <who>', 'who is on it ("" to clear)')
    .option('--labels <list>', 'comma-separated, replaces the list')
    .option('--source <urls>', 'comma-separated evidence links to add')
    .option('--external <ref>', '"jira:INPT-9" or "github:owner/repo#42"')
    .requiredOption('--reason <why>', 'why — recorded in history')
    .option('--by <who>', 'who is changing it'),
).action((key: string, o) => {
  workSet(root, key, { title: o.title, priority: o.priority, assignee: o.assignee, labels: splitList(o.labels), sources: splitList(o.source), external: o.external }, { reason: o.reason }, o)
})
contextual(
  work
    .command('rank')
    .description('move an item in the priority order (file order is rank)')
    .argument('<key>', 'e.g. CAR-3')
    .option('--above <key>', 'place it directly above this item')
    .option('--top', 'place it first')
    .option('--bottom', 'place it last')
    .requiredOption('--reason <why>', 'why — recorded in history')
    .option('--by <who>', 'who is ranking it'),
).action((key: string, o) => {
  workRank(root, key, { above: o.above, top: o.top, bottom: o.bottom }, { reason: o.reason }, o)
})
contextual(
  work
    .command('push')
    .description('write lore\'s tracker state to Jira: transition linked issues that disagree with lore, create issues for open tickets that have none (explicit only — never from the timer; runs on the lore host)')
    .argument('[keys...]', 'ticket keys, e.g. JNT-3 JNT-7')
    .option('--all', 'every ticket that differs from Jira')
    .option('--dry-run', 'show what would change, change nothing')
    .option('--json', 'machine-readable result')
    .option('--by <who>', 'who is pushing (defaults to OS username)'),
).action(async (keys: string[], o) => {
  const r = await workPush(root, { keys, all: o.all, dryRun: o.dryRun }, o)
  if (o.json) console.log(JSON.stringify(r, null, 2))
  else printPush(r)
})
contextual(work.command('list').description('open items in rank order').option('--all', 'include done and archived').option('--json', 'machine-readable output')).action((o) => void workList(root, o))
contextual(work.command('show').description('one item with its full history').argument('<key>').option('--json', 'machine-readable output')).action((key: string, o) => void workShow(root, key, o))

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
    .description('pull the latest synced memory; --trigger asks the self-hosted host to sync now and waits (~a minute; the fold stays on the timer), or waits out a run already in flight')
    .option('--trigger', 'run the host sync service now (SSH to the configured remote)')
    .option('--fold', 'with --trigger: run sync + the LLM fold (the timer unit) so derived artifacts update too; a minute or two')
    .option('--force', 're-run even if the host synced (or, with --fold, folded) within 5 minutes'),
).action((opts) => {
  const r = refresh(root, opts)
  console.log(`host: ${r.host}${r.fold ? ' [sync + fold]' : ''}${r.outcome ? ` (${r.outcome})` : ''}${r.note ? ` — ${r.note}` : ''}`)
  console.log(`synced: ${r.before.lastSync ?? 'never'} → ${r.after.lastSync ?? 'never'}; extracted: ${r.before.lastExtract ?? 'never'} → ${r.after.lastExtract ?? 'never'}`)
})

contextual(
  program
    .command('mcp')
    .description('serve the query surface as MCP tools over stdio (lore_grep/lore_read/lore_recall/lore_sync_now/lore_remember/lore_sow_add/lore_doc_add/lore_work_*/lore_work_push)')
    .option('--list-tools', 'print the tool table as JSON ({name, writes, summary}) and exit — for provisioning scripts building allow lists; needs no context or network'),
).action((opts) => mcp(root, opts))

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
