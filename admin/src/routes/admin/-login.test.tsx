import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/router'

// Files prefixed with `-` are ignored by the route generator.
const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('@/lib/auth-client', () => ({
  authClient: {
    getSession: auth.getSession,
    signIn: { email: auth.signInEmail },
    signOut: auth.signOut,
  },
}))

type OnError = (ctx: { response: Response }) => void

function sessionFor(role: string, extra: { impersonatedBy?: string } = {}) {
  return {
    data: {
      session: { id: 's1', impersonatedBy: extra.impersonatedBy ?? null },
      user: { id: 'u1', email: 'owner@shop.bd', name: 'Owner', role, banned: false },
    },
    error: null,
  }
}
const noSession = { data: null, error: null }

function renderLogin(path = '/admin/login?redirect=%2Fadmin%2Fdashboard') {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

async function submit(email = 'admin@shield.bd', password = 'secret-password') {
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

beforeEach(() => {
  auth.getSession.mockReset().mockResolvedValue(noSession)
  auth.signInEmail.mockReset()
  auth.signOut.mockReset()
})
afterEach(cleanup)

describe('/admin/login', () => {
  it('shows a loading state while signing in', async () => {
    auth.signInEmail.mockReturnValue(new Promise(() => {}))
    renderLogin()
    await submit()
    const button = await screen.findByRole('button', { name: 'Signing in…' })
    expect(button).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Email').matches(':disabled')).toBe(true)
    expect(auth.signInEmail).toHaveBeenCalledWith(
      { email: 'admin@shield.bd', password: 'secret-password' },
      expect.objectContaining({ onError: expect.any(Function) }),
    )
  })

  it('explains a bad password (401) and marks the fields invalid', async () => {
    auth.signInEmail.mockResolvedValue({
      data: null,
      error: { status: 401, code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
    })
    renderLogin()
    await submit()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Incorrect email or password.')
    expect(alert.dataset.kind).toBe('invalid-credentials')
    expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true')

    // Editing a field clears the error.
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('explains rate limiting (429) with the X-Retry-After wait', async () => {
    auth.signInEmail.mockImplementation(async (_input: unknown, options: { onError: OnError }) => {
      options.onError({ response: new Response(null, { status: 429, headers: { 'X-Retry-After': '42' } }) })
      return { data: null, error: { status: 429, message: 'Too many requests. Please try again later.' } }
    })
    renderLogin()
    await submit()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Too many sign-in attempts. Try again in 42 s.')
  })

  it('explains a banned account (403 BANNED_USER)', async () => {
    auth.signInEmail.mockResolvedValue({
      data: null,
      error: { status: 403, code: 'BANNED_USER', message: 'You have been banned from this application' },
    })
    renderLogin()
    await submit()
    expect((await screen.findByRole('alert')).textContent).toContain('This account has been banned.')
  })

  it('explains a network failure', async () => {
    auth.signInEmail.mockRejectedValue(new TypeError('Failed to fetch'))
    renderLogin()
    await submit()
    const alert = await screen.findByRole('alert')
    expect(alert.dataset.kind).toBe('network')
    expect(alert.textContent).toContain("Can't reach the server.")
  })

  it('drops a non-string ?redirect= (the router JSON-parses ?redirect=123 into a number)', async () => {
    const { router } = renderLogin('/admin/login?redirect=123')
    await screen.findByLabelText('Email')
    const login = router.state.matches.find((m) => m.routeId === '/admin/login')
    expect(login?.search).toHaveProperty('redirect', undefined)
  })

  it('signs a super admin in, clears the session query and goes to ?redirect', async () => {
    auth.signInEmail.mockImplementation(async () => {
      auth.getSession.mockResolvedValue(sessionFor('super_admin'))
      return { data: { token: 't' }, error: null }
    })
    const { router } = renderLogin()
    await submit()
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/dashboard'))
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy()
    expect(auth.getSession).toHaveBeenCalledTimes(2) // cached `null` was dropped and re-fetched
  })

  it('refuses a non-super-admin: notice, no admin UI, sign-out returns to the form', async () => {
    auth.signInEmail.mockImplementation(async () => {
      auth.getSession.mockResolvedValue(sessionFor('user'))
      return { data: { token: 't' }, error: null }
    })
    auth.signOut.mockImplementation(async () => {
      auth.getSession.mockResolvedValue(noSession)
      return { data: { success: true }, error: null }
    })
    const { router } = renderLogin()
    await submit('owner@shop.bd')

    const notice = await screen.findByRole('alert')
    expect(notice.textContent).toContain('owner@shop.bd is signed in, but it is not a super admin account.')
    expect(router.state.location.pathname).toBe('/admin/login')
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('button', { name: 'Sign in' })
    expect(auth.signOut).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps a non-super-admin out of a deep link and shows the notice', async () => {
    auth.getSession.mockResolvedValue(sessionFor('user'))
    const { router } = renderLogin('/admin/dashboard')
    expect((await screen.findByRole('alert')).textContent).toContain('not a super admin account')
    expect(router.state.location.pathname).toBe('/admin/login')
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull()
  })

  it('refuses an impersonation session', async () => {
    auth.getSession.mockResolvedValue(sessionFor('super_admin', { impersonatedBy: 'admin-1' }))
    renderLogin('/admin/dashboard')
    expect((await screen.findByRole('alert')).textContent).toContain('"Login as Client" session')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
  })
})
