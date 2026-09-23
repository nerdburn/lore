import { userInfo } from 'node:os'
import type { ResolvedContext } from './context.js'

export interface WriteGateOptions {
  /** CLI only: who authorized this. MCP callers can never set it. */
  by?: string
  via?: 'cli' | 'mcp' | 'web'
  /**
   * Hosted MCP only: the caller the platform vouched for (the peer VM named
   * in X-Exedev-Source-Vm), set by the server from the request — never from
   * tool input. Wins over the OS identity, which on the host is always the
   * service user.
   */
  actor?: string
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
  const actor = opts.actor ?? (via === 'cli' && opts.by ? opts.by : userInfo().username)
  // The board checks its own roles (lore.json `board.members`) before it
  // writes, so `write.allow` — which names OS users and agents — does not
  // apply to a signed-in email.
  const allow = via === 'web' ? undefined : ctx.config.write?.allow
  if (allow && !allow.includes(actor)) throw new Error(`"${actor}" is not in lore.json write.allow — ${noun} refused`)
  return actor
}
