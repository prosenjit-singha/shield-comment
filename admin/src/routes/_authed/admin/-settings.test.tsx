import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanAuditEntry, PlanAuditList } from '@/lib/admin-plan-audit'
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
const AUDIT = '/api/admin/settings/plans/audit'

function plan(
  sortOrder: number,
  slug: string,
  name: string,
  price: number,
  offer: [number, string] | null,
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
    offerPriceBdt: offer?.[0] ?? null,
    offerBadge: offer?.[1] ?? null,
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

// As seeded by 0007 + the 0008 launch offers.
const seeded = [
  plan(0, 'free', 'Free', 0, null, [1, 500, 1], 0),
  plan(1, 'starter', 'Starter', 999, [499, '50% Launch Offer'], [1, 2500, 1], 0),
  plan(2, 'growth', 'Growth', 2499, [1499, '40% Off'], [5, 15000, 3], 1),
  plan(3, 'pro', 'Pro', 5999, [3999, '33% Off'], [25, 75000, 10], 2),
] as const satisfies AdminPlan[]
const starter: AdminPlan = seeded[1]

const rootAdmin = { id: 'u1', name: 'Root Admin', email: 'root@shield.bd' }

function auditEntry(n: number, patch: Partial<PlanAuditEntry> = {}): PlanAuditEntry {
  return {
    id: `019a0000-0000-7000-9000-${String(n).padStart(12, '0')}`,
    plan: { id: starter.id, slug: 'starter', name: 'Starter' },
    admin: rootAdmin,
    action: 'UPDATE',
    changes: [{ field: 'featureConfig.limits.teamSeats', before: n, after: n + 1 }],
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
    createdAt: '2026-11-18T06:00:00.000Z',
    ...patch,
  }
}

function auditPage(items: PlanAuditEntry[], url: URL, total = items.length): PlanAuditList {
  return { items, total, skip: Number(url.searchParams.get('skip')), take: Number(url.searchParams.get('take')) }
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
let listHandler: () => Response | Promise<Response>
let patchHandler: (id: string, body: unknown) => Response | Promise<Response>
let auditHandler: (url: URL) => Response | Promise<Response>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function calls(method: string, path?: string) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = new URL(input, 'http://admin.localhost')
    return (
      (init?.method ?? 'GET') === method &&
      (path ? url.pathname === path : url.pathname.startsWith(PLANS) && url.pathname !== AUDIT)
    )
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
  auditHandler = (url) => json(auditPage([], url))
  fetchMock.mockReset().mockImplementation(async (input, init = {}) => {
    const url = new URL(input, 'http://admin.localhost')
    const method = init.method ?? 'GET'
    if (method === 'GET' && url.pathname === PLANS && url.search === '') return listHandler()
    if (method === 'GET' && url.pathname === AUDIT) return auditHandler(url)
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
    expect(input(pro, 'Original price').value).toBe('5999')
    expect(input(pro, 'Offer price').value).toBe('3999')
    expect(input(pro, 'Offer badge').value).toBe('33% Off')
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
        originalPriceBdt: 1199,
        offerPriceBdt: 599,
        offerBadge: '50% Eid Offer',
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

    type(input(region, 'Original price'), '1199')
    type(input(region, 'Offer price'), '599')
    type(input(region, 'Offer badge'), '  50% Eid Offer ')
    type(input(region, 'Team / Moderator Seats'), '2')
    fireEvent.click(within(region).getByRole('switch', { name: 'Custom Keyword & BD Phone Blocklist' }))

    expect(region.dataset.dirty).toBe('true')
    expect(within(region).getByTestId('unsaved').textContent).toBe('Unsaved changes')
    expect(within(region).getByTestId('preview-struck').textContent).toBe('৳1,199')
    expect(within(region).getByTestId('preview-price').textContent).toBe('৳599')
    expect(within(region).getByTestId('preview-badge').textContent).toBe('50% Eid Offer')
    expect(within(region).getByText('13/40')).toBeTruthy()

    fireEvent.click(saveButton(region))

    await waitFor(() => expect(calls('PATCH')).toHaveLength(1))
    const [url, init] = calls('PATCH')[0] ?? ['']
    expect(url).toBe(`${PLANS}/${starter.id}`)
    expect(JSON.parse(String(init?.body))).toEqual({
      originalPriceBdt: 1199,
      offerPriceBdt: 599,
      offerBadge: '50% Eid Offer',
      featureConfig: { limits: { teamSeats: 2 }, features: { customBlocklist: true } },
    })

    expect(await screen.findByText('Starter saved.')).toBeTruthy()
    await waitFor(() => expect(region.dataset.dirty).toBeUndefined())
    expect(within(region).queryByTestId('unsaved')).toBeNull()
    expect(input(region, 'Original price').value).toBe('1199')
    expect(input(region, 'Offer price').value).toBe('599')
    expect(input(region, 'Offer badge').value).toBe('50% Eid Offer')
    expect(saveButton(region).disabled).toBe(true)
    // The list is refreshed after the save.
    await waitFor(() => expect(calls('GET', PLANS)).toHaveLength(2))
  })

  it('sends only one changed field and clears an offer with null', async () => {
    patchHandler = () => json({ plan: { ...starter, offerPriceBdt: null } })
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
    expect(input(region, 'Original price').value).toBe('2499')
    expect(within(region).getByRole('switch', { name: 'WhatsApp & Telegram Alerts' }).getAttribute('aria-checked')).toBe('true')
    expect(saveButton(region).disabled).toBe(true)
    expect(calls('PATCH')).toHaveLength(0)
  })

  it('an offer above the original shows an inline error and disables Save', async () => {
    renderSettings()
    const region = await card('Starter')
    type(input(region, 'Offer price'), '1000')
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

describe('/admin/settings price preview', () => {
  it('shows the seeded launch offers struck through with badge and saving', async () => {
    renderSettings()
    const expected = [
      ['Free', null, '৳0', null, null],
      ['Starter', '৳999', '৳499', '50% Launch Offer', 'Saves 50%'],
      ['Growth', '৳2,499', '৳1,499', '40% Off', 'Saves 40%'],
      ['Pro', '৳5,999', '৳3,999', '33% Off', 'Saves 33%'],
    ] as const
    for (const [name, struck, price, badge, saves] of expected) {
      const preview = within(await card(name)).getByTestId('price-preview')
      const struckEl = within(preview).queryByTestId('preview-struck')
      expect(struckEl?.textContent ?? null).toBe(struck)
      if (struckEl) expect(struckEl.tagName).toBe('S')
      expect(within(preview).getByTestId('preview-price').textContent).toBe(price)
      expect(within(preview).getByText('/mo')).toBeTruthy()
      const badgeEl = within(preview).queryByTestId('preview-badge')
      expect(badgeEl?.textContent ?? null).toBe(badge)
      if (badgeEl) expect(badgeEl.className).toContain('rounded-full')
      if (saves) expect(within(preview).getByText(saves)).toBeTruthy()
      else expect(within(preview).queryByText(/^Saves/)).toBeNull()
    }
  })
})

describe('/admin/settings change history', () => {
  function history() {
    return screen.findByRole('region', { name: 'Change history' })
  }
  function auditCalls() {
    return fetchMock.mock.calls
      .map(([input]) => new URL(input, 'http://admin.localhost'))
      .filter((url) => url.pathname === AUDIT)
      .map((url) => Object.fromEntries(url.searchParams))
  }

  it('lists who, when, the action and every field before → after', async () => {
    auditHandler = (url) =>
      json(
        auditPage(
          [
            auditEntry(2, {
              changes: [
                { field: 'originalPriceBdt', before: 999, after: 1199 },
                { field: 'offerPriceBdt', before: 499, after: null },
                { field: 'offerBadge', before: '50% Launch Offer', after: null },
                { field: 'featureConfig.limits.monthlyComments', before: 2500, after: 5000 },
                { field: 'featureConfig.features.customBlocklist', before: false, after: true },
              ],
            }),
            auditEntry(1, {
              plan: { id: seeded[3].id, slug: 'pro', name: 'Pro' },
              admin: { id: 'u2', name: 'Ops Admin', email: 'ops@shield.bd' },
              ip: null,
              userAgent: null,
              createdAt: '2026-11-17T18:30:00.000Z',
            }),
          ],
          url,
        ),
      )
    renderSettings()
    const panel = await history()
    const entries = await within(panel).findAllByTestId('audit-entry')
    expect(entries).toHaveLength(2)
    expect(auditCalls()).toEqual([{ skip: '0', take: '20' }])

    const [first, second] = entries as [HTMLElement, HTMLElement]
    expect(within(first).getByText('Updated')).toBeTruthy()
    expect(within(first).getByText('Starter')).toBeTruthy()
    expect(within(first).getByText('Root Admin')).toBeTruthy()
    expect(within(first).getByText('root@shield.bd')).toBeTruthy()
    // 06:00 UTC = 12:00 in Dhaka (UTC+6).
    const time = first.querySelector('time') as HTMLTimeElement
    expect(time.dateTime).toBe('2026-11-18T06:00:00.000Z')
    expect(time.textContent).toBe('18 Nov 2026, 12:00')

    const rows = within(first)
      .getAllByTestId('audit-change')
      .map((row) => [
        row.firstElementChild?.textContent,
        within(row).getByTestId('audit-before').textContent,
        within(row).getByTestId('audit-after').textContent,
      ])
    expect(rows).toEqual([
      ['Original price', '৳999', '৳1,199'],
      ['Offer price', '৳499', 'None'],
      ['Offer badge', '“50% Launch Offer”', 'None'],
      ['Monthly Comments Scanned', new Intl.NumberFormat('en-BD').format(2500), new Intl.NumberFormat('en-BD').format(5000)],
      ['Custom Keyword & BD Phone Blocklist', 'Off', 'On'],
    ])
    const clientInfo = within(first).getByTestId('audit-client')
    expect(clientInfo.textContent).toBe('IP 203.0.113.7 · Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0')
    expect(clientInfo.className).toContain('text-muted-foreground')

    expect(within(second).getByText('Pro')).toBeTruthy()
    expect(within(second).getByText('Ops Admin')).toBeTruthy()
    // 18:30 UTC on the 17th is already the 18th in Dhaka.
    expect(second.querySelector('time')?.textContent).toBe('18 Nov 2026, 00:30')
    expect(within(second).getByText('Team / Moderator Seats')).toBeTruthy()
    expect(within(second).queryByTestId('audit-client')).toBeNull()
    expect(within(panel).getByText('1–2 of 2 changes')).toBeTruthy()
  })

  it('pages through the history 20 at a time', async () => {
    auditHandler = (url) => {
      const skip = Number(url.searchParams.get('skip'))
      const items = Array.from({ length: Math.min(20, 45 - skip) }, (_, i) => auditEntry(skip + i))
      return json(auditPage(items, url, 45))
    }
    renderSettings()
    const panel = await history()
    expect(await within(panel).findAllByTestId('audit-entry')).toHaveLength(20)
    const nav = within(panel).getByRole('navigation', { name: 'Change history pages' })
    expect(within(nav).getByText('1–20 of 45 changes')).toBeTruthy()
    expect(within(nav).getByText('1 / 3')).toBeTruthy()
    expect(within(nav).getByRole('button', { name: 'Previous page' })).toHaveProperty('disabled', true)

    fireEvent.click(within(nav).getByRole('button', { name: 'Next page' }))
    expect(await within(panel).findByText('21–40 of 45 changes')).toBeTruthy()
    fireEvent.click(within(nav).getByRole('button', { name: 'Next page' }))
    expect(await within(panel).findByText('41–45 of 45 changes')).toBeTruthy()
    expect(within(panel).getAllByTestId('audit-entry')).toHaveLength(5)
    expect(within(nav).getByText('3 / 3')).toBeTruthy()
    expect(within(nav).getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true)

    fireEvent.click(within(nav).getByRole('button', { name: 'Previous page' }))
    expect(await within(panel).findByText('21–40 of 45 changes')).toBeTruthy()
    expect(auditCalls().map((q) => q.skip)).toEqual(['0', '20', '40'])
    // Page 2 came back from the cache: no 4th request.
    expect(auditCalls()).toHaveLength(3)
    expect(auditCalls().every((q) => q.take === '20' && q.planId === undefined)).toBe(true)
  })

  it('filters by plan and goes back to the first page', async () => {
    auditHandler = (url) => {
      const planId = url.searchParams.get('planId')
      if (planId === seeded[2].id) return json(auditPage([], url))
      if (planId === starter.id) return json(auditPage([auditEntry(7)], url))
      const skip = Number(url.searchParams.get('skip'))
      return json(auditPage(Array.from({ length: Math.min(20, 30 - skip) }, (_, i) => auditEntry(skip + i + 100)), url, 30))
    }
    renderSettings()
    const panel = await history()
    await within(panel).findByText('1–20 of 30 changes')
    const filter = within(panel).getByRole('group', { name: 'Filter by plan' })
    expect(within(filter).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All plans',
      'Free',
      'Starter',
      'Growth',
      'Pro',
    ])
    expect(within(filter).getByRole('button', { name: 'All plans' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(within(panel).getByRole('button', { name: 'Next page' }))
    await within(panel).findByText('21–30 of 30 changes')

    fireEvent.click(within(filter).getByRole('button', { name: 'Starter' }))
    expect(await within(panel).findByText('1–1 of 1 change')).toBeTruthy()
    expect(within(filter).getByRole('button', { name: 'Starter' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(filter).getByRole('button', { name: 'All plans' }).getAttribute('aria-pressed')).toBe('false')
    expect(auditCalls().at(-1)).toEqual({ skip: '0', take: '20', planId: starter.id })

    fireEvent.click(within(filter).getByRole('button', { name: 'Growth' }))
    expect(await within(panel).findByRole('heading', { name: 'No changes to Growth yet' })).toBeTruthy()
    expect(within(panel).queryByRole('navigation')).toBeNull()
    expect(auditCalls().at(-1)).toEqual({ skip: '0', take: '20', planId: seeded[2].id })
  })

  it('shows skeletons, then the empty state', async () => {
    let release: (res: Response) => void = () => {}
    auditHandler = () => new Promise<Response>((resolve) => (release = resolve))
    renderSettings()
    const panel = await history()
    expect(await within(panel).findAllByTestId('audit-skeleton')).toHaveLength(3)
    await act(async () => release(json({ items: [], total: 0, skip: 0, take: 20 })))
    expect(await within(panel).findByRole('heading', { name: 'No plan changes yet' })).toBeTruthy()
    expect(within(panel).queryAllByTestId('audit-skeleton')).toHaveLength(0)
    expect(within(panel).queryByRole('navigation')).toBeNull()
  })

  it('shows the error state and recovers with Try again', async () => {
    auditHandler = () => json({ statusCode: 500, message: 'Audit store unavailable' }, 500)
    renderSettings()
    const panel = await history()
    const alert = await within(panel).findByRole('alert')
    expect(within(alert).getByText("Couldn't load the change history")).toBeTruthy()
    expect(within(alert).getByText('Audit store unavailable')).toBeTruthy()
    // The plan editors still work.
    expect(await card('Pro')).toBeTruthy()

    auditHandler = (url) => json(auditPage([auditEntry(1)], url))
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await within(panel).findAllByTestId('audit-entry')).toHaveLength(1)
    expect(within(panel).queryByRole('alert')).toBeNull()
  })

  it('a save refetches the history so the new entry shows up', async () => {
    let saved = false
    patchHandler = () => {
      saved = true
      const growth = seeded[2]
      return json({ plan: { ...growth, featureConfig: { ...growth.featureConfig, limits: { ...growth.featureConfig.limits, teamSeats: 4 } } } })
    }
    auditHandler = (url) =>
      json(
        auditPage(
          saved
            ? [auditEntry(9, { id: 'new-entry', plan: { id: seeded[2].id, slug: 'growth', name: 'Growth' }, changes: [{ field: 'featureConfig.limits.teamSeats', before: 3, after: 4 }] })]
            : [],
          url,
        ),
      )
    renderSettings()
    const panel = await history()
    await within(panel).findByRole('heading', { name: 'No plan changes yet' })

    // Growth: toasts outlive a test and Starter saves elsewhere.
    const region = await card('Growth')
    type(input(region, 'Team / Moderator Seats'), '4')
    fireEvent.click(saveButton(region))
    expect(await screen.findByText('Growth saved.')).toBeTruthy()

    const entry = await within(panel).findByTestId('audit-entry')
    expect(within(entry).getByText('Team / Moderator Seats')).toBeTruthy()
    expect(within(entry).getByTestId('audit-before').textContent).toBe('3')
    expect(within(entry).getByTestId('audit-after').textContent).toBe('4')
    expect(auditCalls()).toHaveLength(2)
  })
})
