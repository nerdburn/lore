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

/** ~/.lore — overridable with LORE_HOME (tests, or a runner with its own home). */
export function loreHome(): string {
  return process.env.LORE_HOME ?? join(homedir(), '.lore')
}
const registryFile = () => join(loreHome(), 'registry.json')
const globalConfigFile = () => join(loreHome(), 'config.json')

/** "owner/repo" — a GitHub-hosted context repo (the original layout). */
const GITHUB_RE = /^[\w.-]+\/[\w.-]+$/
/** "lore-acme" — a repo on the configured remote (self-hosted layout). */
const NAME_RE = /^[\w.-]+$/

/**
 * ~/.lore/config.json — machine-wide settings.
 * - defaultOrg: GitHub org for `lore setup` in GitHub mode.
 * - remote: where self-hosted context repos live, e.g.
 *   "exedev@lore.exe.xyz:/srv/lore/repos" or "/srv/lore/repos" (on the
 *   host itself). A pointer "lore-acme" resolves to "<remote>/lore-acme.git".
 * - proxy: per-source API base URLs `lore setup` writes into new repos when
 *   tokens are injected by a proxy (exe.dev integrations) instead of env.
 */
export interface GlobalConfig {
  defaultOrg?: string
  remote?: string
  proxy?: { slack?: string; github?: string; granola?: string; notion?: string }
}

export function readGlobalConfig(): GlobalConfig {
  try {
    return JSON.parse(readFileSync(globalConfigFile(), 'utf8')) as GlobalConfig
  } catch {
    return {}
  }
}

export function writeGlobalConfig(config: GlobalConfig): void {
  mkdirSync(loreHome(), { recursive: true })
  writeFileSync(globalConfigFile(), JSON.stringify(config, null, 2) + '\n')
}

/** Is this string a context-repo reference (GitHub or remote name) rather than a path? */
export function isRepoRef(value: string): boolean {
  return GITHUB_RE.test(value) || (NAME_RE.test(value) && Boolean(readGlobalConfig().remote))
}

/**
 * Clone URL for a repo reference. "owner/repo" → GitHub; a bare name →
 * the configured remote. `preferHttps` picks the GitHub fallback URL.
 */
export function remoteUrl(ref: string, preferHttps = false): string {
  if (GITHUB_RE.test(ref)) return preferHttps ? `https://github.com/${ref}.git` : `git@github.com:${ref}.git`
  const remote = readGlobalConfig().remote
  if (!remote) throw new Error(`"${ref}" is a bare repo name but ~/.lore/config.json has no "remote"`)
  return `${remote.replace(/\/$/, '')}/${ref}.git`
}

export function resolveContext(cwd: string, opts: ResolveOptions = {}): ResolvedContext {
  if (opts.context) {
    if (isRepoRef(opts.context) && !existsSync(resolve(cwd, opts.context))) return fromCache(opts.context, opts)
    const root = resolve(cwd, opts.context)
    return fromLocalDir(root)
  }

  const found = findLoreJson(cwd)
  if (found) {
    const raw = JSON.parse(readFileSync(join(found, CONFIG_FILE), 'utf8')) as Record<string, unknown>
    if (typeof raw.context === 'string') {
      if (isAbsolute(raw.context)) return fromLocalDir(raw.context)
      if (!isRepoRef(raw.context)) {
        throw new Error(
          `${CONFIG_FILE}: "context" must be "owner/repo", a repo name on the configured remote, or an absolute path, got "${raw.context}"`,
        )
      }
      return fromCache(raw.context, opts)
    }
    return fromLocalDir(found)
  }

  // Environment fallbacks let an MCP client config or a harness pin the
  // project without flags or a lore.json: LORE_CONTEXT (repo ref or path)
  // or LORE_PROJECT (registry name). Below flags and a cwd lore.json.
  if (!opts.project && process.env.LORE_CONTEXT) return resolveContext(cwd, { ...opts, context: process.env.LORE_CONTEXT })
  if (!opts.project && process.env.LORE_PROJECT) opts = { ...opts, project: process.env.LORE_PROJECT }

  if (opts.project) {
    const repo = readRegistry()[opts.project]
    if (!repo) {
      throw new Error(
        `project "${opts.project}" not in ${registryFile()} — run any lore command once from a repo that points at it, or pass --context owner/repo`,
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
  // Archived clients stay out of the registry: `-p <name>` is for live
  // work, and a read shouldn't undo `lore archive`'s cleanup.
  if (config.lifecycle !== 'archived') registerProject(config.project, repo)
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
  return join(loreHome(), 'cache', repo.replace('/', '__'))
}

function clone(repo: string, dest: string): void {
  // GitHub: SSH first (how dev machines usually auth), https as fallback
  // (CI, tokens). Remote names have exactly one URL.
  try {
    execFileSync('git', ['clone', '--depth', '50', '--quiet', remoteUrl(repo), dest], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (err) {
    if (!GITHUB_RE.test(repo)) throw err
    execFileSync('git', ['clone', '--depth', '50', '--quiet', remoteUrl(repo, true), dest], {
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
export function readRegistry(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(registryFile(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function registerProject(project: string, repo: string): void {
  const registry = readRegistry()
  if (registry[project] === repo) return
  registry[project] = repo
  writeRegistry(registry)
}

export function unregisterProject(project: string): boolean {
  const registry = readRegistry()
  if (!(project in registry)) return false
  delete registry[project]
  writeRegistry(registry)
  return true
}

function writeRegistry(registry: Record<string, string>): void {
  mkdirSync(loreHome(), { recursive: true })
  writeFileSync(registryFile(), JSON.stringify(registry, null, 2) + '\n')
}

/** "owner/repo" from a GitHub remote URL (ssh or https), else undefined. */
export function githubRepoFromRemote(root: string): string | undefined {
  try {
    const url = git(root, 'remote', 'get-url', 'origin')
    const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)
    return m?.[1]
  } catch {
    return undefined
  }
}
