import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { parse, stringify } from 'yaml'
import { loadConfig } from '../config.js'
import { loadState, saveState } from '../state.js'
import type { Pin } from '../types.js'

/**
 * LLM extraction fold: streams/ + derived/ → updated derived/. (SPEC §5)
 *
 * - Input: current artifacts + only stream docs since state.lastExtract
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
- Never delete a request. When new evidence shows one was completed, mark it done. Requests older than ~30 days with no activity become "stale", never "open".
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
  const state = loadState(root)
  const llm = pickBackend()
  const today = new Date().toISOString().slice(0, 10)

  const wantArtifacts = ARTIFACTS.filter((a) => config.extract.includes(a))
  const reportDue =
    config.extract.includes('weekly-report') && (opts.report || isToday(config.report?.day ?? 'friday'))

  // Day-granular incremental window: stream files are one file per day.
  const sinceDay = state.lastExtract?.slice(0, 10) ?? ''
  const newFiles = streamFiles(root).filter((f) => f.day >= sinceDay)

  if (wantArtifacts.length > 0 && newFiles.length > 0) {
    const artifacts: Record<string, unknown[]> = {}
    for (const name of wantArtifacts) artifacts[name] = readYamlList(root, `context/derived/${name}.yaml`)
    const pins = stringify((parse(readFileSync(join(root, 'context/facts.yaml'), 'utf8')) as Pin[] | null) ?? [])

    const batches = pack(newFiles, BATCH_CHARS)
    console.log(`extracting from ${newFiles.length} stream file(s) in ${batches.length} batch(es) [${llm}:${MODEL}]…`)

    let contradictions: FoldResult['contradictions'] = []
    for (let i = 0; i < batches.length; i++) {
      const user = `Today is ${today}.\n\n# Current artifacts\n${Object.entries(artifacts)
        .map(([name, items]) => `## ${name}\n${stringify(items)}`)
        .join('\n')}\n\n# Pinned facts\n${pins}\n\n# New material\n${batches[i]}`
      const result = llm === 'sdk' ? await sdkFold(user) : cliFold(user)
      for (const name of wantArtifacts) artifacts[name] = (result as unknown as Record<string, unknown[]>)[name]
      contradictions = result.contradictions
      console.log(
        `  batch ${i + 1}/${batches.length}: ${wantArtifacts.map((n) => `${artifacts[n].length} ${n}`).join(', ')}`,
      )
    }

    mkdirSync(join(root, 'context/derived'), { recursive: true })
    for (const name of wantArtifacts) {
      writeFileSync(
        join(root, `context/derived/${name}.yaml`),
        `# Derived by \`lore extract\` — regenerable; do not hand-edit.\n` + stringify(artifacts[name]),
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
  const text = cliCall(FOLD_SYSTEM + instruction, user)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`extract: no JSON in model output: ${text.slice(0, 200)}`)
  return JSON.parse(text.slice(start, end + 1)) as FoldResult
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

/** All stream files with their day, sorted ascending — the fold order. */
function streamFiles(root: string): { day: string; text: string }[] {
  const files: { day: string; text: string }[] = []
  const base = join(root, 'context/streams')
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) {
        files.push({ day: entry.name.slice(0, 10), text: readFileSync(path, 'utf8') })
      }
    }
  }
  if (existsSync(base)) walk(base)
  return files.sort((a, b) => a.day.localeCompare(b.day))
}

function pack(files: { text: string }[], budget: number): string[] {
  const batches: string[] = []
  let current = ''
  for (const f of files) {
    if (current && current.length + f.text.length > budget) {
      batches.push(current)
      current = ''
    }
    current += f.text + '\n\n'
  }
  if (current) batches.push(current)
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
