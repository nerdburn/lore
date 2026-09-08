import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { archive, type ArchiveDeps } from '../src/commands/archive.js'
import { createServer } from '../src/commands/mcp.js'
import { recall } from '../src/commands/recall.js'
import { remember } from '../src/commands/remember.js'
import { sync } from '../src/commands/sync.js'
import { extract } from '../src/commands/extract.js'
import { configSchema } from '../src/config.js'
import { githubRepoFromRemote, resolveContext } from '../src/context.js'
import { recallData } from '../src/recall.js'
import { captureConsole, fullFixtureRepo, makeContextRepo } from './helpers.js'

const g = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

/** A context repo with a bare "origin" so push works offline. */
function gitBackedRepo(config?: Record<string, unknown>) {
  const root = makeContextRepo({}, config)
  const bare = mkdtempSync(join(tmpdir(), 'lore-origin-'))
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', bare])
  g(root, 'init', '--quiet', '-b', 'main')
  g(root, 'config', 'user.email', 't@t')
  g(root, 'config', 'user.name', 't')
  g(root, 'remote', 'add', 'origin', bare)
  g(root, 'add', '-A')
  g(root, 'commit', '--quiet', '-m', 'init')
  g(root, 'push', '--quiet', '-u', 'origin', 'main')
  return { root, bare }
}

function fakeDeps() {
  const calls: string[][] = []
  const removed: string[] = []
  const unregistered: string[] = []
  const deps: ArchiveDeps = {
    gh: (args) => void calls.push(args),
    removeCache: (repo) => void removed.push(repo),
    unregister: (project) => {
      unregistered.push(project)
      return true
    },
  }
  return { deps, calls, removed, unregistered }
}

test('config: lifecycle defaults to active and only accepts known states', () => {
  assert.equal(configSchema.parse({ project: 'x' }).lifecycle, 'active')
  assert.equal(configSchema.parse({ project: 'x', lifecycle: 'archived', archived_at: '2026-09-08T00:00:00Z' }).lifecycle, 'archived')
  assert.throws(() => configSchema.parse({ project: 'x', lifecycle: 'paused' }))
})

test('context: githubRepoFromRemote parses ssh and https remotes', () => {
  const { root } = gitBackedRepo()
  assert.equal(githubRepoFromRemote(root), undefined, 'a local bare remote is not GitHub')
  g(root, 'remote', 'set-url', 'origin', 'git@github.com:inputlogic/lore-acme.git')
  assert.equal(githubRepoFromRemote(root), 'inputlogic/lore-acme')
  g(root, 'remote', 'set-url', 'origin', 'https://github.com/inputlogic/lore-acme')
  assert.equal(githubRepoFromRemote(root), 'inputlogic/lore-acme')
})

