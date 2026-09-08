import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { CONFIG_FILE } from '../config.js'
import { cachePath, git, readGlobalConfig, remoteUrl, writeGlobalConfig, type GlobalConfig } from '../context.js'
import { scaffold, type ScaffoldConfig } from './init.js'
import { link } from './link.js'

export interface SetupFlags {
  channels?: string
  /** Comma-separated "owner/repo" list — adds a github source. */
  github?: string
  backfill?: string
  org?: string
  yes?: boolean
}

/**
 * The whole scriptable half of onboarding, one command. Two hosting modes,
 * chosen by ~/.lore/config.json:
 *
 * - **remote** (`remote` set, e.g. "exedev@lore.exe.xyz:/srv/lore/repos"):
 *   create a bare repo on that host over SSH, scaffold, push. No GitHub,
 *   no Actions workflow, no secrets — the host's `lore run-all` timer syncs
 *   every repo it holds, and tokens are injected by proxies whose base URLs
 *   come from `proxy` in the same file.
 * - **github** (default): create a private repo in `defaultOrg`, scaffold
 *   with the daily workflow, set secrets from the environment, dispatch the
 *   first sync.
 *
 * Either way the repo you ran it from gets linked. Interactive by default
 * (derived defaults, Enter to accept); every prompt has a flag so agents
 * and scripts can run it with --yes.
 *
 * What stays human: creating the Slack app in a new workspace, and
 * /invite @lore in each channel — a bot can't invite itself, by design.
 */
export async function setup(cwd: string, repoArg: string | undefined, flags: SetupFlags): Promise<void> {
  const interactive = !flags.yes && process.stdin.isTTY === true
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null
  const ask = async (question: string, fallback: string): Promise<string> => {
    if (!rl) return fallback
    const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim()
    return answer || fallback
  }

  try {
    const global = readGlobalConfig()
    const mode: 'remote' | 'github' = global.remote ? 'remote' : 'github'

    // GitHub mode: org first — the one thing that must never be inferred
    // from the project repo: context repos belong in YOUR org, not the
    // client's. Asked once, saved globally.
    let org = flags.org ?? global.defaultOrg ?? ''
    if (mode === 'github') {
      if (!org) {
        org = await ask("GitHub org for context repos (yours, never the client's)", ghLogin())
        if (!org) throw new Error('no org — pass --org or run interactively once to set it')
      }
      if (org !== global.defaultOrg) writeGlobalConfig({ ...global, defaultOrg: org })
    }

    // Channels before name, so the name can fall back to the first channel.
    const channels = normalizeChannels(flags.channels ?? (await ask('Slack channels to sync (comma-separated)', '')))
    if (channels.length === 0) throw new Error('no channels — pass --channels "#acme,#acme-dev"')
    const repos = (flags.github ?? '')
      .split(/[,\s]+/)
      .map((r) => r.trim())
      .filter(Boolean)
    for (const r of repos) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error(`--github: "${r}" is not "owner/repo"`)
    }

    // Name: explicit arg > the project repo we're standing in > first channel.
    let name = repoArg?.includes('/') ? repoArg.split('/')[1] : repoArg
    if (repoArg?.includes('/')) org = repoArg.split('/')[0]
    if (!name) {
      const derived = projectRepoName(cwd) ?? channels[0].slice(1)
      name = await ask('Context repo name', `lore-${derived}`)
    }
    const ref = mode === 'remote' ? name : `${org}/${name}`
    const project = name.replace(/^lore-/, '')

    const months = Number(flags.backfill ?? (await ask('Backfill window in months (first sync)', '3')))

    const config: ScaffoldConfig = {
      project,
      lifecycle: 'active',
      sources: buildSources(channels, repos, mode === 'remote' ? global.proxy : undefined),
      backfill: { months: Number.isFinite(months) ? months : 3 },
      extract: ['requests', 'decisions', 'roadmap', 'weekly-report'],
    }

    const where = mode === 'remote' ? `${global.remote}/${name}.git` : `private ${ref}`
    console.log(
      `\nPlan: create ${where} · project "${project}" · ${channels.join(', ')}${repos.length ? ` · github: ${repos.join(', ')}` : ''} · ${config.backfill.months}mo backfill`,
    )
    if (interactive && (await ask('Proceed? (y/n)', 'y')).toLowerCase() !== 'y') {
      console.log('aborted')
      return
    }

    const root = cachePath(ref)
    mkdirSync(dirname(root), { recursive: true })
    if (mode === 'remote') {
      createBareRemote(global.remote!, name)
      execFileSync('git', ['clone', '--quiet', remoteUrl(ref), root], { stdio: ['ignore', 'ignore', 'pipe'] })
      scaffold(root, config, { workflow: false })
    } else {
      gh('repo', 'create', ref, '--private')
      gh('repo', 'clone', ref, root)
      scaffold(root, config)
    }
    git(root, 'checkout', '-B', 'main')
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', 'chore(lore): scaffold context repo')
    git(root, 'push', '--quiet', '-u', 'origin', 'main')
    console.log(`✓ created and scaffolded ${ref}`)

    if (mode === 'github') githubSecretsAndFirstSync(ref, root, repos)

    // Standing in a project repo? Finish the job.
    if (existsSync(join(cwd, '.git')) && !existsSync(join(cwd, CONFIG_FILE))) {
      link(cwd, ref)
    }

    console.log('\nStill human (by design):')
    console.log('  - if this workspace has no lore Slack app yet: `lore manifest slack` and create it')
    if (mode === 'remote') {
      console.log(`  - /invite @lore in ${channels.join(', ')} — the host's next \`lore run-all\` picks the repo up automatically`)
      if (!global.proxy?.slack) console.log('  - the host needs SLACK_TOKEN in its environment (no slack proxy configured)')
    } else {
      console.log(`  - /invite @lore in ${channels.join(', ')}, then re-run the sync from Actions`)
    }
  } finally {
    rl?.close()
  }
}

