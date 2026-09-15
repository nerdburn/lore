import { execFileSync } from 'node:child_process'
import { resolveEnvRefs } from '../config.js'
import { jiraApiFromConfig, type JiraApi, type JiraTransition } from '../connectors/jira.js'
import { git, readGlobalConfig, resolveContext } from '../context.js'
import { authorizeWrite } from '../write.js'
import { applyChange, findItem, type LoreWorkItem, type WorkStatus } from '../work.js'
import { sshTargetFromRemote } from './refresh.js'
import { mutateBatch, type WorkWriteOptions } from './work.js'

/**
 * `lore work push` — write lore's tracker state out to Jira. Explicit only
 * (SPEC §7: write-back is a human/agent command, never cron).
 *
 * Two kinds of push, decided per ticket:
 * - a ticket linked to a Jira issue whose status disagrees with lore's gets a
 *   workflow transition, chosen by status category so that "In Review" still
 *   counts as in progress and a "blocked" transition is used when the
 *   workflow has one;
 * - an open ticket with no issue gets one created in the client's project,
 *   scoped onto their board (the board filter's equality clauses, resolved
 *   against the create screen), then linked back as `external`.
 *
 * Jira is reachable only from the lore host (the vendor proxy is VM-scoped),
 * so from a laptop or agent the command runs itself on the host over SSH —
 * the same route `lore refresh --trigger` takes — and pulls the result back.
 * Every push is a history entry on the ticket and a line in the audit log.
 */

export interface WorkPushInput {
  keys?: string[]
  all?: boolean
  dryRun?: boolean
}

export interface PushAction {
  key: string
  kind: 'create' | 'transition' | 'skip' | 'error'
  detail: string
  /** The Jira key involved, when there is one. */
  jira?: string
}

export interface WorkPushResult {
  dryRun: boolean
  ranOn: 'here' | 'host'
  actions: PushAction[]
}

export interface WorkPushDeps {
  ssh?: (target: string, command: string, timeoutMs: number) => string
  /** Test seam: the Jira client for a resolved jira source config. */
  jira?: (cfg: Record<string, unknown>) => { api: JiraApi; site: string }
}

const HOST_TIMEOUT_MS = 10 * 60_000

