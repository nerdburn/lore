import { createHash, createSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loreHome } from '../context.js'
import type { Connector, ConnectorContext, Doc } from '../types.js'

/**
 * Gmail connector — client email across the team's inboxes.
 *
 * A client that doesn't use Slack still writes email, and it lands in several
 * teammates' mailboxes. Reading them all through one identity is what a
 * Google Workspace *service account with domain-wide delegation* is for: a
 * Workspace admin grants the account's client id the `gmail.readonly` scope
 * once, and the connector then mints a short-lived token *per mailbox* (a JWT
 * with the teammate as `sub`) — no per-teammate consent flow, nothing that
 * expires when someone changes their password.
 *
 * Scope is the client, not the mailbox: each inbox is searched for mail
 * from/to/cc any of the client's domains (`client.domains` ∪ `domains`) or
 * any client-side contact. Internal mail never matches. The same thread hits
 * several inboxes, so docs are keyed on the RFC 5322 Message-ID (stable
 * across mailboxes), not Gmail's per-mailbox id; `meta.mailboxes` records who
 * had it. Replies chain on the first `References` id, so a thread stays one
 * thread whoever it was found in.
 *
 * Mailboxes default to the `team`-side contacts in lore.json (`users` to
 * override, `exclude` for a teammate who opts out). Whatever is synced is
 * readable by every agent pointed at the memory — pick mailboxes with that in
 * mind.
 *
 * Auth: the service account key JSON, from `key` (an env ref holding the
 * JSON) or `key_file` (default ~/.lore/gmail-sa.json on the syncing host).
 * exe.dev's header-injecting proxies can't do this dance (the bearer differs
 * per mailbox and per hour), so the key lives on the host like Granola's
 * grant does. Incremental via `after:` with a two-day overlap; stream dedup
 * absorbs the repeats. Quoted history and signatures are trimmed from bodies.
 */

interface GmailCursor {
  since?: string
}

interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri?: string
}

const API = 'https://gmail.googleapis.com'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const DEFAULT_OVERLAP_DAYS = 2
const DAY_MS = 86_400_000
const LIST_PAGE = 500
const GET_BATCH = 8
const MAX_BODY_CHARS = 20_000
const MAX_ATTEMPTS = 5

export function defaultKeyFile(): string {
  return join(loreHome(), 'gmail-sa.json')
}