/** Source config for a new repo: env tokens by default, proxy base URLs (no token) when configured. */
export function buildSources(
  channels: string[],
  repos: string[],
  proxy: GlobalConfig['proxy'],
): Record<string, Record<string, unknown>> {
  const sources: Record<string, Record<string, unknown>> = {
    slack: proxy?.slack ? { channels, api_base: proxy.slack } : { channels, token: 'env:SLACK_TOKEN' },
  }
  if (repos.length) {
    sources.github = proxy?.github ? { repos, api_base: proxy.github } : { repos, token: 'env:LORE_GITHUB_TOKEN' }
  }
  return sources
}

/** `git init --bare` on the remote host (or locally when the remote is a path). */
function createBareRemote(remote: string, name: string): void {
  const m = /^(?:ssh:\/\/)?([^/:]+@[^/:]+)[:/](.+)$/.exec(remote)
  if (m) {
    const [, host, path] = m
    const dir = `${path.replace(/\/$/, '')}/${name}.git`
    execFileSync('ssh', [host, `test ! -e '${dir}' && git init --bare --quiet '${dir}' && git -C '${dir}' symbolic-ref HEAD refs/heads/main`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return
  }
  const dir = join(remote, `${name}.git`)
  if (existsSync(dir)) throw new Error(`${dir} already exists`)
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', dir], { stdio: ['ignore', 'ignore', 'pipe'] })
}

function githubSecretsAndFirstSync(slug: string, root: string, repos: string[]): void {
  // Secrets: repo-level, from the environment (cli.ts already loaded .env).
  // An org-level SLACK_TOKEN shared to this repo works too — we just can't
  // see it from here, so we only warn when neither could exist.
  const token = process.env.SLACK_TOKEN
  if (token) {
    execFileSync('gh', ['secret', 'set', 'SLACK_TOKEN', '--repo', slug], { input: token, stdio: ['pipe', 'ignore', 'pipe'] })
    console.log('✓ SLACK_TOKEN set from environment')
  } else {
    console.log('! SLACK_TOKEN not in env — set it: gh secret set SLACK_TOKEN --repo ' + slug)
  }
  if (repos.length) {
    const ghToken = process.env.LORE_GITHUB_TOKEN
    if (ghToken) {
      execFileSync('gh', ['secret', 'set', 'LORE_GITHUB_TOKEN', '--repo', slug], { input: ghToken, stdio: ['pipe', 'ignore', 'pipe'] })
      console.log('✓ LORE_GITHUB_TOKEN set from environment')
    } else {
      console.log('! LORE_GITHUB_TOKEN not in env — the github source will fail until set: gh secret set LORE_GITHUB_TOKEN --repo ' + slug)
    }
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    execFileSync('gh', ['secret', 'set', 'ANTHROPIC_API_KEY', '--repo', slug], { input: anthropicKey, stdio: ['pipe', 'ignore', 'pipe'] })
    console.log('✓ ANTHROPIC_API_KEY set from environment (enables daily extract)')
  } else {
    console.log('! ANTHROPIC_API_KEY not in env — extract will be skipped until the secret is set')
  }

  ensureWorkflowRegistered(slug, root)

  if (token) {
    try {
      gh('workflow', 'run', 'lore-sync.yml', '--repo', slug)
      console.log('✓ first sync dispatched — watch: gh run watch --repo ' + slug)
    } catch {
      console.log('! could not dispatch the first sync — run it from the Actions tab')
    }
  }
}

function normalizeChannels(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (c.startsWith('#') ? c : `#${c}`))
}

/** "org/repo.git" remote of the repo containing cwd → "repo", else null. */
function projectRepoName(cwd: string): string | null {
  try {
    const url = git(cwd, 'remote', 'get-url', 'origin')
    return basename(url).replace(/\.git$/, '')
  } catch {
    return null
  }
}

/**
 * GitHub sometimes doesn't register a workflow that arrives in the
 * repo-creating push. Poll briefly; nudge with a commit touching the file.
 */
function ensureWorkflowRegistered(slug: string, root: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (gh('api', `repos/${slug}/actions/workflows`, '--jq', '.total_count') !== '0') {
        console.log('✓ sync workflow registered')
        return
      }
    } catch {
      /* API lag — treat as unregistered and retry */
    }
    if (attempt === 0) {
      const path = join(root, '.github/workflows/lore-sync.yml')
      writeFileSync(path, readFileSync(path, 'utf8') + '\n')
      git(root, 'add', '-A')
      git(root, 'commit', '--quiet', '-m', 'ci: nudge workflow registration')
      git(root, 'push', '--quiet')
    }
    execFileSync('sleep', ['5'])
  }
  console.log('! workflow not registered yet — push any commit touching it, or check the Actions tab')
}

function ghLogin(): string {
  try {
    return gh('api', 'user', '--jq', '.login')
  } catch {
    return ''
  }
}

function gh(...args: string[]): string {
  return execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim()
}
