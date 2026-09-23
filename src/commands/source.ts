import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUDIT_FILE, appendAudit } from '../audit.js'
import { CONFIG_FILE, KNOWN_SOURCES, configSchema, type SourceName } from '../config.js'
import { git, gitCommit, type GlobalConfig, readGlobalConfig, resolveContext, type ResolveOptions } from '../context.js'
import { formatStale, sourceStatuses, type SourceState } from '../health.js'
import { loadState } from '../state.js'
import { authorizeWrite } from '../write.js'

/**
 * Sources as a write verb. A client's scope grows during an engagement —
 * a second repo, a new channel, the design file once it exists — and the
 * person who knows about it is usually talking to an agent, not editing
 * lore.json. `lore source add` / `lore_source_add` widen one source's scope
 * (or create the source) the way `lore setup` would have: identifiers in
 * the config, credentials never — a proxy base URL when the machine's
 * ~/.lore/config.json names one, an `env:` reference otherwise. The result
 * is validated against the config schema before it is written, audited like
 * every explicit write, and pushed at once in cache mode so the host's next
 * run picks it up; the new scope backfills automatically (cursor seeding).
 *
 * Removing scope is not a verb here on purpose: dropping a repo or channel
 * loses nothing in git but is a human decision (and `disabled: true` keeps
 * cursors and history) — do it by hand.
 */

export interface SourceAddInput {
  /** slack | github | granola | notion | figma | jira | gmail */
  kind: string
  /** Identifiers in the source's own terms: channels, owner/repo, folder titles, Notion page URLs/ids, Figma file URLs/keys, Jira keys / board:<id>, mailboxes ("all"). */
  scope: string[]
  /** Jira only: https://<site>.atlassian.net, for permalinks (and the API when no proxy). */
  site?: string
}

export interface SourceAddOptions extends ResolveOptions {
  /** CLI only: who is adding this. MCP callers can never set it. */
  by?: string
  via?: 'cli' | 'mcp'
  /** Hosted MCP only: the platform-attested caller; see WriteGateOptions. */
  actor?: string
| 'mcp'
}

export interface SourceAdded {
  source: SourceName
  /** True when the source block did not exist before. */
  created: boolean
  /** True when the block was `disabled` and this re-enabled it. */
  reenabled: boolean
  /** Scope entries this call added. */
  added: string[]
  /** Scope entries that were already configured. */
  already: string[]
  /** The resulting source block, as written. */
  config: Record<string, unknown>
  /** Steps only a person can do before the host can read the new scope. */
  next: string[]
  note: string
}

