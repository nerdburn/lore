import test from 'node:test'
import assert from 'node:assert/strict'
import { jevNouls, JEV_ENDPOINT, JEV_MODEL, type Fetch } from '../src/jev.js'

const questions = { relevant: { type: 'noul' as const, instructions: 'Is this relevant?' } }

test('Jev client sends typed questions and returns probabilities and usage', async () => {
  for (const model of [undefined, 'test-model']) {
    const mock = (async (url, init) => {
      assert.equal(url, JEV_ENDPOINT)
      assert.equal(init?.method, 'POST')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key')
      assert.deepEqual(JSON.parse(String(init?.body)), { model: model ?? JEV_MODEL, state: { text: 'Evidence' }, questions })
      assert.ok(init?.signal instanceof AbortSignal)
      return Response.json({ answers: { relevant: { noul: 0.75 } }, usage: { input_tokens: 42 } })
    }) as Fetch
    assert.deepEqual(await jevNouls({ text: 'Evidence' }, questions, { apiKey: 'test-key', fetch: mock, model }), {
      answers: { relevant: 0.75 }, inputTokens: 42,
    })
  }
})

test('Jev client rejects missing, malformed and out-of-range probabilities', async () => {
  for (const noul of [undefined, null, '0.5', -0.1, 1.1, NaN, Infinity]) {
    const mock = (async () => Response.json({ answers: { relevant: { noul } } })) as Fetch
    await assert.rejects(jevNouls({}, questions, { apiKey: 'test-key', fetch: mock }), /invalid answer for relevant/)
  }
  const missing = (async () => Response.json({})) as Fetch
  await assert.rejects(jevNouls({}, questions, { apiKey: 'test-key', fetch: missing }), /invalid answer for relevant/)
  for (const noul of [0, 1]) {
    const mock = (async () => Response.json({ answers: { relevant: { noul } } })) as Fetch
    assert.deepEqual(await jevNouls({}, questions, { apiKey: 'test-key', fetch: mock }), { answers: { relevant: noul }, inputTokens: 0 })
  }
})

test('Jev client propagates HTTP and network errors for callers to handle', async () => {
  const failed = (async () => new Response('unavailable', { status: 529 })) as Fetch
  await assert.rejects(jevNouls({}, questions, { apiKey: 'test-key', fetch: failed }), /HTTP 529 unavailable/)
  const offline = (async () => { throw new Error('network unavailable') }) as Fetch
  await assert.rejects(jevNouls({}, questions, { apiKey: 'test-key', fetch: offline }), /network unavailable/)
})
