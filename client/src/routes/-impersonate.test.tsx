import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type RouterHistory,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '@/lib/language'
import { createQueryClient } from '@/lib/query-client'
import { createLanguageStore, LanguageStoreContext } from '@/stores/language-store'
import { Route as ImpersonateRoute } from './impersonate'

// Files prefixed with `-` are ignored by the route generator. The real `/impersonate` route is mounted
// under a bare root (the generated tree pulls in the Start server functions); `/dashboard` and `/login`
// are stubs, so these tests check only the hand-off.
const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet })
const impersonateRoute = ImpersonateRoute.update({
  id: '/impersonate',
  path: '/impersonate',
  getParentRoute: () => rootRoute,
} as never)
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  component: () => <p>Dashboard stub</p>,
})
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: () => <p>Login stub</p>,
})
const routeTree = rootRoute.addChildren([impersonateRoute, dashboardRoute, loginRoute])

const TOKEN = 'Q2hhbmdlTWVJbW1lZGlhdGVseS1vbmUtdGltZS10b2tlbg'
const fetchMock = vi.fn<typeof fetch>()

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function renderPage(
  path = `/impersonate?token=${TOKEN}`,
  { language = 'en', strict = false }: { language?: Language; strict?: boolean } = {},
) {
  const queryClient = createQueryClient()
  // Something cached under whoever was signed in before: it must be gone after the exchange.
  queryClient.setQueryData(['auth', 'session'], { user: { id: 'previous-user' } })
  queryClient.setQueryData(['workspace', 'stats'], { scanned: 42 })
  const history: RouterHistory = createMemoryHistory({ initialEntries: [path] })
  const router = createRouter({ routeTree, history, context: { queryClient } })
  const tree = (
    <LanguageStoreContext value={createLanguageStore(language)}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LanguageStoreContext>
  )
  render(strict ? <StrictMode>{tree}</StrictMode> : tree)
  return { router, history, queryClient }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('scrollTo', () => {}) // router scroll restoration; jsdom doesn't implement it
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('/impersonate', () => {
  it('posts the token once, clears cached queries and lands on /dashboard without the token', async () => {
    let urlAtPost = ''
    fetchMock.mockImplementation(async () => {
      urlAtPost = history.location.href
      return json(200, { user: { id: 'owner' }, session: { impersonatedBy: 'admin' } })
    })
    const { history, queryClient } = renderPage()

    expect(await screen.findByText('Dashboard stub')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/auth/impersonate-exchange')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', referrerPolicy: 'origin' })
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ token: TOKEN })

    // The address bar was cleaned before the token was sent, and no history entry keeps it.
    expect(urlAtPost).toBe('/impersonate')
    expect(history.location.pathname).toBe('/dashboard')
    expect(history.location.href).not.toContain(TOKEN)
    expect(history.length).toBe(1)

    expect(queryClient.getQueryData(['auth', 'session'])).toBeUndefined()
    expect(queryClient.getQueryData(['workspace', 'stats'])).toBeUndefined()
  })

  it('posts exactly once under StrictMode', async () => {
    fetchMock.mockResolvedValue(json(200, {}))
    renderPage(undefined, { strict: true })

    expect(await screen.findByText('Dashboard stub')).toBeTruthy()
    // Give any stray second effect time to fire.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows the signing-in state while the exchange is in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(await screen.findByText('Opening the client workspace…')).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it.each(['/impersonate', '/impersonate?token=', '/impersonate?token=%20%20'])(
    'shows the missing-token error without calling the API (%s)',
    async (path) => {
      renderPage(path)
      const alert = await screen.findByRole('alert')
      expect(alert.dataset.reason).toBe('missing')
      expect(screen.getByRole('heading', { name: 'This login link is incomplete' })).toBeTruthy()
      expect(alert.textContent).toContain('click "Login as Client" again')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('explains a missing token in Bangla too', async () => {
    renderPage('/impersonate', { language: 'bn' })
    expect(await screen.findByRole('heading', { name: 'এই লগইন লিংকটি অসম্পূর্ণ' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'লগইনে যান' }).getAttribute('href')).toBe('/login')
  })

  const failures: {
    name: string
    respond: () => Promise<Response>
    reason: string
    en: { title: string; body: string }
    bn: { title: string; body: string }
    retry: boolean
  }[] = [
    {
      name: '400 bad token shape',
      respond: async () => json(400, { message: 'Invalid or expired impersonation token' }),
      reason: 'invalid',
      en: { title: 'This login link is not valid', body: 'click "Login as Client" again' },
      bn: { title: 'এই লগইন লিংকটি সঠিক নয়', body: 'আবার "Login as Client" ক্লিক করুন' },
      retry: false,
    },
    {
      name: '401 expired or used',
      respond: async () => json(401, { message: 'Invalid or expired impersonation token' }),
      reason: 'expired',
      en: { title: 'This login link has expired or was already used', body: 'click "Login as Client" again' },
      bn: { title: 'এই লগইন লিংকের মেয়াদ শেষ বা এটি আগেই ব্যবহার হয়েছে', body: 'আবার "Login as Client" ক্লিক করুন' },
      retry: false,
    },
    {
      name: '403 admin no longer super admin',
      respond: async () => json(403, { message: 'Super admin only' }),
      reason: 'forbidden',
      en: { title: 'Admin access was removed', body: 'no longer a super admin' },
      bn: { title: 'অ্যাডমিন অ্যাক্সেস বাতিল হয়েছে', body: 'আর সুপার অ্যাডমিন নন' },
      retry: false,
    },
    {
      name: '404 workspace gone',
      respond: async () => json(404, { message: 'Workspace not found' }),
      reason: 'not-found',
      en: { title: 'Workspace not found', body: 'no longer exists' },
      bn: { title: 'ওয়ার্কস্পেস পাওয়া যায়নি', body: 'আর নেই' },
      retry: false,
    },
    {
      name: '409 suspended',
      respond: async () => json(409, { message: 'Workspace is suspended' }),
      reason: 'suspended',
      en: { title: 'This workspace is suspended', body: 'Reactivate it in the admin panel' },
      bn: { title: 'এই ওয়ার্কস্পেসটি স্থগিত', body: 'আবার চালু করুন' },
      retry: false,
    },
    {
      name: '409 no owner',
      respond: async () => json(409, { message: 'Workspace has no owner that can be impersonated' }),
      reason: 'no-owner',
      en: { title: 'No owner to sign in as', body: 'no active owner account' },
      bn: { title: 'লগ ইন করার মতো কোনো মালিক নেই', body: 'কোনো সক্রিয় মালিক অ্যাকাউন্ট নেই' },
      retry: false,
    },
    {
      name: '429 rate limited',
      respond: async () => json(429, { message: 'Too many requests' }),
      reason: 'rate-limited',
      en: { title: 'Too many attempts', body: 'try again' },
      bn: { title: 'অনেকবার চেষ্টা করা হয়েছে', body: 'আবার চেষ্টা করুন' },
      retry: true,
    },
    {
      name: '502 from the proxy (not JSON)',
      respond: async () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      reason: 'server',
      en: { title: 'Something went wrong', body: 'couldn’t finish the login' },
      bn: { title: 'কিছু একটা সমস্যা হয়েছে', body: 'লগইন সম্পন্ন করতে পারেনি' },
      retry: true,
    },
    {
      name: 'network error',
      respond: () => Promise.reject(new TypeError('Failed to fetch')),
      reason: 'network',
      en: { title: 'Can’t reach ShieldComment', body: 'Check your internet connection' },
      bn: { title: 'ShieldComment-এ সংযোগ করা যাচ্ছে না', body: 'ইন্টারনেট সংযোগ দেখে' },
      retry: true,
    },
  ]

  describe.each(['en', 'bn'] as const)('error screen (%s)', (language) => {
    it.each(failures)('$name', async (failure) => {
      fetchMock.mockImplementation(failure.respond)
      const { history, queryClient } = renderPage(undefined, { language })
      const copy = failure[language]

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.reason).toBe(failure.reason)
      expect(screen.getByRole('heading', { name: copy.title })).toBeTruthy()
      expect(alert.textContent).toContain(copy.body)

      const login = screen.getByRole('link', { name: language === 'en' ? 'Go to login' : 'লগইনে যান' })
      expect(login.getAttribute('href')).toBe('/login')
      const retryName = language === 'en' ? 'Try again' : 'আবার চেষ্টা করুন'
      expect(screen.queryByRole('button', { name: retryName }) !== null).toBe(failure.retry)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(history.location.href).toBe('/impersonate')
      expect(history.length).toBe(1)
      // A failed exchange changes nothing: the previous user's cache stays.
      expect(queryClient.getQueryData(['auth', 'session'])).toEqual({ user: { id: 'previous-user' } })
    })
  })

  it('retries a network failure with the same token, then continues to /dashboard', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(200, {}))
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Dashboard stub')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ token: TOKEN })
  })

  it('goes to /login from the error screen', async () => {
    fetchMock.mockResolvedValue(json(401, { message: 'Invalid or expired impersonation token' }))
    const { history } = renderPage()
    fireEvent.click(await screen.findByRole('link', { name: 'Go to login' }))
    expect(await screen.findByText('Login stub')).toBeTruthy()
    await waitFor(() => expect(history.location.pathname).toBe('/login'))
  })
})
