import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendAudit, AUDIT_FILE } from '../audit.js'
import { CONFIG_FILE, configSchema, resolveEnvRefs, sourceSchemas } from '../config.js'
import { connectors } from '../connectors/index.js'
import { git, readGlobalConfig, resolveContext, type GlobalConfig, type ResolvedContext, type ResolveOptions } from '../context.js'
import { sourceStatuses } from '../health.js'
import { loadState } from '../state.js'
import type { Connector } from '../types.js'
import { authorizeWrite, type WriteGateOptions } from '../write.js'

/**
 * The scope fields a source is widened by — the list-shaped keys that say
 * *what* of a vendor belongs to this client. Everything else in a source
 * block (tokens, bases, windows) is credential or tuning, written once when
 * the block is created and never touched by an add.
 */
export const SOURCE_SCOPE: Record<string, { field: string; label: string }> = {
  slack: { field: 'channels', label: 'channel' },
  github: { field: 'repos', label: 'repo' },
  granola: { field: 'folders', label: 'folder' },
  notion: { field: 'roots', label: 'page or database' },
  jira: { field: 'projects', label: 'project key' },
  figma: { field: 'files', label: 'file' },
  gmail: { field: 'users', label: 'mailbox' },
}

/** Connector kinds a source can be added for — the ones with a connector in code. */
export function sourceKinds(registry: Record<string, Connector> = connectors): string[] {
  return Object.keys(registry).filter((k) => k in SOURCE_SCOPE)
}

export interface SourceAddInput {
  /** Connector kind: slack, github, granola, notion, jira, figma, gmail. */
  kind: string
  /** Scope values to add — channels, repos, roots, file URLs, project keys, mailboxes. */
  scope: string[]
  /** jira only: the Atlassian site, required when creating the block without a proxy. */
  site?: string
  /** Configure a *new* source disabled even when its credentials resolve.
   *  Ignored for a source that already exists — parking a working source is
   *  not something an add should be able to do by accident. */
  disabled?: boolean
}

export interface SourceAddResult {
  kind: string
  /** True when the source had no block before this call. */
  created: boolean
  /** Scope values actually added (already-present ones are dropped). */
  added: string[]
  /** Scope values that were already configured. */
  present: string[]
  /** The block as it now stands in lore.json. */
  config: Record<string, unknown>
  disabled: boolean
  /** Why it landed disabled, when it did. */
  blocked?: string
  /** What a human must still do before this source yields anything. */
  next: string[]
}

/**
 * Configure one of the built-in connectors for a client, or widen one that is
 * already configured. This is the *scope* half of onboarding a source — the
 * half that is safe to automate: which channels, repos, pages or files belong
 * to this client. The credential half (a Slack app, an exe.dev integration, a
 * service-account key) stays human, and `next` says what is still owed.
 *
 * A source whose credentials cannot be resolved is written `disabled: true`
 * rather than live, because `sync` treats an unusable source as a failure of
 * the whole run — a new source must never be able to take a client's sync
 * down. Widening a source that already works never disables anything.
 */
