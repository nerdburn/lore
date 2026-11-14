// Pushing a context clone that other writers push to as well: the host's
// sync timer, laptops, and the board/MCP writing through a cache clone.
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { AUDIT_FILE, type AuditEntry } from './audit.js'
import { git } from './context.js'
import { mergeWorkItems, parseWorkItems, WORK_DIR, writeWorkItems, type LoreWorkItem } from './work.js'
import { LOAD_FILE, saveLoad } from './load/store.js'
import { mergeSemantic } from './load/semantic-events.js'
import { buildLoad } from './load/build.js'
import type { LoadSnapshot } from './load/schema.js'

/**
 * A long run (a first fold can take an hour) races with pins and config
 * pushes from laptops. If the push is rejected, replay our sync commit on top
 * of the remote and push again. Our commit wins any conflict on the files it
 * touched — streams, derived artifacts and state are regenerated from
 * sources, so the fresher fold is the right one to keep — and everything
 * else (lore.json, facts.yaml) comes through from the remote untouched.
 * The work tracker and audit log are the exception: they are records, not
 * regenerable, and people write them through the board and MCP while a fold
 * runs, so they are merged entry by entry instead.
 *
 * Tracker writes through a cache clone (board, MCP, CLI) push the same way:
 * their commit only touches the tracker and audit log, so a race with the
 * timer's sync of the same ticket merges history rather than conflicting,
 * and a rebase that still fails is aborted so the clone is never left stuck.
 */
export function pushWithRebase(root: string, attempts = 3): void {
  for (let i = 1; ; i++) {
    try {
      git(root, 'push', '--quiet', 'origin', 'HEAD:main')
      return
    } catch (err) {
      if (i >= attempts) throw new Error(`push rejected ${attempts} times — ${err instanceof Error ? err.message.split('\n')[0] : err}`)
      git(root, 'fetch', '--quiet', 'origin')
      const records = mergeRecords(root, 'origin/main')
      try {
        // During a rebase "theirs" is the commit being replayed — ours.
        git(root, '-c', 'user.name=lore', '-c', 'user.email=lore@localhost', 'rebase', '--quiet', '-X', 'theirs', 'origin/main')
      } catch (rebaseErr) {
        try {
          git(root, 'rebase', '--abort')
        } catch {
          /* nothing to abort */
        }
        throw new Error(`push rejected and rebase onto origin/main failed: ${rebaseErr instanceof Error ? rebaseErr.message.split('\n')[0] : rebaseErr}`)
      }
      records()
    }
  }
}

/**
 * Computed before the rebase, which mangles these files hunk by hunk; the
 * returned function writes the merge over the rebased tree and amends it in.
 */
export function mergeRecords(root: string, upstream: string): () => void {
  const base = git(root, 'merge-base', 'HEAD', upstream)
  const changed = (rev: string) => new Set(git(root, 'diff', '--name-only', base, rev, '--', WORK_DIR, AUDIT_FILE, LOAD_FILE).split('\n').filter(Boolean))
  const ours = changed('HEAD')
  const both = [...changed(upstream)].filter((p) => ours.has(p))
  const show = (rev: string, path: string) => {
    // A newly added record may not exist in the base. Only that absence is
    // empty: an unreadable blob (including output overflow) must abort before
    // the rebase, never turn a complete tracker or audit log into no records.
    if (!git(root, 'ls-tree', rev, '--', path)) return ''
    return git(root, 'show', `${rev}:${path}`)
  }

  const tables: { prefix: string; items: LoreWorkItem[] }[] = []
  const rekeyed: Record<string, string> = {}
  for (const path of both.filter((p) => p.startsWith(`${WORK_DIR}/`) && p.endsWith('.yaml'))) {
    const prefix = basename(path, '.yaml')
    const r = mergeWorkItems(parseWorkItems(show(base, path)), parseWorkItems(show('HEAD', path)), parseWorkItems(show(upstream, path)), prefix)
    tables.push({ prefix, items: r.items })
    Object.assign(rekeyed, r.rekeyed)
  }
  for (const [from, to] of Object.entries(rekeyed)) console.warn(`  work: ${from} was created upstream while this run held it — ours is now ${to}`)
  const audit = both.includes(AUDIT_FILE) ? mergeAudit(show(base, AUDIT_FILE), show('HEAD', AUDIT_FILE), show(upstream, AUDIT_FILE), rekeyed) : undefined
  const loadOurs = both.includes(LOAD_FILE) ? JSON.parse(show('HEAD', LOAD_FILE)) as LoadSnapshot : undefined
  const loadTheirs = both.includes(LOAD_FILE) ? JSON.parse(show(upstream, LOAD_FILE)) as LoadSnapshot : undefined
  const semantic = loadOurs?.semantic || loadTheirs?.semantic ? mergeSemantic(loadOurs?.semantic, loadTheirs?.semantic) : undefined

  return () => {
    if (tables.length === 0 && audit === undefined && !semantic) return
    const paths = tables.map(({ prefix, items }) => writeWorkItems(root, prefix, items))
    if (semantic) { saveLoad(root, buildLoad(root, undefined, semantic)); paths.push(LOAD_FILE) }
    if (audit !== undefined) {
      writeFileSync(join(root, AUDIT_FILE), audit)
      paths.push(AUDIT_FILE)
    }
    git(root, 'add', ...paths)
    if (git(root, 'diff', '--cached', '--name-only') === '') return
    git(root, '-c', 'user.name=lore', '-c', 'user.email=lore@localhost', 'commit', '--quiet', '--amend', '--no-edit')
  }
}

function mergeAudit(base: string, ours: string, theirs: string, rekeyed: Record<string, string>): string {
  const lines = (text: string) => text.split('\n').filter(Boolean)
  const known = new Set([...lines(base), ...lines(theirs)])
  const added = lines(ours)
    .filter((l) => !known.has(l))
    .map((l) => {
      try {
        const entry = JSON.parse(l) as AuditEntry
        return entry.action === 'work' && entry.id in rekeyed ? JSON.stringify({ ...entry, id: rekeyed[entry.id] }) : l
      } catch {
        return l
      }
    })
  return [...lines(theirs), ...added].map((l) => `${l}\n`).join('')
}

