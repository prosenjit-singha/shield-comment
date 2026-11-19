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
  subscription: { status: 'ACTIVE', interval: 'year', trialEndsAt: null, termEndsAt: '2027-11-14T18:00:00.000Z' },
  comments: { used: 4200, limit: 15_000, resetsAt: '2026-12-14T18:00:00.000Z' }, // 15 Dec in Dhaka
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
  subscription: null,
  comments: null,
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
    // Workspace status pill + the (ACTIVE) subscription badge.
    expect(row('Acme Fashion').getAllByText('Active')).toHaveLength(2)
    expect(row('Acme Fashion').getByText('18 Nov 2026')).toBeTruthy() // Dhaka date
    expect(row('Bazaar BD').getByText('Suspended')).toBeTruthy()
    expect(screen.getByText('1–2 of 2 clients')).toBeTruthy()
  })

  it('shows plan · interval · status badge and the comments column (no credits)', async () => {
    await renderList()
    expect(row('Acme Fashion').getByLabelText('Plan: Growth').textContent).toBe('Growth')
    expect(row('Acme Fashion').getByTestId('plan-interval').textContent).toBe('Yearly')
    expect(row('Acme Fashion').getByTestId('subscription-badge').textContent).toBe('Active')
    expect(row('Bazaar BD').getByLabelText('Plan: no active plan').textContent).toBe('—')
    expect(row('Bazaar BD').queryByTestId('plan-interval')).toBeNull()
    expect(row('Bazaar BD').getByTestId('subscription-badge').textContent).toBe('No plan')
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toContain('Comments')
    expect(screen.queryByRole('columnheader', { name: 'Credits' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Quota' })).toBeNull()
    expect(screen.getByText(/subscription status, monthly comments and status/)).toBeTruthy()
    expect(screen.queryByText(/credit/i)).toBeNull()
  })

  it('shows "used / limit · resets <Dhaka day>" in the comments bar', async () => {
    await renderList()
    const bar = row('Acme Fashion').getByRole('progressbar', { name: 'Monthly comments used' })
    expect(bar.getAttribute('aria-valuenow')).toBe('28')
    expect(bar.getAttribute('aria-valuetext')).toBe('4,200 / 15,000 comments, resets 15 Dec')
    expect(row('Acme Fashion').getByTestId('comments-text').textContent).toBe('4,200 / 15,000 · resets 15 Dec')
    expect(row('Acme Fashion').getByText('4,200 / 15,000').className).not.toContain('text-destructive')
    expect(row('Acme Fashion').getByTestId('comments-bar').getAttribute('title')).toBe(
      '4,200 / 15,000 · resets 15 Dec (Dhaka time)',
    )
  })

  it('shows trial / active / expired / canceled / no account rows', async () => {
    const at = (n: number) => `0199a000-0000-7000-8000-00000000001${n}`
    handlers['GET /api/admin/clients'] = () =>
      json({
        ...list,
        total: 5,
        items: [
          {
            ...acme,
            id: at(1),
            name: 'Trial Shop',
            plan: { id: 'p-starter', slug: 'starter', name: 'Starter' },
            // 25 Nov 19:30 UTC = 26 Nov 01:30 in Dhaka.
            subscription: {
              status: 'TRIALING',
              interval: 'month',
              trialEndsAt: '2026-11-25T19:30:00.000Z',
              termEndsAt: '2026-11-25T19:30:00.000Z',
            },
            comments: { used: 120, limit: 300, resetsAt: '2026-11-25T19:30:00.000Z' },
          },
          {
            ...acme,
            id: at(2),
            name: 'Paid Shop',
            plan: { id: 'p-pro', slug: 'pro', name: 'Pro' },
            subscription: { status: 'ACTIVE', interval: 'month', trialEndsAt: null, termEndsAt: '2026-12-14T18:00:00.000Z' },
            comments: { used: 1234, limit: 2500, resetsAt: '2026-12-14T18:00:00.000Z' },
          },
          {
            ...acme,
            id: at(3),
            name: 'Expired Shop',
            plan: null,
            subscription: {
              status: 'EXPIRED',
              interval: 'month',
              trialEndsAt: '2026-11-10T06:00:00.000Z',
              termEndsAt: '2026-11-10T06:00:00.000Z',
            },
            comments: { used: 0, limit: 0, resetsAt: null },
          },
          {
            ...acme,
            id: at(4),
            name: 'Canceled Shop',
            plan: null,
            subscription: { status: 'CANCELED', interval: 'year', trialEndsAt: null, termEndsAt: '2026-11-10T06:00:00.000Z' },
            comments: { used: 0, limit: 0, resetsAt: null },
          },
          { ...bazaar, id: at(5), name: 'No Account Shop', comments: { used: 0, limit: 0, resetsAt: null } },
        ],
      })
    renderAt('/admin/clients')
    await screen.findByText('Trial Shop')

    expect(row('Trial Shop').getByLabelText('Plan: Starter')).toBeTruthy()
    expect(row('Trial Shop').queryByTestId('plan-interval')).toBeNull() // a trial has no billing interval
    expect(row('Trial Shop').getByTestId('subscription-badge').textContent).toBe('Trial ends 26 Nov')
    expect(row('Trial Shop').getByTestId('comments-text').textContent).toBe('120 / 300 · resets 26 Nov')

    expect(row('Paid Shop').getByTestId('plan-interval').textContent).toBe('Monthly')
    expect(row('Paid Shop').getByTestId('subscription-badge').textContent).toBe('Active')
    expect(row('Paid Shop').getByTestId('comments-text').textContent).toBe('1,234 / 2,500 · resets 15 Dec')

    for (const [name, badge] of [
      ['Expired Shop', 'Expired'],
      ['Canceled Shop', 'Canceled'],
      ['No Account Shop', 'No plan'],
    ] as const) {
      expect(row(name).getByLabelText('Plan: no active plan').textContent).toBe('—')
      expect(row(name).getByTestId('subscription-badge').textContent).toBe(badge)
      // No live plan: text instead of a bar.
      expect(row(name).queryByRole('progressbar')).toBeNull()
      expect(row(name).getByTestId('comments-bar').textContent).toBe('No active plan')
    }
  })

  it('shows "Usage unavailable" when comments are null', async () => {
    await renderList()
    expect(row('Bazaar BD').queryByRole('progressbar')).toBeNull()
    expect(row('Bazaar BD').getByTestId('comments-bar').textContent).toBe('Usage unavailable')
  })

  it('caps the bar at 100 % when usage passes the limit', async () => {
    handlers['GET /api/admin/clients'] = () =>
      json({ ...list, items: [{ ...acme, comments: { used: 16_500, limit: 15_000, resetsAt: null } }, bazaar] })
    await renderList()
    const over = row('Acme Fashion').getByRole('progressbar', { name: 'Monthly comments used' })
    expect(over.getAttribute('aria-valuenow')).toBe('100')
    expect(over.getAttribute('aria-valuetext')).toBe('16,500 / 15,000 comments')
    expect(row('Acme Fashion').getByText('16,500 / 15,000').className).toContain('text-destructive')
    expect(row('Acme Fashion').getByTestId('comments-text').textContent).toBe('16,500 / 15,000')
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
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'No active plan' }))
    await waitFor(() => expect(lastListCall()?.get('plan')).toBe('none'))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('button', { name: 'Plan: No active plan' })).toBeTruthy()

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

  it.each([
    '/admin/clients?page=-1&status=BOGUS',
    '/admin/clients?page=abc&plan=%20&sort=random',
    '/admin/clients?from=2026-13-40&to=nope&q=%20',
  ])('falls back to the defaults for malformed params: %s', async (path) => {
    const { router } = await renderList(path)
    expect(listCalls().map((p) => p.toString())).toEqual(['sort=newest&skip=0&take=20'])
    expect(router.state.location.search).toEqual({})
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

describe('Activate plan dialog (PW-T9)', () => {
  // 20 Nov 2026, 10:00 in Dhaka.
  const NOW = new Date('2026-11-20T04:00:00.000Z')
  const plan = (id: string, slug: string, name: string, prices: [number, number | null, number | null]) => ({
    id,
    slug,
    name,
    sortOrder: 0,
    isActive: true,
    monthlyPriceBdt: prices[0],
    offerPriceBdt: prices[1],
    offerBadge: null,
    yearlyMonthlyPriceBdt: prices[2],
    trialDays: null,
    trialCommentLimit: null,
    featureConfig: { limits: {}, features: {} },
    createdAt: '',
    updatedAt: '',
  })
  const activePlans = {
    items: [
      plan('0199a000-0000-7000-8000-0000000000b2', 'starter', 'Starter', [999, 499, 449]),
      plan('0199a000-0000-7000-8000-0000000000b3', 'growth', 'Growth', [2499, 1499, 1349]),
      plan('0199a000-0000-7000-8000-0000000000b4', 'pro', 'Pro', [5999, 3999, null]),
    ],
  }
  const POST = `POST /api/admin/clients/${acme.id}/subscription`
  const activated = {
    subscription: {
      status: 'ACTIVE',
      interval: 'year',
      trialEndsAt: null,
      termEndsAt: '2027-11-19T18:00:00.000Z',
      plan: { id: activePlans.items[0]!.id, slug: 'starter', name: 'Starter' },
    },
    comments: { used: 0, limit: 2500, resetsAt: '2026-12-19T18:00:00.000Z' },
    price: {
      listChargedBdt: 5388,
      chargedBdt: 5088,
      perMonthBdt: 424,
      discount: null,
      coupon: null,
    },
  }
  const applied = (name: string, code: string | null, label: string, amountBdt: number) => ({
    promotionId: `p-${name}`,
    redemptionId: `r-${name}`,
    name,
    code,
    label,
    labelBn: label,
    amountBdt,
    months: null,
  })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    handlers['GET /api/admin/settings/plans'] = () => json(activePlans)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function openFor(name: string) {
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: `Activate plan: ${name}` }))
    const dialog = await screen.findByRole('dialog', { name: `Activate a plan for ${name}` })
    await within(dialog).findByRole('radio', { name: /Growth/ })
    return dialog
  }
  const radio = (dialog: HTMLElement, name: RegExp) => within(dialog).getByRole('radio', { name }) as HTMLButtonElement
  const submitButton = (dialog: HTMLElement) =>
    within(dialog).getByRole('button', { name: /Activate plan|Activating/ }) as HTMLButtonElement
  const price = (dialog: HTMLElement) => within(dialog).getByTestId('activation-price').textContent

  it('defaults to the live plan, Monthly, today (Dhaka) with 31-day bounds and a monthly preview', async () => {
    const dialog = await openFor('Acme Fashion')
    expect(radio(dialog, /Growth/).getAttribute('aria-checked')).toBe('true')
    expect(radio(dialog, /Starter/).getAttribute('aria-checked')).toBe('false')
    expect(radio(dialog, /Monthly/).getAttribute('aria-checked')).toBe('true')
    const date = within(dialog).getByLabelText('Start date') as HTMLInputElement
    expect(date.value).toBe('2026-11-20')
    expect(date.min).toBe('2026-10-20')
    expect(date.max).toBe('2026-11-20')
    // The list price: the legacy offer (৳1,499) is never read; promotions apply on activation.
    expect(price(dialog)).toBe('৳2,499/month')
    expect(radio(dialog, /Growth/).textContent).toContain('৳2,499')
    expect(within(dialog).getByText('Growth · term ends 20 Dec 2026')).toBeTruthy()
    expect(within(dialog).getByText(/automatic discount and the coupon come off when you activate/)).toBeTruthy()
    expect((within(dialog).getByLabelText('Coupon (optional)') as HTMLInputElement).value).toBe('')
    expect(within(dialog).getByText(/Ends Growth \(Yearly\) right away/)).toBeTruthy()
    expect(submitButton(dialog).disabled).toBe(true)
  })

  it('defaults to the first plan without a live plan', async () => {
    const dialog = await openFor('Bazaar BD')
    expect(radio(dialog, /Starter/).getAttribute('aria-checked')).toBe('true')
    expect(price(dialog)).toBe('৳999/month')
    expect(within(dialog).getByText(/No active plan to end: starts the new term from the start date\./)).toBeTruthy()
  })

  it('disables Yearly without a yearly price and previews the yearly charge', async () => {
    const dialog = await openFor('Acme Fashion')
    fireEvent.click(radio(dialog, /Pro/))
    expect(radio(dialog, /Yearly/).disabled).toBe(true)
    expect(within(dialog).getByText('Pro has no yearly price.')).toBeTruthy()

    fireEvent.click(radio(dialog, /Starter/))
    expect(radio(dialog, /Yearly/).disabled).toBe(false)
    fireEvent.click(radio(dialog, /Yearly/))
    expect(price(dialog)).toBe('৳449/month · billed ৳5,388 yearly')
    expect(within(dialog).getByText('Starter · term ends 20 Nov 2027')).toBeTruthy()

    // Back to a plan without a yearly price: falls back to Monthly.
    fireEvent.click(radio(dialog, /Pro/))
    expect(radio(dialog, /Monthly/).getAttribute('aria-checked')).toBe('true')
    expect(price(dialog)).toBe('৳5,999/month')
  })

  it.each([
    ['2026-10-19', /at most 31 days ago/],
    ['2026-11-21', /can’t be in the future/],
    ['2026-10-20', /would already be over/],
    ['', /Pick a start date/],
  ])('rejects start date %j', async (value, message) => {
    const dialog = await openFor('Acme Fashion')
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Paid' } })
    fireEvent.change(within(dialog).getByLabelText('Start date'), { target: { value } })
    expect(within(dialog).getByRole('alert').textContent).toMatch(message)
    expect(submitButton(dialog).disabled).toBe(true)
  })

  it('requires a reason (trimmed, ≤ 500) and counts its characters', async () => {
    const dialog = await openFor('Acme Fashion')
    const reason = within(dialog).getByLabelText('Reason')
    expect(within(dialog).getByText('0/500')).toBeTruthy()
    fireEvent.blur(reason)
    expect(within(dialog).getByRole('alert').textContent).toBe('A reason is required.')
    fireEvent.change(reason, { target: { value: 'x'.repeat(501) } })
    expect(within(dialog).getByRole('alert').textContent).toMatch(/500 characters/)
    expect(within(dialog).getByText('501/500')).toBeTruthy()
    expect(submitButton(dialog).disabled).toBe(true)
    fireEvent.change(reason, { target: { value: '  Paid  ' } })
    expect(within(dialog).getByText('4/500')).toBeTruthy()
    expect(submitButton(dialog).disabled).toBe(false)
  })

  it('POSTs the body (no coupon key when empty), shows a pending state, then the result, toasts and refreshes the list', async () => {
    let resolve: (res: Response) => void = () => {}
    const post = vi.fn(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((r) => {
          void init
          resolve = r
        }),
    )
    handlers[POST] = post
    const dialog = await openFor('Acme Fashion')
    const calls = listCalls().length
    fireEvent.click(radio(dialog, /Starter/))
    fireEvent.click(radio(dialog, /Yearly/))
    fireEvent.change(within(dialog).getByLabelText('Start date'), { target: { value: '2026-11-01' } })
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: '  Paid by bKash  ' } })
    fireEvent.click(submitButton(dialog))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(post.mock.calls[0]![1].body))).toEqual({
      planId: activePlans.items[0]!.id,
      interval: 'year',
      startDate: '2026-11-01',
      reason: 'Paid by bKash',
    })
    await waitFor(() => expect(submitButton(dialog).textContent).toBe('Activating…'))
    expect(submitButton(dialog).disabled).toBe(true)

    resolve(json(activated, 201))
    expect(await screen.findByText('Acme Fashion is now on Starter (Yearly).')).toBeTruthy()
    const done = await screen.findByRole('dialog', { name: 'Plan activated' })
    const result = within(done).getByTestId('activation-result')
    expect(result.textContent).toContain('List price৳5,388')
    expect(result.textContent).toContain('Charged৳5,088(৳424/month)')
    expect(within(done).getByText('No promotion applied.')).toBeTruthy()
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(calls))
    fireEvent.click(within(done).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('sends the coupon trimmed (any case) and shows the discount, the coupon and the charge', async () => {
    const post = vi.fn((_url: URL, _init: RequestInit) =>
      json(
        {
          ...activated,
          subscription: { ...activated.subscription, interval: 'month', termEndsAt: '2026-12-19T18:00:00.000Z' },
          price: {
            listChargedBdt: 999,
            chargedBdt: 399,
            perMonthBdt: 399,
            discount: applied('Launch offer', null, '৳500 off', 500),
            coupon: applied('Eid coupon', 'EID100', '৳100 off', 100),
          },
        },
        201,
      ),
    )
    handlers[POST] = post
    const dialog = await openFor('Acme Fashion')
    fireEvent.click(radio(dialog, /Starter/))
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Paid' } })
    fireEvent.change(within(dialog).getByLabelText('Coupon (optional)'), { target: { value: '  eid100 ' } })
    fireEvent.click(submitButton(dialog))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(post.mock.calls[0]![1].body))).toMatchObject({ couponCode: 'eid100' })

    const done = await screen.findByRole('dialog', { name: 'Plan activated' })
    const rows = within(done)
      .getByTestId('activation-result')
      .querySelectorAll('dt')
    expect([...rows].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])).toEqual([
      ['List price', '৳999'],
      ['Launch offer · ৳500 off', '−৳500'],
      ['Coupon EID100 · ৳100 off', '−৳100'],
      ['Charged', '৳399'],
    ])
    expect(within(done).queryByText('No promotion applied.')).toBeNull()
  })

  it.each([
    ['COUPON_NOT_FOUND', 'No coupon with this code.'],
    ['COUPON_EXPIRED', 'This coupon has ended or was stopped.'],
    ['COUPON_NOT_FOR_PLAN', 'This coupon is not for this plan or billing period.'],
    ['COUPON_ALREADY_USED', 'This client has already used this coupon.'],
    ['COUPON_USED_UP', 'This coupon has no uses left.'],
  ])('a 400 %s shows on the coupon field and clears on edit', async (code, shown) => {
    handlers[POST] = () =>
      json({ statusCode: 400, error: 'Bad Request', message: 'Coupon rejected', code, path: '/api', timestamp: '' }, 400)
    const dialog = await openFor('Acme Fashion')
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Paid' } })
    const coupon = within(dialog).getByLabelText('Coupon (optional)')
    fireEvent.change(coupon, { target: { value: 'BADCODE' } })
    fireEvent.click(submitButton(dialog))
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toBe(shown)
    expect(alert.id).toBe(coupon.getAttribute('aria-describedby'))
    expect(coupon.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('dialog', { name: 'Activate a plan for Acme Fashion' })).toBeTruthy()
    fireEvent.change(coupon, { target: { value: 'OTHER' } })
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it.each([
    [409, 'NO_BILLING_ACCOUNT', 'This client has no billing account', /no billing account \(no owner\)/],
    [400, 'TERM_ALREADY_ENDED', 'This term would already be over', /would already be over/],
    [400, 'PLAN_NOT_AVAILABLE', 'This plan is not available', /no longer available/],
    [400, undefined, 'reason must be shorter than or equal to 500 characters', /reason must be shorter/],
    [404, undefined, 'Workspace not found', /no longer exists/],
  ])('shows a %i (%s) inline and keeps the dialog open', async (status, code, message, shown) => {
    handlers[POST] = () =>
      json({ statusCode: status, error: 'Error', message, ...(code ? { code } : {}), path: '/api', timestamp: '' }, status)
    const dialog = await openFor('Acme Fashion')
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Paid' } })
    fireEvent.click(submitButton(dialog))
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toMatch(shown)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(submitButton(dialog).disabled).toBe(false)
  })
})
