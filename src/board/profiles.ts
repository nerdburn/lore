import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loreHome } from '../context.js'
import type { LoreConfig } from '../config.js'
import { principalMatches } from './access.js'

/**
 * Board profiles — a display name and an avatar per person, across every
 * project on the host (so they live in <LORE_HOME>/profiles.json, not in a
 * client's context repo). The avatar is a blob in the asset store, by
 * sha256, like any attachment.
 */

export interface Profile {
  name?: string
  avatar?: string
  updated: string
}

export type Profiles = Record<string, Profile>

export function profilesFile(): string {
  return join(loreHome(), 'profiles.json')
}

export function readProfiles(file = profilesFile()): Profiles {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Profiles
  } catch {
    return {}
  }
}

export function updateProfile(email: string, change: { name?: string | null; avatar?: string | null }, file = profilesFile(), now = new Date()): Profile {
  const all = readProfiles(file)
  const p: Profile = { ...(all[email] ?? {}), updated: now.toISOString() }
  if (change.name !== undefined) {
    const n = change.name?.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (n) p.name = n
    else delete p.name
  }
  if (change.avatar !== undefined) {
    if (change.avatar) p.avatar = change.avatar
    else delete p.avatar
  }
  all[email] = p
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n')
  renameSync(tmp, file)
  return p
}

/**
 * Whose profiles `viewer` may see: anyone who shares a board with them
 * (a member or viewer of a project `viewer` can open, by email or @domain),
 * and the host admins.
 */
export function visiblePeople(profiles: Profiles, viewer: string, projects: LoreConfig[], admins: string[]): string[] {
  const out = new Set<string>([viewer])
  for (const email of Object.keys(profiles)) {
    if (admins.includes(email)) {
      out.add(email)
      continue
    }
    for (const config of projects) {
      const b = config.board
      if (!b?.enabled) continue
      if ([...b.members, ...b.viewers].some((entry) => principalMatches(entry, email))) {
        out.add(email)
        break
      }
    }
  }
  return [...out].filter((e) => profiles[e])
}