export const gmail: Connector = {
  name: 'gmail',

  async fetch(ctx: ConnectorContext) {
    const key = loadKey(ctx.config)
    const apiBase = ((ctx.config.api_base as string | undefined) ?? API).replace(/\/$/, '')
    const tokenUrl = (ctx.config.token_url as string | undefined) ?? key.token_uri ?? TOKEN_URL
    const overlapMs = numberOr(ctx.config.overlap_days, DEFAULT_OVERLAP_DAYS) * DAY_MS

    // Mailboxes: explicit `users`, else the team side of the client block.
    const exclude = new Set(((ctx.config.exclude as string[] | undefined) ?? []).map(lower))
    const users = (((ctx.config.users as string[] | undefined) ?? ctx.client?.contacts.filter((c) => c.side === 'team').map((c) => c.email)) ?? [])
      .map(lower)
      .filter((u) => u && !exclude.has(u))
    if (users.length === 0) {
      throw new Error('gmail: no mailboxes to read — set `users` on the source, or add team-side contacts to client.contacts in lore.json')
    }

    // Scope: the client's domains and people.
    const domains = uniq([...((ctx.config.domains as string[] | undefined) ?? []), ...(ctx.client?.domains ?? [])].map((d) => lower(d).replace(/^@/, '')))
    const contactEmails = uniq((ctx.client?.contacts ?? []).filter((c) => c.side !== 'team').map((c) => lower(c.email)))
    if (domains.length === 0 && contactEmails.length === 0) {
      throw new Error('gmail: nothing scopes mail to this client — set client.domains/contacts in lore.json, or `domains` on the source')
    }
    const scopeTerms = [...domains, ...contactEmails.filter((e) => !domains.includes(e.split('@')[1] ?? ''))]

    const prev = ctx.cursor as GmailCursor
    const sinceMs = prev.since ? Math.max(new Date(prev.since).getTime() - overlapMs, ctx.since) : ctx.since
    const query = buildQuery(scopeTerms, sinceMs, ctx.config.query as string | undefined)

    const api = gmailClient(apiBase, tokenUrl, key)
    const byMessageId = new Map<string, { msg: GmailMessage; mailboxes: string[] }>()
    const errors: string[] = []
    let listed = 0

    for (const user of users) {
      try {
        const ids = await api.listMessageIds(user, query)
        listed += ids.length
        for (let i = 0; i < ids.length; i += GET_BATCH) {
          const batch = await Promise.all(ids.slice(i, i + GET_BATCH).map((id) => api.getMessage(user, id)))
          for (const msg of batch) {
            if (!msg) continue
            const mid = messageIdOf(msg) ?? `${user}/${msg.id}`
            const seen = byMessageId.get(mid)
            if (!seen) byMessageId.set(mid, { msg, mailboxes: [user] })
            else if (!seen.mailboxes.includes(user)) seen.mailboxes.push(user) // sent + received copies in one inbox
          }
        }
      } catch (err) {
        errors.push(`mailbox ${user}: ${err instanceof Error ? err.message : err}`)
      }
    }

    const docs: Doc[] = []
    let newest = prev.since ? new Date(prev.since).getTime() : 0
    for (const [mid, { msg, mailboxes }] of byMessageId) {
      const ms = Number(msg.internalDate)
      if (!Number.isFinite(ms) || ms < sinceMs) continue
      docs.push(renderDoc(msg, mid, mailboxes, domains, ctx.client?.name))
      if (ms > newest) newest = ms
    }

    ctx.log(`gmail: ${users.length} mailbox(es), ${listed} message(s) matched, ${byMessageId.size} unique → ${docs.length} docs`)
    return {
      docs,
      nextCursor: { since: new Date(newest || sinceMs).toISOString() } as Record<string, unknown>,
      ...(errors.length ? { errors } : {}),
    }
  },
}

// ---- config ----

function loadKey(config: Record<string, unknown>): ServiceAccountKey {
  const inline = config.key as string | undefined
  const file = (config.key_file as string | undefined) ?? defaultKeyFile()
  let raw: string | undefined = inline
  if (!raw && existsSync(file)) raw = readFileSync(file, 'utf8')
  if (!raw) {
    throw new Error(`gmail: no service account key — put the JSON key at ${file} (or set key_file), or set key: env:GMAIL_SA_KEY`)
  }
  let parsed: Partial<ServiceAccountKey>
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccountKey>
  } catch {
    throw new Error('gmail: service account key is not valid JSON')
  }
  if (!parsed.client_email || !parsed.private_key) throw new Error('gmail: service account key needs client_email and private_key')
  return parsed as ServiceAccountKey
}

/**
 * Gmail search: `{a b c}` is OR. `from:acme.com` matches any address at that
 * domain (and, generously, subdomains — fine for scoping). `after:` takes epoch
 * seconds. Spam and trash are excluded by default; chats are noise.
 */
export function buildQuery(terms: string[], sinceMs: number, extra?: string): string {
  const alts = terms.flatMap((t) => [`from:${t}`, `to:${t}`, `cc:${t}`])
  const scope = alts.length === 1 ? alts[0] : `{${alts.join(' ')}}`
  return [scope, `after:${Math.floor(sinceMs / 1000)}`, '-label:chats', extra?.trim()].filter(Boolean).join(' ')
}

// ---- rendering ----

