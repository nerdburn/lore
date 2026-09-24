import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readAudit } from '../src/audit.js'
import { createServer, MCP_TOOLS } from '../src/commands/mcp.js'
import { applyScope, scopeOf, sourceAdd, sourceList } from '../src/commands/source.js'
import { resolveContext, writeGlobalConfig } from '../src/context.js'
import { captureConsole, makeContextRepo } from './helpers.js'

// A private ~/.lore so the machine's proxy/remote settings never leak in.
process.env.LORE_HOME = mkdtempSync(join(tmpdir(), 'lore-home-'))
writeGlobalConfig({})

const PROXY = { slack: 'https://slack.int.exe.xyz/api', github: 'https://github.int.exe.xyz/api/v3', notion: 'https://notion.int.exe.xyz/v1', jira: 'https://jira.int.exe.xyz/rest/api/3', figma: 'https://figma.int.exe.xyz/v1' }
const readConfig = (root: string) => JSON.parse(readFileSync(join(root, 'lore.json'), 'utf8')) as { sources: Record<string, Record<string, unknown>> }

test('source add: creates a github source with an env ref when no proxy is configured, then widens it; duplicates are reported, not repeated', async () => {
  const root = makeContextRepo()
  const { result: r1, out } = await captureConsole(() => sourceAdd(root, { kind: 'github', scope: ['acme/web'] }, { context: root }))
  assert.equal(r1.created, true)
  assert.deepEqual(r1.added, ['acme/web'])
  assert.deepEqual(r1.config, { repos: ['acme/web'], token: 'env:LORE_GITHUB_TOKEN' })
  assert.match(out, /added sources\.github: acme\/web/)
  assert.match(out, /backfills the new scope 1 month\(s\) back/)
  assert.match(r1.next[0], /token behind env:LORE_GITHUB_TOKEN must have read access to acme\/web/)

  const r2 = await sourceAdd(root, { kind: 'github', scope: ['acme/mobile', 'acme/web'] }, { context: root })
  assert.equal(r2.created, false)
  assert.deepEqual(r2.added, ['acme/mobile'])
  assert.deepEqual(r2.already, ['acme/web'])
  assert.deepEqual(readConfig(root).sources.github, { repos: ['acme/web', 'acme/mobile'], token: 'env:LORE_GITHUB_TOKEN' })
  // The slack block that was already there is untouched, and key order is preserved.
  assert.deepEqual(Object.keys(readConfig(root).sources), ['slack', 'github'])

  const r3 = await sourceAdd(root, { kind: 'github', scope: ['acme/web'] }, { context: root })
  assert.deepEqual(r3.added, [])
  assert.match(r3.note, /already covers acme\/web/)
  const audit = readAudit(root)
  assert.equal(audit.length, 2, 'a no-op is not audited')
  assert.equal(audit[0].action, 'source')
  assert.equal(audit[0].id, 'github')
  assert.equal(audit[0].source, 'acme/web')
  assert.equal(audit[0].actor, userInfo().username)
  assert.equal(audit[1].source, 'acme/mobile')
})

