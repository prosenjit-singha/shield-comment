import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AdminPaymentEventItem,
  AdminTransaction,
  AdminTransactionDetail,
  PaymentEventList,
  TransactionList,
} from '@/lib/admin-billing'
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

const empty: TransactionList = { items: [], total: 0, skip: 0, take: 20 }
const noEvents: PaymentEventList = { items: [], total: 0, skip: 0, take: 20 }

const paid: AdminTransaction = {
  id: '0199b000-0000-7000-8000-000000000001',
  workspace: { id: 'w1', name: 'Acme Fashion' },
  plan: { id: 'p1', name: 'Growth' },
  amountBdt: 1499,
  gateway: 'bKash',
  status: 'PAID',
  tranId: 'SC7f3a9cAbCdEf0123',
  createdAt: '2026-11-17T20:30:00.000Z', // 18 Nov 2026, 02:30 in Dhaka
  riskFlagged: true,
  invoiceNumber: 'SC-2026-00042',
}
const failed: AdminTransaction = {
  id: '0199b000-0000-7000-8000-000000000002',
  workspace: { id: 'w2', name: 'Bazaar BD' },
  plan: { id: 'p2', name: 'Pro' },
  amountBdt: 3999,
  gateway: 'SSLCommerz',
  status: 'FAILED',
  tranId: 'SC01bb2eXyZ9876543',
  createdAt: '2026-10-01T06:00:00.000Z',
  riskFlagged: false,
  invoiceNumber: null,
}

const detail: AdminTransactionDetail = {
  ...paid,
  kind: 'UPGRADE',
  interval: 'month',
  user: { id: 'u9', name: 'Rahim Uddin', email: 'rahim@acme.bd' },
  paidAt: '2026-11-17T20:31:00.000Z',
  term: { start: '2026-11-17T20:31:00.000Z', end: '2026-12-17T20:31:00.000Z' },
  valId: 'VAL-123456',
  bankTranId: 'BANK-987',
  cardType: 'BKASH-BKash',
  riskLevel: 1,
  listPriceBdt: 2499,
  promotions: [
    {
      type: 'DISCOUNT',
      name: 'Launch offer',
      code: null,
      label: '40% off',
      labelBn: '৪০% ছাড়',
      amountOffBdt: 1000,
      months: { from: 1, to: 3, of: 6 },
    },
    {
      type: 'COUPON',
      name: 'Eid coupon',
      code: 'EID100',
      label: '৳100 off',
      labelBn: '৳১০০ ছাড়',
      amountOffBdt: 100,
      months: null,
    },
  ],
  creditBdt: 0,
  events: [
    { id: 'e1', tranId: paid.tranId, source: 'IPN', outcome: 'PAID', receivedAt: '2026-11-17T20:31:00.000Z' },
    { id: 'e2', tranId: paid.tranId, source: 'SUCCESS', outcome: 'ALREADY_PAID', receivedAt: '2026-11-17T20:31:05.000Z' },
  ],
  refund: null,
}
const refunded: AdminTransactionDetail = {
  ...detail,
  status: 'REFUNDED',
  refund: { admin: { id: 'u1', name: 'Root Admin' }, reason: 'Charged twice', createdAt: '2026-11-19T04:00:00.000Z' },
}

const events: AdminPaymentEventItem[] = [
  {
    id: 'ev1',
    tranId: paid.tranId,
    source: 'IPN',
    outcome: 'PAID_DUPLICATE_CLAIM',
    receivedAt: '2026-11-18T04:00:00.000Z',
    transaction: { id: paid.id, workspace: paid.workspace },
  },
  {
    id: 'ev2',
    tranId: 'SCunknown12345',
    source: 'IPN',
    outcome: 'UNKNOWN_TRAN_ID',
    receivedAt: '2026-11-18T03:00:00.000Z',
    transaction: null,
  },
  {
    id: 'ev3',
    tranId: null,
    source: 'SUCCESS',
    outcome: 'ACTIVATION_FAILED',
    receivedAt: '2026-11-18T02:00:00.000Z',
    transaction: null,
  },
]

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
let handlers: Record<string, Handler>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function apiError(status: number, message: string, code?: string) {
  return json({ statusCode: status, message, ...(code ? { code } : {}) }, status)
}

