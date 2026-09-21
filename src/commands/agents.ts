import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type AgentGrant, agentsFilePath, readAgentsFile } from '../mcp-http.js'

/**
 * `lore agents` — who may open which context through the hosted MCP endpoint
 * (`lore www`, /mcp/<context>). Edits ~/.lore/agents.json on the host; the
 * server reads the file on every new session, so no restart.
 *
 *   lore agents allow accord-agent lore-jointly        # grant (adds to the list)
 *   lore agents allow ops-agent '*' --as ops           # every context; writes attributed to "ops"
 *   lore agents revoke accord-agent lore-jointly       # remove one context (or the agent, with no context)
 *   lore agents list
 */
export interface AgentsOptions {
  file?: string
  /** Name writes are attributed to, instead of the VM name. */
  as?: string
  json?: boolean
}

export function agentsAllow(agent: string, contexts: string[], opts: AgentsOptions = {}): AgentGrant {
  if (!/^[\w.-]+$/.test(agent)) throw new Error(`agent must be a VM name, got "${agent}"`)
  if (contexts.length === 0) throw new Error('name at least one context, or "*"')
  const path = opts.file ?? agentsFilePath()
  const all = readAgentsFile(path)
  const current = all[agent]
  let next: AgentGrant['contexts']
  if (contexts.includes('*') || current?.contexts === '*') next = '*'
  else next = [...new Set([...(current?.contexts ?? []), ...contexts])].sort()
  const grant: AgentGrant = { contexts: next, ...(opts.as ? { actor: opts.as } : current?.actor ? { actor: current.actor } : {}) }
  all[agent] = grant
  write(path, all)
  return grant
}

export function agentsRevoke(agent: string, contexts: string[], opts: AgentsOptions = {}): AgentGrant | undefined {
  const path = opts.file ?? agentsFilePath()
  const all = readAgentsFile(path)
  const current = all[agent]
  if (!current) throw new Error(`${agent} is not in ${path}`)
  if (contexts.length === 0 || current.contexts === '*') {
    delete all[agent]
    write(path, all)
    return undefined
  }
  const left = current.contexts.filter((c) => !contexts.includes(c))
  if (left.length === 0) delete all[agent]
  else all[agent] = { ...current, contexts: left }
  write(path, all)
  return all[agent]
}

export function agentsList(opts: AgentsOptions = {}): void {
  const path = opts.file ?? agentsFilePath()
  const all = readAgentsFile(path)
  if (opts.json) {
    console.log(JSON.stringify(all, null, 2))
    return
  }
  const names = Object.keys(all).sort()
  if (names.length === 0) {
    console.log(`no agents in ${path} — \`lore agents allow <vm> <context>\``)
    return
  }
  for (const name of names) {
    const g = all[name]
    console.log(`${name.padEnd(20)} ${g.contexts === '*' ? '* (every context)' : g.contexts.join(', ')}${g.actor ? `  as ${g.actor}` : ''}`)
  }
}

function write(path: string, all: Record<string, AgentGrant>): void {
  mkdirSync(dirname(path), { recursive: true })
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n')
}