export async function workPush(cwd: string, input: WorkPushInput, opts: WorkWriteOptions = {}, deps: WorkPushDeps = {}): Promise<WorkPushResult> {
  const keys = (input.keys ?? []).map((k) => k.trim()).filter(Boolean)
  if (keys.length === 0 && !input.all) throw new Error('work push: give ticket keys, or --all for every ticket that differs from Jira')
  const ctx = resolveContext(cwd, opts)
  const actor = authorizeWrite(ctx, opts, 'work push')

  // Off-host: hand the whole command to the host, where Jira is reachable.
  const target = ctx.mode === 'cache' ? sshTargetFromRemote(readGlobalConfig().remote) : undefined
  if (target && ctx.repo) {
    const args = ['lore', 'work', 'push', '--context', ctx.repo, '--json', '--by', actor, ...(input.dryRun ? ['--dry-run'] : []), ...(input.all ? ['--all'] : []), ...keys]
    const out = (deps.ssh ?? sshExec)(target, args.map(shellQuote).join(' '), HOST_TIMEOUT_MS)
    const start = out.indexOf('{')
    if (start < 0) throw new Error(`work push: the host returned no result: ${out.slice(0, 300)}`)
    const result = JSON.parse(out.slice(start)) as WorkPushResult
    result.ranOn = 'host'
    if (!input.dryRun) {
      try {
        git(ctx.root, 'pull', '--ff-only', '--quiet')
      } catch {
        /* the next read pulls */
      }
    }
    return result
  }

  const jiraCfg = ctx.config.sources.jira
  if (!jiraCfg || jiraCfg.disabled) throw new Error(`work push: ${ctx.config.project} has no jira source configured`)
  const { resolved, missing } = resolveEnvRefs(jiraCfg)
  if (missing.length > 0) throw new Error(`work push: missing env vars for jira: ${missing.join(', ')}`)
  const { api, site } = (deps.jira ?? jiraApiFromConfig)(resolved)

  const actions: PushAction[] = []
  await mutateBatch(cwd, opts, 'work push', async (items, _prefix, by, at) => {
    const selected = input.all ? items : keys.map((k) => findItem(items, k) ?? k)
    const touched: { key: string; source?: string }[] = []
    let target: PushTarget | undefined
    const targetFor = async () => (target ??= await resolvePushTarget(api, resolved, items))

    for (const sel of selected) {
      if (typeof sel === 'string') {
        actions.push({ key: sel, kind: 'error', detail: 'no such ticket' })
        continue
      }
      const item = sel
      try {
        if (item.status === 'archived') {
          if (!input.all) actions.push({ key: item.key, kind: 'skip', detail: 'archived tickets are not pushed' })
          continue
        }
        if (item.external && item.external.system !== 'jira') {
          if (!input.all) actions.push({ key: item.key, kind: 'skip', detail: `linked to ${item.external.system} ${item.external.key}, not Jira` })
          continue
        }
        if (!item.external) {
          if (item.state === 'closed') {
            if (!input.all) actions.push({ key: item.key, kind: 'skip', detail: 'done with no Jira issue — nothing to create' })
            continue
          }
          const t = await targetFor()
          const fields = issueFields(item, t)
          if (input.dryRun) {
            actions.push({ key: item.key, kind: 'create', detail: `would create a ${t.issueTypeName} in ${t.project}${t.scopeNote} — "${item.title}"` })
            continue
          }
          const created = await api.createIssue(fields)
          const url = site ? `${site}/browse/${created.key}` : created.key
          item.external = { system: 'jira', id: `jira:${created.key}`, key: created.key, url, status: 'To Do', category: 'To Do' }
          if (!item.sources.includes(url)) item.sources.push(url)
          applyChange(item, {}, { at, by, via: opts.via ?? 'cli', reason: `pushed to Jira as ${created.key} (${t.issueTypeName} in ${t.project}${t.scopeNote})`, sources: [url] }, { external: [null, item.external.id] })
          touched.push({ key: item.key, source: url })
          actions.push({ key: item.key, kind: 'create', detail: `created ${created.key} (${t.issueTypeName} in ${t.project}${t.scopeNote}) ${url}`, jira: created.key })
          if (item.status !== 'todo') {
            const moved = await transitionFor(api, item, false)
            if (moved) {
              applyTransition(item, moved, { at, by, via: opts.via ?? 'cli' })
              actions.push({ key: item.key, kind: 'transition', detail: `${created.key} To Do → ${moved.to.name} (lore: ${item.status})`, jira: created.key })
            }
          }
          continue
        }
        // Linked: transition when lore and Jira disagree.
        if (inSync(item)) {
          if (!input.all) actions.push({ key: item.key, kind: 'skip', detail: `${item.external.key} already ${item.external.status} — in sync with lore's ${item.status}` })
          continue
        }
        const moved = await transitionFor(api, item, input.dryRun === true)
        if (!moved) {
          actions.push({ key: item.key, kind: 'skip', detail: `${item.external.key} is ${item.external.status}; no transition to a "${item.status}" status from there`, jira: item.external.key })
          continue
        }
        const from = item.external.status
        if (input.dryRun) {
          actions.push({ key: item.key, kind: 'transition', detail: `would move ${item.external.key} ${from} → ${moved.to.name} (lore: ${item.status})`, jira: item.external.key })
          continue
        }
        applyTransition(item, moved, { at, by, via: opts.via ?? 'cli' })
        touched.push({ key: item.key, source: item.external.url })
        actions.push({ key: item.key, kind: 'transition', detail: `${item.external.key} ${from} → ${moved.to.name} (lore: ${item.status})`, jira: item.external.key })
      } catch (err) {
        actions.push({ key: item.key, kind: 'error', detail: err instanceof Error ? err.message : String(err), ...(item.external ? { jira: item.external.key } : {}) })
      }
    }
    const created = actions.filter((a) => a.kind === 'create').length
    const moved = actions.filter((a) => a.kind === 'transition').length
    return { touched: input.dryRun ? [] : touched, message: `push to Jira: ${created} created, ${moved} moved` }
  })

  return { dryRun: input.dryRun === true, ranOn: 'here', actions }
}

/** Print a result the way the CLI does. */
export function printPush(result: WorkPushResult): void {
  if (result.actions.length === 0) {
    console.log(result.dryRun ? 'nothing to push' : 'nothing pushed — every selected ticket is in sync with Jira')
    return
  }
  for (const a of result.actions) console.log(`${a.key.padEnd(8)} ${a.kind === 'skip' ? 'skip:' : a.kind === 'error' ? 'error:' : ''} ${a.detail}`.replace(/\s+$/, ''))
  if (result.ranOn === 'host') console.error(`(ran on the lore host${result.dryRun ? ', dry run' : ''})`)
}

