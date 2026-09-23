import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { parse, stringify } from 'yaml'
import { loadConfig } from '../config.js'
import { describeSows, readSows, summarizeSow } from '../sow.js'
import { appendAudit } from '../audit.js'
import { applyFoldChanges, applyFoldCreations, describeWorkForPrompt, describeWorkHistory, readWorkItems, workPrefix, writeWorkItems, type WorkChangeProposal, type WorkCreateProposal } from '../work.js'
import { loadState, updateState } from '../state.js'
import { alwaysFolds, gateConfig, newPart, runGate } from '../gate.js'
import { STATUS_SUMMARY_SYSTEM, statusSummaryInput, writeStatus } from '../status.js'
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
 *
 * The fold is a delta: the model returns only items that are new or whose
 * fields changed, and `acceptFold` keeps every omitted item verbatim. Output
 * size therefore tracks what happened, not how much the project remembers —
 * the steady-state timer fold of a few new messages is a few items, not the
 * whole artifact set re-emitted.
 *
 * Two models: a full fold (first backfill, or a re-fold after deleting
 * state.extracted — many batches, empty or thin artifacts) uses LORE_MODEL;
 * an incremental fold (one small batch of new material onto existing
 * artifacts) uses LORE_MODEL_INCREMENTAL, cheaper and faster. A single batch
 * bigger than INCREMENTAL_MAX_CHARS — a new source's first backfill — is a
 * full fold too: on 200k chars of email the small model returned nothing.
 * Set both to the same id to opt out.
 */

const MODEL = process.env.LORE_MODEL ?? 'claude-opus-4-8'
const MODEL_INCREMENTAL = process.env.LORE_MODEL_INCREMENTAL ?? 'claude-sonnet-5'
/** Above this much new material a "one batch" fold is a backfill (a new source, a re-fold), not an hourly delta — the full model handles it. */
const INCREMENTAL_MAX_CHARS = 60_000
const BATCH_CHARS = 300_000
/** A document (or a day of design frames) in the weekly report is evidence that it arrived, not material to summarise in full — this much of it is plenty. */
const REPORT_DOC_CHARS = 12_000
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
    work_changes: {
      type: 'array',
      description: 'changes to tracked work items the material is unambiguous evidence for; empty when no tracked work is listed or nothing moved',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'the item key exactly as listed, e.g. CAR-3' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
          priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
          rank_above: { type: 'string', description: 'key of the item this should now sit directly above' },
          reason: { type: 'string', description: 'one sentence: who said or did what, when' },
          sources: { type: 'array', items: { type: 'string' }, description: 'permalinks to the evidence' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence_date: { type: 'string', description: 'YYYY-MM-DD of the evidence' },
        },
        required: ['key', 'reason', 'sources', 'confidence', 'evidence_date'],
        additionalProperties: false,
      },
    },
    work_new: {
      type: 'array',
      description: 'new tickets for committed work not yet tracked; empty when nothing new was committed',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'short, imperative, self-contained — a ticket title' },
          request: { type: 'string', description: 'the request id this tracks (req-0007), when there is one' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'blocked'] },
          priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
          assignee: { type: 'string', description: 'who is on it, when the material says' },
          reason: { type: 'string', description: 'one sentence: who committed to it, when, where' },
          sources: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence_date: { type: 'string', description: 'YYYY-MM-DD of the evidence' },
        },
        required: ['title', 'reason', 'sources', 'confidence', 'evidence_date'],
        additionalProperties: false,
      },
    },
  },
  required: ['requests', 'decisions', 'roadmap', 'contradictions', 'work_changes', 'work_new'],
  additionalProperties: false,
}

