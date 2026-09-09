// Self-hosted layout: bare repos on a "remote" (here: a local directory),
// resolved through ~/.lore/config.json `remote`, synced by `run-all`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { runAll } from '../src/commands/run-all.js'
import { buildSources } from '../src/commands/setup.js'
import { refresh, sshTargetFromRemote } from '../src/commands/refresh.js'
import { configSchema } from '../src/config.js'
import { cachePath, isRepoRef, readGlobalConfig, remoteUrl, resolveContext, writeGlobalConfig } from '../src/context.js'
import type { Connector, Doc } from '../src/types.js'
import { captureConsole, makeContextRepo } from './helpers.js'

const home = mkdtempSync(join(tmpdir(), 'lore-home-'))
const repos = mkdtempSync(join(tmpdir(), 'lore-repos-'))
const work = mkdtempSync(join(tmpdir(), 'lore-work-'))
process.env.LORE_HOME = home

const g = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

/** Scaffold a context repo and push it into <repos>/<name>.git, as `lore setup` would. */
function seedBare(name: string, config: Record<string, unknown>, files: Record<string, string> = {}) {
  const bare = join(repos, `${name}.git`)
  mkdirSync(bare, { recursive: true })
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', bare])
  const src = makeContextRepo(files, config)
  g(src, 'init', '--quiet', '-b', 'main')
  g(src, 'config', 'user.email', 't@t')
  g(src, 'config', 'user.name', 't')
  g(src, 'add', '-A')
  g(src, 'commit', '--quiet', '-m', 'scaffold')
  g(src, 'push', '--quiet', bare, 'main')
  return bare
}

before(() => {
  writeGlobalConfig({ remote: repos, proxy: { slack: 'http://slack.int.exe.xyz/api', github: 'http://gh.int.exe.xyz' } })
})

test('config: LORE_HOME redirects the global config, registry and cache', () => {
  assert.equal(readGlobalConfig().remote, repos)
  assert.ok(cachePath('lore-acme').startsWith(home))
})

test('context: bare names are repo refs when a remote is configured; owner/repo stays GitHub', () => {
  assert.ok(isRepoRef('lore-acme'))
  assert.ok(isRepoRef('inputlogic/lore-acme'))
  assert.ok(!isRepoRef('not a ref'))
  assert.equal(remoteUrl('lore-acme'), `${repos}/lore-acme.git`)
  assert.equal(remoteUrl('inputlogic/lore-acme'), 'git@github.com:inputlogic/lore-acme.git')
  assert.equal(remoteUrl('inputlogic/lore-acme', true), 'https://github.com/inputlogic/lore-acme.git')
})

test('context: a pointer to a remote name clones from the remote into the cache and registers the project', () => {
  seedBare('lore-acme', { project: 'acme', sources: { slack: { channels: ['#acme'], api_base: 'http://slack.int.exe.xyz/api' } } })
  const pointer = makeContextRepo({ 'lore.json': JSON.stringify({ context: 'lore-acme' }) })
  const ctx = resolveContext(pointer)
  assert.equal(ctx.mode, 'cache')
  assert.equal(ctx.repo, 'lore-acme')
  assert.equal(ctx.root, cachePath('lore-acme'))
  assert.equal(ctx.config.project, 'acme')
  assert.ok(existsSync(join(ctx.root, '.git')))
  const registry = JSON.parse(readFileSync(join(home, 'registry.json'), 'utf8'))
  assert.equal(registry.acme, 'lore-acme')
  // and by project name from anywhere
  assert.equal(resolveContext(tmpdir(), { project: 'acme', pull: false }).config.project, 'acme')
})

test('config: proxy api_base makes the token optional; without either it is an error', () => {
  const ok = configSchema.parse({
    project: 'x',
    sources: {
      slack: { channels: ['#a'], api_base: 'http://slack.int.exe.xyz/api' },
      github: { repos: ['acme/web'], api_base: 'http://gh.int.exe.xyz' },
      granola: { endpoint: 'http://granola.int.exe.xyz/mcp', folders: ['Acme'] },
    },
  })
  assert.equal(ok.sources.slack.token, undefined)
  assert.throws(() => configSchema.parse({ project: 'x', sources: { slack: { channels: ['#a'] } } }), /token/)
  assert.throws(() => configSchema.parse({ project: 'x', sources: { github: { repos: ['a/b'] } } }), /token/)
  assert.equal(configSchema.parse({ project: 'x', sources: { granola: { folders: ['A'] } } }).sources.granola.token, undefined, 'granola auth comes from a token file by default')
})

