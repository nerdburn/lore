import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loreHome } from '../context.js'
import { WORK_STATUSES, workFile, workPrefix, type WorkItemSummary, type WorkStatus } from '../work.js'
import { bareProjects, type BareProject } from './access.js'

const run = promisify(execFile)
type Counts = Record<WorkStatus, number>
interface Snapshot { items: WorkItemSummary[]; counts: Counts }
export function emptyBoardCounts(): Counts {
  return Object.fromEntries(WORK_STATUSES.map(status => [status, 0])) as Counts
}
function count(items: WorkItemSummary[]): Counts {
  const counts = emptyBoardCounts()
  for (const item of items) counts[item.status]++
  return counts
}

async function replace(path: string, oid: string, value: unknown) {
  const temp = path + '.' + randomUUID()
  try {
    await writeFile(temp, JSON.stringify({ oid, value }), { mode: 0o600 })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

// One pair of private, replaceable files per tracker. Each carries its own
// Git blob ID so even overlapping writers or an interrupted refresh are safe.
export class BoardSnapshots {
  private pending = new Map<string, Promise<Snapshot>>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private repos: string, private root = join(loreHome(), 'board-snapshots-v1'),
    private log = (message: string) => console.error('[board]', message)) {}

  async read<K extends keyof Snapshot>(project: BareProject, part: K): Promise<Snapshot[K]> {
    const repo = resolve(this.repos, project.context + '.git')
    const path = workFile(workPrefix(project.config))
    const { stdout } = await run('git', ['-C', repo, 'ls-tree', 'HEAD', '--', path])
    if (!stdout) return ({ items: [], counts: emptyBoardCounts() })[part]
    const oid = /^\d+ blob ([0-9a-f]+)\t/.exec(stdout)?.[1]
    if (!oid) throw new Error('Invalid tracker entry in the Git tree')
    const dir = join(this.root, createHash('sha256').update(JSON.stringify([repo, path])).digest('hex'))
    try {
      const cached = JSON.parse(await readFile(join(dir, part + '.json'), 'utf8'))
      if (cached.oid === oid && (part === 'items' ? Array.isArray(cached.value) :
        WORK_STATUSES.every(s => Number.isInteger(cached.value?.[s])))) return cached.value
    } catch { /* Missing or damaged disposable snapshot. */ }

    const key = dir + '/' + oid
    let job = this.pending.get(key)
    if (!job) {
      job = this.queue.then(() => this.build(repo, oid, dir)).finally(() => this.pending.delete(key))
      this.pending.set(key, job)
      this.queue = job.catch(() => {})
    }
    return (await job)[part]
  }

  private async build(repo: string, oid: string, dir: string): Promise<Snapshot> {
    const source = import.meta.url.endsWith('.ts')
    const worker = fileURLToPath(new URL(source ? './build-snapshot.ts' : './build-snapshot.js', import.meta.url))
    const { stdout } = await run(process.execPath, [...(source ? ['--import', import.meta.resolve('tsx')] : []), worker, repo, oid],
      { maxBuffer: 64 * 1024 * 1024 })
    const items: WorkItemSummary[] = JSON.parse(stdout)
    const counts = count(items)
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await replace(join(dir, 'items.json'), oid, items)
      await replace(join(dir, 'counts.json'), oid, counts)
    } catch (error) {
      this.log('Could not persist board snapshot: ' + (error as Error).message)
    }
    return { items, counts }
  }

  // Poll the local bare repos for updates from any writer, including a direct
  // git push. A request between sweeps can build or join the same refresh.
  start(): () => Promise<void> {
    let stopped = false
    let active: Promise<void> | undefined
    let timer: NodeJS.Timeout
    const sweep = async () => {
      try {
        for (const p of bareProjects(this.repos)) {
          if (stopped) break
          if (!p.config.board?.enabled) continue
          try { await this.read(p, 'counts') }
          catch { this.log('Could not refresh board snapshot for ' + p.context) }
        }
      } finally {
        if (!stopped) schedule(60_000)
      }
    }
    const schedule = (ms: number) => {
      timer = setTimeout(() => { active = sweep().catch(() => this.log('Could not scan board repositories')) }, ms).unref()
    }
    schedule(0)
    return async () => { stopped = true; clearTimeout(timer); await active }
  }
}
