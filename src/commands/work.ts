import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parse } from 'yaml'
import { AUDIT_FILE, appendAudit } from '../audit.js'
import { git, resolveContext, type ResolvedContext, type ResolveOptions } from '../context.js'
import { authorizeWrite } from '../write.js'
import {
  applyChange,
  canonicalLabel,
  describeClaim,
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
  type WorkClaim,
  type RankTarget,
  type WorkItemSummary,
  type WorkPriority,
  type WorkStatus,
} from '../work.js'

export interface WorkWriteOptions extends ResolveOptions {
  operationId?: string
  /** CLI only: who is doing this. MCP callers can never set it. */
  by?: string
  via?: 'cli' | 'mcp' | 'web'
  /** Hosted MCP only: the platform-attested caller; see WriteGateOptions. */
  actor?: string
| 'mcp'
  /** Test seam. */
  at?: string
  /** CLI: the caller prints its own (JSON) result. */
  quiet?: boolean
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
  const existingHistory = new Set(items.flatMap(i => i.history))
  const { item, message, source } = fn(items, prefix, actor, at)
  const operationId = opts.operationId ?? randomUUID()
  for (const row of items) for (const history of row.history) {
    if (existingHistory.has(history)) continue
    history.id ??= randomUUID()
    history.operation_id ??= operationId
    if (history.change.created && row.assignee) history.change.assignee ??= [null, row.assignee]
  }
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
        ...(fields.description !== undefined ? { description: fields.description.trim() } : {}),
        ...(priority ? { priority } : {}),
        ...(fields.assignee !== undefined ? { assignee: fields.assignee.trim() || null } : {}),
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

/** A ticket someone else is already working: the claim was refused and nothing was written. */
export class ClaimHeldError extends Error {
  constructor(public readonly key: string, public readonly claim: WorkClaim, wanted: string) {
    super(`work claim: ${key} is held by ${describeClaim(claim)} since ${claim.since} — ${wanted} did not get it (release it there first, or take it over with --force and a reason)`)
    this.name = 'ClaimHeldError'
  }
}

export interface WorkClaimInput {
  /** Who is claiming; defaults to the caller. */
  holder?: string
  /** The holder's own id for this run (an enso task ref). A holder's second run on the same ticket is refused. */
  ref?: string
  stage?: string
  url?: string
  /** Move the ticket in the same write. */
  status?: string
  /** Take the ticket from another holder. Needs a reason. */
  force?: boolean
  reason?: string
}

export type ClaimOutcome = 'claimed' | 'updated' | 'renewed' | 'taken'

/**
 * Tracker writes that must not be merged with a competing write: read the
 * latest table, decide, write, and push. If the origin moved meanwhile the
 * push is refused, the local commit is thrown away, and the decision is made
 * again on the new table — so of two claims racing for a ticket, the one
 * whose push lands second sees the first and is refused.
 */
function decideAndPush<T>(
  cwd: string,
  opts: WorkWriteOptions,
  fn: (items: LoreWorkItem[], actor: string, at: string) => { touched: string[]; message: string; result: T },
): T {
  const via = opts.via ?? 'cli'
  for (let attempt = 0; ; attempt++) {
    const ctx = resolveContext(cwd, opts)
    const actor = authorizeWrite(ctx, opts, 'work item change')
    const at = opts.at ?? new Date().toISOString()
    const prefix = workPrefix(ctx.config)
    const items = readWorkItems(ctx.root, prefix)
    const existing = new Set(items.flatMap((i) => i.history))
    const { touched, message, result } = fn(items, actor, at)
    if (touched.length === 0) return result
    const operationId = opts.operationId ?? randomUUID()
    for (const row of items) for (const h of row.history) {
      if (existing.has(h)) continue
      h.id ??= randomUUID()
      h.operation_id ??= operationId
    }
    const rel = writeWorkItems(ctx.root, prefix, items)
    for (const key of touched) appendAudit(ctx.root, { at, action: 'work', actor, via, id: key })
    if (ctx.mode !== 'cache') return result
    git(ctx.root, 'add', rel, AUDIT_FILE)
    git(ctx.root, '-c', 'user.name=lore', '-c', 'user.email=lore@localhost', 'commit', '--quiet', '-m', `lore: work ${message}`)
    try {
      git(ctx.root, 'push', '--quiet')
      return result
    } catch (err) {
      // Someone else pushed first. Drop our commit and decide again on theirs.
      try {
        git(ctx.root, 'fetch', '--quiet')
        git(ctx.root, 'reset', '--hard', '--quiet', '@{u}')
      } catch {
        // Origin unreachable: drop our commit so the cache never shows a claim the origin does not have.
        git(ctx.root, 'reset', '--hard', '--quiet', 'HEAD~1')
        throw new Error(`work: could not reach ${ctx.repo} — nothing was recorded`, { cause: err })
      }
      if (attempt >= 3) throw new Error(`work: ${ctx.repo} kept changing — gave up after ${attempt + 1} tries, nothing was recorded`, { cause: err })
    }
  }
}

/**
 * Take a ticket for a run, or confirm a claim already held. One ticket has
 * one claim: another holder — or the same holder under a different `ref`,
 * which is a second run of the same ticket — is refused with ClaimHeldError.
 * The same holder and ref claiming again renews the claim and updates its
 * stage, so a runner can call this on every stage change.
 */
export function workClaim(cwd: string, key: string, input: WorkClaimInput, opts: WorkWriteOptions = {}): { item: LoreWorkItem; outcome: ClaimOutcome } {
  const status = requireStatus(input.status)
  const reason = input.reason?.trim()
  if (input.force && !reason) throw new Error('work claim: --force needs --reason — taking a ticket from its holder is recorded with why')
  const res = decideAndPush(cwd, opts, (items, actor, at) => {
    const item = requireItem(items, key)
    const holder = input.holder?.trim() || actor
    const held = item.claim
    const mine = held && held.holder === holder && (!held.ref || !input.ref || held.ref === input.ref)
    if (held && !mine && !input.force) throw new ClaimHeldError(item.key, held, describeClaim({ holder, ref: input.ref })!)
    const toStatus = status ?? item.status
    if (!held && toStatus !== 'todo' && toStatus !== 'in_progress' && toStatus !== 'review' && toStatus !== 'blocked') throw new Error(`work claim: ${item.key} is ${item.status} — only open tickets can be claimed`)
    const before = describeClaim(held)
    const claim: WorkClaim = {
      holder,
      ...(input.ref?.trim() || (mine && held.ref) ? { ref: input.ref?.trim() || held!.ref } : {}),
      ...(input.stage?.trim() || (mine && held.stage) ? { stage: input.stage?.trim() || held!.stage } : {}),
      ...(input.url?.trim() || (mine && held.url) ? { url: input.url?.trim() || held!.url } : {}),
      since: mine ? held.since : at,
      renewed: at,
    }
    item.claim = claim
    const after = describeClaim(claim)
    const outcome: ClaimOutcome = !held ? 'claimed' : !mine ? 'taken' : before !== after || (status && status !== item.status) ? 'updated' : 'renewed'
    if (outcome !== 'renewed') {
      const why = reason ?? (outcome === 'claimed' ? `claimed by ${holder}` : outcome === 'taken' ? `taken over by ${holder}` : `${holder} moved it to ${claim.stage ?? toStatus}`)
      applyChange(item, status ? { status } : {}, { at, by: actor, via: opts.via ?? 'cli', reason: why }, before !== after ? { claim: [before, after] } : {})
    }
    return { touched: [item.key], message: `claim ${item.key} ${after}${outcome === 'renewed' ? ' (renewed)' : ''}`, result: { item, outcome } }
  })
  if ((opts.via ?? 'cli') === 'cli' && !opts.quiet) console.log(`${res.outcome} ${res.item.key}: ${describeClaim(res.item.claim)}`)
  return res
}

export interface WorkReleaseInput {
  holder?: string
  /** The run letting go; a release naming a different ref than the claim's is refused. */
  ref?: string
  /** Move the ticket in the same write (e.g. done). */
  status?: string
  force?: boolean
  reason: string
}

/** Let go of a ticket. Only its holder may, unless forced; releasing an unclaimed ticket changes nothing. */
export function workRelease(cwd: string, key: string, input: WorkReleaseInput, opts: WorkWriteOptions = {}): { item: LoreWorkItem; released: boolean } {
  const reason = requireReason(input, 'release')
  const status = requireStatus(input.status)
  const res = decideAndPush(cwd, opts, (items, actor, at) => {
    const item = requireItem(items, key)
    const held = item.claim
    const holder = input.holder?.trim() || actor
    if (held && !input.force && (held.holder !== holder || (held.ref && input.ref && held.ref !== input.ref))) {
      throw new ClaimHeldError(item.key, held, describeClaim({ holder, ref: input.ref })!)
    }
    if (held) delete item.claim
    const change = applyChange(item, status ? { status } : {}, { at, by: actor, via: opts.via ?? 'cli', reason }, held ? { claim: [describeClaim(held), null] } : {})
    const changed = Object.keys(change).length > 0
    return { touched: changed ? [item.key] : [], message: `release ${item.key} (${reason})`, result: { item, released: Boolean(held) } }
  })
  if ((opts.via ?? 'cli') === 'cli' && !opts.quiet) console.log(res.released ? `released ${res.item.key}` : `${res.item.key} was not claimed`)
  return res
}

/** How fresh a claim must already be for `workRenew` to leave it alone, so a frequent heartbeat is not a commit every time. */
const RENEW_MIN_MS = 15 * 60_000

/** A holder's heartbeat: confirm every claim it holds in one write. Returns the tickets it holds. */
export function workRenew(cwd: string, input: { holder?: string }, opts: WorkWriteOptions = {}): { held: string[]; renewed: string[] } {
  const res = decideAndPush(cwd, opts, (items, actor, at) => {
    const holder = input.holder?.trim() || actor
    const mine = items.filter((i) => i.claim?.holder === holder)
    const due = mine.filter((i) => Date.parse(at) - Date.parse(i.claim!.renewed) >= RENEW_MIN_MS || i.claim!.stale_notified)
    for (const i of due) {
      i.claim!.renewed = at
      delete i.claim!.stale_notified
    }
    return { touched: due.map((i) => i.key), message: `renew ${due.length} claim${due.length === 1 ? '' : 's'} for ${holder}`, result: { held: mine.map((i) => i.key), renewed: due.map((i) => i.key) } }
  })
  if ((opts.via ?? 'cli') === 'cli' && !opts.quiet) console.log(`holding ${res.held.length ? res.held.join(', ') : 'nothing'}${res.renewed.length ? ` (renewed ${res.renewed.length})` : ''}`)
  return res
}

export interface WorkArchiveFilter {
  /** Only tickets mirrored from this tracker ("linear", "jira", "github"), or "lore" for tickets born here. */
  origin?: string
  status?: string
  label?: string
}

export interface WorkArchiveResult {
  /** Tickets that changed, with the status they left and the one they now have. */
  changed: { key: string; title: string; from: WorkStatus; to: WorkStatus }[]
  unchanged: string[]
}

const ORIGINS = ['lore', 'jira', 'github', 'linear']

/** The tickets a bulk archive / unarchive covers: the keys given, or every ticket matching the filter. */
function selectForArchive(items: LoreWorkItem[], keys: string[], filter: WorkArchiveFilter, verb: string): LoreWorkItem[] {
  const wanted = [...new Set((cleanList(keys) ?? []).map((k) => k.toUpperCase()))]
  const filtered = filter.origin !== undefined || filter.status !== undefined || filter.label !== undefined
  if (wanted.length === 0 && !filtered) throw new Error(`work ${verb}: give ticket keys, or a filter (--origin, --status, --label)`)
  if (filter.origin !== undefined && !ORIGINS.includes(filter.origin)) throw new Error(`work ${verb}: origin must be one of ${ORIGINS.join(', ')}`)
  const status = requireStatus(filter.status)
  const missing = wanted.filter((k) => !findItem(items, k))
  if (missing.length) throw new Error(`work ${verb}: no item ${missing.join(', ')} — nothing changed`)
  return items.filter((i) => {
    if (wanted.length && !wanted.includes(i.key.toUpperCase())) return false
    if (filter.origin !== undefined && (i.external?.system ?? 'lore') !== filter.origin) return false
    if (status && i.status !== status) return false
    if (filter.label !== undefined && !hasLabel(i.labels, filter.label)) return false
    return true
  })
}

/** The status a ticket held before it was archived, from its history; `todo` when history doesn't say. */
export function statusBeforeArchive(item: Pick<LoreWorkItem, 'history'>): WorkStatus {
  for (let n = item.history.length - 1; n >= 0; n--) {
    const change = item.history[n].change.status
    if (Array.isArray(change) && change[1] === 'archived' && (WORK_STATUSES as unknown[]).includes(change[0]) && change[0] !== 'archived') return change[0] as WorkStatus
  }
  return 'todo'
}

/**
 * Archive several tickets in one change: the keys given, or every OPEN ticket
 * matching the filter (a filter alone never touches done tickets unless
 * `--status done` asks for them). One write, one commit, one history entry
 * per ticket. Nothing is deleted — `workUnarchive` puts each one back.
 */
export async function workArchive(cwd: string, keys: string[], filter: WorkArchiveFilter, input: ChangeInput, opts: WorkWriteOptions & { dryRun?: boolean } = {}): Promise<WorkArchiveResult> {
  const reason = requireReason(input, 'archive')
  return archiveBatch(cwd, 'archive', keys, filter, opts, (item) => item.status === 'archived' || (!keys.length && filter.status === undefined && item.state !== 'open') ? undefined : 'archived', reason, input)
}

/** Put archived tickets back where they were (or at `to`): the keys given, or every archived ticket matching the filter. */
export async function workUnarchive(cwd: string, keys: string[], filter: Omit<WorkArchiveFilter, 'status'>, input: ChangeInput & { to?: string }, opts: WorkWriteOptions & { dryRun?: boolean } = {}): Promise<WorkArchiveResult> {
  const reason = requireReason(input, 'unarchive')
  const to = requireStatus(input.to)
  if (to === 'archived') throw new Error('work unarchive: --to must be a status other than archived')
  return archiveBatch(cwd, 'unarchive', keys, filter, opts, (item) => item.status !== 'archived' ? undefined : to ?? statusBeforeArchive(item), reason, input)
}

async function archiveBatch(
  cwd: string,
  verb: 'archive' | 'unarchive',
  keys: string[],
  filter: WorkArchiveFilter,
  opts: WorkWriteOptions & { dryRun?: boolean },
  target: (item: LoreWorkItem) => WorkStatus | undefined,
  reason: string,
  input: ChangeInput,
): Promise<WorkArchiveResult> {
  const result: WorkArchiveResult = { changed: [], unchanged: [] }
  const cli = (opts.via ?? 'cli') === 'cli'
  if (opts.dryRun) {
    const ctx = resolveContext(cwd, opts)
    for (const item of selectForArchive(readWorkItems(ctx.root, workPrefix(ctx.config)), keys, filter, verb)) {
      const to = target(item)
      if (to) result.changed.push({ key: item.key, title: item.title, from: item.status, to })
      else result.unchanged.push(item.key)
    }
  } else {
    await mutateBatch(cwd, opts, 'work item change', async (items, _prefix, actor, at) => {
      for (const item of selectForArchive(items, keys, filter, verb)) {
        const to = target(item)
        const from = item.status
        if (to && Object.keys(applyChange(item, { status: to }, { at, by: actor, via: opts.via ?? 'cli', reason, sources: cleanList(input.sources) })).length) result.changed.push({ key: item.key, title: item.title, from, to })
        else result.unchanged.push(item.key)
      }
      const listed = result.changed.length > 8 ? `${result.changed.length} tickets` : result.changed.map((c) => c.key).join(', ')
      return { touched: result.changed.map((c) => ({ key: c.key })), message: `${verb} ${listed} (${reason})` }
    })
  }
  if (cli) {
    for (const c of result.changed) console.log(`${c.key.padEnd(8)} ${c.from} → ${c.to}  ${c.title}`)
    console.log(`${opts.dryRun ? `would ${verb}` : `${verb}d`} ${result.changed.length} ticket${result.changed.length === 1 ? '' : 's'}${result.unchanged.length && keys.length ? `; unchanged: ${result.unchanged.join(', ')}` : ''}`)
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
    for (const pr of item.related_prs ?? []) console.log(`related PR: ${pr.repo}#${pr.number} (${pr.status}) ${pr.title}\n  ${pr.reason} ${pr.url}`)
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