test('setup: buildSources writes proxy bases (no tokens) when proxies are configured, env refs otherwise', () => {
  assert.deepEqual(buildSources(['#acme'], ['acme/web'], readGlobalConfig().proxy), {
    slack: { channels: ['#acme'], api_base: 'http://slack.int.exe.xyz/api' },
    github: { repos: ['acme/web'], api_base: 'http://gh.int.exe.xyz' },
  })
  assert.deepEqual(buildSources(['#acme'], [], undefined), { slack: { channels: ['#acme'], token: 'env:SLACK_TOKEN' } })
  assert.deepEqual(buildSources(['#acme'], [], undefined, ['Acme', 'Acme Ops']).granola, { folders: ['Acme', 'Acme Ops'] })
  assert.deepEqual(buildSources(['#acme'], [], undefined, [], ['abc']).notion, { roots: ['abc'], token: 'env:NOTION_TOKEN' })
  assert.deepEqual(buildSources(['#acme'], [], { notion: 'https://notion.int.exe.xyz/v1' }, [], ['abc']).notion, { roots: ['abc'], api_base: 'https://notion.int.exe.xyz/v1' })
  assert.deepEqual(buildSources(['#acme'], [], { jira: 'https://jira.int.exe.xyz/rest/api/3' }, [], [], ['ACM'], 'https://acme.atlassian.net').jira, { projects: ['ACM'], api_base: 'https://jira.int.exe.xyz/rest/api/3', site: 'https://acme.atlassian.net' })
  assert.deepEqual(buildSources(['#acme'], [], undefined, [], [], ['ACM']).jira, { projects: ['ACM'], site: 'https://CHANGE-ME.atlassian.net', email: 'env:JIRA_EMAIL', token: 'env:JIRA_TOKEN' })
  assert.deepEqual(buildSources(['#acme'], [], { jira: 'https://jira.int.exe.xyz/rest/api/3' }, [], [], [], 'https://input-logic.atlassian.net', [293]).jira, { boards: [293], api_base: 'https://jira.int.exe.xyz/rest/api/3', site: 'https://input-logic.atlassian.net' })
  assert.deepEqual(buildSources(['#acme'], ['a/b'], { slack: 'http://s' }), {
    slack: { channels: ['#acme'], api_base: 'http://s' },
    github: { repos: ['a/b'], token: 'env:LORE_GITHUB_TOKEN' },
  })
})

const doc = (id: string): Doc => ({ id, source: 'fake', channel: '#c', author: 'a', timestamp: '2026-09-01T10:00:00.000Z', text: 'hello' })

test('run-all: syncs every active bare repo, commits and pushes; archived skipped; failures isolated', async () => {
  seedBare('lore-good', { project: 'good', sources: { fake: {} } })
  seedBare('lore-old', { project: 'old', lifecycle: 'archived', archived_at: '2026-09-01T00:00:00Z', sources: { fake: {} } })
  seedBare('lore-bad', { project: 'bad', sources: { fake: {}, boom: {} } })
  let calls = 0
  const registry: Record<string, Connector> = {
    fake: { name: 'fake', fetch: async () => ({ docs: [doc(`fake-${++calls}`)], nextCursor: { n: calls } }) },
  }

  const { result, out } = await captureConsole(() => runAll({ repos, work }, registry))
  assert.equal(result.ok, false)
  assert.deepEqual(result.clients['lore-good'], { status: 'synced', committed: true })
  assert.deepEqual(result.clients['lore-old'], { status: 'archived', committed: false })
  assert.equal(result.clients['lore-bad'].status, 'failed')
  assert.match(result.clients['lore-bad'].error!, /boom/)
  assert.equal(result.clients['lore-bad'].committed, true, 'even a failed run commits the progress it made (state health, partial docs)')
  assert.match(out, /=== lore-acme/) // the repo from the earlier test is picked up too — the directory is the registry
  assert.match(out, /run-all summary/)

  // The bare repo received the sync commit; a fresh clone sees the stream file.
  const check = mkdtempSync(join(tmpdir(), 'lore-check-'))
  execFileSync('git', ['clone', '--quiet', join(repos, 'lore-good.git'), check])
  assert.equal(g(check, 'log', '-1', '--format=%s'), 'chore(lore): sync lore-good')
  assert.ok(existsSync(join(check, 'context/streams/fake/#c/2026-09-01.md')))
  assert.ok(existsSync(join(check, 'state.json')))
  assert.equal(g(check, 'log', '--format=%an', '-1'), 'lore')

  // Second run: incremental, still commits (new doc), and a dirty work tree is reset first.
  writeFileSync(join(work, 'lore-good/context/junk.md'), 'leftover')
  const again = await captureConsole(() => runAll({ repos, work }, registry))
  assert.deepEqual(again.result.clients['lore-good'], { status: 'synced', committed: true })
  assert.ok(!existsSync(join(work, 'lore-good/context/junk.md')))
})

