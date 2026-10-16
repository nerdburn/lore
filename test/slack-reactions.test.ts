import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { SLACK_REACTIONS, type ReactionSignal } from '../src/connectors/slack.js'
import { applySlackReactions, classifyReactionRequest, fallbackTitle, SLACK_REACTIONS_APPLIED } from '../src/slack-reactions.js'
import { readWorkItems, writeWorkItems, type LoreWorkItem } from '../src/work.js'
import { readAudit } from '../src/audit.js'
import { makeContextRepo } from './helpers.js'

const CONFIG = { project: 'acme', work: { prefix: 'ACM' } }
const AT = '2026-10-05T12:00:00.000Z'
const link = (ts: string) => `https://slack.com/archives/C0ACME/p${ts.replace('.', '')}`
const sig = (ts: string, over: Partial<ReactionSignal>): ReactionSignal => ({ channel: '#acme', ts, author: 'Brayden', text: 'Rename Affiliate to Ambassador on the home page.', ...over })

function repo(signals: Record<string, ReactionSignal>, items: LoreWorkItem[] = [], requests: unknown[] = [], applied: string[] = []) {
  const root = makeContextRepo({ [SLACK_REACTIONS]: stringify(signals), [SLACK_REACTIONS_APPLIED]: stringify(applied), 'context/derived/requests.yaml': stringify(requests) })
  if (items.length) writeWorkItems(root, 'ACM', items)
  return root
}

function ticket(key: string, over: Partial<LoreWorkItem> = {}): LoreWorkItem {
  return { key, title: 'Existing', status: 'todo', state: 'open', labels: [], sources: [], created: '2026-10-01', updated: '2026-10-01', history: [{ at: '2026-10-01T00:00:00Z', by: 'shawn', via: 'cli', change: { created: true }, reason: 'x' }], ...over }
}

test('slack reactions: 👍 opens a todo ticket with the writer\'s title, linked to its request', async () => {
  const ts = '1790982334.505889'
  const root = repo({ [link(ts)]: sig(ts, { ticket: ['cory'] }) }, [], [{ id: 'req-0144', source: link(ts), request: 'x', status: 'open' }])
  const r = await applySlackReactions(root, CONFIG, { at: AT, request: async () => true, title: async () => 'Rename Affiliate to Ambassador' })
  assert.equal(r.created.length, 1)
  const [item] = readWorkItems(root, 'ACM')
  assert.equal(item.key, 'ACM-1')
  assert.equal(item.title, 'Rename Affiliate to Ambassador')
  assert.equal(item.status, 'todo')
  assert.equal(item.request, 'req-0144')
  assert.deepEqual(item.sources, [link(ts)])
  assert.match(item.description!, /^> Rename Affiliate/)
  assert.deepEqual(item.history.map((h) => [h.by, h.via]), [['cory', 'slack']])
  assert.deepEqual(readAudit(root).map((a) => [a.actor, a.via, a.id]), [['cory', 'slack', 'ACM-1']])

  const again = await applySlackReactions(root, CONFIG, { at: AT, request: async () => true, title: async () => 'other' })
  assert.deepEqual(again, { created: [], done: [] }, 'idempotent')
})

test('slack reactions: ✅ closes the ticket already tracking the message, by source or by request', async () => {
  const a = '1790000000.000100'
  const b = '1790000000.000200'
  const root = repo(
    { [link(a)]: sig(a, { done: ['shawn'] }), [link(b)]: sig(b, { ticket: ['cory'], done: ['cory'] }) },
    [ticket('ACM-1', { sources: [link(a)] }), ticket('ACM-2', { request: 'req-0002' })],
    [{ id: 'req-0002', source: link(b) }],
  )
  const r = await applySlackReactions(root, CONFIG, { at: AT, request: async () => true })
  assert.deepEqual(r.created, [])
  const items = readWorkItems(root, 'ACM')
  assert.deepEqual(items.map((i) => [i.key, i.status, i.state]), [['ACM-1', 'done', 'closed'], ['ACM-2', 'done', 'closed']])
  assert.deepEqual(items[0].history.at(-1)!.change, { status: ['todo', 'done'] })
  assert.equal(items[0].history.at(-1)!.via, 'slack')
})

