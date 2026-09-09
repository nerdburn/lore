import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { parse, stringify } from 'yaml'
import { loadConfig } from '../config.js'
import { loadState, saveState } from '../state.js'
import type { Pin } from '../types.js'

/**
 * LLM extraction fold: streams/ + derived/ → updated derived/. (SPEC §5)
 *
 * - Input: current artifacts + only stream files whose content changed since
 *   they were last folded (state.extracted tracks path → length)
 * - Update, don't rewrite: item ids and wording are preserved unless
 *   evidence changes them
 * - Every new/changed item cites source permalinks
 * - Old unresolved requests → status "stale", never silently dropped
 * - Pins in facts.yaml are audited against fresh evidence → contradictions
 * - No network except the LLM (connectors never run here)
 *
 * Two interchangeable backends:
 * - "sdk": the Claude API via @anthropic-ai/sdk — API-key billing, used
 *   whenever ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set. Structured
 *   outputs guarantee the fold's shape.
 * - "cli": headless Claude Code (`claude -p`) — runs on a Claude
 *   subscription; locally via your existing login, in CI via a
 *   CLAUDE_CODE_OAUTH_TOKEN secret (`claude setup-token`, Max plans).
 * Override with LORE_LLM=sdk|cli.
 *
 * Large backfills are folded in batches: each call sees the current
 * artifacts plus one slice of new material and returns the updated
 * artifacts, which feed the next batch.
 */

const MODEL = process.env.LORE_MODEL ?? 'claude-opus-4-8'
const BATCH_CHARS = 300_000
const ARTIFACTS = ['requests', 'decisions', 'roadmap'] as const

const ITEM_SCHEMAS: Record<string, object> = {
  requests: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'req-0001 style; preserve existing ids' },
      request: { type: 'string' },
      requested_by: { type: 'string' },
      date: { type: 'string' },
      status: { type: 'string', enum: ['open', 'in_progress', 'done', 'stale'] },
      source: { type: 'string', description: 'permalink to the evidence' },
    },
    required: ['id', 'request', 'requested_by', 'date', 'status', 'source'],
    additionalProperties: false,
  },
  decisions: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      decision: { type: 'string' },
      decided_by: { type: 'string' },
      date: { type: 'string' },
      source: { type: 'string' },
    },
    required: ['id', 'decision', 'decided_by', 'date', 'source'],
    additionalProperties: false,
  },
  roadmap: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      item: { type: 'string' },
      priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
      status: { type: 'string', enum: ['planned', 'in_progress', 'done'] },
      source: { type: 'string' },
    },
    required: ['id', 'item', 'priority', 'status', 'source'],
    additionalProperties: false,
  },
}

const FOLD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    requests: { type: 'array', items: ITEM_SCHEMAS.requests },
    decisions: { type: 'array', items: ITEM_SCHEMAS.decisions },
    roadmap: { type: 'array', items: ITEM_SCHEMAS.roadmap },
    contradictions: {
      type: 'array',
      description: 'pinned facts that fresh evidence contradicts',
      items: {
        type: 'object',
        properties: {
          pin_id: { type: 'string' },
          conflict: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['pin_id', 'conflict', 'source'],
        additionalProperties: false,
      },
    },
  },
  required: ['requests', 'decisions', 'roadmap', 'contradictions'],
  additionalProperties: false,
}

const FOLD_SYSTEM = `You maintain the derived-artifact layer of a project's memory. Input: the current artifacts (YAML), the pinned facts, and a batch of newly synced raw material (Slack messages with permalinks). Output: the updated artifacts.

Rules:
- Update, don't rewrite. Preserve existing item ids and wording unless the new material is evidence that they should change.
- Only add items with real evidence in the material: a request is something someone asked for; a decision is something someone with authority declared; a roadmap item is planned work. Casual chatter is not an artifact.
- Every new or changed item cites the most relevant source permalink from the material.
- Never delete a request, decision, or roadmap item. Every existing item must appear in your output (updated if evidence changed it). When new evidence shows a request was completed, mark it done. Requests older than ~30 days with no activity become "stale", never "open".
- New ids continue the existing sequence (req-0007 after req-0006).
- Compare the pinned facts against the material; report any the evidence now contradicts. An empty contradictions list is the normal case.`