test('run-all: progress is committed even when the run fails, so checkpoints survive the next reset', async () => {
  const bareDir = mkdtempSync(join(tmpdir(), 'lore-repos3-'))
  const workDir = mkdtempSync(join(tmpdir(), 'lore-work3-'))
  const bare = join(bareDir, 'lore-flaky.git')
  mkdirSync(bare)
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', bare])
  const src = makeContextRepo({}, { project: 'flaky', sources: { good: {}, bad: {} } })
  g(src, 'init', '--quiet', '-b', 'main')
  g(src, 'config', 'user.email', 't@t')
  g(src, 'config', 'user.name', 't')
  g(src, 'add', '-A')
  g(src, 'commit', '--quiet', '-m', 'scaffold')
  g(src, 'push', '--quiet', bare, 'main')
  const registry: Record<string, Connector> = {
    good: { name: 'good', fetch: async () => ({ docs: [doc('good-1')], nextCursor: { n: 1 } }) },
    bad: { name: 'bad', fetch: async () => { throw new Error('boom') } },
  }
  const { result } = await captureConsole(() => runAll({ repos: bareDir, work: workDir }, registry))
  assert.equal(result.clients['lore-flaky'].status, 'failed')
  assert.equal(result.clients['lore-flaky'].committed, true, 'the good source\'s docs were committed despite the failure')
  const check = mkdtempSync(join(tmpdir(), 'lore-check3-'))
  execFileSync('git', ['clone', '--quiet', bare, check])
  assert.ok(existsSync(join(check, 'context/streams/fake/#c/2026-09-01.md')))
  assert.match(readFileSync(join(check, 'state.json'), 'utf8'), /"good"/)
})

test('run-all: a commit pushed to the bare repo mid-run is absorbed — sync commit rebased and pushed', async () => {
  const bareDir = mkdtempSync(join(tmpdir(), 'lore-repos4-'))
  const workDir = mkdtempSync(join(tmpdir(), 'lore-work4-'))
  const bare = join(bareDir, 'lore-race.git')
  mkdirSync(bare)
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', bare])
  const src = makeContextRepo({}, { project: 'race', sources: { fake: {} } })
  g(src, 'init', '--quiet', '-b', 'main')
  g(src, 'config', 'user.email', 't@t')
  g(src, 'config', 'user.name', 't')
  g(src, 'add', '-A')
  g(src, 'commit', '--quiet', '-m', 'scaffold')
  g(src, 'push', '--quiet', bare, 'main')
  // A laptop pins a fact while the host's sync is running (from inside fetch).
  const laptop = mkdtempSync(join(tmpdir(), 'lore-laptop-'))
  execFileSync('git', ['clone', '--quiet', bare, laptop])
  const registry: Record<string, Connector> = {
    fake: {
      name: 'fake',
      fetch: async () => {
        writeFileSync(join(laptop, 'context/facts.yaml'), '- id: pin-0001\n  fact: pinned mid-run\n  category: general\n  authorized_by: t\n  date: 2026-09-09\n')
        g(laptop, 'config', 'user.email', 't@t')
        g(laptop, 'config', 'user.name', 't')
        g(laptop, 'add', '-A')
        g(laptop, 'commit', '--quiet', '-m', 'lore: remember pin-0001')
        g(laptop, 'push', '--quiet', 'origin', 'main')
        return { docs: [doc('race-1')], nextCursor: { n: 1 } }
      },
    },
  }
  const { result } = await captureConsole(() => runAll({ repos: bareDir, work: workDir }, registry))
  assert.deepEqual(result.clients['lore-race'], { status: 'synced', committed: true })
  const check = mkdtempSync(join(tmpdir(), 'lore-check4-'))
  execFileSync('git', ['clone', '--quiet', bare, check])
  assert.equal(g(check, 'log', '-1', '--format=%s'), 'chore(lore): sync lore-race', 'sync commit is on top')
  assert.equal(g(check, 'log', '--format=%s', '-3').split('\n').length, 3, 'pin commit preserved underneath')
  assert.match(readFileSync(join(check, 'context/facts.yaml'), 'utf8'), /pinned mid-run/, 'the laptop pin survived')
  assert.ok(existsSync(join(check, 'context/streams/fake/#c/2026-09-01.md')), 'the sync output survived')
})

