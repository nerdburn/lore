import { createSendMail, emailConfigFromEnv, type MailMessage, type SendMail } from './board/email.js'
import type { LoreConfig } from './config.js'
import { CLAIM_STALE_HOURS, describeClaim, readWorkItems, staleClaims, workPrefix, writeWorkItems, type LoreWorkItem } from './work.js'

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

/**
 * A claim never lapses on its own, so a holder that has stopped (a crashed
 * runner, a machine that is down) would hold its tickets forever in silence.
 * Each sync reports tickets whose holder has not confirmed its claim for
 * CLAIM_STALE_HOURS — once per silence; the next renewal clears the mark.
 * Recipient: LORE_ALERT_NOTIFY, else the project's account lead.
 */
export async function alertStaleClaims(
  root: string,
  config: Pick<LoreConfig, 'project' | 'client' | 'work'>,
  opts: { send?: SendMail; now?: number } = {},
): Promise<string[]> {
  const now = opts.now ?? Date.now()
  const prefix = workPrefix(config)
  const items = readWorkItems(root, prefix)
  const stale = staleClaims(items, now).filter((i) => !i.claim!.stale_notified)
  if (stale.length === 0) return []
  const to = process.env.LORE_ALERT_NOTIFY || config.client?.owner
  const cfg = emailConfigFromEnv()
  if (!to || (!opts.send && (!cfg.from || !cfg.api))) {
    console.warn(`⚠ ${stale.length} stale claim${stale.length === 1 ? '' : 's'} (${stale.map((i) => i.key).join(', ')}) not emailed: set LORE_ALERT_NOTIFY or client.owner, and the board email settings`)
    return []
  }
  await (opts.send ?? createSendMail(cfg, console.log))(staleClaimEmail(to, config.project, stale, now))
  const at = new Date(now).toISOString()
  for (const i of stale) i.claim!.stale_notified = at
  writeWorkItems(root, prefix, items)
  return stale.map((i) => i.key)
}

export function staleClaimEmail(to: string, project: string, stale: LoreWorkItem[], now = Date.now()): MailMessage {
  const lines = stale.map((i) => {
    const hours = Math.round((now - Date.parse(i.claim!.renewed)) / 3_600_000)
    return `${i.key} — ${i.title}\n  held by ${describeClaim(i.claim)}, silent for ${hours}h`
  })
  const text =
    `${stale.length} ticket${stale.length === 1 ? ' is' : 's are'} claimed in ${project} by a holder that has not confirmed its claim for over ${CLAIM_STALE_HOURS} hours.\n\n` +
    `${lines.join('\n\n')}\n\n` +
    `Nothing else will pick these up while the claim stands. Check the holder is running; if it is gone, free a ticket with:\nlore work release <KEY> --force --reason "<why>" -p ${project}\n`
  return {
    to,
    subject: `Lore: ${stale.length} claimed ticket${stale.length === 1 ? '' : 's'} in ${project} gone quiet`,
    text,
    html: `<div style="font:16px/1.5 system-ui,sans-serif;color:#1f1d1a;max-width:560px">${text.split('\n\n').map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`,
  }
}
