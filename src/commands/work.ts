import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { AUDIT_FILE, appendAudit } from '../audit.js'
import { git, resolveContext, type ResolvedContext, type ResolveOptions } from '../context.js'
import { authorizeWrite } from '../write.js'
import {
  applyChange,
  canonicalLabel,
  findItem,
  hasLabel,
  nextKey,
  rankItem,
  readExternalIssues,
  readWorkItems,
  stateFor,
  summarizeForRecall,
  WORK_PRIORITIES,
  WORK_STATUSES,
  workPrefix,
  writeWorkItems,
  type ExternalRef,
  type LoreWorkItem,
  type RankTarget,
  type WorkItemSummary,
  type WorkPriority,
  type WorkStatus,
} from '../work.js'

export interface WorkWriteOptions extends ResolveOptions {
  /** CLI only: who is doing this. MCP callers can never set it. */
  by?: string
  via?: 'cli' | 'mcp' | 'web'
  /** Hosted MCP only: the platform-attested caller; see WriteGateOptions. */
  actor?: string
| 'mcp'
  /** Test seam. */
  at?: string
}

export interface WorkAddInput {
  title: string
  description?: string
  status?: WorkStatus
  priority?: WorkPriority
  assignee?: string
  labels?: string[]
  sources?: string[]
  /** "jira:INPT-9" or "github:owner/repo#42" — link an existing tracker issue. */
  external?: string
  reason?: string
}

export interface WorkSetInput {
  title?: string
  /** Markdown body; "" clears it. */
  description?: string
  priority?: WorkPriority
  assignee?: string
  labels?: string[]
  /** Add evidence links. */
  sources?: string[]
  external?: string
}

export interface ChangeInput {
  reason: string
  sources?: string[]
}

/**
 * Every explicit write to the tracker: resolve the context, pass the write
 * gate, read the table, apply one mutation, write, audit, and in cache mode
 * commit and push at once — the `remember` family's contract. `fn` returns
 * the item touched and the commit subject.
 */
function mutate(
  cwd: string,
  opts: WorkWriteOptions,
  fn: (items: LoreWorkItem[], prefix: string, actor: string, at: string) => { item: LoreWorkItem; message: string; source?: string },
): LoreWorkItem {
  const ctx = resolveContext(cwd, opts)
  const via = opts.via ?? 'cli'
  const actor = authorizeWrite(ctx, opts, 'work item change')
  const at = opts.at ?? new Date().toISOString()
  const prefix = workPrefix(ctx.config)
  const items = readWorkItems(ctx.root, prefix)
  const { item, message, source } = fn(items, prefix, actor, at)
  const rel = writeWorkItems(ctx.root, prefix, items)
  appendAudit(ctx.root, { at, action: 'work', actor, via, id: item.key, ...(source ? { source } : {}) })
  commitWork(ctx, rel, `lore: work ${message}`)
  if (via === 'cli') console.log(`${message}${ctx.repo ? ` → ${ctx.repo}` : ''}`)
  return item
}

/**
 * Commit and push a tracker change in cache mode. The host's timer may have
 * pushed a sync commit meanwhile, so a rejected push is rebased once and
 * retried before giving up — a ticket move must not be lost to timing.
 */
export function commitWork(ctx: ResolvedContext, rel: string | string[], message: string): void {
  if (ctx.mode !== 'cache') return
  git(ctx.root, 'add', ...(Array.isArray(rel) ? rel : [rel]), AUDIT_FILE)
  git(ctx.root, '-c', 'user.name=lore', '-c', 'user.email=lore@localhost', 'commit', '--quiet', '-m', message)
  try {
    git(ctx.root, 'push', '--quiet')
  } catch {
    try {
      git(ctx.root, '-c', 'user.name=lore', '-c', 'user.email=lore@localhost', 'pull', '--rebase', '--quiet')
      git(ctx.root, 'push', '--quiet')
    } catch {
      throw new Error(`wrote ${rel} and committed to the cache, but push to ${ctx.repo} failed — check access, then run \`git -C ${ctx.root} push\``)
    }
  }
}

/**
 * The batch form of `mutate` for commands that touch several tickets in one
 * pass (`work push`): one write, one audit line per touched ticket, one
 * commit. `fn` may call out (Jira) between reading and returning.
 */
