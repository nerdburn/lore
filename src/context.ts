import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { CONFIG_FILE, configSchema, type LoreConfig } from './config.js'

/**
 * Where a lore command's data actually lives. Two modes:
 * - local: cwd (or an ancestor) IS a context repo — operate in place
 * - cache: lore.json here is only a pointer ({"context": "owner/repo"}),
 *   or the repo was named via --context/--project — operate on a clone
 *   under ~/.lore/cache, pulled before reads, pushed after writes.
 */
export interface ResolvedContext {
  /** Directory containing lore.json and context/. */
  root: string
  config: LoreConfig
  mode: 'local' | 'cache'
  /** "owner/repo" when mode === 'cache'. */
  repo?: string
}

export interface ResolveOptions {
  /** Explicit "owner/repo" (or a filesystem path) — wins over everything. */
  context?: string
  /** Project name to look up in the registry (for agents with no repo at all). */
  project?: string
  /** Skip `git pull` on the cache (offline / hot loop). Default: pull. */
  pull?: boolean
}

const LORE_HOME = join(homedir(), '.lore')
const REGISTRY_FILE = join(LORE_HOME, 'registry.json')

const REPO_RE = /^[\w.-]+\/[\w.-]+$/

export function resolveContext(cwd: string, opts: ResolveOptions = {}): ResolvedContext {
  if (opts.context) {
    if (REPO_RE.test(opts.context)) return fromCache(opts.context, opts)
    const root = resolve(cwd, opts.context)
    return fromLocalDir(root)
  }

  const found = findLoreJson(cwd)
  if (found) {
    const raw = JSON.parse(readFileSync(join(found, CONFIG_FILE), 'utf8')) as Record<string, unknown>
    if (typeof raw.context === 'string') {
      if (!REPO_RE.test(raw.context) && !isAbsolute(raw.context)) {
        throw new Error(`${CONFIG_FILE}: "context" must be "owner/repo" or an absolute path, got "${raw.context}"`)
      }
      return REPO_RE.test(raw.context) ? fromCache(raw.context, opts) : fromLocalDir(raw.context)
    }
    return fromLocalDir(found)
  }

  if (opts.project) {
    const repo = readRegistry()[opts.project]
    if (!repo) {
      throw new Error(
        `project "${opts.project}" not in ${REGISTRY_FILE} — run any lore command once from a repo that points at it, or pass --context owner/repo`,
      )
    }
    return fromCache(repo, opts)
  }

  throw new Error(
    `no ${CONFIG_FILE} found from ${cwd} upward — run \`lore init\` (context repo), \`lore link owner/repo\` (project repo), or pass --context/--project`,
  )
}

/** Walk up from cwd looking for lore.json (stops at filesystem root). */
function findLoreJson(from: string): string | null {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function fromLocalDir(root: string): ResolvedContext {
  const config = loadFullConfig(root)
  return { root, config, mode: 'local' }
}

function fromCache(repo: string, opts: ResolveOptions): ResolvedContext {
  const root = cachePath(repo)
  if (!existsSync(join(root, '.git'))) {
    mkdirSync(dirname(root), { recursive: true })
    clone(repo, root)
  } else if (opts.pull !== false) {
    try {
      git(root, 'pull', '--ff-only', '--quiet')
    } catch {
      console.error(`warning: could not pull ${repo} — using cached copy`)
    }
  }
  const config = loadFullConfig(root)
  registerProject(config.project, repo)
  return { root, config, mode: 'cache', repo }
}

function loadFullConfig(root: string): LoreConfig {
  const path = join(root, CONFIG_FILE)
  if (!existsSync(path)) throw new Error(`no ${CONFIG_FILE} in ${root}`)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (typeof raw.context === 'string') {
    throw new Error(`${root} is itself a pointer (${CONFIG_FILE} has "context") — pointers must lead to a context repo, not another pointer`)
  }
  return configSchema.parse(raw)
}

export function cachePath(repo: string): string {
  return join(LORE_HOME, 'cache', repo.replace('/', '__'))
}

function clone(repo: string, dest: string): void {
  // SSH first (how dev machines usually auth), https as fallback (CI, tokens).
  try {
    execFileSync('git', ['clone', '--depth', '50', '--quiet', `git@github.com:${repo}.git`, dest], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch {
    execFileSync('git', ['clone', '--depth', '50', '--quiet', `https://github.com/${repo}.git`, dest], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  }
}

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim()
}

/**
 * ~/.lore/registry.json maps project name → "owner/repo". Written as a side
 * effect of every cache resolution, so `lore --project <name> …` works from
 * anywhere after the first use.
 */
function readRegistry(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function registerProject(project: string, repo: string): void {
  const registry = readRegistry()
  if (registry[project] === repo) return
  registry[project] = repo
  mkdirSync(LORE_HOME, { recursive: true })
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n')
}
