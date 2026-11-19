import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminPromotion } from '@/lib/admin-promotions'
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

// 20 Nov 2026, 10:00 in Dhaka.
const NOW = new Date('2026-11-20T04:00:00.000Z')
const starter = { id: '0199a000-0000-7000-8000-0000000000b2', slug: 'starter', name: 'Starter' }
const growth = { id: '0199a000-0000-7000-8000-0000000000b3', slug: 'growth', name: 'Growth' }
const pro = { id: '0199a000-0000-7000-8000-0000000000b4', slug: 'pro', name: 'Pro' }
const plans = { items: [starter, growth, pro].map((p) => ({ ...p, isActive: true })) }

const base: AdminPromotion = {
  id: 'p0',
  kind: 'DISCOUNT',
  name: '',
  code: null,
  allPlans: false,
  plans: [],
  endsAt: null,
  endsOn: null,
  maxRedemptions: null,
  redemptionCount: 0,
  status: 'LIVE',
  termsLocked: false,
  stoppedAt: null,
  trialDays: null,
  trialCommentLimit: null,
  discountType: null,
  discountValue: null,
  discountScope: null,
  durationMonths: null,
  createdByAdmin: true,
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
}
const launch: AdminPromotion = {
  ...base,
  id: 'p-launch',
  name: 'Launch offer',
  plans: [starter],
  redemptionCount: 3,
  termsLocked: true,
  discountType: 'FLAT',
  discountValue: 500,
  discountScope: 'PER_MONTH',
  createdByAdmin: false,
}
const eid: AdminPromotion = {
  ...base,
  id: 'p-eid',
  kind: 'COUPON',
  name: 'Eid offer',
  code: 'EID25',
  allPlans: true,
  endsAt: '2026-12-01T17:59:59.999Z',
  endsOn: '2026-12-01',
  maxRedemptions: 10,
  redemptionCount: 3,
  discountType: 'PERCENT',
  discountValue: 25,
  discountScope: 'TOTAL',
}
const trial: AdminPromotion = {
  ...base,
  id: 'p-trial',
  kind: 'TRIAL',
  name: 'Starter 7-day trial',
  plans: [starter],
  status: 'STOPPED',
  stoppedAt: '2026-11-19T10:00:00.000Z',
  trialDays: 7,
  trialCommentLimit: 300,
}
const spring: AdminPromotion = {
  ...base,
  id: 'p-spring',
  name: 'Spring sale',
  plans: [growth, pro],
  endsAt: '2026-11-01T17:59:59.999Z',
  endsOn: '2026-11-01',
  status: 'ENDED',
  discountType: 'PERCENT',
  discountValue: 10,
  discountScope: 'PER_MONTH',
  durationMonths: 3,
}
const tenDay: AdminPromotion = {
  ...base,
  id: 'p-ten',
  kind: 'TRIAL',
  name: 'Ten-day trial',
  allPlans: true,
  maxRedemptions: 5,
  redemptionCount: 5,
  status: 'USED_UP',
  termsLocked: true,
  trialDays: 10,
}
const all = [launch, eid, trial, spring, tenDay]

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
let handlers: Record<string, Handler>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function apiError(status: number, code: string, message = 'Rejected', details?: Record<string, unknown>) {
  return json({ statusCode: status, message, code, details, path: '/api', timestamp: '' }, status)
}

function calls(method: string, path: string) {
  return fetchMock.mock.calls
    .map(([input, init]) => ({ url: new URL(input, 'http://admin.localhost'), init: init ?? {} }))
    .filter(({ url, init }) => (init.method ?? 'GET') === method && url.pathname === path)
}
const bodyOf = (method: string, path: string) => {
  const call = calls(method, path).at(-1)
  return call ? (JSON.parse(String(call.init.body)) as unknown) : undefined
}