export async function mutateBatch(
  cwd: string,
  opts: WorkWriteOptions,
  noun: string,
  fn: (items: LoreWorkItem[], prefix: string, actor: string, at: string, ctx: ResolvedContext) => Promise<{ touched: { key: string; source?: string }[]; message: string }>,
): Promise<void> {
  const ctx = resolveContext(cwd, opts)
  const via = opts.via ?? 'cli'
  const actor = authorizeWrite(ctx, opts, noun)
  const at = opts.at ?? new Date().toISOString()
  const prefix = workPrefix(ctx.config)
  const items = readWorkItems(ctx.root, prefix)
  const { touched, message } = await fn(items, prefix, actor, at, ctx)
  if (touched.length === 0) return
  const rel = writeWorkItems(ctx.root, prefix, items)
  for (const t of touched) appendAudit(ctx.root, { at, action: 'work', actor, via, id: t.key, ...(t.source ? { source: t.source } : {}) })
  commitWork(ctx, rel, `lore: work ${message}`)
}

function requireStatus(s: string | undefined): WorkStatus | undefined {
  if (s === undefined) return undefined
  if (!(WORK_STATUSES as string[]).includes(s)) throw new Error(`work: status must be one of ${WORK_STATUSES.join(', ')}`)
  return s as WorkStatus
}

function requirePriority(p: string | undefined): WorkPriority | undefined {
  if (p === undefined) return undefined
  const up = p.toUpperCase()
  if (!(WORK_PRIORITIES as string[]).includes(up)) throw new Error(`work: priority must be one of ${WORK_PRIORITIES.join(', ')}`)
  return up as WorkPriority
}

function requireReason(input: { reason?: string }, verb: string): string {
  const r = input.reason?.trim()
  if (!r) throw new Error(`work ${verb}: --reason is required — every move is recorded with why it happened`)
  return r
}

function requireItem(items: LoreWorkItem[], key: string): LoreWorkItem {
  const item = findItem(items, key)
  if (!item) throw new Error(`work: no item ${key}`)
  return item
}

function cleanList(list: string[] | undefined): string[] | undefined {
  if (!list) return undefined
  const out = list.map((s) => s.trim()).filter(Boolean)
  return out
}

