import { readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { git, resolveContext, type ResolvedContext, type ResolveOptions } from '../context.js'
import { recallData } from '../recall.js'
import { grepContext } from '../search.js'
import { refresh } from './refresh.js'
import { remember } from './remember.js'

const PULL_INTERVAL_MS = 60_000

/**
 * Expose the query surface as MCP tools over stdio, so agents get project
 * memory without knowing it's a git repo. The context is resolved once at
 * startup; reads re-pull at most once a minute.
 */
export async function mcp(cwd: string, opts: ResolveOptions): Promise<void> {
  const ctx = resolveContext(cwd, opts)
  const server = createServer(ctx, { cwd, opts })
  await server.connect(new StdioServerTransport())
}

/**
 * Build the server for an already-resolved context. Split from `mcp()` so
 * tests can connect it over an in-memory transport against a fixture repo.
 * `rememberOpts` are the resolve options the write path re-resolves with,
 * so cache mode still commits + pushes.
 */
export function createServer(ctx: ResolvedContext, rememberOpts: { cwd: string; opts: ResolveOptions }): McpServer {
  let lastPull = Date.now()
  const freshen = () => {
    if (ctx.mode !== 'cache' || Date.now() - lastPull < PULL_INTERVAL_MS) return
    lastPull = Date.now()
    try {
      git(ctx.root, 'pull', '--ff-only', '--quiet')
    } catch {
      /* offline — serve the cached copy */
    }
  }

  const archived = ctx.config.lifecycle === 'archived'
  const label = archived
    ? `ARCHIVED client (engagement ended ${ctx.config.archived_at?.slice(0, 10) ?? 'unknown'}; this is history, not current state). `
    : ''
  const server = new McpServer({ name: 'lore', version: '0.3.0' })
  const text = (value: unknown) => ({
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  })

  server.registerTool(
    'lore_grep',
    {
      description: `${label}Search ${ctx.config.project}'s project memory (synced Slack history, decisions, pinned facts). Pattern is a regex; falls back to literal. Returns file:line matches — read surrounding context with lore_read.`,
      inputSchema: {
        pattern: z.string().describe('regex or literal to search for'),
        channel: z.string().optional().describe('substring filter on the file path, e.g. a channel name'),
        ignoreCase: z.boolean().optional().default(true),
        limit: z.number().int().min(1).max(500).optional().default(50),
      },
    },
    async ({ pattern, channel, ignoreCase, limit }) => {
      freshen()
      return text(grepContext(ctx.root, pattern, { ignoreCase, path: channel, limit }))
    },
  )

  server.registerTool(
    'lore_read',
    {
      description: 'Read a file from project memory by the path lore_grep returned (e.g. "context/streams/slack/#acme/2026-07-01.md").',
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      freshen()
      const rel = normalize(path)
      if (rel.startsWith('..') || !rel.startsWith('context')) {
        throw new Error('path must be inside context/')
      }
      return text(readFileSync(join(ctx.root, rel), 'utf8'))
    },
  )

  server.registerTool(
    'lore_recall',
    {
      description:
        label +
        'Pinned facts, every derived artifact (requests, decisions, roadmap, contradictions), source-owned work tables (the live GitHub issue/PR list — authoritative for delivery state; open items in full, closed/merged as counts, full table via lore_read of the given file), and recent weekly reports, with source-freshness timestamps — "what do we know" without a search term. Pins win over derived data on conflict; work tables win over derived for delivery state. Filter with category: a pin category or one of requests|decisions|roadmap|contradictions|work|reports.',
      inputSchema: { category: z.string().optional() },
    },
    async ({ category }) => {
      freshen()
      return text(recallData(ctx.root, ctx.config, category))
    },
  )

  server.registerTool(
    'lore_sync_now',
    {
      description:
        'Refresh project memory. Pulls the latest synced data; with trigger=true also asks the lore host to sync right now (Slack, GitHub, Granola, Notion, Jira) and waits for it — about a minute. Raw streams (lore_grep/lore_read) are then current; derived artifacts (lore_recall: requests/decisions/roadmap) are refreshed by the hourly fold, so lastExtract may lag lastSync — pass fold=true to run that fold now as well (a minute or two more) when the user needs recall itself to be current. If a host run is already in flight it waits for that one instead of starting another (host: "waited"). Use only when the user asks for fresh data or the last sync is stale. Never run `lore sync` yourself: agents cannot sync, only the host can. Returns before/after freshness plus host/outcome; a failed host run is reported in outcome, not thrown.',
      inputSchema: {
        trigger: z.boolean().optional().default(true).describe('ask the host to sync now (default true); false = just pull what the host already has'),
        fold: z.boolean().optional().default(false).describe('also run the LLM fold so recall (requests/decisions/roadmap) is current, not just the raw streams (default false; costs a fold, ~1–2 min)'),
        force: z.boolean().optional().default(false).describe('re-run even if the host synced (or, with fold, folded) within the last 10 minutes'),
      },
    },
    async ({ trigger, force, fold }) => {
      lastPull = Date.now()
      const r = refresh(rememberOpts.cwd, { ...rememberOpts.opts, trigger, force, fold })
      return text(r)
    },
  )

  server.registerTool(
    'lore_remember',
    {
      description: archived
        ? 'Unavailable: this client is archived and its memory is read-only.'
        : 'Pin a fact to project memory permanently. Use ONLY on explicit user instruction — never to cache your own inferences.',
      inputSchema: {
        fact: z.string(),
        category: z.string().optional().describe('e.g. client, deployment, decisions'),
        source: z.string().optional().describe('optional source link'),
      },
    },
    async ({ fact, category, source }) => {
      // The caller never supplies the actor: it is the OS identity the
      // server runs as, tagged as an MCP write in the audit log.
      const pin = remember(rememberOpts.cwd, fact, { ...rememberOpts.opts, category, source, via: 'mcp' })
      return text(`pinned ${pin.id}: ${fact}`)
    },
  )

  return server
}
