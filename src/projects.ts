import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GhProjectConfig, LoreConfig } from './config.js'
import { GithubProjectsClient, projectConfigs, projectCursor, projectDocs, projectFile, projectKey, type ProjectItem, type ProjectSnapshot } from './connectors/github-projects.js'
import { loadState, updateState, type ProjectConflict } from './state.js'
import { writeDocs } from './streams.js'
import { scrub } from './scrub.js'
import { tryLock } from './lock.js'
import { applyChange, readWorkItems, workFile, workPrefix, writeWorkItems, type ChangeMeta, type LoreWorkItem, type ProjectItemRef } from './work.js'

export function bodyHash(body: string): string {
  return createHash('sha256').update(body.replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')).digest('hex')
}
export function fieldDirection(lore: string, project: string, previous: string | undefined): 'none' | 'pull' | 'push' | 'conflict' {
  if (lore === project) return 'none'
  // A new link has no common ancestor: Lore is authoritative, no invented drift.
  if (previous === undefined) return 'push'
  if (lore === previous) return 'pull'
  if (project === previous) return 'push'
  return 'conflict'
}
export function projectLink(project: ProjectSnapshot, item: ProjectItem): ProjectItemRef {
  return { kind: 'github-project-item', ref: item.id, project: project.project, url: item.url, last_sync: {} }
}

/** Serialize project reads/mutations/ledger writes on a clone, including timer and fold. */
export async function withProjectLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const path = join(root, '.lore-projects.lock')
  const deadline = Date.now() + 120_000
  let lock = tryLock(path)
  while (!lock) {
    if (Date.now() > deadline) throw new Error('github_projects: another project operation is still running')
    await new Promise(r => setTimeout(r, 100))
    lock = tryLock(path)
  }
  try { return await fn() } finally { lock.release() }
}

export function saveProjectSnapshot(root: string, cfg: GhProjectConfig, project: ProjectSnapshot): void {
  const state = loadState(root)
  const old = state.cursors.github_projects?.[project.project] as { fingerprints?: Record<string, string> } | undefined
  writeDocs(root, projectDocs(project, old?.fingerprints))
  const file = join(root, projectFile(cfg))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, scrub(JSON.stringify(project, null, 2)).text + '\n')
  updateState(root, { cursors: { ...state.cursors, github_projects: { ...state.cursors.github_projects, [project.project]: projectCursor(project) } } })
}

/** Fresh, complete snapshots only: absence in a partial/failed response is never deletion. */
export async function reconcileProject(
  root: string, config: LoreConfig, cfg: GhProjectConfig, client: GithubProjectsClient, project: ProjectSnapshot,
  meta: ChangeMeta = { at: new Date().toISOString(), by: 'lore-sync', via: 'sync', reason: 'GitHub Projects reconciliation' },
  onlyKeys?: string[],
  forceFields: ('status' | 'title' | 'body')[] = [],
): Promise<void> {
  const prefix = workPrefix(config)
  const items = readWorkItems(root, prefix)
  const path = join(root, workFile(prefix))
  const contents = () => existsSync(path) ? readFileSync(path, 'utf8') : ''
  let expected = contents()
  let saved = JSON.stringify(items)
  const persist = () => {
    if (JSON.stringify(items) === saved) return
    if (contents() !== expected) throw new Error('github_projects: work changed during reconciliation; retrying on next sync without overwriting the newer work')
    writeWorkItems(root, prefix, items)
    expected = contents()
    saved = JSON.stringify(items)
  }
  const byId = new Map(project.items.map(i => [i.id, i]))
  const byIssue = new Map(items.filter(i => i.external?.system === 'github').map(i => [i.external!.id.slice('github:'.length).toLowerCase(), i]))
  for (const remote of project.items) {
    const row = remote.linked_issue && byIssue.get(remote.linked_issue.toLowerCase())
    if (!row || remote.redacted || (onlyKeys && !onlyKeys.includes(row.key))) continue
    if (!row.project_items?.some(l => l.ref === remote.id)) {
      const link = projectLink(project, remote)
      ;(row.project_items ??= []).push(link)
      applyChange(row, {}, { ...meta, sources: [remote.url] }, { project_link: [null, remote.id] })
    }
  }
  try {
    for (const row of items) {
      if (onlyKeys && !onlyKeys.includes(row.key)) continue
      for (const link of [...row.project_items ?? []]) {
        if (link.project !== project.project) continue
        const remote = byId.get(link.ref)
        if (!remote) {
          row.project_items = row.project_items!.filter(l => l !== link)
          applyChange(row, {}, meta, { project_link: [link.ref, null] })
          continue
        }
        if (remote.redacted) continue // inaccessible content remains linked, never blanked
        await reconcileItem(root, row, link, remote, cfg, client, project, meta, forceFields)
        // Each successful item is durable even if a later mutation fails.
        persist()
      }
    }
  } finally {
    // Keep pending local values and successful ledger fields on partial failures.
    // The next run retries only fields that still disagree.
    persist()
  }
}

