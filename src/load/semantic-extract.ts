import { join } from 'node:path'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { configSchema } from '../config.js'
import { structuredCompletion } from '../commands/extract.js'
import { acquireLock, tryLock } from '../lock.js'
import { readLoadInputs } from './inputs.js'
import { buildLoad } from './build.js'
import { optionalLoad, saveLoad } from './store.js'
import { acceptSemantic, SEMANTIC_HOLD_RUNS, type SemanticRejections, emptySemantic, semanticChunks, semanticPrompt, SEMANTIC_OUTPUT_SCHEMA, SEMANTIC_SYSTEM } from './semantic-events.js'
import type { SemanticState } from './schema.js'
import { checkpointMatches, irrelevant, screenChunks, skippedCheckpoint, type ScreenOptions } from './gate.js'

export interface SemanticExtractOptions {
  maxBatches?: number
  complete?: typeof structuredCompletion
  log?: (message: string) => void
  screening?: ScreenOptions
  metrics?: (value: Record<string, unknown>) => void
}

/** Dedicated writer; checkpoint and events publish together after EVERY validated batch.
 * No tracker/summary mutations, source API calls, or dependence on state.extracted.
 * Only the short publication section shares the source projection's lock.
 */
export async function extractSemanticLoad(root: string, opts: SemanticExtractOptions = {}) {
  const lock = tryLock(join(root, '.load-semantic.lock'))
  if (!lock) throw new Error('load: semantic extraction is already running for this context')
  const log = opts.log ?? console.log
  let completed = 0
  try {
    const input = readLoadInputs(root)
    const config = configSchema.parse(JSON.parse(input.files.get('lore.json') ?? '{}'))
    if (!config.load?.semantic?.enabled) throw new Error('Enable load.semantic.enabled in committed lore.json before extracting semantic activity.')
    if (config.lifecycle === 'archived') throw new Error('load: archived contexts cannot extract semantic activity')
    const maxBatches = opts.maxBatches ?? config.load.semantic.max_batches
    if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) throw new Error('load: max batches must be an integer from 1 to 100')
    let state = optionalLoad(root)?.semantic ?? emptySemantic()
    const pending = semanticChunks(input, config).filter(c => !checkpointMatches(c.hash, state.checkpoints[c.key], config))
    log(`load: ${pending.length} pending semantic chunks; at most ${maxBatches} batches this run`)
    for (let offset = 0; offset < pending.length && completed < maxBatches;) {
      const batch = [] as typeof pending
      let chars = 0
      while (offset < pending.length && (batch.length === 0 || chars + pending[offset].text.length <= 30000) && batch.length < 80) {
        const chunk = pending[offset++]; batch.push(chunk); chars += chunk.text.length
      }
      const gate = config.load?.semantic?.gate
      const screening = gate && gate.mode !== 'off' ? await screenChunks(batch, { apiKey: process.env.TYPESAFE_API_KEY, log, ...opts.screening }) : undefined
      const negatives = new Set(batch.filter(c => irrelevant(screening?.judgments.get(c.key), gate?.threshold ?? 0.1)).map(c => c.key))
      // Keep every overlapping chunk of a document if any chunk has signal or could not be judged.
      const retainedDocs = new Set(batch.filter(c => !negatives.has(c.key) || c.doc.text.length > 10000).map(c => `${c.source}:${c.doc.fields.id}`))
      const wouldSkip = batch.filter(c => negatives.has(c.key) && !retainedDocs.has(`${c.source}:${c.doc.fields.id}`))
      const wouldSkipKeys = new Set(wouldSkip.map(c => c.key))
      const skipped = gate?.mode === 'filter' ? wouldSkip : []
      const kept = batch.filter(c => !skipped.includes(c))
      const prompt = semanticPrompt(config, kept, state)
      let attempts = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, usageReported = 0, shadowMisses = 0
      let next: SemanticState | undefined
      let validationFailure = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!kept.length) { next = structuredClone(state); next.lastSuccess = new Date().toISOString(); delete next.error; break }
        attempts++
        const response = await (opts.complete ?? structuredCompletion)(SEMANTIC_SYSTEM, prompt.user + (validationFailure
          ? `\nYour previous response failed validation: ${validationFailure}. Return a corrected complete batch. Copy evidence quotes exactly from their stated chunks; omit unsupported proposals.` : ''), SEMANTIC_OUTPUT_SCHEMA)
        if (response.usage) { usageReported++; inputTokens += response.usage.inputTokens; outputTokens += response.usage.outputTokens; cacheReadTokens += response.usage.cacheReadTokens; cacheWriteTokens += response.usage.cacheWriteTokens }
        try {
          if (attempt === 0) next = acceptSemantic(state, kept, response.value, response.model, prompt.catalog)
          else {
            // The corrected retry still has unsupported proposals: keep the
            // rest of the batch and leave the chunks they cited pending,
            // rather than failing the project and redoing the whole batch.
            const rejections: SemanticRejections = { dropped: [], held: [] }
            next = acceptSemantic(state, kept, response.value, response.model, prompt.catalog, rejections)
            if (rejections.dropped.length) log(`load: dropped ${rejections.dropped.length} unsupported proposal(s) (${[...new Set(rejections.dropped.map(d => d.reason.replace(/^load: /, '')))].join('; ')}); ${rejections.held.length - (rejections.gaveUp?.length ?? 0)} chunk(s) left pending for a later run`)
            if (rejections.gaveUp?.length) log(`load: gave up on ${rejections.gaveUp.join(', ')} after ${SEMANTIC_HOLD_RUNS} runs of unsupported proposals; checkpointed without them`)
          }
          const proposals = response.value as { events: Array<{ evidence: Array<{ chunk: string }> }> }
          shadowMisses = proposals.events.filter(e => e.evidence.every(ref => wouldSkipKeys.has(ref.chunk))).length
          break
        }
        catch (error) {
          if (attempt === 1) throw error
          validationFailure = error instanceof Error ? error.message.slice(0, 300) : 'invalid output'
          log('load: semantic output failed evidence/schema validation; retrying once without advancing its checkpoint')
        }
      }
      if (!next) throw new Error('load: semantic batch produced no valid response')
      for (const c of skipped) next.checkpoints[c.key] = skippedCheckpoint(c.hash, config)
      await publishSemantic(root, next)
      const metric = { at: new Date().toISOString(), project: config.project, mode: gate?.mode ?? 'off', chunks: batch.length,
        wouldSkip: wouldSkip.length, skipped: skipped.length, retained: kept.length, shadowMisses,
        jevInputTokens: screening?.inputTokens ?? 0, jevCalls: screening?.calls ?? 0, cacheHits: screening?.cacheHits ?? 0, jevFailed: screening?.failed ?? 0,
        claudeCalls: attempts, usageReported, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
        promptChars: kept.length ? SEMANTIC_SYSTEM.length + prompt.user.length : 0, skippedSourceChars: skipped.reduce((n, c) => n + c.text.length, 0) }
      try { (opts.metrics ?? recordMetrics)(metric) } catch { log('load: usage metrics could not be saved') }
      if (screening) log(`load: Jev ${gate!.mode}, ${negatives.size}/${batch.length} low-signal, ${skipped.length} skipped, ${shadowMisses} shadow event misses, ${screening.cacheHits} cache hits`)
      state = next
      completed++
      log(`load: semantic batch ${completed}, ${batch.length} chunks, ${state.records.length} distinct proposed events`)
    }
    // Even an empty run refreshes materialized roles/coverage from current committed evidence.
    if (!completed) await publishSemantic(root, state)
    return { completedBatches: completed, snapshot: optionalLoad(root)! }
  } catch (error) {
    // Persist health without consuming failed chunks; successful earlier batches survive.
    const state = structuredClone(optionalLoad(root)?.semantic ?? emptySemantic())
    state.error = `Semantic extraction failed; unprocessed evidence remains pending (${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}).`
    await publishSemantic(root, state)
    throw error
  } finally { lock.release() }
}

function recordMetrics(value: Record<string, unknown>) {
  const dir = process.env.LORE_LOAD_METRICS_DIR ?? join(homedir(), '.lore', 'load-metrics')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'usage.jsonl')
  try { if (statSync(path).size > 5 * 1024 * 1024) renameSync(path, `${path}.previous`) } catch { /* first use */ }
  appendFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 })
}

async function publishSemantic(root: string, semantic: SemanticState) {
  const lock = await acquireLock(join(root, '.load.lock'), 30000, 100)
  try {
    // Sync may have advanced while the model ran. Build the complete envelope
    // from the latest coherent revision; changed chunks remain pending by digest.
    saveLoad(root, buildLoad(root, readLoadInputs(root), semantic))
  } finally { lock.release() }
}
