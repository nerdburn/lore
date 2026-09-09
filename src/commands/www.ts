import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { parse } from 'yaml'
import { configSchema } from '../config.js'
import { esc, renderMarkdown } from '../markdown.js'

export interface WwwOptions {
  /** Directory of bare context repos — the client registry. */
  repos: string
  port: number
  host?: string
}

export interface ClientStatus {
  name: string
  project?: string
  client?: string
  lifecycle?: string
  sources: string[]
  lastSync?: string
  lastExtract?: string
  health: Record<string, { lastSuccess?: string; lastError?: string }>
  lastCommit?: string
  error?: string
}

/**
 * `lore www` — the host's own page: the onboarding playbook and a live status
 * table of every client on this host, read straight from the bare repos.
 * No dependencies, no auth of its own: on exe.dev the HTTPS proxy in front
 * of it is private to the account (and shareable) — that is the access layer.
 */
export function www(opts: WwwOptions): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (url.pathname === '/status.json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ generated: new Date().toISOString(), clients: clientStatuses(opts.repos) }, null, 2))
        return
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page('lore', statusSection(clientStatuses(opts.repos)) + renderMarkdown(playbookMarkdown())))
        return
      }
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok\n')
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found\n')
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`error: ${err instanceof Error ? err.message : err}\n`)
    }
  })
  server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
    console.log(`lore www: http://${opts.host ?? '0.0.0.0'}:${opts.port}/  (repos: ${opts.repos})`)
  })
}

/** Read each bare repo's lore.json + state.json at HEAD without a checkout. */
export function clientStatuses(reposDir: string): ClientStatus[] {
  if (!existsSync(reposDir)) return []
  return readdirSync(reposDir)
    .filter((e) => e.endsWith('.git'))
    .sort()
    .map((bare) => {
      const name = basename(bare, '.git')
      const dir = join(reposDir, bare)
      const status: ClientStatus = { name, sources: [], health: {} }
      try {
        const cfg = configSchema.parse(JSON.parse(gitShow(dir, 'lore.json')))
        status.project = cfg.project
        status.client = cfg.client?.name
        status.lifecycle = cfg.lifecycle
        status.sources = Object.entries(cfg.sources)
          .filter(([, s]) => !s.disabled)
          .map(([k]) => k)
        const stateRaw = gitShow(dir, 'state.json', true)
        if (stateRaw) {
          const state = JSON.parse(stateRaw) as { lastSync?: string; lastExtract?: string; sources?: Record<string, { lastSuccess?: string; lastError?: { at: string; message: string } }> }
          status.lastSync = state.lastSync
          status.lastExtract = state.lastExtract
          for (const [src, h] of Object.entries(state.sources ?? {})) {
            status.health[src] = { lastSuccess: h.lastSuccess, lastError: h.lastError?.message }
          }
        }
        status.lastCommit = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%cI %s'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      } catch (err) {
        status.error = err instanceof Error ? err.message : String(err)
      }
      return status
    })
}

function gitShow(dir: string, path: string, optional = false): string {
  try {
    return execFileSync('git', ['-C', dir, 'show', `HEAD:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  } catch (err) {
    if (optional) return ''
    throw err
  }
}

function playbookMarkdown(): string {
  // Shipped in the package (package.json "files"); dev tree fallback.
  for (const candidate of [
    fileURLToPath(new URL('../../docs/PLAYBOOK.md', import.meta.url)),
    fileURLToPath(new URL('../../../docs/PLAYBOOK.md', import.meta.url)),
  ]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
  }
  return '# Client onboarding playbook\n\n_PLAYBOOK.md not found in this install._'
}

function statusSection(clients: ClientStatus[]): string {
  const ago = (iso?: string) => {
    if (!iso) return '—'
    const ms = Date.now() - new Date(iso).getTime()
    const h = Math.floor(ms / 3_600_000)
    return h < 1 ? `${Math.max(1, Math.floor(ms / 60_000))}m ago` : h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
  }
  const rows = clients
    .map((c) => {
      const errs = Object.entries(c.health)
        .filter(([, h]) => h.lastError)
        .map(([s, h]) => `<div class="err"><b>${esc(s)}</b>: ${esc(h.lastError!)}</div>`)
        .join('')
      return `<tr class="${c.lifecycle === 'archived' ? 'archived' : ''}">
        <td><code>${esc(c.name)}</code>${c.client ? `<div class="muted">${esc(c.client)}</div>` : ''}</td>
        <td>${esc(c.lifecycle ?? '?')}</td>
        <td>${c.sources.map((s) => `<span class="tag">${esc(s)}</span>`).join(' ')}</td>
        <td title="${esc(c.lastSync ?? '')}">${ago(c.lastSync)}</td>
        <td title="${esc(c.lastExtract ?? '')}">${ago(c.lastExtract)}</td>
        <td>${errs || (c.error ? `<div class="err">${esc(c.error)}</div>` : '<span class="ok">ok</span>')}</td>
      </tr>`
    })
    .join('')
  return `<section class="status"><h1 id="status">Clients on this host</h1>
<table><thead><tr><th>Context repo</th><th>Lifecycle</th><th>Sources</th><th>Synced</th><th>Extracted</th><th>Health</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">no context repos yet</td></tr>'}</tbody></table>
<p class="muted">Read live from <code>/srv/lore/repos</code> at every load · <a href="/status.json">status.json</a> · queries: <code>lore recall -p &lt;client&gt;</code></p></section>`
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1f1d1a;--muted:#6b665e;--line:#e6e1d8;--code:#f1ede5;--accent:#8a4b1f;--ok:#2f7d4f;--err:#a8321f}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ece7de;--muted:#9a938a;--line:#2c2925;--code:#22201c;--accent:#e0a068;--ok:#6fbf8a;--err:#e57a66}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:1.9rem;margin:2.2rem 0 .8rem;letter-spacing:-.01em}h2{font-size:1.35rem;margin:2.4rem 0 .6rem;padding-top:.6rem;border-top:1px solid var(--line)}h3{font-size:1.05rem;margin:1.6rem 0 .4rem}
p,li{max-width:70ch}a{color:var(--accent)}code{font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:.1em .35em;border-radius:4px}
pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow-x:auto;line-height:1.45}pre code{background:none;padding:0;font-size:.85rem}
table{border-collapse:collapse;width:100%;margin:.8rem 0 1.2rem;font-size:.93rem}th,td{text-align:left;vertical-align:top;padding:.5rem .6rem;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
.muted{color:var(--muted);font-size:.85rem}.tag{display:inline-block;background:var(--code);border-radius:999px;padding:.05em .6em;font-size:.8rem}.ok{color:var(--ok)}.err{color:var(--err);font-size:.85rem}.archived td{opacity:.55}
hr{border:0;border-top:1px solid var(--line);margin:2.5rem 0}.status{margin-bottom:2rem}
</style></head><body><main>${body}</main></body></html>`
}
