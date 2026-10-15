import type { LoreConfig } from '../config.js'
import { type ActorDefinition, type LoadActor, type LoadRole } from './schema.js'

const formatters = new Map<string, Intl.DateTimeFormat>()
export function localDay(at: string, timezone: string): string {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(timezone, formatter)
    if (formatters.size > 16) formatters.delete(formatters.keys().next().value!)
  }
  return formatter.format(new Date(at))
}

/** Explicit project registry takes precedence over the existing contact directory. */
export function actorResolver(config: LoreConfig): (identities: string[], at?: string) => LoadActor {
  const keys = new Map<string, { definition: ActorDefinition; attribution: 'explicit' | 'contact' }[]>()
  const add = (definition: ActorDefinition, attribution: 'explicit' | 'contact') => {
    for (const identity of definition.identities) {
      const key = identity.trim().toLowerCase()
      const entries = keys.get(key) ?? []
      entries.push({ definition, attribution }); keys.set(key, entries)
    }
  }
  for (const a of config.load?.actors ?? []) add(a, 'explicit')
  for (const c of config.client?.contacts ?? []) add({
    id: `email:${c.email.toLowerCase()}`, name: c.name, kind: 'human',
    identities: [`email:${c.email}`, ...(c.aliases ?? []).map(e => `email:${e}`), `name:${c.name}`],
    // Customer is a direct translation of an explicitly configured client contact.
    // Job titles such as PM and account lead are deliberately not guessed.
    roles: c.side === 'client' ? [{ role: 'customer' }] : [],
  }, 'contact')
  return (identities, at) => {
    const matches = identities.flatMap(i => keys.get(i.trim().toLowerCase()) ?? [])
    const explicit = matches.filter(m => m.attribution === 'explicit')
    const selected = explicit.length ? explicit : matches
    const distinct = [...new Map(selected.map(m => [m.definition.id, m])).values()]
    if (distinct.length !== 1) return { id: identities[0] ?? 'unknown', name: (identities[0] ?? 'unknown').replace(/^[^:]+:/, ''), kind: 'unknown', roles: [], attribution: 'unknown', roleDatesKnown: false }
    const { definition: a, attribution } = distinct[0]
    const day = at ? (/^\d{4}-\d{2}-\d{2}$/.test(at) ? at : localDay(at, config.load?.timezone ?? 'UTC')) : undefined
    const active = a.roles.filter(r => day ? (!r.from || r.from <= day) && (!r.to || day < r.to) : !r.from && !r.to)
    return { id: a.id, name: a.name, kind: a.kind, roles: [...new Set(active.map(r => r.role))] as LoadRole[], attribution, roleDatesKnown: active.length > 0 && active.every(r => Boolean(r.from)) }
  }
}
