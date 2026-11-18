import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { languageFromCookieString, type Language } from '@/lib/language'
import { createQueryClient } from '@/lib/query-client'
import { createLanguageStore, LanguageStoreContext } from '@/stores/language-store'
import { useUiStore } from '@/stores/ui-store'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'
import { Route as AppRoute } from './_app'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// The real `_app` layout under a bare root (the generated tree pulls in the Start server functions),
// with a stub child page and a stub /login.
const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet })
const appRoute = AppRoute.update({ id: '/_app', getParentRoute: () => rootRoute } as never)
const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/dashboard',
  component: () => <p>Dashboard stub</p>,
})
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: () => <p>Login stub</p> })
const routeTree = rootRoute.addChildren([appRoute.addChildren([dashboardRoute]), loginRoute])

const USER = { id: 'u1', email: 'owner@shop.bd', name: 'Rahim', emailVerified: false }
const SESSION = { session: { id: 's1', userId: 'u1', impersonatedBy: null }, user: USER }
const IMPERSONATED = { session: { id: 's2', userId: 'u1', impersonatedBy: 'admin-1' }, user: USER }

const copy = {
  en: {
    bannerTitle: 'Admin Impersonation Mode',
    bannerBody: 'You are viewing this workspace as its owner (owner@shop.bd) via Admin Impersonation.',
    exit: 'Exit impersonation',
    exiting: 'Exiting…',
    retry: 'Try again',
    ended: 'You can close this tab',
    endedBody: 'The impersonated session has ended.',
    exitFailed: 'Couldn’t end the impersonated session.',
    server: 'The server is unavailable right now.',
    network: 'Can’t reach the server.',
    logout: 'Log out',
    logoutFailed: 'Couldn’t log you out.',
    switchLanguage: 'Switch to Bangla',
    languageLabel: 'বাংলা',
  },
  bn: {
    bannerTitle: 'অ্যাডমিন ইমপারসোনেশন মোড',
    bannerBody: 'আপনি অ্যাডমিন ইমপারসোনেশনের মাধ্যমে এই ওয়ার্কস্পেসটি এর মালিক (owner@shop.bd) হিসেবে দেখছেন।',
    exit: 'ইমপারসোনেশন থেকে বের হন',
    exiting: 'বের হচ্ছে…',
    retry: 'আবার চেষ্টা করুন',
    ended: 'এখন এই ট্যাবটি বন্ধ করতে পারেন',
    endedBody: 'ইমপারসোনেশন সেশন শেষ হয়েছে।',
    exitFailed: 'ইমপারসোনেশন সেশন শেষ করা যায়নি।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
    network: 'সার্ভারে সংযোগ করা যাচ্ছে না।',
    logout: 'লগ আউট',
    logoutFailed: 'লগ আউট করা যায়নি।',
    switchLanguage: 'ইংরেজিতে দেখুন',
    languageLabel: 'English',
  },
} as const

function renderApp(path = '/dashboard', language: Language = 'en') {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  // Tenant data cached by a page: it must be gone after a sign-out, and kept when one fails.
  queryClient.setQueryData(['workspace', 'stats'], { scanned: 42 })
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

const banner = () => screen.queryByRole('status', { name: /Admin Impersonation Mode|অ্যাডমিন ইমপারসোনেশন মোড/ })

function clearLanguageCookie() {
  document.cookie = 'shield-lang=; Path=/; Max-Age=0'
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('scrollTo', () => {})
  // jsdom has no matchMedia; the theme toggle resolves 'system' with it.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  useUiStore.setState({ theme: 'light' })
  clearLanguageCookie()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  clearLanguageCookie()
})

