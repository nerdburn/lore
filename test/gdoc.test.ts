import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sowAdd } from '../src/commands/sow.js'
import { exportGoogleDoc, googleDocId } from '../src/gdoc.js'
import { readSows } from '../src/sow.js'
import { captureConsole, makeContextRepo } from './helpers.js'

// Isolate from the developer's ~/.lore/config.json (a saved global `owner` would satisfy the no-owner case).
process.env.LORE_HOME = mkdtempSync(join(tmpdir(), 'lore-home-gdoc-'))

const DOC_ID = '1DNMt4pUJPRqU7vj3dPo6U0icWuNO_2RbZAcEKnATaqg'
const URL = `https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`

test('gdoc: recognises Docs and Drive links, rejects everything else', () => {
  assert.equal(googleDocId(URL), DOC_ID)
  assert.equal(googleDocId(`https://docs.google.com/document/d/${DOC_ID}`), DOC_ID)
  assert.equal(googleDocId(`https://drive.google.com/file/d/${DOC_ID}/view`), DOC_ID)
  assert.equal(googleDocId('https://docs.google.com/spreadsheets/d/abc'), undefined)
  assert.equal(googleDocId('./sow.md'), undefined)
  assert.equal(googleDocId('https://example.com/document/d/' + DOC_ID), undefined)
})

function fakeKeyFile(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const dir = mkdtempSync(join(tmpdir(), 'lore-sa-'))
  const file = join(dir, 'sa.json')
  writeFileSync(file, JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.test/token' }))
  return file
}

function fakeDrive(opts: { tokenError?: string; missing?: boolean; mime?: string; apiDisabled?: boolean } = {}) {
  const calls: { url: string; sub?: string; auth?: string }[] = []
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
    if (url === 'https://oauth2.test/token') {
      const assertion = new URLSearchParams(String(init?.body)).get('assertion')!
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString())
      calls.push({ url, sub: claims.sub })
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.readonly')
      return opts.tokenError ? json({ error: opts.tokenError }, 401) : json({ access_token: 'tok' })
    }
    calls.push({ url, auth })
    if (opts.apiDisabled) return json({ error: { message: 'Google Drive API has not been used in project 1 before or it is disabled.' } }, 403)
    if (url.includes(`/files/${DOC_ID}?`)) return opts.missing ? json({ error: 'nf' }, 404) : json({ name: 'Input — SOW — Jointly (Marketing Site)', mimeType: opts.mime ?? 'application/vnd.google-apps.document' })
    if (url.includes(`/files/${DOC_ID}/export`)) return new Response('**![logo][image1]**\n\n**Statement of Work**  \n\nJointly — Marketing site\n\n\n\n| Estimated Weeks | 3 weeks |\n\n[image1]: <data:image/png;base64,AAAA>\n', { status: 200, headers: { 'content-type': 'text/markdown' } })
    return json({ error: 'unexpected ' + url }, 500)
  }) as typeof fetch
  return { fetchFn, calls }
}

test('gdoc: exports a Doc as markdown, acting as the given teammate, and tidies image refs', async () => {
  const d = fakeDrive()
  const doc = await exportGoogleDoc(URL, 'shawn@inputlogic.ca', { fetch: d.fetchFn, keyFile: fakeKeyFile() })
  assert.equal(doc.id, DOC_ID)
  assert.equal(doc.name, 'Input — SOW — Jointly (Marketing Site)')
  assert.equal(doc.url, `https://docs.google.com/document/d/${DOC_ID}`)
  assert.equal(doc.markdown, '****\n\n**Statement of Work**\n\nJointly — Marketing site\n\n| Estimated Weeks | 3 weeks |')
  assert.equal(d.calls[0].sub, 'shawn@inputlogic.ca')
  assert.ok(d.calls.slice(1).every((c) => c.auth === 'Bearer tok'))
})

test('gdoc: failures name the fix', async () => {
  const key = fakeKeyFile()
  await assert.rejects(exportGoogleDoc(URL, 'x@y', { fetch: fakeDrive({ tokenError: 'unauthorized_client' }).fetchFn, keyFile: key }), /domain-wide delegation .* lacks https:\/\/www\.googleapis\.com\/auth\/drive\.readonly/)
  await assert.rejects(exportGoogleDoc(URL, 'x@y', { fetch: fakeDrive({ missing: true }).fetchFn, keyFile: key }), /not found, or x@y cannot see it/)
  await assert.rejects(exportGoogleDoc(URL, 'x@y', { fetch: fakeDrive({ mime: 'application/pdf' }).fetchFn, keyFile: key }), /not a Google Doc — download it/)
  await assert.rejects(exportGoogleDoc(URL, 'x@y', { fetch: fakeDrive({ apiDisabled: true }).fetchFn, keyFile: key }), /Drive API is not enabled/)
  await assert.rejects(exportGoogleDoc('https://example.com/x', 'x@y', { keyFile: key }), /not a Google Doc link/)
  await assert.rejects(exportGoogleDoc(URL, 'x@y', { keyFile: join(tmpdir(), 'nope.json') }), /no service account key/)
})

test('sow add: a Google Doc link is exported as client.owner, and becomes the source', async () => {
  const root = makeContextRepo({}, { project: 'acme', client: { name: 'Acme', domains: ['acme.com'], contacts: [], owner: 'shawn@inputlogic.ca' } })
  const seen: string[] = []
  const exportDoc = async (url: string, as: string) => {
    seen.push(`${as} ${url}`)
    return { id: DOC_ID, name: 'n', url: `https://docs.google.com/document/d/${DOC_ID}`, markdown: '# SOW\n\nThree weeks.\nTotal $19,000.' }
  }
  const { result } = await captureConsole(() => sowAdd(root, { name: 'Acme SOW 1', weeks: 3, start: '2026-06-02', end: '2026-07-02', file: URL }, { context: root, exportDoc }))
  assert.deepEqual(seen, [`shawn@inputlogic.ca ${URL}`])
  assert.equal(result.source, `https://docs.google.com/document/d/${DOC_ID}`)
  const [sow] = readSows(root)
  assert.match(sow.body, /Three weeks\./)
  assert.doesNotMatch(sow.body, /19,000/)

  // --as overrides; an explicit --source wins over the link.
  await captureConsole(() => sowAdd(root, { name: 'Acme SOW 2', weeks: 1, start: '2026-06-02', end: '2026-07-02', file: URL, as: 'kaity@inputlogic.ca', source: 'https://drive/x' }, { context: root, exportDoc }))
  assert.equal(seen[1], `kaity@inputlogic.ca ${URL}`)
  assert.equal(readSows(root).find((s) => s.id === 'acme-sow-2')?.source, 'https://drive/x')

  // No owner and no --as: refuse rather than guess whose Drive to read.
  const bare = makeContextRepo()
  await assert.rejects(sowAdd(bare, { name: 'x', weeks: 1, start: '2026-06-02', end: '2026-07-02', file: URL }, { context: bare, exportDoc }), /needs --as/)
})
