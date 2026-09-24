import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const backfillSchema = z
  .object({ months: z.number().int().min(0).default(0) })
  .catchall(z.number().int().min(0))

/**
 * Every source shares one control field; the rest is connector-owned.
 * `disabled: true` is the only way a configured source may be skipped by
 * `sync` without failing the run — a source that is merely unavailable
 * (no connector, missing env) is an error, never a silent skip.
 */
const baseSource = z.object({ disabled: z.boolean().optional() })

/** "env:VAR" — lore.json carries references, never the secret itself. */
const envRef = z.string().regex(/^env:[A-Z_][A-Z0-9_]*$/, 'must be an "env:VAR_NAME" reference')

const REPO_RE = /^[\w.-]+\/[\w.-]+$/

/**
 * Typed per-source schemas (backlog §8). Invalid scope config is rejected
 * before a sync starts. Sources not listed here are accepted structurally
 * (so a config can be written ahead of its connector) but `check`/`sync`
 * fail on them until a connector exists or they are disabled.
 */
export const sourceSchemas = {
  slack: baseSource
    .extend({
      channels: z.array(z.string().min(1)).min(1),
      /** Required unless `api_base` points at a proxy that injects the token. */
      token: envRef.optional(),
      /** Slack Web API base (default https://slack.com/api); a proxy URL when tokens live off-host. */
      api_base: z.string().url().optional(),
    /** Days of history re-read on every sync (default 7). */
    overlap_days: z.number().min(0).optional(),
      /** Days a thread stays tracked for late replies (default 30). */
      thread_window_days: z.number().min(0).optional(),
    })
    .refine((s) => s.token || s.api_base, { message: 'slack needs a token (env:…) or an api_base proxy that injects one', path: ['token'] }),
  github: baseSource
    .extend({
      /** "owner/repo" — each syncs issues, PRs, comments, reviews, commits, releases. */
      repos: z.array(z.string().regex(REPO_RE, 'must be "owner/repo"')).min(1),
      /** Fine-grained PAT or GitHub App installation token; never a personal classic token.
       *  Optional when `api_base` is a proxy that injects it (or for public repos). */
      token: envRef.optional(),
      /** REST API base (default https://api.github.com); a proxy URL when tokens live off-host. */
      api_base: z.string().url().optional(),
    /** Days re-read on every sync (default 1). */
    overlap_days: z.number().min(0).optional(),
      /** Default: all. */
      include: z.array(z.enum(['issues', 'comments', 'reviews', 'commits', 'releases'])).optional(),
    })
    .refine((g) => g.token || g.api_base, { message: 'github needs a token (env:…) or an api_base proxy that injects one', path: ['token'] }),
  granola: baseSource
    .extend({
      /** Bearer token for Granola's MCP endpoint. Usually omitted: `lore auth granola`
       *  stores an OAuth grant in a token file and the connector refreshes it. */
      token: envRef.optional(),
      /** Path of the OAuth token file written by `lore auth granola` (default ~/.lore/granola-auth.json). */
      auth_file: z.string().optional(),
      /** MCP endpoint (default https://mcp.granola.ai/mcp); a proxy URL when the token lives off-host. */
      endpoint: z.string().url().optional(),
      /** Folder titles or ids whose meetings belong to this client. */
      folders: z.array(z.string().min(1)).optional(),
      /** Email domains: a meeting with any attendee at one of these belongs to this client. */
      attendee_domains: z.array(z.string().min(1)).optional(),
      /** Store the verbatim transcript alongside notes + summary (default true). */
      transcripts: z.boolean().optional(),
      /** Days re-read on every sync (default 2). */
      overlap_days: z.number().min(0).optional(),
      /** Hours a meeting must be over before it is synced, so Granola has finished the summary (default 1). */
      settle_hours: z.number().min(0).optional(),
      /** New meetings whose notes are synced per run, oldest first (default 50). */
      meetings_per_run: z.number().int().positive().optional(),
      /** Seconds per run spent fetching owed transcripts (default 300) — Granola allows roughly one every two minutes, so a backfill's transcripts trickle in over later runs. */
      transcript_seconds: z.number().min(0).optional(),
    })
    // Scope (folders / attendee_domains / the repo's `client` block) and auth
    // (token, proxy endpoint, or a device-flow token file) are checked at
    // sync time by the connector: both can come from outside this block.
    ,
  notion: baseSource
    .extend({
      /** Internal-integration token (`ntn_…`); optional when `api_base` is a proxy that injects it. */
      token: envRef.optional(),
      /** REST base (default https://api.notion.com/v1); a proxy URL when the token lives off-host. */
      api_base: z.string().url().optional(),
      /** Page/database ids or URLs; anything under one of them is in scope. Empty = everything shared with the integration. */
      roots: z.array(z.string().min(1)).optional(),
      /** Days re-read on every sync (default 1). */
      overlap_days: z.number().min(0).optional(),
      /** Skip pages edited within the last N minutes (default 30) — let edits settle. */
      settle_minutes: z.number().min(0).optional(),
    })
    .refine((n) => n.token || n.api_base, { message: 'notion needs a token (env:…) or an api_base proxy that injects one', path: ['token'] }),
  figma: baseSource
    .extend({
      /** File URLs or keys — design files, FigJam boards, Slides decks. */
      files: z.array(z.string().min(1)).optional(),
      /** Figma project ids; every file in them is in scope. */
      projects: z.array(z.union([z.string().min(1), z.number().int().positive()])).optional(),
      /** Personal access token (env:FIGMA_TOKEN), sent as X-Figma-Token; optional when api_base is a proxy that injects it. */
      token: envRef.optional(),
      /** REST base (default https://api.figma.com/v1); a proxy URL when the token lives off-host. */
      api_base: z.string().url().optional(),
      /** Default: frames + comments. */
      include: z.array(z.enum(['frames', 'comments'])).optional(),
      overlap_days: z.number().min(0).optional(),
    })
    .refine((f) => (f.files?.length ?? 0) > 0 || (f.projects?.length ?? 0) > 0, { message: 'figma needs files and/or projects', path: ['files'] })
    .refine((f) => f.token || f.api_base, { message: 'figma needs token (env:FIGMA_TOKEN) or an api_base proxy that injects it', path: ['token'] }),
  jira: baseSource
    .extend({
      /** Project keys, e.g. ["JNT"]. */
      projects: z.array(z.string().regex(/^[A-Z][A-Z0-9_]+$/, 'Jira project keys are uppercase, e.g. JNT')).optional(),
      /** Agile board ids — for workspaces that run clients as boards inside one project; scope = the board's saved filter. */
      boards: z.array(z.number().int().positive()).optional(),
      /** https://<site>.atlassian.net — for the API (unless api_base) and for permalinks. */
      site: z.string().url().optional(),
      /** Atlassian account email + API token (HTTP Basic); optional when api_base is a proxy that injects the header. */
      email: envRef.optional(),
      token: envRef.optional(),
      /** REST v3 base; a proxy URL when credentials live off-host, e.g. https://jira.int.exe.xyz/rest/api/3. */
      api_base: z.string().url().optional(),
      /** Default: issues + comments. */
      include: z.array(z.enum(['issues', 'comments'])).optional(),
      /**
       * Where `lore work push` creates issues for lore tickets that have none.
       * Defaults: `project` = the project the mirrored issues live in,
       * `issuetype` = "Task", `fields` = the board filter's equality clauses
       * (e.g. "Client Project" = Jointly) resolved against the create screen.
       * Set `fields` explicitly (raw Jira field payloads, e.g.
       * {"customfield_10034": {"id": "10434"}}) when inference can't.
       *
       * Sprints: a pushed ticket that is in flight in lore (in_progress or
       * blocked) and in no open sprint goes into the board's active sprint;
       * `lore work push --sprint` puts named tickets in one on request. The
       * board is `board`, else the first of `boards`, else the project's
       * only scrum board. `sprints: false` turns this off for a client.
       * Lore's tickets never store a sprint — Jira owns sprint planning.
       */
      push: z
        .object({
          project: z.string().regex(/^[A-Z][A-Z0-9_]+$/).optional(),
          issuetype: z.string().optional(),
          fields: z.record(z.string(), z.unknown()).optional(),
          board: z.number().int().positive().optional(),
          sprints: z.boolean().optional(),
        })
        .optional(),
      /** Days re-read on every sync (default 1). */
      overlap_days: z.number().min(0).optional(),
    })
    .refine((j) => (j.projects?.length ?? 0) > 0 || (j.boards?.length ?? 0) > 0, { message: 'jira needs projects and/or boards', path: ['projects'] })
    .refine((j) => j.site || j.api_base, { message: 'jira needs site (https://x.atlassian.net) or api_base', path: ['site'] })
    .refine((j) => (j.email && j.token) || j.api_base, { message: 'jira needs email + token (env:…) or an api_base proxy that injects them', path: ['token'] }),
  linear: baseSource
    .extend({
      /** Team keys, e.g. ["PRP"]. */
      teams: z.array(z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/, 'Linear team keys are uppercase, e.g. PRP')).min(1),
      /** Personal API key (env:LINEAR_API_KEY), sent as Authorization; optional when api_base is a proxy that injects it. */
      token: envRef.optional(),
      /** GraphQL endpoint (default https://api.linear.app/graphql); a proxy URL when the key lives off-host. */
      api_base: z.string().url().optional(),
      /** Proxy for https://uploads.linear.app (files pasted into issues), when the key lives off-host. */
      uploads_base: z.string().url().optional(),
      /** Default: issues + comments. */
      include: z.array(z.enum(['issues', 'comments'])).optional(),
      overlap_days: z.number().min(0).optional(),
    })
    .refine((l) => l.token || l.api_base, { message: 'linear needs token (env:LINEAR_API_KEY) or an api_base proxy that injects it', path: ['token'] }),
  gmail: baseSource.extend({
    /** Service account key JSON as an env ref (env:GMAIL_SA_KEY); or leave both unset for `key_file`. */
    key: envRef.optional(),
    /** Path of the service account key JSON on the syncing host (default ~/.lore/gmail-sa.json). */
    key_file: z.string().optional(),
    /** Mailboxes to read: a list of Workspace users, or "all" for every active user in the Workspace
     *  (listed via the Directory API — delegate admin.directory.user.readonly too). Default: the team-side contacts in `client.contacts`. */
    users: z.union([z.literal('all'), z.array(z.string().email())]).optional(),
    /** With users "all": the Workspace admin to list users as (default `client.owner`). */
    admin: z.string().email().optional(),
    /** Mailboxes never read, whoever is in `users`/contacts — a teammate's opt-out. */
    exclude: z.array(z.string().email()).optional(),
    /** File documents the client links (Google Docs/Sheets/Slides/Drive files) or attaches (PDF, Word, PowerPoint, Excel, text) into the `docs` stream (default true). */
    documents: z.boolean().optional(),
    /** Extra client domains to match, on top of `client.domains`. */
    domains: z.array(z.string().min(1)).optional(),
    /** Extra Gmail search terms appended to the scope query, e.g. "-label:newsletters". */
    query: z.string().optional(),
    /** Days re-read on every sync (default 2). */
    overlap_days: z.number().min(0).optional(),
    /** Gmail REST base (default https://gmail.googleapis.com), Directory base (https://admin.googleapis.com) and OAuth token endpoint — for tests and proxies. */
    api_base: z.string().url().optional(),
    directory_base: z.string().url().optional(),
    token_url: z.string().url().optional(),
  }),
} as const

