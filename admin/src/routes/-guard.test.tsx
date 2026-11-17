import { createMemoryHistory } from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/router'

// Files prefixed with `-` are ignored by the route generator.
const getSession = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth-client', () => ({ authClient: { getSession } }))

function sessionFor(
  role: string,
  extra: { impersonatedBy?: string; banned?: boolean } = {},
) {
  return {
    data: {
      session: { id: 's1', impersonatedBy: extra.impersonatedBy ?? null },
      user: { id: 'u1', email: 'a@b.co', name: 'A', role, banned: extra.banned ?? false },
    },
    error: null,
  }
}

async function loadAt(path: string) {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  await router.load()
  return router.state.location
}

describe('_authed guard', () => {
  // Braces matter: a function returned from beforeEach is run as teardown (it would call the mock).
  beforeEach(() => {
    getSession.mockReset()
  })

  it('redirects a signed-out visitor to /admin/login with the target in ?redirect', async () => {
    getSession.mockResolvedValue({ data: null, error: null })
    const location = await loadAt('/admin/dashboard')
    expect(location.pathname).toBe('/admin/login')
    expect(location.search).toEqual({ redirect: '/admin/dashboard' })
  })

  it('redirects a signed-in non-super-admin to /admin/login', async () => {
    getSession.mockResolvedValue(sessionFor('user'))
    const location = await loadAt('/admin/dashboard')
    expect(location.pathname).toBe('/admin/login')
  })

  it('refuses an impersonation session even when the user is a super admin', async () => {
    getSession.mockResolvedValue(sessionFor('super_admin', { impersonatedBy: 'admin-1' }))
    const location = await loadAt('/admin/dashboard')
    expect(location.pathname).toBe('/admin/login')
    expect(location.search).toEqual({ redirect: '/admin/dashboard' })
  })

  it('refuses a banned super admin', async () => {
    getSession.mockResolvedValue(sessionFor('super_admin', { banned: true }))
    const location = await loadAt('/admin/dashboard')
    expect(location.pathname).toBe('/admin/login')
  })

  it('fails closed to /admin/login when the session check errors', async () => {
    getSession.mockRejectedValue(new TypeError('Failed to fetch'))
    const location = await loadAt('/admin/dashboard')
    expect(location.pathname).toBe('/admin/login')
    expect(location.search).toEqual({ redirect: '/admin/dashboard' })
  })

  it('lets a super admin through to /admin/dashboard', async () => {
    getSession.mockResolvedValue(sessionFor('super_admin'))
    const location = await loadAt('/admin/dashboard')
    expect(location.pathname).toBe('/admin/dashboard')
  })

  it('sends a super admin on /admin/login back to the ?redirect target', async () => {
    getSession.mockResolvedValue(sessionFor('super_admin'))
    const location = await loadAt('/admin/login?redirect=%2Fadmin%2Fdashboard')
    expect(location.pathname).toBe('/admin/dashboard')
  })

  it('ignores an off-site ?redirect target', async () => {
    getSession.mockResolvedValue(sessionFor('super_admin'))
    const location = await loadAt('/admin/login?redirect=%2F%2Fevil.example')
    expect(location.pathname).toBe('/admin/dashboard')
  })
})
