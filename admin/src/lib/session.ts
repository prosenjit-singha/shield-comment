import { queryOptions } from '@tanstack/react-query'
import { authClient, type AuthSession } from '@/lib/auth-client'

export const sessionQueryKey = ['auth', 'session'] as const

/** Current Better Auth session (`null` when signed out). Route guards use `ensureQueryData` on this. */
export const sessionQueryOptions = queryOptions({
  queryKey: sessionQueryKey,
  queryFn: async (): Promise<AuthSession | null> => {
    const { data, error } = await authClient.getSession()
    if (error) throw new Error(error.message ?? `Session check failed (${error.status})`)
    return data
  },
})

export function isSuperAdmin(session: AuthSession | null | undefined): session is AuthSession {
  return session?.user.role === 'super_admin'
}
