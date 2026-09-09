import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loreHome } from './context.js'

/**
 * OAuth for Granola's MCP server, headless-friendly (backlog §12 blocker).
 *
 * Granola's authorization server supports dynamic client registration and
 * the device-code grant, so a machine with no browser can be authorised:
 * `lore auth granola` registers lore as a client, prints a URL + code, the
 * human approves in any browser, and the resulting tokens (with a refresh
 * token) are stored in a file the connector refreshes from thereafter.
 *
 * The token file is the one secret lore keeps on disk for Granola; exe.dev's
 * proxies can't run this token dance (Granola isn't in their catalog).
 */

export const DEFAULT_RESOURCE = 'https://mcp.granola.ai/mcp'

export interface GranolaAuthFile {
  issuer: string
  token_endpoint: string
  client_id: string
  resource: string
  scope: string
  tokens: { access_token: string; refresh_token?: string; expires_at: number }
}

interface AsMetadata {
  issuer: string
  token_endpoint: string
  device_authorization_endpoint?: string
  registration_endpoint?: string
}

export function defaultAuthFile(): string {
  return join(loreHome(), 'granola-auth.json')
}

export function readAuthFile(path: string): GranolaAuthFile | undefined {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as GranolaAuthFile
}

function writeAuthFile(path: string, data: GranolaAuthFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/** Protected-resource → authorization-server metadata (RFC 9728 / 8414). */
export async function discover(resource: string, fetchFn: typeof fetch = fetch): Promise<AsMetadata> {
  const origin = new URL(resource).origin
  const prm = (await (await fetchFn(`${origin}/.well-known/oauth-protected-resource`)).json()) as { authorization_servers?: string[] }
  const as = prm.authorization_servers?.[0]
  if (!as) throw new Error(`granola: no authorization server advertised by ${origin}`)
  const md = (await (await fetchFn(`${as.replace(/\/$/, '')}/.well-known/oauth-authorization-server`)).json()) as AsMetadata
  if (!md.token_endpoint) throw new Error(`granola: incomplete authorization server metadata at ${as}`)
  return md
}

export interface DeviceFlowIO {
  /** Show the user where to go and what code to enter. */
  prompt: (verificationUri: string, userCode: string, expiresInS: number) => void
  sleep?: (ms: number) => Promise<void>
  fetchFn?: typeof fetch
  now?: () => number
}

/**
 * Run the whole device-code flow and write the token file. Returns the file
 * contents. Registers a client first unless one is already in the file.
 */
export async function deviceFlow(path: string, io: DeviceFlowIO, resource = DEFAULT_RESOURCE): Promise<GranolaAuthFile> {
  const fetchFn = io.fetchFn ?? fetch
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = io.now ?? Date.now
  const md = await discover(resource, fetchFn)
  if (!md.device_authorization_endpoint) throw new Error('granola: authorization server does not offer the device-code grant')

  const existing = readAuthFile(path)
  let clientId = existing?.issuer === md.issuer ? existing.client_id : undefined
  if (!clientId) {
    if (!md.registration_endpoint) throw new Error('granola: no dynamic client registration and no saved client_id')
    // Granola's registration accepts only the auth-code profile; the device
    // endpoint honours the resulting client anyway (verified 2026-09-09).
    const res = await fetchFn(md.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'lore',
        client_uri: 'https://github.com/nerdburn/lore',
        redirect_uris: ['http://localhost:3119/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp offline_access',
      }),
    })
    const reg = (await res.json()) as { client_id?: string; error?: string; error_description?: string }
    if (!reg.client_id) throw new Error(`granola: client registration failed: ${reg.error_description ?? reg.error ?? res.status}`)
    clientId = reg.client_id
  }

  const scope = 'mcp offline_access'
  const dev = (await (
    await fetchFn(md.device_authorization_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope, resource }),
    })
  ).json()) as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
    error?: string
    error_description?: string
  }
  if (!dev.device_code || !dev.user_code) throw new Error(`granola: device authorization failed: ${dev.error_description ?? dev.error}`)
  io.prompt(dev.verification_uri_complete ?? dev.verification_uri ?? '', dev.user_code, dev.expires_in ?? 300)

  let intervalMs = (dev.interval ?? 5) * 1000
  const deadline = now() + (dev.expires_in ?? 300) * 1000
  while (now() < deadline) {
    await sleep(intervalMs)
    const res = await fetchFn(md.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dev.device_code, client_id: clientId, resource }),
    })
    const tok = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
    if (tok.access_token) {
      const file: GranolaAuthFile = {
        issuer: md.issuer,
        token_endpoint: md.token_endpoint,
        client_id: clientId,
        resource,
        scope,
        tokens: { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: now() + (tok.expires_in ?? 3600) * 1000 },
      }
      writeAuthFile(path, file)
      return file
    }
    if (tok.error === 'authorization_pending') continue
    if (tok.error === 'slow_down') {
      intervalMs += 5000
      continue
    }
    throw new Error(`granola: device authorization ${tok.error}: ${tok.error_description ?? ''}`.trim())
  }
  throw new Error('granola: device code expired before it was approved — run `lore auth granola` again')
}

/**
 * A bearer for the connector: the saved access token, refreshed through the
 * refresh token when it is within `skewMs` of expiry (or when `force` is
 * set, after a 401). Rotated refresh tokens are written back.
 */
export async function accessToken(
  path: string,
  opts: { force?: boolean; skewMs?: number; fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<string> {
  const file = readAuthFile(path)
  if (!file) throw new Error(`granola: no token file at ${path} — run \`lore auth granola\` (on the machine that syncs)`)
  const now = opts.now ?? Date.now
  const skew = opts.skewMs ?? 120_000
  if (!opts.force && file.tokens.expires_at - skew > now()) return file.tokens.access_token
  if (!file.tokens.refresh_token) throw new Error('granola: access token expired and no refresh token saved — run `lore auth granola` again')
  const res = await (opts.fetchFn ?? fetch)(file.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: file.tokens.refresh_token, client_id: file.client_id, resource: file.resource }),
  })
  const tok = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!tok.access_token) throw new Error(`granola: token refresh failed (${tok.error ?? res.status}): ${tok.error_description ?? ''} — run \`lore auth granola\` again`.trim())
  file.tokens = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? file.tokens.refresh_token,
    expires_at: now() + (tok.expires_in ?? 3600) * 1000,
  }
  writeAuthFile(path, file)
  return file.tokens.access_token
}
