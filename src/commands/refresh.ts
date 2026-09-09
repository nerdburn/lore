import { execFileSync } from 'node:child_process'
import { git, readGlobalConfig, resolveContext, type ResolvedContext, type ResolveOptions } from '../context.js'
import { recallData } from '../recall.js'

export interface RefreshResult {
  before: { lastSync?: string; lastExtract?: string }
  after: { lastSync?: string; lastExtract?: string }
  /** What happened on the host: 'ran' | 'skipped-recent' | 'unavailable' | 'not-requested'. */
  host: 'ran' | 'skipped-recent' | 'unavailable' | 'not-requested'
  note?: string
}

export interface RefreshDeps {
  /** Run a command on the host over SSH; throws on non-zero exit. */
  ssh: (target: string, command: string, timeoutMs: number) => string
  now?: () => number
}

const MIN_INTERVAL_MS = 10 * 60_000
const HOST_TIMEOUT_MS = 45 * 60_000

/**
 * "Sync now" for agents and humans who don't sit on the host. Pulls the cache
 * clone so reads see everything the host has committed; with `trigger`, first
 * asks the host to run its sync service (the same unit the hourly timer
 * runs) and waits for it. Only possible when the remote is an SSH target the
 * caller can reach — that is how self-hosted lore is wired. A sync that
 * finished within the last 10 minutes is not re-run unless forced.
 */
export function refresh(
  cwd: string,
  opts: ResolveOptions & { trigger?: boolean; force?: boolean },
  deps: RefreshDeps = { ssh: sshExec },
): RefreshResult {
  const ctx = resolveContext(cwd, { ...opts, pull: opts.pull ?? true })
  const before = freshness(ctx)
  let host: RefreshResult['host'] = 'not-requested'
  let note: string | undefined

  if (opts.trigger) {
    const target = ctx.mode === 'cache' ? sshTargetFromRemote(readGlobalConfig().remote) : undefined
    if (!target) {
      host = 'unavailable'
      note = ctx.mode === 'cache' ? 'remote is not an SSH host — the host syncs on its own timer' : 'local context repo — run `lore sync` here'
    } else {
      const now = deps.now?.() ?? Date.now()
      const lastMs = before.lastSync ? new Date(before.lastSync).getTime() : 0
      if (!opts.force && now - lastMs < MIN_INTERVAL_MS) {
        host = 'skipped-recent'
        note = `host synced ${Math.round((now - lastMs) / 60_000)} min ago; not re-running (force to override)`
      } else {
        deps.ssh(target, 'sudo systemctl start lore-sync.service', HOST_TIMEOUT_MS)
        host = 'ran'
        if (ctx.mode === 'cache') git(ctx.root, 'pull', '--ff-only', '--quiet')
      }
    }
  }
  return { before, after: freshness(ctx), host, ...(note ? { note } : {}) }
}

function freshness(ctx: ResolvedContext): { lastSync?: string; lastExtract?: string } {
  return recallData(ctx.root, ctx.config, 'nothing').synced
}

/** "user@host:/path" or "ssh://user@host/path" → "user@host"; paths → undefined. */
export function sshTargetFromRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined
  const m = /^(?:ssh:\/\/)?([^/:@\s]+@[^/:\s]+)[:/]/.exec(remote)
  return m?.[1]
}

function sshExec(target: string, command: string, timeoutMs: number): string {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target, command], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  }).toString()
}
