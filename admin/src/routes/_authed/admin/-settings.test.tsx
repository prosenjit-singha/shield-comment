import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminPlan } from '@/lib/admin-plans'
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

const PLANS = '/api/admin/settings/plans'

function plan(
  sortOrder: number,
  slug: string,
  name: string,
  price: number,
  limits: [number, number, number],
  tier: 0 | 1 | 2,
): AdminPlan {
  return {
    id: `019a0000-0000-7000-8000-00000000000${sortOrder + 1}`,
    slug,
    name,
    sortOrder,
    isActive: true,
    originalPriceBdt: price,
    offerPriceBdt: null,
    offerBadge: null,
    featureConfig: {
      limits: { connectedPages: limits[0], monthlyComments: limits[1], teamSeats: limits[2] },
      features: {
        banglaAiFilter: true,
        autoHideScams: true,
        customBlocklist: tier >= 1,
        autoReplyTemplates: tier >= 1,
        messengerAlerts: tier >= 1,
        whiteLabelReports: tier >= 2,
        prioritySupportApi: tier >= 2,
      },
    },
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
  }
}

const seeded = [
  plan(0, 'free', 'Free', 0, [1, 500, 1], 0),
  plan(1, 'starter', 'Starter', 499, [1, 2500, 1], 0),
  plan(2, 'growth', 'Growth', 1499, [5, 15000, 3], 1),
  plan(3, 'pro', 'Pro', 3999, [25, 75000, 10], 2),
] as const satisfies AdminPlan[]
const starter: AdminPlan = seeded[1]

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
let listHandler: () => Response | Promise<Response>
let patchHandler: (id: string, body: unknown) => Response | Promise<Response>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function calls(method: string, path?: string) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = new URL(input, 'http://admin.localhost')
    return (init?.method ?? 'GET') === method && (path ? url.pathname === path : url.pathname.startsWith(PLANS))
  })
}

