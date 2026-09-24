import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { loreHome } from './context.js'
import { RateLimiter } from './board/auth.js'

/**
 * OAuth 2.1 for the hosted MCP endpoint, so Claude Code on a laptop can use
 * lore without SSH or a VM-to-VM integration: `claude mcp add --transport
 * http lore https://<host>/mcp/<context>`, and on first use a browser opens,
 * the person signs in with the board's email code, and approves.
 *
 * The pieces the MCP authorization spec asks for:
 * - protected-resource and authorization-server metadata under /.well-known;
 * - dynamic client registration (/oauth/register) — public clients, PKCE only;
 * - /oauth/authorize → the board's consent page (/board/authorize), which
 *   reuses the board sign-in; /oauth/token for codes and refresh tokens.
 *
 * Who may open what is not in the token: every MCP request re-checks the
 * person's board role on the context (members get every tool, viewers the
 * read tools), so removing someone from a board ends their MCP access at
 * once. Access tokens are signed (no store) and live an hour; refresh
 * tokens are random, stored only as hashes in <LORE_HOME>/oauth.json,
 * rotated on use, and can be revoked from the board.
 */

const ACCESS_TTL_S = 3600
const REFRESH_TTL_MS = 90 * 86_400_000
const CODE_TTL_MS = 5 * 60_000
const REQUEST_TTL_MS = 15 * 60_000
const MAX_CLIENTS = 1000
export const MCP_SCOPE = 'mcp'

export interface OAuthClient {
  client_id: string
  client_name: string
  redirect_uris: string[]
  created: string
}

export interface Grant {
  /** Stable across rotations — what the board lists and revokes. */
  id: string
  email: string
  client_id: string
  client_name: string
  /** The MCP URL the token was granted for (one context), or undefined for any context the person can open. */
  resource?: string
  created: string
  last_used: string
  expires: string
}

interface Store {
  clients: Record<string, OAuthClient>
  /** sha256(refresh token) → grant */
  refresh: Record<string, Grant>
}

export interface AuthRequest {
  id: string
  client: OAuthClient
  redirect_uri: string
  state?: string
  code_challenge: string
  resource?: string
  created: number
}

interface Code {
  client_id: string
  redirect_uri: string
  code_challenge: string
  email: string
  resource?: string
  exp: number
}

export interface AccessClaims {
  email: string
  client_id: string
  resource?: string
  exp: number
}

export interface OAuthOptions {
  secret: string
  file?: string
  /** Fixed public origin (LORE_PUBLIC_URL); default: from the request. */
  publicUrl?: string
  now?: () => number
  log?: (line: string) => void
}

export interface OAuthServer {
  /** /.well-known/oauth-* and /oauth/*; false when the path is not ours. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
  verify(token: string): AccessClaims | undefined
  /** WWW-Authenticate value for a 401 on an MCP path. */
  challenge(req: IncomingMessage, context?: string, error?: string): string
  /** For the consent page. */
  request(id: string): AuthRequest | undefined
  /** Finish a pending request; returns where to send the browser. */
  decide(id: string, email: string, approve: boolean): string
  grants(email: string): Omit<Grant, 'email'>[]
  revoke(email: string, grantId: string): boolean
  /** "lore-acme" from an MCP resource URL, if it names one. */
  contextOf(resource: string | undefined): string | undefined
}

export function oauthFile(): string {
  return join(loreHome(), 'oauth.json')
}

