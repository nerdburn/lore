import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backfillSince, configSchema, loadConfig, resolveEnvRefs } from '../src/config.js'
import { makeContextRepo } from './helpers.js'

test('config: minimal valid config parses with defaults', () => {
  const cfg = configSchema.parse({ project: 'acme' })
  assert.deepEqual(cfg.sources, {})
  assert.equal(cfg.backfill.months, 0)
  assert.deepEqual(cfg.extract, [])
  assert.equal(cfg.write, undefined)
})

test('config: rejects an empty project name and bad backfill', () => {
  assert.throws(() => configSchema.parse({ project: '' }))
  assert.throws(() => configSchema.parse({ project: 'x', backfill: { months: -1 } }))
  assert.throws(() => configSchema.parse({ project: 'x', backfill: { months: 1.5 } }))
})

test('config: source entries keep connector fields and type the disabled flag', () => {
  const cfg = configSchema.parse({
    project: 'acme',
    sources: {
      slack: { channels: ['#acme'], token: 'env:SLACK_TOKEN' },
      github: { repos: ['acme/web'], token: 'env:LORE_GITHUB_TOKEN', disabled: true },
    },
  })
  assert.deepEqual(cfg.sources.slack.channels, ['#acme'])
  assert.equal(cfg.sources.github.disabled, true)
  assert.throws(() => configSchema.parse({ project: 'x', sources: { slack: { disabled: 'yes' } } }))
})

test('config: write.allow must be a non-empty list', () => {
  assert.deepEqual(configSchema.parse({ project: 'x', write: { allow: ['shawn'] } }).write, { allow: ['shawn'] })
  assert.throws(() => configSchema.parse({ project: 'x', write: { allow: [] } }))
})

test('config: loadConfig reads lore.json from a root', () => {
  const root = makeContextRepo()
  assert.equal(loadConfig(root).project, 'acme')
})

test('config: resolveEnvRefs resolves env: refs and reports missing ones', () => {
  process.env.LORE_TEST_TOKEN = 'xoxb-test'
  delete process.env.LORE_TEST_MISSING
  const { resolved, missing } = resolveEnvRefs({
    token: 'env:LORE_TEST_TOKEN',
    other: 'env:LORE_TEST_MISSING',
    channels: ['#a'],
    plain: 'literal',
  })
  assert.equal(resolved.token, 'xoxb-test')
  assert.equal(resolved.other, undefined)
  assert.deepEqual(resolved.channels, ['#a'])
  assert.equal(resolved.plain, 'literal')
  assert.deepEqual(missing, ['LORE_TEST_MISSING'])
})

test('config: backfillSince honours per-source override and zero means now', () => {
  const cfg = configSchema.parse({ project: 'x', backfill: { months: 3, slack: 1 } })
  const now = Date.UTC(2026, 8, 8)
  const oneMonth = new Date(now)
  oneMonth.setMonth(oneMonth.getMonth() - 1)
  assert.equal(backfillSince(cfg, 'slack', now), oneMonth.getTime())
  const threeMonths = new Date(now)
  threeMonths.setMonth(threeMonths.getMonth() - 3)
  assert.equal(backfillSince(cfg, 'github', now), threeMonths.getTime())
  assert.equal(backfillSince(configSchema.parse({ project: 'x' }), 'slack', now), now)
})

test('config: known sources are validated by their typed schema', () => {
  const bad = (sources: Record<string, unknown>) => assert.throws(() => configSchema.parse({ project: 'x', sources }))
  bad({ slack: { channels: [], token: 'env:T' } })
  bad({ slack: { channels: ['#a'], token: 'xoxb-literal-token' } })
  bad({ github: { repos: ['not-a-repo'], token: 'env:T' } })
  bad({ github: { repos: ['acme/web'] } })
  bad({ github: { repos: ['acme/web'], token: 'env:T', include: ['wiki'] } })
  bad({ granola: { token: 'env:T', folders: ['Acme'], endpoint: 'not a url' } })
  bad({ notion: { roots: ['abc'] } })
  bad({ jira: { projects: ['acm'], site: 'https://x.atlassian.net', email: 'env:E', token: 'env:T' } })
  bad({ jira: { projects: ['ACM'], email: 'env:E', token: 'env:T' } })
  bad({ jira: { projects: ['ACM'], site: 'https://x.atlassian.net' } })
  bad({ notion: { token: 'literal', roots: ['abc'] } })
  bad({ granola: { token: 'literal-token', folders: ['Acme'] } })

  const ok = configSchema.parse({
    project: 'x',
    sources: {
      slack: { channels: ['#a'], token: 'env:SLACK_TOKEN', overlap_days: 3 },
      github: { repos: ['acme/web', 'acme/mobile'], token: 'env:LORE_GITHUB_TOKEN', include: ['issues', 'commits'] },
      granola: { token: 'env:GRANOLA_TOKEN', folders: ['Acme'], attendee_domains: ['acme.com'], transcripts: false },
      notion: { token: 'env:NOTION_TOKEN', roots: ['https://www.notion.so/x/Docs-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'], settle_minutes: 10 },
    },
  })
  assert.deepEqual(ok.sources.notion.roots?.length, 1)
  assert.equal(configSchema.parse({ project: 'x', sources: { jira: { projects: ['ACM'], api_base: 'https://jira.int.exe.xyz/rest/api/3' } } }).sources.jira.projects?.[0], 'ACM')
  assert.deepEqual(configSchema.parse({ project: 'x', sources: { jira: { boards: [293], api_base: 'https://jira.int.exe.xyz/rest/api/3' } } }).sources.jira.boards, [293])
  bad({ jira: { api_base: 'https://jira.int.exe.xyz/rest/api/3' } })
  assert.deepEqual(ok.sources.github.repos, ['acme/web', 'acme/mobile'])
})

test('config: validation errors name the source and field', () => {
  try {
    configSchema.parse({ project: 'x', sources: { github: { repos: ['bad'], token: 'env:T' } } })
    assert.fail('should throw')
  } catch (err) {
    assert.match(String(err), /github/)
    assert.match(String(err), /owner\/repo/)
  }
})

test('config: unknown sources are accepted structurally (connector may come later)', () => {
  const cfg = configSchema.parse({ project: 'x', sources: { linear: { team: 'ACME', disabled: true } } })
  assert.equal(cfg.sources.linear.disabled, true)
})

test('config: client block — domains normalised, contacts default to the client side', () => {
  const cfg = configSchema.parse({
    project: 'jointly',
    client: {
      name: 'Jointly',
      domains: ['@Jointly.ca', 'getjointly.ca'],
      contacts: [{ name: 'Aimee Schalles', email: 'aimee@jointly.ca', role: 'Founder' }, { name: 'Kaity', email: 'kaity@inputlogic.ca', side: 'team' }],
    },
  })
  assert.deepEqual(cfg.client?.domains, ['jointly.ca', 'getjointly.ca'])
  assert.equal(cfg.client?.contacts[0].side, 'client')
  assert.equal(cfg.client?.contacts[1].side, 'team')
  assert.throws(() => configSchema.parse({ project: 'x', client: { name: 'X', contacts: [{ name: 'A', email: 'not-an-email' }] } }))
  assert.equal(configSchema.parse({ project: 'x' }).client, undefined)
})
