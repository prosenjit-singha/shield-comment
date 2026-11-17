import { createMemoryHistory } from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/router'

// Files prefixed with `-` are ignored by the route generator.
const getSession = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth-client', () => ({ authClient: { getSession } }))

function sessionFor(role: string) {
  return {
    data: { session: { id: 's1' }, user: { id: 'u1', email: 'a@b.co', name: 'A', role } },
    error: null,
  }
}

async function loadAt(path: string) {
  const router = createAppRouter(
    createQueryClient(),
    createMemoryHistory({ initialEntries: [path] }),
  )
  await router.load()
  return router.state.location
}

describe('_authed guard', () => {
  beforeEach(() => getSession.mockReset())

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
