import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appendAudit, AUDIT_FILE } from '../audit.js'
import { git, resolveContext, type ResolvedContext } from '../context.js'
import { GithubProjectsClient, projectConfigs, projectKey } from '../connectors/github-projects.js'
import { reconcileProject, reconcileProjects, saveProjectSnapshot, withProjectLock } from '../projects.js'
import { authorizeWrite } from '../write.js'
import { applyChange, findItem, readWorkItems, workFile, workPrefix, writeWorkItems, type LoreWorkItem, type WorkStatus } from '../work.js'
import { commitWork, workAdd as addLocal, workMove as moveLocal, workSet as setLocal, type WorkAddInput, type WorkWriteOptions, type WorkSetInput, type ChangeInput } from './work.js'

export interface ProjectAddInput {
  project: string
  title: string
  body?: string
  status?: string
  link_work?: string
  reason?: string
}
function configured(ctx: ResolvedContext, key: string) {
  const cfg = projectConfigs(ctx.config.sources.github_projects).find(c => projectKey(c) === key)
  if (!cfg) throw new Error(`github_projects: ${key} is not an enabled project in lore.json`)
  return cfg
}
function commitProjects(ctx: ResolvedContext, message: string): void {
  const paths = [workFile(workPrefix(ctx.config)), AUDIT_FILE, 'state.json', 'context/projects/github', 'context/streams/github-projects'].filter(p => existsSync(join(ctx.root, p)))
  if (ctx.mode === 'cache' && paths.length && git(ctx.root, 'status', '--porcelain', '--', ...paths).trim()) commitWork(ctx, paths, message)
}

