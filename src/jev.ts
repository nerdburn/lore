/** Shared TypeSafe Jev client for Load screening and PR matching. */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = process.env.LORE_JEV_MODEL ?? 'jev-latest'
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
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`jev: invalid answer for ${id}`)
    answers[id] = p
  }
  return { answers, inputTokens: body.usage?.input_tokens ?? 0 }
}

