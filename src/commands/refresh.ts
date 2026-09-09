import { execFileSync } from 'node:child_process'
import { git, readGlobalConfig, resolveContext, type ResolvedContext, type ResolveOptions } from '../context.js'
import { recallData } from '../recall.js'

export interface RefreshResult {
  before: { lastSync?: string; lastExtract?: string }
  after: { lastSync?: string; lastExtract?: string }
  /**
   * What happened on the host: 'ran' (we started the sync service and waited
   * for it), 'waited' (a run was already in flight — we waited for that one
   * instead of starting another), 'skipped-recent', 'unavailable', 'not-requested'.
   */
  host: 'ran' | 'waited' | 'skipped-recent' | 'unavailable' | 'not-requested'
  /** How the host run ended, when host is 'ran' or 'waited'. A failed run is a result, not an error. */
  outcome?: 'success' | 'failed'
  note?: string
}

export interface RefreshDeps {
  /** Run a command on the host over SSH; throws on non-zero exit. */
  ssh: (target: string, command: string, timeoutMs: number) => string
  now?: () => number
}

const MIN_INTERVAL_MS = 10 * 60_000
const HOST_TIMEOUT_MS = 45 * 60_000
const STATUS_TIMEOUT_MS = 60_000

/**
 * Which unit "sync now" means on the host. Newer hosts have a sync-only
 * unit (`lore-sync-now.service`, seconds) beside the hourly sync+fold unit
 * (`lore-sync.service`, minutes); older hosts only the latter. Every command
 * below resolves `$U` first so a laptop on the new CLI still works against a
 * host that has not been re-provisioned.
 */
export const UNIT_PRELUDE = 'U=$(systemctl cat lore-sync-now.service >/dev/null 2>&1 && echo lore-sync-now.service || echo lore-sync.service)'
/** Prints the unit's ActiveState; `is-active` exits non-zero for anything but `active`, so swallow that. */
export const STATE_CMD = `${UNIT_PRELUDE}; systemctl is-active $U || true`
const SHOW_CMD = 'systemctl show -p Result,ExecMainStatus $U'
/** Block until the in-flight run finishes (a oneshot is `activating` while ExecStart runs), then report how it ended. */
export const WAIT_CMD = `${UNIT_PRELUDE}; while case "$(systemctl is-active $U)" in activating|active|deactivating) true;; *) false;; esac; do sleep 5; done; ${SHOW_CMD}`
/** `systemctl start` on a oneshot blocks until it exits; its exit code is not the signal, the unit's Result is. */
export const START_CMD = `${UNIT_PRELUDE}; sudo systemctl start $U; ${SHOW_CMD}`

const IN_FLIGHT = new Set(['activating', 'active', 'deactivating'])

/**
 * "Sync now" for agents and humans who don't sit on the host. Pulls the cache
 * clone so reads see everything the host has committed; with `trigger`, first
 * asks the host to run its sync-only service and waits for it — raw streams
 * land in about a minute; the LLM fold that updates derived artifacts stays
 * on the hourly timer, so `lastExtract` may lag `lastSync`. Only possible when the remote is an SSH target the
 * caller can reach — that is how self-hosted lore is wired. A run already in
 * flight (the timer fired, or another caller triggered) is waited out rather
 * than re-triggered; a sync that finished within the last 10 minutes is not
 * re-run unless forced. The run's outcome comes back in the result — only
 * failing to reach the host throws.
 */
export function refresh(
  cwd: string,
  opts: ResolveOptions & { trigger?: boolean; force?: boolean },
  deps: RefreshDeps = { ssh: sshExec },
): RefreshResult {
  const ctx = resolveContext(cwd, { ...opts, pull: opts.pull ?? true })
  const before = freshness(ctx)
  let host: RefreshResult['host'] = 'not-requested'
  let outcome: RefreshResult['outcome']
  let note: string | undefined

  if (opts.trigger) {
    const target = ctx.mode === 'cache' ? sshTargetFromRemote(readGlobalConfig().remote) : undefined
    if (!target) {
      host = 'unavailable'
      note = ctx.mode === 'cache' ? 'remote is not an SSH host — the host syncs on its own timer' : 'local context repo — run `lore sync` here'
    } else {
      const state = deps.ssh(target, STATE_CMD, STATUS_TIMEOUT_MS).trim()
      const now = deps.now?.() ?? Date.now()
      const lastMs = before.lastSync ? new Date(before.lastSync).getTime() : 0
      if (IN_FLIGHT.has(state)) {
        host = 'waited'
        ;({ outcome, note } = unitOutcome(deps.ssh(target, WAIT_CMD, HOST_TIMEOUT_MS), 'a sync was already running; waited for it'))
      } else if (!opts.force && now - lastMs < MIN_INTERVAL_MS) {
        host = 'skipped-recent'
        note = `host synced ${Math.round((now - lastMs) / 60_000)} min ago; not re-running (force to override)`
      } else {
        host = 'ran'
        ;({ outcome, note } = unitOutcome(deps.ssh(target, START_CMD, HOST_TIMEOUT_MS)))
      }
      if (outcome && ctx.mode === 'cache') git(ctx.root, 'pull', '--ff-only', '--quiet')
    }
  }
  return { before, after: freshness(ctx), host, ...(outcome ? { outcome } : {}), ...(note ? { note } : {}) }
}

/** Parse `systemctl show -p Result,ExecMainStatus` into an outcome; `Result=success` is the only success. */
export function unitOutcome(show: string, prefix?: string): { outcome: 'success' | 'failed'; note?: string } {
  const props = new Map<string, string>()
  for (const line of show.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const result = props.get('Result')
  const status = props.get('ExecMainStatus')
  const parts = prefix ? [prefix] : []
  if (result === 'success') return { outcome: 'success', ...(parts.length ? { note: parts.join('; ') } : {}) }
  parts.push(
    result
      ? `host run failed (${result}${status && status !== '0' ? `, exit ${status}` : ''}) — see journalctl -u lore-sync on the host`
      : 'could not read the unit result from the host',
  )
  return { outcome: 'failed', note: parts.join('; ') }
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