function renderDoc(msg: GmailMessage, mid: string, mailboxes: string[], clientDomains: string[], clientName: string | undefined): Doc {
  const h = headersOf(msg)
  const from = parseAddress(h.from ?? '')
  const to = splitAddresses(h.to ?? '')
  const cc = splitAddresses(h.cc ?? '')
  const subject = (h.subject ?? '').trim() || '(no subject)'
  const timestamp = new Date(Number(msg.internalDate)).toISOString()
  const references = (h.references ?? h['in-reply-to'] ?? '').match(/<[^>]+>/g) ?? []
  const rootRef = references[0] ? normalizeMessageId(references[0]) : undefined

  const { text: rawBody, attachments } = bodyOf(msg.payload)
  const body = trimQuoted(rawBody).slice(0, MAX_BODY_CHARS).trim()

  const everyone = [from.email, ...to.map((a) => a.email), ...cc.map((a) => a.email)]
  const matched = clientDomains.find((d) => everyone.some((e) => e.endsWith(`@${d}`) || e.endsWith(`.${d}`)))
  const channel = matched ?? (clientName ? lower(clientName).replace(/\s+/g, '-') : 'mail')

  const lines = [
    `**${subject}**`,
    '',
    `From: ${formatAddress(from)}`,
    ...(to.length ? [`To: ${to.map(formatAddress).join(', ')}`] : []),
    ...(cc.length ? [`Cc: ${cc.map(formatAddress).join(', ')}`] : []),
    '',
    body || '(empty message)',
    ...(attachments.length ? ['', `Attachments: ${attachments.join(', ')}`] : []),
  ]

  const meta: Record<string, string> = {
    message_id: mid.replace(/\s+/g, ''),
    from: from.email || 'unknown',
    mailboxes: mailboxes.join(','),
  }
  if (to.length) meta.to = to.map((a) => a.email).join(',')
  if (cc.length) meta.cc = cc.map((a) => a.email).join(',')

  return {
    id: `gmail-${shortHash(mid)}`,
    source: 'gmail',
    channel,
    author: from.name || from.email || 'unknown',
    timestamp,
    permalink: `https://mail.google.com/mail/#search/rfc822msgid:${encodeURIComponent(mid)}`,
    ...(rootRef && rootRef !== mid ? { thread: `gmail-${shortHash(rootRef)}` } : {}),
    meta,
    text: lines.join('\n'),
  }
}

export function messageIdOf(msg: GmailMessage): string | undefined {
  const raw = headersOf(msg)['message-id']
  return raw ? normalizeMessageId(raw) : undefined
}

export function normalizeMessageId(raw: string): string {
  const m = /<([^>]+)>/.exec(raw)
  return (m ? m[1] : raw).trim().toLowerCase()
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 20)
}

function headersOf(msg: GmailMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of msg.payload?.headers ?? []) out[h.name.toLowerCase()] = h.value
  return out
}

interface Address {
  name: string
  email: string
}

export function parseAddress(raw: string): Address {
  const s = raw.trim()
  const m = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(s)
  if (m) return { name: (m[1] ?? '').trim(), email: lower(m[2]) }
  return { name: '', email: lower(s) }
}

export function splitAddresses(raw: string): Address[] {
  // Split on commas outside quotes and angle brackets.
  const parts: string[] = []
  let cur = ''
  let quoted = false
  let angle = 0
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<' && !quoted) angle++
    else if (ch === '>' && !quoted) angle = Math.max(0, angle - 1)
    if (ch === ',' && !quoted && angle === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean).map(parseAddress).filter((a) => a.email)
}