test('slack reactions: ✅ with no ticket opens one and closes it; a ticket reopened after its ✅ stays open', async () => {
  const a = '1790000000.000100'
  const b = '1790000000.000200'
  const reopened = ticket('ACM-1', { sources: [link(b)] })
  const root = repo({ [link(a)]: sig(a, { done: ['cory'] }), [link(b)]: sig(b, { done: ['shawn'] }) }, [reopened], [], [`${link(b)} done`])
  await applySlackReactions(root, CONFIG, { at: AT, request: async () => true, title: async () => { throw new Error('llm down') } })
  const items = readWorkItems(root, 'ACM')
  assert.deepEqual(items.map((i) => [i.key, i.status]), [['ACM-1', 'todo'], ['ACM-2', 'done']])
  assert.equal(items[1].title, 'Rename Affiliate to Ambassador on the home page', 'falls back to the message when the writer fails')
  assert.deepEqual(items[1].history.map((h) => Object.keys(h.change)[0]), ['created', 'status'])
})

test('slack reactions: the first run records existing reactions without acting on them', async () => {
  const a = '1790000000.000100'
  const b = '1790000000.000200'
  const root = makeContextRepo({ [SLACK_REACTIONS]: stringify({ [link(a)]: sig(a, { ticket: ['cory'] }) }) })
  assert.deepEqual(await applySlackReactions(root, CONFIG, { at: AT, request: async () => true }), { created: [], done: [] })
  assert.deepEqual(readWorkItems(root, 'ACM'), [])

  // Later: a ✅ lands on the old message and a 👍 on a new one — both act.
  writeFileSync(join(root, SLACK_REACTIONS), stringify({ [link(a)]: sig(a, { ticket: ['cory'], done: ['cory'] }), [link(b)]: sig(b, { ticket: ['shawn'] }) }))
  const r = await applySlackReactions(root, CONFIG, { at: AT, request: async () => true })
  assert.equal(r.created.length, 2)
  const items = readWorkItems(root, 'ACM')
  assert.deepEqual(items.map((i) => [i.key, i.status]), [['ACM-1', 'done'], ['ACM-2', 'todo']])
  assert.ok(items[0].history[0].reason.startsWith('✅ from cory'), 'the 👍 was there before the first run; only the ✅ is new')
  assert.ok(items[1].history[0].reason.startsWith('👍 from shawn'))
})

test('slack reactions: no index, no tracker file', async () => {
  const root = makeContextRepo()
  assert.deepEqual(await applySlackReactions(root, CONFIG), { created: [], done: [] })
  assert.deepEqual(readWorkItems(root, 'ACM'), [])
})

test('slack reactions: fallback titles drop mentions and emoji and stop at the first sentence', () => {
  assert.equal(fallbackTitle({ author: 'B', text: '<@U6NP54ZAP> :pray: Make the <https://momday.com/app|app link> work. Today it 404s.' }), 'Make the app link work')
  assert.equal(fallbackTitle({ author: 'Brayden', text: ':pray:' }), 'Slack request from Brayden')
  assert.ok(fallbackTitle({ author: 'B', text: 'word '.repeat(40) }).endsWith('…'))
})

