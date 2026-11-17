import { queryOptions } from '@tanstack/react-query'
import { authClient, type AuthSession } from '@/lib/auth-client'
import { getServerSession } from '@/server/session'

export const sessionQueryKey = ['auth', 'session'] as const

async function fetchBrowserSession(): Promise<AuthSession | null> {
  const { data, error } = await authClient.getSession()
  if (error) throw new Error(error.message ?? `Session check failed (${error.status})`)
  return data
}

/**
 * Current Better Auth session (`null` when signed out). Route guards use `ensureQueryData` on this.
 * Server render: the `getServerSession` server function forwards the request cookie to the backend.
 * Browser: the Better Auth client through same-origin /api.
 *
 * A plain `typeof window` branch on purpose: inside `createIsomorphicFn().server()` the server function
 * is stripped from the client build, and the production build then leaves it out of its manifest
 * ("Server function info not found").
 */
export const sessionQueryOptions = queryOptions({
  queryKey: sessionQueryKey,
  queryFn: (): Promise<AuthSession | null> =>
    typeof window === 'undefined' ? getServerSession() : fetchBrowserSession(),
})
