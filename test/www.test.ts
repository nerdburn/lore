import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clientStatuses } from '../src/commands/www.js'
import { renderMarkdown, slug } from '../src/markdown.js'
import { makeContextRepo } from './helpers.js'

test('markdown: headings, paragraphs, code, lists, tables, inline, escaping', () => {
  const html = renderMarkdown(`# Title <x>

Some *emph* and **bold** with \`code\` and a [link](https://e.x/a).

- one
- two
  continued

1. first
2. second

| A | B |
|---|---|
| 1 | \`c\` |

\`\`\`sh
echo "<hi>"
\`\`\`

---
`)
  assert.match(html, /<h1 id="title-x">Title &lt;x&gt;<\/h1>/)
  assert.match(html, /<p>Some <em>emph<\/em> and <strong>bold<\/strong> with <code>code<\/code> and a <a href="https:\/\/e.x\/a">link<\/a>.<\/p>/)
  assert.match(html, /<ul><li>one<\/li><li>two continued<\/li><\/ul>/)
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/)
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td><code>c<\/code><\/td><\/tr><\/tbody><\/table>/)
  assert.match(html, /<pre><code class="lang-sh">echo &quot;&lt;hi&gt;&quot;<\/code><\/pre>/)
  assert.match(html, /<hr>/)
  assert.equal(slug('4. Create the `context` repo — one command'), '4-create-the-context-repo-one-command')
})

test('www: client statuses come from the bare repos at HEAD', () => {
  const repos = mkdtempSync(join(tmpdir(), 'lore-www-'))
  const g = (root: string, ...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  const seed = (name: string, cfg: Record<string, unknown>, files: Record<string, string> = {}) => {
    const bare = join(repos, `${name}.git`)
    mkdirSync(bare)
    execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', bare])
    const src = makeContextRepo(files, cfg)
    g(src, 'init', '--quiet', '-b', 'main')
    g(src, 'config', 'user.email', 't@t')
    g(src, 'config', 'user.name', 't')
    g(src, 'add', '-A')
    g(src, 'commit', '--quiet', '-m', 'chore(lore): sync')
    g(src, 'push', '--quiet', bare, 'main')
  }
  seed(
    'lore-acme',
    { project: 'acme', client: { name: 'Acme' }, sources: { slack: { channels: ['#a'], api_base: 'https://s/api' }, github: { repos: ['a/b'], api_base: 'https://g' }, linear: { disabled: true } } },
    { 'state.json': JSON.stringify({ cursors: {}, lastSync: '2026-09-09T10:00:00Z', lastExtract: '2026-09-09T10:05:00Z', sources: { slack: { lastAttempt: 'x', lastSuccess: '2026-09-09T10:00:00Z' }, github: { lastAttempt: 'x', lastError: { at: 'x', message: 'repo gone' } } } }) },
  )
  seed('lore-old', { project: 'old', lifecycle: 'archived', archived_at: '2026-09-01T00:00:00Z' })
  mkdirSync(join(repos, 'not-a-repo'))

  const statuses = clientStatuses(repos)
  assert.deepEqual(statuses.map((s) => s.name), ['lore-acme', 'lore-old'])
  const acme = statuses[0]
  assert.equal(acme.client, 'Acme')
  assert.equal(acme.lifecycle, 'active')
  assert.deepEqual(acme.sources, ['slack', 'github'], 'disabled sources are not listed')
  assert.equal(acme.lastSync, '2026-09-09T10:00:00Z')
  assert.equal(acme.health.github.lastError, 'repo gone')
  assert.equal(acme.health.slack.lastError, undefined)
  assert.match(acme.lastCommit!, /chore\(lore\): sync$/)
  assert.equal(statuses[1].lifecycle, 'archived')
  assert.equal(statuses[1].lastSync, undefined)
  assert.deepEqual(clientStatuses('/nonexistent'), [])
})
