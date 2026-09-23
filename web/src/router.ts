import { useEffect, useState } from 'react'

// A two-route router under /board: "/" (projects) and "/p/<context>".
const BASE = '/board'

export type Route = { name: 'projects' } | { name: 'board'; context: string; view: 'list' | 'kanban'; item?: string }

export function parseRoute(loc: Location = window.location): Route {
  const path = loc.pathname.startsWith(BASE) ? loc.pathname.slice(BASE.length) : loc.pathname
  const m = /^\/p\/([\w.-]+)\/?$/.exec(path)
  if (!m) return { name: 'projects' }
  const q = new URLSearchParams(loc.search)
  return { name: 'board', context: m[1], view: q.get('view') === 'list' ? 'list' : 'kanban', item: q.get('item') ?? undefined }
}

export function href(route: Route): string {
  if (route.name === 'projects') return `${BASE}/`
  const q = new URLSearchParams()
  if (route.view === 'list') q.set('view', 'list')
  if (route.item) q.set('item', route.item)
  const qs = q.toString()
  return `${BASE}/p/${route.context}${qs ? `?${qs}` : ''}`
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
