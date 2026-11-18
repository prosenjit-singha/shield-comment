import { queryOptions } from '@tanstack/react-query'
import { ApiError, apiFetch } from '@/lib/api'

/**
 * Meta (FB/IG) connection + workspace Pages, mirroring the backend contracts (M3-T4…T6):
 * - `GET /api/workspaces/:id/meta/oauth/url?returnTo=` → `{ url }` (the Meta dialog)
 * - callback lands on `returnTo` with `?meta=connected[&skipped=N]` or `?meta=error&reason=…`
 * - `GET /api/workspaces/:id/pages` → `{ items, pageLimit }`
 * - `PATCH /api/workspaces/:id/pages/:pageRowId/toggle` `{ isActive }` → `{ page, changed }`
 * Shared by `/onboarding` (C3) and `/pages` (C6).
 */

/** `backend/src/meta/dto/workspace-pages.dto.ts` (dates arrive as ISO strings). */
export interface WorkspacePage {
  id: string
  pageId: string
  pageName: string
  igBusinessId: string | null
  igUsername: string | null
  isActive: boolean
  /** `false` = missing on the last re-connect: can't be switched on until Facebook is reconnected. */
  hasToken: boolean
  createdAt: string
  updatedAt: string
}

export interface WorkspacePageLimit {
  limit: number
  activeCount: number
}

export interface WorkspacePagesResponse {
  items: WorkspacePage[]
  pageLimit: WorkspacePageLimit
}

export interface TogglePageResponse {
  page: WorkspacePage
  changed: boolean
}

/** Client pages allowed to start the Meta flow (`META_OAUTH_RETURN_PATHS` on the backend). */
export type MetaReturnPath = '/onboarding' | '/pages'

/** `META_OAUTH_ERROR_REASONS` in `backend/src/meta/meta-oauth-state.ts`. */
export const META_OAUTH_ERROR_REASONS = [
  'access_denied',
  'invalid_state',
  'unauthenticated',
  'state_mismatch',
  'impersonation_blocked',
  'forbidden',
  'missing_code',
  'not_configured',
  'meta_unavailable',
  'meta_error',
  'server_error',
] as const
export type MetaOAuthErrorReason = (typeof META_OAUTH_ERROR_REASONS)[number]

/** Search params the OAuth callback adds to `/onboarding` / `/pages`. */
export interface MetaReturnSearch {
  meta?: 'connected' | 'error'
  reason?: MetaOAuthErrorReason
  /** Pages held by another workspace (only sent when > 0). */
  skipped?: number
}

function isMetaOAuthErrorReason(value: unknown): value is MetaOAuthErrorReason {
  return typeof value === 'string' && (META_OAUTH_ERROR_REASONS as readonly string[]).includes(value)
}

function parseSkipped(value: unknown): number | undefined {
  // The router JSON-parses search values (`skipped=2` → 2), but accept a digit string too.
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/**
 * `validateSearch` for the routes the callback returns to. Every key is returned (`undefined` when
 * invalid): the router merges the raw search under this result, so an omitted key would leak through.
 */
export function validateMetaReturnSearch(search: Record<string, unknown>): MetaReturnSearch {
  return {
    meta: search.meta === 'connected' || search.meta === 'error' ? search.meta : undefined,
    reason: isMetaOAuthErrorReason(search.reason) ? search.reason : undefined,
    skipped: parseSkipped(search.skipped),
  }
}

export const workspacePagesQueryKey = (workspaceId: string) => ['workspace', workspaceId, 'pages'] as const

export function workspacePagesQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: workspacePagesQueryKey(workspaceId),
    queryFn: () => apiFetch<WorkspacePagesResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/pages`),
  })
}

export function togglePage(workspaceId: string, pageRowId: string, isActive: boolean): Promise<TogglePageResponse> {
  return apiFetch<TogglePageResponse>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/pages/${encodeURIComponent(pageRowId)}/toggle`,
    { method: 'PATCH', body: { isActive } },
  )
}

export async function fetchMetaOAuthUrl(workspaceId: string, returnTo: MetaReturnPath): Promise<string> {
  const query = new URLSearchParams({ returnTo })
  const { url } = await apiFetch<{ url: string }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/meta/oauth/url?${query.toString()}`,
  )
  return url
}

/** Leaves the app for the Meta dialog (full-page navigation; the callback brings the user back). */
export function goToExternalUrl(url: string): void {
  window.location.href = url
}

export type PageToggleFailure =
  | { kind: 'limit-reached'; limit: number | undefined; activeCount: number | undefined }
  | { kind: 'token-missing' }
  | { kind: 'other'; error: ApiError }

/** Reads the toggle's 409 `code` / `details` (`PAGE_LIMIT_REACHED`, `PAGE_TOKEN_MISSING`). */
export function pageToggleFailure(error: ApiError): PageToggleFailure {
  if (error.status === 409 && error.code === 'PAGE_LIMIT_REACHED') {
    const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
    return { kind: 'limit-reached', limit: number(error.details?.limit), activeCount: number(error.details?.activeCount) }
  }
  if (error.status === 409 && error.code === 'PAGE_TOKEN_MISSING') return { kind: 'token-missing' }
  return { kind: 'other', error }
}