const FOLD_SYSTEM = `You maintain the derived-artifact layer of a project's memory. Input: the current artifacts (YAML), the pinned facts, and a batch of newly synced raw material — Slack messages, emails, meeting notes and transcripts, documentation pages, issues and pull requests — each with a permalink. Output: only the items that are new or changed — the caller merges them into the artifacts.

Email is a first-class source: a client asking for something in an email is a request; a client or lead confirming a plan in an email is a decision; scheduled work described in an email is roadmap. Attached documents (the docs stream — specs, briefs, decks, handoff packages the client sent) are the same: requirements a spec states are requests from whoever sent it, a plan a brief lays out is roadmap, a choice a document records is a decision — cite the document's permalink. A long document yields a handful of substantive items, not one per paragraph. Treat every source the same way — what matters is who said it and whether it is an ask, a call, or a plan.

Rules:
- Output is a delta. Return only items that are new, or existing items whose fields the material changed (return the whole item, same id). Every existing item you leave out is kept exactly as it is — do not repeat unchanged items. Empty arrays are the normal result for a batch with nothing new.
- Update, don't rewrite. Preserve existing item ids and wording unless the new material is evidence that they should change.
- Only add items with real evidence in the material: a request is something someone asked for; a decision is something someone with authority declared; a roadmap item is planned work. Casual chatter is not an artifact.
- Every new or changed item cites the most relevant source permalink from the material.
- Never delete a request, decision, or roadmap item; items are only ever added or updated. When new evidence shows a request was completed, return it with status done. A request older than ~30 days with no activity is returned once with status "stale", never left "open".
- New ids continue the existing sequence (req-0007 after req-0006). Never reuse an existing id for a different item.
- Compare the pinned facts against the material; report any the evidence now contradicts. An empty contradictions list is the normal case.
- Figma frames (source figma) are the design: what a screen contains, what a label says. They are evidence for confirming or contradicting a request, decision or ticket, not requests or roadmap in themselves — do not turn screen names into roadmap items or requests. Figma *comments* are like Slack messages: a request or decision when someone with authority makes one.
- Tracked work: when a "Tracked work" list is given, those items are the project's tracker of record — lore's own tickets, some mirrored from Jira or GitHub. Review them against the material and return work_changes for items the material moves: status (a merged PR, "shipped", "done", "blocked on X", someone starting on it), priority (a decision-maker calling it urgent or deferring it), or rank_above (an explicit reprioritisation). Only with high confidence and a citable source; medium or low confidence proposals are recorded as skipped, so return them only when they are worth a human's glance. Never propose archived, never invent keys, and never repeat a tracked item as a new roadmap item — a request that has a ticket takes its status from the ticket. An empty work_changes list is the normal case.
- New tickets: return work_new for work that is *committed* and not yet tracked — the team agreed to do it, someone is doing it, it is scheduled, or it is planned roadmap the client signed off on — whether the commitment is in this batch's material or visible in the current requests/roadmap. Reference the request id when one exists (request: req-0007) so the two stay linked. A ticket title is short and imperative. Not a ticket: a bare ask nobody agreed to, an open question, a decision, a meeting mention, anything already in the Tracked work list under other words (Jira/GitHub issues are mirrored there — do not duplicate them), or finished work (that is a request marked done). High confidence and a cited source only. A ticket is never proposed as done or archived. An empty work_new list is the normal case.`

const REPORT_SYSTEM = `You write the weekly status report for a client project, derived from the past week of synced history (Slack, email, meetings, attached documents, issues) and the project's tracked artifacts. Markdown, these sections in order: Done, In progress, Blockers, Bugs, Decisions, New requests, Next, Budget. Budget only when a Commitments section is given: one line per active SOW restating the figures given (weeks sold, effective date) — never compute or estimate weeks used or remaining. Every claim cites a source permalink. Be specific and factual — name who did or said what. Omit a section (heading and all) if there is genuinely nothing for it. No preamble.`

interface FoldResult {
  requests: unknown[]
  decisions: unknown[]
  roadmap: unknown[]
  contradictions: { pin_id: string; conflict: string; source: string }[]
  work_changes?: WorkChangeProposal[]
  work_new?: WorkCreateProposal[]
}

type Backend = 'sdk' | 'cli'

