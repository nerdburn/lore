import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { authFailureReason, cliFailureReason, fallbackApiKey, notifyFallback, resetFallback, usageLimitReason, withCliFallback } from '../src/llm-fallback.js'
import type { MailMessage } from '../src/board/email.js'

process.env.LORE_HOME = mkdtempSync(join(tmpdir(), 'lore-fallback-home-'))
const marker = () => join(process.env.LORE_HOME!, 'llm-fallback.json')

/** What execFileSync throws when `claude -p` exits non-zero with its JSON envelope on stdout. */
const cliFailure = (envelope: Record<string, unknown>) => Object.assign(new Error('Command failed: claude -p --output-format json --model sonnet'), { stdout: Buffer.from(JSON.stringify(envelope)) })
/** What the host's CLI said on 2026-11-12 when its OAuth session lapsed. */
const expired = () => cliFailure({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed', terminal_reason: 'api_error' })
const weekly = () => cliFailure({ is_error: true, result: 'You\'ve hit your weekly limit · resets 11am (UTC)', api_error_status: 429 })

beforeEach(() => {
  resetFallback()
  delete process.env.LORE_FALLBACK_ANTHROPIC_API_KEY
})

test('fallback: recognises subscription limits from the CLI envelope or a wrapped message, and nothing else', () => {
  assert.equal(usageLimitReason(weekly()), 'You\'ve hit your weekly limit · resets 11am (UTC)')
  assert.equal(usageLimitReason(cliFailure({ is_error: true, result: 'You\'ve hit your daily limit' })), 'You\'ve hit your daily limit')
  assert.equal(usageLimitReason(cliFailure({ is_error: true, api_error_status: 429 })), 'usage limit (HTTP 429)')
  assert.equal(usageLimitReason(new Error('load: You\'ve hit your weekly limit · resets Oct 24, 11am (UTC)')), 'You\'ve hit your weekly limit · resets Oct 24, 11am (UTC)')
  assert.equal(usageLimitReason(new Error('extract: claude cli error: 5-hour limit reached ∙ resets 3pm')), '5-hour limit reached ∙ resets 3pm')
  assert.equal(usageLimitReason(cliFailure({ is_error: true, result: 'Invalid API key' })), undefined)
  assert.equal(usageLimitReason(new Error('extract: output truncated — lower BATCH_CHARS')), undefined)
})

test('fallback: recognises a lost CLI login, kept apart from limits', () => {
  assert.equal(authFailureReason(expired()), 'Failed to authenticate: OAuth session expired and could not be refreshed')
  assert.equal(authFailureReason(cliFailure({ is_error: true, result: 'Invalid API key · Please run /login' })), 'Invalid API key · Please run /login')
  assert.equal(authFailureReason(cliFailure({ is_error: true, api_error_status: 401 })), 'authentication failed (HTTP 401)')
  assert.equal(authFailureReason(new Error('extract: claude cli error: OAuth token has expired')), 'OAuth token has expired')
  assert.equal(authFailureReason(weekly()), undefined)
  assert.equal(authFailureReason(new Error('extract: output truncated — lower BATCH_CHARS')), undefined)
  assert.deepEqual(cliFailureReason(weekly()), { kind: 'limit', reason: 'You\'ve hit your weekly limit · resets 11am (UTC)' })
  assert.deepEqual(cliFailureReason(expired()), { kind: 'auth', reason: 'Failed to authenticate: OAuth session expired and could not be refreshed' })
  assert.equal(cliFailureReason(cliFailure({ is_error: true, result: 'Overloaded' })), undefined)
})

test('fallback: a lost login switches to the API key and says it is an auth problem', async () => {
  process.env.LORE_FALLBACK_ANTHROPIC_API_KEY = 'sk-ant-test'
  const notices: [string, string][] = []
  assert.equal(await withCliFallback(() => { throw expired() }, async () => 'api', async (r, k) => { notices.push([r, k]) }), 'api')
  assert.deepEqual(notices, [['Failed to authenticate: OAuth session expired and could not be refreshed', 'auth']])
  assert.equal(fallbackApiKey(), 'sk-ant-test')
})

test('fallback: without a fallback key a limit fails as before', async () => {
  await assert.rejects(withCliFallback(() => { throw weekly() }, async () => 'api', async () => {}), /Command failed/)
  assert.equal(fallbackApiKey(), undefined)
})

test('fallback: a limit switches the process to the API key once — concurrent failures notify once, later calls skip the CLI', async () => {
  process.env.LORE_FALLBACK_ANTHROPIC_API_KEY = 'sk-ant-test'
  const notices: string[] = []
  let cliCalls = 0
  const cli = () => { cliCalls++; throw weekly() }
  const notify = async (reason: string) => { notices.push(reason) }
  assert.equal(fallbackApiKey(), undefined, 'the subscription is used until a limit is seen')
  const results = await Promise.all([1, 2, 3].map(() => withCliFallback(cli, async () => 'api', notify)))
  assert.deepEqual(results, ['api', 'api', 'api'])
  assert.deepEqual(notices, ['You\'ve hit your weekly limit · resets 11am (UTC)'])
  assert.equal(fallbackApiKey(), 'sk-ant-test')
  assert.equal(await withCliFallback(cli, async () => 'api', notify), 'api')
  assert.equal(cliCalls, 1, 'the first limit switches everyone in flight; no CLI call after it')
  await assert.rejects(withCliFallback(() => 'cli', async () => { throw new Error('api down') }, notify), /api down/)
})

test('fallback: other CLI failures are not a switch', async () => {
  process.env.LORE_FALLBACK_ANTHROPIC_API_KEY = 'sk-ant-test'
  await assert.rejects(withCliFallback(() => { throw cliFailure({ is_error: true, result: 'Overloaded' }) }, async () => 'api', async () => {}), /Command failed/)
  await assert.rejects(withCliFallback(() => { throw new Error('extract: output truncated — lower BATCH_CHARS') }, async () => 'api', async () => {}), /truncated/)
  assert.equal(fallbackApiKey(), undefined)
})

test('fallback: one email per episode; a CLI success ends the episode so the next limit emails again', async () => {
  process.env.LORE_LLM_FALLBACK_NOTIFY = 'ops@example.com'
  const sent: MailMessage[] = []
  const send = async (msg: MailMessage) => { sent.push(msg) }
  await notifyFallback('You\'ve hit your weekly limit', 'limit', send)
  await notifyFallback('You\'ve hit your weekly limit', 'limit', send)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, 'ops@example.com')
  assert.match(sent[0].subject, /switched to the API key/)
  assert.match(sent[0].text, /used its Claude subscription limit and is switching to the backup Claude API key/)
  assert.doesNotMatch(sent[0].text, /sk-ant/, 'the email never carries the key')
  assert.ok(existsSync(marker()))
  assert.equal(await withCliFallback(() => 'cli', async () => 'api'), 'cli')
  assert.ok(!existsSync(marker()), 'the subscription answering again ends the episode')
  await notifyFallback('You\'ve hit your weekly limit', 'limit', send)
  assert.equal(sent.length, 2)
  delete process.env.LORE_LLM_FALLBACK_NOTIFY
})

test('fallback: a lost login emails how to restore it, never the key', async () => {
  process.env.LORE_LLM_FALLBACK_NOTIFY = 'ops@example.com'
  assert.equal(await withCliFallback(() => 'cli', async () => 'api'), 'cli') // clear any episode
  const sent: MailMessage[] = []
  await notifyFallback('Failed to authenticate: OAuth session expired and could not be refreshed', 'auth', async (msg) => { sent.push(msg) })
  assert.equal(sent.length, 1)
  assert.match(sent[0].subject, /lost its Claude login/)
  assert.match(sent[0].text, /does not fix itself/)
  assert.match(sent[0].text, /claude setup-token/)
  assert.match(sent[0].text, /CLAUDE_CODE_OAUTH_TOKEN/)
  assert.doesNotMatch(sent[0].text, /sk-ant/)
  delete process.env.LORE_LLM_FALLBACK_NOTIFY
})
