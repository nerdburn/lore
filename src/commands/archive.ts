import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE, configSchema } from '../config.js'
import { cachePath, git, githubRepoFromRemote, resolveContext, unregisterProject, type ResolveOptions } from '../context.js'

export interface ArchiveOptions extends ResolveOptions {
  /** Reopen an archived client instead. */
  restore?: boolean
  /** Keep the ~/.lore cache clone and registry entry (default: remove them). */
  keepLocal?: boolean
}

/** Injectable side effects, so tests never touch GitHub or ~/.lore. */
export interface ArchiveDeps {
  gh: (args: string[]) => void
  removeCache: (repo: string) => void
  unregister: (project: string) => boolean
}

const defaultDeps: ArchiveDeps = {
  gh: (args) => execFileSync('gh', args, { stdio: ['ignore', 'ignore', 'pipe'] }),
  removeCache: (repo) => rmSync(cachePath(repo), { recursive: true, force: true }),
  unregister: unregisterProject,
}

/**
 * End (or reopen) an engagement. Archiving:
 *
 * 1. writes `lifecycle: archived` + `archived_at` into lore.json, commits,
 *    pushes — from here sync/extract are no-ops, writes are refused, reads
 *    are labelled;
 * 2. archives the GitHub repo (read-only, history kept, cron stops);
 * 3. drops the local cache clone and registry entry.
 *
 * The context repo is never deleted: it is the only copy of the synced
 * history and the pins. `--restore` reverses 1 and 2 (unarchive first,
 * since an archived repo can't be pushed to).
 */
export function archive(cwd: string, opts: ArchiveOptions, deps: ArchiveDeps = defaultDeps): void {
  const ctx = resolveContext(cwd, opts)
  const { root, config } = ctx
  const repo = ctx.repo ?? githubRepoFromRemote(root)
  const target = opts.restore ? 'active' : 'archived'

  if (config.lifecycle === target) {
    console.log(`${config.project} is already ${target}`)
    return
  }

  // Reopening: the GitHub repo must be writable before we can push.
  if (opts.restore && repo) {
    deps.gh(['repo', 'unarchive', repo, '--yes'])
    console.log(`✓ unarchived github.com/${repo}`)
    git(root, 'pull', '--ff-only', '--quiet')
  }

  const raw = JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8')) as Record<string, unknown>
  if (opts.restore) {
    raw.lifecycle = 'active'
    delete raw.archived_at
  } else {
    raw.lifecycle = 'archived'
    raw.archived_at = new Date().toISOString()
  }
  configSchema.parse(raw)
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify(raw, null, 2) + '\n')
  console.log(`✓ ${CONFIG_FILE}: lifecycle ${target}`)

  if (existsSync(join(root, '.git'))) {
    git(root, 'add', CONFIG_FILE)
    git(root, 'commit', '--quiet', '-m', `lore: ${opts.restore ? 'restore' : 'archive'} ${config.project}`)
    try {
      git(root, 'push', '--quiet')
      console.log(`✓ pushed`)
    } catch {
      throw new Error(
        `committed the lifecycle change but could not push${repo ? ` to ${repo}` : ''} — fix access, \`git -C ${root} push\`, then re-run \`lore archive\` to finish`,
      )
    }
  } else {
    console.log(`! ${root} is not a git repo — lifecycle changed on disk only`)
  }

  if (!opts.restore) {
    if (repo) {
      deps.gh(['repo', 'archive', repo, '--yes'])
      console.log(`✓ archived github.com/${repo} (read-only; daily sync stops)`)
    } else if (existsSync(join(root, '.git'))) {
      console.log('✓ self-hosted repo: lifecycle flag is the archive — the host\'s run-all skips it from now on')
    }
    if (!opts.keepLocal && ctx.mode === 'cache' && ctx.repo) {
      deps.removeCache(ctx.repo)
      console.log(`✓ removed cache clone ${cachePath(ctx.repo)}`)
    }
    if (!opts.keepLocal && deps.unregister(config.project)) {
      console.log(`✓ removed "${config.project}" from ~/.lore/registry.json`)
    }
    console.log(
      [
        '',
        'Still yours to do:',
        `  • remove the lore.json pointer + AGENTS.md section from any project repos linked to ${repo ?? config.project}`,
        '  • in Slack, remove @lore from the client channels (or leave it — it reads nothing once the cron stops)',
        `  • reads still work with --context ${repo ?? root} and are labelled ARCHIVED`,
      ].join('\n'),
    )
  } else {
    console.log(`${config.project} reopened — re-enable the daily workflow from the repo's Actions tab if GitHub paused it`)
  }
}
