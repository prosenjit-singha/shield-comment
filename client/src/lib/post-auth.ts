import type { QueryClient } from '@tanstack/react-query'
import { billingSummaryQueryOptions } from '@/lib/billing-summary'
import { workspacePagesQueryOptions } from '@/lib/meta-pages'
import { sessionQueryOptions } from '@/lib/session'

export type PostAuthDestination = '/plans' | '/onboarding' | '/dashboard'

/**
 * Where a fresh sign-in / sign-up lands when there is no explicit `?redirect=`:
 * - `/plans` while the account never had a plan (billing summary `NONE`; PR-T6, reading 5: sign-up
 *   creates no plan). A failed summary check skips this step;
 * - else `/onboarding` while the active workspace has 0 active Pages, else `/dashboard` (decision D13,
 *   answered 2026-11-18: "entry points only"). Only these entry points check; `/dashboard` itself never
 *   redirects, so "Skip for now" needs nothing stored. Any failure of the pages check (no active
 *   workspace, 403 for a moderator, 5xx, offline) → `/dashboard`.
 *
 * Call it after `queryClient.removeQueries()`: the answers stay cached, so the `_app` guard reuses the
 * session, the shell banner the summary and `/onboarding` the pages list instead of fetching them again.
 */
export async function postAuthDestination(queryClient: QueryClient): Promise<PostAuthDestination> {
  try {
    const session = await queryClient.fetchQuery(sessionQueryOptions)
    const workspaceId = session?.session.activeOrganizationId
    if (!workspaceId) return '/dashboard'
    const summary = await queryClient.fetchQuery(billingSummaryQueryOptions(workspaceId)).catch(() => null)
    if (summary?.status === 'NONE') return '/plans'
    const pages = await queryClient.fetchQuery(workspacePagesQueryOptions(workspaceId))
    return pages.pageLimit.activeCount === 0 ? '/onboarding' : '/dashboard'
  } catch {
    return '/dashboard'
  }
}