export function sourceAdd(
  cwd: string,
  input: SourceAddInput,
  opts: ResolveOptions & WriteGateOptions = {},
  deps: { global?: GlobalConfig; registry?: Record<string, Connector> } = {},
): SourceAddResult {
  const registry = deps.registry ?? connectors
  const kinds = sourceKinds(registry)
  if (!kinds.includes(input.kind)) {
    throw new Error(`no connector for "${input.kind}" — lore syncs ${kinds.join(', ')}; new kinds are a code change, not config`)
  }
  const scope = [...new Set(input.scope.map((s) => s.trim()).filter(Boolean))]
  if (scope.length === 0) throw new Error(`nothing to add: give at least one ${SOURCE_SCOPE[input.kind].label}`)

  const ctx = resolveContext(cwd, opts)
  const actor = authorizeWrite(ctx, opts, `source "${input.kind}"`)
  const { root } = ctx

  const raw = JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8')) as Record<string, unknown>
  const sources = (raw.sources ?? (raw.sources = {})) as Record<string, Record<string, unknown>>
  const existing = sources[input.kind]
  const created = existing === undefined

  const global = deps.global ?? readGlobalConfig()
  const block = existing ?? newBlock(input, global.proxy)
  const { field } = SOURCE_SCOPE[input.kind]
  const current = normalizeScope(block[field])
  const present = scope.filter((v) => current.some((c) => sameScope(input.kind, c, v)))
  const added = scope.filter((v) => !present.includes(v))

  // Nothing new on a source that already exists: leave lore.json alone
  // rather than write an identical file and commit an empty change.
  if (!created && added.length === 0) {
    return { kind: input.kind, created, added, present, config: block, disabled: Boolean(block.disabled), next: [] }
  }

  // gmail's "all" is a scalar scope (every Workspace mailbox), not a member.
  block[field] = input.kind === 'gmail' && scope.includes('all') ? 'all' : [...current, ...added]
  sources[input.kind] = block

  // A source that cannot run must not be live: sync fails the whole client
  // on an unusable source, so an unverifiable credential lands disabled.
  const blocked = created ? credentialGap(input.kind, block) : undefined
  if (created) {
    if (input.disabled || blocked) block.disabled = true
    else delete block.disabled
  }

  const schema = sourceSchemas[input.kind as keyof typeof sourceSchemas]
  if (schema) {
    const parsed = schema.safeParse(block)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(`invalid ${input.kind} config: ${issue.path.join('.') || input.kind}: ${issue.message}`)
    }
  }
  configSchema.parse(raw)

  writeFileSync(join(root, CONFIG_FILE), JSON.stringify(raw, null, 2) + '\n')
  appendAudit(root, {
    at: new Date().toISOString(),
    action: 'source',
    actor,
    via: opts.via ?? 'cli',
    id: input.kind,
    ...(added.length ? { source: added.join(', ') } : {}),
  })

  const verb = created ? 'configure' : 'add to'
  commitSource(ctx, `lore: ${verb} ${input.kind} source (${added.join(', ') || 'no new scope'})`)

  return {
    kind: input.kind,
    created,
    added,
    present,
    config: block,
    disabled: Boolean(block.disabled),
    ...(blocked ? { blocked } : {}),
    next: nextSteps(input.kind, added, created, blocked),
  }
}

/**
 * Every configured source with its scope and its health — what an agent
 * reads before adding one, and what a human reads to find out why a source
 * has gone quiet. Health matters here because a failed source no longer
 * stops the run: it goes stale on its own while everything else keeps
 * syncing, and this is where that shows.
 */
export function sourceList(cwd: string, opts: ResolveOptions = {}, registry: Record<string, Connector> = connectors) {
  const ctx = resolveContext(cwd, opts)
  const health = new Map(sourceStatuses(ctx.config, loadState(ctx.root)).map((h) => [h.source, h]))
  const configured = Object.entries(ctx.config.sources).map(([kind, block]) => {
    const scope = SOURCE_SCOPE[kind]
    const h = health.get(kind)
    return {
      kind,
      scope: scope ? normalizeScope((block as Record<string, unknown>)[scope.field]) : [],
      disabled: Boolean((block as Record<string, unknown>).disabled),
      connector: kind in registry,
      state: h?.state ?? 'ok',
      ...(h?.lastSuccess ? { lastSuccess: h.lastSuccess } : {}),
      ...(h?.staleHours !== undefined ? { staleHours: h.staleHours } : {}),
      ...(h?.error ? { error: h.error } : {}),
    }
  })
  return { project: ctx.config.project, sources: configured, available: sourceKinds(registry).filter((k) => !(k in ctx.config.sources)) }
}

/**
 * A fresh source block: proxy base URLs when the host injects credentials at
 * the edge, `env:` references otherwise. Mirrors what `lore setup` writes, so
 * a source added later is indistinguishable from one configured at onboarding.
 */
export function newBlock(input: SourceAddInput, proxy: GlobalConfig['proxy']): Record<string, unknown> {
  switch (input.kind) {
    case 'slack':
      return proxy?.slack ? { channels: [], api_base: proxy.slack } : { channels: [], token: 'env:SLACK_TOKEN' }
    case 'github':
      return proxy?.github ? { repos: [], api_base: proxy.github } : { repos: [], token: 'env:LORE_GITHUB_TOKEN' }
    case 'granola':
      // Auth is the OAuth grant from `lore auth granola` on the syncing host.
      return proxy?.granola ? { folders: [], endpoint: proxy.granola } : { folders: [] }
    case 'notion':
      return proxy?.notion ? { roots: [], api_base: proxy.notion } : { roots: [], token: 'env:NOTION_TOKEN' }
    case 'figma':
      return proxy?.figma ? { files: [], api_base: proxy.figma } : { files: [], token: 'env:FIGMA_TOKEN' }
    case 'jira':
      return proxy?.jira
        ? { projects: [], api_base: proxy.jira, ...(input.site ? { site: input.site } : {}) }
        : { projects: [], site: input.site ?? 'https://CHANGE-ME.atlassian.net', email: 'env:JIRA_EMAIL', token: 'env:JIRA_TOKEN' }
    case 'gmail':
      // Auth is the service-account key on the syncing host.
      return { users: [] }
    default:
      return {}
  }
}

