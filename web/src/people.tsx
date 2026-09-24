import { Blobatar } from '@blobatar/react'
import { Tooltip } from '@heroui/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type Person } from './api'

/**
 * Who's who on the board: profiles (display name, avatar) of everyone who
 * shares a board with you, and the projects' contacts (name → email), so a
 * comment's email or a ticket's assignee name finds the right face.
 */
interface People {
  find(who: { email?: string; name?: string }): Person | undefined
  reload(): void
}

const Ctx = createContext<People>({ find: () => undefined, reload: () => {} })

export function PeopleProvider({ children }: { children: ReactNode }) {
  const [people, setPeople] = useState<Person[]>([])
  const [contacts, setContacts] = useState<Record<string, string>>({})
  const reload = useCallback(() => {
    api.people().then(
      (r) => {
        setPeople(r.people)
        setContacts(r.contacts)
      },
      () => undefined,
    )
  }, [])
  useEffect(reload, [reload])
  const value = useMemo<People>(() => {
    const byEmail = new Map(people.map((p) => [p.email.toLowerCase(), p]))
    const byName = new Map(people.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))
    return {
      reload,
      find({ email, name }) {
        if (email) return byEmail.get(email.toLowerCase())
        if (!name) return undefined
        const n = name.trim().toLowerCase()
        const viaContact = Object.entries(contacts).find(([c]) => c.toLowerCase() === n)?.[1]
        return byName.get(n) ?? (viaContact ? byEmail.get(viaContact) : undefined) ?? (n.includes('@') ? byEmail.get(n) : undefined)
      },
    }
  }, [people, contacts, reload])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const usePeople = () => useContext(Ctx)

/**
 * A person's face: their photo if they set one, else a blobatar — a
 * deterministic shape seeded from their email (or name), so the same
 * person looks the same everywhere. Hover shows who it is.
 */
export function PersonAvatar({ email, name, px = 28, className = '', tooltip = true }: { email?: string; name?: string; px?: number; className?: string; tooltip?: boolean }) {
  const person = usePeople().find({ email, name })
  const label = person?.name ?? name ?? email ?? 'Someone'
  const seed = (person?.email ?? email ?? name ?? '?').trim().toLowerCase()
  const face = (
    <span className={`inline-flex shrink-0 overflow-hidden rounded-full bg-default ring-2 ring-surface ${className}`} style={{ width: px, height: px }} aria-label={label} role="img">
      {person?.avatar ? <img src={api.avatarUrl(person.avatar)} alt="" className="size-full object-cover" /> : <Blobatar name={seed} size={px} title={label} />}
    </span>
  )
  if (!tooltip) return face
  return (
    <Tooltip delay={150} closeDelay={0}>
      <Tooltip.Trigger aria-label={label}>{face}</Tooltip.Trigger>
      <Tooltip.Content>
        <p className="text-xs">
          {label}
          {person?.name && (person.email ?? email) && person.name !== (person.email ?? email) ? <span className="text-muted"> · {person.email ?? email}</span> : null}
        </p>
      </Tooltip.Content>
    </Tooltip>
  )
}

/** Who is on a board: overlapping faces, the rest as "+n". */
export function AvatarStack({ people, max = 6, px = 26 }: { people: { email: string; name: string | null }[]; max?: number; px?: number }) {
  if (people.length === 0) return null
  const shown = people.slice(0, max)
  const rest = people.length - shown.length
  return (
    <span className="inline-flex items-center">
      {shown.map((p, i) => (
        <span key={p.email} className={i ? '-ml-2' : ''}>
          <PersonAvatar email={p.email} px={px} />
        </span>
      ))}
      {rest > 0 && (
        <span className="-ml-2 inline-flex items-center justify-center rounded-full bg-default text-[10px] font-medium text-muted ring-2 ring-surface" style={{ width: px, height: px }} title={people.slice(max).map((p) => p.name ?? p.email).join(', ')}>
          +{rest}
        </span>
      )}
    </span>
  )
}

/** How to show a person: their chosen name, else what the source called them. */
export function useDisplayName(who: string): string {
  const p = usePeople().find(who.includes('@') ? { email: who } : { name: who })
  return p?.name ?? who
}
