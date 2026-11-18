import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient, ClientList } from '@/lib/admin-clients'
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

const acme: AdminClient = {
  id: '0199a000-0000-7000-8000-000000000001',
  name: 'Acme Fashion',
  slug: 'acme-fashion',
  status: 'ACTIVE',
  createdAt: '2026-11-17T20:30:00.000Z', // 18 Nov in Dhaka
  plan: { id: '0199a000-0000-7000-8000-0000000000b3', slug: 'growth', name: 'Growth' },
  owner: { id: 'o1', email: 'rahim@acme.bd', name: 'Rahim Uddin' },
  memberCount: 3,
}
const bazaar: AdminClient = {
  id: '0199a000-0000-7000-8000-000000000002',
  name: 'Bazaar BD',
  slug: 'bazaar-bd',
  status: 'SUSPENDED',
  createdAt: '2026-10-01T06:00:00.000Z',
  plan: null,
  owner: { id: 'o2', email: 'karim@bazaar.bd', name: 'Karim' },
  memberCount: 1,
}
const list: ClientList = { items: [acme, bazaar], total: 2, skip: 0, take: 20 }
/** `GET /api/admin/settings/plans` (only the fields the plan filter reads). */
const plans = {
  items: [
    { id: '0199a000-0000-7000-8000-0000000000b1', slug: 'free', name: 'Free' },
    { id: '0199a000-0000-7000-8000-0000000000b2', slug: 'starter', name: 'Starter' },
    { id: '0199a000-0000-7000-8000-0000000000b3', slug: 'growth', name: 'Growth' },
    { id: '0199a000-0000-7000-8000-0000000000b4', slug: 'pro', name: 'Pro' },
  ],
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
let handlers: Record<string, Handler>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function apiError(status: number, message: string) {
  return json({ statusCode: status, error: 'Error', message, path: '/api', timestamp: '' }, status)
}

/** GET list calls so far, as parsed search params. */
function listCalls() {
  return fetchMock.mock.calls
    .map(([input, init]) => ({ url: new URL(input, 'http://admin.localhost'), method: init?.method ?? 'GET' }))
    .filter(({ url, method }) => method === 'GET' && url.pathname === '/api/admin/clients')
    .map(({ url }) => url.searchParams)
}
const lastListCall = () => listCalls().at(-1)

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

beforeEach(() => {
  auth.getSession.mockReset().mockResolvedValue(superAdmin)
  handlers = {
    'GET /api/admin/clients': () => json(list),
    'GET /api/admin/settings/plans': () => json(plans),
  }
  fetchMock.mockReset().mockImplementation(async (input, init = {}) => {
    const url = new URL(input, 'http://admin.localhost')
    const handler = handlers[`${init.method ?? 'GET'} ${url.pathname}`]
    if (!handler) throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url.pathname}`)
    return handler(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function renderList(path = '/admin/clients') {
  const result = renderAt(path)
  await screen.findByText('Acme Fashion')
  return result
}
const row = (name: string) => {
  const cell = screen.getByText(name)
  const tr = cell.closest('tr')
  if (!tr) throw new Error(`no row for ${name}`)
  return within(tr)
}

describe('/admin/clients list', () => {
  it('renders the clients from GET /api/admin/clients (newest first, page 1)', async () => {
    await renderList()
    expect(screen.getByRole('heading', { level: 1, name: 'Clients' })).toBeTruthy()
    const params = lastListCall()
    expect(params?.get('sort')).toBe('newest')
    expect(params?.get('skip')).toBe('0')
    expect(params?.get('take')).toBe('20')
    expect(params?.has('q')).toBe(false)

    expect(row('Acme Fashion').getByText('rahim@acme.bd')).toBeTruthy()
    expect(row('Acme Fashion').getByText('Active')).toBeTruthy()
    expect(row('Acme Fashion').getByText('18 Nov 2026')).toBeTruthy() // Dhaka date
    expect(row('Bazaar BD').getByText('Suspended')).toBeTruthy()
    expect(screen.getByText('1–2 of 2 clients')).toBeTruthy()
  })

  it('shows the plan name, a muted dash for no plan, and the Quota placeholder on every row', async () => {
    await renderList()
    expect(row('Acme Fashion').getByLabelText('Plan: Growth').textContent).toBe('Growth')
    expect(row('Bazaar BD').getByLabelText('Plan: none yet').textContent).toBe('—')
    expect(screen.getAllByLabelText('Plan: none yet')).toHaveLength(1)
    expect(screen.getAllByText('No plan yet')).toHaveLength(2)
    expect(screen.getAllByTestId('quota-bar')).toHaveLength(2)
  })

  it('shows the muted dash on every row while no client has a plan', async () => {
    handlers['GET /api/admin/clients'] = () =>
      json({ ...list, items: list.items.map((c) => ({ ...c, plan: null })) })
    await renderList()
    expect(screen.getAllByLabelText('Plan: none yet').map((b) => b.textContent)).toEqual(['—', '—'])
  })

  it('filters by plan (slug or none) through ?plan= and the API query', async () => {
    const { router } = await renderList('/admin/clients?page=3')
    expect(lastListCall()?.has('plan')).toBe(false)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Plan: All plans' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Growth' }))
    await waitFor(() => expect(lastListCall()?.get('plan')).toBe('growth'))
    expect(lastListCall()?.get('skip')).toBe('0') // a filter change resets the page
    expect(router.state.location.search).toEqual({ plan: 'growth' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.keyDown(screen.getByRole('button', { name: 'Plan: Growth' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'No plan' }))
    await waitFor(() => expect(lastListCall()?.get('plan')).toBe('none'))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('button', { name: 'Plan: No plan' })).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: /Clear filters/ })[0]!)
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    await waitFor(() => expect(lastListCall()?.has('plan')).toBe(false))
  })

  it('drops a malformed ?plan= and page instead of sending them', async () => {
    const { router } = await renderList('/admin/clients?plan=Growth%20Plan&page=abc')
    expect(lastListCall()?.has('plan')).toBe(false)
    expect(lastListCall()?.get('skip')).toBe('0')
    expect(router.state.location.search).toEqual({})
    expect(screen.getByRole('button', { name: 'Plan: All plans' })).toBeTruthy()
  })

  it('debounces the search box into ?q= and the API query', async () => {
    const { router } = await renderList()
    const calls = listCalls().length
    fireEvent.change(screen.getByLabelText('Search clients'), { target: { value: '  rahim ' } })
    // Nothing is sent while typing.
    expect(router.state.location.search).toEqual({})
    expect(listCalls()).toHaveLength(calls)

    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'rahim' }))
    await waitFor(() => expect(lastListCall()?.get('q')).toBe('rahim'))
    expect(lastListCall()?.get('skip')).toBe('0')
  })

  it('maps status, sort and Dhaka date filters to search params and the API query', async () => {
    const { router } = await renderList('/admin/clients?page=2')
    expect(lastListCall()?.get('skip')).toBe('20')

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Suspended' }), { button: 0 })
    await waitFor(() => expect(router.state.location.search).toEqual({ status: 'SUSPENDED' }))
    await waitFor(() => expect(lastListCall()?.get('status')).toBe('SUSPENDED'))
    expect(lastListCall()?.get('skip')).toBe('0') // a filter change resets the page

    fireEvent.change(screen.getByLabelText('Created from'), { target: { value: '2026-11-01' } })
    fireEvent.change(screen.getByLabelText('Created to'), { target: { value: '2026-11-18' } })
    await waitFor(() =>
      expect(lastListCall()?.get('createdTo')).toBe('2026-11-18T23:59:59.999+06:00'),
    )
    expect(lastListCall()?.get('createdFrom')).toBe('2026-11-01T00:00:00+06:00')

    fireEvent.keyDown(screen.getByRole('button', { name: 'Sort: Newest first' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Name (A–Z)' }))
    await waitFor(() => expect(lastListCall()?.get('sort')).toBe('name'))
    expect(router.state.location.search).toEqual({
      status: 'SUSPENDED',
      from: '2026-11-01',
      to: '2026-11-18',
      sort: 'name',
    })
  })

  it('shows a filtered empty state with Clear filters', async () => {
    handlers['GET /api/admin/clients'] = (url) =>
      json(url.searchParams.has('q') ? { items: [], total: 0, skip: 0, take: 20 } : list)
    const { router } = renderAt('/admin/clients?q=nobody')
    expect(await screen.findByText('No clients match these filters')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /Clear filters/ })[0]!)
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    expect(await screen.findByText('Acme Fashion')).toBeTruthy()
    expect((screen.getByLabelText('Search clients') as HTMLInputElement).value).toBe('')
  })
})

describe('suspend / activate dialog', () => {
  it('requires a reason, then PATCHes { status, reason } and refreshes the list', async () => {
    const patch = vi.fn((_url: URL, init: RequestInit) => {
      void init
      return json({ client: { ...acme, status: 'SUSPENDED' }, changed: true })
    })
    handlers[`PATCH /api/admin/clients/${acme.id}/status`] = patch
    await renderList()
    const calls = listCalls().length

    fireEvent.click(screen.getByRole('button', { name: 'Suspend Acme Fashion' }))
    const dialog = await screen.findByRole('dialog', { name: 'Suspend Acme Fashion?' })
    const confirm = within(dialog).getByRole('button', { name: 'Suspend client' }) as HTMLButtonElement
    const reason = within(dialog).getByLabelText('Reason')
    expect(confirm.disabled).toBe(true)

    fireEvent.change(reason, { target: { value: '   ' } })
    fireEvent.blur(reason)
    expect(within(dialog).getByRole('alert').textContent).toBe('A reason is required.')
    expect(confirm.disabled).toBe(true)

    fireEvent.change(reason, { target: { value: 'x'.repeat(501) } })
    expect(within(dialog).getByRole('alert').textContent).toMatch(/500 characters/)
    expect(confirm.disabled).toBe(true)

    fireEvent.change(reason, { target: { value: '  Chargeback on last payment  ' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(patch.mock.calls[0]![1].body))).toEqual({
      status: 'SUSPENDED',
      reason: 'Chargeback on last payment',
    })
    expect(await screen.findByText('Acme Fashion is suspended.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(calls))
  })

  it('activates a suspended client', async () => {
    const patch = vi.fn((_url: URL, init: RequestInit) => {
      void init
      return json({ client: { ...bazaar, status: 'ACTIVE' }, changed: true })
    })
    handlers[`PATCH /api/admin/clients/${bazaar.id}/status`] = patch
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Activate Bazaar BD' }))
    const dialog = await screen.findByRole('dialog', { name: 'Activate Bazaar BD?' })
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Paid' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Activate client' }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(patch.mock.calls[0]![1].body))).toEqual({ status: 'ACTIVE', reason: 'Paid' })
    expect(await screen.findByText('Bazaar BD is active again.')).toBeTruthy()
  })

  it.each([
    [400, 'reason must be shorter than or equal to 500 characters', 'The status change was rejected.'],
    [404, 'Workspace not found', 'This client no longer exists.'],
  ])('toasts a %i and refreshes the list', async (status, message, toastText) => {
    handlers[`PATCH /api/admin/clients/${acme.id}/status`] = () => apiError(status, message)
    await renderList()
    const calls = listCalls().length
    fireEvent.click(screen.getByRole('button', { name: 'Suspend Acme Fashion' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Spam' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend client' }))
    expect(await screen.findByText(toastText)).toBeTruthy()
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(calls))
  })
})

describe('Login as Client', () => {
  function fakeTab() {
    return {
      opener: {} as unknown,
      closed: false,
      location: { href: '' },
      close: vi.fn(),
    }
  }

  it('opens the tab synchronously on click, then points it at redirectUrl', async () => {
    const tab = fakeTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    let resolve: (res: Response) => void = () => {}
    handlers[`POST /api/admin/clients/${acme.id}/impersonate`] = () =>
      new Promise<Response>((r) => {
        resolve = r
      })
    await renderList()

    fireEvent.click(screen.getByRole('button', { name: 'Login as Client: Acme Fashion' }))
    // Inside the click handler, before the API answered: popup blockers allow this.
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(tab.opener).toBeNull()
    expect(tab.location.href).toBe('')
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/admin/clients/${acme.id}/impersonate`,
        expect.objectContaining({ method: 'POST' }),
      ),
    )

    const redirectUrl = 'http://app.localhost:5174/impersonate?token=abc'
    resolve(json({ token: 'abc', redirectUrl }))
    await waitFor(() => expect(tab.location.href).toBe(redirectUrl))
    expect(tab.close).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('closes the tab and toasts on 409', async () => {
    const tab = fakeTab()
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    handlers[`POST /api/admin/clients/${acme.id}/impersonate`] = () =>
      apiError(409, 'Workspace has no owner that can be impersonated')
    await renderList()

    fireEvent.click(screen.getByRole('button', { name: 'Login as Client: Acme Fashion' }))
    expect(await screen.findByText("Can't log in as Acme Fashion.")).toBeTruthy()
    expect(screen.getByText('Workspace has no owner that can be impersonated')).toBeTruthy()
    expect(tab.close).toHaveBeenCalledTimes(1)
    expect(tab.location.href).toBe('')
  })

  it('is disabled for a suspended client', async () => {
    await renderList()
    const button = screen.getByRole('button', { name: 'Login as Client: Bazaar BD' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})
