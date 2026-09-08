import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { loadConfig } from '../config.js'
import { connectors } from '../connectors/index.js'
import { git } from '../context.js'
import type { Connector } from '../types.js'
import { extract } from './extract.js'
import { sync } from './sync.js'

export interface RunAllOptions {
  /** Directory of bare repos, one per client: <repos>/<name>.git */
  repos: string
  /** Directory of working clones the runner syncs in: <work>/<name> */
  work: string
  /** Run extract after sync (needs LLM credentials in the environment). */
  extract?: boolean
  /** Force the weekly report regardless of the configured day. */
  report?: boolean
}

export interface RunAllSummary {
  ok: boolean
  clients: Record<string, { status: 'synced' | 'archived' | 'failed'; committed: boolean; error?: string }>
}

/**
 * The self-hosted scheduler's one job: for every context repo on this host,
 * sync (and optionally extract), commit, push back to the bare repo. Runs
 * from a systemd timer; per-client failures are isolated and the exit code
 * reflects the whole run. The set of bare repos *is* the client registry —
 * `lore setup` in remote mode adds one, `lore archive` flips its lifecycle.
 *
 * Layout on the host:
 *   <repos>/lore-acme.git   bare — what laptops and agents clone/push
 *   <work>/lore-acme        clone of it — where sync writes
 */
export async function runAll(opts: RunAllOptions, registry: Record<string, Connector> = connectors): Promise<RunAllSummary> {
  const summary: RunAllSummary = { ok: true, clients: {} }
  if (!existsSync(opts.repos)) throw new Error(`repos dir not found: ${opts.repos}`)
  mkdirSync(opts.work, { recursive: true })

  const bares = readdirSync(opts.repos)
    .filter((e) => e.endsWith('.git'))
    .sort()
  if (bares.length === 0) console.log(`no context repos in ${opts.repos}`)

  for (const bare of bares) {
    const name = basename(bare, '.git')
    const root = join(opts.work, name)
    console.log(`\n=== ${name}`)
    try {
      ensureClone(join(opts.repos, bare), root)
      const config = loadConfig(root)
      if (config.lifecycle === 'archived') {
        console.log('archived — skipped')
        summary.clients[name] = { status: 'archived', committed: false }
        continue
      }

      const s = await sync(root, registry)
      if (opts.extract) await extract(root, { report: opts.report })
      const committed = commitAndPush(root, name)
      if (!s.ok) throw new Error(`sync reported errors: ${Object.entries(s.sources).filter(([, v]) => v.status === 'failed').map(([k]) => k).join(', ')}`)
      summary.clients[name] = { status: 'synced', committed }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`✗ ${name}: ${message}`)
      summary.clients[name] = { status: 'failed', committed: false, error: message }
      summary.ok = false
    }
  }

  console.log('\n--- run-all summary')
  for (const [name, c] of Object.entries(summary.clients)) {
    console.log(`${c.status === 'failed' ? '✗' : c.status === 'archived' ? '–' : '✓'} ${name}: ${c.status}${c.committed ? ', committed' : ''}${c.error ? ` — ${c.error}` : ''}`)
  }
  return summary
}

function ensureClone(bare: string, root: string): void {
  if (!existsSync(join(root, '.git'))) {
    execFileSync('git', ['clone', '--quiet', bare, root], { stdio: ['ignore', 'ignore', 'pipe'] })
    return
  }
  // A previous run may have left uncommitted output behind (killed mid-run);
  // that is regenerable, so reset to what the bare repo has.
  git(root, 'fetch', '--quiet', 'origin')
  git(root, 'reset', '--quiet', '--hard', 'origin/main')
  git(root, 'clean', '--quiet', '-fd', 'context', 'state.json')
}

/** Commit sync/extract output and push. Returns whether anything changed. */
function commitAndPush(root: string, name: string): boolean {
  git(root, 'add', '-A', 'context', 'state.json')
  const staged = git(root, 'diff', '--cached', '--name-only')
  if (!staged) return false
  // state.json alone changing means "ran, nothing new" — still committed so
  // `recall` can report freshness honestly, but labelled so history scans.
  const heartbeat = staged.split('\n').every((f) => f === 'state.json')
  const message = heartbeat ? `chore(lore): heartbeat ${name}` : `chore(lore): sync ${name}`
  git(root, '-c', 'user.name=lore', '-c', 'user.email=lore@localhost', 'commit', '--quiet', '-m', message)
  git(root, 'push', '--quiet', 'origin', 'HEAD:main')
  return true
}
