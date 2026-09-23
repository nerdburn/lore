import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { loreHome } from '../context.js'

/**
 * Board sign-in: an emailed one-time code, then a long-lived signed cookie.
 *
 * No user table and no session store. A code lives in memory for ten
 * minutes (a restart only cancels codes in flight). The cookie is
 * `<payload>.<hmac>` over the email, issue time and the session epoch; it
 * lasts 90 days and is re-issued as it is used, so people rarely sign in
 * again. Who may see what is checked against lore.json on every request —
 * removing an email from `board.members` takes effect at once, and bumping
 * LORE_BOARD_SESSION_EPOCH signs everyone out.
 */

export const COOKIE = 'lore_board'
export const SESSION_DAYS = 90
const CODE_TTL_MS = 10 * 60_000
const CODE_ATTEMPTS = 5
/** Re-issue the cookie once it is a day old, so an active user never hits the 90-day wall. */
const RENEW_AFTER_MS = 24 * 3_600_000

export interface Session {
  email: string
  /** ms since epoch. */
  iat: number
  exp: number
}

/** The HMAC key: LORE_BOARD_SECRET, else a random one generated once into ~/.lore/board-secret (0600). */
export function boardSecret(): string {
  if (process.env.LORE_BOARD_SECRET) return process.env.LORE_BOARD_SECRET
  const path = join(loreHome(), 'board-secret')
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  mkdirSync(dirname(path), { recursive: true })
  const secret = randomBytes(32).toString('base64url')
  writeFileSync(path, secret + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  return secret
}

export function normalizeEmail(email: unknown): string | undefined {
  if (typeof email !== 'string') return undefined
  const e = email.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : undefined
}

export class SessionSigner {
  constructor(
    private readonly secret: string,
    private readonly epoch = process.env.LORE_BOARD_SESSION_EPOCH ?? '0',
  ) {}

  private mac(payload: string): string {
    return createHmac('sha256', this.secret).update(`${this.epoch}.${payload}`).digest('base64url')
  }

  issue(email: string, now = Date.now()): { value: string; session: Session } {
    const session: Session = { email, iat: now, exp: now + SESSION_DAYS * 86_400_000 }
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url')
    return { value: `${payload}.${this.mac(payload)}`, session }
  }

  verify(value: string | undefined, now = Date.now()): Session | undefined {
    if (!value) return undefined
    const dot = value.lastIndexOf('.')
    if (dot <= 0) return undefined
    const payload = value.slice(0, dot)
    if (!safeEqual(value.slice(dot + 1), this.mac(payload))) return undefined
    try {
      const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session
      if (typeof s.email !== 'string' || typeof s.exp !== 'number' || s.exp < now) return undefined
      return s
    } catch {
      return undefined
    }
  }

  /** Should this still-valid session get a fresh cookie? */
  stale(s: Session, now = Date.now()): boolean {
    return now - s.iat > RENEW_AFTER_MS
  }
}

export function cookieHeader(value: string, opts: { secure: boolean; maxAgeS?: number }): string {
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeS ?? SESSION_DAYS * 86_400}`,
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ')
}

export function readCookie(req: IncomingMessage, name = COOKIE): string | undefined {
  const raw = req.headers.cookie
  if (!raw) return undefined
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

// ---- one-time codes ----

interface Pending {
  mac: string
  exp: number
  attempts: number
}

export type CodeCheck = 'ok' | 'wrong' | 'expired'

export class CodeStore {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly secret: string) {}

  private mac(email: string, code: string): string {
    return createHmac('sha256', this.secret).update(`otp.${email}.${code}`).digest('base64url')
  }

  /** A fresh 6-digit code for this email; replaces any earlier one. */
  create(email: string, now = Date.now()): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pending.set(email, { mac: this.mac(email, code), exp: now + CODE_TTL_MS, attempts: 0 })
    this.sweep(now)
    return code
  }

  check(email: string, code: string, now = Date.now()): CodeCheck {
    const p = this.pending.get(email)
    if (!p || p.exp < now || p.attempts >= CODE_ATTEMPTS) {
      this.pending.delete(email)
      return 'expired'
    }
    p.attempts++
    if (!safeEqual(this.mac(email, code.replace(/\s+/g, '')), p.mac)) {
      if (p.attempts >= CODE_ATTEMPTS) this.pending.delete(email)
      return 'wrong'
    }
    this.pending.delete(email)
    return 'ok'
  }

  private sweep(now: number): void {
    for (const [e, p] of this.pending) if (p.exp < now) this.pending.delete(e)
  }
}

/** Sliding-window counter: at most `limit` hits per `windowMs` per key. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k)
    return true
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
