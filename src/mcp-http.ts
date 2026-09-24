import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createServer } from './commands/mcp.js'
import { loreHome, resolveContext } from './context.js'
import { serializeFor } from './queue.js'

/**
 * The hosted MCP server: one HTTP endpoint on the lore host that every agent
 * talks to, instead of a lore install and a clone per agent VM.
 *
 *   POST/GET/DELETE /mcp/<context>      e.g. /mcp/lore-acme
 *
 * Who is calling is not a token the agent holds: on exe.dev the request
 * arrives through a VM-to-VM (peer) integration, and the platform sets
 * `X-Exedev-Source-Vm` to the calling VM's name after stripping anything the
 * caller sent — so the header is an attestation, not a claim. The agents file
 * (`~/.lore/agents.json` on the host) says which contexts each VM may open:
 *
 *   { "accord-agent": { "contexts": ["lore-jointly"] },
 *     "ops-agent":    { "contexts": "*", "actor": "ops" } }
 *
 * A request with no identity header is refused (401): a human on the private
 * exe.dev URL, or anything that bypassed the edge. A VM not in the file, or
 * asking for a context it is not allowed, gets 403. Writes are attributed to
 * the VM name (or the entry's `actor`), so `authorized_by` finally names the
 * agent, not the host's service user.
 *
 * Sessions are the MCP Streamable HTTP kind: `initialize` opens one (its own
 * McpServer over the host's cache clone of the context, under
 * `~/.lore/cache`), later requests carry `mcp-session-id`, and an idle
 * session is closed after a while. Every session on one context shares one
 * clone, so their write tools run one at a time.
 */
export interface McpHttpOptions {
  /** Path of the agents file. Default `<LORE_HOME>/agents.json`. */
  agentsFile?: string
  /** Request header naming the caller. Default `x-exedev-source-vm`. */
  identityHeader?: string
  /** Directory lore commands resolve from (only matters for relative paths). Default cwd. */
  cwd?: string
  /** Close a session idle this long. Default 30 min. */
  idleMs?: number
  log?: (line: string) => void
  /**
   * People, not VMs: OAuth bearer tokens (oauth.ts) for requests that did
   * not come through a peer integration — Claude Code on a laptop. Access
   * follows the person's board role on the context, checked every request.
   */
  users?: UserAuth
}

export interface UserAuth {
  verify(token: string): { email: string; resource?: string } | undefined
  /** "lore-acme" from a token's resource URL, when it is bound to one. */
  contextOf(resource: string | undefined): string | undefined
  /** members: every tool; viewers: read tools; undefined: no access. */
  roleFor(context: string, email: string): 'member' | 'viewer' | undefined
  /** WWW-Authenticate for a 401, pointing at the resource metadata. */
  challenge(req: IncomingMessage, context?: string, error?: string): string
}

export interface AgentGrant {
  /** Context repo names this agent may open, or "*" for every one on the host. */
  contexts: string[] | '*'
  /** Name writes are attributed to. Default: the VM name. */
  actor?: string
}

export type AgentsFile = Record<string, AgentGrant>

interface Session {
  id: string
  /** The VM name, or "user:<email>" for a person over OAuth. */
  agent: string
  readOnly?: boolean
  context: string
  transport: StreamableHTTPServerTransport
  server: McpServer
  lastSeen: number
}

export const MCP_PATH = '/mcp'
export const DEFAULT_IDENTITY_HEADER = 'x-exedev-source-vm'

export function agentsFilePath(): string {
  return join(loreHome(), 'agents.json')
}

export function readAgentsFile(path = agentsFilePath()): AgentsFile {
  if (!existsSync(path)) return {}
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const out: AgentsFile = {}
  for (const [agent, grant] of Object.entries(raw)) {
    if (!grant || typeof grant !== 'object') throw new Error(`${path}: "${agent}" must be an object`)
    const g = grant as Record<string, unknown>
    if (g.contexts !== '*' && !(Array.isArray(g.contexts) && g.contexts.every((c) => typeof c === 'string'))) {
      throw new Error(`${path}: "${agent}".contexts must be a list of context names or "*"`)
    }
    out[agent] = { contexts: g.contexts as string[] | '*', ...(typeof g.actor === 'string' ? { actor: g.actor } : {}) }
  }
  return out
}

/** May this agent open this context? */
export function grantAllows(grant: AgentGrant | undefined, context: string): boolean {
  if (!grant) return false
  return grant.contexts === '*' || grant.contexts.includes(context)
}

export interface McpHttpHandler {
  /** Handle the request if it is under /mcp; returns false (untouched) otherwise. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
  /** Open sessions, for status pages and tests. */
  sessions(): { agent: string; context: string; idleMs: number }[]
  close(): Promise<void>
}

