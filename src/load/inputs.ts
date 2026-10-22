import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const LOAD_INPUT_PATHS = ['lore.json', 'state.json', 'context/streams', 'context/work/lore']
/**
 * Paths whose change makes a built projection out of date. state.json is an
 * input only for per-source sync health in coverage, and every sync rewrites
 * its cursors and timestamps, so it would mark every projection stale minutes
 * after the host built it.
 */
export const LOAD_FRESHNESS_PATHS = LOAD_INPUT_PATHS.filter(path => path !== 'state.json')
const paths = LOAD_INPUT_PATHS
export interface LoadInputs { files: Map<string, string>; revision?: string }

/** Pin all Git reads to one commit; uncommitted sources are never mixed in. */
export function readLoadInputs(root: string): LoadInputs {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 128 * 1024 * 1024 })
  let revision: string | undefined
  try {
    if (realpathSync(git('rev-parse', '--show-toplevel').toString().trim()) === realpathSync(root)) revision = git('rev-parse', '--verify', 'HEAD').toString().trim()
  } catch { /* A standalone context can still be previewed. */ }
  const files = new Map<string, string>()
  if (revision) {
    const entries = git('ls-tree', '-rz', '--full-tree', revision, '--', ...paths).toString().split('\0').filter(Boolean)
      .map(line => { const [meta, path] = line.split('\t'); const [mode, type, oid] = meta.split(' '); return { mode, type, oid, path } })
      .filter(e => e.type === 'blob' && e.mode !== '120000' && /\.(json|md|yaml)$/.test(e.path))
    if (entries.length) {
      const output = execFileSync('git', ['-C', root, 'cat-file', '--batch'], { input: entries.map(e => e.oid).join('\n') + '\n', maxBuffer: 128 * 1024 * 1024 })
      let offset = 0
      for (const e of entries) {
        const end = output.indexOf(10, offset)
        const [oid, type, size] = output.subarray(offset, end).toString().split(' ')
        const length = Number(size)
        if (oid !== e.oid || type !== 'blob' || !Number.isSafeInteger(length)) throw new Error('load: invalid Git blob response')
        files.set(e.path, output.subarray(end + 1, end + 1 + length).toString())
        offset = end + length + 2
      }
    }
  } else {
    const visit = (path: string) => {
      if (!existsSync(path)) return
      for (const e of readdirSync(path, { withFileTypes: true })) {
        if (e.isDirectory()) visit(join(path, e.name))
        else if (e.isFile() && /\.(md|yaml)$/.test(e.name)) files.set(relative(root, join(path, e.name)), readFileSync(join(path, e.name), 'utf8'))
      }
    }
    for (const path of paths) {
      if (path.endsWith('.json')) { if (existsSync(join(root, path))) files.set(path, readFileSync(join(root, path), 'utf8')) }
      else visit(join(root, path))
    }
  }
  return { files, revision }
}
