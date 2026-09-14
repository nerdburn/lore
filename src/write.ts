import { userInfo } from 'node:os'
import type { ResolvedContext } from './context.js'

export interface WriteGateOptions {
  /** CLI only: who authorized this. MCP callers can never set it. */
  by?: string
  via?: 'cli' | 'mcp'
}

/**
 * The gate every explicit write (`remember`, `sow add`, `doc add`) passes:
 * an archived client is read-only, and when lore.json has `write.allow` the
 * actor must be listed. The actor is the OS identity, or `--by` on the CLI —
 * an honesty check on a shared machine, not authentication. Returns the
 * actor to record in the audit log; `noun` names the refused thing.
 */
export function authorizeWrite(ctx: ResolvedContext, opts: WriteGateOptions, noun: string): string {
  if (ctx.config.lifecycle === 'archived') {
    throw new Error(`${ctx.config.project} is archived — its memory is read-only (\`lore archive --restore\` to reopen)`)
  }
  const via = opts.via ?? 'cli'
  const actor = via === 'cli' && opts.by ? opts.by : userInfo().username
  const allow = ctx.config.write?.allow
  if (allow && !allow.includes(actor)) throw new Error(`"${actor}" is not in lore.json write.allow — ${noun} refused`)
  return actor
}
