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