async function reconcileItem(root: string, row: LoreWorkItem, link: ProjectItemRef, remote: ProjectItem,
  cfg: GhProjectConfig, client: GithubProjectsClient, project: ProjectSnapshot, meta: ChangeMeta, forceFields: ('status' | 'title' | 'body')[]): Promise<void> {
  link.url = remote.url
  link.last_sync ??= {}
  for (const field of ['status', 'title', 'body'] as const) {
    const local = field === 'body' ? row.description ?? '' : row[field]
    const foreign = field === 'status' ? cfg.status_map[remote.status_raw ?? ''] : remote[field]
    const ledger = field === 'body' ? 'body_hash' : field
    const previous = link.last_sync[ledger]
    // Unmapped columns are read-only metadata. Once Lore changes status, a
    // missing reverse mapping is a configuration error, never a silent drop.
    if (!forceFields.includes(field) && foreign === undefined && (previous === undefined || local === previous)) {
      if (field === 'status') link.last_sync.status = row.status
      continue
    }
    const localValue = field === 'body' ? bodyHash(local) : local
    const remoteValue = field === 'body' ? bodyHash(foreign ?? '') : foreign ?? ''
    let direction = fieldDirection(localValue, remoteValue, previous)
    // Mirrored issues historically have no description. Seed that missing
    // body from GitHub instead of wiping it on the first auto-link.
    if (field === 'body' && previous === undefined && row.description === undefined) direction = 'pull'
    if (forceFields.includes(field) && localValue !== remoteValue) direction = direction === 'conflict' ? 'conflict' : 'push'
    if (direction === 'pull') {
      applyChange(row, field === 'body' ? { description: foreign ?? '' } : field === 'status' ? { status: foreign as LoreWorkItem['status'] } : { title: foreign },
        { ...meta, sources: [remote.url] })
    } else if (direction === 'push' || direction === 'conflict') {
      if (field === 'status') await client.move(project, remote, local)
      else await client.edit(remote, { [field]: local })
      applyChange(row, {}, { ...meta, sources: [remote.url] }, { project_write: { item: remote.id, field, value: local } })
      if (direction === 'conflict') {
        const conflict: ProjectConflict = { at: meta.at, kind: 'field-drift', project: project.project, item_node_id: remote.id,
          field, lore_value: scrub(local).text, project_value: scrub(foreign ?? '').text, resolved: 'lore' }
        const state = loadState(root)
        updateState(root, { conflicts: [...state.conflicts ?? [], conflict] })
      }
    }
    if (field === 'body') link.last_sync.body_hash = bodyHash(row.description ?? '')
    else if (field === 'status') link.last_sync.status = row.status
    else link.last_sync.title = row.title
  }
}

export async function reconcileProjects(root: string, config: LoreConfig, opts: { project?: string; keys?: string[]; meta?: ChangeMeta; forceFields?: ('status' | 'title' | 'body')[]; locked?: boolean } = {}): Promise<void> {
  if (config.lifecycle === 'archived') return
  const configs = projectConfigs(config.sources.github_projects).filter(c => !opts.project || projectKey(c) === opts.project)
  if (!configs.length) return
  const run = async () => {
    const errors: string[] = []
    for (const cfg of configs) {
      try {
        const client = new GithubProjectsClient(cfg)
        const project = await client.read()
        await reconcileProject(root, config, cfg, client, project, opts.meta, opts.keys, opts.forceFields)
        saveProjectSnapshot(root, cfg, project)
      } catch (err) { errors.push(`${projectKey(cfg)}: ${err instanceof Error ? err.message : String(err)}`) }
    }
    if (errors.length) throw new Error(`github_projects: ${errors.join('; ')}`)
  }
  if (opts.locked) await run()
  else await withProjectLock(root, run)
}
