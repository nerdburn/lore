import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const AUDIT_FILE = 'context/audit.jsonl'

/**
 * One line per approved write. Git history already records *that* a pin
 * changed; this records who asked, through which surface, and why — the
 * fields git can't know. Append-only JSONL so a merge never rewrites history.
 */
export interface AuditEntry {
  /** ISO 8601 */
  at: string
  action: 'remember' | 'sow'
  /** OS user (or --by on the CLI) — never a value supplied over MCP. */
  actor: string
  via: 'cli' | 'mcp'
  /** The id of the record written (pin id, or SOW slug). */
  id: string
  /** Supporting rationale or source link, when given. */
  source?: string
}

export function appendAudit(root: string, entry: AuditEntry): void {
  const path = join(root, AUDIT_FILE)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(entry) + '\n')
}

export function readAudit(root: string): AuditEntry[] {
  const path = join(root, AUDIT_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry)
}