test('archive: flips lifecycle, commits, pushes, archives on GitHub, cleans registry', async () => {
  const { root, bare } = gitBackedRepo()
  g(root, 'remote', 'set-url', 'origin', 'git@github.com:inputlogic/lore-acme.git')
  g(root, 'remote', 'add', 'local', bare)
  // push goes to the bare "local" mirror since the GitHub URL is fake
  g(root, 'fetch', '--quiet', 'local')
  g(root, 'branch', '--set-upstream-to=local/main')
  const f = fakeDeps()
  const { out } = await captureConsole(() => archive(root, { context: root }, f.deps))

  const cfg = JSON.parse(readFileSync(join(root, 'lore.json'), 'utf8'))
  assert.equal(cfg.lifecycle, 'archived')
  assert.match(cfg.archived_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(f.calls, [['repo', 'archive', 'inputlogic/lore-acme', '--yes']])
  assert.deepEqual(f.unregistered, ['acme'])
  assert.deepEqual(f.removed, [], 'local mode has no cache clone to remove')
  assert.match(g(root, 'log', '-1', '--format=%s'), /lore: archive acme/)
  assert.equal(g(bare, 'log', '-1', '--format=%s'), 'lore: archive acme', 'pushed before archiving')
  assert.match(out, /Still yours to do/)
  assert.match(out, /lore.json pointer/)
})

test('archive: pushes before archiving, and a failed push aborts before touching GitHub', async () => {
  const { root } = gitBackedRepo()
  g(root, 'remote', 'set-url', 'origin', 'git@github.com:inputlogic/lore-acme.git') // unreachable
  const f = fakeDeps()
  await assert.rejects(captureConsole(() => archive(root, { context: root }, f.deps)), /could not push/)
  assert.deepEqual(f.calls, [], 'GitHub untouched when the push failed')
  assert.equal(JSON.parse(readFileSync(join(root, 'lore.json'), 'utf8')).lifecycle, 'archived', 'committed locally')
})

test('archive: is idempotent and --restore reverses it', async () => {
  const { root, bare } = gitBackedRepo({ project: 'acme', lifecycle: 'archived', archived_at: '2026-09-01T00:00:00Z' })
  const f = fakeDeps()
  const again = await captureConsole(() => archive(root, { context: root }, f.deps))
  assert.match(again.out, /already archived/)
  assert.deepEqual(f.calls, [])

  const { out } = await captureConsole(() => archive(root, { context: root, restore: true }, f.deps))
  const cfg = JSON.parse(readFileSync(join(root, 'lore.json'), 'utf8'))
  assert.equal(cfg.lifecycle, 'active')
  assert.equal(cfg.archived_at, undefined)
  assert.deepEqual(f.calls, [], 'no GitHub remote → nothing to unarchive')
  assert.equal(g(bare, 'log', '-1', '--format=%s'), 'lore: restore acme')
  assert.match(out, /reopened/)
})

test('archive: --restore unarchives on GitHub before pulling and pushing', async () => {
  const { root, bare } = gitBackedRepo({ project: 'acme', lifecycle: 'archived', archived_at: '2026-09-01T00:00:00Z' })
  g(root, 'remote', 'set-url', 'origin', 'git@github.com:inputlogic/lore-acme.git')
  g(root, 'remote', 'add', 'local', bare)
  g(root, 'fetch', '--quiet', 'local')
  g(root, 'branch', '--set-upstream-to=local/main')
  const f = fakeDeps()
  await captureConsole(() => archive(root, { context: root, restore: true }, f.deps))
  assert.deepEqual(f.calls, [['repo', 'unarchive', 'inputlogic/lore-acme', '--yes']])
  assert.equal(g(bare, 'log', '-1', '--format=%s'), 'lore: restore acme')
})

test('archive: without a git repo it changes lore.json and says so', async () => {
  const root = makeContextRepo()
  const f = fakeDeps()
  const { out } = await captureConsole(() => archive(root, { context: root }, f.deps))
  assert.match(out, /not a git repo/)
  assert.equal(JSON.parse(readFileSync(join(root, 'lore.json'), 'utf8')).lifecycle, 'archived')
})

test('archive: --keep-local leaves the registry alone', async () => {
  const root = makeContextRepo()
  const f = fakeDeps()
  await captureConsole(() => archive(root, { context: root, keepLocal: true }, f.deps))
  assert.deepEqual(f.unregistered, [])
})

const ARCHIVED = { project: 'acme', lifecycle: 'archived', archived_at: '2026-09-01T12:00:00.000Z' }

test('archived: sync and extract are no-ops', async () => {
  const root = makeContextRepo({}, { ...ARCHIVED, sources: { nope: {} } })
  const s = await captureConsole(() => sync(root, {}))
  assert.equal(s.result.ok, true, 'a missing connector does not matter for an archived client')
  assert.match(s.out, /archived — nothing to sync/)
  const e = await captureConsole(() => extract(root))
  assert.match(e.out, /archived — nothing to extract/)
})

test('archived: remember is refused on the CLI', async () => {
  const root = makeContextRepo({}, ARCHIVED)
  await assert.rejects(captureConsole(() => remember(root, 'x', { context: root })), /archived — its memory is read-only/)
  assert.ok(readFileSync(join(root, 'context/facts.yaml'), 'utf8').trim().endsWith('[]'))
})

test('archived: recall carries the lifecycle and the CLI warns', async () => {
  const root = fullFixtureRepo()
  writeFileSync(join(root, 'lore.json'), JSON.stringify(ARCHIVED))
  const r = recallData(root, resolveContext(root).config)
  assert.equal(r.lifecycle, 'archived')
  assert.equal(r.archived_at, ARCHIVED.archived_at)
  const { err } = await captureConsole(() => recall(root, undefined, { context: root }))
  assert.match(err, /ARCHIVED — acme was archived 2026-09-01/)
})

test('archived: MCP labels reads and refuses writes', async () => {
  const root = fullFixtureRepo()
  writeFileSync(join(root, 'lore.json'), JSON.stringify(ARCHIVED))
  const ctx = resolveContext(root, { context: root })
  const server = createServer(ctx, { cwd: root, opts: { context: root } })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 't', version: '0' })
  await client.connect(ct)

  const tools = (await client.listTools()).tools
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? '']))
  assert.match(byName.lore_recall, /^ARCHIVED client \(engagement ended 2026-09-01/)
  assert.match(byName.lore_grep, /^ARCHIVED client/)
  assert.match(byName.lore_remember, /Unavailable.*archived/)

  const recalled = await client.callTool({ name: 'lore_recall', arguments: {} })
  const parsed = JSON.parse((recalled.content as { text: string }[])[0].text)
  assert.equal(parsed.lifecycle, 'archived')
  assert.equal(parsed.pins.length, 2, 'history still readable')

  const write = await client.callTool({ name: 'lore_remember', arguments: { fact: 'x' } })
  assert.equal(write.isError, true)
  assert.match((write.content as { text: string }[])[0].text, /archived/)
  await Promise.all([client.close(), server.close()])
})
