import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'

/** The config identity recall needs, for the default fixture project. */
export const ACME = { project: 'acme', lifecycle: 'active' as const, sources: {} }

const created: string[] = []
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/**
 * A throwaway context repo. `files` maps relative path → content; lore.json
 * defaults to a minimal Slack config unless supplied. Cleaned up when the
 * test file finishes.
 */
export function makeContextRepo(files: Record<string, string> = {}, config?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'lore-test-'))
  created.push(root)
  const cfg = config ?? {
    project: 'acme',
    sources: { slack: { channels: ['#acme'], token: 'env:SLACK_TOKEN' } },
    backfill: { months: 1 },
    extract: ['requests', 'decisions', 'roadmap'],
  }
  writeFileSync(join(root, 'lore.json'), JSON.stringify(cfg, null, 2) + '\n')
  mkdirSync(join(root, 'context/streams'), { recursive: true })
  mkdirSync(join(root, 'context/derived/reports'), { recursive: true })
  writeFileSync(join(root, 'context/facts.yaml'), '# Pinned facts. Written only via `lore remember`.\n[]\n')
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

/** Capture console output for the duration of fn. */
export async function captureConsole<T>(fn: () => T | Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origErr = console.error
  const origWarn = console.warn
  console.log = (...a: unknown[]) => out.push(a.join(' '))
  console.error = (...a: unknown[]) => err.push(a.join(' '))
  console.warn = (...a: unknown[]) => err.push(a.join(' '))
  try {
    const result = await fn()
    return { result, out: out.join('\n'), err: err.join('\n') }
  } finally {
    console.log = origLog
    console.error = origErr
    console.warn = origWarn
  }
}

/** Fixture Slack fold: a few channels' worth of realistic-looking docs. */
export const FIXTURE_STREAM = `---
source: slack
channel: "#acme"
date: 2026-08-03
---

### Priya — 2026-08-03T14:02:00.000Z
<!-- id: slack-C0ACME-1754229720.000100 team: T0TEAM channel: C0ACME user: U0PRIYA -->
[permalink](https://slack.com/archives/C0ACME/p1754229720000100)

Can we get the Black Friday landing page live before Nov 20? Marketing needs a week to QA.

### Shawn — 2026-08-03T14:10:00.000Z
<!-- id: slack-C0ACME-1754230200.000200 thread: 1754229720.000100 team: T0TEAM channel: C0ACME user: U0SHAWN -->
[permalink](https://slack.com/archives/C0ACME/p1754230200000200)

Yes — decision: we ship the landing page Nov 17, deploys stay manual until then.
`

export const FIXTURE_FACTS = `# Pinned facts. Written only via \`lore remember\`.
- id: pin-0001
  fact: Deploys are manual until the Black Friday launch
  category: deployment
  authorized_by: shawn
  date: 2026-08-04
- id: pin-0002
  fact: Priya is the client-side product owner
  category: client
  authorized_by: shawn
  date: 2026-08-04
`

export const FIXTURE_REQUESTS = `# Derived by \`lore extract\` — regenerable; do not hand-edit.
- id: req-0001
  request: Black Friday landing page live before Nov 20
  requested_by: Priya
  date: 2026-08-03
  status: open
  source: https://slack.com/archives/C0ACME/p1754229720000100
`

export const FIXTURE_DECISIONS = `# Derived by \`lore extract\` — regenerable; do not hand-edit.
- id: dec-0001
  decision: Ship the landing page Nov 17; deploys stay manual until then
  decided_by: Shawn
  date: 2026-08-03
  source: https://slack.com/archives/C0ACME/p1754230200000200
`

export const FIXTURE_ROADMAP = `# Derived by \`lore extract\` — regenerable; do not hand-edit.
- id: rm-0001
  item: Black Friday landing page
  priority: P1
  status: in_progress
  source: https://slack.com/archives/C0ACME/p1754230200000200
`

export const FIXTURE_REPORT = `## Done
- Landing page copy approved ([source](https://slack.com/archives/C0ACME/p1754229720000100))
`

/** Every layer populated — the shape recall and MCP tests run against. */
export function fullFixtureRepo(): string {
  return makeContextRepo({
    'context/streams/slack/#acme/2026-08-03.md': FIXTURE_STREAM,
    'context/facts.yaml': FIXTURE_FACTS,
    'context/derived/requests.yaml': FIXTURE_REQUESTS,
    'context/derived/decisions.yaml': FIXTURE_DECISIONS,
    'context/derived/roadmap.yaml': FIXTURE_ROADMAP,
    'context/derived/reports/2026-08-07.md': FIXTURE_REPORT,
    'context/derived/reports/2026-08-14.md': FIXTURE_REPORT.replace('Done', 'Done (week 2)'),
    'state.json': JSON.stringify({ cursors: {}, lastSync: '2026-08-14T06:23:00.000Z', lastExtract: '2026-08-14T06:30:00.000Z' }),
  })
}

/** A minimal zip (stored entries, no CRC) — enough for the Office reader, which ignores checksums. */
export function zipStored(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const n = Buffer.from(name, 'utf8')
    const d = Buffer.from(content, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(d.length, 18)
    local.writeUInt32LE(d.length, 22)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(d.length, 20)
    central.writeUInt32LE(d.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, d)
    centrals.push(central, n)
    offset += local.length + n.length + d.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(centrals.length / 2, 8)
  eocd.writeUInt16LE(centrals.length / 2, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

export const DOCX_XML = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Product Spec</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Merrin helps </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>parents</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>SMS first &amp; app later</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Phase</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Weeks</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Alpha</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>6</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>After the table.</w:t></w:r></w:p>
</w:body></w:document>`
