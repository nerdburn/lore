import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { readAudit } from '../src/audit.js'
import { loadConfig } from '../src/config.js'
import { sourceAdd, sourceList } from '../src/commands/source.js'
import { makeContextRepo } from './helpers.js'

/** A client with one source configured, the way a design-only engagement starts. */
function figmaOnly() {
  return makeContextRepo(
    {},
    {
      project: 'acme',
      sources: { figma: { files: ['https://figma.com/design/abc/Acme'], token: 'env:FIGMA_TOKEN' } },
      backfill: { months: 1 },
      extract: ['requests'],
    },
  )
}

const cfg = (root: string) => JSON.parse(readFileSync(join(root, 'lore.json'), 'utf8'))

test('source add: configures a connector the client does not have, using the proxy when one is set', () => {
  const root = figmaOnly()
  const r = sourceAdd(root, { kind: 'github', scope: ['acme/web', 'acme/api'] }, {}, { global: { proxy: { github: 'https://github.int.exe.xyz/api/v3' } } })

  assert.equal(r.created, true)
  assert.deepEqual(r.added, ['acme/web', 'acme/api'])
  assert.equal(r.disabled, false)
  assert.deepEqual(cfg(root).sources.github, { repos: ['acme/web', 'acme/api'], api_base: 'https://github.int.exe.xyz/api/v3' })
  // The source it already had is untouched.
  assert.deepEqual(cfg(root).sources.figma.files, ['https://figma.com/design/abc/Acme'])
  // The per-repo host integration is the human's half.
  assert.match(r.next.join('\n'), /GitHub integration per repo/)
})

test('source add: widens a configured source, ignoring duplicates and Slack’s leading #', () => {
  const root = makeContextRepo()
  const r = sourceAdd(root, { kind: 'slack', scope: ['#acme-design', 'acme', '#acme-dev'] }, {})

  assert.equal(r.created, false)
  assert.deepEqual(r.added, ['#acme-design', '#acme-dev'])
  assert.deepEqual(r.present, ['acme'])
  assert.deepEqual(cfg(root).sources.slack.channels, ['#acme', '#acme-design', '#acme-dev'])
  assert.match(r.next.join('\n'), /invite @lore/)
})

test('source add: a new source whose credentials do not resolve lands disabled, never live', () => {
  const root = figmaOnly()
  delete process.env.NOTION_TOKEN
  const r = sourceAdd(root, { kind: 'notion', scope: ['https://notion.so/acme/Spec'] }, {}, { global: {} })

  assert.equal(r.disabled, true)
  assert.match(r.blocked ?? '', /NOTION_TOKEN/)
  assert.equal(cfg(root).sources.notion.disabled, true)
  // Disabled is the one state `check` tolerates, so the client still syncs.
  assert.equal(loadConfig(root).sources.notion.disabled, true)
})

test('source add: widening an already-working source never disables it', () => {
  const root = makeContextRepo()
  delete process.env.SLACK_TOKEN
  const r = sourceAdd(root, { kind: 'slack', scope: ['#acme-ops'] }, {})

  assert.equal(r.disabled, false)
  assert.equal(cfg(root).sources.slack.disabled, undefined)
})

test('source add: refuses a kind with no connector — new kinds are code, not config', () => {
  const root = makeContextRepo()
  assert.throws(() => sourceAdd(root, { kind: 'linear', scope: ['ACME'] }, {}), /no connector for "linear"/)
  assert.throws(() => sourceAdd(root, { kind: 'slack', scope: ['  '] }, {}), /nothing to add/)
})

test('source add: rejects scope the source schema will not accept, leaving lore.json untouched', () => {
  const root = figmaOnly()
  const before = readFileSync(join(root, 'lore.json'), 'utf8')
  assert.throws(() => sourceAdd(root, { kind: 'github', scope: ['not-a-repo'] }, {}, { global: {} }), /must be "owner\/repo"/)
  assert.equal(readFileSync(join(root, 'lore.json'), 'utf8'), before)
})

test('source add: gmail "all" is a scalar scope, not a list member', () => {
  const root = figmaOnly()
  const r = sourceAdd(root, { kind: 'gmail', scope: ['all'] }, {}, { global: {} })
  assert.equal(cfg(root).sources.gmail.users, 'all')
  assert.equal(r.disabled, false)
})