test('source add: validates identifiers and refuses to write an invalid lore.json', async () => {
  const root = makeContextRepo()
  const before = readFileSync(join(root, 'lore.json'), 'utf8')
  await assert.rejects(sourceAdd(root, { kind: 'github', scope: ['not-a-repo'] }, { context: root }), /is not "owner\/repo"/)
  await assert.rejects(sourceAdd(root, { kind: 'asana', scope: ['x'] }, { context: root }), /not a source lore syncs \(one of slack, github/)
  await assert.rejects(sourceAdd(root, { kind: 'jira', scope: ['9abc'] }, { context: root }), /not a Jira project key/)
  await assert.rejects(sourceAdd(root, { kind: 'figma', scope: ['https://www.figma.com/deck/8KDHUykKTwbvIXqqUcedIg/Vision'] }, { context: root }), /Slides deck/)
  await assert.rejects(sourceAdd(root, { kind: 'gmail', scope: ['nobody'] }, { context: root }), /not an email address/)
  await assert.rejects(sourceAdd(root, { kind: 'slack', scope: [] }, { context: root }), /at least one channel/)
  assert.equal(readFileSync(join(root, 'lore.json'), 'utf8'), before, 'nothing written')
  assert.deepEqual(readAudit(root), [])
})

test('source add: slack normalises channels and relays the invite; a disabled block is re-enabled', async () => {
  const root = makeContextRepo({}, { project: 'acme', sources: { slack: { channels: ['#acme'], token: 'env:SLACK_TOKEN', disabled: true } } })
  const r = await sourceAdd(root, { kind: 'slack', scope: ['acme-dev', '#acme'] }, { context: root })
  assert.deepEqual(r.added, ['#acme-dev'])
  assert.deepEqual(r.already, ['#acme'])
  assert.equal(r.reenabled, true)
  assert.deepEqual(readConfig(root).sources.slack, { channels: ['#acme', '#acme-dev'], token: 'env:SLACK_TOKEN' })
  assert.match(r.next[0], /\/invite @lore in #acme-dev/)
})

test('applyScope: new blocks carry the proxy base when the machine has one (self-hosted), else env refs; self-hosted without a proxy is refused', () => {
  const hosted = { remote: 'exedev@lore-host:/srv/lore/repos', proxy: PROXY }
  assert.deepEqual(applyScope('github', undefined, ['acme/web'], undefined, hosted).block, { repos: ['acme/web'], api_base: PROXY.github })
  assert.match(applyScope('github', undefined, ['acme/web'], undefined, hosted).next[0], /integrations add github --name acme-web --repository acme\/web --readonly --attach tag:lore/)
  assert.deepEqual(applyScope('slack', undefined, ['#x'], undefined, hosted).block, { channels: ['#x'], api_base: PROXY.slack })
  assert.deepEqual(applyScope('notion', undefined, ['https://notion.so/p/abc'], undefined, hosted).block, { roots: ['https://notion.so/p/abc'], api_base: PROXY.notion })
  assert.deepEqual(applyScope('figma', undefined, ['https://www.figma.com/design/s8hXkLIZZwkSt0lMssnVYt/Jointly-UI'], undefined, hosted).block, {
    files: ['https://www.figma.com/design/s8hXkLIZZwkSt0lMssnVYt/Jointly-UI'],
    api_base: PROXY.figma,
  })
  assert.deepEqual(applyScope('jira', undefined, ['acm', 'board:293'], 'https://acme.atlassian.net', hosted).block, {
    projects: ['ACM'],
    boards: [293],
    site: 'https://acme.atlassian.net',
    api_base: PROXY.jira,
  })
  // Granola and Gmail authenticate on the host itself — no proxy needed either way.
  assert.deepEqual(applyScope('granola', undefined, ['Acme'], undefined, hosted).block, { folders: ['Acme'] })
  assert.deepEqual(applyScope('gmail', undefined, ['all'], undefined, hosted).block, { users: 'all' })
  assert.throws(() => applyScope('github', undefined, ['acme/web'], undefined, { remote: 'x@y:/repos' }), /no proxy for github/)
  assert.throws(() => applyScope('figma', undefined, ['abcdefgh1'], undefined, { remote: 'x@y:/repos', proxy: { slack: 's' } }), /proxy\.figma/)
  // Widening an existing block never needs a proxy: the auth is already there.
  assert.deepEqual(applyScope('github', { repos: ['a/b'], api_base: 'p' }, ['c/d'], undefined, { remote: 'x@y:/repos' }).block, { repos: ['a/b', 'c/d'], api_base: 'p' })
  // Not self-hosted: env refs, as `lore setup` writes them.
  assert.deepEqual(applyScope('jira', undefined, ['ACM'], undefined, {}).block, { projects: ['ACM'], site: 'https://CHANGE-ME.atlassian.net', email: 'env:JIRA_EMAIL', token: 'env:JIRA_TOKEN' })
})

test('applyScope: jira merges projects and boards and can set the site later; gmail moves from a list to "all" but never back', () => {
  const j = applyScope('jira', { boards: [293], api_base: 'p' }, ['board:293', 'ACM'], 'https://acme.atlassian.net', {})
  assert.deepEqual(j.block, { boards: [293], api_base: 'p', projects: ['ACM'], site: 'https://acme.atlassian.net' })
  assert.deepEqual(j.added, ['ACM'])
  assert.deepEqual(j.already, ['board:293'])
  assert.equal(j.changed, true)
  const siteOnly = applyScope('jira', { projects: ['ACM'], api_base: 'p' }, [], 'https://acme.atlassian.net', {})
  assert.deepEqual(siteOnly.added, [])
  assert.equal(siteOnly.changed, true)
  assert.match(applyScope('jira', { projects: ['ACM'], api_base: 'p' }, ['ACM'], undefined, {}).next[0], /set `site`/)

  assert.deepEqual(applyScope('gmail', undefined, [], undefined, {}).block, {}, 'no mailboxes = the team-side contacts')
  assert.deepEqual(applyScope('gmail', undefined, [], undefined, {}).added, ['team contacts'])
  const g = applyScope('gmail', { users: ['a@x.com'] }, ['b@x.com', 'A@x.com'], undefined, {})
  assert.deepEqual(g.block, { users: ['a@x.com', 'b@x.com'] })
  assert.deepEqual(g.already, ['a@x.com'])
  assert.deepEqual(applyScope('gmail', { users: ['a@x.com'], exclude: ['z@x.com'] }, ['all'], undefined, {}).block, { users: 'all', exclude: ['z@x.com'] })
  const covered = applyScope('gmail', { users: 'all', admin: 'o@x.com' }, ['c@x.com'], undefined, {})
  assert.deepEqual(covered.added, [])
  assert.deepEqual(covered.already, ['c@x.com'])
  assert.deepEqual(covered.block, { users: 'all', admin: 'o@x.com' })
})

test('source list: every source with its scope, auth mode, and health from state.json', async () => {
  const root = makeContextRepo(
    { 'state.json': JSON.stringify({ cursors: {}, sources: { slack: { lastAttempt: 't', lastSuccess: '2026-09-18T10:00:00Z' }, github: { lastAttempt: 't', lastError: { at: '2026-09-18T10:00:00Z', message: 'repo x/y not found' } } } }) },
    {
      project: 'acme',
      sources: {
        slack: { channels: ['#acme'], api_base: 'https://slack.int.exe.xyz/api' },
        github: { repos: ['x/y'], token: 'env:LORE_GITHUB_TOKEN' },
        granola: { folders: ['Acme'], attendee_domains: ['acme.com'] },
        gmail: { users: 'all', disabled: true },
        jira: { projects: ['ACM'], boards: [3], api_base: 'https://jira.int.exe.xyz/rest/api/3' },
        figma: { files: ['abcdefgh1'], projects: [12], api_base: 'https://figma.int.exe.xyz/v1' },
      },
    },
  )
  const { result, out } = await captureConsole(() => sourceList(root, { context: root }))
  assert.deepEqual(
    result.map((s) => [s.name, s.scope, s.auth, s.disabled]),
    [
      ['slack', ['#acme'], 'proxy', false],
      ['github', ['x/y'], 'env', false],
      ['granola', ['Acme', '@acme.com'], 'host', false],
      ['gmail', ['all mailboxes'], 'host', true],
      ['jira', ['ACM', 'board:3'], 'proxy', false],
      ['figma', ['abcdefgh1', 'project:12'], 'proxy', false],
    ],
  )
  assert.equal(result[0].lastSuccess, '2026-09-18T10:00:00Z')
  assert.equal(result[1].lastError?.message, 'repo x/y not found')
  // Freshness in the same vocabulary `check`, `recall` and the host page use:
  // github has never succeeded, so it is a hole in memory, not just an error.
  assert.deepEqual(result.map((s) => [s.name, s.state]), [
    ['slack', 'ok'],
    ['github', 'never'],
    ['granola', 'ok'],
    ['gmail', 'disabled'],
    ['jira', 'ok'],
    ['figma', 'ok'],
  ])
  assert.match(out, /never synced/)
  assert.match(out, /✓ slack {4}#acme {2}\[proxy\]/)
  assert.match(out, /✗ github {3}x\/y {2}\[env\]/)
  assert.match(out, /– gmail {4}all mailboxes {2}\[host\] disabled/)
  assert.deepEqual(scopeOf('gmail', {}), ['team contacts'])
  assert.deepEqual(scopeOf('notion', { roots: ['r'] }), ['r'])
})

test('mcp: lore_source_add widens scope with the server identity as actor; lore_source_list reads it back; both listed in MCP_TOOLS', async () => {
  const root = makeContextRepo()
  const ctx = resolveContext(root, { context: root })
  const server = createServer(ctx, { cwd: root, opts: { context: root } })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientT)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args })
    return { isError: res.isError === true, text: (res.content as { text: string }[])[0]?.text ?? '' }
  }

  const add = await call('lore_source_add', { kind: 'github', scope: ['acme/web'], by: 'ceo' })
  assert.equal(add.isError, false, add.text)
  const r = JSON.parse(add.text)
  assert.deepEqual(r.added, ['acme/web'])
  assert.equal(r.created, true)
  assert.ok(Array.isArray(r.next) && r.next.length === 1)
  const audit = readAudit(root)
  assert.equal(audit[0].via, 'mcp')
  assert.equal(audit[0].actor, userInfo().username, 'the caller cannot name the actor')

  const bad = await call('lore_source_add', { kind: 'github', scope: ['nope'] })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /owner\/repo/)
  const unknown = await call('lore_source_add', { kind: 'asana', scope: ['x'] })
  assert.equal(unknown.isError, true, 'the kind enum rejects unknown sources')

  const list = JSON.parse((await call('lore_source_list')).text) as { name: string; scope: string[] }[]
  assert.deepEqual(list.map((s) => [s.name, s.scope]), [['slack', ['#acme']], ['github', ['acme/web']]])

  assert.ok(MCP_TOOLS.find((t) => t.name === 'lore_source_add')?.writes)
  assert.equal(MCP_TOOLS.find((t) => t.name === 'lore_source_list')?.writes, false)
  await Promise.all([client.close(), server.close()])
})

test('source add: refused on an archived client and by write.allow', async () => {
  const archived = makeContextRepo({}, { project: 'old', lifecycle: 'archived', archived_at: '2026-09-01T00:00:00Z', sources: { slack: { channels: ['#x'], token: 'env:SLACK_TOKEN' } } })
  await assert.rejects(sourceAdd(archived, { kind: 'github', scope: ['a/b'] }, { context: archived }), /archived/)
  const gated = makeContextRepo({}, { project: 'acme', write: { allow: ['someone-else'] }, sources: {} })
  await assert.rejects(sourceAdd(gated, { kind: 'github', scope: ['a/b'] }, { context: gated }), /not in lore.json write.allow — source refused/)
  writeFileSync(join(gated, 'noop'), '')
})