export type SourceName = keyof typeof sourceSchemas
export const KNOWN_SOURCES = Object.keys(sourceSchemas) as SourceName[]

/** Any source: typed when known, structurally checked otherwise. */
export const sourceSchema = baseSource.catchall(z.unknown())
export type SourceConfig = z.infer<typeof sourceSchema>

const sourcesSchema = z.record(z.string(), sourceSchema).superRefine((sources, ctx) => {
  for (const [name, cfg] of Object.entries(sources)) {
    const schema = (sourceSchemas as Record<string, z.ZodTypeAny>)[name]
    if (!schema) continue
    const r = schema.safeParse(cfg)
    if (!r.success) {
      for (const issue of r.error.issues) {
        ctx.addIssue({ ...issue, path: [name, ...issue.path] })
      }
    }
  }
})

export const LIFECYCLES = ['active', 'archived'] as const
export type Lifecycle = (typeof LIFECYCLES)[number]

/** Who the client is (backlog §6/§7, first slice). Email is the identity key
 *  that connectors can match on; names are display fields. */
export const contactSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  /** Other addresses the same person writes from (a personal gmail, an old domain) — matched like `email` by every connector. */
  aliases: z.array(z.string().email().transform((e) => e.toLowerCase())).optional(),
  role: z.string().optional(),
  /** "client" (default) — the customer side; "team" — your own people; "vendor". */
  side: z.enum(['client', 'team', 'vendor']).default('client'),
})
export type Contact = z.infer<typeof contactSchema>

