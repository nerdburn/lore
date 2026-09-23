import { useEffect, useState } from 'react'

// A small router under /board: "/" (projects), "/host" (host status, admins)
// and "/p/<context>". Everything a person would bookmark — the view, the
// open ticket, the filters — lives in the query string.
const BASE = '/board'

export interface Filters {
  q: string
  label?: string
  /** An assignee's name, or "none" for unassigned. */
  assignee?: string
  /** List view: include done and archived. */
  closed: boolean
}

export const NO_FILTERS: Filters = { q: '', closed: false }

export type Route =
  | { name: 'projects' }
  | { name: 'host' }
  | { name: 'board'; context: string; view: 'list' | 'kanban'; item?: string; filters: Filters }

export function parseRoute(loc: Location = window.location): Route {
  const path = loc.pathname.startsWith(BASE) ? loc.pathname.slice(BASE.length) : loc.pathname
  if (/^\/host\/?$/.test(path)) return { name: 'host' }
  const m = /^\/p\/([\w.-]+)\/?$/.exec(path)
  if (!m) return { name: 'projects' }
  const q = new URLSearchParams(loc.search)
  return {
    name: 'board',
    context: m[1],
    view: q.get('view') === 'list' ? 'list' : 'kanban',
    item: q.get('item') ?? undefined,
    filters: { q: q.get('q') ?? '', label: q.get('label') ?? undefined, assignee: q.get('assignee') ?? undefined, closed: q.get('closed') === '1' },
  }
}

export function href(route: Route): string {
  if (route.name === 'projects') return `${BASE}/`
  if (route.name === 'host') return `${BASE}/host`
  const q = new URLSearchParams()
  if (route.view === 'list') q.set('view', 'list')
  const f = route.filters
  if (f.q) q.set('q', f.q)
  if (f.label) q.set('label', f.label)
  if (f.assignee) q.set('assignee', f.assignee)
  if (f.closed) q.set('closed', '1')
  if (route.item) q.set('item', route.item)
  const qs = q.toString()
  return `${BASE}/p/${route.context}${qs ? `?${qs}` : ''}`
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
