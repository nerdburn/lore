import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { addedLines, gateReplay } from '../src/commands/gate.js'
import { DEFAULT_GATE_THRESHOLD, gateConfig, gateQuestions, newPart, runGate, type Fetch } from '../src/gate.js'
import { captureConsole, makeContextRepo } from './helpers.js'

/** A fake Jev: records each request, answers every question with `p(state)`. */
function fakeJev(p: (material: string) => number) {
  const calls: { state: Record<string, string>; questions: Record<string, unknown>; auth: string }[] = []
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { state: Record<string, string>; questions: Record<string, unknown> }
    calls.push({ ...body, auth: String((init.headers as Record<string, string>).Authorization) })
    const answers = Object.fromEntries(Object.keys(body.questions).map((q) => [q, { type: 'noul', noul: p(body.state.material) }]))
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 10 } }), { status: 200 })
  }) as unknown as Fetch
  return { fetch, calls }
}

test('gate: folds when any question clears the threshold, skips when none does; asks about pins only when there are some', async () => {
  const jev = fakeJev((m) => (/please|merged/.test(m) ? 0.9 : 0.05))
  const input = { trackedWork: 'ACM-1 | rank 1 | todo | Stripe webhooks', pins: '[]' }
  const chatter = await runGate({ ...input, material: [{ path: 'context/streams/slack/#acme/2026-09-20.md', text: 'lol nice weekend' }] }, { apiKey: 'k', fetch: jev.fetch })
  assert.equal(chatter.fold, false)
  assert.equal(chatter.top.p, 0.05)
  const ask = await runGate({ ...input, material: [{ path: 'context/streams/slack/#acme/2026-09-20.md', text: 'please move the launch' }] }, { apiKey: 'k', fetch: jev.fetch })
  assert.equal(ask.fold, true)
  assert.equal(jev.calls[0].auth, 'Bearer k')
  assert.deepEqual(Object.keys(jev.calls[0].questions), ['ask', 'decision', 'plan', 'progress'])
  assert.equal(jev.calls[0].state.tracked_work, input.trackedWork)
  assert.match(jev.calls[0].state.material, /^## context\/streams\/slack\/#acme\/2026-09-20\.md\nlol nice weekend$/)
  assert.ok(!('pinned_facts' in jev.calls[0].state))

  await runGate({ ...input, pins: '- id: pin-0001\n  fact: launch is Nov 20\n', material: [{ path: 'x', text: 'hi' }] }, { apiKey: 'k', fetch: jev.fetch })
  assert.ok('contradiction' in jev.calls.at(-1)!.questions)
  assert.deepEqual(Object.keys(gateQuestions(true)), ['ask', 'decision', 'plan', 'progress', 'contradiction'])
})

test('gate: big material is split and the highest probability across chunks wins; an API error throws (the caller folds)', async () => {
  const jev = fakeJev((m) => (m.includes('merged') ? 0.8 : 0.01))
  const text = `${'chatter line\n\n'.repeat(6000)}the webhook PR is merged`
  const r = await runGate({ trackedWork: '', pins: '', material: [{ path: 'p', text }] }, { apiKey: 'k', fetch: jev.fetch })
  assert.ok(r.chunks > 1)
  assert.equal(r.fold, true)
  assert.equal(r.inputTokens, 100 * r.chunks)

  const failing = (async () => new Response('overloaded', { status: 529 })) as unknown as Fetch
  await assert.rejects(runGate({ trackedWork: '', pins: '', material: [{ path: 'p', text: 'x' }] }, { apiKey: 'k', fetch: failing }), /HTTP 529/)
})

test('gate: config comes from the environment; only the unconsumed tail of a day-file is sent', () => {
  assert.equal(gateConfig({}), undefined)
  assert.equal(gateConfig({ TYPESAFE_API_KEY: 'k', LORE_GATE: 'off' }), undefined)
  assert.deepEqual(gateConfig({ TYPESAFE_API_KEY: 'k' }), { apiKey: 'k', threshold: DEFAULT_GATE_THRESHOLD })
  assert.deepEqual(gateConfig({ TYPESAFE_API_KEY: 'k', LORE_GATE_THRESHOLD: '0.5' }), { apiKey: 'k', threshold: 0.5 })
  assert.deepEqual(gateConfig({ TYPESAFE_API_KEY: 'k', LORE_GATE_THRESHOLD: 'nope' }), { apiKey: 'k', threshold: DEFAULT_GATE_THRESHOLD })
  assert.equal(newPart('old\nnew', 4), 'new')
  assert.equal(newPart('rewritten', 40), 'rewritten', 'a shorter file was rewritten: send all of it')
  assert.equal(newPart('fresh', undefined), 'fresh')
})

test('gate replay: addedLines keeps only appended stream lines, per file', () => {
  const diff = [
    'diff --git a/context/streams/slack/#acme/2026-09-20.md b/context/streams/slack/#acme/2026-09-20.md',
    '--- a/context/streams/slack/#acme/2026-09-20.md',
    '+++ b/context/streams/slack/#acme/2026-09-20.md',
    '@@ -3,0 +4,2 @@',
    '+### Priya — 10:02',
    '+can we add Apple Pay?',
    'diff --git a/context/streams/github/acme_web/2026-09-20.md b/context/streams/github/acme_web/2026-09-20.md',
    '--- /dev/null',
    '+++ b/context/streams/github/acme_web/2026-09-20.md',
    '@@ -0,0 +1 @@',
    '+PR #44 merged',
  ].join('\n')
  assert.deepEqual(addedLines(diff), [
    { path: 'context/streams/slack/#acme/2026-09-20.md', text: '### Priya — 10:02\ncan we add Apple Pay?' },
    { path: 'context/streams/github/acme_web/2026-09-20.md', text: 'PR #44 merged' },
  ])
})

test('gate replay: scores each past incremental fold and reports skips that would have lost a change', async () => {
  const root = makeContextRepo({ 'context/derived/requests.yaml': '- id: req-0001\n  request: seed\n', 'state.json': '{"cursors":{}}\n' })
  const g = (...a: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
  const day = join(root, 'context/streams/slack/#acme/2026-09-20.md')
  mkdirSync(join(root, 'context/streams/slack/#acme'), { recursive: true })
  let hour = 0
  const commit = (subject: string, fold: boolean) => {
    if (fold) writeFileSync(join(root, 'state.json'), JSON.stringify({ cursors: {}, lastExtract: `2026-09-20T${String(++hour).padStart(2, '0')}:00:00Z` }, null, 2) + '\n')
    g('add', '-A')
    g('commit', '--quiet', '--allow-empty', '-m', `chore(lore): ${subject}`)
  }
  // As run-all commits: sync (streams) then, separately, the fold — "sync"
  // when it changed an artifact, "heartbeat" when only state.json moved.
  g('init', '--quiet')
  writeFileSync(day, 'start\n')
  commit('scaffold', true)
  // 1: chatter over two syncs; the fold found nothing.
  appendFileSync(day, 'lol nice weekend\n')
  commit('sync lore-acme', false)
  appendFileSync(day, 'ha\n')
  commit('sync lore-acme', false)
  commit('heartbeat lore-acme', true)
  // 2: a real ask; the fold added a request.
  appendFileSync(day, 'please add Apple Pay\n')
  commit('sync lore-acme', false)
  appendFileSync(join(root, 'context/derived/requests.yaml'), '- id: req-0002\n  request: Apple Pay\n')
  commit('sync lore-acme', true)
  // 3: the gate misses a quiet one the fold caught.
  appendFileSync(day, 'fyi pushed it\n')
  commit('sync lore-acme', false)
  appendFileSync(join(root, 'context/derived/requests.yaml'), '- id: req-0003\n  request: quiet\n')
  commit('sync lore-acme', true)
  // 4: a fold run with no new material — no LLM call, not replayed.
  commit('heartbeat lore-acme', true)

  const jev = fakeJev((m) => (m.includes('please') ? 0.95 : m.includes('pushed') ? 0.25 : 0.02))
  const { result: r, out } = await captureConsole(() => gateReplay(root, { apiKey: 'k', fetch: jev.fetch }))
  assert.equal(r.replayed, 3)
  assert.equal(r.folded_something, 2)
  assert.deepEqual(r.rows.map((x) => [x.changed, x.top.p]), [[[], 0.02], [['requests'], 0.95], [['requests'], 0.25]])
  assert.match(jev.calls.find((c) => c.state.material.includes('lol'))!.state.material, /\nlol nice weekend\nha$/, 'everything since the previous fold, across syncs')
  assert.match(jev.calls.find((c) => c.state.material.includes('please'))!.state.material, /\nplease add Apple Pay$/, 'only what was appended since the previous fold')
  const at = (t: number) => r.thresholds.find((x) => x.threshold === t)!
  assert.deepEqual([at(0.2).skipped, at(0.2).missed], [1, 0])
  assert.deepEqual([at(0.3).skipped, at(0.3).missed], [2, 1])
  assert.match(out, /replayed 3 incremental fold\(s\); 2 changed something/)
  assert.match(out, /miss [0-9a-f]{7} .*fold changed requests; gate top ask p=0\.25/)
})
