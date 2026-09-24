import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachUpload, ATTACHMENTS_FILE, cleanName, guessType, liveAttachments, parseAttachments, removeAttachment, type AttachmentRecord } from '../attachments.js'
import { gitShow } from '../bare.js'
import { blobStoreFromEnv, MAX_ATTACHMENT_BYTES, TooLarge, writeHashed, type BlobStore } from '../blobs.js'
import { addComment, ticketThread } from '../comments.js'
import { workAdd, workMove, workRank, workSet, type WorkWriteOptions } from '../commands/work.js'
import { serializeFor } from '../queue.js'
import { findItem, labelCounts, summarizeForRecall, WORK_PRIORITIES, WORK_STATUSES, type LoreWorkItem, type RankTarget } from '../work.js'
import { assigneeOptions, bareProject, bareProjects, bareWorkItems, boardRole, type BoardRole } from './access.js'
import { boardSecret, CodeStore, cookieHeader, normalizeEmail, RateLimiter, readCookie, SessionSigner, type Session } from './auth.js'
import { codeEmail, createSendMail, emailConfigFromEnv, type SendMail } from './email.js'
import type { OAuthServer } from '../oauth.js'
import { profilesFile, readProfiles, updateProfile, visiblePeople } from './profiles.js'

/**
 * The board: a list + kanban web view over the lore work tracker, served by
 * `lore www` when LORE_BOARD=1.
 *
 *   /board/*             the SPA (web/, built to web/dist)
 *   /api/board/*         JSON: sign-in, projects, tickets
 *
 * Reads come straight from HEAD of the bare repos (always current). Writes
 * go through the same `lore work` functions the CLI and MCP use — history,
 * audit, commit, push — as `via: web`, signed with the email, one at a time
 * per context on the queue the MCP sessions share.
 */
export interface BoardOptions {
  /** Directory of bare context repos. */
  repos: string
  /** Where `lore work` resolves contexts from. Default cwd. */
  cwd?: string
  /** Emails that are members of every enabled board (and may see the host's status pages). */
  admins?: string[]
  secret?: string
  sendMail?: SendMail
  /** Built SPA. Default: web/dist in the install. */
  webDir?: string
  /** Where attachment bytes live (default: from the environment — see blobs.ts). */
  store?: BlobStore
  log?: (line: string) => void
  /** Test seam. */
  now?: () => number
  /** The host's own status (client health, MCP sessions, playbook) for admins at /api/board/host — supplied by `lore www`. */
  hostStatus?: () => unknown
  /** MCP OAuth (oauth.ts): the board hosts its consent page and "connected apps". */
  oauth?: OAuthServer
  /** Test seam: where OAuth keeps clients and refresh grants. */
  oauthFile?: string
  /** Test seam: where profiles (name, avatar) live. */
  profilesFile?: string
}

export interface BoardHandler {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
  /** The signed-in session on this request, if any. */
  session(req: IncomingMessage): Session | undefined
  isAdmin(req: IncomingMessage): boolean
}

export const BOARD_PATH = '/board'
export const BOARD_API = '/api/board'