// ---- status mapping ----

type CategoryKey = 'new' | 'indeterminate' | 'done'

/** Jira's category name (as the work table stores it) → its key. */
function categoryKey(category: string): CategoryKey | undefined {
  if (/^done$/i.test(category)) return 'done'
  if (/^in progress$/i.test(category)) return 'indeterminate'
  if (/^(to do|new)$/i.test(category)) return 'new'
  return undefined
}

/** Does Jira's current status already express lore's status? */
export function inSync(item: LoreWorkItem): boolean {
  const ext = item.external
  if (!ext) return false
  const cat = categoryKey(ext.category)
  const blocked = /block/i.test(ext.status)
  switch (item.status) {
    case 'todo':
      return cat === 'new'
    case 'in_progress':
      return cat === 'indeterminate' && !blocked
    case 'blocked':
      return blocked
    case 'done':
      return cat === 'done'
    case 'archived':
      return true
  }
}

/** The transition that would express lore's status, from those Jira offers right now. */
export function pickTransition(status: WorkStatus, transitions: JiraTransition[]): JiraTransition | undefined {
  const by = (pred: (t: JiraTransition) => boolean, prefer?: RegExp) => {
    const c = transitions.filter(pred)
    return (prefer && c.find((t) => prefer.test(t.to.name))) ?? c[0]
  }
  switch (status) {
    case 'todo':
      return by((t) => t.to.statusCategory.key === 'new', /^(to do|backlog|open)$/i)
    case 'in_progress':
      return by((t) => t.to.statusCategory.key === 'indeterminate' && !/block|review|qa|test/i.test(t.to.name), /^in progress$/i)
    case 'blocked':
      return by((t) => /block/i.test(t.to.name))
    case 'done':
      return by((t) => t.to.statusCategory.key === 'done', /^done$/i)
    case 'archived':
      return undefined
  }
}

async function transitionFor(api: JiraApi, item: LoreWorkItem, _dryRun: boolean): Promise<JiraTransition | undefined> {
  const t = pickTransition(item.status, await api.transitions(item.external!.key))
  if (!t) return undefined
  if (!_dryRun) await api.transition(item.external!.key, t.id)
  return t
}

function applyTransition(item: LoreWorkItem, t: JiraTransition, meta: { at: string; by: string; via: 'cli' | 'mcp' }): void {
  const ext = item.external!
  const from = ext.status
  ext.status = t.to.name
  ext.category = t.to.statusCategory.name ?? { new: 'To Do', indeterminate: 'In Progress', done: 'Done' }[t.to.statusCategory.key]
  applyChange(item, {}, { ...meta, reason: `pushed lore status ${item.status} to Jira: ${ext.key} ${from} → ${t.to.name}`, sources: [ext.url] }, { external_status: [from, t.to.name] })
}

// ---- creating issues ----

interface PushTarget {
  project: string
  issueTypeId: string
  issueTypeName: string
  /** Extra field payloads that put the issue on the client's board. */
  fields: Record<string, unknown>
  scopeNote: string
}

/**
 * Where a new issue goes. Project: `push.project`, else the configured
 * project, else the project the mirrored issues live in. Issue type: the
 * configured name (default Task) from the project's create-meta. Scope:
 * `push.fields` verbatim, else the board filter's equality clauses
 * ("Client Project" = Jointly) resolved to field ids and option ids through
 * the create screen — the clause that puts an issue on the board.
 */
