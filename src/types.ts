/** A normalized document emitted by any connector. One unit of source material. */
export interface Doc {
  /** Stable, source-derived id, e.g. "slack-C0123-1720624400.123" */
  id: string
  source: string
  /** Human-readable container: "#acme", "inbox", "linear/acme" */
  channel: string
  /** Display name — for reading. Machine identity goes in `meta`. */
  author: string
  /** ISO 8601 */
  timestamp: string
  permalink?: string
  /** Parent thread id, if this doc is a reply */
  thread?: string
  /**
   * Stable machine identifiers the source owns (Slack user id, workspace id,
   * GitHub node id…). Persisted verbatim in the stream so later layers can
   * resolve identities without re-querying the source. Values must be
   * single tokens (no whitespace).
   */
  meta?: Record<string, string>
  text: string
}

/** Opaque per-source sync position. Shape is owned by the connector. */
export type Cursor = Record<string, unknown>

export interface ConnectorContext {
  /** Resolved secrets/config for this source (env: refs already resolved). */
  config: Record<string, unknown>
  cursor: Cursor
  /** Earliest timestamp to fetch, ms epoch. Set from backfill on first sync. */
  since: number
  /**
   * Who the client is (lore.json `client`), when configured. Connectors use
   * it to scope material to this client — Granola matches meetings on the
   * domains and contact emails — without repeating the list per source.
   */
  client?: { name: string; domains: string[]; contacts: { name: string; email: string; role?: string; side: string }[]; owner?: string }
  log: (msg: string) => void
  /**
   * Read a file this connector previously emitted via `FetchResult.files`
   * (path relative to the context root), or undefined if absent. Lets a
   * connector maintain a source-owned state table without bloating the cursor.
   */
  readFile: (relPath: string) => string | undefined
}

export interface FetchResult {
  docs: Doc[]
  nextCursor: Cursor
  /**
   * Problems that did not stop the fetch but mean the source is not fully
   * synced (a configured channel the bot can't see, a repo that 404s).
   * `sync` records them as source health and fails the run.
   */
  errors?: string[]
  /**
   * Source-owned files to write verbatim under the context root (e.g.
   * "context/work/github/acme__web.yaml" — the current issue table). Unlike
   * streams these are overwritten, not appended: the source is authoritative
   * for their content and the LLM never edits them.
   */
  files?: Record<string, string>
}

export interface Connector {
  name: string
  fetch(ctx: ConnectorContext): Promise<FetchResult>
}

export interface Pin {
  id: string
  fact: string
  category: string
  authorized_by: string
  date: string
  source?: string
}
