/**
 * Secrets scrubber (SPEC §10). Runs on every doc before it is written to a
 * stream file — git history is forever, so this is the one place a pasted
 * token can be stopped. Patterns favour recall over precision: redacting a
 * harmless "1Password" after "password:" costs a word; missing a real key
 * costs a rotation. Each hit becomes "[redacted:<kind>]".
 */

interface Rule {
  kind: string
  re: RegExp
  /** When set, only this capture group is replaced (keeps the key name). */
  group?: number
}

const RULES: Rule[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'slack-token', re: /\bxox[abposer]-[A-Za-z0-9-]{10,}/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: 'aws-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer', re: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/g, group: 2 },
  {
    kind: 'secret',
    // key: value / key=value where the key names a credential (DB_PASSWORD,
    // api_key, client-secret…) and the value looks like one: token charset,
    // 8+ chars, and either letters+digits mixed or 20+ chars. "env:" refs
    // are pointers, not secrets, and pass through.
    re: /\b([A-Za-z0-9_-]*?(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|token)\b\s*[:=]\s*["']?)((?!env:)(?:(?=[A-Za-z0-9_\-./+=]*\d)(?=[A-Za-z0-9_\-./+=]*[A-Za-z])[A-Za-z0-9_\-./+=]{8,}|[A-Za-z0-9_\-./+=]{20,}))/gi,
    group: 2,
  },
]

export interface ScrubResult {
  text: string
  /** Redactions made, by kind. Empty when the text was clean. */
  redacted: Record<string, number>
}

export function scrub(text: string): ScrubResult {
  const redacted: Record<string, number> = {}
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      redacted[rule.kind] = (redacted[rule.kind] ?? 0) + 1
      const marker = `[redacted:${rule.kind}]`
      if (rule.group === undefined) return marker
      // Rebuild the match with only the target group replaced.
      const groups = args.slice(1, -2) as string[]
      return groups.map((g, i) => (i + 1 === rule.group ? marker : g ?? '')).join('')
    })
  }
  return { text: out, redacted }
}

export function totalRedactions(r: Record<string, number>): number {
  return Object.values(r).reduce((a, b) => a + b, 0)
}