export const clientSchema = z.object({
  /** Display name, e.g. "Jointly". */
  name: z.string().min(1),
  /** Email domains that identify the client's people: a meeting with any attendee at one belongs to this client. */
  domains: z.array(z.string().min(1).transform((d) => d.toLowerCase().replace(/^@/, ''))).default([]),
  contacts: z.array(contactSchema).default([]),
  /** Who owns the relationship on your side. */
  owner: z.string().optional(),
})
export type Client = z.infer<typeof clientSchema>

/** A board member/viewer: "jane@client.com" or "@client.com" (the whole domain). Lower-cased. */
export const boardPrincipal = z
  .string()
  .transform((e) => e.trim().toLowerCase())
  .refine((e) => /^@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) || z.string().email().safeParse(e).success, 'board entries are emails or "@domain"')

export const configSchema = z.object({
  project: z.string().min(1),
  client: clientSchema.optional(),
  /**
   * Client lifecycle. `archived` = the engagement ended: sync and extract
   * become no-ops, writes are refused, reads still work but are labelled.
   * Set by `lore archive`, never by hand.
   */
  lifecycle: z.enum(LIFECYCLES).default('active'),
  /** ISO 8601, set when lifecycle became archived. */
  archived_at: z.string().optional(),
  sources: sourcesSchema.default({}),
  backfill: backfillSchema.default({ months: 0 }),
  extract: z.array(z.string()).default([]),
  report: z
    .object({ post_to: z.string(), day: z.string().default('friday') })
    .optional(),
  /** Who may `remember`. Absent = anyone with push access (the default). */
  write: z.object({ allow: z.array(z.string().min(1)).min(1) }).optional(),
  /**
   * The lore work tracker (context/work/lore/<PREFIX>.yaml). `prefix` is
   * the ticket key prefix (CAR-1, JOI-14); derived from the client name
   * when absent. Written by `lore setup` for new clients.
   */
  work: z.object({ prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,5}$/, 'work.prefix must be 2–6 uppercase letters/digits starting with a letter, e.g. "CAR"') }).optional(),
  /**
   * The web board (`lore www` with LORE_BOARD=1): list + kanban over the work
   * tracker. Off unless `enabled`. `members` may create, edit and move
   * tickets; `viewers` may only look. Entries are emails, or "@domain" for
   * everyone at a domain. Managed by `lore board`, never by hand.
   */
  board: z
    .object({
      enabled: z.boolean().default(false),
      members: z.array(boardPrincipal).default([]),
      viewers: z.array(boardPrincipal).default([]),
    })
    .optional(),
})

