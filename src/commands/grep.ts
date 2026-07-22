import { resolveContext, type ResolveOptions } from '../context.js'
import { grepContext } from '../search.js'

export function grep(
  cwd: string,
  pattern: string,
  opts: ResolveOptions & { ignoreCase?: boolean; channel?: string; limit?: string; json?: boolean },
): void {
  const ctx = resolveContext(cwd, opts)
  const matches = grepContext(ctx.root, pattern, {
    ignoreCase: opts.ignoreCase,
    path: opts.channel,
    limit: opts.limit ? Number(opts.limit) : undefined,
  })

  if (opts.json) {
    console.log(JSON.stringify({ project: ctx.config.project, matches }, null, 2))
    return
  }
  if (matches.length === 0) {
    console.error(`no matches for "${pattern}" in ${ctx.config.project}`)
    process.exitCode = 1
    return
  }
  for (const m of matches) console.log(`${m.file}:${m.line}: ${m.text}`)
  console.error(`\n${matches.length} match${matches.length === 1 ? '' : 'es'} (${ctx.config.project}${ctx.repo ? ` via ${ctx.repo}` : ''})`)
}