export function createOAuth(opts: OAuthOptions): OAuthServer {
  const file = opts.file ?? oauthFile()
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((line: string) => console.log(`[oauth] ${line}`))
  const requests = new Map<string, AuthRequest>()
  const codes = new Map<string, Code>()
  const registerLimit = new RateLimiter(20, 3_600_000)
  const tokenLimit = new RateLimiter(120, 60_000)

  const load = (): Store => {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as Store
      return { clients: s.clients ?? {}, refresh: s.refresh ?? {} }
    } catch {
      return { clients: {}, refresh: {} }
    }
  }
  const save = (s: Store) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
  }
  const sweep = () => {
    const t = now()
    for (const [k, r] of requests) if (t - r.created > REQUEST_TTL_MS) requests.delete(k)
    for (const [k, c] of codes) if (c.exp < t) codes.delete(k)
  }

  const base = (req: IncomingMessage) => (opts.publicUrl ?? `${header(req, 'x-forwarded-proto') === 'https' ? 'https' : 'http'}://${header(req, 'x-forwarded-host') ?? header(req, 'host') ?? 'localhost'}`).replace(/\/+$/, '')
  const mac = (payload: string) => createHmac('sha256', opts.secret).update(`oauth.${payload}`).digest('base64url')

  function signAccess(claims: AccessClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `lat_${payload}.${mac(payload)}`
  }

  function verify(token: string): AccessClaims | undefined {
    const m = /^lat_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token)
    if (!m || !safeEqual(m[2], mac(m[1]))) return undefined
    try {
      const c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as AccessClaims
      return typeof c.email === 'string' && c.exp * 1000 > now() ? c : undefined
    } catch {
      return undefined
    }
  }

  function contextOf(resource: string | undefined): string | undefined {
    if (!resource) return undefined
    try {
      return /^\/mcp\/([\w.-]+)\/?$/.exec(new URL(resource).pathname)?.[1]
    } catch {
      return undefined
    }
  }

  function issue(store: Store, grant: Omit<Grant, 'last_used' | 'expires'>): { access_token: string; refresh_token: string; token_type: 'Bearer'; expires_in: number; scope: string } {
    const refresh = `lrt_${randomBytes(32).toString('base64url')}`
    const t = new Date(now())
    store.refresh[hash(refresh)] = { ...grant, last_used: t.toISOString(), expires: new Date(now() + REFRESH_TTL_MS).toISOString() }
    const access = signAccess({ email: grant.email, client_id: grant.client_id, ...(grant.resource ? { resource: grant.resource } : {}), exp: Math.floor(now() / 1000) + ACCESS_TTL_S })
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_TTL_S, scope: MCP_SCOPE }
  }

  function asMetadata(req: IncomingMessage) {
    const b = base(req)
    return {
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      revocation_endpoint: `${b}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [MCP_SCOPE],
      service_documentation: `${b}/board/`,
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === '/.well-known/oauth-authorization-server' || path.startsWith('/.well-known/oauth-authorization-server/') || path === '/.well-known/openid-configuration') {
      json(res, 200, asMetadata(req))
      return true
    }
    if (path === '/.well-known/oauth-protected-resource' || path.startsWith('/.well-known/oauth-protected-resource/')) {
      const rest = path.slice('/.well-known/oauth-protected-resource'.length) || '/mcp'
      if (!/^\/mcp(\/[\w.-]+)?\/?$/.test(rest)) return json(res, 404, { error: 'not_found' }), true
      const b = base(req)
      json(res, 200, { resource: `${b}${rest.replace(/\/+$/, '')}`, authorization_servers: [b], scopes_supported: [MCP_SCOPE], bearer_methods_supported: ['header'], resource_name: 'lore project memory' })
      return true
    }
    if (!path.startsWith('/oauth/')) return false
    sweep()

    if (path === '/oauth/register' && method === 'POST') {
      if (!registerLimit.allow(clientIp(req), now())) return json(res, 429, { error: 'too_many_requests' }), true
      const body = await readParams(req)
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
      if (uris.length === 0 || uris.length > 10 || !uris.every(allowedRedirect)) {
        return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs or http loopback (localhost / 127.0.0.1 / [::1])' }), true
      }
      if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
        return json(res, 400, { error: 'invalid_client_metadata', error_description: 'only public clients (token_endpoint_auth_method: none) with PKCE' }), true
      }
      const store = load()
      if (Object.keys(store.clients).length >= MAX_CLIENTS) return json(res, 503, { error: 'temporarily_unavailable' }), true
      const client: OAuthClient = {
        client_id: `lc_${randomBytes(16).toString('base64url')}`,
        client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 80) : 'MCP client',
        redirect_uris: uris,
        created: new Date(now()).toISOString(),
      }
      store.clients[client.client_id] = client
      save(store)
      log(`registered client "${client.client_name}" (${client.client_id})`)
      json(res, 201, {
        ...client,
        client_id_issued_at: Math.floor(now() / 1000),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      })
      return true
    }

    if (path === '/oauth/authorize' && method === 'GET') {
      const q = url.searchParams
      const client = load().clients[q.get('client_id') ?? '']
      const redirect = q.get('redirect_uri') ?? ''
      // Until the client and its redirect are known-good, errors are shown here, never redirected.
      if (!client) return page(res, 400, 'Unknown app', 'This app is not registered with lore. Try connecting again from your MCP client.'), true
      if (!client.redirect_uris.some((r) => sameRedirect(r, redirect))) return page(res, 400, 'Bad redirect', 'The app asked to return somewhere it did not register.'), true
      const back = (error: string, description: string) => {
        const u = new URL(redirect)
        u.searchParams.set('error', error)
        u.searchParams.set('error_description', description)
        if (q.get('state')) u.searchParams.set('state', q.get('state')!)
        res.writeHead(302, { location: u.toString() })
        res.end()
        return true
      }
      if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'only response_type=code')
      const challenge = q.get('code_challenge') ?? ''
      if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back('invalid_request', 'PKCE with S256 is required')
      const resource = q.get('resource') ?? undefined
      if (resource && !/^\/mcp(\/[\w.-]+)?\/?$/.test(safePath(resource))) return back('invalid_target', 'resource must be this host\'s /mcp/<context>')
      const id = randomBytes(18).toString('base64url')
      requests.set(id, { id, client, redirect_uri: redirect, ...(q.get('state') ? { state: q.get('state')! } : {}), code_challenge: challenge, ...(resource ? { resource: resource.replace(/\/+$/, '') } : {}), created: now() })
      res.writeHead(302, { location: `/board/authorize?request=${id}` })
      res.end()
      return true
    }

    if (path === '/oauth/token' && method === 'POST') {
      if (!tokenLimit.allow(clientIp(req), now())) return json(res, 429, { error: 'too_many_requests' }), true
      const p = await readParams(req)
      const store = load()
      if (p.grant_type === 'authorization_code') {
        const code = typeof p.code === 'string' ? codes.get(p.code) : undefined
        if (code) codes.delete(p.code as string) // single use, whatever happens next
        if (!code || code.exp < now()) return json(res, 400, { error: 'invalid_grant', error_description: 'code is unknown, used or expired' }), true
        if (p.client_id !== code.client_id || !sameRedirect(code.redirect_uri, String(p.redirect_uri ?? ''))) return json(res, 400, { error: 'invalid_grant', error_description: 'client or redirect_uri does not match' }), true
        const verifier = typeof p.code_verifier === 'string' ? p.code_verifier : ''
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== code.code_challenge) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }), true
        }
        const client = store.clients[code.client_id]
        const tokens = issue(store, {
          id: randomBytes(9).toString('base64url'),
          email: code.email,
          client_id: code.client_id,
          client_name: client?.client_name ?? 'MCP client',
          ...(code.resource ? { resource: code.resource } : {}),
          created: new Date(now()).toISOString(),
        })
        save(store)
        log(`${code.email} connected "${client?.client_name}"${code.resource ? ` to ${contextOf(code.resource)}` : ''}`)
        json(res, 200, tokens)
        return true
      }
      if (p.grant_type === 'refresh_token') {
        const key = typeof p.refresh_token === 'string' ? hash(p.refresh_token) : ''
        const grant = store.refresh[key]
        if (!grant || grant.expires < new Date(now()).toISOString() || (p.client_id && p.client_id !== grant.client_id)) {
          if (grant) delete store.refresh[key]
          save(store)
          return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token is unknown, revoked or expired' }), true
        }
        // Rotate: the old refresh token dies with this use.
        delete store.refresh[key]
        const tokens = issue(store, { id: grant.id, email: grant.email, client_id: grant.client_id, client_name: grant.client_name, ...(grant.resource ? { resource: grant.resource } : {}), created: grant.created })
        save(store)
        json(res, 200, tokens)
        return true
      }
      return json(res, 400, { error: 'unsupported_grant_type' }), true
    }

    if (path === '/oauth/revoke' && method === 'POST') {
      const p = await readParams(req)
      const store = load()
      if (typeof p.token === 'string' && store.refresh[hash(p.token)]) {
        delete store.refresh[hash(p.token)]
        save(store)
      }
      res.writeHead(200).end()
      return true
    }

    json(res, 404, { error: 'not_found' })
    return true
  }

  return {
    handle,
    verify,
    contextOf,
    challenge(req, context, error) {
      const meta = `${base(req)}/.well-known/oauth-protected-resource/mcp${context ? `/${context}` : ''}`
      return `Bearer resource_metadata="${meta}", scope="${MCP_SCOPE}"${error ? `, error="${error}"` : ''}`
    },
    request(id) {
      sweep()
      return requests.get(id)
    },
    decide(id, email, approve) {
      const r = requests.get(id)
      if (!r) throw new Error('this sign-in request has expired — start again from your MCP client')
      requests.delete(id)
      const u = new URL(r.redirect_uri)
      if (r.state) u.searchParams.set('state', r.state)
      if (!approve) {
        u.searchParams.set('error', 'access_denied')
        return u.toString()
      }
      const code = randomBytes(24).toString('base64url')
      codes.set(code, { client_id: r.client.client_id, redirect_uri: r.redirect_uri, code_challenge: r.code_challenge, email, ...(r.resource ? { resource: r.resource } : {}), exp: now() + CODE_TTL_MS })
      u.searchParams.set('code', code)
      return u.toString()
    },
    grants(email) {
      const store = load()
      const t = new Date(now()).toISOString()
      return Object.values(store.refresh)
        .filter((g) => g.email === email && g.expires > t)
        .map(({ email: _e, ...g }) => g)
        .sort((a, b) => b.last_used.localeCompare(a.last_used))
    },
    revoke(email, grantId) {
      const store = load()
      let hit = false
      for (const [k, g] of Object.entries(store.refresh)) {
        if (g.email === email && g.id === grantId) {
          delete store.refresh[k]
          hit = true
        }
      }
      if (hit) save(store)
      return hit
    },
  }
}

// ---- helpers ----

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function safePath(u: string): string {
  try {
    return new URL(u).pathname
  } catch {
    return ''
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** https anywhere, or plain http only back to this machine (RFC 8252). */
export function allowedRedirect(u: string): boolean {
  try {
    const url = new URL(u)
    if (url.hash) return false
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  } catch {
    return false
  }
}

/** Exact match, except a loopback redirect may use any port (native apps pick one per run). */
export function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true
  try {
    const a = new URL(registered)
    const b = new URL(given)
    return a.protocol === 'http:' && LOOPBACK.has(a.hostname) && a.hostname === b.hostname && a.protocol === b.protocol && a.pathname === b.pathname && a.search === b.search
  } catch {
    return false
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() || undefined
}

function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  return (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop() ?? req.socket.remoteAddress ?? 'unknown'
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(body))
}

function page(res: ServerResponse, code: number, title: string, text: string): void {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' })
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.3rem">${esc(title)}</h1><p>${esc(text)}</p></body>`)
}

/** Token and registration bodies: form-encoded (the spec) or JSON (some clients). */
async function readParams(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length
    if (size > 64 * 1024) break
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (/json/i.test(String(req.headers['content-type'] ?? ''))) {
    try {
      const v = JSON.parse(raw || '{}') as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return Object.fromEntries(new URLSearchParams(raw))
}