function calls(method: string, pathname: string) {
  return fetchMock.mock.calls
    .map(([input, init]) => ({ url: new URL(input, 'http://admin.localhost'), method: init?.method ?? 'GET' }))
    .filter((c) => c.method === method && c.url.pathname === pathname)
    .map(({ url }) => url.searchParams)
}
const listCalls = () => calls('GET', '/api/admin/billing/transactions')
const eventCalls = () => calls('GET', '/api/admin/billing/events')
const detailCalls = () => calls('GET', `/api/admin/billing/transactions/${paid.id}`)

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
    'GET /api/admin/billing/transactions': () => json(empty),
    'GET /api/admin/billing/events': () => json(noEvents),
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

const columns = ['Date', 'Client', 'Plan', 'Amount', 'Gateway', 'Status', 'Invoice', 'Transaction ID']

describe('/admin/billing transactions', () => {
  it('asks for the first 20 transactions and shows "No payments yet" with no filters', async () => {
    renderAt('/admin/billing')
    expect(await screen.findByRole('heading', { name: 'No payments yet' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Billing' })).toBeTruthy()
    expect(listCalls().at(-1)?.toString()).toBe('skip=0&take=20')
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('shows skeleton rows while loading', async () => {
    handlers['GET /api/admin/billing/transactions'] = () => new Promise<Response>(() => {})
    renderAt('/admin/billing')
    await waitFor(() => expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0))
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(columns)
  })

  it('maps ?page= to skip and drops a malformed page', async () => {
    handlers['GET /api/admin/billing/transactions'] = (url) => json({ ...empty, skip: Number(url.searchParams.get('skip')) })
    renderAt('/admin/billing?page=3')
    expect(await screen.findByRole('heading', { name: 'No payments on this page' })).toBeTruthy()
    expect(listCalls().at(-1)?.get('skip')).toBe('40')

    cleanup()
    fetchMock.mockClear()
    renderAt('/admin/billing?page=abc')
    expect(await screen.findByRole('heading', { name: 'No payments yet' })).toBeTruthy()
    expect(listCalls().at(-1)?.get('skip')).toBe('0')
  })

  it('renders the rows with the risk flag and invoice number', async () => {
    handlers['GET /api/admin/billing/transactions'] = () => json({ items: [paid, failed], total: 2, skip: 0, take: 20 })
    renderAt('/admin/billing')
    const row = within((await screen.findByText('Acme Fashion')).closest('tr')!)
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(columns)

    expect(row.getByText('18 Nov 2026')).toBeTruthy() // Dhaka date (UTC is still 17 Nov)
    expect(row.getByText('02:30')).toBeTruthy()
    expect(row.getByText('Growth')).toBeTruthy()
    expect(row.getByText(`৳${new Intl.NumberFormat('en-BD').format(1499)}`)).toBeTruthy()
    expect(row.getByText('bKash')).toBeTruthy()
    expect(row.getByText('High risk')).toBeTruthy()
    expect(row.getByText('SC-2026-00042')).toBeTruthy()
    expect(row.getByTestId('transaction-status').textContent).toBe('Paid')

    const other = within(screen.getByText('Bazaar BD').closest('tr')!)
    expect(other.getByTestId('transaction-status').textContent).toBe('Failed')
    expect(other.queryByText('High risk')).toBeNull()
    expect(other.getByText('—')).toBeTruthy()
    expect(screen.getByText('1–2 of 2 payments')).toBeTruthy()
  })

  it('pages through transactions with ?page=', async () => {
    handlers['GET /api/admin/billing/transactions'] = (url) =>
      json({ items: [paid], total: 41, skip: Number(url.searchParams.get('skip')), take: 20 })
    const { router } = renderAt('/admin/billing')
    expect(await screen.findByText('1–1 of 41 payments')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ page: 2 }))
    await waitFor(() => expect(listCalls().at(-1)?.get('skip')).toBe('20'))
    expect(await screen.findByText('2 / 3')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    await waitFor(() => expect(router.state.location.search).toEqual({}))
  })

  it('shows the error state and recovers with Try again', async () => {
    let fail = true
    handlers['GET /api/admin/billing/transactions'] = () =>
      fail ? apiError(500, 'Database unavailable') : json(empty)
    renderAt('/admin/billing')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText("Couldn't load transactions")).toBeTruthy()
    expect(within(alert).getByText('Database unavailable')).toBeTruthy()

    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'No payments yet' })).toBeTruthy()
  })

  it('sends URL filters to the API (q as text) and keys the query on them', async () => {
    const { queryClient } = renderAt(
      '/admin/billing?status=PAID&gateway=bKash&q=123&from=2026-11-01&to=2026-11-18&page=2',
    )
    expect(await screen.findByRole('heading', { name: 'No payments match these filters' })).toBeTruthy()
    const params = listCalls().at(-1)!
    expect(Object.fromEntries(params)).toEqual({
      status: 'PAID',
      gateway: 'bKash',
      q: '123',
      from: '2026-11-01',
      to: '2026-11-18',
      skip: '20',
      take: '20',
    })
    const keys = queryClient.getQueryCache().findAll({ queryKey: ['admin', 'billing', 'transactions'] })
    expect(keys.map((q) => q.queryKey[3])).toContain(params.toString())
    expect(screen.getByRole('button', { name: 'Status: Paid' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Gateway: bKash' })).toBeTruthy()
  })

  it.each([
    '/admin/billing?status=BOGUS&page=0&tab=nope',
    `/admin/billing?from=2026-02-30&to=nope&q=%20&gateway=${'x'.repeat(41)}`,
  ])('drops malformed params: %s', async (path) => {
    const { router } = renderAt(path)
    expect(await screen.findByRole('heading', { name: 'No payments yet' })).toBeTruthy()
    expect(listCalls().map((p) => p.toString())).toEqual(['skip=0&take=20'])
    expect(router.state.location.search).toEqual({})
  })

  it('drops a "to" date before "from" (the API would answer 400)', async () => {
    renderAt('/admin/billing?from=2026-11-18&to=2026-11-01')
    await screen.findByRole('heading', { name: 'No payments match these filters' })
    expect(listCalls().at(-1)?.toString()).toBe('from=2026-11-18&skip=0&take=20')
  })

  it('writes filter changes to the URL, resets the page and clears them', async () => {
    const { router } = renderAt('/admin/billing?page=2')
    await waitFor(() => expect(listCalls().at(-1)?.get('skip')).toBe('20'))

    fireEvent.keyDown(screen.getByRole('button', { name: 'Status: All statuses' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Refunded' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ status: 'REFUNDED' }))
    await waitFor(() => expect(listCalls().at(-1)?.toString()).toBe('status=REFUNDED&skip=0&take=20'))

    fireEvent.keyDown(await screen.findByRole('button', { name: 'Gateway: All gateways' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'PROMOTION' }))
    await waitFor(() => expect(listCalls().at(-1)?.get('gateway')).toBe('PROMOTION'))

    fireEvent.change(screen.getByLabelText('Search transactions'), { target: { value: '  rahim ' } })
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'rahim' }))
    await waitFor(() => expect(listCalls().at(-1)?.get('q')).toBe('rahim'))

    fireEvent.change(screen.getByLabelText('Created from'), { target: { value: '2026-11-01' } })
    fireEvent.change(screen.getByLabelText('Created to'), { target: { value: '2026-11-18' } })
    await waitFor(() => expect(listCalls().at(-1)?.get('to')).toBe('2026-11-18'))
    expect(listCalls().at(-1)?.get('from')).toBe('2026-11-01')

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!)
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    await waitFor(() => expect(listCalls().at(-1)?.toString()).toBe('skip=0&take=20'))
  })
})

describe('/admin/billing transaction sheet', () => {
  beforeEach(() => {
    handlers['GET /api/admin/billing/transactions'] = () => json({ items: [paid], total: 1, skip: 0, take: 20 })
    handlers[`GET /api/admin/billing/transactions/${paid.id}`] = () => json(detail)
  })

  async function openSheet() {
    renderAt('/admin/billing')
    fireEvent.click(await screen.findByRole('button', { name: `Open transaction ${paid.tranId}` }))
    const sheet = await screen.findByRole('dialog', { name: /Acme Fashion/ })
    return within(sheet)
  }

  it('shows payer, plan, term, price lines, gateway ids, risk flag and events', async () => {
    const sheet = await openSheet()
    expect(sheet.getByText('Rahim Uddin')).toBeTruthy()
    expect(sheet.getByText('rahim@acme.bd')).toBeTruthy()
    expect(sheet.getByText('Growth · Monthly · Upgrade')).toBeTruthy()
    expect(sheet.getByText('18 Nov 2026 – 18 Dec 2026')).toBeTruthy()
    expect(sheet.getByText('৳2,499')).toBeTruthy()
    expect(sheet.getByText('Discount · 40% off')).toBeTruthy()
    expect(sheet.getByText('Launch offer · Months 1–3 of 6')).toBeTruthy()
    expect(sheet.getByText('−৳1,000')).toBeTruthy()
    expect(sheet.getByText('Coupon EID100 · ৳100 off')).toBeTruthy()
    expect(sheet.getByText('−৳100')).toBeTruthy()
    expect(sheet.queryByText('Upgrade credit')).toBeNull()
    expect(sheet.getAllByText('৳1,499').length).toBeGreaterThan(0)
    expect(sheet.getByText('BKASH-BKash')).toBeTruthy()
    expect(sheet.getByText('VAL-123456')).toBeTruthy()
    expect(sheet.getByText('BANK-987')).toBeTruthy()
    expect(sheet.getByText(/High risk \(SSLCommerz risk level 1\)/)).toBeTruthy()

    const list = within(sheet.getByRole('list', { name: 'Events' }))
    expect(list.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'PaidIPN18 Nov 2026, 02:31',
      'Already paidSuccess return18 Nov 2026, 02:31',
    ])
    expect(sheet.getByRole('button', { name: 'Mark refunded' })).toBeTruthy()
  })

  it('shows the refund audit and hides "Mark refunded" unless PAID', async () => {
    handlers[`GET /api/admin/billing/transactions/${paid.id}`] = () => json(refunded)
    const sheet = await openSheet()
    expect(sheet.getByText('Charged twice')).toBeTruthy()
    expect(sheet.getByText('19 Nov 2026, 10:00')).toBeTruthy()
    expect(sheet.queryByRole('button', { name: 'Mark refunded' })).toBeNull()
  })

  it('shows a 404 for a transaction that is gone', async () => {
    handlers[`GET /api/admin/billing/transactions/${paid.id}`] = () => apiError(404, 'Transaction not found')
    renderAt('/admin/billing')
    fireEvent.click(await screen.findByRole('button', { name: `Open transaction ${paid.tranId}` }))
    expect((await screen.findByRole('alert')).textContent).toMatch('This transaction no longer exists.')
  })

  it('validates the reason, posts it and refreshes the list and sheet', async () => {
    let current = detail
    const post = vi.fn((_url: URL, init: RequestInit) => {
      void init
      current = refunded
      return json(refunded)
    })
    handlers[`GET /api/admin/billing/transactions/${paid.id}`] = () => json(current)
    handlers[`POST /api/admin/billing/transactions/${paid.id}/refund`] = post
    const sheet = await openSheet()
    const lists = listCalls().length
    const details = detailCalls().length

    fireEvent.click(sheet.getByRole('button', { name: 'Mark refunded' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Mark ৳1,499 refunded?' }))
    expect(dialog.getByText(/SSLCommerz merchant panel/)).toBeTruthy()
    expect(dialog.getByText(/plan\s+is not changed/)).toBeTruthy()
    const confirm = dialog.getByRole('button', { name: 'Mark refunded' }) as HTMLButtonElement
    const reason = dialog.getByLabelText('Reason')
    expect(confirm.disabled).toBe(true)

    fireEvent.change(reason, { target: { value: '   ' } })
    fireEvent.blur(reason)
    expect(dialog.getByRole('alert').textContent).toBe('A reason is required.')
    fireEvent.change(reason, { target: { value: 'x'.repeat(501) } })
    expect(dialog.getByRole('alert').textContent).toMatch(/500 characters/)
    expect(confirm.disabled).toBe(true)

    fireEvent.change(reason, { target: { value: '  Charged twice  ' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(post.mock.calls[0]![1].body))).toEqual({ reason: 'Charged twice' })
    expect(await screen.findByText(`${paid.tranId} is marked refunded.`)).toBeTruthy()
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(lists))
    await waitFor(() => expect(detailCalls().length).toBeGreaterThan(details))
    expect(await screen.findByText('Charged twice')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark refunded' })).toBeNull()
  })

  it.each([
    [409, 'NOT_REFUNDABLE', 'Only a paid transaction can be marked refunded.'],
    [404, undefined, 'This transaction no longer exists.'],
    [400, undefined, 'The refund was rejected.'],
  ])('toasts a %i and refreshes', async (status, code, toastText) => {
    handlers[`POST /api/admin/billing/transactions/${paid.id}/refund`] = () =>
      apiError(status, 'Rejected by the API', code)
    const sheet = await openSheet()
    const lists = listCalls().length
    fireEvent.click(sheet.getByRole('button', { name: 'Mark refunded' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Mark ৳1,499 refunded?' }))
    fireEvent.change(dialog.getByLabelText('Reason'), { target: { value: 'Refunded' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Mark refunded' }))
    expect(await screen.findByText(toastText)).toBeTruthy()
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(lists))
  })
})

describe('/admin/billing failed IPNs', () => {
  it('switches tabs via ?tab=failed and lists failed events with labels and links', async () => {
    handlers['GET /api/admin/billing/events'] = () => json({ items: events, total: 3, skip: 0, take: 20 })
    handlers[`GET /api/admin/billing/transactions/${paid.id}`] = () => json(detail)
    const { router } = renderAt('/admin/billing?status=PAID&page=2')
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Failed IPNs' }), { button: 0 })
    await waitFor(() => expect(router.state.location.search).toEqual({ status: 'PAID', tab: 'failed' }))
    await waitFor(() => expect(eventCalls().at(-1)?.toString()).toBe('outcome=failed&skip=0&take=20'))

    const duplicate = within((await screen.findByText('Paid, promotion already claimed')).closest('tr')!)
    expect(duplicate.getByText('IPN')).toBeTruthy()
    expect(duplicate.getByText('PAID_DUPLICATE_CLAIM')).toBeTruthy()
    const unknown = within(screen.getByText('Unknown transaction ID').closest('tr')!)
    expect(unknown.getByText('SCunknown12345')).toBeTruthy()
    expect(unknown.getByText('Unknown transaction')).toBeTruthy()
    expect(unknown.queryByRole('button')).toBeNull()
    const activation = within(screen.getByText('Activation failed (retry)').closest('tr')!)
    expect(activation.getByText('No transaction ID')).toBeTruthy()
    expect(activation.getByText('Success return')).toBeTruthy()

    fireEvent.click(duplicate.getByRole('button', { name: `Open transaction ${paid.tranId}` }))
    expect(await screen.findByRole('dialog', { name: /Acme Fashion/ })).toBeTruthy()
  })

  it('pages the events and shows the empty and error states', async () => {
    handlers['GET /api/admin/billing/events'] = (url) =>
      json({ items: [events[0]], total: 25, skip: Number(url.searchParams.get('skip')), take: 20 })
    const { router } = renderAt('/admin/billing?tab=failed')
    expect(await screen.findByText('1–1 of 25 events')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'failed', page: 2 }))
    await waitFor(() => expect(eventCalls().at(-1)?.get('skip')).toBe('20'))
    expect(listCalls()).toHaveLength(0)

    cleanup()
    handlers['GET /api/admin/billing/events'] = () => json(noEvents)
    renderAt('/admin/billing?tab=failed')
    expect(await screen.findByRole('heading', { name: 'No failed IPNs' })).toBeTruthy()

    cleanup()
    handlers['GET /api/admin/billing/events'] = () => apiError(500, 'Database unavailable')
    renderAt('/admin/billing?tab=failed')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText("Couldn't load failed IPNs")).toBeTruthy()
  })
})