test('run-all: no-change runs commit a state heartbeat only', async () => {
  const registry: Record<string, Connector> = { fake: { name: 'fake', fetch: async () => ({ docs: [], nextCursor: {} }) } }
  const bareDir = mkdtempSync(join(tmpdir(), 'lore-repos2-'))
  const workDir = mkdtempSync(join(tmpdir(), 'lore-work2-'))
  const bare = join(bareDir, 'lore-quiet.git')
  mkdirSync(bare)
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', bare])
  const src = makeContextRepo({}, { project: 'quiet', sources: { fake: {} } })
  g(src, 'init', '--quiet', '-b', 'main')
  g(src, 'config', 'user.email', 't@t')
  g(src, 'config', 'user.name', 't')
  g(src, 'add', '-A')
  g(src, 'commit', '--quiet', '-m', 'scaffold')
  g(src, 'push', '--quiet', bare, 'main')

  const first = await captureConsole(() => runAll({ repos: bareDir, work: workDir }, registry))
  assert.deepEqual(first.result.clients['lore-quiet'], { status: 'synced', committed: true }, 'first run writes state.json')
  const second = await captureConsole(() => runAll({ repos: bareDir, work: workDir }, registry))
  assert.equal(second.result.clients['lore-quiet'].committed, true, 'state.json lastSync changes every run')
  assert.equal(g(join(workDir, 'lore-quiet'), 'log', '-1', '--format=%s'), 'chore(lore): heartbeat lore-quiet')
})

test('run-all: missing repos dir is an error', async () => {
  await assert.rejects(runAll({ repos: '/nonexistent/lore-repos', work }), /repos dir not found/)
})

test('refresh: sshTargetFromRemote parses ssh remotes and rejects paths', () => {
  assert.equal(sshTargetFromRemote('exedev@lore-host.exe.xyz:/srv/lore/repos'), 'exedev@lore-host.exe.xyz')
  assert.equal(sshTargetFromRemote('ssh://exedev@lore-host.exe.xyz/srv/lore/repos'), 'exedev@lore-host.exe.xyz')
  assert.equal(sshTargetFromRemote('/srv/lore/repos'), undefined)
  assert.equal(sshTargetFromRemote(undefined), undefined)
})

test('refresh: with a path remote the host trigger is unavailable but the pull still reports freshness', () => {
  seedBare('lore-fresh', { project: 'fresh' }, { 'state.json': JSON.stringify({ cursors: {}, lastSync: '2026-09-09T10:00:00Z' }) })
  const calls: string[] = []
  const r = refresh(tmpdir(), { context: 'lore-fresh', trigger: true }, { ssh: (t, c) => { calls.push(`${t} ${c}`); return '' } })
  assert.equal(r.host, 'unavailable')
  assert.deepEqual(calls, [])
  assert.equal(r.after.lastSync, '2026-09-09T10:00:00Z')
})

test('refresh: with an ssh remote it runs the host service unless the last sync is recent', () => {
  seedBare('lore-ssh', { project: 'ssh' }, { 'state.json': JSON.stringify({ cursors: {}, lastSync: '2026-09-09T10:00:00Z' }) })
  // clone first so the cache exists, then swap the global remote to an ssh form for the trigger check
  resolveContext(tmpdir(), { context: 'lore-ssh' })
  const saved = readGlobalConfig()
  writeGlobalConfig({ ...saved, remote: 'exedev@lore-host.example:/srv/lore/repos' })
  try {
    const calls: string[] = []
    const ssh = (t: string, c: string) => { calls.push(`${t} ${c}`); return '' }
    // The cache's origin is still the local bare path, so `git pull` after the trigger keeps working.
    const recent = refresh(tmpdir(), { context: 'lore-ssh', trigger: true, pull: false }, { ssh, now: () => Date.parse('2026-09-09T10:05:00Z') })
    assert.equal(recent.host, 'skipped-recent')
    assert.deepEqual(calls, [])
    const stale = refresh(tmpdir(), { context: 'lore-ssh', trigger: true, pull: false }, { ssh, now: () => Date.parse('2026-09-09T12:00:00Z') })
    assert.equal(stale.host, 'ran')
    assert.deepEqual(calls, ['exedev@lore-host.example sudo systemctl start lore-sync.service'])
    const forced = refresh(tmpdir(), { context: 'lore-ssh', trigger: true, force: true, pull: false }, { ssh, now: () => Date.parse('2026-09-09T10:05:00Z') })
    assert.equal(forced.host, 'ran')
    const noTrigger = refresh(tmpdir(), { context: 'lore-ssh', pull: false }, { ssh })
    assert.equal(noTrigger.host, 'not-requested')
    assert.equal(calls.length, 2)
  } finally {
    writeGlobalConfig(saved)
  }
})