const REPORT_SYSTEM = `You write the weekly status report for a client project, derived from the past week of synced Slack history and the project's tracked artifacts. Markdown, these sections in order: Done, In progress, Blockers, Bugs, Decisions, New requests, Next. Every claim cites a source permalink. Be specific and factual — name who did or said what. Omit a section (heading and all) if there is genuinely nothing for it. No preamble.`

interface FoldResult {
  requests: unknown[]
  decisions: unknown[]
  roadmap: unknown[]
  contradictions: { pin_id: string; conflict: string; source: string }[]
}

type Backend = 'sdk' | 'cli'

export async function extract(root: string, opts: { report?: boolean } = {}): Promise<void> {
  const config = loadConfig(root)
  if (config.lifecycle === 'archived') {
    console.log(`${config.project} is archived — nothing to extract`)
    return
  }
  const state = loadState(root)
  const llm = pickBackend()
  const today = new Date().toISOString().slice(0, 10)

  const wantArtifacts = ARTIFACTS.filter((a) => config.extract.includes(a))
  const reportDue =
    config.extract.includes('weekly-report') && (opts.report || isToday(config.report?.day ?? 'friday'))

  // New material = any stream file whose content changed since it was last
  // folded. Day-files only ever grow (append-only streams), so length is a
  // sufficient fingerprint and cheap to keep in state.json.
  state.extracted ??= {}
  const newFiles = streamFiles(root).filter((f) => state.extracted![f.path] !== f.text.length)

  if (wantArtifacts.length > 0 && newFiles.length > 0) {
    const artifacts: Record<string, unknown[]> = {}
    for (const name of wantArtifacts) artifacts[name] = readYamlList(root, `context/derived/${name}.yaml`)
    const pins = stringify((parse(readFileSync(join(root, 'context/facts.yaml'), 'utf8')) as Pin[] | null) ?? [])

    const batches = pack(newFiles, BATCH_CHARS)
    console.log(`extracting from ${newFiles.length} stream file(s) in ${batches.length} batch(es) [${llm}:${MODEL}]…`)

    let contradictions: FoldResult['contradictions'] = []
    mkdirSync(join(root, 'context/derived'), { recursive: true })
    const clientNote = config.client
      ? `\n\n# Client\n${config.client.name}${config.client.domains.length ? ` — people with emails at ${config.client.domains.join(', ')} are the client` : ''}${
          config.client.contacts.length
            ? `\nKnown people: ${config.client.contacts.map((c) => `${c.name} <${c.email}>${c.role ? ` (${c.role})` : ''} [${c.side}]`).join('; ')}`
            : ''
        }\nAttribute requests and decisions to the client side vs the team accordingly.`
      : ''
    for (let i = 0; i < batches.length; i++) {
      const user = `Today is ${today}.${clientNote}\n\n# Current artifacts\n${Object.entries(artifacts)
        .map(([name, items]) => `## ${name}\n${stringify(items)}`)
        .join('\n')}\n\n# Pinned facts\n${pins}\n\n# New material\n${batches[i].text}`
      const result = await withRetry(() => (llm === 'sdk' ? sdkFold(user) : Promise.resolve(cliFold(user))), 2, (attempt, err) =>
        console.warn(`  ⚠ batch ${i + 1} attempt ${attempt} failed (${err instanceof Error ? err.message : err}) — retrying`),
      )
      for (const name of wantArtifacts) {
        const merged = acceptFold(name, artifacts[name], (result as unknown as Record<string, unknown[]>)[name])
        if (merged.rejected) console.warn(`  ⚠ ${name}: model ${merged.rejected}`)
        artifacts[name] = merged.items
      }
      contradictions = result.contradictions
      // Checkpoint after every batch — artifacts to disk, consumed files to
      // state.extracted — so a killed fold resumes at the next batch instead
      // of refolding from the start.
      for (const name of wantArtifacts) {
        writeFileSync(
          join(root, `context/derived/${name}.yaml`),
          `# Derived by \`lore extract\` — regenerable; do not hand-edit.\n` + stringify(artifacts[name]),
        )
      }
      for (const f of batches[i].files) state.extracted[f.path] = f.length
      saveState(root, state)
      console.log(
        `  batch ${i + 1}/${batches.length}: ${wantArtifacts.map((n) => `${artifacts[n].length} ${n}`).join(', ')}`,
      )
    }

    if (contradictions.length > 0) {
      writeFileSync(join(root, 'context/derived/contradictions.yaml'), stringify(contradictions))
      console.warn(
        `⚠ ${contradictions.length} pinned fact(s) contradicted by fresh evidence — see derived/contradictions.yaml`,
      )
    }
  } else if (wantArtifacts.length > 0) {
    console.log('no new stream material since last extract')
  }

  if (reportDue) {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
    const week = streamFiles(root).filter((f) => f.day >= weekAgo)
    if (week.length === 0) {
      console.log('weekly report: no material this week')
    } else {
      const artifactContext = ARTIFACTS.map((n) => `## ${n}\n${readRaw(root, `context/derived/${n}.yaml`)}`).join('\n')
      const user = `Today is ${today}.\n\n# Tracked artifacts\n${artifactContext}\n\n# This week's raw material\n${week
        .map((f) => f.text)
        .join('\n\n')}`
      const report = llm === 'sdk' ? await sdkText(REPORT_SYSTEM, user) : cliCall(REPORT_SYSTEM, user)
      mkdirSync(join(root, 'context/derived/reports'), { recursive: true })
      writeFileSync(join(root, `context/derived/reports/${today}.md`), report.trim() + '\n')
      console.log(`wrote derived/reports/${today}.md`)
    }
  }

  state.lastExtract = new Date().toISOString()
  saveState(root, state)
}