/**
 * Why a new block can't go live yet, or undefined when it can. Only the
 * credentials *lore.json itself* declares are checkable here: env refs resolve
 * against this machine, and a proxy base is only reachable from the host, so
 * a clean result means "nothing is known to be missing", not "this will sync".
 */
function credentialGap(kind: string, block: Record<string, unknown>): string | undefined {
  const gaps: string[] = []
  const { missing } = resolveEnvRefs(block)
  // Every gap at once: fixing one only to rediscover the next wastes a
  // round trip for a human who has to go and find credentials anyway.
  if (missing.length > 0) gaps.push(`${missing.join(', ')} not set — the host needs ${missing.length > 1 ? 'them' : 'it'} before this source can sync`)
  if (kind === 'jira' && typeof block.site === 'string' && block.site.includes('CHANGE-ME')) {
    gaps.push('no Jira site — pass site (https://<you>.atlassian.net)')
  }
  return gaps.length ? gaps.join('; ') : undefined
}

/** What the human still owes, per source. Scope is config; consent is not. */
function nextSteps(kind: string, added: string[], created: boolean, blocked?: string): string[] {
  const steps: string[] = []
  if (blocked) steps.push(`${blocked}; then drop "disabled": true from the ${kind} source`)
  switch (kind) {
    case 'slack':
      steps.push(`/invite @lore in ${added.join(', ')} — the bot only reads channels it is in`)
      break
    case 'github':
      steps.push(`self-hosted: one read-only GitHub integration per repo on the host (${added.map((r) => `--repository ${r}`).join(', ')})`)
      break
    case 'notion':
      steps.push('share each page with the Notion integration (page ··· → Connections)')
      break
    case 'gmail':
      if (created) steps.push('a Workspace admin must grant domain-wide delegation for gmail.readonly')
      break
    case 'figma':
      steps.push('the token must have access to the file — Slides decks are unsupported by the API; export to PDF and `lore doc add`')
      break
  }
  steps.push('the scope backfills on the next sync — `lore refresh --trigger` to start one now')
  return steps
}

/**
 * Commit and push a config change. Only in cache mode: standing in the
 * context repo itself, the edit is yours to commit, exactly as `remember`
 * and `work` leave it. The host's timer may have pushed a sync commit
 * meanwhile, so a rejected push is rebased once and retried — the same
 * treatment a tracker move gets, for the same reason.
 */
function commitSource(ctx: ResolvedContext, message: string): void {
  const { root, repo } = ctx
  if (ctx.mode !== 'cache' || !existsSync(join(root, '.git'))) return
  git(root, 'add', CONFIG_FILE, AUDIT_FILE)
  git(root, '-c', 'user.name=lore', '-c', 'user.email=lore@localhost', 'commit', '--quiet', '-m', message)
  try {
    git(root, 'push', '--quiet')
  } catch {
    try {
      git(root, '-c', 'user.name=lore', '-c', 'user.email=lore@localhost', 'pull', '--rebase', '--quiet')
      git(root, 'push', '--quiet')
    } catch {
      throw new Error(`wrote ${CONFIG_FILE} and committed to the cache, but push${repo ? ` to ${repo}` : ''} failed — check access, then run \`git -C ${root} push\``)
    }
  }
}

/** `users: "all"` is a scope, not a list; everything else is already one. */
function normalizeScope(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return [value]
  return []
}

/** Slack channels differ only by a leading #; repos and keys are case-insensitive. */
function sameScope(kind: string, a: string, b: string): boolean {
  if (kind === 'slack') return a.replace(/^#/, '').toLowerCase() === b.replace(/^#/, '').toLowerCase()
  return a.toLowerCase() === b.toLowerCase()
}
