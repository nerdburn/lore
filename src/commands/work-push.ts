import { execFileSync } from 'node:child_process'
import { resolveEnvRefs } from '../config.js'
import { jiraApiFromConfig, type JiraApi, type JiraBoard, type JiraSprint, type JiraTransition } from '../connectors/jira.js'
import { git, readGlobalConfig, resolveContext } from '../context.js'
import { authorizeWrite } from '../write.js'
import { applyChange, findItem, type LoreWorkItem, type WorkStatus } from '../work.js'
import { sshTargetFromRemote } from './refresh.js'
import { mutateBatch, type WorkWriteOptions } from './work.js'

/**
 * `lore work push` — write lore's tracker state out to Jira. Explicit only
 * (SPEC §7: write-back is a human/agent command, never cron).
 *
 * Sprints stay Jira's: lore stores none. A pushed ticket that is in flight
 * in lore (in_progress / blocked) and in no open sprint is added to the
 * board's active sprint; `--sprint` puts named tickets in a sprint on
 * request. Either is a history entry (`jira_sprint`) like any other push.
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
  /**
   * Put these tickets in a Jira sprint on request — "active" for the board's
   * current sprint, or a sprint's name (active or future). Without it, only
   * tickets in flight in lore (in_progress / blocked) that sit in no open
   * sprint are added, to the active one.
   */
  sprint?: string
}

export interface PushAction {
  key: string
  kind: 'create' | 'transition' | 'sprint' | 'skip' | 'error'
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
  const sprintAsk = input.sprint?.trim() || undefined
  if (sprintAsk && input.all) throw new Error('work push: --sprint puts named tickets in a sprint — give ticket keys, not --all')
  const ctx = resolveContext(cwd, opts)
  const actor = authorizeWrite(ctx, opts, 'work push')

  // Off-host: hand the whole command to the host, where Jira is reachable.
  const target = ctx.mode === 'cache' ? sshTargetFromRemote(readGlobalConfig().remote) : undefined
  if (target && ctx.repo) {
    const args = ['lore', 'work', 'push', '--context', ctx.repo, '--json', '--by', actor, ...(input.dryRun ? ['--dry-run'] : []), ...(input.all ? ['--all'] : []), ...(sprintAsk ? ['--sprint', sprintAsk] : []), ...keys]
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
    const touch = (key: string, source?: string) => {
      if (!touched.some((t) => t.key === key)) touched.push({ key, source })
    }
    let target: PushTarget | undefined
    const targetFor = async () => (target ??= await resolvePushTarget(api, resolved, items))
    let plan: SprintPlan | undefined
    const planFor = async () => (plan ??= await resolveSprintPlan(api, resolved, items))

    /**
     * The sprint half of a push, after the issue exists (or would). Returns
     * whether it reported anything. In-flight tickets already in an open
     * sprint are left where the client planned them.
     */
    const sprintStep = async (item: LoreWorkItem, jiraKey: string | undefined, created: boolean): Promise<boolean> => {
      const inFlight = item.status === 'in_progress' || item.status === 'blocked'
      if (!sprintAsk && !inFlight) return false
      const p = await planFor()
      const label = jiraKey ?? 'the new issue'
      if (p.off || !p.board || !p.sprints) {
        if (!sprintAsk) return false
        actions.push({ key: item.key, kind: p.off ? 'skip' : 'error', detail: p.off ? 'sprints are off for this client (sources.jira.push.sprints)' : p.note ?? 'no scrum board to take sprints from', ...(jiraKey ? { jira: jiraKey } : {}) })
        return true
      }
      const wanted = sprintAsk && !/^(active|current)$/i.test(sprintAsk) ? sprintAsk : undefined
      const sprint = wanted ? p.sprints.find((sp) => sp.name.toLowerCase() === wanted.toLowerCase() || String(sp.id) === wanted) : p.active
      if (!sprint) {
        const open = p.sprints.map((sp) => `${sp.name}${sp.state === 'future' ? ' (future)' : ''}`).join(', ') || 'none'
        actions.push({
          key: item.key,
          kind: wanted ? 'error' : 'skip',
          detail: wanted ? `no open sprint "${wanted}" on board ${p.board.name} (open: ${open})` : `no active sprint on board ${p.board.name} — ${label} left in the backlog`,
          ...(jiraKey ? { jira: jiraKey } : {}),
        })
        return true
      }
      const current = created || !jiraKey ? undefined : await api.issueSprint(jiraKey)
      if (current && !sprintAsk) return false
      if (current?.id === sprint.id) {
        actions.push({ key: item.key, kind: 'skip', detail: `${jiraKey} is already in sprint ${sprint.name}`, jira: jiraKey })
        return true
      }
      const why = sprintAsk ? 'asked' : `${item.status} in lore`
      if (input.dryRun || !jiraKey) {
        actions.push({ key: item.key, kind: 'sprint', detail: `would add ${label} to sprint ${sprint.name}${current ? ` (from ${current.name})` : ''} — ${why}`, ...(jiraKey ? { jira: jiraKey } : {}) })
        return true
      }
      await api.addToSprint(sprint.id, [jiraKey])
      const url = item.external?.url ?? jiraKey
      applyChange(item, {}, { at, by, via: opts.via ?? 'cli', reason: `pushed to Jira: ${jiraKey} added to sprint ${sprint.name} (${why})`, sources: [url] }, { jira_sprint: [current?.name ?? null, sprint.name] })
      touch(item.key, url)
      actions.push({ key: item.key, kind: 'sprint', detail: `${jiraKey} → sprint ${sprint.name}${current ? ` (from ${current.name})` : ''} — ${why}`, jira: jiraKey })
      return true
    }

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
            await sprintStep(item, undefined, true)
            continue
          }
          const created = await api.createIssue(fields)
          const url = site ? `${site}/browse/${created.key}` : created.key
          item.external = { system: 'jira', id: `jira:${created.key}`, key: created.key, url, status: 'To Do', category: 'To Do' }
          if (!item.sources.includes(url)) item.sources.push(url)
          applyChange(item, {}, { at, by, via: opts.via ?? 'cli', reason: `pushed to Jira as ${created.key} (${t.issueTypeName} in ${t.project}${t.scopeNote})`, sources: [url] }, { external: [null, item.external.id] })
          touch(item.key, url)
          actions.push({ key: item.key, kind: 'create', detail: `created ${created.key} (${t.issueTypeName} in ${t.project}${t.scopeNote}) ${url}`, jira: created.key })
          if (item.status !== 'todo') {
            const moved = await transitionFor(api, item, false)
            if (moved) {
              applyTransition(item, moved, { at, by, via: opts.via ?? 'cli' })
              actions.push({ key: item.key, kind: 'transition', detail: `${created.key} To Do → ${moved.to.name} (lore: ${item.status})`, jira: created.key })
            }
          }
          await sprintStep(item, created.key, true)
          continue
        }
        // Linked: transition when lore and Jira disagree.
        const jiraKey = item.external.key
        if (inSync(item)) {
          const reported = await sprintStep(item, jiraKey, false)
          if (!reported && !input.all) actions.push({ key: item.key, kind: 'skip', detail: `${jiraKey} already ${item.external.status} — in sync with lore's ${item.status}` })
          continue
        }
        const moved = await transitionFor(api, item, input.dryRun === true)
        if (!moved) {
          actions.push({ key: item.key, kind: 'skip', detail: `${jiraKey} is ${item.external.status}; no transition to a "${item.status}" status from there`, jira: jiraKey })
          await sprintStep(item, jiraKey, false)
          continue
        }
        const from = item.external.status
        if (input.dryRun) {
          actions.push({ key: item.key, kind: 'transition', detail: `would move ${jiraKey} ${from} → ${moved.to.name} (lore: ${item.status})`, jira: jiraKey })
          await sprintStep(item, jiraKey, false)
          continue
        }
        applyTransition(item, moved, { at, by, via: opts.via ?? 'cli' })
        touch(item.key, item.external.url)
        actions.push({ key: item.key, kind: 'transition', detail: `${jiraKey} ${from} → ${moved.to.name} (lore: ${item.status})`, jira: jiraKey })
        await sprintStep(item, jiraKey, false)
      } catch (err) {
        actions.push({ key: item.key, kind: 'error', detail: err instanceof Error ? err.message : String(err), ...(item.external ? { jira: item.external.key } : {}) })
      }
    }
    const created = actions.filter((a) => a.kind === 'create').length
    const moved = actions.filter((a) => a.kind === 'transition').length
    const sprinted = actions.filter((a) => a.kind === 'sprint').length
    return { touched: input.dryRun ? [] : touched, message: `push to Jira: ${created} created, ${moved} moved${sprinted ? `, ${sprinted} into a sprint` : ''}` }
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

