import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { describeDegraded, degraded, sourceStatuses } from '../src/health.js'
import { recallData } from '../src/recall.js'
import type { LoreState } from '../src/state.js'
import { makeContextRepo } from './helpers.js'

const NOW = Date.parse('2026-09-19T12:00:00Z')
const config = { sources: { slack: {}, github: {}, notion: {}, figma: { disabled: true } } }

const state: LoreState = {
  cursors: {},
  sources: {
    // healthy: the last attempt succeeded
    slack: { lastAttempt: '2026-09-19T11:55:00Z', lastSuccess: '2026-09-19T11:55:00Z' },
    // has synced before, but the latest attempt failed — there is a gap
    github: { lastAttempt: '2026-09-19T11:55:00Z', lastSuccess: '2026-09-18T06:00:00Z', lastError: { at: '2026-09-19T11:55:00Z', message: 'bad credentials' } },
    // never once succeeded — absence of memory is not absence of material
    notion: { lastAttempt: '2026-09-19T11:55:00Z', lastError: { at: '2026-09-19T11:55:00Z', message: 'unauthorized' } },
  },
}

test('health: a source is stale from its last success, not its last attempt', () => {
  const s = sourceStatuses(config, state, NOW)

  assert.deepEqual(s.find((x) => x.source === 'slack')!.state, 'ok')
  const gh = s.find((x) => x.source === 'github')!
  assert.equal(gh.state, 'stale')
  assert.equal(gh.staleHours, 30)
  assert.equal(gh.error, 'bad credentials')
  assert.equal(s.find((x) => x.source === 'notion')!.state, 'never')
  assert.equal(s.find((x) => x.source === 'figma')!.state, 'disabled')
})

test('health: a failure older than the last success is spent, not current', () => {
  const recovered: LoreState = {
    cursors: {},
    sources: { github: { lastAttempt: '2026-09-19T11:00:00Z', lastSuccess: '2026-09-19T11:00:00Z', lastError: { at: '2026-09-18T09:00:00Z', message: 'old' } } },
  }
  assert.equal(sourceStatuses({ sources: { github: {} } }, recovered, NOW)[0].state, 'ok')
})

test('health: degraded names what an answer must be hedged on, and disabled is not a gap', () => {
  const s = sourceStatuses(config, state, NOW)
  assert.deepEqual(degraded(s).map((d) => d.source), ['github', 'notion'])
  assert.equal(describeDegraded(s), 'github stale 30h, notion never synced')
  assert.equal(describeDegraded(sourceStatuses({ sources: { figma: { disabled: true } } }, state, NOW)), '')
})

test('health: recall reports per-source freshness, so a partial sync cannot read as complete', () => {
  const root = makeContextRepo({}, {
    project: 'acme',
    sources: { slack: { channels: ['#acme'], token: 'env:SLACK_TOKEN' }, github: { repos: ['a/b'], token: 'env:LORE_GITHUB_TOKEN' } },
    backfill: { months: 1 },
    extract: [],
  })
  writeFileSync(join(root, 'state.json'), JSON.stringify({
    cursors: {},
    lastSync: '2026-09-19T11:59:00Z',
    sources: {
      slack: { lastAttempt: '2026-09-19T11:59:00Z', lastSuccess: '2026-09-19T11:59:00Z' },
      github: { lastAttempt: '2026-09-19T11:59:00Z', lastSuccess: '2026-09-12T09:00:00Z', lastError: { at: '2026-09-19T11:59:00Z', message: 'bad credentials' } },
    },
  }))

  const r = recallData(root, { project: 'acme', lifecycle: 'active', sources: { slack: {}, github: {} } })
  // The run-level timestamp says "a minute ago" — the per-source layer is what stops that being the whole story.
  assert.equal(r.synced.lastSync, '2026-09-19T11:59:00Z')
  assert.deepEqual(r.synced.degraded, ['github'])
  assert.equal(r.synced.sources.find((s) => s.source === 'github')!.state, 'stale')
})
