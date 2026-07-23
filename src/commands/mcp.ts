import { readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { parse } from 'yaml'
import { z } from 'zod'
import { git, resolveContext, type ResolveOptions } from '../context.js'
import { grepContext } from '../search.js'
import type { Pin } from '../types.js'
import { remember } from './remember.js'

const PULL_INTERVAL_MS = 60_000

/**
 * Expose the query surface as MCP tools over stdio, so agents get project
 * memory without knowing it's a git repo. The context is resolved once at
 * startup; reads re-pull at most once a minute.
 */
export async function mcp(cwd: string, opts: ResolveOptions): Promise<void> {
  const ctx = resolveContext(cwd, opts)
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

  const server = new McpServer({ name: 'lore', version: '0.3.0' })
  const text = (value: unknown) => ({
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  })

  server.registerTool(
    'lore_grep',
    {
      description: `Search ${ctx.config.project}'s project memory (synced Slack history, decisions, pinned facts). Pattern is a regex; falls back to literal. Returns file:line matches — read surrounding context with lore_read.`,
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
      description: 'List pinned facts (and derived artifacts, when present) — "what do we know" without a search term.',
      inputSchema: { category: z.string().optional() },
    },
    async ({ category }) => {
      freshen()
      const pins = (parse(readFileSync(join(ctx.root, 'context/facts.yaml'), 'utf8')) as Pin[] | null) ?? []
      return text(category ? pins.filter((p) => p.category === category) : pins)
    },
  )

  server.registerTool(
    'lore_remember',
    {
      description: 'Pin a fact to project memory permanently. Use ONLY on explicit user instruction — never to cache your own inferences.',
      inputSchema: {
        fact: z.string(),
        category: z.string().optional().describe('e.g. client, deployment, decisions'),
        source: z.string().optional().describe('optional source link'),
      },
    },
    async ({ fact, category, source }) => {
      // Re-resolve with the server's own options so cache mode commits+pushes.
      remember(cwd, fact, { ...opts, category, source, by: 'mcp-agent' })
      return text(`pinned: ${fact}`)
    },
  )

  await server.connect(new StdioServerTransport())
}