function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.email}>` : a.email
}

/** Prefer text/plain; fall back to stripped HTML; collect attachment names. */
export function bodyOf(payload: GmailPart | undefined): { text: string; attachments: string[] } {
  const plain: string[] = []
  const html: string[] = []
  const attachments: string[] = []
  const walk = (p: GmailPart | undefined) => {
    if (!p) return
    if (p.filename && p.body?.attachmentId) attachments.push(p.filename)
    else if (p.mimeType === 'text/plain' && p.body?.data) plain.push(decodeBody(p.body.data))
    else if (p.mimeType === 'text/html' && p.body?.data) html.push(decodeBody(p.body.data))
    for (const c of p.parts ?? []) walk(c)
  }
  walk(payload)
  const text = plain.length ? plain.join('\n') : html.map(htmlToText).join('\n')
  return { text: text.replace(/\r\n/g, '\n'), attachments }
}

function decodeBody(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Drop quoted history and signature blocks: everything from the first
 * "On … wrote:" / "-----Original Message-----" / Outlook "From:" header
 * block onward, plus trailing `>`-quoted lines and a `-- ` signature.
 * Each message is its own doc, so the quoted copy is pure duplication.
 */
export function trimQuoted(text: string): string {
  const lines = text.split('\n')
  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (
      /^On .{3,200}wrote:$/.test(l) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(l) ||
      /^-{2,}\s*Forwarded message\s*-{2,}$/i.test(l) ||
      (/^From:\s.+/.test(l) && /^(Sent|Date):\s/.test((lines[i + 1] ?? '').trim())) ||
      /^--\s?$/.test(lines[i])
    ) {
      cut = i
      break
    }
    // A multi-line "On <date>" ... "wrote:" wrap.
    if (/^On .{3,200}$/.test(l) && /wrote:$/.test((lines[i + 1] ?? '').trim())) {
      cut = i
      break
    }
  }
  const kept = lines.slice(0, cut)
  while (kept.length && (kept[kept.length - 1].trim() === '' || kept[kept.length - 1].startsWith('>'))) kept.pop()
  return kept.filter((l) => !l.startsWith('>')).join('\n').trim()
}

// ---- API client ----

export interface GmailMessage {
  id: string
  threadId?: string
  internalDate: string
  payload?: GmailPart
}
export interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailPart[]
}

interface Api {
  listMessageIds(user: string, query: string): Promise<string[]>
  getMessage(user: string, id: string): Promise<GmailMessage | undefined>
}

function gmailClient(apiBase: string, tokenUrl: string, key: ServiceAccountKey): Api {
  const tokens = new Map<string, { token: string; expiresAt: number }>()

  async function tokenFor(user: string): Promise<string> {
    const cached = tokens.get(user)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const assertion = signJwt(key, user, tokenUrl)
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    })
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    if (!res.ok || !body.access_token) {
      const hint =
        body.error === 'unauthorized_client'
          ? ' — domain-wide delegation is not granted for this service account (Workspace Admin → Security → API controls → Domain-wide delegation, scope gmail.readonly)'
          : body.error === 'invalid_grant'
            ? ' — is this a real mailbox in the Workspace domain?'
            : ''
      throw new Error(`token for ${user}: ${body.error ?? res.status} ${body.error_description ?? ''}${hint}`.trim())
    }
    tokens.set(user, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 })
    return body.access_token
  }

  async function request<T>(user: string, path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const token = await tokenFor(user)
      const res = await fetch(`${apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit|userRateLimit/i.test(await res.clone().text()))) {
        if (attempt >= MAX_ATTEMPTS) throw new Error(`gmail ${res.status} ${path} after ${attempt} attempts`)
        const retryAfter = Number(res.headers.get('retry-after'))
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 500, 30_000)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      if (res.status === 401 && attempt === 1) {
        tokens.delete(user)
        continue
      }
      if (!res.ok) throw new Error(`gmail ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`)
      return (await res.json()) as T
    }
  }

  return {
    async listMessageIds(user, query) {
      const ids: string[] = []
      let pageToken: string | undefined
      do {
        const qs = new URLSearchParams({ q: query, maxResults: String(LIST_PAGE), ...(pageToken ? { pageToken } : {}) })
        const page = await request<{ messages?: { id: string }[]; nextPageToken?: string }>(user, `/gmail/v1/users/me/messages?${qs}`)
        ids.push(...(page.messages ?? []).map((m) => m.id))
        pageToken = page.nextPageToken
      } while (pageToken)
      return ids
    },
    async getMessage(user, id) {
      try {
        return await request<GmailMessage>(user, `/gmail/v1/users/me/messages/${id}?format=full`)
      } catch (err) {
        if (err instanceof Error && /gmail 404/.test(err.message)) return undefined // deleted between list and get
        throw err
      }
    },
  }
}

/** RS256 JWT for the OAuth 2.0 JWT-bearer grant, impersonating `sub`. */
export function signJwt(key: ServiceAccountKey, sub: string, aud: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: key.client_email, sub, scope: SCOPE, aud, iat, exp: iat + 3600 }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  return `${header}.${claims}.${b64url(signer.sign(key.private_key))}`
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---- small helpers ----

function lower(s: string): string {
  return s.trim().toLowerCase()
}
function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? value : fallback
}
