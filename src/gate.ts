import { splitDoc } from './commands/extract.js'

/**
 * The fold gate: a fast, cheap check on new material before an incremental
 * fold, so an hour of chatter doesn't wake the fold model to return empty
 * arrays.
 *
 * It asks TypeSafe's Jev (a System One model — typed judgments with
 * calibrated probabilities, no generated text) a handful of yes/no questions
 * over the new material: does anyone ask for something, decide something,
 * plan something, report progress on work, or contradict a pinned fact?
 * Those are exactly the things the fold can turn into an artifact or a
 * ticket move. If every probability is under the threshold the fold is
 * skipped and the material is marked consumed; otherwise the fold runs as
 * before. Jev only decides *whether* to fold — ids, wording, reasons and
 * permalinks still come from the fold model.
 *
 * Fails open: no key, an API error, or a timeout means the fold runs.
 * Enabled when TYPESAFE_API_KEY is set; LORE_GATE=off disables it;
 * LORE_GATE_THRESHOLD overrides the threshold. `lore gate replay` measures
 * a threshold against a context repo's own fold history before trusting it.
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = process.env.LORE_JEV_MODEL ?? 'jev-latest'
/** Low on purpose: a wasted fold costs a Sonnet call, a skipped real one loses an artifact. */
export const DEFAULT_GATE_THRESHOLD = 0.3
/** Jev takes 32k tokens of state + question; ~4 chars a token leaves room for the tracked work and pins alongside. */
const MATERIAL_CHARS = 60_000
const CONTEXT_CHARS = 16_000
const TIMEOUT_MS = 20_000

export type Fetch = typeof fetch

export interface NoulQuestion {
  type: 'noul'
  instructions: string | Record<string, unknown>
  criteria?: { true: string; false: string }
}

/** One Jev call; returns each question's probability of "yes". */
export async function jevNouls(
  state: unknown,
  questions: Record<string, NoulQuestion>,
  opts: { apiKey: string; fetch?: Fetch; model?: string },
): Promise<{ answers: Record<string, number>; inputTokens: number }> {
  const res = await (opts.fetch ?? fetch)(JEV_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model ?? JEV_MODEL, state, questions }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`jev: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { answers?: Record<string, { noul?: number }>; usage?: { input_tokens?: number } }
  const answers: Record<string, number> = {}
  for (const id of Object.keys(questions)) {
    const p = body.answers?.[id]?.noul
    if (typeof p !== 'number') throw new Error(`jev: no answer for ${id}`)
    answers[id] = p
  }
  return { answers, inputTokens: body.usage?.input_tokens ?? 0 }
}

/** The things a fold can act on — one question each, all asked over the same state in one call. */
export function gateQuestions(hasPins: boolean): Record<string, NoulQuestion> {
  const q: Record<string, NoulQuestion> = {
    ask: {
      type: 'noul',
      instructions: 'Does anyone in `material` ask for work to be done: a feature, a change, a fix, a deliverable, or information the team must produce?',
      criteria: { true: 'At least one message makes such an ask, even briefly or politely.', false: 'No one asks for any work, change, fix or deliverable.' },
    },
    decision: {
      type: 'noul',
      instructions: 'Does anyone in `material` make or confirm a decision about the project: approving, choosing, rejecting, or settling scope, design, timing, or approach?',
      criteria: { true: 'A decision is made or confirmed.', false: 'No decision is made or confirmed.' },
    },
    plan: {
      type: 'noul',
      instructions: 'Does `material` describe planned or scheduled work, a timeline or deadline, or someone committing to do something?',
      criteria: { true: 'There is a plan, schedule, deadline, or commitment to do work.', false: 'Nothing is planned, scheduled, or committed.' },
    },
    progress: {
      type: 'noul',
      instructions: 'Does `material` report the state of any piece of work — started, in progress, merged, shipped, done, blocked, deferred, re-prioritised — including any item listed in `tracked_work`?',
      criteria: { true: 'Some piece of work changes or reports its state.', false: 'No work reports or changes state.' },
    },
  }
  if (hasPins) {
    q.contradiction = {
      type: 'noul',
      instructions: 'Does anything in `material` contradict one of the facts in `pinned_facts`?',
      criteria: { true: 'Something in the material conflicts with a pinned fact.', false: 'Nothing conflicts with the pinned facts.' },
    }
  }
  return q
}

export interface GateInput {
  /** Only what is new since the last fold, per file. */
  material: { path: string; text: string }[]
  /** Open ticket titles (describeWorkForPrompt lines). */
  trackedWork: string
  pins: string
}

export interface GateResult {
  fold: boolean
  /** Highest probability per question across chunks. */
  max: Record<string, number>
  top: { question: string; p: number }
  chunks: number
  inputTokens: number
}

/** The new part of an append-only day-file: everything after what the fold already consumed. */
export function newPart(text: string, consumed: number | undefined): string {
  return consumed !== undefined && consumed < text.length ? text.slice(consumed) : text
}

export async function runGate(input: GateInput, opts: { apiKey: string; threshold?: number; fetch?: Fetch }): Promise<GateResult> {
  const threshold = opts.threshold ?? DEFAULT_GATE_THRESHOLD
  const joined = input.material.map((m) => `## ${m.path}\n${m.text}`).join('\n\n')
  const chunks = joined.length > MATERIAL_CHARS ? splitDoc(joined, MATERIAL_CHARS) : [joined]
  const pins = input.pins.trim() && input.pins.trim() !== '[]' ? input.pins.slice(0, CONTEXT_CHARS / 2) : ''
  const questions = gateQuestions(pins !== '')
  const results = await Promise.all(
    chunks.map((material) =>
      jevNouls({ material, tracked_work: input.trackedWork.slice(0, CONTEXT_CHARS) || '(none)', ...(pins ? { pinned_facts: pins } : {}) }, questions, opts),
    ),
  )
  const max: Record<string, number> = {}
  for (const r of results) for (const [q, p] of Object.entries(r.answers)) max[q] = Math.max(max[q] ?? 0, p)
  const [question, p] = Object.entries(max).sort((a, b) => b[1] - a[1])[0] ?? ['none', 0]
  return { fold: p >= threshold, max, top: { question, p }, chunks: chunks.length, inputTokens: results.reduce((n, r) => n + r.inputTokens, 0) }
}

/** The gate's config from the environment; undefined when it is off. */
export function gateConfig(env: NodeJS.ProcessEnv = process.env): { apiKey: string; threshold: number } | undefined {
  if (!env.TYPESAFE_API_KEY || env.LORE_GATE === 'off') return undefined
  const t = Number(env.LORE_GATE_THRESHOLD)
  return { apiKey: env.TYPESAFE_API_KEY, threshold: Number.isFinite(t) && t > 0 && t < 1 ? t : DEFAULT_GATE_THRESHOLD }
}

/** Documents (the docs stream) are sent on purpose and always fold. */
export function alwaysFolds(path: string): boolean {
  return /^context\/streams\/docs\//.test(path)
}
