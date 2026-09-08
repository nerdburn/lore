import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scrub, totalRedactions } from '../src/scrub.js'

// Fixture secrets are assembled at runtime so the source never contains a
// string that push protection or a scanner would flag as a live credential.
const fake = (...parts: string[]) => parts.join('')
export const FAKE_SLACK = fake('xoxb-', '1234567890-1234567890123-', 'AbCdEfGhIjKlMnOpQrStUvWx')
const FAKE_SLACK_USER = fake('xoxp-', '1234567890-1234567890123-', 'AbCdEfGhIjKlMnOp')
const SECRETS: [string, string][] = [
  ['slack-token', FAKE_SLACK],
  ['anthropic-key', fake('sk-ant-', 'api03-', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh')],
  ['openai-key', fake('sk-proj-', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')],
  ['github-token', fake('ghp_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')],
  ['github-token', fake('github_pat_', '11ABCDEFG0AbCdEfGhIjKlMnOpQrStUvWxYz')],
  ['aws-key-id', fake('AKIA', 'IOSFODNN7EXAMPLE')],
  ['google-key', fake('AIza', 'SyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1v')],
  ['stripe-key', fake('sk_live_', 'AbCdEfGhIjKlMnOpQrStUvWx')],
  ['jwt', fake('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')],
]

for (const [kind, secret] of SECRETS) {
  test(`scrub: redacts ${kind}`, () => {
    const { text, redacted } = scrub(`here you go: ${secret} — don't share`)
    assert.ok(!text.includes(secret), `secret survived: ${text}`)
    assert.ok(text.includes(`[redacted:`), text)
    assert.ok(totalRedactions(redacted) >= 1)
  })
}

test('scrub: redacts private key blocks entirely', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc123\n-----END RSA PRIVATE KEY-----'
  const { text, redacted } = scrub(`cert:\n${key}\nthanks`)
  assert.equal(text, 'cert:\n[redacted:private-key]\nthanks')
  assert.deepEqual(redacted, { 'private-key': 1 })
})

test('scrub: bearer tokens keep the scheme, lose the token', () => {
  const { text } = scrub('curl -H "Authorization: Bearer AbCdEf0123456789XyZ_token" https://x')
  assert.equal(text, 'curl -H "Authorization: Bearer [redacted:bearer]" https://x')
})

test('scrub: key/value credential assignments keep the key name', () => {
  const cases = [
    ['password: Hunter2Hunter2', 'password: [redacted:secret]'],
    ['DB_PASSWORD=s3cr3tPassw0rd!', 'DB_PASSWORD=[redacted:secret]!'],
    ['api_key = "a1b2c3d4e5f6"', 'api_key = "[redacted:secret]"'],
    ['client_secret: abcdefghijklmnopqrstuvwxyz', 'client_secret: [redacted:secret]'],
  ]
  for (const [input, expected] of cases) assert.equal(scrub(input).text, expected, input)
})

test('scrub: leaves ordinary text and env: references alone', () => {
  const clean = [
    'the token is broken again, can someone look?',
    'token: env:SLACK_TOKEN',
    'password reset flow is done',
    'see the API key in 1Password → vault Acme',
    'Talked to Priya about the roadmap and the black friday launch.',
    'PR #123 merged, sk8er boi playlist',
  ]
  for (const line of clean) {
    const r = scrub(line)
    assert.equal(r.text, line)
    assert.deepEqual(r.redacted, {})
  }
})

test('scrub: counts redactions by kind', () => {
  const { redacted } = scrub(`${FAKE_SLACK} and ${FAKE_SLACK_USER}, plus ${fake('AKIA', 'IOSFODNN7EXAMPLE')}`)
  assert.deepEqual(redacted, { 'slack-token': 2, 'aws-key-id': 1 })
  assert.equal(totalRedactions(redacted), 3)
})
