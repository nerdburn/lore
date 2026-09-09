import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { loadConfig } from '../config.js'
import { connectors } from '../connectors/index.js'
import { git } from '../context.js'
import { acquireLock, lockHolder, tryLock } from '../lock.js'
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
  /** How many clients to run at once (default 3). Clients are independent; the work is network-bound. */
  concurrency?: number
}

export interface RunAllSummary {
  ok: boolean
  clients: Record<string, { status: 'synced' | 'archived' | 'failed'; committed: boolean; error?: string; note?: string }>
}

/** How long a run waits for another run's sync of the same client before giving up. Syncs take seconds; this is a safety net. */
const SYNC_LOCK_WAIT_MS = 15 * 60_000
/** Git operations on a clone are short; another run holding the git lock is committing or pushing. */
const GIT_LOCK_WAIT_MS = 5 * 60_000

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
 *   <work>/.locks/          per-client locks (sync, extract, git)
 *
 * Two kinds of run share a clone: the hourly timer (sync + fold) and
 * on-demand sync-only runs triggered by `lore refresh` / `lore_sync_now`.
 * The fold can take many minutes, and an agent asking for fresh data must
 * not wait for it, so the two overlap under three per-client locks:
 *
 *   sync     — one sync at a time (two would append duplicate docs). Waited on.
 *   extract  — one fold at a time. A run that finds it held skips its fold;
 *              the holder will commit what it derives.
 *   git      — reset/commit/push are serialised; held for seconds.
 *
 * Sync output is committed and pushed *before* the fold starts, so raw
 * streams reach the bare repo within a minute of any run starting, and a
 * killed fold never loses sync work. state.json is written half-by-half
 * (`updateState`), so a fold checkpoint and a sync landing at the same time
 * keep each other's keys.
 */
export async function runAll(opts: RunAllOptions, registry: Record<string, Connector> = connectors): Promise<RunAllSummary> {
  const summary: RunAllSummary = { ok: true, clients: {} }
  if (!existsSync(opts.repos)) throw new Error(`repos dir not found: ${opts.repos}`)
  mkdirSync(join(opts.work, '.locks'), { recursive: true })

  const bares = readdirSync(opts.repos)
    .filter((e) => e.endsWith('.git'))
    .sort()
  if (bares.length === 0) console.log(`no context repos in ${opts.repos}`)

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, bares.length || 1))
  const restore = prefixConsole()
  try {
    // A small pool: `concurrency` workers pull the next client off the queue.
    const queue = [...bares]
    const worker = async () => {
      for (let bare = queue.shift(); bare; bare = queue.shift()) {
        const name = basename(bare, '.git')
        summary.clients[name] = await clientScope.run(name, () => runClient(name, join(opts.repos, bare), opts, registry))
        if (summary.clients[name].status === 'failed') summary.ok = false
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
  } finally {
    restore()
  }

  console.log('\n--- run-all summary')
  for (const name of bares.map((b) => basename(b, '.git'))) {
    const c = summary.clients[name]
    console.log(`${c.status === 'failed' ? '✗' : c.status === 'archived' ? '–' : '✓'} ${name}: ${c.status}${c.committed ? ', committed' : ''}${c.note ? ` (${c.note})` : ''}${c.error ? ` — ${c.error}` : ''}`)
  }
  return summary
}

async function runClient(
  name: string,
  bare: string,
  opts: RunAllOptions,
  registry: Record<string, Connector>,
): Promise<RunAllSummary['clients'][string]> {
  const root = join(opts.work, name)
  const locks = {
    sync: join(opts.work, '.locks', `${name}.sync`),
    extract: join(opts.work, '.locks', `${name}.extract`),
    git: join(opts.work, '.locks', `${name}.git`),
  }
  console.log(`=== ${name}`)
  let committed = false
  const notes: string[] = []
  try {
    // ---- phase 1: sync, commit, push — under the sync lock ----
    const syncLock = await acquireLock(locks.sync, SYNC_LOCK_WAIT_MS)
    let s: Awaited<ReturnType<typeof sync>> | undefined
    let failure: Error | undefined
    try {
      const foldInFlight = lockHolder(locks.extract) !== undefined
      await withGitLock(locks.git, () => ensureClone(bare, root, { reset: !foldInFlight }))
      if (foldInFlight) notes.push('fold in flight from another run')
      const config = loadConfig(root)
      if (config.lifecycle === 'archived') {
        console.log('archived — skipped')
        return { status: 'archived', committed: false }
      }
      // sync checkpoints to disk as it goes; whatever it managed must reach
      // the bare repo even if it failed part-way, or the next run's reset
      // throws it away and repeats the work.
      try {
        s = await sync(root, registry)
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err))
      }
      committed = (await withGitLock(locks.git, () => commitAndPush(root, name))) || committed
    } finally {
      syncLock.release()
    }
    if (failure) throw failure
    if (!s!.ok) throw new Error(`sync reported errors: ${Object.entries(s!.sources).filter(([, v]) => v.status === 'failed').map(([k]) => k).join(', ')}`)

    // ---- phase 2: fold, commit, push — under the extract lock ----
    if (opts.extract) {
      const foldLock = tryLock(locks.extract)
      if (!foldLock) {
        console.log('fold skipped — another run is already folding this client')
        notes.push('fold skipped: in flight elsewhere')
      } else {
        let foldFailure: Error | undefined
        try {
          await extract(root, { report: opts.report })
        } catch (err) {
          foldFailure = err instanceof Error ? err : new Error(String(err))
        } finally {
          try {
            committed = (await withGitLock(locks.git, () => commitAndPush(root, name))) || committed
          } finally {
            foldLock.release()
          }
        }
        if (foldFailure) throw foldFailure
      }
    }
    return { status: 'synced', committed, ...(notes.length ? { note: notes.join('; ') } : {}) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`✗ ${name}: ${message}`)
    committed ||= existsSync(join(root, '.git')) && git(root, 'log', '-1', '--format=%s').startsWith('chore(lore)') && git(root, 'status', '--porcelain', 'context', 'state.json') === ''
    return { status: 'failed', committed, error: message, ...(notes.length ? { note: notes.join('; ') } : {}) }
  }
}

