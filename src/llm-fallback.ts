import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loreHome } from './context.js'
import { createSendMail, emailConfigFromEnv, type MailMessage } from './board/email.js'
import { esc } from './markdown.js'

/**
 * Subscription limits on the claude CLI backend. When `claude -p` reports a
 * usage limit (weekly, daily, five-hour), the rest of this process calls the
 * Claude API with LORE_FALLBACK_ANTHROPIC_API_KEY instead, and
 * LORE_LLM_FALLBACK_NOTIFY gets one email per episode. Every new process
 * tries the CLI first — one fast rejected call while the limit lasts — so the
 * subscription is used again as soon as it resets, and that first successful
 * CLI call ends the episode. Without a fallback key, a limit fails as before.
 */

const LIMIT = /hit your (?:[\w-]+ )?limit|usage limit reached|[\w-]+ limit reached/i
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

/**
 * Run `cli`; if it hits a subscription limit and a fallback key is set, switch
 * this process to the API and run `api` instead. Once switched, `cli` is
 * skipped for the rest of the process.
 */
export async function withCliFallback<T>(cli: () => T | Promise<T>, api: () => Promise<T>, notify: (reason: string) => Promise<void> = notifyFallback): Promise<T> {
  if (reason && fallbackKey()) return api()
  let result: T
  try {
    result = await cli()
  } catch (err) {
    const limit = usageLimitReason(err)
    if (!limit || !fallbackKey()) throw err
    activation ??= (async () => {
      reason = limit
      console.warn(`⚠ claude CLI: ${limit} — using the Claude API key for the rest of this run`)
      try { await notify(limit) } catch (e) { console.warn(`⚠ fallback notice not sent: ${e instanceof Error ? e.message : String(e)}`) }
    })()
    await activation
    return api()
  }
  endEpisode()
  return result
}

/** Email LORE_LLM_FALLBACK_NOTIFY once per episode; the marker keeps later runs from repeating it. */
export async function notifyFallback(limit: string, send?: (msg: MailMessage) => Promise<void>): Promise<void> {
  if (existsSync(MARKER())) return
  writeFileSync(MARKER(), JSON.stringify({ since: new Date().toISOString(), reason: limit }) + '\n')
  const to = process.env.LORE_LLM_FALLBACK_NOTIFY
  const cfg = emailConfigFromEnv()
  if (!to || (!send && (!cfg.from || !cfg.api))) {
    console.warn('⚠ fallback notice not emailed: set LORE_LLM_FALLBACK_NOTIFY and the board email settings')
    return
  }
  await (send ?? createSendMail(cfg, console.log))(fallbackEmail(to, limit))
}

function endEpisode(): void {
  if (!existsSync(MARKER())) return
  rmSync(MARKER(), { force: true })
  console.log('claude CLI is answering again — back on the subscription')
}

export function fallbackEmail(to: string, limit: string): MailMessage {
  const text = `Lore has used its Claude subscription limit and is switching to the backup Claude API key.\n\nClaude Code said: ${limit}\n\nFolds keep running on the API key, billed per token, until the subscription answers again; lore switches back on its own.\n`
  return {
    to,
    subject: 'Lore hit its Claude limit and switched to the API key',
    text,
    html: `<div style="font:16px/1.5 system-ui,sans-serif;color:#1f1d1a;max-width:520px">${text.split('\n\n').map(p => `<p>${esc(p)}</p>`).join('')}</div>`,
  }
}

/** Tests only: forget this process's switch. */
export function resetFallback(): void {
  reason = undefined
  activation = undefined
}