/** API creds → sdk; else a usable claude CLI → cli; else sdk (its
 * resolution error names the options). LORE_LLM overrides. */
function pickBackend(): Backend {
  if (process.env.LORE_LLM === 'cli' || process.env.LORE_LLM === 'sdk') return process.env.LORE_LLM
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'sdk'
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
    return 'cli'
  } catch {
    return 'sdk'
  }
}

// ---- sdk backend: Claude API with structured outputs ----

async function sdkFold(user: string): Promise<FoldResult> {
  const text = await sdkText(FOLD_SYSTEM, user, FOLD_SCHEMA)
  return JSON.parse(text) as FoldResult
}

async function sdkText(system: string, user: string, schema?: Record<string, unknown>): Promise<string> {
  const client = new Anthropic()
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    system,
    ...(schema ? { output_config: { format: { type: 'json_schema' as const, schema } } } : {}),
    messages: [{ role: 'user', content: user }],
  })
  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') throw new Error('extract: model refused the request')
  if (message.stop_reason === 'max_tokens') throw new Error('extract: output truncated — lower BATCH_CHARS')
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

// ---- cli backend: headless Claude Code on a subscription ----

function cliFold(user: string): FoldResult {
  const instruction = `\n\nRespond with ONLY a JSON object matching this schema — no prose, no code fences:\n${JSON.stringify(FOLD_SCHEMA)}`
  return parseFoldOutput(cliCall(FOLD_SYSTEM + instruction, user))
}

/**
 * Retry transient LLM failures (dropped connections, 5xx, overload) with a
 * short backoff. Refusals and truncation are deterministic and not retried.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  onRetry: (attempt: number, err: unknown) => void = () => {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const permanent = /refused|truncated|no JSON|not valid JSON|missing array/i.test(message)
      if (permanent || attempt > retries) throw err
      onRetry(attempt, err)
      await sleep(Math.min(5000 * 2 ** (attempt - 1), 30_000))
    }
  }
}

/**
 * The fold is update-only: items may be added or changed, never dropped.
 * Models do drop them — a batch of pure commit history often comes back
 * with `requests: []` — so merge instead of trusting the returned list:
 * every existing item survives (replaced by the proposed version when the
 * same id is returned), and proposed items with new ids are appended.
 * Returns what to store and, when existing items were omitted, a short
 * note for the log.
 */