function applyTransition(item: LoreWorkItem, t: JiraTransition, meta: { at: string; by: string; via: 'cli' | 'mcp' | 'web' }): void {
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

// ---- sprints ----

interface SprintPlan {
  off?: boolean
  board?: JiraBoard
  /** Open sprints on the board: active first, then future by start. Absent when the board has none (kanban). */
  sprints?: JiraSprint[]
  active?: JiraSprint
  /** Why there is no usable board, for an explicit --sprint. */
  note?: string
}

/**
 * Which board's sprints a push uses: `push.board`, else the first configured
 * board, else the project's only scrum board. Kanban and simple boards have
 * no sprints; with several scrum boards and none named, lore does not guess.
 */
export async function resolveSprintPlan(api: JiraApi, cfg: Record<string, unknown>, items: LoreWorkItem[]): Promise<SprintPlan> {
  const push = (cfg.push as { board?: number; sprints?: boolean; project?: string } | undefined) ?? {}
  if (push.sprints === false) return { off: true }
  const boardId = push.board ?? ((cfg.boards as number[] | undefined) ?? [])[0]
  let board: JiraBoard
  if (boardId) board = await api.boardInfo(boardId)
  else {
    const project = push.project ?? ((cfg.projects as string[] | undefined) ?? [])[0] ?? mostCommonProject(items)
    if (!project) return { note: 'no Jira project to find a sprint board in — set sources.jira.push.board' }
    const scrum = (await api.projectBoards(project)).filter((b) => b.type === 'scrum')
    if (scrum.length !== 1) return { note: scrum.length ? `${project} has ${scrum.length} scrum boards (${scrum.map((b) => `${b.name} ${b.id}`).join(', ')}) — set sources.jira.push.board` : `${project} has no scrum board, so no sprints` }
    board = scrum[0]
  }
  if (board.type !== 'scrum') return { board, note: `board ${board.name} is a ${board.type} board — it has no sprints` }
  const sprints = await api.openSprints(board.id)
  return { board, sprints, active: sprints.find((sp) => sp.state === 'active') }
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