test('source add: jira reports every gap at once, not just the first', () => {
  delete process.env.JIRA_EMAIL
  delete process.env.JIRA_TOKEN
  const root = figmaOnly()
  const r = sourceAdd(root, { kind: 'jira', scope: ['ACM'] }, {}, { global: {} })
  assert.equal(r.disabled, true)
  assert.match(r.blocked ?? '', /JIRA_EMAIL/)
  assert.match(r.blocked ?? '', /Jira site/)

  const withSite = figmaOnly()
  const r2 = sourceAdd(withSite, { kind: 'jira', scope: ['ACM'], site: 'https://acme.atlassian.net' }, {}, { global: {} })
  // The site is satisfied; the Basic-auth env refs still are not.
  assert.match(r2.blocked ?? '', /JIRA_EMAIL/)
  assert.doesNotMatch(r2.blocked ?? '', /Jira site/)
})

test('source add: re-adding the same scope is a no-op, not an empty commit', () => {
  const root = makeContextRepo()
  sourceAdd(root, { kind: 'slack', scope: ['#acme-design'] }, {})
  const audits = readAudit(root).length
  const r = sourceAdd(root, { kind: 'slack', scope: ['#acme-design'] }, {})

  assert.deepEqual(r.added, [])
  assert.deepEqual(r.present, ['#acme-design'])
  assert.equal(readAudit(root).length, audits)
})

test('source add: every write is audited with the surface it came through', () => {
  const root = figmaOnly()
  sourceAdd(root, { kind: 'github', scope: ['acme/web'] }, { via: 'mcp' }, { global: { proxy: { github: 'https://gh.int/api/v3' } } })
  const entry = readAudit(root).at(-1)!

  assert.equal(entry.action, 'source')
  assert.equal(entry.via, 'mcp')
  assert.equal(entry.id, 'github')
  assert.equal(entry.source, 'acme/web')
})

test('source add: an archived client is read-only', () => {
  const root = makeContextRepo({}, { project: 'acme', lifecycle: 'archived', sources: {}, backfill: { months: 1 }, extract: [] })
  assert.throws(() => sourceAdd(root, { kind: 'slack', scope: ['#acme'] }, {}), /read-only/)
})

test('source add: write.allow gates config changes like any other write', () => {
  const root = makeContextRepo({}, {
    project: 'acme',
    sources: { slack: { channels: ['#acme'], token: 'env:SLACK_TOKEN' } },
    backfill: { months: 1 },
    extract: [],
    write: { allow: ['someone-else'] },
  })
  assert.throws(() => sourceAdd(root, { kind: 'slack', scope: ['#acme-ops'] }, {}), /not in lore.json write.allow/)
})

test('source add: --disabled cannot park a source that is already working', () => {
  const root = makeContextRepo()
  const r = sourceAdd(root, { kind: 'slack', scope: ['#acme-ops'], disabled: true }, {})

  assert.equal(r.disabled, false)
  assert.equal(cfg(root).sources.slack.disabled, undefined)
  assert.deepEqual(cfg(root).sources.slack.channels, ['#acme', '#acme-ops'])
})

test('source add: in direct mode the edit is written but left uncommitted, like remember', () => {
  const root = figmaOnly()
  execFileSync('git', ['init', '--quiet', root])
  const r = sourceAdd(root, { kind: 'slack', scope: ['#acme'] }, {}, { global: { proxy: { slack: 'https://slack.int/api' } } })

  assert.deepEqual(r.added, ['#acme'])
  assert.deepEqual(cfg(root).sources.slack.channels, ['#acme'])
  // Nothing committed: standing in the context repo, committing is the human's.
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).includes('lore.json'), true)
})

test('source list: reports scope, disabled state, and what is still available', () => {
  const root = figmaOnly()
  sourceAdd(root, { kind: 'github', scope: ['acme/web'] }, {}, { global: { proxy: { github: 'https://gh.int/api/v3' } } })
  const r = sourceList(root)

  assert.equal(r.project, 'acme')
  assert.deepEqual(r.sources.find((s) => s.kind === 'github'), { kind: 'github', scope: ['acme/web'], disabled: false, connector: true, state: 'ok' })
  assert.ok(!r.available.includes('github'))
  assert.ok(r.available.includes('slack'))
})
