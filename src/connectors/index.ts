import type { Connector } from '../types.js'
import { github } from './github.js'
import { gmail } from './gmail.js'
import { granola } from './granola.js'
import { jira } from './jira.js'
import { notion } from './notion.js'
import { slack } from './slack.js'

/**
 * Connector registry. Connectors are dumb, deterministic API scripts —
 * they never call an LLM (SPEC §1.3). To add a source, implement the
 * Connector interface, add its config schema to `sourceSchemas`, and
 * register it here under its lore.json key.
 */
export const connectors: Record<string, Connector> = {
  slack,
  github,
  granola,
  notion,
  jira,
  gmail,
}
