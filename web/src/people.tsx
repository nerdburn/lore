import { Avatar } from '@heroui/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type Person } from './api'
import { initials } from './bits'

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

/** A person's avatar: their photo if they set one, else initials. */
export function PersonAvatar({ email, name, className = 'size-7 text-[10px]', size = 'sm' }: { email?: string; name?: string; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const person = usePeople().find({ email, name })
  const label = person?.name ?? name ?? email ?? ''
  return (
    <Avatar size={size} className={className} aria-label={label}>
      {person?.avatar ? <Avatar.Image src={api.avatarUrl(person.avatar)} alt={label} /> : null}
      <Avatar.Fallback>{initials(person?.name ?? name ?? email ?? '?')}</Avatar.Fallback>
    </Avatar>
  )
}

/** How to show a person: their chosen name, else what the source called them. */
export function useDisplayName(who: string): string {
  const p = usePeople().find(who.includes('@') ? { email: who } : { name: who })
  return p?.name ?? who
}
