import assert from 'node:assert/strict'
import { test } from 'node:test'
import { api, ApiError } from '../web/src/api.js'

test('board API handles upstream HTML errors without exposing JSON parsing errors', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const [status, body, expected] of [
      [503, '<!doctype html><h1>Service unavailable</h1>', /temporarily unavailable/],
      [429, '<!doctype html><h1>Rate limited</h1>', /Wait a minute/],
      [200, '<!doctype html><h1>Proxy page</h1>', /Refresh the page/],
      [200, 'null', /Refresh the page/],
      [400, '{"error":"enter a valid email address"}', /enter a valid email address/],
    ] as const) {
      globalThis.fetch = async () => new Response(body, { status })
      await assert.rejects(api.login('test@example.com'), error => error instanceof ApiError && error.status === status && expected.test(error.message))
    }
    globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 })
    assert.deepEqual(await api.login('test@example.com'), { ok: true })
  } finally {
    globalThis.fetch = originalFetch
  }
})
