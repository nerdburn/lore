import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loreHome } from './context.js'
import { createSendMail, emailConfigFromEnv, type MailMessage } from './board/email.js'
import { esc } from './markdown.js'

/**
 * Subscription limits and lost logins on the claude CLI backend. When
 * `claude -p` reports a usage limit (weekly, daily, five-hour) or that it can
 * no longer authenticate (an expired OAuth session or setup-token, a logout),
 * the rest of this process calls the Claude API with
 * LORE_FALLBACK_ANTHROPIC_API_KEY instead, and LORE_LLM_FALLBACK_NOTIFY gets
 * one email per episode — for a lost login, with the steps to restore it,
 * since unlike a limit it never resets by itself. (Nov 2026: the host's CLI
 * session expired and every fold failed for six days without a word.) Every new process
 * tries the CLI first — one fast rejected call while the limit lasts — so the
 * subscription is used again as soon as it resets, and that first successful
 * CLI call ends the episode. Without a fallback key, a limit fails as before.
 */

const LIMIT = /hit your (?:[\w-]+ )?limit|usage limit reached|[\w-]+ limit reached/i
const AUTH = /failed to authenticate|oauth (?:session|token)\b[^.]*\b(?:expired|revoked|invalid)|not logged in|please run \/login|invalid (?:api key|bearer token|oauth token)|authentication_error/i

export type FallbackKind = 'limit' | 'auth'
export interface CliFailure { kind: FallbackKind; reason: string }
const MARKER = () => join(loreHome(), 'llm-fallback.json')

let reason: string | undefined
let activation: Promise<void> | undefined

export const fallbackKey = (env = process.env) => env.LORE_FALLBACK_ANTHROPIC_API_KEY || undefined
/** The API key the SDK should use right now: the fallback key once a limit switched this process over. */
export const fallbackApiKey = () => (reason ? fallbackKey() : undefined)

/** The limit message behind a failed CLI call, or undefined when it failed for another reason. */
export function usageLimitReason(err: unknown): string | undefined {
  const stdout = (err as { stdout?: Buffer | string } | undefined)?.stdout?.toString()
  if (stdout) {
    try {
      const envelope = JSON.parse(stdout) as { result?: unknown; api_error_status?: unknown }
      const result = typeof envelope.result === 'string' ? envelope.result : ''
      if (LIMIT.test(result) || envelope.api_error_status === 429) return result || 'usage limit (HTTP 429)'
    } catch { /* not a CLI envelope */ }
  }
  const message = err instanceof Error ? err.message : String(err)
  return LIMIT.test(message) ? message.replace(/^(?:load|extract): (?:claude cli error: )?/, '') : undefined
}

/** The login failure behind a failed CLI call (HTTP 401 or an auth message), or undefined. */
export function authFailureReason(err: unknown): string | undefined {
  const stdout = (err as { stdout?: Buffer | string } | undefined)?.stdout?.toString()
  if (stdout) {
    try {
      const envelope = JSON.parse(stdout) as { result?: unknown; api_error_status?: unknown }
      const result = typeof envelope.result === 'string' ? envelope.result : ''
      if (AUTH.test(result) || envelope.api_error_status === 401) return result || 'authentication failed (HTTP 401)'
    } catch { /* not a CLI envelope */ }
  }
  const message = err instanceof Error ? err.message : String(err)
  return AUTH.test(message) ? message.replace(/^(?:load|extract): (?:claude cli error: )?/, '') : undefined
}

/** Why a CLI failure should switch to the API key, or undefined when it should not. */
export function cliFailureReason(err: unknown): CliFailure | undefined {
  const limit = usageLimitReason(err)
  if (limit) return { kind: 'limit', reason: limit }
  const auth = authFailureReason(err)
  return auth ? { kind: 'auth', reason: auth } : undefined
}

/**
 * Run `cli`; if it hits a subscription limit or has lost its login and a fallback key is set, switch
 * this process to the API and run `api` instead. Once switched, `cli` is
 * skipped for the rest of the process.
 */
export async function withCliFallback<T>(cli: () => T | Promise<T>, api: () => Promise<T>, notify: (reason: string, kind: FallbackKind) => Promise<void> = notifyFallback): Promise<T> {
  if (reason && fallbackKey()) return api()
  let result: T
  try {
    result = await cli()
  } catch (err) {
    const failure = cliFailureReason(err)
    if (!failure || !fallbackKey()) throw err
    activation ??= (async () => {
      reason = failure.reason
      console.warn(`⚠ claude CLI: ${failure.reason} — using the Claude API key for the rest of this run${failure.kind === 'auth' ? ' (the CLI login needs renewing: claude setup-token)' : ''}`)
      try { await notify(failure.reason, failure.kind) } catch (e) { console.warn(`⚠ fallback notice not sent: ${e instanceof Error ? e.message : String(e)}`) }
    })()
    await activation
    return api()
  }
  endEpisode()
  return result
}

/** Email LORE_LLM_FALLBACK_NOTIFY once per episode; the marker keeps later runs from repeating it. */
export async function notifyFallback(limit: string, kind: FallbackKind = 'limit', send?: (msg: MailMessage) => Promise<void>): Promise<void> {
  if (existsSync(MARKER())) return
  writeFileSync(MARKER(), JSON.stringify({ since: new Date().toISOString(), kind, reason: limit }) + '\n')
  const to = process.env.LORE_LLM_FALLBACK_NOTIFY
  const cfg = emailConfigFromEnv()
  if (!to || (!send && (!cfg.from || !cfg.api))) {
    console.warn('⚠ fallback notice not emailed: set LORE_LLM_FALLBACK_NOTIFY and the board email settings')
    return
  }
  await (send ?? createSendMail(cfg, console.log))(fallbackEmail(to, limit, kind))
}

function endEpisode(): void {
  if (!existsSync(MARKER())) return
  rmSync(MARKER(), { force: true })
  console.log('claude CLI is answering again — back on the subscription')
}

export function fallbackEmail(to: string, limit: string, kind: FallbackKind = 'limit'): MailMessage {
  const text = kind === 'auth'
    ? `Lore's Claude Code login on the host stopped working, so it is switching to the backup Claude API key.\n\nClaude Code said: ${limit}\n\nFolds keep running on the API key, billed per token, until the login is restored. Unlike a usage limit, this does not fix itself. To restore it: run \`claude setup-token\` (on any machine signed in to the Claude subscription), save the token in 1Password, and install it as CLAUDE_CODE_OAUTH_TOKEN in /etc/lore/env on the host. Lore switches back on the next run after that.\n`
    : `Lore has used its Claude subscription limit and is switching to the backup Claude API key.\n\nClaude Code said: ${limit}\n\nFolds keep running on the API key, billed per token, until the subscription answers again; lore switches back on its own.\n`
  return {
    to,
    subject: kind === 'auth' ? 'Lore lost its Claude login and switched to the API key' : 'Lore hit its Claude limit and switched to the API key',
    text,
    html: `<div style="font:16px/1.5 system-ui,sans-serif;color:#1f1d1a;max-width:520px">${text.split('\n\n').map(p => `<p>${esc(p)}</p>`).join('')}</div>`,
  }
}

/** Tests only: forget this process's switch. */
export function resetFallback(): void {
  reason = undefined
  activation = undefined
}
