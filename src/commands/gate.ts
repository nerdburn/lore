import { execFileSync } from 'node:child_process'
import { loadConfig } from '../config.js'
import { alwaysFolds, DEFAULT_GATE_THRESHOLD, gateConfig, runGate, type Fetch } from '../gate.js'
import { describeWorkForPrompt, parseWorkItems, workFile, workPrefix } from '../work.js'

/**
 * `lore gate replay` — measure the fold gate against this context repo's own
 * history before trusting it on the timer.
 *
 * Every fold leaves a commit that bumps `lastExtract` in state.json —
 * labelled "sync" when it changed an artifact, "heartbeat" when it found
 * nothing. The streams gained between one fold commit and the next are the
 * new material that fold saw (the gate would have seen); that commit's
 * changes to derived artifacts, or tickets moved/created `via: fold`, are
 * what the fold made of it. Replaying the gate over that material — with the
 * tracker and pins as they stood just before — gives, per threshold, how
 * many folds would have been skipped and, the number that matters, how many
 * of those skips would have lost a real change. Only folds the gate would
 * actually judge are replayed: incremental ones onto existing artifacts,
 * with no attached document.
 */

const DERIVED = ['requests', 'decisions', 'roadmap', 'contradictions'].map((n) => `context/derived/${n}.yaml`)
const INCREMENTAL_MAX_CHARS = 60_000
const THRESHOLDS = [0.1, 0.2, 0.3, 0.5, 0.7]
const CONCURRENCY = 8

export interface ReplayRow {
  sha: string
  date: string
  chars: number
  /** What the fold actually changed: "requests", "work" … empty = the fold found nothing. */
  changed: string[]
  max: Record<string, number>
  top: { question: string; p: number }
}

export interface ReplayReport {
  replayed: number
  folded_something: number
  inputTokens: number
  thresholds: { threshold: number; skipped: number; missed: number; missedShas: string[] }[]
  rows: ReplayRow[]
}

export async function gateReplay(
  root: string,
  opts: { since?: string; limit?: number; json?: boolean; fetch?: Fetch; apiKey?: string } = {},
): Promise<ReplayReport> {
  const apiKey = opts.apiKey ?? gateConfig()?.apiKey
  if (!apiKey) throw new Error('gate replay: set TYPESAFE_API_KEY')
  const config = loadConfig(root)
  const prefix = workPrefix(config)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  const show = (rev: string, path: string) => {
    try {
      return git('show', `${rev}:${path}`)
    } catch {
      return undefined
    }
  }

  // Every commit that moved lastExtract, oldest first. Material is measured
  // from the fold before, so the window starts one fold early.
  const folds = git('log', '--reverse', '--format=%H\t%cI', '-G"lastExtract"', '--', 'state.json')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
  const since = opts.since ? new Date(git('log', '-1', '--format=%cI', `--until=${opts.since}`) || 0).getTime() : 0

  const cases: { sha: string; date: string; material: { path: string; text: string }[]; changed: string[]; parent: string }[] = []
  for (let i = 1; i < folds.length; i++) {
    const [sha, date] = folds[i]
    if (new Date(date).getTime() <= since) continue
    const parent = `${sha}^`
    if (!show(parent, DERIVED[0])) continue
    const material = addedLines(git('diff', '-U0', folds[i - 1][0], sha, '--', 'context/streams'))
    const chars = material.reduce((n, m) => n + m.text.length, 0)
    // No new material: a run that made no LLM call. Too much or a document: the gate never judges it.
    if (material.length === 0 || chars > INCREMENTAL_MAX_CHARS || material.some((m) => alwaysFolds(m.path))) continue
    const changed = git('show', '--format=', '--name-only', sha, '--', ...DERIVED)
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^context\/derived\/|\.yaml$/g, ''))
    if (/^\+.*via: fold/m.test(git('show', '--format=', '-U0', sha, '--', workFile(prefix)))) changed.push('work')
    cases.push({ sha, date: date.slice(0, 16), material, changed, parent })
  }
  if (opts.limit) cases.splice(0, Math.max(0, cases.length - opts.limit))

  const rows: ReplayRow[] = []
  let inputTokens = 0
  for (let i = 0; i < cases.length; i += CONCURRENCY) {
    const slice = cases.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      slice.map((c) =>
        runGate(
          {
            material: c.material,
            trackedWork: describeWorkForPrompt(parseWorkItems(show(c.parent, workFile(prefix)) ?? ''), c.date.slice(0, 10)),
            pins: show(c.parent, 'context/facts.yaml') ?? '',
          },
          { apiKey, threshold: DEFAULT_GATE_THRESHOLD, fetch: opts.fetch },
        ),
      ),
    )
    results.forEach((r, j) => {
      const c = slice[j]
      inputTokens += r.inputTokens
      rows.push({ sha: c.sha.slice(0, 7), date: c.date, chars: c.material.reduce((n, m) => n + m.text.length, 0), changed: c.changed, max: r.max, top: r.top })
    })
  }

  const report: ReplayReport = {
    replayed: rows.length,
    folded_something: rows.filter((r) => r.changed.length > 0).length,
    inputTokens,
    thresholds: THRESHOLDS.map((threshold) => {
      const skipped = rows.filter((r) => r.top.p < threshold)
      const missed = skipped.filter((r) => r.changed.length > 0)
      return { threshold, skipped: skipped.length, missed: missed.length, missedShas: missed.map((r) => r.sha) }
    }),
    rows,
  }
  if (opts.json) console.log(JSON.stringify(report, null, 2))
  else printReplay(config.project, report)
  return report
}

/** `git show -U0` of stream files → the appended lines per file. */
export function addedLines(diff: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  let current: { path: string; lines: string[] } | undefined
  const flush = () => {
    if (current?.lines.length) out.push({ path: current.path, text: current.lines.join('\n') })
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      flush()
      current = line === '+++ /dev/null' ? undefined : { path: line.replace(/^\+\+\+ b\//, ''), lines: [] }
    } else if (current && line.startsWith('+')) current.lines.push(line.slice(1))
  }
  flush()
  return out
}

function printReplay(project: string, r: ReplayReport): void {
  console.log(`${project}: replayed ${r.replayed} incremental fold(s); ${r.folded_something} changed something (${r.inputTokens.toLocaleString()} Jev input tokens)`)
  if (r.replayed === 0) return
  console.log('threshold  skipped  missed')
  for (const t of r.thresholds) console.log(`${String(t.threshold).padEnd(11)}${String(t.skipped).padEnd(9)}${t.missed}${t.missedShas.length ? `  (${t.missedShas.join(', ')})` : ''}`)
  const misses = new Set(r.thresholds.find((t) => t.threshold === DEFAULT_GATE_THRESHOLD)?.missedShas ?? [])
  for (const row of r.rows.filter((x) => misses.has(x.sha)))
    console.log(`  miss ${row.sha} ${row.date}: fold changed ${row.changed.join(', ')}; gate top ${row.top.question} p=${row.top.p.toFixed(2)}`)
}