export function adminsFromEnv(env = process.env): string[] {
  return (env.LORE_BOARD_ADMINS ?? '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter((e): e is string => Boolean(e))
}

export function createBoardHandler(opts: BoardOptions): BoardHandler {
  const log = opts.log ?? ((line: string) => console.log(`[board] ${line}`))
  const now = opts.now ?? Date.now
  const secret = opts.secret ?? boardSecret()
  const admins = opts.admins ?? adminsFromEnv()
  const signer = new SessionSigner(secret)
  const codes = new CodeStore(secret)
  const sendMail = opts.sendMail ?? createSendMail(emailConfigFromEnv(), log)
  const cwd = opts.cwd ?? process.cwd()
  const webDir = opts.webDir ?? defaultWebDir()
  const store = opts.store ?? blobStoreFromEnv()
  const profiles = opts.profilesFile ?? profilesFile()
  const perEmail = new RateLimiter(5, 3_600_000)
  const perEmailBurst = new RateLimiter(1, 30_000)
  const perIp = new RateLimiter(30, 3_600_000)
  const verifyPerIp = new RateLimiter(60, 3_600_000)

  const session = (req: IncomingMessage) => signer.verify(readCookie(req), now())

  function eligible(email: string): boolean {
    if (admins.includes(email)) return true
    return bareProjects(opts.repos).some((p) => boardRole(p.config, email, admins))
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname
    if (path === BOARD_PATH || path.startsWith(`${BOARD_PATH}/`)) {
      serveStatic(res, webDir, path.slice(BOARD_PATH.length))
      return true
    }
    if (path !== BOARD_API && !path.startsWith(`${BOARD_API}/`)) return false
    const route = path.slice(BOARD_API.length).replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'
    try {
      if (method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'cross-origin request refused' }), true

      // ---- sign-in ----
      if (route === '/login' && method === 'POST') {
        const email = normalizeEmail((await readBody(req)).email)
        if (!email) return send(res, 400, { error: 'enter a valid email address' }), true
        const ip = clientIp(req)
        if (!perIp.allow(ip, now()) || !perEmailBurst.allow(email, now()) || !perEmail.allow(email, now())) {
          return send(res, 429, { error: 'too many codes requested — wait a minute and try again' }), true
        }
        // Same answer, in the same time, whether or not the address has
        // access — so the form can't be used to find out who does. The send
        // is not awaited for that reason; a failure is only in the log.
        if (eligible(email)) {
          const code = codes.create(email, now())
          sendMail(codeEmail(email, code, `${origin(req)}${BOARD_PATH}/`)).then(
            () => log(`code sent to ${email}`),
            (err) => log(`could not send code to ${email}: ${err instanceof Error ? err.message : err}`),
          )
        } else {
          log(`code requested for ${email}: no board access, nothing sent`)
        }
        return send(res, 200, { ok: true }), true
      }
      if (route === '/verify' && method === 'POST') {
        const body = await readBody(req)
        const email = normalizeEmail(body.email)
        const code = typeof body.code === 'string' ? body.code : ''
        if (!email || !/^\s*\d{6}\s*$/.test(code)) return send(res, 400, { error: 'enter the 6-digit code from the email' }), true
        if (!verifyPerIp.allow(clientIp(req), now())) return send(res, 429, { error: 'too many attempts — wait and try again' }), true
        const result = codes.check(email, code.trim(), now())
        // One message for wrong and expired: "expired" would also mean "no code was ever sent", i.e. no access.
        if (result !== 'ok') return send(res, 401, { error: 'that code is not right or has expired — check it, or send a new one' }), true
        const { value } = signer.issue(email, now())
        res.setHeader('set-cookie', cookieHeader(value, { secure: isHttps(req) }))
        log(`${email} signed in`)
        return send(res, 200, { email, admin: admins.includes(email) }), true
      }
      if (route === '/logout' && method === 'POST') {
        res.setHeader('set-cookie', cookieHeader('', { secure: isHttps(req), maxAgeS: 0 }))
        return send(res, 200, { ok: true }), true
      }

      // ---- everything else needs a session ----
      const s = session(req)
      if (!s) return send(res, 401, { error: 'sign in' }), true
      if (signer.stale(s, now())) res.setHeader('set-cookie', cookieHeader(signer.issue(s.email, now()).value, { secure: isHttps(req) }))
      const email = s.email

      if (route === '/me' && method === 'GET') {
        const p = readProfiles(profiles)[email]
        return send(res, 200, { email, admin: admins.includes(email), name: p?.name ?? null, avatar: p?.avatar ?? null }), true
      }

      // ---- profile: display name + avatar, host-wide ----
      if (route === '/profile' && method === 'PATCH') {
        const body = await readBody(req)
        const p = updateProfile(email, { name: typeof body.name === 'string' ? body.name : undefined }, profiles)
        return send(res, 200, { name: p.name ?? null, avatar: p.avatar ?? null }), true
      }
      if (route === '/profile/avatar' && method === 'POST') {
        const type = (header(req, 'content-type') ?? '').split(';')[0].toLowerCase()
        if (!AVATAR_TYPES.has(type)) return send(res, 415, { error: 'avatars are PNG, JPEG, WebP or GIF' }), true
        if (Number(req.headers['content-length']) > MAX_AVATAR) return send(res, 413, { error: 'avatars are limited to 2 MB' }), true
        let got
        try {
          got = await writeHashed(req, store.dir, MAX_AVATAR)
        } catch (err) {
          if (err instanceof TooLarge) return send(res, 413, { error: 'avatars are limited to 2 MB' }), true
          throw err
        }
        await store.put(got.tmp, got.sha, type)
        const p = updateProfile(email, { avatar: got.sha }, profiles)
        log(`${email} set an avatar`)
        return send(res, 200, { name: p.name ?? null, avatar: p.avatar ?? null }), true
      }
      if (route === '/profile/avatar/remove' && method === 'POST') {
        const p = updateProfile(email, { avatar: null }, profiles)
        return send(res, 200, { name: p.name ?? null, avatar: p.avatar ?? null }), true
      }
      if (route === '/people' && method === 'GET') {
        const all = readProfiles(profiles)
        const mine = bareProjects(opts.repos).filter((p) => boardRole(p.config, email, admins))
        const people = visiblePeople(all, email, mine.map((p) => p.config), admins).map((e) => ({ email: e, name: all[e].name ?? null, avatar: all[e].avatar ?? null }))
        // Assignees are names; the projects' contacts say whose email a name is.
        const contacts: Record<string, string> = {}
        for (const p of mine) for (const c of p.config.client?.contacts ?? []) contacts[c.name] = c.email.toLowerCase()
        return send(res, 200, { people, contacts }), true
      }
      const avatarRoute = /^\/avatars\/([a-f0-9]{64})$/.exec(route)
      if (avatarRoute && method === 'GET') {
        const sha = avatarRoute[1]
        const all = readProfiles(profiles)
        const owner = Object.entries(all).find(([, p]) => p.avatar === sha)?.[0]
        const mine = bareProjects(opts.repos).filter((p) => boardRole(p.config, email, admins)).map((p) => p.config)
        const path = owner && visiblePeople(all, email, mine, admins).includes(owner) ? await store.path(sha) : undefined
        if (!path) return send(res, 404, { error: 'no such avatar' }), true
        serveFile(req, res, path, { name: 'avatar', type: 'image/png', ticket: '', source: 'board', by: owner!, at: '' } as AttachmentRecord, true)
        return true
      }

      // ---- MCP OAuth: consent, and the person's connected apps ----
      const oauthReq = /^\/oauth\/request\/([\w-]+)$/.exec(route)
      if (oauthReq && opts.oauth) {
        const r = opts.oauth.request(oauthReq[1])
        if (!r) return send(res, 404, { error: 'this sign-in request has expired — start again from your MCP client' }), true
        const context = opts.oauth.contextOf(r.resource)
        const project = context ? bareProject(opts.repos, context) : undefined
        const role = project ? boardRole(project.config, email, admins) : undefined
        // A mistyped MCP URL names a project that isn't here — say so, not "no access".
        if (context && !project) return send(res, 404, { error: `There's no project called "${context}" on this host — check the URL in your MCP config (the board's Connect Claude Code page has the exact command).` }), true
        if (method === 'GET') {
          const reachable = bareProjects(opts.repos)
            .map((p) => ({ context: p.context, name: p.config.client?.name ?? p.config.project, role: boardRole(p.config, email, admins) }))
            .filter((p) => p.role)
          return send(res, 200, { client: r.client.client_name, redirect: new URL(r.redirect_uri).host, context: context ?? null, role: role ?? null, projects: reachable }), true
        }
        if (method === 'POST') {
          const body = await readBody(req)
          const approve = body.approve === true
          if (approve && context && !role) return send(res, 403, { error: `you don't have access to ${context}` }), true
          const redirect = opts.oauth.decide(r.id, email, approve)
          log(`${email} ${approve ? 'approved' : 'denied'} MCP access for "${r.client.client_name}"${context ? ` to ${context}` : ''}`)
          return send(res, 200, { redirect }), true
        }
      }
      if (route === '/oauth/connections' && method === 'GET' && opts.oauth) return send(res, 200, { connections: opts.oauth.grants(email) }), true
      const revokeRoute = /^\/oauth\/connections\/([\w-]+)\/revoke$/.exec(route)
      if (revokeRoute && method === 'POST' && opts.oauth) {
        return (opts.oauth.revoke(email, revokeRoute[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such connection' })), true
      }

      if (route === '/host' && method === 'GET') {
        if (!admins.includes(email)) return send(res, 403, { error: 'host status is for host admins' }), true
        return send(res, 200, opts.hostStatus?.() ?? {}), true
      }

      if (route === '/projects' && method === 'GET') {
        const projects = bareProjects(opts.repos)
          .map((p) => ({ p, role: boardRole(p.config, email, admins) }))
          .filter((x): x is { p: typeof x.p; role: BoardRole } => Boolean(x.role))
          .map(({ p, role }) => {
            const { prefix, items } = bareWorkItems(opts.repos, p)
            const counts = Object.fromEntries(WORK_STATUSES.map((st) => [st, items.filter((i) => i.status === st).length]))
            return { context: p.context, project: p.config.project, client: p.config.client?.name, prefix, role, archived: p.config.lifecycle === 'archived', counts }
          })
        return send(res, 200, { projects }), true
      }

      const fileRoute = /^\/p\/([\w.-]+)\/files\/([a-f0-9]{64})$/.exec(route)
      const m = fileRoute ? null : /^\/p\/([\w.-]+)(?:\/items(?:\/([\w.-]+)(?:\/(move|rank|thread|comments|files|detach))?)?)?$/.exec(route)
      if (!m && !fileRoute) return send(res, 404, { error: 'not found' }), true
      const [, context, key, action] = (m ?? [route, fileRoute![1], undefined, undefined]) as unknown as [string, string, string | undefined, string | undefined]
      const project = bareProject(opts.repos, context)
      const role = project ? boardRole(project.config, email, admins) : undefined
      // A board you can't see and a board that doesn't exist look the same.
      if (!project || !role) return send(res, 404, { error: 'no such board' }), true
      const bare = join(opts.repos, `${context}.git`)

      // A file: only one this board's record names, so a hash alone opens nothing.
      if (fileRoute && method === 'GET') {
        const sha = fileRoute[2]
        const record = liveAttachments(parseAttachments(gitShow(bare, ATTACHMENTS_FILE, true))).find((r) => r.sha256 === sha)
        const path = record ? await store.path(sha) : undefined
        if (!record || !path) return send(res, 404, { error: 'no such file' }), true
        serveFile(req, res, path, record)
        return true
      }

      if (key && action === 'thread' && method === 'GET') {
        const item = findItem(bareWorkItems(opts.repos, project).items, key)
        if (!item) return send(res, 404, { error: `no item ${key}` }), true
        const attachments = liveAttachments(parseAttachments(gitShow(bare, ATTACHMENTS_FILE, true))).filter((r) => r.ticket === item.key)
        return send(res, 200, { comments: ticketThread(bare, item), attachments }), true
      }

      if (method === 'GET') {
        const { prefix, items } = bareWorkItems(opts.repos, project)
        if (key) {
          const item = findItem(items, key)
          return item ? send(res, 200, { item }) : send(res, 404, { error: `no item ${key}` }), true
        }
        return (
          send(res, 200, {
            context,
            project: project.config.project,
            client: project.config.client?.name,
            prefix,
            role,
            archived: project.config.lifecycle === 'archived',
            statuses: WORK_STATUSES,
            priorities: WORK_PRIORITIES,
            labels: Object.keys(labelCounts(items)).sort((a, b) => a.localeCompare(b)),
            assignees: assigneeOptions(project.config, items),
            items: items.map((i) => summarizeForRecall(i)),
          }),
          true
        )
      }

      if (role !== 'member') return send(res, 403, { error: 'you can view this board but not change it' }), true

      // Uploads are the raw bytes, hashed to a temp file as they stream in
      // (capped), then stored and recorded on the context's write queue.
      if (key && action === 'files' && method === 'POST') {
        const name = cleanName(decodeHeader(header(req, 'x-file-name')) || 'upload')
        const declared = Number(req.headers['content-length'])
        if (declared > MAX_ATTACHMENT_BYTES) return send(res, 413, { error: `files are limited to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` }), true
        let upload
        try {
          upload = await writeHashed(req, store.dir, MAX_ATTACHMENT_BYTES)
        } catch (err) {
          if (err instanceof TooLarge) return send(res, 413, { error: err.message }), true
          throw err
        }
        const type = guessType(name, header(req, 'content-type'))
        const record = await serializeFor(context)(() => attachUpload(cwd, key, { ...upload, name, type }, store, { context, via: 'web', actor: email }))
        return send(res, 201, { attachment: record }), true
      }

      const body = await readBody(req)
      // Assignees come from a fixed list on the board (see assigneeOptions); "" clears.
      if (typeof body.assignee === 'string' && body.assignee.trim()) {
        const options = assigneeOptions(project.config, bareWorkItems(opts.repos, project).items)
        if (!options.includes(body.assignee.trim())) return send(res, 400, { error: `"${body.assignee}" is not someone on this project — pick from the list` }), true
      }
      const reason = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined
      const w: WorkWriteOptions = { context, via: 'web', actor: email }
      const write = (fn: () => LoreWorkItem) => serializeFor(context)(async () => fn())

      if (!key && method === 'POST') {
        const item = await write(() =>
          workAdd(
            cwd,
            {
              title: str(body.title) ?? '',
              description: str(body.description),
              status: str(body.status) as never,
              priority: str(body.priority) as never,
              assignee: str(body.assignee),
              labels: strList(body.labels),
              reason: reason ?? 'added on the board',
            },
            w,
          ),
        )
        return send(res, 201, { item }), true
      }
      if (key && !action && method === 'PATCH') {
        const item = await write(() =>
          workSet(
            cwd,
            key,
            { title: str(body.title), description: str(body.description), priority: str(body.priority) as never, assignee: str(body.assignee), labels: strList(body.labels) },
            { reason: reason ?? 'edited on the board' },
            w,
          ),
        )
        return send(res, 200, { item }), true
      }
      if (key && action === 'move' && method === 'POST') {
        const status = str(body.status)
        const target = rankTarget(body, bareWorkItems(opts.repos, project).items, key)
        const item = await write(() => {
          let item: LoreWorkItem | undefined
          if (status) {
            try {
              item = workMove(cwd, key, status, { reason: reason ?? `moved to ${status} on the board` }, w)
            } catch (err) {
              if (!target || !/is already/.test(String(err))) throw err
            }
          }
          if (target) item = rankQuietly(() => workRank(cwd, key, target, { reason: reason ?? 'reordered on the board' }, w)) ?? item
          if (!item) throw new Error(`nothing to change on ${key}`)
          return item
        })
        return send(res, 200, { item }), true
      }
      if (key && action === 'detach' && method === 'POST') {
        const which = { sha256: str(body.sha256), source_id: str(body.source_id) }
        const record = await serializeFor(context)(async () => removeAttachment(cwd, key, which, { context, via: 'web', actor: email }))
        return send(res, 200, { attachment: record }), true
      }
      if (key && action === 'comments' && method === 'POST') {
        const comment = await serializeFor(context)(async () => addComment(cwd, key, typeof body.body === 'string' ? body.body : '', { context, via: 'web', actor: email }))
        return send(res, 201, { comment }), true
      }
      if (key && action === 'rank' && method === 'POST') {
        const target = rankTarget(body, bareWorkItems(opts.repos, project).items, key)
        if (!target) return send(res, 400, { error: 'give above, top or bottom' }), true
        const item = await write(() => workRank(cwd, key, target, { reason: reason ?? 'reordered on the board' }, w))
        return send(res, 200, { item }), true
      }
      return send(res, 405, { error: 'method not allowed' }), true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof BodyError) return send(res, 400, { error: message }), true
      log(`${method} ${path}: ${message.split('\n')[0]}`)
      return send(res, /no item/.test(message) ? 404 : /archived|not in lore\.json/.test(message) ? 403 : 400, { error: message.split('\n')[0] }), true
    }
  }

  return {
    handle,
    session,
    isAdmin: (req) => {
      const s = session(req)
      return Boolean(s && admins.includes(s.email))
    },
  }
}

// ---- helpers ----

/**
 * Where a dropped card goes. `above: KEY` sits it directly above KEY;
 * `below: KEY` (the end of a kanban column) sits it directly above
 * whatever follows KEY in the whole table, or at the bottom.
 */
function rankTarget(body: Record<string, unknown>, items: LoreWorkItem[], moving: string): RankTarget | undefined {
  if (body.top === true) return { top: true }
  if (body.bottom === true) return { bottom: true }
  if (typeof body.above === 'string' && body.above.trim()) return { above: body.above.trim() }
  if (typeof body.below === 'string' && body.below.trim()) {
    const rest = items.filter((i) => i.key.toUpperCase() !== moving.toUpperCase())
    const at = rest.findIndex((i) => i.key.toUpperCase() === (body.below as string).trim().toUpperCase())
    if (at < 0) throw new Error(`work: no item ${body.below}`)
    const next = rest[at + 1]
    return next ? { above: next.key } : { bottom: true }
  }
  return undefined
}

/** A drop onto the spot an item already holds is not an error. */
function rankQuietly(fn: () => LoreWorkItem): LoreWorkItem | undefined {
  try {
    return fn()
  } catch (err) {
    if (/is already there/.test(String(err))) return undefined
    throw err
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

class BodyError extends Error {}

const MAX_BODY = 256 * 1024

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new BodyError('send JSON (content-type: application/json)')
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length
    if (size > MAX_BODY) throw new BodyError('body too large')
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new BodyError('invalid JSON body')
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() || undefined
}

function isHttps(req: IncomingMessage): boolean {
  return header(req, 'x-forwarded-proto') === 'https'
}

function origin(req: IncomingMessage): string {
  return `${isHttps(req) ? 'https' : 'http'}://${header(req, 'x-forwarded-host') ?? header(req, 'host') ?? 'localhost'}`
}

/** Writes must come from the board's own pages: an Origin, when sent, must name this host. */
function sameOrigin(req: IncomingMessage): boolean {
  const o = header(req, 'origin')
  if (!o) return true
  try {
    const host = header(req, 'x-forwarded-host') ?? header(req, 'host')
    return new URL(o).host === host
  } catch {
    return false
  }
}

/** The address the proxy saw: the last X-Forwarded-For hop (earlier ones are whatever the client sent). */
function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  const last = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop()
  return last ?? req.socket.remoteAddress ?? 'unknown'
}

// ---- files ----

/** RFC 5987-ish: the board sends the file name URI-encoded in a header. */
function decodeHeader(v: string | undefined): string {
  if (!v) return ''
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_AVATAR = 2 * 1024 * 1024

/** An avatar's real type, from its first bytes (it was uploaded as one of AVATAR_TYPES). */
function imageType(path: string): string {
  const b = Buffer.alloc(12)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, b, 0, 12, 0)
  } finally {
    closeSync(fd)
  }
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return 'application/octet-stream'
}

/** Shown in the page: pictures, video, audio, PDF. Everything else downloads. SVG downloads too — it can carry script. */
function inlineType(type: string): boolean {
  return (/^(image|video|audio)\//.test(type) && type !== 'image/svg+xml') || type === 'application/pdf'
}

function serveFile(req: IncomingMessage, res: ServerResponse, path: string, record: AttachmentRecord, sniffImage = false): void {
  const size = statSync(path).size
  const headers: Record<string, string> = {
    'content-type': sniffImage ? imageType(path) : record.type || 'application/octet-stream',
    'content-disposition': `${inlineType(record.type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    // Content-addressed: the bytes behind a hash never change; private, since access is per person.
    'cache-control': 'private, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    // Whatever the file is, it may not run in the board's origin.
    'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    ...SECURITY_HEADERS,
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : size - 1
    if (!range[1]) end = size - 1
    start = Math.max(0, start)
    end = Math.min(end, size - 1)
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
    createReadStream(path, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD') res.end()
  else createReadStream(path).pipe(res)
}

// ---- the SPA ----

function defaultWebDir(): string {
  // dist/board/http.js and src/board/http.ts both sit two levels under the package root.
  return fileURLToPath(new URL('../../web/dist', import.meta.url))
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
}

function serveStatic(res: ServerResponse, root: string, rel: string): void {
  const index = join(root, 'index.html')
  if (!existsSync(index)) {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('the board UI is not built in this install — run `npm run build:web`\n')
    return
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(rel || '/')
  } catch {
    decoded = '/'
  }
  const safe = normalize(decoded).replace(/^([/\\])+/, '')
  let file = join(root, safe)
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) file = index
  const isIndex = file === index
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // Vite fingerprints everything under assets/; the shell must always be fresh.
    'cache-control': isIndex ? 'no-cache' : file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    ...SECURITY_HEADERS,
  })
  res.end(readFileSync(file))
}