function renderAt(path = '/admin/promotions') {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  auth.getSession.mockReset().mockResolvedValue(superAdmin)
  handlers = {
    'GET /api/admin/promotions': (url) => {
      const kind = url.searchParams.get('kind')
      const status = url.searchParams.get('status')
      return json({ items: all.filter((p) => (!kind || p.kind === kind) && (!status || p.status === status)) })
    },
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function renderList(path?: string) {
  const result = renderAt(path)
  await screen.findByText('Launch offer')
  return result
}
const row = (name: string) => {
  const tr = screen.getByText(name).closest('tr')
  if (!tr) throw new Error(`no row for ${name}`)
  return within(tr)
}
const cells = (name: string) =>
  Array.from(screen.getByText(name).closest('tr')?.querySelectorAll('td') ?? []).map((td) => td.textContent)

async function openNew() {
  await renderList()
  fireEvent.click(screen.getByRole('button', { name: 'New promotion' }))
  return screen.findByRole('dialog', { name: 'New promotion' })
}
async function openEdit(name: string) {
  await renderList()
  fireEvent.click(screen.getByRole('button', { name: `Edit ${name}` }))
  return screen.findByRole('dialog', { name: `Edit ${name}` })
}
const radio = (dialog: HTMLElement, name: string | RegExp) => within(dialog).getByRole('radio', { name })
const type = (dialog: HTMLElement, label: string | RegExp, value: string) =>
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })
const submit = (dialog: HTMLElement, name = /Create promotion|Save changes|Saving/) =>
  fireEvent.click(within(dialog).getByRole('button', { name }))

describe('/admin/promotions table', () => {
  it('lists every promotion with kind, name + code, plans, value, ends, used and status', async () => {
    await renderList()
    expect(screen.getByRole('heading', { level: 1, name: 'Promotions' })).toBeTruthy()
    expect(calls('GET', '/api/admin/promotions').at(-1)?.url.search).toBe('')

    expect(cells('Launch offer')).toEqual([
      'Discount',
      'Launch offer',
      'Starter',
      '৳500 offeach month · forever',
      'Until stopped',
      '3 used',
      'Live',
      'ClaimsEditStop',
    ])
    expect(cells('Eid offer')).toEqual([
      'Coupon',
      'Eid offerEID25',
      'All plans',
      '25% offtotal bill',
      '1 Dec 2026',
      '3 / 10 used',
      'Live',
      'ClaimsEditStop',
    ])
    expect(cells('Starter 7-day trial').slice(0, 7)).toEqual([
      'Trial',
      'Starter 7-day trial',
      'Starter',
      '7 days300 comments',
      'Until stopped',
      '0 used',
      'Stopped',
    ])
    expect(cells('Spring sale').slice(2, 7)).toEqual([
      'Growth, Pro',
      '10% offeach month · 3 months',
      '1 Nov 2026',
      '0 used',
      'Ended',
    ])
    expect(cells('Ten-day trial').slice(3, 7)).toEqual([
      "10 daysplan's monthly comments",
      'Until stopped',
      '5 / 5 used',
      'Used up',
    ])
    // A stopped promotion can't be stopped again.
    expect(row('Starter 7-day trial').queryByRole('button', { name: /^Stop/ })).toBeNull()
    expect(row('Spring sale').getByRole('button', { name: 'Stop Spring sale' })).toBeTruthy()
  })

  it('filters by kind and status through the URL and the query key', async () => {
    const { router } = await renderList()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Coupon' }), { button: 0 })
    await waitFor(() => expect(screen.queryByText('Launch offer')).toBeNull())
    expect(screen.getByText('Eid offer')).toBeTruthy()
    expect(router.state.location.search).toEqual({ kind: 'COUPON' })
    expect(calls('GET', '/api/admin/promotions').at(-1)?.url.searchParams.get('kind')).toBe('COUPON')

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Ended' }), { button: 0 })
    expect(await screen.findByText('No promotions match these filters')).toBeTruthy()
    const last = calls('GET', '/api/admin/promotions').at(-1)?.url.searchParams
    expect([last?.get('kind'), last?.get('status')]).toEqual(['COUPON', 'ENDED'])

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByText('Launch offer')).toBeTruthy()
    expect(router.state.location.search).toEqual({})
  })

  it('shows the empty state without promotions', async () => {
    handlers['GET /api/admin/promotions'] = () => json({ items: [] })
    renderAt()
    expect(await screen.findByText('No promotions yet')).toBeTruthy()
  })
})