/** Local changes remain pending on API failure; their ledger is never advanced prematurely. */
async function projectedWrite(cwd: string, opts: WorkWriteOptions, fn: (root: string) => LoreWorkItem): Promise<LoreWorkItem> {
  const ctx = resolveContext(cwd, opts)
  const by = authorizeWrite(ctx, opts, 'work item change')
  if (!projectConfigs(ctx.config.sources.github_projects).length) return fn(cwd)
  // fn uses local mode so the work change and its ledger share one cache commit.
  return withProjectLock(ctx.root, async () => {
    let item: LoreWorkItem | undefined
    try {
      item = fn(ctx.root)
      if (item.project_items?.length) await reconcileProjects(ctx.root, ctx.config, { keys: [item.key], locked: true, meta: {
        at: opts.at ?? new Date().toISOString(), by, via: opts.via ?? 'cli', reason: 'project write-back after work change',
      } })
      return findItem(readWorkItems(ctx.root, workPrefix(ctx.config)), item.key)!
    } catch (err) {
      if (item) throw new Error(`saved ${item.key} in Lore; GitHub Projects reconciliation failed and will retry on sync: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    } finally { if (item) commitProjects(ctx, `lore: work ${item.key} and project reconciliation`) }
  })
}
function localOptions(opts: WorkWriteOptions): WorkWriteOptions {
  return { by: opts.by, actor: opts.actor, via: opts.via, at: opts.at, pull: false }
}
export async function workMove(cwd: string, key: string, status: string, input: ChangeInput, opts: WorkWriteOptions = {}): Promise<LoreWorkItem> {
  return projectedWrite(cwd, opts, root => moveLocal(root, key, status, input, root === cwd ? opts : localOptions(opts)))
}
export async function workSet(cwd: string, key: string, fields: WorkSetInput, input: ChangeInput, opts: WorkWriteOptions = {}): Promise<LoreWorkItem> {
  return projectedWrite(cwd, opts, root => setLocal(root, key, fields, input, root === cwd ? opts : localOptions(opts)))
}
export async function workAdd(cwd: string, input: WorkAddInput & { project?: { owner: string; number: number; column?: string } }, opts: WorkWriteOptions = {}): Promise<LoreWorkItem> {
  if (!input.project) return addLocal(cwd, input, opts)
  const ctx = resolveContext(cwd, opts)
  authorizeWrite(ctx, opts, 'project item add')
  const cfg = configured(ctx, `${input.project.owner}/${input.project.number}`)
  const status = input.project.column ? cfg.status_map[input.project.column] : input.status ?? 'todo'
  if (!status) throw new Error(`github_projects: unmapped column ${input.project.column}`)
  if (input.status && input.status !== status) throw new Error('github_projects: status and project.column disagree')
  const client = new GithubProjectsClient(cfg)
  client.statusOption(await client.read(), status) // validate before creating a local ticket
  const row = addLocal(ctx.root, { ...input, status }, localOptions(opts))
  try {
    await projectItemAdd(ctx.root, { project: projectKey(cfg), title: row.title, body: row.description, status, link_work: row.key, reason: input.reason }, localOptions(opts))
    return findItem(readWorkItems(ctx.root, workPrefix(ctx.config)), row.key)!
  } catch (err) {
    throw new Error(`saved ${row.key} in Lore; project add failed. Retry lore_project_item_add with link_work=${row.key}: ${err instanceof Error ? err.message : String(err)}`)
  } finally { commitProjects(ctx, `lore: add ${row.key} to ${projectKey(cfg)}`) }
}

export async function projectItemAdd(cwd: string, input: ProjectAddInput, opts: WorkWriteOptions = {}): Promise<{ item_node_id: string; project_url: string; work_id: string }> {
  const ctx = resolveContext(cwd, opts)
  const by = authorizeWrite(ctx, opts, 'project item add')
  const title = input.title?.trim()
  if (!title) throw new Error('github_projects: title is required')
  const cfg = configured(ctx, input.project)
  return withProjectLock(ctx.root, async () => {
    const client = new GithubProjectsClient(cfg)
    let project = await client.read()
    const prefix = workPrefix(ctx.config)
    let items = readWorkItems(ctx.root, prefix)
    let row = input.link_work ? findItem(items, input.link_work) : undefined
    if (input.link_work && !row) throw new Error(`work: no item ${input.link_work}`)
    const status = input.status ?? row?.status ?? 'todo'
    client.statusOption(project, status)
    const meta = { at: opts.at ?? new Date().toISOString(), by, via: opts.via ?? 'cli' as const, reason: input.reason?.trim() || `added to GitHub Project ${input.project}` }
    if (!row) {
      row = addLocal(ctx.root, { title, description: input.body, status: status as WorkStatus, reason: meta.reason }, localOptions(opts))
      items = readWorkItems(ctx.root, prefix)
      row = findItem(items, row.key)!
    }
    const workId = row.key
    let itemId: string | undefined
    try {
      applyChange(row, { title, ...(input.body !== undefined ? { description: input.body } : {}), status: status as WorkStatus }, meta)
      writeWorkItems(ctx.root, prefix, items)
      // Retrying an interrupted add with link_work reuses its persisted project link.
      const known = row.project_items?.find(l => l.project === input.project)
      itemId = known?.ref
      if (!itemId) {
        const issue = row.external?.system === 'github' ? row.external.id.slice('github:'.length) : undefined
        itemId = project.items.find(i => issue && i.linked_issue?.toLowerCase() === issue.toLowerCase())?.id
          ?? await client.add(project, row.title, row.description ?? '', issue)
        const link = { kind: 'github-project-item' as const, ref: itemId, project: input.project, url: project.url, last_sync: {} }
        ;(row.project_items ??= []).push(link)
        applyChange(row, {}, meta, { project_link: [null, itemId] })
        // Save immediately: later status/body failures must not produce duplicate drafts on retry.
        writeWorkItems(ctx.root, prefix, items)
        appendAudit(ctx.root, { at: meta.at, action: 'work', actor: by, via: meta.via, id: row.key, source: project.url })
      }
      project = await client.read()
      const remote = project.items.find(i => i.id === itemId)
      if (!remote || remote.redacted) throw new Error(`created/linked item ${itemId} is not readable yet`)
      await reconcileProject(ctx.root, ctx.config, cfg, client, project, meta, [workId], ['status', 'title', ...(row.description !== undefined ? ['body' as const] : [])])
      saveProjectSnapshot(ctx.root, cfg, project)
      return { item_node_id: itemId, project_url: remote.url, work_id: workId }
    } catch (err) {
      throw new Error(`github_projects: work ${workId}${itemId ? `, item ${itemId}` : ''} saved; retry with link_work=${workId}: ${err instanceof Error ? err.message : String(err)}`)
    } finally { commitProjects(ctx, `lore: project add ${workId} to ${input.project}`) }
  })
}

export async function projectItemMove(cwd: string, input: { item: string; status: string; reason?: string }, opts: WorkWriteOptions = {}): Promise<LoreWorkItem> {
  const ctx = resolveContext(cwd, opts)
  const by = authorizeWrite(ctx, opts, 'project item move')
  const items = readWorkItems(ctx.root, workPrefix(ctx.config))
  const row = findItem(items, input.item) ?? items.find(i => i.project_items?.some(l => l.ref === input.item))
  if (!row || !row.project_items?.length) throw new Error(`github_projects: no linked work row for ${input.item}; add/link it first`)
  // Validate every target before the local change. A work id can project to several boards.
  for (const link of row.project_items) {
    const cfg = configured(ctx, link.project)
    const client = new GithubProjectsClient(cfg)
    client.statusOption(await client.read(), input.status)
  }
  if (row.status !== input.status) return workMove(cwd, row.key, input.status, { reason: input.reason ?? 'moved through GitHub Projects' }, opts)
  try {
    await reconcileProjects(ctx.root, ctx.config, { keys: [row.key], forceFields: ['status'], meta: { at: new Date().toISOString(), by, via: opts.via ?? 'cli', reason: input.reason ?? 'retry project move' } })
    return findItem(readWorkItems(ctx.root, workPrefix(ctx.config)), row.key)!
  } finally { commitProjects(ctx, `lore: project move ${row.key}`) }
}
export async function projectSync(cwd: string, project: string, opts: WorkWriteOptions = {}): Promise<void> {
  const ctx = resolveContext(cwd, opts)
  authorizeWrite(ctx, opts, 'project sync')
  configured(ctx, project)
  try { await reconcileProjects(ctx.root, ctx.config, { project }) }
  finally { commitProjects(ctx, `lore: project sync ${project}`) }
}