export async function resolvePushTarget(api: JiraApi, cfg: Record<string, unknown>, items: LoreWorkItem[]): Promise<PushTarget> {
  const push = (cfg.push as { project?: string; issuetype?: string; fields?: Record<string, unknown> } | undefined) ?? {}
  const projects = (cfg.projects as string[] | undefined) ?? []
  const boards = (cfg.boards as number[] | undefined) ?? []
  const project = push.project ?? projects[0] ?? mostCommonProject(items)
  if (!project) throw new Error('work push: cannot tell which Jira project to create issues in — set sources.jira.push.project in lore.json')

  const types = await api.issueTypes(project)
  const wanted = (push.issuetype ?? 'Task').toLowerCase()
  const type = types.find((t) => t.name.toLowerCase() === wanted) ?? types.find((t) => !t.subtask)
  if (!type) throw new Error(`work push: project ${project} offers no issue type${push.issuetype ? ` "${push.issuetype}"` : ''} — set sources.jira.push.issuetype`)

  if (push.fields) return { project, issueTypeId: type.id, issueTypeName: type.name, fields: push.fields, scopeNote: '' }
  if (boards.length === 0) return { project, issueTypeId: type.id, issueTypeName: type.name, fields: {}, scopeNote: '' }

  const { jql } = await api.board(boards[0])
  const clauses = equalityClauses(jql).filter((c) => c.field.toLowerCase() !== 'project')
  if (clauses.length === 0) return { project, issueTypeId: type.id, issueTypeName: type.name, fields: {}, scopeNote: '' }
  const screen = await api.createFields(project, type.id)
  const fields: Record<string, unknown> = {}
  const notes: string[] = []
  for (const c of clauses) {
    const field = screen.find((f) => f.name.toLowerCase() === c.field.toLowerCase() || f.fieldId.toLowerCase() === c.field.toLowerCase())
    if (!field) throw new Error(`work push: the board filter scopes on "${c.field}" = ${c.value}, but the ${type.name} create screen in ${project} has no such field — set sources.jira.push.fields in lore.json`)
    if (field.allowedValues?.length) {
      const opt = field.allowedValues.find((v) => [v.value, v.name, v.key, v.id].some((x) => x !== undefined && String(x).toLowerCase() === c.value.toLowerCase()))
      if (!opt) throw new Error(`work push: "${c.field}" has no option "${c.value}" on the create screen — set sources.jira.push.fields in lore.json`)
      fields[field.fieldId] = opt.id ? { id: opt.id } : opt.key ? { key: opt.key } : { value: opt.value ?? opt.name }
    } else {
      fields[field.fieldId] = c.value
    }
    notes.push(`${field.name} = ${c.value}`)
  }
  return { project, issueTypeId: type.id, issueTypeName: type.name, fields, scopeNote: notes.length ? `, ${notes.join(', ')}` : '' }
}

/** `"Client Project[Dropdown]" = Jointly AND project = INPT` → [{field: 'Client Project', value: 'Jointly'}, {field: 'project', value: 'INPT'}]. */
export function equalityClauses(jql: string): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = []
  const re = /(?:"([^"]+?)(?:\[[^\]]*\])?"|([A-Za-z_][\w.]*))\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s()]+))/g
  for (const m of jql.matchAll(re)) {
    const field = (m[1] ?? m[2]).trim()
    const value = (m[3] ?? m[4] ?? m[5]).trim()
    if (/^(order|by|and|or|not)$/i.test(field)) continue
    out.push({ field, value })
  }
  return out
}

function mostCommonProject(items: LoreWorkItem[]): string | undefined {
  const counts = new Map<string, number>()
  for (const i of items) {
    const k = i.external?.system === 'jira' ? /^([A-Z][A-Z0-9_]+)-\d+$/.exec(i.external.key)?.[1] : undefined
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

const JIRA_PRIORITY: Record<string, string> = { P1: 'High', P2: 'Medium', P3: 'Low' }

export function issueFields(item: LoreWorkItem, t: PushTarget): Record<string, unknown> {
  return {
    project: { key: t.project },
    issuetype: { id: t.issueTypeId },
    summary: item.title,
    description: descriptionAdf(item),
    ...(item.priority ? { priority: { name: JIRA_PRIORITY[item.priority] } } : {}),
    ...(item.labels.length ? { labels: item.labels.map((l) => l.replace(/\s+/g, '-')) } : {}),
    ...t.fields,
  }
}

function descriptionAdf(item: LoreWorkItem): unknown {
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  const content: unknown[] = [p(`Tracked in lore as ${item.key}.${item.request ? ` Promoted from request ${item.request}.` : ''}`)]
  if (item.sources.length) {
    content.push(p('Sources:'))
    content.push({
      type: 'bulletList',
      content: item.sources.map((s) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: s, marks: [{ type: 'link', attrs: { href: s } }] }] }],
      })),
    })
  }
  return { type: 'doc', version: 1, content }
}

// ---- remote ----

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

function sshExec(target: string, command: string, timeoutMs: number): string {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target, command], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).toString()
}

