import { useEffect, useState } from 'react'

// A small router under /board: "/" (projects), "/host" (host status, admins)
// "/p/<context>" (the board) and "/p/<context>/requests" (client requests
// not yet ticketed). Everything a person would bookmark — the view, the
// open ticket, the filters — lives in the query string.
const BASE = '/board'

export interface Filters {
  q: string
  /** Any of these labels (empty: any). */
  labels: string[]
  /** Any of these assignees, "none" meaning unassigned (empty: any). */
  assignees: string[]
  /** List view: include done and archived. Requests view: include tracked, done and stale. */
  closed: boolean
  /** Board view: show the Archived column. */
  archived: boolean
}

export const NO_FILTERS: Filters = { q: '', labels: [], assignees: [], closed: false, archived: false }

export type Route =
  | { name: 'projects' }
  | { name: 'host' }
  | { name: 'connect' }
  | { name: 'profile' }
  | { name: 'help' }
  | { name: 'authorize'; request: string }
  | { name: 'board'; context: string; view: 'list' | 'kanban' | 'requests'; item?: string; filters: Filters }

export function parseRoute(loc: Location = window.location): Route {
  const path = loc.pathname.startsWith(BASE) ? loc.pathname.slice(BASE.length) : loc.pathname
  if (/^\/host\/?$/.test(path)) return { name: 'host' }
  if (/^\/connect\/?$/.test(path)) return { name: 'connect' }
  if (/^\/profile\/?$/.test(path)) return { name: 'profile' }
  if (/^\/help\/?$/.test(path)) return { name: 'help' }
  if (/^\/authorize\/?$/.test(path)) return { name: 'authorize', request: new URLSearchParams(loc.search).get('request') ?? '' }
  const m = /^\/p\/([\w.-]+)(\/requests)?\/?$/.exec(path)
  if (!m) return { name: 'projects' }
  const q = new URLSearchParams(loc.search)
  return {
    name: 'board',
    context: m[1],
    view: m[2] ? 'requests' : q.get('view') === 'list' ? 'list' : 'kanban',
    item: q.get('item') ?? undefined,
    filters: { q: q.get('q') ?? '', labels: q.getAll('label'), assignees: q.getAll('assignee'), closed: q.get('closed') === '1', archived: q.get('archived') === '1' },
  }
}

export function href(route: Route): string {
  if (route.name === 'projects') return `${BASE}/`
  if (route.name === 'host') return `${BASE}/host`
  if (route.name === 'connect') return `${BASE}/connect`
  if (route.name === 'profile') return `${BASE}/profile`
  if (route.name === 'help') return `${BASE}/help`
  if (route.name === 'authorize') return `${BASE}/authorize?request=${encodeURIComponent(route.request)}`
  const q = new URLSearchParams()
  if (route.view === 'list') q.set('view', 'list')
  const f = route.filters
  if (f.q) q.set('q', f.q)
  for (const l of f.labels) q.append('label', l)
  for (const a of f.assignees) q.append('assignee', a)
  if (f.closed) q.set('closed', '1')
  if (f.archived) q.set('archived', '1')
  if (route.item) q.set('item', route.item)
  const qs = q.toString()
  return `${BASE}/p/${route.context}${route.view === 'requests' ? '/requests' : ''}${qs ? `?${qs}` : ''}`
}

export function boardRoute(context: string): Route {
  return { name: 'board', context, view: 'kanban', filters: NO_FILTERS }
}

export function navigate(route: Route, replace = false): void {
  const url = href(route)
  if (url === window.location.pathname + window.location.search) return
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parseRoute)
  useEffect(() => {
    const on = () => setRoute(parseRoute())
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return route
}
