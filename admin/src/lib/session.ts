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

/**
 * Why a session may or may not use the admin panel. Only `'granted'` gets in; the rest are refused
 * by the `_authed` guard and explained on `/admin/login`. The backend `SuperAdminGuard` re-checks
 * all of this (role + ban from Postgres, impersonation), so this is UX, not the security boundary.
 */
export type AdminAccess = 'granted' | 'signed-out' | 'not-super-admin' | 'banned' | 'impersonated'

export function adminAccess(session: AuthSession | null | undefined): AdminAccess {
  if (!session) return 'signed-out'
  // An impersonation session acts as a client owner; it must never open the admin panel,
  // even if the impersonated user happens to be a super admin.
  if (session.session.impersonatedBy) return 'impersonated'
  if (session.user.banned) return 'banned'
  if (session.user.role !== 'super_admin') return 'not-super-admin'
  return 'granted'
}

export function isSuperAdmin(session: AuthSession | null | undefined): session is AuthSession {
  return adminAccess(session) === 'granted'
}