export type LoreConfig = z.infer<typeof configSchema>

export const CONFIG_FILE = 'lore.json'

export function loadConfig(root: string): LoreConfig {
  const raw = readFileSync(join(root, CONFIG_FILE), 'utf8')
  return configSchema.parse(JSON.parse(raw))
}

/**
 * Resolve "env:VAR_NAME" string values against process.env.
 * Keys never live in lore.json — only references.
 */
export function resolveEnvRefs(
  obj: Record<string, unknown>,
): { resolved: Record<string, unknown>; missing: string[] } {
  const resolved: Record<string, unknown> = {}
  const missing: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.startsWith('env:')) {
      const name = value.slice(4)
      const env = process.env[name]
      if (env === undefined) missing.push(name)
      resolved[key] = env
    } else {
      resolved[key] = value
    }
  }
  return { resolved, missing }
}

/** Months of backfill for a source: per-source override, else global default. */
export function backfillMonths(config: LoreConfig, source: string): number {
  const override = config.backfill[source]
  return typeof override === 'number' ? override : config.backfill.months
}

export function backfillSince(config: LoreConfig, source: string, now = Date.now()): number {
  const months = backfillMonths(config, source)
  if (months === 0) return now
  const d = new Date(now)
  d.setMonth(d.getMonth() - months)
  return d.getTime()
}