export interface SourceSummary {
  name: string
  disabled: boolean
  /** The scope in the source's own terms. */
  scope: string[]
  /** How the host authenticates: a proxy base URL, an env reference, or credentials it holds itself (Granola token file, Gmail service account). */
  auth: 'proxy' | 'env' | 'host'
  /** Freshness in the shared vocabulary `check`, `recall` and the host page use: ok | stale | never | disabled. */
  state: SourceState
  /** Hours since the last success, when the source is behind. */
  staleHours?: number
  lastSuccess?: string
  lastError?: { at: string; message: string }
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+$/
const FIGMA_URL_RE = /^(?:https?:\/\/)?(?:www\.)?figma\.com\/(design|file|board|deck|slides|proto)\/([A-Za-z0-9]{8,})(?:[/?#]|$)/

/** Sources whose credential is a token the host cannot hold in its environment on a self-hosted install. */
const NEEDS_PROXY: Record<string, keyof NonNullable<GlobalConfig['proxy']> | undefined> = {
  slack: 'slack',
  github: 'github',
  notion: 'notion',
  figma: 'figma',
  jira: 'jira',
  granola: undefined,
  gmail: undefined,
}

export async function sourceAdd(cwd: string, input: SourceAddInput, opts: SourceAddOptions = {}): Promise<SourceAdded> {
  const ctx = resolveContext(cwd, opts)
  const via = opts.via ?? 'cli'
  const actor = authorizeWrite(ctx, opts, 'source')
  const kind = input.kind.trim().toLowerCase()
  if (!(KNOWN_SOURCES as string[]).includes(kind)) throw new Error(`source: "${input.kind}" is not a source lore syncs (one of ${KNOWN_SOURCES.join(', ')})`)

  const path = join(ctx.root, CONFIG_FILE)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const sources = ((raw.sources ??= {}) as Record<string, Record<string, unknown>>)
  const existing = sources[kind]
  const global = readGlobalConfig()

  const plan = applyScope(kind as SourceName, existing, input.scope, input.site, global)
  if (plan.added.length === 0 && !plan.reenabled && !plan.changed) {
    return {
      source: kind as SourceName,
      created: false,
      reenabled: false,
      added: [],
      already: plan.already,
      config: existing ?? plan.block,
      next: [],
      note: existing ? `${kind} already covers ${plan.already.join(', ') || 'this scope'} — nothing changed` : 'nothing to add',
    }
  }

  sources[kind] = plan.block
  // Validate the whole file as lore would load it, before touching disk.
  const check = configSchema.safeParse(structuredClone(raw))
  if (!check.success) {
    const why = check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`source: the resulting lore.json would be invalid — ${why}`)
  }

  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n')
  appendAudit(ctx.root, {
    at: new Date().toISOString(),
    action: 'source',
    actor,
    via,
    id: kind,
    source: plan.added.join(', ') || (plan.reenabled ? 're-enabled' : 'updated'),
  })

  const what = plan.added.length ? plan.added.join(', ') : plan.reenabled ? 're-enable' : 'update'
  if (ctx.mode === 'cache') {
    git(ctx.root, 'add', CONFIG_FILE, AUDIT_FILE)
    gitCommit(ctx.root, '--quiet', '-m', `lore: source add ${kind} ${what}`)
    try {
      git(ctx.root, 'push', '--quiet')
    } catch {
      throw new Error(`updated ${CONFIG_FILE} and committed to the cache, but push to ${ctx.repo} failed — check access, then run \`git -C ${ctx.root} push\``)
    }
  }

  const months = typeof (raw.backfill as { months?: number } | undefined)?.months === 'number' ? (raw.backfill as { months: number }).months : 0
  const result: SourceAdded = {
    source: kind as SourceName,
    created: !existing,
    reenabled: plan.reenabled,
    added: plan.added,
    already: plan.already,
    config: plan.block,
    next: plan.next,
    note: `${existing ? 'widened' : 'added'} sources.${kind}${plan.added.length ? `: ${plan.added.join(', ')}` : ''}${plan.reenabled ? ' (re-enabled)' : ''}${ctx.repo ? ` → ${ctx.repo}` : ''}. The host's next sync backfills the new scope ${months ? `${months} month(s) back` : 'from now'} and then follows it; \`lore refresh --trigger\` / lore_sync_now starts that now${plan.next.length ? ' — once the steps in `next` are done' : ''}.`,
  }
  if (via === 'cli') {
    console.log(result.note)
    for (const n of plan.next) console.log(`  - ${n}`)
    if (plan.already.length) console.log(`  (already configured: ${plan.already.join(', ')})`)
  }
  return result
}

interface Plan {
  block: Record<string, unknown>
  added: string[]
  already: string[]
  reenabled: boolean
  /** A field other than scope changed (e.g. jira site set). */
  changed: boolean
  next: string[]
}

/**
 * Pure: the new source block for `kind` given the existing one (if any) and
 * the scope entries to add. Exported for tests; `sourceAdd` does the I/O.
 */
export function applyScope(kind: SourceName, existing: Record<string, unknown> | undefined, scope: string[], site: string | undefined, global: GlobalConfig): Plan {
  const entries = scope.map((s) => s.trim()).filter(Boolean)
  const proxy = global.proxy ?? {}
  const block: Record<string, unknown> = { ...(existing ?? {}) }
  const next: string[] = []
  let reenabled = false
  let changed = false
  if (block.disabled === true) {
    delete block.disabled
    reenabled = true
  }

  // A new block needs to say how the host authenticates. Self-hosted (a
  // `remote` is configured) means tokens live in proxies, never on the host,
  // so a kind with no proxy configured cannot be added from here.
  const proxyKey = NEEDS_PROXY[kind]
  const proxyBase = proxyKey ? proxy[proxyKey] : undefined
  if (!existing && proxyKey && !proxyBase && global.remote) {
    throw new Error(`source: this machine has no proxy for ${kind} in ~/.lore/config.json (proxy.${proxyKey}) and the self-hosted host holds no ${kind} token — add the proxy, or configure sources.${kind} by hand`)
  }

  const merge = (field: string, values: string[]): { added: string[]; already: string[] } => {
    const current = Array.isArray(block[field]) ? (block[field] as unknown[]).map(String) : []
    const added: string[] = []
    const already: string[] = []
    for (const v of values) (current.includes(v) ? already : added).push(v)
    if (added.length || !Array.isArray(block[field])) block[field] = [...current, ...added]
    return { added, already }
  }

  let res: { added: string[]; already: string[] } = { added: [], already: [] }
  switch (kind) {
    case 'slack': {
      const channels = entries.map((c) => (c.startsWith('#') ? c : `#${c}`))
      if (!channels.length) throw new Error('source: slack needs at least one channel, e.g. "#acme-dev"')
      res = merge('channels', channels)
      if (!existing) Object.assign(block, proxyBase ? { api_base: proxyBase } : { token: 'env:SLACK_TOKEN' })
      for (const c of res.added) next.push(`/invite @lore in ${c} — a bot cannot join a channel by itself; until then the sync reports not_in_channel`)
      break
    }
    case 'github': {
      if (!entries.length) throw new Error('source: github needs at least one "owner/repo"')
      for (const r of entries) if (!REPO_RE.test(r)) throw new Error(`source: "${r}" is not "owner/repo"`)
      res = merge('repos', entries)
      if (!existing) Object.assign(block, proxyBase ? { api_base: proxyBase } : { token: 'env:LORE_GITHUB_TOKEN' })
      for (const r of res.added) {
        next.push(
          block.api_base
            ? `give the host read access to ${r}: \`ssh exe.dev integrations add github --name ${r.replace('/', '-')} --repository ${r} --readonly --attach tag:lore\` (or attach the existing integration: \`ssh exe.dev integrations attach <name> tag:lore\`); until then the sync reports "not found or token lacks access"`
            : `the token behind ${String(block.token)} must have read access to ${r}`,
        )
      }
      break
    }
    case 'granola': {
      if (!entries.length) throw new Error('source: granola needs at least one folder title (as it appears in Granola)')
      res = merge('folders', entries)
      if (!existing && proxy.granola) block.endpoint = proxy.granola
      if (res.added.length) next.push(`folder titles must match Granola exactly (${res.added.join(', ')}); the host's own Granola login must be able to see them`)
      break
    }
    case 'notion': {
      if (!entries.length) throw new Error('source: notion needs at least one page or database URL/id')
      res = merge('roots', entries)
      if (!existing) Object.assign(block, proxyBase ? { api_base: proxyBase } : { token: 'env:NOTION_TOKEN' })
      for (const r of res.added) next.push(`connect the lore Notion integration to ${r} (page ··· → Connections) — nothing under it syncs until it is shared`)
      break
    }
    case 'figma': {
      if (!entries.length) throw new Error('source: figma needs at least one file URL or key')
      for (const f of entries) {
        const m = FIGMA_URL_RE.exec(f)
        if (m && (m[1] === 'deck' || m[1] === 'slides')) {
          throw new Error(`source: ${f} is a Figma Slides deck — Figma's API does not serve decks; export it as PDF and \`lore doc add\` it instead`)
        }
        if (!m && !/^[A-Za-z0-9]{8,}$/.test(f)) throw new Error(`source: "${f}" is not a Figma file URL or key`)
      }
      res = merge('files', entries)
      if (!existing) Object.assign(block, proxyBase ? { api_base: proxyBase } : { token: 'env:FIGMA_TOKEN' })
      if (res.added.length) next.push('the Figma account behind the host\'s token must have access to the file (it is a personal token; ask its owner to accept the file invite)')
      break
    }
    case 'jira': {
      const projects = entries.filter((e) => !/^board:/i.test(e)).map((k) => k.toUpperCase())
      const boards = entries.filter((e) => /^board:/i.test(e)).map((e) => Number(e.split(':')[1]))
      if (!projects.length && !boards.length && !site) throw new Error('source: jira needs project keys (ACM) and/or boards (board:293)')
      for (const p of projects) if (!JIRA_KEY_RE.test(p)) throw new Error(`source: "${p}" is not a Jira project key (uppercase, e.g. ACM)`)
      if (boards.some((b) => !Number.isInteger(b) || b <= 0)) throw new Error('source: jira board entries look like "board:293"')
      const a: string[] = []
      const b: string[] = []
      if (projects.length) {
        const r = merge('projects', projects)
        a.push(...r.added)
        b.push(...r.already)
      }
      if (boards.length) {
        const current = Array.isArray(block.boards) ? (block.boards as number[]) : []
        const fresh = boards.filter((n) => !current.includes(n))
        if (fresh.length || !Array.isArray(block.boards)) block.boards = [...current, ...fresh]
        a.push(...fresh.map((n) => `board:${n}`))
        b.push(...boards.filter((n) => current.includes(n)).map((n) => `board:${n}`))
      }
      if (Array.isArray(block.boards) && (block.boards as number[]).length === 0) delete block.boards
      if (Array.isArray(block.projects) && (block.projects as string[]).length === 0) delete block.projects
      res = { added: a, already: b }
      if (site && block.site !== site) {
        block.site = site
        changed = true
      }
      if (!existing) {
        if (proxyBase) block.api_base = proxyBase
        else Object.assign(block, { site: site ?? 'https://CHANGE-ME.atlassian.net', email: 'env:JIRA_EMAIL', token: 'env:JIRA_TOKEN' })
      }
      if (!block.site) next.push('set `site` (https://<site>.atlassian.net) on sources.jira so issues get permalinks — pass --site / site')
      if (res.added.length) next.push('the Jira account behind the host\'s credentials must be able to browse the project/board')
      break
    }
    case 'gmail': {
      const lower = entries.map((e) => e.toLowerCase())
      const all = lower.includes('all')
      const users = lower.filter((e) => e !== 'all')
      for (const u of users) if (!EMAIL_RE.test(u)) throw new Error(`source: "${u}" is not an email address (or "all")`)
      if (existing) {
        if (block.users === 'all') {
          res = { added: [], already: [...(all ? ['all'] : []), ...users] }
        } else if (all) {
          block.users = 'all'
          res = { added: ['all'], already: [] }
        } else if (users.length) {
          res = merge('users', users)
        } else {
          res = { added: [], already: [] }
        }
      } else {
        if (all) block.users = 'all'
        else if (users.length) block.users = users
        // else {}: the team-side contacts' mailboxes
        res = { added: all ? ['all'] : users.length ? users : ['team contacts'], already: [] }
      }
      if (res.added.length) {
        next.push('the Workspace service account key must be on the host (~/.lore/gmail-sa.json) with domain-wide delegation for gmail.readonly' + (all ? ' and admin.directory.user.readonly (users: "all" lists the directory as client.owner / admin)' : ''))
        next.push('tell the teammates whose inboxes this reads; put any mailbox that must never be read in sources.gmail.exclude')
      }
      break
    }
  }

  return { block, added: res.added, already: res.already, reenabled, changed, next }
}

export function sourceList(cwd: string, opts: ResolveOptions & { json?: boolean } = {}): SourceSummary[] {
  const ctx = resolveContext(cwd, opts)
  const state = loadState(ctx.root)
  const health = state.sources ?? {}
  // Since a failed source no longer stops the run, this is where a source
  // that is quietly behind shows up — classified the same way everywhere.
  const status = new Map(sourceStatuses(ctx.config, state).map((x) => [x.source, x]))
  const out: SourceSummary[] = Object.entries(ctx.config.sources).map(([name, cfg]) => {
    const c = cfg as Record<string, unknown>
    const h = health[name]
    const st = status.get(name)
    return {
      name,
      disabled: c.disabled === true,
      scope: scopeOf(name, c),
      auth: c.api_base || c.endpoint ? 'proxy' : c.token || c.key ? 'env' : 'host',
      state: st?.state ?? 'ok',
      ...(st?.staleHours !== undefined ? { staleHours: st.staleHours } : {}),
      ...(h?.lastSuccess ? { lastSuccess: h.lastSuccess } : {}),
      ...(h?.lastError ? { lastError: h.lastError } : {}),
    }
  })
  if (opts.json) console.log(JSON.stringify(out, null, 2))
  else if (out.length === 0) console.log('no sources configured — `lore source add <kind> <scope…>`')
  else {
    for (const s of out) {
      const mark = s.state === 'disabled' ? '–' : s.state === 'ok' ? '✓' : '✗'
      const behind = s.state === 'stale' ? `  stale ${formatStale(s.staleHours ?? 0)}` : s.state === 'never' ? '  never synced' : ''
      console.log(`${mark} ${s.name.padEnd(8)} ${s.scope.join(', ') || '(default scope)'}  [${s.auth}]${s.disabled ? ' disabled' : ''}${behind}`)
      if (s.lastSuccess) console.log(`    last success: ${s.lastSuccess}`)
      if (s.lastError) console.log(`    last error:   ${s.lastError.at} — ${s.lastError.message}`)
    }
  }
  return out
}

/** The scope of a source block in its own terms, for listing. */
export function scopeOf(name: string, c: Record<string, unknown>): string[] {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
  switch (name) {
    case 'slack':
      return list(c.channels)
    case 'github':
      return list(c.repos)
    case 'granola':
      return [...list(c.folders), ...list(c.attendee_domains).map((d) => `@${d}`)]
    case 'notion':
      return list(c.roots)
    case 'figma':
      return [...list(c.files), ...list(c.projects).map((p) => `project:${p}`)]
    case 'jira':
      return [...list(c.projects), ...list(c.boards).map((b) => `board:${b}`)]
    case 'gmail':
      return c.users === 'all' ? ['all mailboxes'] : list(c.users).length ? list(c.users) : ['team contacts']
    default:
      return []
  }
}