describe('_app shell', () => {
  it('shows the top bar and the page, without the banner, for a normal session', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION) })
    renderApp()

    expect(await screen.findByText('Dashboard stub')).toBeTruthy()
    expect(screen.getByText('owner@shop.bd')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'ShieldComment BD' }).getAttribute('href')).toBe('/dashboard')
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy()
    expect(banner()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Exit impersonation' })).toBeNull()
  })

  it('redirects to /login?redirect= when there is no session', async () => {
    mockApi({}) // get-session → null
    const { history } = renderApp('/dashboard?tab=week')

    expect(await screen.findByText('Login stub')).toBeTruthy()
    expect(history.location.pathname).toBe('/login')
    expect(new URLSearchParams(history.location.search).get('redirect')).toBe('/dashboard?tab=week')
    expect(screen.queryByText('Dashboard stub')).toBeNull()
  })

  it('logs out a normal session: sign-out POST, cache cleared, /login', async () => {
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      '/api/auth/sign-out': () => json(200, { success: true }),
    })
    const { history, queryClient } = renderApp()

    fireEvent.click(await screen.findByRole('button', { name: 'Log out' }))
    expect(await screen.findByText('Login stub')).toBeTruthy()
    expect(callsTo('/api/auth/sign-out')).toHaveLength(1)
    expect(callsTo('/api/auth/sign-out')[0]!.method).toBe('POST')
    expect(history.location.pathname).toBe('/login')
    expect(history.length).toBe(1) // replace: Back doesn't return to the signed-out shell
    expect(queryClient.getQueryData(['workspace', 'stats'])).toBeUndefined()
    expect(queryClient.getQueryData(['auth', 'session'])).toBeUndefined()
  })

  it('keeps the user signed in and explains a failed log-out', async () => {
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      '/api/auth/sign-out': () => new Response('<html>Bad Gateway</html>', { status: 502 }),
    })
    const { history, queryClient } = renderApp()

    fireEvent.click(await screen.findByRole('button', { name: 'Log out' }))
    const alert = await screen.findByRole('alert')
    expect(alert.dataset.kind).toBe('server')
    expect(alert.textContent).toContain('Couldn’t log you out.')
    expect(history.location.pathname).toBe('/dashboard')
    expect(screen.getByText('Dashboard stub')).toBeTruthy()
    expect(queryClient.getQueryData(['workspace', 'stats'])).toEqual({ scanned: 42 })
  })

  it('toggles the theme', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION) })
    renderApp()

    fireEvent.click(await screen.findByRole('button', { name: 'Switch to dark theme' }))
    expect(useUiStore.getState().theme).toBe('dark')
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeTruthy()
  })

  it('switches EN → BN, writes the shield-lang cookie and switches back', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, IMPERSONATED) })
    renderApp()

    expect(await screen.findByText(copy.en.bannerTitle)).toBeTruthy()
    expect(languageFromCookieString(document.cookie)).toBe('en') // nothing written yet

    fireEvent.click(screen.getByRole('button', { name: copy.en.switchLanguage }))
    expect(await screen.findByText(copy.bn.bannerTitle)).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.bn.exit })).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.bn.switchLanguage }).textContent).toContain(copy.bn.languageLabel)
    expect(document.cookie).toContain('shield-lang=bn')
    expect(languageFromCookieString(document.cookie)).toBe('bn') // what the next server render reads

    fireEvent.click(screen.getByRole('button', { name: copy.bn.switchLanguage }))
    expect(await screen.findByText(copy.en.bannerTitle)).toBeTruthy()
    expect(languageFromCookieString(document.cookie)).toBe('en')
  })

  describe.each(['en', 'bn'] as const)('impersonation banner (%s)', (language) => {
    const t = copy[language]

    it('is shown with the owner email, and the top bar has no separate log-out', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, IMPERSONATED) })
      renderApp('/dashboard', language)

      expect(await screen.findByText('Dashboard stub')).toBeTruthy()
      const bar = banner()
      expect(bar).toBeTruthy()
      expect(within(bar!).getByText(t.bannerTitle)).toBeTruthy()
      expect(bar!.textContent).toContain(t.bannerBody)
      expect(within(bar!).getByRole('button', { name: t.exit })).toBeTruthy()
      expect(screen.queryByRole('button', { name: t.logout })).toBeNull()
    })

    it('is hidden for a normal session', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION) })
      renderApp('/dashboard', language)

      expect(await screen.findByText('Dashboard stub')).toBeTruthy()
      expect(banner()).toBeNull()
      expect(screen.queryByText(t.bannerTitle)).toBeNull()
      expect(screen.getByRole('button', { name: t.logout })).toBeTruthy()
    })

    it('Exit signs the impersonated session out, clears the cache and says the tab can be closed', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, IMPERSONATED),
        '/api/auth/sign-out': () => json(200, { success: true }),
      })
      const { history, queryClient } = renderApp('/dashboard', language)

      fireEvent.click(await screen.findByRole('button', { name: t.exit }))
      expect(await screen.findByRole('heading', { name: t.ended })).toBeTruthy()
      expect(screen.getByText(new RegExp(t.endedBody))).toBeTruthy()

      expect(callsTo('/api/auth/sign-out')).toHaveLength(1)
      expect(callsTo('/api/auth/sign-out')[0]!.method).toBe('POST')
      expect(queryClient.getQueryData(['workspace', 'stats'])).toBeUndefined()
      expect(queryClient.getQueryData(['auth', 'session'])).toBeUndefined()
      // No redirect to /login; the shell and the page are gone.
      expect(history.location.pathname).toBe('/dashboard')
      expect(screen.queryByText('Login stub')).toBeNull()
      expect(screen.queryByText('Dashboard stub')).toBeNull()
      expect(banner()).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(callsTo('/api/auth/sign-out')).toHaveLength(1)
    })

    it('shows the pending state while signing out', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, IMPERSONATED),
        '/api/auth/sign-out': () => new Promise<Response>(() => {}),
      })
      renderApp('/dashboard', language)

      fireEvent.click(await screen.findByRole('button', { name: t.exit }))
      const pending = await screen.findByRole('button', { name: t.exiting })
      expect((pending as HTMLButtonElement).disabled).toBe(true)
    })

    it.each([
      { name: '502 from the proxy', kind: 'server', message: t.server, respond: () => new Response('down', { status: 502 }) },
      { name: '500 JSON', kind: 'server', message: t.server, respond: () => json(500, { message: 'boom' }) },
      {
        name: 'network error',
        kind: 'network',
        message: t.network,
        respond: () => Promise.reject(new TypeError('Failed to fetch')),
      },
    ])('Exit failure ($name) shows an error and retries', async ({ kind, message, respond }) => {
      let failNext = true
      mockApi({
        '/api/auth/get-session': () => json(200, IMPERSONATED),
        '/api/auth/sign-out': () => {
          if (failNext) {
            failNext = false
            return respond()
          }
          return json(200, { success: true })
        },
      })
      const { queryClient } = renderApp('/dashboard', language)

      fireEvent.click(await screen.findByRole('button', { name: t.exit }))
      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe(kind)
      expect(alert.textContent).toContain(t.exitFailed)
      expect(alert.textContent).toContain(message)
      // Still impersonating: banner, page and cache stay.
      expect(banner()).toBeTruthy()
      expect(screen.getByText('Dashboard stub')).toBeTruthy()
      expect(queryClient.getQueryData(['workspace', 'stats'])).toEqual({ scanned: 42 })

      fireEvent.click(screen.getByRole('button', { name: t.retry }))
      expect(await screen.findByRole('heading', { name: t.ended })).toBeTruthy()
      expect(callsTo('/api/auth/sign-out')).toHaveLength(2)
      expect(queryClient.getQueryData(['workspace', 'stats'])).toBeUndefined()
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    })
  })
})
