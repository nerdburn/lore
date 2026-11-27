import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { alertStaleClaims } from '../src/claim-alert.js'
import type { MailMessage } from '../src/board/email.js'
import { ClaimHeldError, workAdd, workClaim, workList, workMove, workRelease, workRenew } from '../src/commands/work.js'
import { writeGlobalConfig } from '../src/context.js'
import { applyFoldChanges, readWorkItems } from '../src/work.js'
import { ACME, captureConsole, makeContextRepo } from './helpers.js'

async function fixture() {
  const root = makeContextRepo({})
  const o = (at: string) => ({ context: root, at })
  await captureConsole(async () => {
    await workAdd(root, { title: 'Fix the invite email' }, o('2026-09-20T10:00:00.000Z'))
    await workAdd(root, { title: 'Profile photo crop' }, o('2026-09-20T10:01:00.000Z'))
  })
  return { root, o }
}
const item = (root: string, key: string) => readWorkItems(root, 'ACM').find((i) => i.key === key)!

test('work claim: one holder per ticket — a second holder, or a second run by the same holder, is refused and writes nothing', async () => {
  const { root, o } = await fixture()
  await captureConsole(async () => {
    const first = workClaim(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1', stage: 'build', status: 'in_progress' }, o('2026-09-21T09:00:00.000Z'))
    assert.equal(first.outcome, 'claimed')
    assert.deepEqual(item(root, 'ACM-1').claim, { holder: 'enso:athena', ref: 'WEB-1', stage: 'build', since: '2026-09-21T09:00:00.000Z', renewed: '2026-09-21T09:00:00.000Z' })
    assert.equal(item(root, 'ACM-1').status, 'in_progress')

    assert.throws(() => workClaim(root, 'ACM-1', { holder: 'enso:mobile-qa', ref: 'MOB-4' }, o('2026-09-21T09:05:00.000Z')), ClaimHeldError)
    assert.throws(() => workClaim(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-2' }, o('2026-09-21T09:06:00.000Z')), /held by enso:athena WEB-1 @build/)
    assert.equal(item(root, 'ACM-1').claim!.ref, 'WEB-1')
    assert.equal(item(root, 'ACM-1').history.length, 2, 'refused claims leave no history')
  })
})

test('work claim: the holder claiming again hands the ticket to the next stage, and a bare repeat only renews', async () => {
  const { root, o } = await fixture()
  await captureConsole(async () => {
    workClaim(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1', stage: 'build' }, o('2026-09-21T09:00:00.000Z'))
    const handoff = workClaim(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1', stage: 'review', status: 'review' }, o('2026-09-21T10:00:00.000Z'))
    assert.equal(handoff.outcome, 'updated')
    const again = workClaim(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1' }, o('2026-09-21T11:00:00.000Z'))
    assert.equal(again.outcome, 'renewed')
    const i = item(root, 'ACM-1')
    assert.deepEqual([i.status, i.claim!.stage, i.claim!.since, i.claim!.renewed], ['review', 'review', '2026-09-21T09:00:00.000Z', '2026-09-21T11:00:00.000Z'])
    assert.deepEqual(i.history.map((h) => h.change.claim ?? null), [null, [null, 'enso:athena WEB-1 @build'], ['enso:athena WEB-1 @build', 'enso:athena WEB-1 @review']])
  })
})

test('work claim: closed tickets cannot be claimed; force takes a ticket over and needs a reason', async () => {
  const { root, o } = await fixture()
  await captureConsole(async () => {
    await workMove(root, 'ACM-2', 'done', { reason: 'shipped' }, o('2026-09-21T08:00:00.000Z'))
    assert.throws(() => workClaim(root, 'ACM-2', { holder: 'enso:athena' }, o('2026-09-21T09:00:00.000Z')), /only open tickets/)
    workClaim(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1' }, o('2026-09-21T09:00:00.000Z'))
    assert.throws(() => workClaim(root, 'ACM-1', { holder: 'shawn', force: true }, o('2026-09-21T09:30:00.000Z')), /--force needs --reason/)
    const taken = workClaim(root, 'ACM-1', { holder: 'shawn', force: true, reason: 'athena is down' }, o('2026-09-21T09:30:00.000Z'))
    assert.equal(taken.outcome, 'taken')
    assert.deepEqual(item(root, 'ACM-1').claim, { holder: 'shawn', since: '2026-09-21T09:30:00.000Z', renewed: '2026-09-21T09:30:00.000Z' })
  })
})

test('work release: only the holder lets go, optionally closing the ticket; an unclaimed ticket is left alone', async () => {
  const { root, o } = await fixture()
  await captureConsole(async () => {
    workClaim(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1' }, o('2026-09-21T09:00:00.000Z'))
    assert.throws(() => workRelease(root, 'ACM-1', { holder: 'enso:mobile-qa', reason: 'mine now' }, o('2026-09-21T09:10:00.000Z')), ClaimHeldError)
    assert.throws(() => workRelease(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-9', reason: 'wrong run' }, o('2026-09-21T09:10:00.000Z')), ClaimHeldError)
    const done = workRelease(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1', status: 'done', reason: 'deployed' }, o('2026-09-21T12:00:00.000Z'))
    assert.equal(done.released, true)
    assert.deepEqual([item(root, 'ACM-1').claim, item(root, 'ACM-1').status], [undefined, 'done'])
    const before = item(root, 'ACM-2').history.length
    assert.equal(workRelease(root, 'ACM-2', { holder: 'enso:athena', reason: 'nothing to do' }, o('2026-09-21T12:01:00.000Z')).released, false)
    assert.equal(item(root, 'ACM-2').history.length, before)
  })
})

test('work renew: one heartbeat confirms every claim a holder has, and skips the ones still fresh', async () => {
  const { root, o } = await fixture()
  await captureConsole(async () => {
    workClaim(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1' }, o('2026-09-21T09:00:00.000Z'))
    workClaim(root, 'ACM-2', { holder: 'enso:athena', ref: 'WEB-2' }, o('2026-09-21T09:50:00.000Z'))
    const r = workRenew(root, { holder: 'enso:athena' }, o('2026-09-21T10:00:00.000Z'))
    assert.deepEqual(r, { held: ['ACM-1', 'ACM-2'], renewed: ['ACM-1'] })
    assert.equal(item(root, 'ACM-1').claim!.renewed, '2026-09-21T10:00:00.000Z')
    assert.equal(item(root, 'ACM-2').claim!.renewed, '2026-09-21T09:50:00.000Z')
    assert.equal(item(root, 'ACM-1').history.length, 2, 'a heartbeat is not history')
  })
})

test('claims: the fold leaves a held ticket alone, and a silent holder is reported once until it renews', async () => {
  const { root, o } = await fixture()
  await captureConsole(async () => {
    workClaim(root, 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1', stage: 'build' }, o('2026-09-21T09:00:00.000Z'))
    const fold = applyFoldChanges(readWorkItems(root, 'ACM'), [{ key: 'ACM-1', status: 'done', confidence: 'high', sources: ['x'], reason: 'looked shipped' }], '2026-09-21T09:30:00.000Z')
    assert.match(fold.skipped.join(), /ACM-1: held by enso:athena WEB-1 @build/)

    const sent: MailMessage[] = []
    const send = async (m: MailMessage) => void sent.push(m)
    const config = { ...ACME, client: { ...ACME.client!, owner: 'lead@agency.test' } }
    assert.deepEqual(await alertStaleClaims(root, config, { send, now: Date.parse('2026-09-21T12:00:00.000Z') }), [], 'three hours is not stale')
    assert.deepEqual(await alertStaleClaims(root, config, { send, now: Date.parse('2026-09-21T16:00:00.000Z') }), ['ACM-1'])
    assert.deepEqual(await alertStaleClaims(root, config, { send, now: Date.parse('2026-09-21T17:00:00.000Z') }), [], 'told once')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].to, 'lead@agency.test')
    assert.match(sent[0].text, /ACM-1 — Fix the invite email\n {2}held by enso:athena WEB-1 @build, silent for 7h/)

    workRenew(root, { holder: 'enso:athena' }, o('2026-09-21T17:30:00.000Z'))
    assert.equal(item(root, 'ACM-1').claim!.stale_notified, undefined)
  })
})

test('work claim: of two machines racing for a ticket through the same origin, the second to push is refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lore-claim-race-'))
  const bares = join(home, 'repos')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  const prevHome = process.env.LORE_HOME
  process.env.LORE_HOME = home
  try {
    writeGlobalConfig({ remote: bares })
    mkdirSync(bares, { recursive: true })
    const seed = makeContextRepo({})
    await captureConsole(async () => {
      await workAdd(seed, { title: 'Fix the invite email' }, { context: seed, at: '2026-09-20T10:00:00.000Z' })
      await workAdd(seed, { title: 'Profile photo crop' }, { context: seed, at: '2026-09-20T10:01:00.000Z' })
    })
    git(seed, 'init', '-q')
    git(seed, 'add', '-A')
    git(seed, 'commit', '-qm', 'seed')
    git(home, 'clone', '-q', '--bare', seed, join(bares, 'lore-acme.git'))
    // The other machine: its own clone, pushing straight to the origin.
    const other = join(home, 'other')
    git(home, 'clone', '-q', join(bares, 'lore-acme.git'), other)
    const otherClaims = (key: string, ref: string, at: string) => {
      workClaim(other, key, { holder: 'enso:mobile-qa', ref }, { context: other, at, quiet: true })
      git(other, 'add', '-A')
      git(other, 'commit', '-qm', `claim ${key}`)
      git(other, 'push', '-q')
    }
    // This machine reads through the cache, as a hosted agent does. `pull: false`
    // stands in for the moment between its read and its push.
    const mine = (at: string) => ({ context: 'lore-acme', at, pull: false, quiet: true })
    assert.equal(workList('.', { context: 'lore-acme', json: true }).length, 2)

    otherClaims('ACM-2', 'MOB-2', '2026-09-21T09:00:00.000Z')
    const ok = workClaim('.', 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1' }, mine('2026-09-21T09:01:00.000Z'))
    assert.equal(ok.outcome, 'claimed', 'a claim on a different ticket does not block ours')

    await captureConsole(async () => void workRelease('.', 'ACM-1', { holder: 'enso:athena', reason: 'handing back' }, { context: 'lore-acme', at: '2026-09-21T09:02:00.000Z', quiet: true }))
    git(other, 'pull', '-q')
    otherClaims('ACM-1', 'MOB-1', '2026-09-21T09:03:00.000Z')
    assert.throws(() => workClaim('.', 'ACM-1', { holder: 'enso:athena', ref: 'WEB-1' }, mine('2026-09-21T09:04:00.000Z')), /held by enso:mobile-qa MOB-1/)

    git(other, 'pull', '-q')
    const final = readWorkItems(other, 'ACM')
    assert.deepEqual(final.map((i) => i.claim?.holder), ['enso:mobile-qa', 'enso:mobile-qa'])
    assert.equal(git(other, 'log', '--oneline').split('\n').filter((l) => /claim ACM-1 enso:athena/.test(l)).length, 1, 'the refused claim never reached the origin')
  } finally {
    if (prevHome === undefined) delete process.env.LORE_HOME
    else process.env.LORE_HOME = prevHome
  }
})

test('claims: one made by hand is let go when its holder hands the ticket on, and is never reported as quiet', async () => {
  const { root } = await fixture()
  const as = (by: string, at: string) => ({ context: root, at, by })
  await captureConsole(async () => {
    workClaim(root, 'ACM-1', { stage: 'build', status: 'in_progress' }, as('jeff', '2026-09-21T09:00:00.000Z'))
    workClaim(root, 'ACM-2', { holder: 'enso:athena', ref: 'WEB-2', stage: 'build' }, as('runner', '2026-09-21T09:00:00.000Z'))
    assert.equal(item(root, 'ACM-1').claim!.holder, 'jeff')

    const sent: MailMessage[] = []
    const config = { ...ACME, client: { ...ACME.client!, owner: 'lead@agency.test' } }
    assert.deepEqual(await alertStaleClaims(root, config, { send: async (m) => void sent.push(m), now: Date.parse('2026-09-22T09:00:00.000Z') }), ['ACM-2'], 'only the run is expected to check in')

    await workMove(root, 'ACM-2', 'review', { reason: 'a person moved it' }, as('jeff', '2026-09-22T10:00:00.000Z'))
    assert.equal(item(root, 'ACM-2').claim!.ref, 'WEB-2', "a run's claim is its runner's to release")
    await workMove(root, 'ACM-1', 'review', { reason: 'PR is up' }, as('jeff', '2026-09-22T10:01:00.000Z'))
    assert.equal(item(root, 'ACM-1').claim, undefined)
    assert.deepEqual(item(root, 'ACM-1').history.at(-1)!.change, { claim: ['jeff @build', null], status: ['in_progress', 'review'] })
  })
})

test('dispatch rechecks file rank and capacity on the claim, including work started outside the runner', async () => {
  const root = makeContextRepo()
  const opts = { context: root, quiet: true }
  const dispatch = { holder: 'enso:athena', nextFor: 'Athena' }
  const first = workAdd(root, { title: 'Finish checkout', assignee: 'athena' }, opts)
  const second = workAdd(root, { title: 'Add invoice export', assignee: 'Athena', priority: 'P1' }, opts)
  assert.throws(() => workClaim(root, second.key, dispatch, opts), /no longer next/)
  assert.equal(workClaim(root, first.key, dispatch, opts).outcome, 'claimed')
  assert.throws(() => workClaim(root, second.key, dispatch, opts), /work in flight/)
  workRelease(root, first.key, { holder: dispatch.holder, status: 'review', reason: 'With the reviewer' }, opts)
  assert.throws(() => workClaim(root, second.key, dispatch, opts), /work in flight/)
  assert.equal(item(root, second.key).history.length, 1)
  workMove(root, first.key, 'done', { reason: 'Accepted' }, opts)
  assert.equal(workClaim(root, second.key, dispatch, opts).outcome, 'claimed')
})
