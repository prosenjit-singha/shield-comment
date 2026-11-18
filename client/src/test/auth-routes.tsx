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
import { createQueryClient } from '@/lib/query-client'
import { Route as OnboardingRoute } from '@/routes/_app/onboarding'
import { Route as LoginRoute } from '@/routes/login'
import { Route as RegisterRoute } from '@/routes/register'
import { createLanguageStore, LanguageStoreContext } from '@/stores/language-store'

/**
 * Test harness for the C2 auth screens (M3-T8). The real `/login`, `/register` and `/onboarding` route
 * files are mounted under a bare root (the generated tree pulls in the Start server functions, and
 * `/onboarding`'s `_app` guard is not under test here); `/`, `/dashboard` and `/orders` are stubs.
 * Better Auth's client runs for real against a stubbed global `fetch`.
 */
const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet })
const stub = (path: string, text: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => <p>{text}</p> })

const routeTree = rootRoute.addChildren([
  LoginRoute.update({ id: '/login', path: '/login', getParentRoute: () => rootRoute } as never),
  RegisterRoute.update({ id: '/register', path: '/register', getParentRoute: () => rootRoute } as never),
  OnboardingRoute.update({ id: '/onboarding', path: '/onboarding', getParentRoute: () => rootRoute } as never),
  stub('/', 'Landing stub'),
  stub('/dashboard', 'Dashboard stub'),
  stub('/orders', 'Orders stub'),
])

export const fetchMock = vi.fn<typeof fetch>()

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

type Handler = () => Response | Promise<Response>

/** Answers by pathname; get-session defaults to "signed out". Unknown paths fail the test loudly. */
export function mockApi(handlers: Record<string, Handler>): void {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
    const handler = handlers[url.pathname] ?? (url.pathname === '/api/auth/get-session' ? () => json(200, null) : undefined)
    if (!handler) throw new Error(`Unexpected fetch ${url.pathname}`)
    return handler()
  })
}

export interface ApiCall {
  path: string
  method: string
  body: unknown
}

/** Every call made through `fetch`, with the JSON body parsed. */
export function apiCalls(): ApiCall[] {
  return fetchMock.mock.calls.map(([input, init]) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
    const raw = init?.body
    return {
      path: url.pathname,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw,
    }
  })
}

export function callsTo(path: string): ApiCall[] {
  return apiCalls().filter((call) => call.path === path)
}

export function renderAuthRoute(path: string, language: Language = 'en') {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createRouter({ routeTree, history, context: { queryClient } })
  const languageStore = createLanguageStore(language)
  render(
    <LanguageStoreContext value={languageStore}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LanguageStoreContext>,
  )
  return { router, history, queryClient, languageStore }
}
