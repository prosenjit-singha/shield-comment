import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import type { Language } from '@/lib/language'
import type { WorkspaceMetaConnection, WorkspacePage } from '@/lib/meta-pages'
import { createQueryClient } from '@/lib/query-client'
import { Route as AppRoute } from '@/routes/_app'
import { Route as DashboardRoute } from '@/routes/_app/dashboard'
import { Route as OnboardingRoute } from '@/routes/_app/onboarding'
import { Route as PagesRoute } from '@/routes/_app/pages'
import { createLanguageStore, LanguageStoreContext } from '@/stores/language-store'
import { useUiStore } from '@/stores/ui-store'
import { json } from './auth-routes'

/**
 * Harness for the logged-in Meta screens (`/onboarding` M3-T10, `/pages` M3-T11): the real `_app`
 * layout + `/onboarding` + `/pages` + `/dashboard` route files under a bare root (the generated tree pulls
 * in the Start server functions), with a stub /login. Test files must still
 * `vi.mock('@/server/session', …)` themselves (vi.mock is hoisted per file).
 */
const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet })
const appRoute = AppRoute.update({ id: '/_app', getParentRoute: () => rootRoute } as never)
const childOptions = (path: string) => ({ id: path, path, getParentRoute: () => appRoute }) as never
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: () => <p>Login stub</p> })
const routeTree = rootRoute.addChildren([
  appRoute.addChildren([
    OnboardingRoute.update(childOptions('/onboarding')),
    PagesRoute.update(childOptions('/pages')),
    DashboardRoute.update(childOptions('/dashboard')),
  ]),
  loginRoute,
])

export const USER = { id: 'u1', email: 'owner@shop.bd', name: 'Rahim', emailVerified: false }
export const SESSION = { session: { id: 's1', userId: 'u1', impersonatedBy: null, activeOrganizationId: 'w1' }, user: USER }
export const IMPERSONATED = { session: { ...SESSION.session, id: 's2', impersonatedBy: 'admin-1' }, user: USER }

export const PAGES = '/api/workspaces/w1/pages'
export const OAUTH_URL = '/api/workspaces/w1/meta/oauth/url'
export const toggleUrl = (id: string) => `${PAGES}/${id}/toggle`
export const DISCONNECT = '/api/workspaces/w1/meta/connection'
export const META_DIALOG = 'https://www.facebook.com/v26.0/dialog/oauth?client_id=1&state=abc'

export function page(overrides: Partial<WorkspacePage> = {}): WorkspacePage {
  return {
    id: 'p1',
    pageId: '1001',
    pageName: 'Rahim Fashion',
    igBusinessId: '17841',
    igUsername: 'rahimfashion',
    isActive: false,
    hasToken: true,
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  }
}

export const SECOND = page({ id: 'p2', pageId: '1002', pageName: 'Shop Two', igBusinessId: null, igUsername: null })

export const connection = (status: WorkspaceMetaConnection['status'] = 'ACTIVE'): WorkspaceMetaConnection => ({
  status,
  statusChangedAt: '2026-11-19T00:00:00.000Z',
  tokenExpiresAt: status === 'REVOKED' ? null : '2027-01-18T00:00:00.000Z',
})

export interface PagesApiOptions {
  /** The list's `connection` (M4-T9); default ACTIVE. */
  connection?: WorkspaceMetaConnection | null
  /**
   * Adds `DELETE …/meta/connection`: answers with this; a 2xx answer empties the list and sets
   * `connection: null` for the next GET (as the backend does).
   */
  onDisconnect?: () => Response | Promise<Response>
}

/**
 * A stateful pages API: GET lists `items`; PATCH …/toggle flips the Page (or answers with `onToggle`,
 * which gets the stored row) and the next GET reflects it.
 */
export function pagesApi(
  items: WorkspacePage[],
  limit = 3,
  onToggle?: (item: WorkspacePage) => Response | Promise<Response>,
  options: PagesApiOptions = {},
) {
  const state = items.map((item) => ({ ...item }))
  let current = options.connection === undefined ? connection() : options.connection
  const list = () =>
    json(200, {
      items: state,
      pageLimit: { limit, activeCount: state.filter((item) => item.isActive).length },
      connection: current,
    })
  const handlers: Record<string, () => Response | Promise<Response>> = { [PAGES]: list }
  const { onDisconnect } = options
  if (onDisconnect) {
    handlers[DISCONNECT] = async () => {
      const response = await onDisconnect()
      if (response.ok) {
        state.length = 0
        current = null
      }
      return response
    }
  }
  for (const item of state) {
    handlers[toggleUrl(item.id)] = () => {
      if (onToggle) return onToggle(item)
      item.isActive = !item.isActive
      return json(200, { page: item, changed: true })
    }
  }
  return handlers
}

/** jsdom gaps the `_app` shell needs (top-bar theme toggle reads matchMedia; the router scrolls). */
export function stubAppGlobals(): void {
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  useUiStore.setState({ theme: 'light' })
}

export function renderAppRoute(path: string, language: Language = 'en') {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createRouter({ routeTree, history, context: { queryClient } })
  render(
    <LanguageStoreContext value={createLanguageStore(language)}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LanguageStoreContext>,
  )
  return { router, history, queryClient }
}