export function acceptFold(
  name: string,
  previous: unknown[],
  proposed: unknown[] | undefined,
): { items: unknown[]; rejected?: string } {
  if (!Array.isArray(proposed)) return { items: previous, rejected: `no "${name}" array` }
  const idOf = (i: unknown) => (i as { id?: string }).id
  const proposedById = new Map<string, unknown>()
  for (const item of proposed) {
    const id = idOf(item)
    if (id) proposedById.set(id, item)
  }
  const merged: unknown[] = []
  const seen = new Set<string>()
  const omitted: string[] = []
  for (const item of previous) {
    const id = idOf(item)
    if (id && proposedById.has(id)) {
      merged.push(proposedById.get(id))
      seen.add(id)
    } else {
      merged.push(item)
      if (id) omitted.push(id)
    }
  }
  for (const item of proposed) {
    const id = idOf(item)
    if (!id || !seen.has(id)) {
      merged.push(item)
      if (id) seen.add(id)
    }
  }
  return omitted.length
    ? { items: merged, rejected: `omitted ${omitted.length} existing item(s) (${omitted.slice(0, 4).join(', ')}${omitted.length > 4 ? '…' : ''}) — kept them` }
    : { items: merged }
}

/**
 * The CLI backend has no structured-output guarantee, so tolerate prose or
 * code fences around the JSON and validate the shape before trusting it.
 */
export function parseFoldOutput(text: string): FoldResult {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`extract: no JSON in model output: ${text.slice(0, 200)}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (err) {
    throw new Error(`extract: model output is not valid JSON: ${err instanceof Error ? err.message : err}`)
  }
  const obj = parsed as Record<string, unknown>
  for (const key of ['requests', 'decisions', 'roadmap', 'contradictions']) {
    if (!Array.isArray(obj[key])) throw new Error(`extract: model output missing array "${key}"`)
  }
  return obj as unknown as FoldResult
}

function cliCall(system: string, user: string): string {
  // Prompt over stdin: batches are far larger than argv allows.
  const out = execFileSync('claude', ['-p', '--output-format', 'json', '--model', 'opus'], {
    input: `${system}\n\n${user}`,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString()
  const envelope = JSON.parse(out) as { is_error?: boolean; result?: string }
  if (envelope.is_error || typeof envelope.result !== 'string') {
    throw new Error(`extract: claude cli error: ${(envelope.result ?? out).slice(0, 300)}`)
  }
  return envelope.result
}

// ---- shared helpers ----

export interface StreamFile {
  /** Relative to the context root, e.g. "context/streams/slack/#acme/2026-07-01.md". */
  path: string
  day: string
  text: string
}

/** All stream files with their day, sorted ascending — the fold order. */
export function streamFiles(root: string): StreamFile[] {
  const files: StreamFile[] = []
  const base = join(root, 'context/streams')
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) {
        files.push({ path: relative(root, path), day: entry.name.slice(0, 10), text: readFileSync(path, 'utf8') })
      }
    }
  }
  if (existsSync(base)) walk(base)
  return files.sort((a, b) => a.day.localeCompare(b.day) || a.path.localeCompare(b.path))
}

export interface Batch {
  text: string
  lastDay: string
  files: { path: string; length: number }[]
}

export function pack(files: Pick<StreamFile, 'day' | 'text'>[] & Partial<StreamFile>[], budget: number): Batch[] {
  const batches: Batch[] = []
  let current = ''
  let lastDay = ''
  let members: Batch['files'] = []
  for (const f of files) {
    if (current && current.length + f.text.length > budget) {
      batches.push({ text: current, lastDay, files: members })
      current = ''
      members = []
    }
    current += f.text + '\n\n'
    lastDay = f.day
    members.push({ path: f.path ?? '', length: f.text.length })
  }
  if (current) batches.push({ text: current, lastDay, files: members })
  return batches
}

function readYamlList(root: string, rel: string): unknown[] {
  const path = join(root, rel)
  if (!existsSync(path)) return []
  return (parse(readFileSync(path, 'utf8')) as unknown[] | null) ?? []
}

function readRaw(root: string, rel: string): string {
  const path = join(root, rel)
  return existsSync(path) ? readFileSync(path, 'utf8') : '(none yet)'
}

function isToday(day: string): boolean {
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  return names[new Date().getUTCDay()] === day.toLowerCase()
}
