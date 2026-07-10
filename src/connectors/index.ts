import type { Connector } from '../types.js'
import { slack } from './slack.js'

/**
 * Connector registry. Connectors are dumb, deterministic API scripts —
 * they never call an LLM (SPEC §1.3). To add a source, implement the
 * Connector interface and register it here under its lore.json key.
 *
 * Planned: email (gmail), linear, github, granola, vercel.
 */
export const connectors: Record<string, Connector> = {
  slack,
}