describe('New promotion dialog', () => {
  beforeEach(() => {
    handlers['POST /api/admin/promotions'] = (_url, init) =>
      json({ promotion: { ...base, ...(JSON.parse(String(init.body)) as object), id: 'new' } }, 201)
  })

  it('creates a DISCOUNT for chosen plans, 3 months, with an end date and a cap', async () => {
    const dialog = await openNew()
    expect(radio(dialog, 'Discount').getAttribute('aria-checked')).toBe('true')
    type(dialog, 'Name', '  Winter sale ')
    fireEvent.click(radio(dialog, '৳ off'))
    type(dialog, 'Taka off (৳)', '200')
    fireEvent.click(radio(dialog, 'First months'))
    type(dialog, 'Months', '3')
    fireEvent.click(within(dialog).getByRole('switch', { name: 'All plans' }))
    await within(dialog).findByRole('checkbox', { name: 'Growth' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Growth' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Pro' }))
    fireEvent.click(radio(dialog, 'End date'))
    expect((within(dialog).getByLabelText('Last day') as HTMLInputElement).min).toBe('2026-11-20')
    type(dialog, 'Last day', '2026-12-31')
    type(dialog, /First N clients/, '50')
    submit(dialog)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(bodyOf('POST', '/api/admin/promotions')).toEqual({
      kind: 'DISCOUNT',
      name: 'Winter sale',
      allPlans: false,
      planIds: [growth.id, pro.id],
      endsOn: '2026-12-31',
      maxRedemptions: 50,
      discountType: 'FLAT',
      discountValue: 200,
      discountScope: 'PER_MONTH',
      durationMonths: 3,
    })
    expect(await screen.findByText('Winter sale is created.')).toBeTruthy()
    // The list is refetched.
    await waitFor(() => expect(calls('GET', '/api/admin/promotions').length).toBeGreaterThan(1))
  })

  it('creates a COUPON on all plans: code uppercased, months hidden for Total bill', async () => {
    const dialog = await openNew()
    fireEvent.click(radio(dialog, 'Coupon'))
    type(dialog, 'Name', 'Eid 2027')
    type(dialog, 'Coupon code', ' eid-27 ')
    type(dialog, 'Percent off', '15')
    fireEvent.click(radio(dialog, 'First months'))
    fireEvent.click(radio(dialog, 'Total bill'))
    expect(within(dialog).queryByRole('radio', { name: 'Forever' })).toBeNull()
    expect(within(dialog).queryByLabelText('Months')).toBeNull()
    submit(dialog)

    await waitFor(() => expect(bodyOf('POST', '/api/admin/promotions')).toBeDefined())
    expect(bodyOf('POST', '/api/admin/promotions')).toEqual({
      kind: 'COUPON',
      name: 'Eid 2027',
      code: 'EID-27',
      allPlans: true,
      discountType: 'PERCENT',
      discountValue: 15,
      discountScope: 'TOTAL',
    })
  })

  it('creates a TRIAL from the length pills (empty comment limit = the plan’s)', async () => {
    const dialog = await openNew()
    fireEvent.click(radio(dialog, 'Trial'))
    expect(within(dialog).queryByLabelText('Coupon code')).toBeNull()
    expect(within(dialog).getAllByRole('radio', { name: /days$/ }).map((r) => r.textContent)).toEqual([
      '3 days',
      '7 days',
      '14 days',
      '30 days',
    ])
    expect(radio(dialog, '7 days').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(radio(dialog, '14 days'))
    type(dialog, 'Name', '14-day trial')
    submit(dialog)

    await waitFor(() => expect(bodyOf('POST', '/api/admin/promotions')).toBeDefined())
    expect(bodyOf('POST', '/api/admin/promotions')).toEqual({ kind: 'TRIAL', name: '14-day trial', allPlans: true, trialDays: 14 })
  })

  it('checks the fields inline and sends nothing while they are invalid', async () => {
    const dialog = await openNew()
    fireEvent.click(radio(dialog, 'Coupon'))
    type(dialog, 'Coupon code', 'ab')
    type(dialog, 'Percent off', '150')
    fireEvent.click(radio(dialog, 'First months'))
    fireEvent.click(within(dialog).getByRole('switch', { name: 'All plans' }))
    fireEvent.click(radio(dialog, 'End date'))
    type(dialog, 'Last day', '2026-11-19')
    type(dialog, /First N clients/, '0')
    submit(dialog)

    expect(within(dialog).getByText('Enter a name.')).toBeTruthy()
    expect(within(dialog).getByText('Use 3–32 letters, digits or dashes.')).toBeTruthy()
    expect(within(dialog).getByText('Enter a percentage from 1 to 100.')).toBeTruthy()
    expect(within(dialog).getByText('Enter 1 to 120 months.')).toBeTruthy()
    expect(within(dialog).getByText('Pick at least one plan, or All plans.')).toBeTruthy()
    expect(within(dialog).getByText('Pick today or a later day.')).toBeTruthy()
    expect(within(dialog).getByText(/^Enter 1 to [\d,]+, or leave it empty\.$/)).toBeTruthy()

    fireEvent.click(radio(dialog, '৳ off'))
    type(dialog, 'Taka off (৳)', '0')
    expect(within(dialog).getByText(/^Enter ৳1 to ৳[\d,]+\.$/)).toBeTruthy()
    expect(calls('POST', '/api/admin/promotions')).toHaveLength(0)
  })

  it.each([
    [409, 'PROMOTION_CODE_TAKEN', 'Coupon code', 'Another promotion already uses this code.'],
    [400, 'PROMOTION_ENDS_IN_PAST', 'Last day', /The end date has passed/],
    [400, 'PLAN_NOT_AVAILABLE', null, 'A chosen plan is no longer active. Pick the plans again.'],
    [400, 'PROMOTION_INVALID_TERMS', null, "These terms don't fit the promotion: planIds must name at least one plan (or set allPlans)"],
  ] as const)('maps a %i %s to a readable message', async (status, code, field, text) => {
    handlers['POST /api/admin/promotions'] = () =>
      apiError(status, code, 'planIds must name at least one plan (or set allPlans)')
    const dialog = await openNew()
    fireEvent.click(radio(dialog, 'Coupon'))
    type(dialog, 'Name', 'Eid')
    type(dialog, 'Coupon code', 'EID')
    type(dialog, 'Percent off', '10')
    fireEvent.click(radio(dialog, 'End date'))
    submit(dialog)

    const message = await within(dialog).findByText(text)
    if (field) {
      const input = within(dialog).getByLabelText(field)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.getAttribute('aria-describedby')).toBe(message.id)
    }
    expect(screen.getByRole('dialog', { name: 'New promotion' })).toBeTruthy()
  })
})