export function createMcpHttpHandler(opts: McpHttpOptions = {}): McpHttpHandler {
  const agentsFile = opts.agentsFile ?? agentsFilePath()
  const header = (opts.identityHeader ?? DEFAULT_IDENTITY_HEADER).toLowerCase()
  const cwd = opts.cwd ?? process.cwd()
  const idleMs = opts.idleMs ?? 30 * 60_000
  const log = opts.log ?? ((line: string) => console.log(`[mcp] ${line}`))
  const sessions = new Map<string, Session>()

  const reaper = setInterval(() => {
    const now = Date.now()
    for (const s of sessions.values()) {
      if (now - s.lastSeen > idleMs) void closeSession(s, 'idle')
    }
  }, 60_000)
  reaper.unref()

  async function closeSession(s: Session, why: string): Promise<void> {
    if (!sessions.delete(s.id)) return
    log(`${s.agent} → ${s.context}: session closed (${why})`)
    try {
      await s.transport.close()
    } catch {
      /* already gone */
    }
    try {
      await s.server.close()
    } catch {
      /* already gone */
    }
  }

  const deny = (res: ServerResponse, code: number, message: string, headers: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== MCP_PATH && !url.pathname.startsWith(`${MCP_PATH}/`)) return false
    const context = url.pathname.slice(MCP_PATH.length + 1).replace(/\/+$/, '')
    const agent = firstHeader(req, header)
    // Who is calling: a VM the exe.dev edge vouched for, or a person with an
    // OAuth token. The edge strips the header from outside callers, so a
    // request carrying it came through a peer integration.
    let caller: { id: string; actor: string; readOnly: boolean; viaOAuth: boolean } | undefined
    if (agent) {
      caller = { id: agent, actor: agent, readOnly: false, viaOAuth: false }
    } else if (opts.users) {
      const users = opts.users
      const bearer = /^Bearer\s+(\S+)$/i.exec(firstHeader(req, 'authorization') ?? '')?.[1]
      const scoped = /^[\w.-]+$/.test(context) ? context : undefined
      if (!bearer) {
        deny(res, 401, 'sign in: this endpoint takes an OAuth bearer token (your MCP client will open a browser)', { 'www-authenticate': users.challenge(req, scoped) })
        return true
      }
      const claims = users.verify(bearer)
      if (!claims) {
        deny(res, 401, 'the access token is invalid or expired', { 'www-authenticate': users.challenge(req, scoped, 'invalid_token') })
        return true
      }
      const bound = users.contextOf(claims.resource)
      if (bound && bound !== context) {
        deny(res, 403, `this token is for ${bound}, not ${context}`)
        return true
      }
      const role = scoped ? users.roleFor(scoped, claims.email) : undefined
      if (scoped && !role) {
        deny(res, 403, `${claims.email} has no board access to ${context} — ask a host admin to add you (lore board add)`)
        return true
      }
      caller = { id: `user:${claims.email}`, actor: claims.email, readOnly: role === 'viewer', viaOAuth: true }
    } else {
      deny(res, 401, `no caller identity: requests must arrive through a peer integration that sets ${header}`)
      return true
    }
    if (!context) {
      deny(res, 404, `name the context in the path: ${MCP_PATH}/<context>`)
      return true
    }
    if (!/^[\w.-]+$/.test(context)) {
      deny(res, 400, 'context must be a repo name')
      return true
    }
    const sessionId = firstHeader(req, 'mcp-session-id')
    let body: unknown
    if (req.method === 'POST') {
      try {
        body = await readJson(req)
      } catch (err) {
        deny(res, 400, `invalid JSON body: ${err instanceof Error ? err.message : err}`)
        return true
      }
    }

    // An existing session: it must belong to this caller and this context.
    if (sessionId) {
      const s = sessions.get(sessionId)
      if (!s) {
        deny(res, 404, 'unknown or expired session — initialize again')
        return true
      }
      if (s.agent !== caller.id || s.context !== context) {
        deny(res, 403, 'session belongs to another caller or context')
        return true
      }
      // A person's role can change mid-session (removed, or made a viewer): start over.
      if (caller.viaOAuth && Boolean(s.readOnly) !== caller.readOnly) {
        await closeSession(s, 'role changed')
        deny(res, 404, 'your access to this board changed — initialize again')
        return true
      }
      s.lastSeen = Date.now()
      if (req.method === 'DELETE') {
        await s.transport.handleRequest(req, res, body)
        await closeSession(s, 'client')
        return true
      }
      await s.transport.handleRequest(req, res, body)
      return true
    }

    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      deny(res, 400, 'no session: send an initialize request first')
      return true
    }

    let actor = caller.actor
    if (!caller.viaOAuth) {
      let grants: AgentsFile
      try {
        grants = readAgentsFile(agentsFile)
      } catch (err) {
        log(`agents file unreadable: ${err instanceof Error ? err.message : err}`)
        deny(res, 500, 'agents file on the host is invalid')
        return true
      }
      const grant = grants[caller.id]
      if (!grantAllows(grant, context)) {
        log(`${caller.id} → ${context}: refused (${grant ? 'context not granted' : 'agent not in agents file'})`)
        deny(res, 403, `${caller.id} is not allowed to open ${context} on this host`)
        return true
      }
      actor = grant!.actor ?? caller.id
    }
    const agentId = caller.id
    const readOnly = caller.readOnly

    // Resolve under the context's write queue: two agents initializing at
    // once must not both `git pull` the same clone.
    const serialize = serializeFor(context)
    let server: McpServer
    try {
      server = await serialize(async () => {
        const ctx = resolveContext(cwd, { context })
        return createServer(ctx, { cwd, opts: { context, actor } }, { serialize, readOnly })
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`${agentId} → ${context}: cannot open (${message.split('\n')[0]})`)
      deny(res, 404, `cannot open ${context}: ${message.split('\n')[0]}`)
      return true
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { id, agent: agentId, context, transport, server, lastSeen: Date.now(), ...(readOnly ? { readOnly } : {}) })
        log(`${agentId} → ${context}: session opened (as ${actor}${readOnly ? ', read-only' : ''})`)
      },
    })
    transport.onclose = () => {
      const id = transport.sessionId
      const s = id ? sessions.get(id) : undefined
      if (s) void closeSession(s, 'transport')
    }
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
    return true
  }

  return {
    handle,
    sessions: () => [...sessions.values()].map((s) => ({ agent: s.agent, context: s.context, idleMs: Date.now() - s.lastSeen })),
    close: async () => {
      clearInterval(reaper)
      await Promise.all([...sessions.values()].map((s) => closeSession(s, 'shutdown')))
    },
  }
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  const s = Array.isArray(v) ? v[0] : v
  return s?.trim() || undefined
}

const MAX_BODY = 4 * 1024 * 1024

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}
