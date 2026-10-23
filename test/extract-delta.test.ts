import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { extract, foldMaterial, pack, streamFiles } from '../src/commands/extract.js'
import { loadState } from '../src/state.js'
import { writeDocs } from '../src/streams.js'
import { captureConsole, makeContextRepo } from './helpers.js'

const message = (id: string, timestamp: string, text: string) =>
  ({ source: 'slack', channel: '#acme', id, author: 'Customer', timestamp, text })

/** A day-file with one folded entry, then one appended after it. */
function dayFile() {
  const root = makeContextRepo({}, { project: 'acme', sources: {} })
  writeDocs(root, [message('slack-1', '2026-10-22T09:00:00Z', 'Morning: can we move the launch?')])
  const [first] = streamFiles(root)
  writeDocs(root, [message('slack-2', '2026-10-22T15:00:00Z', 'Afternoon: launch moves to Friday.')])
  const [grown] = streamFiles(root)
  return { first, grown }
}

test('fold delta: only entries appended since the folded length are read, under the file\'s front matter', () => {
  const { first, grown } = dayFile()
  const delta = foldMaterial(grown, first.text.length)
  assert.equal(delta.length, grown.text.length, 'records the whole file as folded')
  assert.match(delta.text, /^---\nsource: slack\nchannel: "#acme"\ndate: 2026-10-22\n---\n\(continues context\/streams\/slack\/#acme\/2026-10-22\.md;/)
  assert.match(delta.text, /launch moves to Friday/)
  assert.doesNotMatch(delta.text, /Morning/)
})

test('fold delta: the whole file goes when the folded prefix cannot be trusted', () => {
  const { first, grown } = dayFile()
  const whole = (f: ReturnType<typeof foldMaterial>) => f.text === grown.text
  assert.ok(whole(foldMaterial(grown, undefined)), 'never folded')
  assert.ok(whole(foldMaterial(grown, grown.text.length + 10)), 'shorter than when folded')
  assert.ok(whole(foldMaterial(grown, first.text.length, 'f'.repeat(64))), 'prefix digest no longer matches')
  assert.ok(whole(foldMaterial(grown, first.text.length - 5)), 'cut inside an entry')
  const project = { ...grown, path: 'context/streams/github-projects/acme_1/2026-10-22.md' }
  assert.equal(foldMaterial(project, first.text.length).text, grown.text, 'a source rewritten in place')
})

test('fold delta: pack records the full file length for a delta, so the next fold starts after it', () => {
  const { first, grown } = dayFile()
  const [batch] = pack([foldMaterial(grown, first.text.length)], 300_000)
  assert.deepEqual(batch.files, [{ path: grown.path, length: grown.text.length }])
})

test('fold delta: a timer fold after new messages sends only those messages, and a rewritten file is resent whole', async () => {
  const root = makeContextRepo({}, { project: 'acme', sources: {}, extract: ['requests'] })
  // A stand-in `claude` that records each prompt and proposes nothing.
  const bin = mkdtempSync(join(tmpdir(), 'lore-fake-claude-'))
  const prompts = join(bin, 'prompts.log')
  const result = JSON.stringify({ result: JSON.stringify({ requests: [], decisions: [], roadmap: [], contradictions: [], work_changes: [], work_new: [] }) })
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\n{ cat; printf '\\n<<END>>\\n'; } >> "${prompts}"\nprintf '%s' '${result}'\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  const env = { PATH: process.env.PATH, LORE_LLM: process.env.LORE_LLM, LORE_PR_MATCHING: process.env.LORE_PR_MATCHING }
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.LORE_LLM = 'cli'
  process.env.LORE_PR_MATCHING = 'off'
  const sent = () => readFileSync(prompts, 'utf8').split('\n<<END>>\n').filter(Boolean).map(p => p.slice(p.indexOf('# New material')))
  try {
    writeDocs(root, [message('slack-1', '2026-10-22T09:00:00Z', 'Morning: can we move the launch?')])
    await captureConsole(() => extract(root))
    writeDocs(root, [message('slack-2', '2026-10-22T15:00:00Z', 'Afternoon: launch moves to Friday.')])
    const { out } = await captureConsole(() => extract(root))
    let folds = sent()
    assert.equal(folds.length, 2)
    assert.match(folds[0], /Morning/)
    assert.match(folds[1], /launch moves to Friday/)
    assert.doesNotMatch(folds[1], /Morning/, 'the already-folded morning is not resent')
    assert.match(out, /extracting from 1 stream file\(s\), [\d,]+ new chars, in 1 batch/)
    const path = 'context/streams/slack/#acme/2026-10-22.md'
    const state = loadState(root)
    assert.equal(state.extracted?.[path], readFileSync(join(root, path), 'utf8').length)
    assert.match(state.extractedHead?.[path] ?? '', /^[0-9a-f]{64}$/)

    // Earlier text changed under the fold (a hand edit, a bad merge): resend all of it.
    const file = join(root, path)
    writeFileSync(file, readFileSync(file, 'utf8').replace('Morning', 'Early') + '\n### Customer — 2026-10-22T16:00:00Z\n<!-- id: slack-3 -->\n\nOne more.\n')
    await captureConsole(() => extract(root))
    folds = sent()
    assert.equal(folds.length, 3)
    assert.match(folds[2], /Early: can we move the launch/)
    assert.match(folds[2], /One more/)
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('weekly report: written once on report day, not on every timer fold; --report still forces one', async () => {
  const day = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date().getUTCDay()]
  const root = makeContextRepo({}, { project: 'acme', sources: {}, extract: ['weekly-report'], report: { day, post_to: '#acme' } })
  const bin = mkdtempSync(join(tmpdir(), 'lore-fake-claude-'))
  const calls = join(bin, 'calls.log')
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > /dev/null\necho call >> "${calls}"\nprintf '%s' '{"result":"# Weekly report"}'\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  const env = { PATH: process.env.PATH, LORE_LLM: process.env.LORE_LLM, LORE_PR_MATCHING: process.env.LORE_PR_MATCHING }
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.LORE_LLM = 'cli'
  process.env.LORE_PR_MATCHING = 'off'
  const count = () => readFileSync(calls, 'utf8').trim().split('\n').length
  try {
    writeDocs(root, [message('slack-1', new Date().toISOString(), 'This week: launch moved to Friday.')])
    await captureConsole(() => extract(root))
    await captureConsole(() => extract(root))
    assert.equal(count(), 1, 'the second timer fold on report day does not rewrite the report')
    await captureConsole(() => extract(root, { report: true }))
    assert.equal(count(), 2)
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