async function withGitLock<T>(path: string, fn: () => T): Promise<T> {
  const lock = await acquireLock(path, GIT_LOCK_WAIT_MS, 500)
  try {
    return fn()
  } finally {
    lock.release()
  }
}

/**
 * Make sure the clone exists and is current. With `reset` (nobody else is
 * working in it) a previous run's uncommitted leftovers — regenerable — are
 * thrown away in favour of what the bare repo has. Without it (a fold is
 * checkpointing into this clone right now) only fast-forward what we can;
 * the fold's own commit will reconcile the rest.
 */
function ensureClone(bare: string, root: string, { reset }: { reset: boolean }): void {
  if (!existsSync(join(root, '.git'))) {
    execFileSync('git', ['clone', '--quiet', bare, root], { stdio: ['ignore', 'ignore', 'pipe'] })
    return
  }
  git(root, 'fetch', '--quiet', 'origin')
  if (reset) {
    git(root, 'reset', '--quiet', '--hard', 'origin/main')
    git(root, 'clean', '--quiet', '-fd', 'context', 'state.json')
    return
  }
  try {
    git(root, 'merge', '--quiet', '--ff-only', 'origin/main')
  } catch {
    console.log('clone is behind origin but busy — will reconcile at push')
  }
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
  pushWithRebase(root)
  return true
}

/**
 * A long run (a first fold can take an hour) races with pins and config
 * pushes from laptops. If the push is rejected, replay our sync commit on top
 * of the remote and push again. Our commit wins any conflict on the files it
 * touched — streams, derived artifacts and state are regenerated from
 * sources, so the fresher fold is the right one to keep — and everything
 * else (lore.json, facts.yaml) comes through from the remote untouched.
 */
export function pushWithRebase(root: string, attempts = 3): void {
  for (let i = 1; ; i++) {
    try {
      git(root, 'push', '--quiet', 'origin', 'HEAD:main')
      return
    } catch (err) {
      if (i >= attempts) throw new Error(`push rejected ${attempts} times — ${err instanceof Error ? err.message.split('\n')[0] : err}`)
      git(root, 'fetch', '--quiet', 'origin')
      try {
        // During a rebase "theirs" is the commit being replayed — ours.
        git(root, '-c', 'user.name=lore', '-c', 'user.email=lore@localhost', 'rebase', '--quiet', '-X', 'theirs', 'origin/main')
      } catch (rebaseErr) {
        try {
          git(root, 'rebase', '--abort')
        } catch {
          /* nothing to abort */
        }
        throw new Error(`push rejected and rebase onto origin/main failed: ${rebaseErr instanceof Error ? rebaseErr.message.split('\n')[0] : rebaseErr}`)
      }
    }
  }
}

// ---- per-client log prefixes ----

const clientScope = new AsyncLocalStorage<string>()

/**
 * Clients run concurrently, so every console line is prefixed with the
 * client it belongs to. Wraps whatever console methods are current (tests
 * swap them) and returns a restorer.
 */
function prefixConsole(): () => void {
  const orig = { log: console.log, warn: console.warn, error: console.error }
  const wrap = (fn: (...a: unknown[]) => void) => (...a: unknown[]) => {
    const name = clientScope.getStore()
    fn(...(name ? [`[${name}]`, ...a] : a))
  }
  console.log = wrap(orig.log)
  console.warn = wrap(orig.warn)
  console.error = wrap(orig.error)
  return () => {
    console.log = orig.log
    console.warn = orig.warn
    console.error = orig.error
  }
}