function renderSettings() {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ['/admin/settings'] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

beforeEach(() => {
  auth.getSession.mockReset().mockResolvedValue(superAdmin)
  listHandler = () => json({ items: seeded })
  patchHandler = () => json({ statusCode: 500, message: 'unexpected PATCH' }, 500)
  fetchMock.mockReset().mockImplementation(async (input, init = {}) => {
    const url = new URL(input, 'http://admin.localhost')
    const method = init.method ?? 'GET'
    if (method === 'GET' && url.pathname === PLANS && url.search === '') return listHandler()
    const match = /^\/api\/admin\/settings\/plans\/([^/]+)$/.exec(url.pathname)
    if (method === 'PATCH' && match) return patchHandler(decodeURIComponent(match[1] ?? ''), JSON.parse(String(init.body)))
    throw new Error(`unexpected fetch ${method} ${url.pathname}${url.search}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function card(name: string) {
  return screen.findByRole('region', { name })
}

function input(region: HTMLElement, label: string) {
  return within(region).getByLabelText(label) as HTMLInputElement
}

function type(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } })
}

function saveButton(region: HTMLElement) {
  return within(region).getByRole('button', { name: 'Save' }) as HTMLButtonElement
}

describe('/admin/settings', () => {
  it('renders one card per plan in sortOrder with name, slug, prices, limits and features', async () => {
    // The API orders by sortOrder; the screen keeps that order.
    renderSettings()
    await card('Free')
    const cards = screen.getAllByTestId('plan-card')
    expect(cards.map((c) => within(c).getByRole('heading', { level: 2 }).textContent)).toEqual([
      'Free',
      'Starter',
      'Growth',
      'Pro',
    ])
    expect(cards.map((c) => within(c).getByText(/^(free|starter|growth|pro)$/).textContent)).toEqual([
      'free',
      'starter',
      'growth',
      'pro',
    ])

    const pro = await card('Pro')
    expect(input(pro, 'Original price').value).toBe('3999')
    expect(input(pro, 'Offer price').value).toBe('')
    expect(input(pro, 'Offer badge').value).toBe('')
    expect(input(pro, 'Connected FB & IG Pages').value).toBe('25')
    expect(input(pro, 'Monthly Comments Scanned').value).toBe('75000')
    expect(input(pro, 'Team / Moderator Seats').value).toBe('10')
    expect(within(pro).getAllByRole('switch')).toHaveLength(7)
    expect(within(pro).getByRole('switch', { name: 'Priority Support & API Webhook Access' }).getAttribute('aria-checked')).toBe('true')
    expect(within(pro).getByTestId('preview-price').textContent).toBe('৳3,999')
    expect(input(pro, 'Original price').className).toContain('rounded-full')

    const free = await card('Free')
    expect(within(free).getByRole('switch', { name: 'White-Label CSV/PDF Agency Reports' }).getAttribute('aria-checked')).toBe('false')
    expect(saveButton(free).disabled).toBe(true)
    expect(within(free).getByRole('button', { name: 'Reset' })).toHaveProperty('disabled', true)
    expect(calls('GET', PLANS)).toHaveLength(1)
  })

  it('edits → dirty → Save sends the minimal PATCH body, toasts and ends clean', async () => {
    let saved: AdminPlan | undefined
    patchHandler = (id) => {
      expect(id).toBe(starter.id)
      saved = {
        ...starter,
        originalPriceBdt: 999,
        offerPriceBdt: 499,
        offerBadge: '50% Launch Offer',
        featureConfig: {
          limits: { ...starter.featureConfig.limits, teamSeats: 2 },
          features: { ...starter.featureConfig.features, customBlocklist: true },
        },
        updatedAt: '2026-11-18T09:00:00.000Z',
      }
      return json({ plan: saved })
    }
    listHandler = () => json({ items: seeded.map((p): AdminPlan => (saved && p.id === saved.id ? saved : p)) })
    renderSettings()
    const region = await card('Starter')
    expect(region.dataset.dirty).toBeUndefined()

    type(input(region, 'Original price'), '999')
    type(input(region, 'Offer price'), '499')
    type(input(region, 'Offer badge'), '  50% Launch Offer ')
    type(input(region, 'Team / Moderator Seats'), '2')
    fireEvent.click(within(region).getByRole('switch', { name: 'Custom Keyword & BD Phone Blocklist' }))

    expect(region.dataset.dirty).toBe('true')
    expect(within(region).getByTestId('unsaved').textContent).toBe('Unsaved changes')
    expect(within(region).getByTestId('preview-struck').textContent).toBe('৳999')
    expect(within(region).getByTestId('preview-price').textContent).toBe('৳499')
    expect(within(region).getByTestId('preview-badge').textContent).toBe('50% Launch Offer')
    expect(within(region).getByText('16/40')).toBeTruthy()

    fireEvent.click(saveButton(region))

    await waitFor(() => expect(calls('PATCH')).toHaveLength(1))
    const [url, init] = calls('PATCH')[0] ?? ['']
    expect(url).toBe(`${PLANS}/${starter.id}`)
    expect(JSON.parse(String(init?.body))).toEqual({
      originalPriceBdt: 999,
      offerPriceBdt: 499,
      offerBadge: '50% Launch Offer',
      featureConfig: { limits: { teamSeats: 2 }, features: { customBlocklist: true } },
    })

    expect(await screen.findByText('Starter saved.')).toBeTruthy()
    await waitFor(() => expect(region.dataset.dirty).toBeUndefined())
    expect(within(region).queryByTestId('unsaved')).toBeNull()
    expect(input(region, 'Original price').value).toBe('999')
    expect(input(region, 'Offer price').value).toBe('499')
    expect(input(region, 'Offer badge').value).toBe('50% Launch Offer')
    expect(saveButton(region).disabled).toBe(true)
    // The list is refreshed after the save.
    await waitFor(() => expect(calls('GET', PLANS)).toHaveLength(2))
  })

  it('sends only one changed field and clears an offer with null', async () => {
    const promo = { ...starter, originalPriceBdt: 999, offerPriceBdt: 499, offerBadge: 'Sale' }
    listHandler = () => json({ items: [seeded[0], promo, seeded[2], seeded[3]] })
    patchHandler = () => json({ plan: { ...promo, offerPriceBdt: null } })
    renderSettings()
    const region = await card('Starter')
    type(input(region, 'Offer price'), '')
    fireEvent.click(saveButton(region))
    await waitFor(() => expect(calls('PATCH')).toHaveLength(1))
    expect(JSON.parse(String(calls('PATCH')[0]?.[1]?.body))).toEqual({ offerPriceBdt: null })
  })

  it('Reset brings back the stored values', async () => {
    renderSettings()
    const region = await card('Growth')
    type(input(region, 'Original price'), '1799')
    fireEvent.click(within(region).getByRole('switch', { name: 'WhatsApp & Telegram Alerts' }))
    expect(region.dataset.dirty).toBe('true')

    fireEvent.click(within(region).getByRole('button', { name: 'Reset' }))
    expect(region.dataset.dirty).toBeUndefined()
    expect(input(region, 'Original price').value).toBe('1499')
    expect(within(region).getByRole('switch', { name: 'WhatsApp & Telegram Alerts' }).getAttribute('aria-checked')).toBe('true')
    expect(saveButton(region).disabled).toBe(true)
    expect(calls('PATCH')).toHaveLength(0)
  })

  it('an offer above the original shows an inline error and disables Save', async () => {
    renderSettings()
    const region = await card('Starter')
    type(input(region, 'Offer price'), '500')
    expect(within(region).getByText("The offer can't be more than the original price.")).toBeTruthy()
    expect(input(region, 'Offer price').getAttribute('aria-invalid')).toBe('true')
    expect(saveButton(region).disabled).toBe(true)
    expect(within(region).getByTestId('preview-price').textContent).toBe('—')

    type(input(region, 'Offer price'), '12.5')
    expect(within(region).getByText('Use a whole number (digits only).')).toBeTruthy()
    expect(saveButton(region).disabled).toBe(true)

    type(input(region, 'Offer price'), '399')
    expect(saveButton(region).disabled).toBe(false)

    type(input(region, 'Monthly Comments Scanned'), '10000001')
    expect(saveButton(region).disabled).toBe(true)
    fireEvent.submit(saveButton(region).closest('form') as HTMLFormElement)
    expect(calls('PATCH')).toHaveLength(0)
  })

  it('a 400 shows the backend message and keeps the edit', async () => {
    patchHandler = () => json({ statusCode: 400, message: 'offerPriceBdt must not be greater than originalPriceBdt' }, 400)
    renderSettings()
    const region = await card('Pro')
    type(input(region, 'Original price'), '4999')
    fireEvent.click(saveButton(region))

    const alert = await within(region).findByRole('alert')
    expect(alert.textContent).toBe('offerPriceBdt must not be greater than originalPriceBdt')
    expect(await screen.findByText('Pro was not saved.')).toBeTruthy()
    expect(region.dataset.dirty).toBe('true')
    expect(input(region, 'Original price').value).toBe('4999')

    // Editing again clears the message.
    type(input(region, 'Original price'), '4998')
    expect(within(region).queryByRole('alert')).toBeNull()
  })

  it('a 404 toasts and refreshes the list', async () => {
    patchHandler = () => json({ statusCode: 404, message: 'Plan not found' }, 404)
    renderSettings()
    const region = await card('Free')
    type(input(region, 'Team / Moderator Seats'), '3')
    fireEvent.click(saveButton(region))
    expect(await screen.findByText('Free no longer exists.')).toBeTruthy()
    await waitFor(() => expect(calls('GET', PLANS)).toHaveLength(2))
  })

  it('shows skeletons while loading', async () => {
    let release: (res: Response) => void = () => {}
    listHandler = () => new Promise<Response>((resolve) => (release = resolve))
    renderSettings()
    expect((await screen.findAllByTestId('plan-skeleton')).length).toBe(4)
    expect(screen.queryAllByTestId('plan-card')).toHaveLength(0)
    await act(async () => release(json({ items: seeded })))
    expect(await card('Free')).toBeTruthy()
    expect(screen.queryAllByTestId('plan-skeleton')).toHaveLength(0)
  })

  it('shows "No plans" for an empty list', async () => {
    listHandler = () => json({ items: [] })
    renderSettings()
    expect(await screen.findByRole('heading', { name: 'No plans' })).toBeTruthy()
    expect(screen.queryAllByTestId('plan-card')).toHaveLength(0)
  })

  it('shows the error state and recovers with Try again', async () => {
    listHandler = () => json({ statusCode: 500, message: 'Internal server error' }, 500)
    renderSettings()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText("Couldn't load plans")).toBeTruthy()
    expect(within(alert).getByText('Internal server error')).toBeTruthy()

    listHandler = () => json({ items: seeded })
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await card('Pro')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('asks before leaving with unsaved changes', async () => {
    const { router } = renderSettings()
    const region = await card('Starter')
    type(input(region, 'Original price'), '599')

    act(() => void router.navigate({ to: '/admin/billing' }))
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' })
    expect(within(dialog).getByText('One plan has unsaved changes. They will be lost.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/admin/settings')
    expect(input(region, 'Original price').value).toBe('599')

    act(() => void router.navigate({ to: '/admin/billing' }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', {
        name: 'Discard changes',
      }),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/billing'))
  })

  it('leaves without asking when nothing is dirty', async () => {
    const { router } = renderSettings()
    await card('Starter')
    act(() => void router.navigate({ to: '/admin/billing' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/billing'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
