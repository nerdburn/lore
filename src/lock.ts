import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Directory locks with owner liveness. `mkdir` is atomic on every
 * filesystem we run on, so the lock is the directory; a `pid` file inside
 * names the owner so a lock left by a killed process is reclaimed instead of
 * wedging every later run. Good for one host with a few cooperating
 * processes (the timer's run-all and on-demand sync-now runs), not for
 * anything networked.
 */
export interface Lock {
  path: string
  release(): void
}

/** Take the lock now, or return undefined if a live process holds it. */
export function tryLock(path: string): Lock | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path, { recursive: false })
      writeFileSync(join(path, 'pid'), String(process.pid))
      return { path, release: () => rmSync(path, { recursive: true, force: true }) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (lockHolder(path) !== undefined) return undefined
      // Stale: the owner is gone. Reclaim and retry once.
      rmSync(path, { recursive: true, force: true })
    }
  }
  return undefined
}

/** Wait for the lock, polling; throws after `timeoutMs`. */
export async function acquireLock(path: string, timeoutMs: number, pollMs = 2000): Promise<Lock> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lock = tryLock(path)
    if (lock) return lock
    if (Date.now() >= deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for lock ${path} (held by pid ${lockHolder(path)})`)
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/** The pid of a live process holding the lock, or undefined (free or stale). */
export function lockHolder(path: string): number | undefined {
  let pid: number
  try {
    pid = Number(readFileSync(join(path, 'pid'), 'utf8').trim())
  } catch {
    // Directory exists but no pid yet: the owner is between mkdir and write.
    // Treat as held; if it really died in that window the next probe (a
    // moment later, still no pid) is still "held" — so give it a grace
    // window keyed on the directory's age.
    return dirIsFresh(path) ? -1 : undefined
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  return isAlive(pid) ? pid : undefined
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: exists but owned by another user — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function dirIsFresh(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs < 10_000
  } catch {
    return false
  }
}
