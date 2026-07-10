/** A normalized document emitted by any connector. One unit of source material. */
export interface Doc {
  /** Stable, source-derived id, e.g. "slack-C0123-1720624400.123" */
  id: string
  source: string
  /** Human-readable container: "#acme", "inbox", "linear/acme" */
  channel: string
  author: string
  /** ISO 8601 */
  timestamp: string
  permalink?: string
  /** Parent thread id, if this doc is a reply */
  thread?: string
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
  log: (msg: string) => void
}

export interface Connector {
  name: string
  fetch(ctx: ConnectorContext): Promise<{ docs: Doc[]; nextCursor: Cursor }>
}

export interface Pin {
  id: string
  fact: string
  category: string
  authorized_by: string
  date: string
  source?: string
}