describe('Edit promotion dialog', () => {
  beforeEach(() => {
    handlers['PATCH /api/admin/promotions/p-spring'] = () => json({ promotion: spring })
    handlers['PATCH /api/admin/promotions/p-launch'] = () => json({ promotion: launch })
  })

  it('starts from the stored values and PATCHes only the changed fields', async () => {
    const dialog = await openEdit('Spring sale')
    expect(within(dialog).queryByRole('radio', { name: 'Trial' })).toBeNull() // kind is fixed
    expect((within(dialog).getByLabelText('Months') as HTMLInputElement).value).toBe('3')
    expect((within(dialog).getByRole('checkbox', { name: 'Growth' }) as HTMLInputElement).checked).toBe(true)
    const save = within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement
    expect(save.disabled).toBe(true) // nothing changed yet

    type(dialog, 'Name', 'Spring sale 2027')
    type(dialog, 'Months', '6')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Pro' }))
    fireEvent.click(radio(dialog, 'Until stopped'))
    submit(dialog)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(bodyOf('PATCH', '/api/admin/promotions/p-spring')).toEqual({
      name: 'Spring sale 2027',
      endsOn: null,
      planIds: [growth.id],
      durationMonths: 6,
    })
  })

  it('shows locked money terms read-only and still saves the cap', async () => {
    const dialog = await openEdit('Launch offer')
    expect(within(dialog).getByTestId('locked-terms').textContent).toContain('৳500 off · each month · forever')
    expect(within(dialog).queryByLabelText('Taka off (৳)')).toBeNull()
    expect(within(dialog).queryByRole('radio', { name: 'Total bill' })).toBeNull()
    type(dialog, /First N clients/, '100')
    submit(dialog)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(bodyOf('PATCH', '/api/admin/promotions/p-launch')).toEqual({ maxRedemptions: 100 })
  })

  it('names the locked fields on a 409 PROMOTION_TERMS_LOCKED', async () => {
    handlers['PATCH /api/admin/promotions/p-spring'] = () =>
      apiError(409, 'PROMOTION_TERMS_LOCKED', 'Locked', { fields: ['discountValue', 'durationMonths'] })
    // Spring sale has already ended: its unchanged past end date doesn't block saving.
    const dialog = await openEdit('Spring sale')
    type(dialog, 'Percent off', '20')
    submit(dialog)
    expect(
      await within(dialog).findByText(
        'Clients have already claimed this promotion, so its money terms are locked (discount value, months).',
      ),
    ).toBeTruthy()
  })

  it('offers the stored trial length when it is not a preset', async () => {
    const dialog = await openEdit('Ten-day trial')
    // termsLocked: read-only summary instead of the pills.
    expect(within(dialog).getByTestId('locked-terms').textContent).toContain("10 days · plan's monthly comments")
    cleanup()
    handlers['GET /api/admin/promotions'] = () => json({ items: [{ ...tenDay, termsLocked: false }, launch] })
    const unlocked = await openEdit('Ten-day trial')
    expect(radio(unlocked, '10 days').getAttribute('aria-checked')).toBe('true')
    expect(within(unlocked).getAllByRole('radio', { name: /days$/ })).toHaveLength(5)
  })
})

