import { execFileSync } from 'node:child_process'

/** A file at HEAD of a bare repo, without a checkout. Missing + `optional` → ''. */
export function gitShow(dir: string, path: string, optional = false): string {
  try {
    return execFileSync('git', ['-C', dir, 'show', `HEAD:${path}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString()
  } catch (err) {
    if (optional) return ''
    throw err
  }
}

/** Files at HEAD under `path` (recursive), or [] when it doesn't exist. */
export function gitLsFiles(dir: string, path: string): string[] {
  try {
    return execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD', '--', path], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Files at HEAD under `path` containing the fixed string `needle`. */
export function gitGrepFiles(dir: string, needle: string, path: string): string[] {
  try {
    return execFileSync('git', ['-C', dir, 'grep', '-l', '-F', needle, 'HEAD', '--', path], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.replace(/^HEAD:/, ''))
  } catch {
    return []
  }
}