test('slack reactions: acknowledgements never create tickets, even with both reactions or a derived request', async () => {
  for (const text of ['okay thank you', '<@U123> Okay, thank you! :pray:', 'Thanks!', '👍', 'sounds good', 'got it, thanks']) {
    const ts = '1790000000.000100'
    const root = repo({ [link(ts)]: sig(ts, { text, ticket: ['cory'], done: ['shawn'] }) }, [], [{ id: 'req-1', source: link(ts) }])
    const unexpected = async () => { assert.fail('acknowledgements need neither classification nor a title') }
    assert.deepEqual(await applySlackReactions(root, CONFIG, { request: unexpected, title: unexpected }), { created: [], done: [] })
    assert.deepEqual(readWorkItems(root, 'ACM'), [])
    assert.deepEqual(readAudit(root), [])
  }
})

test('slack reactions: negative request judgments are handled once without title generation', async () => {
  const ts = '1790000000.000100'
  const root = repo({ [link(ts)]: sig(ts, { text: 'We had a nice weekend', ticket: ['cory'] }) })
  let calls = 0
  const opts = { request: async () => { calls++; return false }, title: async () => { assert.fail('non-request needs no title') } }
  await applySlackReactions(root, CONFIG, opts)
  await applySlackReactions(root, CONFIG, opts)
  assert.equal(calls, 1)
  assert.deepEqual(readWorkItems(root, 'ACM'), [])
})

test('slack reactions: unavailable checks retry later and do not prevent other approved requests', async () => {
  const a = '1790000000.000100', b = '1790000000.000200'
  for (const unavailable of [async () => undefined, async () => { throw new Error('provider unavailable') }]) {
    const root = repo({ [link(a)]: sig(a, { ticket: ['cory'] }), [link(b)]: sig(b, { ticket: ['shawn'] }) })
    await applySlackReactions(root, CONFIG, { request: async s => s.ts === a ? unavailable() : true })
    assert.equal(readWorkItems(root, 'ACM').length, 1)
    assert.deepEqual(readWorkItems(root, 'ACM')[0].sources, [link(b)])
    const retry = await applySlackReactions(root, CONFIG, { request: async () => true })
    assert.equal(retry.created.length, 1)
    assert.equal(readWorkItems(root, 'ACM').length, 2)
    assert.deepEqual(await applySlackReactions(root, CONFIG), { created: [], done: [] })
  }
})

test('slack reactions: completion of an existing linked ticket needs no new request classification', async () => {
  const ts = '1790000000.000100'
  const root = repo({ [link(ts)]: sig(ts, { text: 'okay thank you', done: ['cory'] }) }, [ticket('ACM-1', { sources: [link(ts)] })])
  const result = await applySlackReactions(root, CONFIG, { request: async () => { assert.fail('existing work is already identified') } })
  assert.equal(result.done.length, 1)
  assert.equal(result.created.length, 0)
})

test('slack reactions: Jev checks the original ask before approval and preserves mixed thanks plus requests', async () => {
  for (const [score, expected] of [[0.1, false], [0.84, false], [0.85, true], [1, true]] as const) {
    const signal = sig('1790000000.000100', { text: 'Thanks! Please fix the broken checkout link.', ticket: ['cory'] })
    const fetchMock = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      assert.deepEqual(body.state, { message: signal.text }, 'reactions are not evidence of request intent')
      assert.match(body.questions.request.instructions, /original client message/)
      return Response.json({ answers: { request: { noul: score } } })
    }) as typeof fetch
    assert.equal(await classifyReactionRequest(signal, { apiKey: 'test', fetch: fetchMock }), expected)
  }
  const ack = sig('1790000000.000100', { text: 'okay thank you' })
  assert.equal(await classifyReactionRequest(ack, { apiKey: 'test', fetch: async () => { assert.fail('ack is deterministic') } }), false)
  const request = sig('1790000000.000100', {})
  assert.equal(await classifyReactionRequest(request, { apiKey: '' }), undefined)
  assert.equal(await classifyReactionRequest({ ...request, text: 'a'.repeat(20001) }, { apiKey: 'test' }), undefined)
  await assert.rejects(classifyReactionRequest(request, { apiKey: 'test', fetch: async () => new Response('unavailable', { status: 503 }) }), /HTTP 503/)
})