/** "jira:INPT-9" / "github:owner/repo#42" → an ExternalRef, with the tracker's state when its table has the issue. */
function resolveExternal(ctx: ResolvedContext, spec: string): ExternalRef {
  const m = /^(jira|github|linear):(.+)$/i.exec(spec.trim())
  if (!m) throw new Error('work: --external must be "jira:<KEY>", "github:<owner>/<repo>#<n>" or "linear:<KEY>"')
  const system = m[1].toLowerCase() as 'jira' | 'github' | 'linear'
  const rest = m[2].trim()
  const id = system === 'github' ? `github:${rest}` : `${system}:${rest.toUpperCase()}`
  const known = readExternalIssues(ctx.root).find((i) => i.ref.id === id)
  if (known) return known.ref
  if (system === 'linear') {
    if (!/^[A-Z][A-Z0-9]*-\d+$/i.test(rest)) throw new Error('work: --external linear form is "linear:<TEAM>-<n>", e.g. linear:PRP-12')
    return { system, id, key: rest.toUpperCase(), url: '', status: 'unknown', category: 'unknown' }
  }
  if (system === 'jira') {
    const site = ((ctx.config.sources.jira as { site?: string } | undefined)?.site ?? '').replace(/\/$/, '')
    return { system, id, key: rest.toUpperCase(), url: site ? `${site}/browse/${rest.toUpperCase()}` : '', status: 'unknown', category: 'unknown' }
  }
  const gh = /^([^/#]+\/[^/#]+)#(\d+)$/.exec(rest)
  if (!gh) throw new Error('work: --external github form is "github:<owner>/<repo>#<n>"')
  return { system, id, key: `#${gh[2]}`, url: `https://github.com/${gh[1]}/issues/${gh[2]}`, status: 'unknown', category: 'unknown' }
}

export function workAdd(cwd: string, input: WorkAddInput, opts: WorkWriteOptions = {}): LoreWorkItem {
  const title = input.title?.trim()
  if (!title) throw new Error('work add: a title is required')
  const status = requireStatus(input.status) ?? 'todo'
  const priority = requirePriority(input.priority)
  return mutate(cwd, opts, (items, prefix, actor, at) => {
    const ctx = resolveContext(cwd, opts)
    const external = input.external ? resolveExternal(ctx, input.external) : undefined
    if (external && items.some((i) => i.external?.id === external.id)) {
      throw new Error(`work add: ${external.id} is already tracked as ${items.find((i) => i.external?.id === external.id)!.key}`)
    }
    const sources = cleanList(input.sources) ?? []
    if (external?.url && !sources.includes(external.url)) sources.push(external.url)
    const item: LoreWorkItem = {
      key: nextKey(items, prefix),
      title,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      status,
      state: stateFor(status),
      ...(priority ? { priority } : {}),
      ...(input.assignee?.trim() ? { assignee: input.assignee.trim() } : {}),
      labels: cleanList(input.labels) ?? [],
      ...(external ? { external } : {}),
      sources,
      created: at.slice(0, 10),
      updated: at.slice(0, 10),
      history: [
        {
          at,
          by: actor,
          via: opts.via ?? 'cli',
          change: { created: true },
          reason: input.reason?.trim() || (external ? `linked to ${external.system} ${external.key}` : 'added'),
          ...(sources.length ? { sources } : {}),
        },
      ],
    }
    items.push(item)
    return { item, message: `add ${item.key}: ${title}`, source: sources[0] }
  })
}

/** Turn a derived request (req-0007) into a tracked item, keeping its evidence. */
export function workPromote(cwd: string, requestId: string, input: { title?: string; priority?: WorkPriority; reason?: string } = {}, opts: WorkWriteOptions = {}): LoreWorkItem {
  const ctx = resolveContext(cwd, opts)
  const path = join(ctx.root, 'context/derived/requests.yaml')
  const requests = existsSync(path) ? ((parse(readFileSync(path, 'utf8')) as Record<string, unknown>[] | null) ?? []) : []
  const req = requests.find((r) => r.id === requestId.trim())
  if (!req) throw new Error(`work promote: no derived request ${requestId} (see \`lore recall requests\`)`)
  const priority = requirePriority(input.priority)
  return mutate(cwd, opts, (items, prefix, actor, at) => {
    const already = items.find((i) => i.request === req.id)
    if (already) throw new Error(`work promote: ${req.id} is already tracked as ${already.key}`)
    const source = typeof req.source === 'string' ? req.source : undefined
    const item: LoreWorkItem = {
      key: nextKey(items, prefix),
      title: input.title?.trim() || String(req.request ?? req.id),
      status: 'todo',
      state: 'open',
      ...(priority ? { priority } : {}),
      labels: [],
      request: String(req.id),
      sources: source ? [source] : [],
      created: at.slice(0, 10),
      updated: at.slice(0, 10),
      history: [
        {
          at,
          by: actor,
          via: opts.via ?? 'cli',
          change: { created: true },
          reason: input.reason?.trim() || `promoted from ${req.id}${req.requested_by ? ` (asked by ${req.requested_by}${req.date ? `, ${req.date}` : ''})` : ''}`,
          ...(source ? { sources: [source] } : {}),
        },
      ],
    }
    items.push(item)
    return { item, message: `promote ${req.id} → ${item.key}: ${item.title}`, source }
  })
}

export function workMove(cwd: string, key: string, status: string, input: ChangeInput, opts: WorkWriteOptions = {}): LoreWorkItem {
  const to = requireStatus(status)!
  const reason = requireReason(input, 'move')
  return mutate(cwd, opts, (items, _prefix, actor, at) => {
    const item = requireItem(items, key)
    const from = item.status
    const change = applyChange(item, { status: to }, { at, by: actor, via: opts.via ?? 'cli', reason, sources: cleanList(input.sources) })
    if (Object.keys(change).length === 0) throw new Error(`work move: ${item.key} is already ${to}`)
    return { item, message: `move ${item.key} ${from} → ${to} (${reason})`, source: input.sources?.[0] }
  })
}

export function workSet(cwd: string, key: string, fields: WorkSetInput, input: ChangeInput, opts: WorkWriteOptions = {}): LoreWorkItem {
  const reason = requireReason(input, 'set')
  const priority = requirePriority(fields.priority)
  return mutate(cwd, opts, (items, _prefix, actor, at) => {
    const ctx = resolveContext(cwd, opts)
    const item = requireItem(items, key)
    const extra: Record<string, unknown> = {}
    if (fields.external !== undefined) {
      const ext = resolveExternal(ctx, fields.external)
      const clash = items.find((i) => i !== item && i.external?.id === ext.id)
      if (clash) throw new Error(`work set: ${ext.id} is already linked to ${clash.key}`)
      if (item.external?.id !== ext.id) {
        extra.external = [item.external?.id ?? null, ext.id]
        item.external = ext
        if (ext.url && !item.sources.includes(ext.url)) item.sources.push(ext.url)
      }
    }
    const sources = [...new Set([...(cleanList(input.sources) ?? []), ...(cleanList(fields.sources) ?? [])])]
    // Attaching evidence is a change in its own right — a link with no other
    // field alongside it must still land on the item (and in its history).
    const added = sources.filter((s) => !item.sources.includes(s))
    if (added.length) extra.sources = [item.sources.slice(), [...item.sources, ...added]]
    const change = applyChange(
      item,
      {
        ...(fields.title?.trim() ? { title: fields.title.trim() } : {}),
        ...(fields.description !== undefined ? { description: fields.description.trim() || undefined } : {}),
        ...(priority ? { priority } : {}),
        ...(fields.assignee !== undefined ? { assignee: fields.assignee.trim() || undefined } : {}),
        ...(fields.labels ? { labels: cleanList(fields.labels) } : {}),
      },
      { at, by: actor, via: opts.via ?? 'cli', reason, sources: sources.length ? sources : undefined },
      extra,
    )
    if (Object.keys(change).length === 0) throw new Error(`work set: nothing changed on ${item.key} (every field already has that value; every source is already attached)`)
    return { item, message: `set ${item.key} ${Object.keys(change).join(', ')} (${reason})`, source: sources[0] }
  })
}

export interface WorkLabelResult {
  /** Items whose labels changed, with their labels after. */
  labeled: { key: string; title: string; labels: string[] }[]
  /** Items that already had (or already lacked) the labels. */
  unchanged: string[]
}

/**
 * Add or remove project labels — a theme, epic or workstream ("onboarding",
 * "stripe integration") — on several tickets in one change: one write, one
 * commit, one history entry per ticket touched. Every key must exist or
 * nothing is written. A label the project already uses keeps its spelling,
 * so "Stripe Integration" and "stripe integration" stay one label.
 */
export async function workLabel(
  cwd: string,
  keys: string[],
  change: { add?: string[]; remove?: string[] },
  input: ChangeInput,
  opts: WorkWriteOptions = {},
): Promise<WorkLabelResult> {
  const reason = requireReason(input, 'label')
  const add = cleanList(change.add) ?? []
  const remove = cleanList(change.remove) ?? []
  if (add.length === 0 && remove.length === 0) throw new Error('work label: give a label to add or remove')
  const wanted = [...new Set((cleanList(keys) ?? []).map((k) => k.toUpperCase()))]
  if (wanted.length === 0) throw new Error('work label: give at least one ticket key')
  const result: WorkLabelResult = { labeled: [], unchanged: [] }
  await mutateBatch(cwd, opts, 'work item change', async (items, _prefix, actor, at) => {
    const missing = wanted.filter((k) => !findItem(items, k))
    if (missing.length) throw new Error(`work label: no item ${missing.join(', ')} — nothing labeled`)
    const adding = add.map((l) => canonicalLabel(items, l))
    for (const key of wanted) {
      const item = findItem(items, key)!
      const labels = [...item.labels.filter((l) => !hasLabel(remove, l)), ...adding.filter((l) => !hasLabel(item.labels, l) && !hasLabel(remove, l))]
      const applied = applyChange(item, { labels }, { at, by: actor, via: opts.via ?? 'cli', reason, sources: cleanList(input.sources) })
      if (Object.keys(applied).length) result.labeled.push({ key: item.key, title: item.title, labels: item.labels })
      else result.unchanged.push(item.key)
    }
    const what = [adding.length ? `+${adding.join(', +')}` : '', remove.length ? `-${remove.join(', -')}` : ''].filter(Boolean).join(' ')
    return { touched: result.labeled.map((l) => ({ key: l.key })), message: `label ${result.labeled.map((l) => l.key).join(', ')} ${what} (${reason})` }
  })
  if ((opts.via ?? 'cli') === 'cli') {
    for (const l of result.labeled) console.log(`${l.key.padEnd(8)} ${l.labels.join(', ') || '(no labels)'}  ${l.title}`)
    if (result.unchanged.length) console.log(`unchanged: ${result.unchanged.join(', ')}`)
  }
  return result
}

export function workRank(cwd: string, key: string, target: RankTarget, input: ChangeInput, opts: WorkWriteOptions = {}): LoreWorkItem {
  const reason = requireReason(input, 'rank')
  return mutate(cwd, opts, (items, _prefix, actor, at) => {
    const item = requireItem(items, key)
    const change = rankItem(items, item.key, target, { at, by: actor, via: opts.via ?? 'cli', reason, sources: cleanList(input.sources) })
    if (Object.keys(change).length === 0) throw new Error(`work rank: ${item.key} is already there`)
    const where = target.top ? 'top' : target.bottom ? 'bottom' : `above ${target.above}`
    return { item, message: `rank ${item.key} → ${where} (${reason})`, source: input.sources?.[0] }
  })
}

export function workList(cwd: string, opts: ResolveOptions & { all?: boolean; json?: boolean; label?: string } = {}): WorkItemSummary[] {
  const ctx = resolveContext(cwd, opts)
  const prefix = workPrefix(ctx.config)
  const items = readWorkItems(ctx.root, prefix)
    .filter((i) => opts.all || i.state === 'open')
    .filter((i) => !opts.label || hasLabel(i.labels, opts.label))
    .map((i) => summarizeForRecall(i))
  if (opts.json) console.log(JSON.stringify(items, null, 2))
  else if (items.length === 0) console.log(opts.all ? `no work items yet (prefix ${prefix}) — \`lore work add "<title>"\`` : `nothing open (prefix ${prefix}); \`lore work list --all\` for closed items`)
  else
    for (const i of items)
      console.log(
        `${i.key.padEnd(8)} ${i.status.padEnd(12)}${(i.priority ?? '').padEnd(4)}${i.title}${i.assignee ? `  @${i.assignee}` : ''}${i.labels.length ? `  #${i.labels.join(' #')}` : ''}${
          i.external ? `  [${i.external.system} ${i.external.key}: ${i.external.status}${i.drift ? ', drift' : ''}]` : ''
        }`,
      )
  return items
}

export function workShow(cwd: string, key: string, opts: ResolveOptions & { json?: boolean } = {}): LoreWorkItem {
  const ctx = resolveContext(cwd, opts)
  const item = requireItem(readWorkItems(ctx.root, workPrefix(ctx.config)), key)
  if (opts.json) console.log(JSON.stringify(item, null, 2))
  else {
    console.log(`${item.key}  ${item.title}`)
    console.log(`status: ${item.status}${item.priority ? `  priority: ${item.priority}` : ''}${item.assignee ? `  assignee: ${item.assignee}` : ''}${item.labels.length ? `  labels: ${item.labels.join(', ')}` : ''}`)
    if (item.external) console.log(`external: ${item.external.system} ${item.external.key} (${item.external.status}) ${item.external.url}`)
    if (item.request) console.log(`from request: ${item.request}`)
    for (const s of item.sources) console.log(`source: ${s}`)
    console.log('history:')
    for (const h of item.history) {
      const what = Object.entries(h.change)
        .map(([f, v]) => (f === 'created' ? 'created' : `${f}: ${Array.isArray(v) ? `${v[0] ?? '—'} → ${v[1]}` : String(v)}`))
        .join(', ')
      console.log(`  ${h.at}  ${what}  — ${h.reason}  [${h.via}: ${h.by}${h.confidence ? `, ${h.confidence} confidence` : ''}]`)
    }
  }
  return item
}
