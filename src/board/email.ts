import { esc } from '../markdown.js'

/**
 * Sending the sign-in code. Resend's REST API, reached the way every other
 * credential on the host is: through an exe.dev http-proxy integration that
 * injects the bearer key, so the VM never holds it —
 *
 *   ssh exe.dev integrations add http-proxy --name resend --target https://api.resend.com \
 *       --bearer re_… --attach vm:lore-host
 *   LORE_BOARD_EMAIL_API=https://resend.int.exe.xyz   (in /etc/lore/env)
 *
 * RESEND_API_KEY in the environment also works (a laptop, no proxy). With
 * neither a From address nor an API, codes are printed to the log instead —
 * for local development only.
 */
export interface MailMessage {
  to: string
  subject: string
  text: string
  html: string
}

export type SendMail = (msg: MailMessage) => Promise<void>

export interface EmailConfig {
  from?: string
  api?: string
  key?: string
}

export function emailConfigFromEnv(env = process.env): EmailConfig {
  return {
    from: env.LORE_BOARD_EMAIL_FROM,
    api: env.LORE_BOARD_EMAIL_API ?? (env.RESEND_API_KEY ? 'https://api.resend.com' : undefined),
    key: env.RESEND_API_KEY,
  }
}

export function createSendMail(cfg: EmailConfig, log: (line: string) => void, fetchImpl: typeof fetch = fetch): SendMail {
  if (!cfg.from || !cfg.api) {
    log('email is not configured (LORE_BOARD_EMAIL_FROM + LORE_BOARD_EMAIL_API) — sign-in codes are printed here instead of sent')
    return async (msg) => log(`sign-in email for ${msg.to}: ${msg.text.split('\n')[0]}`)
  }
  const url = `${cfg.api.replace(/\/+$/, '')}/emails`
  return async (msg) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
      body: JSON.stringify({ from: cfg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    })
    if (!res.ok) throw new Error(`email send failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }
}

export function codeEmail(to: string, code: string, link?: string): MailMessage {
  return {
    to,
    subject: `${code} is your lore sign-in code`,
    text: `Your lore sign-in code is ${code}\n\nIt expires in 10 minutes. If you did not ask for it, ignore this email.${link ? `\n\n${link}` : ''}\n`,
    html: `<div style="font:16px/1.5 system-ui,sans-serif;color:#1f1d1a;max-width:420px">
<p>Your lore sign-in code:</p>
<p style="font:600 32px/1 ui-monospace,Menlo,monospace;letter-spacing:.2em;margin:16px 0">${esc(code)}</p>
<p style="color:#6b665e;font-size:14px">It expires in 10 minutes. If you did not ask for it, ignore this email.</p>
${link ? `<p style="font-size:14px"><a href="${esc(link)}" style="color:#8a4b1f">Open the board</a></p>` : ''}
</div>`,
  }
}
