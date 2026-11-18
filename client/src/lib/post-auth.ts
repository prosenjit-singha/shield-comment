import type { QueryClient } from '@tanstack/react-query'
import { workspacePagesQueryOptions } from '@/lib/meta-pages'
import { sessionQueryOptions } from '@/lib/session'

export type PostAuthDestination = '/onboarding' | '/dashboard'

/**
 * Where a fresh sign-in / sign-up lands when there is no explicit `?redirect=` (decision D13, answered
 * 2026-11-18: "entry points only"): `/onboarding` while the active workspace has 0 active Pages, else
 * `/dashboard`. Only these entry points check; `/dashboard` itself never redirects, so "Skip for now"
 * needs nothing stored. Any failure (no active workspace, 403 for a moderator, 5xx, offline) →
 * `/dashboard`.
 *
 * Call it after `queryClient.removeQueries()`: both answers stay cached, so the `_app` guard reuses the
 * session and `/onboarding` reuses the pages list instead of fetching them again.
 */
export async function postAuthDestination(queryClient: QueryClient): Promise<PostAuthDestination> {
  try {
    const session = await queryClient.fetchQuery(sessionQueryOptions)
    const workspaceId = session?.session.activeOrganizationId
    if (!workspaceId) return '/dashboard'
    const pages = await queryClient.fetchQuery(workspacePagesQueryOptions(workspaceId))
    return pages.pageLimit.activeCount === 0 ? '/onboarding' : '/dashboard'
  } catch {
    return '/dashboard'
  }
}
