import { Spinner, Toast } from '@heroui/react'
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type Me } from './api'
import { BoardPage } from './BoardPage'
import { Header } from './Header'
import { Login } from './Login'
import { Projects } from './Projects'
import { useRoute } from './router'

export function App() {
  const route = useRoute()
  const [me, setMe] = useState<Me | null | undefined>(undefined)

  useEffect(() => {
    api.me().then(setMe, (err) => setMe(err instanceof ApiError && err.status === 401 ? null : null))
  }, [])

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined)
    setMe(null)
  }, [])

  // Any 401 later (session revoked, epoch bumped) drops back to sign-in.
  const onUnauthorized = useCallback(() => setMe(null), [])

  if (me === undefined)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    )

  return (
    <>
      <Toast.Provider placement="bottom end" />
      {me === null ? (
        <Login onSignedIn={setMe} />
      ) : (
        <div className="flex min-h-screen flex-col">
          <Header me={me} onSignOut={signOut} />
          <main className="flex-1">
            {route.name === 'projects' ? (
              <Projects onUnauthorized={onUnauthorized} />
            ) : (
              <BoardPage key={route.context} route={route} onUnauthorized={onUnauthorized} />
            )}
          </main>
        </div>
      )}
    </>
  )
}