describe('Stop and claims', () => {
  it('asks before stopping, POSTs /stop and refreshes the list', async () => {
    const stop = vi.fn(() => json({ promotion: { ...spring, status: 'STOPPED', stoppedAt: NOW.toISOString() } }))
    handlers['POST /api/admin/promotions/p-spring/stop'] = stop
    await renderList()
    const before = calls('GET', '/api/admin/promotions').length
    fireEvent.click(screen.getByRole('button', { name: 'Stop Spring sale' }))
    const dialog = await screen.findByRole('dialog', { name: 'Stop Spring sale?' })
    expect(within(dialog).getByText(/Clients who already claimed it keep what they got/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(stop).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Stop Spring sale' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop promotion' }))
    expect(await screen.findByText('Spring sale is stopped.')).toBeTruthy()
    expect(stop).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(calls('GET', '/api/admin/promotions').length).toBeGreaterThan(before))
  })

  it('lists the claims of a promotion', async () => {
    handlers['GET /api/admin/promotions/p-launch/redemptions'] = () =>
      json({
        items: [
          {
            id: 'r1',
            redeemedAt: '2026-11-18T19:00:00.000Z', // 19 Nov in Dhaka
            billingAccountId: 'a1',
            client: { id: 'u2', name: 'Rahim Uddin', email: 'rahim@acme.bd' },
            workspace: { id: 'w1', name: 'Acme Fashion' },
            plan: starter,
            discountBdtFirstTerm: 500,
            monthsUsed: 2,
          },
        ],
      })
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Claims: Launch offer' }))
    const sheet = await screen.findByRole('dialog', { name: 'Claims · Launch offer' })
    const item = within(await within(sheet).findByRole('list', { name: 'Claims' })).getByRole('listitem')
    expect(item.textContent).toContain('Rahim Uddin')
    expect(item.textContent).toContain('rahim@acme.bd')
    expect(item.textContent).toContain('Acme Fashion · Starter')
    expect(item.textContent).toContain('19 Nov 2026')
    expect(item.textContent).toContain('Saved ৳500 on the first bill · 2 months used')
  })

  it('shows an empty state without claims', async () => {
    handlers['GET /api/admin/promotions/p-spring/redemptions'] = () => json({ items: [] })
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Claims: Spring sale' }))
    const sheet = await screen.findByRole('dialog', { name: 'Claims · Spring sale' })
    expect(await within(sheet).findByText('No client has claimed this promotion yet.')).toBeTruthy()
  })
})
