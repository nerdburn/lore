import { readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { git, resolveContext, type ResolvedContext, type ResolveOptions } from '../context.js'
import { recallData } from '../recall.js'
import { statusView } from '../status.js'
import { grepContext } from '../search.js'
import { refresh } from './refresh.js'
import { remember } from './remember.js'
import { docAdd } from './doc.js'
import { sowAdd } from './sow.js'
import { workAdd, workLabel, workMove, workPromote, workRank, workSet } from './work.js'
import { workPush } from './work-push.js'
import { sourceAdd, sourceList } from './source.js'
import { KNOWN_SOURCES } from '../config.js'
import { WORK_PRIORITIES, WORK_STATUSES } from '../work.js'
import type { WriteGateOptions } from '../write.js'

const PULL_INTERVAL_MS = 60_000

/**
 * Every tool the server registers, and whether it writes to the context repo.
 * `lore mcp --list-tools` prints this table, so anything that provisions an
 * agent (enso-agent-bootstrap's channel routing, the onboarding playbook)
 * derives its allow list from the installed binary instead of a hand copy
 * that drifts. A test asserts the registered tools match this table exactly.
 */
export const MCP_TOOLS: readonly { name: string; writes: boolean; summary: string }[] = [
  { name: 'lore_grep', writes: false, summary: 'regex search across synced memory' },
  { name: 'lore_read', writes: false, summary: 'read a file or line range from the context repo' },
  { name: 'lore_status', writes: false, summary: "what's outstanding, ready to relay: summary, live open work, freshness" },
  { name: 'lore_recall', writes: false, summary: 'pins, tracker, derived artifacts, reports, SOWs at once' },
  { name: 'lore_sync_now', writes: false, summary: 'pull, and ask the host to sync (and fold) now' },
  { name: 'lore_source_list', writes: false, summary: 'what is synced: each source, its scope, and its health' },
  { name: 'lore_remember', writes: true, summary: 'pin a fact (explicit user instruction only)' },
  { name: 'lore_sow_add', writes: true, summary: 'attach a statement of work' },
  { name: 'lore_doc_add', writes: true, summary: 'attach a document or link the client sent' },
  { name: 'lore_source_add', writes: true, summary: 'add a source or widen its scope: a repo, channel, folder, page, design file, board, mailbox (explicit only)' },
  { name: 'lore_work_add', writes: true, summary: 'open a tracker ticket' },
  { name: 'lore_work_promote', writes: true, summary: 'turn a derived request into a ticket' },
  { name: 'lore_work_move', writes: true, summary: 'change a ticket status, with a reason' },
  { name: 'lore_work_set', writes: true, summary: 'priority, assignee, labels, title, evidence, rank' },
  { name: 'lore_work_label', writes: true, summary: 'add or remove a project label on several tickets at once' },
  { name: 'lore_work_push', writes: true, summary: 'write ticket state to Jira: transition linked issues, create missing ones, put in-flight or requested tickets in a sprint (explicit only)' },
]

export interface McpCommandOptions extends ResolveOptions {
  /** Print the tool table as JSON and exit without resolving a context. */
  listTools?: boolean
}

/**
 * Expose the query surface as MCP tools over stdio, so agents get project
 * memory without knowing it's a git repo. The context is resolved once at
 * startup; reads re-pull at most once a minute.
 */
export async function mcp(cwd: string, opts: McpCommandOptions): Promise<void> {
  if (opts.listTools) {
    // No context needed: provisioning scripts call this on a VM whose lore
    // key may not be registered yet, so it must never touch the network.
    console.log(JSON.stringify(MCP_TOOLS, null, 2))
    return
  }
  const ctx = resolveContext(cwd, opts)
  const server = createServer(ctx, { cwd, opts })
  await server.connect(new StdioServerTransport())
}

/** Options the write tools re-resolve with: the context, plus (hosted) the attested actor. */
export type ServerWriteOptions = ResolveOptions & Pick<WriteGateOptions, 'actor'>

export interface ServerHooks {
  /**
   * Runs every write tool through this, so a server that hosts several
   * sessions on one clone can serialise their commits. Reads are not wrapped.
   */
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>
}

/**
 * Build the server for an already-resolved context. Split from `mcp()` so
 * tests can connect it over an in-memory transport against a fixture repo,
 * and so `lore www` can host one per HTTP session. `rememberOpts` are the
 * resolve options the write path re-resolves with, so cache mode still
 * commits + pushes; `opts.actor` (hosted only) is who the writes are
 * attributed to.
 */
export function createServer(ctx: ResolvedContext, rememberOpts: { cwd: string; opts: ServerWriteOptions }, hooks: ServerHooks = {}): McpServer {
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
  const server = new McpServer({ name: 'lore', version: '0.4.0' })
  const text = (value: unknown) => ({
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  })
  const writes = new Set(MCP_TOOLS.filter((t) => t.writes).map((t) => t.name))
  // registerTool with the write hook applied: the name decides, so the table
  // above stays the one place that says which tools write.
  const tool: McpServer['registerTool'] = (name, def, handler) => {
    const wrapped = writes.has(name) && hooks.serialize ? ((...args: Parameters<typeof handler>) => hooks.serialize!(async () => (handler as (...a: unknown[]) => Promise<unknown>)(...args))) : handler
    return server.registerTool(name, def, wrapped as typeof handler)
  }

  tool(
    'lore_grep',
    {
      description: `${label}Search ${ctx.config.project}'s project memory (synced Slack, email, meetings, attached documents, decisions, pinned facts). Pattern is a regex; falls back to literal. Returns file:line matches — read surrounding context with lore_read.`,
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

  tool(
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

  tool(
    'lore_status',
    {
      description:
        label +
        `The status of ${ctx.config.project}, ready to relay: a short summary written after the last fold, anything the tracker recorded since, and the live outstanding list (open tickets by status, requests not yet ticketed, roadmap not done), with source freshness. Call this FIRST for "what's outstanding", "where are we", "status update", "what's left" — and reply with it as returned (trim or filter only if asked, e.g. "just the blocked ones"); do not also call lore_recall to rebuild it. Use lore_recall or lore_grep only for detail the page doesn't carry.`,
      inputSchema: {},
    },
    async () => {
      freshen()
      return text(statusView(ctx.root, ctx.config))
    },
  )

  tool(
    'lore_recall',
    {
      description:
        label +
        'Pinned facts, every derived artifact (requests, decisions, roadmap, contradictions), the lore work tracker (work["lore/<PREFIX>"] — the tracker of record for delivery state, each item with who last moved it and why; drift: true where lore and Jira/GitHub disagree), external tracker snapshots (work["github/…"], work["jira/…"] — what the tracker itself says; open items in full, closed/merged as counts, full table via lore_read of the given file), recent weekly reports, and statements of work (sow: human-weeks sold and effective date — authoritative for what was committed; weeks allocated against them are not tracked yet, and calendar time is never a proxy), with source-freshness timestamps — "what do we know" without a search term. Pins win over derived data on conflict; work tables win over derived for delivery state. Filter with category: a pin category or one of requests|decisions|roadmap|contradictions|work|reports|sow. The lore tracker lists its project labels (themes like "onboarding", "stripe integration") with open/closed counts; pass label to get just that theme\'s tickets, open and closed.',
      inputSchema: {
        category: z.string().optional(),
        label: z.string().optional().describe('only work items carrying this label (case-insensitive); implies category "work"'),
      },
    },
    async ({ category, label }) => {
      freshen()
      return text(recallData(ctx.root, ctx.config, category ?? (label ? 'work' : undefined), { label }))
    },
  )

  tool(
    'lore_sync_now',
    {
      description:
        'Refresh project memory. Not the first step: answer from lore_recall (which reports lastSync/lastExtract; the host syncs and folds every 15 min) and state the freshness — use this only when the user asks for fresh data, when lastSync is older than ~20 minutes, or when the question is about the last few minutes. Pulls the latest synced data; with trigger=true also asks the lore host to sync right now (Slack, GitHub, Granola, Notion, Jira, Gmail) and waits for it — about a minute. Raw streams (lore_grep/lore_read) are then current; derived artifacts (lore_recall: requests/decisions/roadmap) only update with fold=true (about a minute more), so pass fold=true when the refreshed answer must come from recall, and leave it off when you will read the raw streams yourself. If a host run is already in flight it waits for that one instead of starting another (host: "waited"). Rate-limited to once per 5 minutes unless force. Never run `lore sync` yourself: agents cannot sync, only the host can. Returns before/after freshness plus host/outcome; a failed host run is reported in outcome, not thrown.',
      inputSchema: {
        trigger: z.boolean().optional().default(true).describe('ask the host to sync now (default true); false = just pull what the host already has'),
        fold: z.boolean().optional().default(false).describe('also run the LLM fold so recall (requests/decisions/roadmap) is current, not just the raw streams (default false; costs a fold, ~1–2 min)'),
        force: z.boolean().optional().default(false).describe('re-run even if the host synced (or, with fold, folded) within the last 5 minutes'),
      },
    },
    async ({ trigger, force, fold }) => {
      lastPull = Date.now()
      const r = refresh(rememberOpts.cwd, { ...rememberOpts.opts, trigger, force, fold })
      return text(r)
    },
  )

  tool(
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

  tool(
    'lore_sow_add',
    {
      description: archived
        ? 'Unavailable: this client is archived and its memory is read-only.'
        : 'Attach a statement of work to project memory: the document — a docs.google.com link (url; lore exports it as markdown via the Workspace service account, reading as the client owner) or its text (text) — plus the commitment: human-weeks sold, period start/end, optional signed date, source link, and named scope items. Use ONLY on explicit user instruction, with the numbers the user or the document states — never estimate them. Lines carrying currency amounts are stripped unless keep_commercials. Re-adding the same name updates it (e.g. status: exhausted | superseded | closed).',
      inputSchema: {
        name: z.string().describe('e.g. "Jointly SOW 4"'),
        text: z.string().optional().describe('the SOW document as markdown/plain text (or give url)'),
        url: z.string().optional().describe('docs.google.com link to the SOW (or give text)'),
        weeks: z.number().positive().describe('human-weeks sold'),
        start: z.string().describe('effective date, YYYY-MM-DD'),
        end: z.string().optional().describe('period end, YYYY-MM-DD — only when the SOW states one'),
        signed: z.string().optional().describe('date signed, YYYY-MM-DD'),
        source: z.string().optional().describe('where the document lives (Google Doc URL)'),
        scope: z.array(z.string()).optional().describe('named deliverables, when the SOW lists any'),
        status: z.enum(['active', 'exhausted', 'superseded', 'closed']).optional(),
        keep_commercials: z.boolean().optional(),
      },
    },
    async ({ name, text: body, url, weeks, start, end, signed, source, scope, status, keep_commercials }) => {
      const s = await sowAdd(
        rememberOpts.cwd,
        { name, text: body, file: url, weeks, start, end, signed, source, scope, status, keepCommercials: keep_commercials },
        { ...rememberOpts.opts, via: 'mcp' },
      )
      return text(s)
    },
  )

  tool(
    'lore_doc_add',
    {
      description: archived
        ? 'Unavailable: this client is archived and its memory is read-only.'
        : 'Add a document to project memory as raw material — a spec, brief, deck, handoff package, anything a client sends that is not a statement of work. Give a Google Docs/Drive link (url; lore reads it via the Workspace service account as the client owner — Docs, Slides, Sheets, PDFs, text) or the text itself (text, with a title). It lands in the docs stream like a Slack message or an email: grep-able at once, folded by the next extract into requests/decisions/roadmap citing the link. Nothing in it becomes authoritative; for commitments use lore_sow_add. Use on explicit user instruction. Re-adding identical content is a no-op; changed content adds a new version.',
      inputSchema: {
        url: z.string().optional().describe('docs.google.com or drive.google.com link (or give text)'),
        text: z.string().optional().describe('the document as markdown/plain text (or give url)'),
        title: z.string().optional().describe('title — required with text; defaults to the Google Doc name'),
        from: z.string().optional().describe('who sent or authored it (default: the Drive owner)'),
        date: z.string().optional().describe('YYYY-MM-DD the document belongs to (default today)'),
        source: z.string().optional().describe('where it lives, when not the Google link'),
      },
    },
    async ({ url, text: body, title, from, date, source }) => {
      const d = await docAdd(rememberOpts.cwd, { file: url, text: body, title, from, date, source }, { ...rememberOpts.opts, via: 'mcp' })
      return text(d)
    },
  )

  tool(
    'lore_source_list',
    {
      description:
        label +
        `What ${ctx.config.project}'s memory is synced from: each configured source (slack, github, granola, notion, figma, jira, gmail) with its scope in its own terms (channels, repos, folders, roots, files, projects/boards, mailboxes), whether it is disabled, how the host authenticates, and its last successful sync / last error. Use it to answer "which repos/channels are synced", to check a scope before adding to it, and to explain a source that is failing.`,
      inputSchema: {},
    },
    async () => {
      freshen()
      return text(sourceList(rememberOpts.cwd, { ...rememberOpts.opts, pull: false }))
    },
  )

  tool(
    'lore_source_add',
    {
      description: archived
        ? 'Unavailable: this client is archived and its memory is read-only.'
        : 'Add a source to project memory, or widen one: a GitHub repo, a Slack channel, a Granola folder, a Notion page, a Figma design file, a Jira project/board, or Gmail mailboxes. Use ONLY on explicit instruction from a teammate ("add the mobile repo to lore", "sync #acme-dev too"), with the identifiers exactly as given — never guess a repo name, channel, or folder, and never add a scope you merely saw mentioned. Credentials are never part of this: the config records identifiers only, and the host authenticates through its proxies. The result lists what was added, what was already there, and `next`: the steps only a person can do (invite the bot to the channel, attach the GitHub integration, share the Notion page) — relay those verbatim, because the host cannot read the new scope until they are done. The new scope backfills automatically on the host\'s next sync (or lore_sync_now). Scope is never removed here; that is a human edit.',
      inputSchema: {
        kind: z.enum(KNOWN_SOURCES as [string, ...string[]]).describe('slack | github | granola | notion | figma | jira | gmail'),
        scope: z
          .array(z.string().min(1))
          .describe('in the source\'s own terms: "#channel"; "owner/repo"; a Granola folder title; a Notion page/database URL or id; a Figma file URL or key (not a Slides deck); a Jira project key (ACM) or "board:293"; mailboxes as emails, or "all" for every Workspace mailbox (gmail: an empty list means the team-side contacts\' inboxes)'),
        site: z.string().optional().describe('jira only: https://<site>.atlassian.net, for permalinks'),
      },
    },
    async ({ kind, scope, site }) => {
      const r = await sourceAdd(rememberOpts.cwd, { kind, scope, site }, { ...rememberOpts.opts, via: 'mcp' })
      return text(r)
    },
  )

  const unavailable = 'Unavailable: this client is archived and its memory is read-only.'
  const workVia = { ...rememberOpts.opts, via: 'mcp' as const }
  const reasonField = z.string().min(1).describe('why — recorded in the item\'s history with you as the actor; cite what the person said or the evidence')
  const sourcesField = z.array(z.string()).optional().describe('permalinks to the evidence (Slack message, email, PR)')

  tool(
    'lore_work_add',
    {
      description: archived
        ? unavailable
        : 'Create a work item in the lore tracker (the tracker of record). Use when a person asks to track/ticket something new; to track an existing derived request use lore_work_promote instead. Give a title and a reason; link a Jira/GitHub issue with external ("jira:INPT-9" / "github:owner/repo#42") if one exists.',
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional().describe('markdown body: what the ticket is, for people reading it'),
        status: z.enum(WORK_STATUSES as [string, ...string[]]).optional().describe('default todo'),
        priority: z.enum(WORK_PRIORITIES as [string, ...string[]]).optional(),
        assignee: z.string().optional(),
        labels: z.array(z.string()).optional(),
        sources: sourcesField,
        external: z.string().optional().describe('"jira:<KEY>" or "github:<owner>/<repo>#<n>"'),
        reason: reasonField,
      },
    },
    async ({ title, description, status, priority, assignee, labels, sources, external, reason }) => {
      const item = workAdd(rememberOpts.cwd, { title, description, status: status as never, priority: priority as never, assignee, labels, sources, external, reason }, workVia)
      return text(`added ${item.key}: ${item.title} [${item.status}]`)
    },
  )

  tool(
    'lore_work_promote',
    {
      description: archived
        ? unavailable
        : 'Promote a derived request (req-0007, from lore_recall category "requests") into a tracked work item, keeping its evidence. Use when a person says to track, ticket, or schedule a request.',
      inputSchema: {
        request_id: z.string().min(1),
        title: z.string().optional().describe('ticket title (default: the request text)'),
        priority: z.enum(WORK_PRIORITIES as [string, ...string[]]).optional(),
        reason: z.string().optional().describe('why now'),
      },
    },
    async ({ request_id, title, priority, reason }) => {
      const item = workPromote(rememberOpts.cwd, request_id, { title, priority: priority as never, reason }, workVia)
      return text(`promoted ${request_id} → ${item.key}: ${item.title}`)
    },
  )

  tool(
    'lore_work_move',
    {
      description: archived
        ? unavailable
        : 'Change a work item\'s status (todo | in_progress | blocked | done | archived). Move it when a person asks, or when the evidence in front of you is unambiguous (a merged PR, "shipped", "this is blocked on X") — always with the reason and sources. Never archive on your own initiative.',
      inputSchema: {
        key: z.string().min(1).describe('e.g. CAR-3'),
        status: z.enum(WORK_STATUSES as [string, ...string[]]),
        reason: reasonField,
        sources: sourcesField,
      },
    },
    async ({ key, status, reason, sources }) => {
      const item = workMove(rememberOpts.cwd, key, status, { reason, sources }, workVia)
      return text(`moved ${item.key} → ${item.status}: ${item.title}`)
    },
  )

  tool(
    'lore_work_set',
    {
      description: archived
        ? unavailable
        : 'Change a work item\'s title, description, priority, assignee, labels, evidence links, linked tracker issue, or rank (rank_above = the key it should sit directly above; "top" / "bottom" also accepted). Always with a reason.',
      inputSchema: {
        key: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional().describe('markdown body; "" clears it'),
        priority: z.enum(WORK_PRIORITIES as [string, ...string[]]).optional(),
        assignee: z.string().optional().describe('"" clears it'),
        labels: z.array(z.string()).optional().describe('replaces the list'),
        sources: sourcesField,
        external: z.string().optional().describe('"jira:<KEY>" or "github:<owner>/<repo>#<n>"'),
        rank_above: z.string().optional().describe('a key, or "top" / "bottom"'),
        reason: reasonField,
      },
    },
    async ({ key, title, description, priority, assignee, labels, sources, external, rank_above, reason }) => {
      const notes: string[] = []
      if (title !== undefined || description !== undefined || priority !== undefined || assignee !== undefined || labels !== undefined || sources !== undefined || external !== undefined) {
        const item = workSet(rememberOpts.cwd, key, { title, description, priority: priority as never, assignee, labels, sources, external }, { reason }, workVia)
        notes.push(`updated ${item.key}`)
      }
      if (rank_above !== undefined) {
        const target = rank_above === 'top' ? { top: true } : rank_above === 'bottom' ? { bottom: true } : { above: rank_above }
        const item = workRank(rememberOpts.cwd, key, target, { reason }, workVia)
        notes.push(`ranked ${item.key} ${rank_above === 'top' || rank_above === 'bottom' ? rank_above : `above ${rank_above}`}`)
      }
      if (notes.length === 0) throw new Error('lore_work_set: give at least one field to change')
      return text(notes.join('; '))
    },
  )

  tool(
    'lore_work_label',
    {
      description: archived
        ? unavailable
        : 'Add (or remove) a project-specific label — a theme, epic or workstream such as "onboarding" or "stripe integration" — on several work items in one change. Use when a person asks to label, tag, or group tickets. When they say "these", resolve the keys from the conversation or lore_recall first and name every labeled ticket in your reply; if it is unclear which tickets they mean, ask before labeling. A label the project already uses keeps its spelling. Find a label\'s tickets later with lore_recall { label }.',
      inputSchema: {
        keys: z.array(z.string().min(1)).min(1).describe('ticket keys, e.g. ["CAR-3", "CAR-7"]'),
        add: z.array(z.string().min(1)).optional().describe('labels to add, e.g. ["stripe integration"]'),
        remove: z.array(z.string().min(1)).optional().describe('labels to remove'),
        reason: reasonField,
      },
    },
    async ({ keys, add, remove, reason }) => {
      const r = await workLabel(rememberOpts.cwd, keys, { add, remove }, { reason }, workVia)
      const lines = r.labeled.map((l) => `${l.key}: ${l.title} — labels: ${l.labels.join(', ') || '(none)'}`)
      if (r.unchanged.length) lines.push(`unchanged (already so): ${r.unchanged.join(', ')}`)
      return text(lines.join('\n') || 'nothing changed')
    },
  )

  tool(
    'lore_work_push',
    {
      description: archived
        ? unavailable
        : 'Write lore\'s tracker state to Jira for the given tickets: a ticket linked to a Jira issue whose status disagrees with lore\'s gets the matching workflow transition; an open ticket with no Jira issue gets one created on the client\'s board and linked back. Tickets in progress or blocked in lore that sit in no Jira sprint go into the board\'s active sprint; with sprint, the given tickets go into that sprint. Lore stores no sprints — Jira owns sprint planning. Only when a person asks ("push this to Jira", "create the Jira ticket for JNT-3", "sync Jira"); never on your own initiative. Use dry_run first when the person is unsure what will change. Runs on the lore host; takes a few seconds per ticket.',
      inputSchema: {
        keys: z.array(z.string().min(1)).optional().describe('ticket keys, e.g. ["JNT-3"] — or all: true'),
        all: z.boolean().optional().describe('every ticket that differs from Jira'),
        dry_run: z.boolean().optional().describe('report what would change without changing Jira'),
        sprint: z
          .string()
          .optional()
          .describe('put the given tickets in a Jira sprint: "active" for the current one, or a sprint name — only when a person asks for tickets to go into a sprint. Without it, in-flight tickets that are in no sprint go into the active one.'),
      },
    },
    async ({ keys, all, dry_run, sprint }) => {
      const r = await workPush(rememberOpts.cwd, { keys, all, dryRun: dry_run, sprint }, workVia)
      return text(r)
    },
  )

  return server
}
