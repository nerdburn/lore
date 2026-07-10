/**
 * LLM extraction fold: streams/ + derived/ → updated derived/. (SPEC §5)
 *
 * Not implemented yet. The contract, when it lands:
 * - Input: current artifact + only stream docs since state.lastExtract + today's date
 * - Update, don't rewrite: preserve item ids and wording unless evidence changes them
 * - Every new/changed item cites source permalinks
 * - Old unresolved requests → status "stale", never "open"
 * - Compare pins in facts.yaml against fresh derived data → contradictions report
 * - No network except the LLM API (connectors never run here)
 */
export async function extract(_root: string): Promise<void> {
  console.error('lore extract: not implemented yet — see SPEC §5 and the M2 milestone')
  process.exitCode = 1
}
