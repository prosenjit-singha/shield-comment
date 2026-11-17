import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/router'

// Files prefixed with `-` are ignored by the route generator.
const auth = vi.hoisted(() => ({ getSession: vi.fn(), signOut: vi.fn() }))
vi.mock('@/lib/auth-client', () => ({
  authClient: { getSession: auth.getSession, signOut: auth.signOut },
}))

const superAdmin = {
  data: {
    session: { id: 's1', impersonatedBy: null },
    user: { id: 'u1', email: 'root@shield.bd', name: 'Root Admin', role: 'super_admin', banned: false },
  },
  error: null,
}
const noSession = { data: null, error: null }

function renderAt(path: string) {
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

beforeAll(() => {
  // jsdom has no matchMedia; the shell reads it for the theme and the mobile breakpoint.
  window.matchMedia ??= ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia
  // jsdom has no Web Animations API; Animate UI's menus stagger their rows with element.animate().
  Element.prototype.animate ??= function () {
    return {
      finished: Promise.resolve(),
      playState: 'finished',
      cancel() {},
      finish() {},
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Animation
  }
  Element.prototype.getAnimations ??= () => []
  // …and no SVGGeometryElement, which the menu's check indicators test with instanceof.
  globalThis.SVGGeometryElement ??= class extends SVGElement {} as typeof SVGGeometryElement
})

beforeEach(() => {
  auth.getSession.mockReset().mockResolvedValue(superAdmin)
  auth.signOut.mockReset()
})
afterEach(cleanup)

const nav = [
  ['Dashboard', '/admin/dashboard'],
  ['Clients', '/admin/clients'],
  ['Billing', '/admin/billing'],
  ['Tickets', '/admin/tickets'],
  ['System', '/admin/system'],
  ['Settings', '/admin/settings'],
] as const

describe('_authed sidebar shell', () => {
  it('shows all six nav links to a super admin and highlights the active one', async () => {
    renderAt('/admin/dashboard')
    const navigation = await screen.findByRole('navigation', { name: 'Admin' })
    const links = within(navigation).getAllByRole('link')
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual(nav)
    expect(within(navigation).getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(within(navigation).getByRole('link', { name: 'Clients' }).getAttribute('aria-current')).toBeNull()
  })

  it.each(nav.slice(1))('renders the %s placeholder under the shell', async (label, path) => {
    renderAt(path)
    expect(await screen.findByRole('heading', { level: 1, name: label })).toBeTruthy()
    const navigation = screen.getByRole('navigation', { name: 'Admin' })
    expect(within(navigation).getByRole('link', { name: label }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Account menu' }).textContent).toContain('root@shield.bd')
  })

  it('navigates between sections from the sidebar', async () => {
    const { router } = renderAt('/admin/dashboard')
    const navigation = await screen.findByRole('navigation', { name: 'Admin' })
    fireEvent.click(within(navigation).getByRole('link', { name: 'Tickets' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Tickets' })).toBeTruthy()
    expect(router.state.location.pathname).toBe('/admin/tickets')
  })

  it('collapses and expands the sidebar through the persisted UI store', async () => {
    const { useUiStore } = await import('@/stores/ui-store')
    useUiStore.setState({ sidebarCollapsed: false })
    renderAt('/admin/dashboard')
    // The header trigger (the rail has the same label but is not focusable).
    const toggle = (await screen.findAllByRole('button', { name: 'Toggle Sidebar' })).find(
      (b) => b.dataset.sidebar === 'trigger',
    )
    if (!toggle) throw new Error('sidebar trigger not rendered')
    fireEvent.click(toggle)
    expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    expect(document.querySelector('[data-slot=sidebar]')?.getAttribute('data-state')).toBe('collapsed')
    fireEvent.click(toggle)
    expect(useUiStore.getState().sidebarCollapsed).toBe(false)
  })

  it('signs out from the user menu: signOut, cache cleared, back on /admin/login', async () => {
    auth.signOut.mockImplementation(async () => {
      auth.getSession.mockResolvedValue(noSession)
      return { data: { success: true }, error: null }
    })
    const { router, queryClient } = renderAt('/admin/clients')
    const clear = vi.spyOn(queryClient, 'clear')

    const trigger = await screen.findByRole('button', { name: 'Account menu' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('root@shield.bd')).toBeTruthy()
    expect(within(menu).getByRole('menuitemradio', { name: 'System' })).toBeTruthy()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign out' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'))
    expect(auth.signOut).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear.mock.invocationCallOrder[0]).toBeGreaterThan(auth.signOut.mock.invocationCallOrder[0] ?? Infinity)
    expect(router.state.location.search).toEqual({})
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull()
  })
})
