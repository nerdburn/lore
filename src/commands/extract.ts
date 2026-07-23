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
 * - No network except the LLM API (connectors never run here)
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

const FOLD_SCHEMA = {
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

export async function extract(root: string, opts: { report?: boolean } = {}): Promise<void> {
  const config = loadConfig(root)
  const state = loadState(root)
  const client = new Anthropic()
  const today = new Date().toISOString().slice(0, 10)

  const wantArtifacts = ARTIFACTS.filter((a) => config.extract.includes(a))
  const reportDue =
    config.extract.includes('weekly-report') &&
    (opts.report || today === nextDayDate(config.report?.day ?? 'friday'))

  // Day-granular incremental window: stream files are one file per day.
  const sinceDay = state.lastExtract?.slice(0, 10) ?? ''
  const newFiles = streamFiles(root).filter((f) => f.day >= sinceDay)

  if (wantArtifacts.length > 0 && newFiles.length > 0) {
    let artifacts: Record<string, unknown[]> = {}
    for (const name of wantArtifacts) artifacts[name] = readYamlList(root, `context/derived/${name}.yaml`)
    const pins = stringify((parse(readFileSync(join(root, 'context/facts.yaml'), 'utf8')) as Pin[] | null) ?? [])

    const batches = pack(newFiles, BATCH_CHARS)
    console.log(`extracting from ${newFiles.length} stream file(s) in ${batches.length} batch(es) [${MODEL}]…`)

    let contradictions: FoldResult['contradictions'] = []
    for (let i = 0; i < batches.length; i++) {
      const result = await fold(client, artifacts, pins, batches[i], today)
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
      console.warn(`⚠ ${contradictions.length} pinned fact(s) contradicted by fresh evidence — see derived/contradictions.yaml`)
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
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: REPORT_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Today is ${today}.\n\n# Tracked artifacts\n${artifactContext}\n\n# This week's raw material\n${week.map((f) => f.text).join('\n\n')}`,
          },
        ],
      })
      const message = await stream.finalMessage()
      const report = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      mkdirSync(join(root, 'context/derived/reports'), { recursive: true })
      writeFileSync(join(root, `context/derived/reports/${today}.md`), report + '\n')
      console.log(`wrote derived/reports/${today}.md`)
    }
  }

  state.lastExtract = new Date().toISOString()
  saveState(root, state)
}

async function fold(
  client: Anthropic,
  artifacts: Record<string, unknown[]>,
  pins: string,
  material: string,
  today: string,
): Promise<FoldResult> {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    system: FOLD_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: FOLD_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `Today is ${today}.\n\n# Current artifacts\n${Object.entries(artifacts)
          .map(([name, items]) => `## ${name}\n${stringify(items)}`)
          .join('\n')}\n\n# Pinned facts\n${pins}\n\n# New material\n${material}`,
      },
    ],
  })
  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') throw new Error('extract: model refused the fold request')
  if (message.stop_reason === 'max_tokens') throw new Error('extract: output truncated — lower BATCH_CHARS or raise max_tokens')
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return JSON.parse(text) as FoldResult
}

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

/** Does `today` fall on the configured weekday? Returns today's date if so. */
function nextDayDate(day: string): string {
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const now = new Date()
  return names[now.getUTCDay()] === day.toLowerCase() ? now.toISOString().slice(0, 10) : ''
}
