import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { backfillSince, loadConfig, resolveEnvRefs } from '../config.js'
import { connectors } from '../connectors/index.js'
import { loadState, saveState, type SourceHealth } from '../state.js'
import { writeDocs } from '../streams.js'
import { totalRedactions } from '../scrub.js'
import type { Connector } from '../types.js'

/** Connector-supplied paths must stay inside context/. */
function safeRel(rel: string): string {
  const n = normalize(rel)
  if (n.startsWith('..') || !n.startsWith('context')) throw new Error(`connector file path must be inside context/: ${rel}`)
  return n
}

export interface SyncSummary {
  /** False when any enabled source failed or reported errors. */
  ok: boolean
  sources: Record<string, { status: 'ok' | 'failed' | 'disabled'; written: number; errors: string[] }>
}

/**
 * Deterministic sync: connectors → context/streams/. No LLM involved.
 * Backfill is just cursor seeding, per channel: any channel without a
 * cursor — first sync or newly whitelisted — starts at now minus the
 * configured backfill months; after that, cursors rule. To re-backfill a
 * channel, delete its cursor from state.json.
 *
 * Failure model: every enabled source must succeed for the run to succeed.
 * A source with no connector, unresolved env, a thrown fetch, or connector-
 * reported errors marks the run failed (non-zero exit) — but sources that
 * did succeed still keep their docs and cursors, and health for every
 * source is recorded in state.json. Only `"disabled": true` skips a source
 * quietly.
 */
export async function sync(root: string, registry: Record<string, Connector> = connectors): Promise<SyncSummary> {
  const config = loadConfig(root)
  const summary: SyncSummary = { ok: true, sources: {} }
  if (config.lifecycle === 'archived') {
    console.log(`${config.project} is archived — nothing to sync`)
    return summary
  }
  const state = loadState(root)
  state.sources ??= {}

  for (const [name, rawSourceConfig] of Object.entries(config.sources)) {
    if (rawSourceConfig.disabled) {
      console.log(`${name}: disabled — skipped`)
      summary.sources[name] = { status: 'disabled', written: 0, errors: [] }
      continue
    }

    const now = new Date().toISOString()
    const health: SourceHealth = { ...state.sources[name], lastAttempt: now }
    const errors: string[] = []
    let written = 0

    const connector = registry[name]
    const { resolved, missing } = resolveEnvRefs(rawSourceConfig)
    if (!connector) {
      errors.push(`no such connector "${name}" (available: ${Object.keys(registry).join(', ')})`)
    } else if (missing.length > 0) {
      errors.push(`missing env vars: ${missing.join(', ')}`)
    } else {
      const since = backfillSince(config, name)
      console.log(`syncing ${name} (new channels since ${new Date(since).toISOString().slice(0, 10)})…`)
      try {
        const result = await connector.fetch({
          config: resolved,
          cursor: state.cursors[name] ?? {},
          since,
          log: (msg) => console.log(`  ${msg}`),
          readFile: (rel) => {
            const path = join(root, safeRel(rel))
            return existsSync(path) ? readFileSync(path, 'utf8') : undefined
          },
        })
        const w = writeDocs(root, result.docs)
        for (const [rel, content] of Object.entries(result.files ?? {})) {
          const path = join(root, safeRel(rel))
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, content)
        }
        written = w.written
        state.cursors[name] = result.nextCursor
        errors.push(...(result.errors ?? []))
        const scrubbed = totalRedactions(w.redacted)
        console.log(
          `${name}: ${w.written} new docs${w.skipped ? `, ${w.skipped} already synced` : ''}${scrubbed ? `, ${scrubbed} secret(s) redacted` : ''}`,
        )
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }

    if (errors.length === 0) {
      health.lastSuccess = now
      delete health.lastError
      summary.sources[name] = { status: 'ok', written, errors }
    } else {
      health.lastError = { at: now, message: errors.join('; ') }
      summary.sources[name] = { status: 'failed', written, errors }
      summary.ok = false
      for (const e of errors) console.error(`✗ ${name}: ${e}`)
    }
    state.sources[name] = health
  }

  state.lastSync = new Date().toISOString()
  saveState(root, state)

  if (!summary.ok) {
    const failed = Object.entries(summary.sources)
      .filter(([, s]) => s.status === 'failed')
      .map(([n]) => n)
    console.error(`sync failed: ${failed.join(', ')} — see state.json sources for details`)
  }
  return summary
}