export async function extract(root: string, opts: { report?: boolean; review?: boolean } = {}): Promise<void> {
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
  // --review: one fold pass with no new material, so the model reviews the
  // current artifacts and tracker under the current rules (after a rule
  // change, or to open tickets for work already committed in memory).
  const review = opts.review === true && newFiles.length === 0

  let gated = false
  if (wantArtifacts.length > 0 && newFiles.length > 0 && !review) gated = await gateSkips(root, config, state, newFiles, today)

  if (wantArtifacts.length > 0 && (newFiles.length > 0 || review) && !gated) {
    const artifacts: Record<string, unknown[]> = {}
    for (const name of wantArtifacts) artifacts[name] = readYamlList(root, `context/derived/${name}.yaml`)
    const pins = stringify((parse(readFileSync(join(root, 'context/facts.yaml'), 'utf8')) as Pin[] | null) ?? [])

    const batches = review ? [{ text: '(no new material — review the current artifacts and tracked work under the rules)', files: [] as { path: string; length: number }[] }] : pack(newFiles, BATCH_CHARS)
    const newChars = newFiles.reduce((n, f) => n + f.text.length, 0)
    const model = review ? (process.env.LORE_MODEL ?? MODEL) : pickModel(batches.length, Object.values(artifacts).reduce((n, a) => n + a.length, 0), process.env, newChars)
    console.log(review ? `review fold over current artifacts [${llm}:${model}]…` : `extracting from ${newFiles.length} stream file(s) in ${batches.length} batch(es) [${llm}:${model}]…`)

    let contradictions: FoldResult['contradictions'] = []
    /** Everything this fold changed, for the status summary. */
    const foldChanges: string[] = []
    mkdirSync(join(root, 'context/derived'), { recursive: true })
    const sowNote = commitmentsNote(root)
    const clientNote = config.client
      ? `\n\n# Client\n${config.client.name}${config.client.domains.length ? ` — people with emails at ${config.client.domains.join(', ')} are the client` : ''}${
          config.client.contacts.length
            ? `\nKnown people: ${config.client.contacts.map((c) => `${c.name} <${[c.email, ...(c.aliases ?? [])].join(', ')}>${c.role ? ` (${c.role})` : ''} [${c.side}]`).join('; ')}`
            : ''
        }\nAttribute requests and decisions to the client side vs the team accordingly.`
      : ''
    const commitments = sowNote ? `\n\n# Commitments (statements of work — authoritative, human-attached)\n${sowNote}\nWhere an SOW names scope items, note in a request's text whether it falls inside or outside them; never invent budget figures.` : ''
    const prefix = workPrefix(config)
    const workItems = readWorkItems(root, prefix)
    for (let i = 0; i < batches.length; i++) {
      const workNote = `\n\n# Tracked work (lore tracker ${prefix}: key | rank | status | priority | assignee | title | external tracker state)\n${workItems.length ? describeWorkForPrompt(workItems, today) : '(no tickets yet)'}`
      const user = `Today is ${today}.${clientNote}${commitments}${workNote}\n\n# Current artifacts\n${Object.entries(artifacts)
        .map(([name, items]) => `## ${name}\n${stringify(items)}`)
        .join('\n')}\n\n# Pinned facts\n${pins}\n\n# New material\n${batches[i].text}`
      const result = await withRetry(() => (llm === 'sdk' ? sdkFold(model, user) : Promise.resolve(cliFold(model, user))), 2, (attempt, err) =>
        console.warn(`  ⚠ batch ${i + 1} attempt ${attempt} failed (${err instanceof Error ? err.message : err}) — retrying`),
      )
      const changes: string[] = []
      for (const name of wantArtifacts) {
        const merged = acceptFold(name, artifacts[name], (result as unknown as Record<string, unknown[]>)[name])
        if (merged.rejected) console.warn(`  ⚠ ${name}: model ${merged.rejected}`)
        if (merged.added || merged.updated) changes.push(`${name} +${merged.added}/~${merged.updated}`)
        for (const item of (result as unknown as Record<string, unknown[]>)[name] ?? []) foldChanges.push(`${name}: ${JSON.stringify(item)}`)
        artifacts[name] = merged.items
      }
      contradictions = result.contradictions
      if (workItems.length > 0 || (result.work_changes?.length ?? 0) > 0) {
        const at = new Date().toISOString()
        const w = applyFoldChanges(workItems, result.work_changes, at)
        if (w.applied.length > 0) {
          writeWorkItems(root, prefix, workItems)
          for (const line of w.applied) {
            foldChanges.push(`ticket ${line}`)
            const key = line.slice(0, line.indexOf(':'))
            const proposal = (result.work_changes ?? []).find((c) => c.key?.toUpperCase() === key.toUpperCase())
            appendAudit(root, { at, action: 'work', actor: 'lore-extract', via: 'fold', id: key, ...(proposal?.sources?.[0] ? { source: proposal.sources[0] } : {}) })
            console.log(`  work: ${line}`)
          }
          changes.push(`work ~${w.applied.length}`)
        }
        for (const line of w.skipped) if (!/: no change$/.test(line)) console.log(`  work skipped: ${line}`)
      }
      {
        const at = new Date().toISOString()
        const c = applyFoldCreations(workItems, prefix, result.work_new, at)
        if (c.created.length > 0) {
          writeWorkItems(root, prefix, workItems)
          for (const line of c.created) {
            foldChanges.push(`new ticket ${line}`)
            const key = line.slice(0, line.indexOf(':'))
            const proposal = (result.work_new ?? []).find((n) => line.startsWith(`${key}: "${n.title?.trim()}"`))
            appendAudit(root, { at, action: 'work', actor: 'lore-extract', via: 'fold', id: key, ...(proposal?.sources?.[0] ? { source: proposal.sources[0] } : {}) })
            console.log(`  work: new ${line}`)
          }
          changes.push(`work +${c.created.length}`)
        }
        for (const line of c.skipped) console.log(`  work not created: ${line}`)
      }
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
      updateState(root, { extracted: state.extracted })
      console.log(
        `  batch ${i + 1}/${batches.length}: ${wantArtifacts.map((n) => `${artifacts[n].length} ${n}`).join(', ')}${changes.length ? ` (${changes.join(', ')})` : ' (no changes)'}`,
      )
    }

    if (foldChanges.length > 0) {
      // The status summary: a light call on the incremental model, only when
      // the fold changed something. A failure keeps the previous summary.
      const summaryModel = process.env.LORE_MODEL_INCREMENTAL ?? MODEL_INCREMENTAL
      try {
        const input = statusSummaryInput(root, config, today, foldChanges.slice(0, 60))
        const summary = llm === 'sdk' ? await sdkText(summaryModel, STATUS_SUMMARY_SYSTEM, input) : cliCall(summaryModel, STATUS_SUMMARY_SYSTEM, input)
        writeStatus(root, config, { summary: summary.trim(), summaryAt: new Date().toISOString() })
        console.log(`status: summary written [${llm}:${summaryModel}]`)
      } catch (err) {
        console.warn(`  ⚠ status summary failed (${err instanceof Error ? err.message : err}) — kept the previous one`)
      }
    }

    if (contradictions.length > 0) {
      writeFileSync(join(root, 'context/derived/contradictions.yaml'), stringify(contradictions))
      console.warn(
        `⚠ ${contradictions.length} pinned fact(s) contradicted by fresh evidence — see derived/contradictions.yaml`,
      )
    }
  } else if (wantArtifacts.length > 0 && !gated) {
    console.log('no new stream material since last extract')
  }

  if (reportDue) {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
    const week = streamFiles(root).filter((f) => f.day >= weekAgo)
    if (week.length === 0) {
      console.log('weekly report: no material this week')
    } else {
      const artifactContext = ARTIFACTS.map((n) => `## ${n}\n${readRaw(root, `context/derived/${n}.yaml`)}`).join('\n')
      const sowNote = commitmentsNote(root)
      const reportItems = readWorkItems(root, workPrefix(config))
      const workNote = reportItems.length
        ? `\n\n# Tracked work (lore tracker — the tracker of record; open items and recent closes)\n${describeWorkForPrompt(reportItems, today)}\n\n## Work moved this week\n${describeWorkHistory(reportItems, weekAgo) || '(nothing moved)'}`
        : ''
      const user = `Today is ${today}.${sowNote ? `\n\n# Commitments (statements of work)\n${sowNote}` : ''}${workNote}\n\n# Tracked artifacts\n${artifactContext}\n\n# This week's raw material\n${week
        .map((f) => reportExcerpt(f))
        .join('\n\n')}`
      const report = llm === 'sdk' ? await sdkText(MODEL, REPORT_SYSTEM, user) : cliCall(MODEL, REPORT_SYSTEM, user)
      mkdirSync(join(root, 'context/derived/reports'), { recursive: true })
      writeFileSync(join(root, `context/derived/reports/${today}.md`), report.trim() + '\n')
      console.log(`wrote derived/reports/${today}.md`)
    }
  }

  // The list half of status.md follows whatever the fold (or anything since) did to the tracker and artifacts.
  if (wantArtifacts.length > 0) writeStatus(root, config)

  updateState(root, { extracted: state.extracted, lastExtract: new Date().toISOString() })
}

/**
 * Ask the gate whether this hour's material is worth an incremental fold.
 * Only the incremental path is gated — a backfill, a re-fold, a new source,
 * an attached document or an empty tracker always folds. On a skip the
 * files are marked consumed, exactly as a fold that found nothing would.
 * Any gate failure folds.
 */
async function gateSkips(root: string, config: ReturnType<typeof loadConfig>, state: ReturnType<typeof loadState>, newFiles: StreamFile[], today: string): Promise<boolean> {
  const gate = gateConfig()
  if (!gate) return false
  const newChars = newFiles.reduce((n, f) => n + f.text.length, 0)
  const existing = ARTIFACTS.reduce((n, a) => n + readYamlList(root, `context/derived/${a}.yaml`).length, 0)
  if (!isIncremental(pack(newFiles, BATCH_CHARS).length, existing, newChars) || newFiles.some((f) => alwaysFolds(f.path))) return false
  try {
    const items = readWorkItems(root, workPrefix(config))
    const r = await runGate(
      {
        material: newFiles.map((f) => ({ path: f.path, text: newPart(f.text, state.extracted?.[f.path]) })),
        trackedWork: describeWorkForPrompt(items, today),
        pins: readRaw(root, 'context/facts.yaml'),
      },
      gate,
    )
    const why = `${r.top.question} p=${r.top.p.toFixed(2)}, threshold ${gate.threshold}; ${r.inputTokens} tokens`
    if (r.fold) {
      console.log(`gate: folding — ${why}`)
      return false
    }
    for (const f of newFiles) state.extracted![f.path] = f.text.length
    updateState(root, { extracted: state.extracted })
    console.log(`gate: nothing to fold in ${newFiles.length} stream file(s) — ${why} [jev]`)
    return true
  } catch (err) {
    console.warn(`  ⚠ gate failed (${err instanceof Error ? err.message : err}) — folding`)
    return false
  }
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

/**
 * Which model folds this run. Incremental = one batch of new material onto
 * artifacts that already exist; everything else (a first fold, a multi-batch
 * backfill or re-fold) is the full model. Exported for tests; env-overridable
 * so a host can pin either side.
 */
export function pickModel(batchCount: number, existingItems: number, env: NodeJS.ProcessEnv = process.env, newChars = 0): string {
  const full = env.LORE_MODEL ?? MODEL
  const incremental = env.LORE_MODEL_INCREMENTAL ?? MODEL_INCREMENTAL
  return isIncremental(batchCount, existingItems, newChars) ? incremental : full
}

/** One small batch of new material onto artifacts that already exist — the hourly delta, not a backfill. */
export function isIncremental(batchCount: number, existingItems: number, newChars: number): boolean {
  return batchCount === 1 && existingItems > 0 && newChars <= INCREMENTAL_MAX_CHARS
}

/** `claude -p --model` takes a family alias; map a model id onto one. */
export function cliModelAlias(model: string): string {
  if (/haiku/.test(model)) return 'haiku'
  if (/sonnet/.test(model)) return 'sonnet'
  return 'opus'
}

// ---- sdk backend: Claude API with structured outputs ----

async function sdkFold(model: string, user: string): Promise<FoldResult> {
  const text = await sdkText(model, FOLD_SYSTEM, user, FOLD_SCHEMA)
  return JSON.parse(text) as FoldResult
}

async function sdkText(model: string, system: string, user: string, schema?: Record<string, unknown>): Promise<string> {
  const client = new Anthropic()
  const stream = client.messages.stream({
    model,
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

function cliFold(model: string, user: string): FoldResult {
  const instruction = `\n\nRespond with ONLY a JSON object matching this schema — no prose, no code fences:\n${JSON.stringify(FOLD_SCHEMA)}`
  return parseFoldOutput(cliCall(model, FOLD_SYSTEM + instruction, user))
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
 * Merge a fold delta into the artifacts. The model returns only new or
 * changed items; every existing item it omits is kept verbatim, an existing
 * id it returns is replaced by the returned version, and new ids are
 * appended. Omission is therefore the normal case, not a defect — only a
 * missing or malformed array is reported. Returns what to store plus counts
 * for the log.
 */
export function acceptFold(
  name: string,
  previous: unknown[],
  proposed: unknown[] | undefined,
): { items: unknown[]; added: number; updated: number; rejected?: string } {
  if (!Array.isArray(proposed)) return { items: previous, added: 0, updated: 0, rejected: `no "${name}" array` }
  const idOf = (i: unknown) => (i as { id?: string }).id
  const proposedById = new Map<string, unknown>()
  for (const item of proposed) {
    const id = idOf(item)
    if (id) proposedById.set(id, item)
  }
  const merged: unknown[] = []
  const seen = new Set<string>()
  let updated = 0
  for (const item of previous) {
    const id = idOf(item)
    if (id && proposedById.has(id)) {
      const next = proposedById.get(id)
      if (JSON.stringify(next) !== JSON.stringify(item)) updated++
      merged.push(next)
      seen.add(id)
    } else {
      merged.push(item)
    }
  }
  let added = 0
  for (const item of proposed) {
    const id = idOf(item)
    if (!id || !seen.has(id)) {
      merged.push(item)
      added++
      if (id) seen.add(id)
    }
  }
  return { items: merged, added, updated }
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
  if (!Array.isArray(obj.work_changes)) obj.work_changes = []
  if (!Array.isArray(obj.work_new)) obj.work_new = []
  return obj as unknown as FoldResult
}

function cliCall(model: string, system: string, user: string): string {
  // Prompt over stdin: batches are far larger than argv allows.
  const out = execFileSync('claude', ['-p', '--output-format', 'json', '--model', cliModelAlias(model)], {
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

/**
 * Group files into batches under `budget` chars. A day-file is kept whole
 * when it fits; one bigger than the budget on its own — a 400-page spec in
 * the docs stream, a huge mail day — is split at paragraph breaks into
 * parts, each carrying the stream heading it continues so the model still
 * knows who sent it and what to cite. The file is recorded as consumed only
 * in the batch holding its last part, so a fold killed midway refolds it.
 */
export function pack(files: Pick<StreamFile, 'day' | 'text'>[] & Partial<StreamFile>[], budget: number): Batch[] {
  const batches: Batch[] = []
  let current = ''
  let lastDay = ''
  let members: Batch['files'] = []
  const flush = () => {
    if (current) batches.push({ text: current, lastDay, files: members })
    current = ''
    members = []
  }
  for (const f of files) {
    if (f.text.length > budget) {
      flush()
      const parts = splitDoc(f.text, budget)
      for (let i = 0; i < parts.length; i++) {
        batches.push({ text: parts[i] + '\n\n', lastDay: f.day, files: i === parts.length - 1 ? [{ path: f.path ?? '', length: f.text.length }] : [] })
      }
      continue
    }
    if (current && current.length + f.text.length > budget) flush()
    current += f.text + '\n\n'
    lastDay = f.day
    members.push({ path: f.path ?? '', length: f.text.length })
  }
  flush()
  return batches
}

/** Cut a stream file into ≤budget parts at blank lines; parts after the first restate the heading they continue. */
export function splitDoc(text: string, budget: number): string[] {
  const parts: string[] = []
  let rest = text
  let heading = ''
  while (rest.length > budget) {
    let cut = rest.lastIndexOf('\n\n', budget)
    if (cut < budget / 4) cut = rest.lastIndexOf('\n', budget)
    if (cut < budget / 4) cut = budget
    const part = rest.slice(0, cut)
    heading = lastHeading(part) ?? heading
    parts.push(part)
    rest = rest.slice(cut).replace(/^\n+/, '')
    if (rest) rest = `${heading ? `${heading}\n\n` : ''}(…continued)\n\n${rest}`
  }
  if (rest) parts.push(rest)
  return parts
}

/** The last stream heading block in a part: `### who — when`, its id comment, and the permalink line if any. */
function lastHeading(part: string): string | undefined {
  const m = [...part.matchAll(/^### [^\n]+\n<!-- id: [^\n]*-->\n(?:\[permalink\]\([^\n]*\)\n)?/gm)].pop()
  return m?.[0].trimEnd()
}

/** What the weekly report sees of a stream file: everything, except documents beyond REPORT_DOC_CHARS. */
export function reportExcerpt(f: StreamFile, limit = REPORT_DOC_CHARS): string {
  if (!/^context\/streams\/(docs|figma)\//.test(f.path) || f.text.length <= limit) return f.text
  return `${f.text.slice(0, limit)}\n\n[… document truncated for the report: ${(f.text.length - limit).toLocaleString()} more characters in ${f.path}]`
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

/** Active SOWs as precomputed lines for the prompts; empty when none. */
function commitmentsNote(root: string): string {
  return describeSows(readSows(root).map((s) => summarizeSow(s)))
}
