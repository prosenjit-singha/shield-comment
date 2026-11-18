import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminTransaction, TransactionList } from '@/lib/admin-billing'
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

/** Module 8 data in the final row shape (user decision 2026-11-18). */
const paid: AdminTransaction = {
  id: '0199b000-0000-7000-8000-000000000001',
  workspace: { id: 'w1', name: 'Acme Fashion' },
  plan: { id: 'p1', name: 'Growth' },
  amountBdt: 1499,
  gateway: 'bKash',
  status: 'PAID',
  tranId: 'SHC-20261118-7f3a9c',
  createdAt: '2026-11-17T20:30:00.000Z', // 18 Nov 2026, 02:30 in Dhaka
}
const failed: AdminTransaction = {
  id: '0199b000-0000-7000-8000-000000000002',
  workspace: { id: 'w2', name: 'Bazaar BD' },
  plan: { id: 'p2', name: 'Pro' },
  amountBdt: 3999,
  gateway: 'Visa',
  status: 'FAILED',
  tranId: 'SHC-20261001-01bb2e',
  createdAt: '2026-10-01T06:00:00.000Z',
}

type Handler = (url: URL) => Response | Promise<Response>
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
let handler: Handler

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** GET transaction calls so far, as parsed search params. */
function listCalls() {
  return fetchMock.mock.calls
    .map(([input, init]) => ({ url: new URL(input, 'http://admin.localhost'), method: init?.method ?? 'GET' }))
    .filter(({ url, method }) => method === 'GET' && url.pathname === '/api/admin/billing/transactions')
    .map(({ url }) => url.searchParams)
}

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
  handler = () => json(empty)
  fetchMock.mockReset().mockImplementation(async (input, init = {}) => {
    const url = new URL(input, 'http://admin.localhost')
    if ((init.method ?? 'GET') !== 'GET' || url.pathname !== '/api/admin/billing/transactions') {
      throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url.pathname}`)
    }
    return handler(url)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const columns = ['Date', 'Client', 'Plan', 'Amount', 'Gateway', 'Status', 'Transaction ID']

describe('/admin/billing', () => {
  it('asks for the first 20 transactions and shows "No payments yet" under the final columns', async () => {
    renderAt('/admin/billing')
    expect(await screen.findByRole('heading', { name: 'No payments yet' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Billing' })).toBeTruthy()

    const params = listCalls().at(-1)
    expect(params?.get('skip')).toBe('0')
    expect(params?.get('take')).toBe('20')
    expect([...(params?.keys() ?? [])].sort()).toEqual(['skip', 'take'])

    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(columns)
    expect(screen.queryAllByTestId('transaction-status')).toHaveLength(0)
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull()
  })

  it('maps ?page= to skip and drops a malformed page', async () => {
    handler = (url) => json({ ...empty, skip: Number(url.searchParams.get('skip')) })
    renderAt('/admin/billing?page=3')
    expect(await screen.findByRole('heading', { name: 'No payments on this page' })).toBeTruthy()
    expect(listCalls().at(-1)?.get('skip')).toBe('40')

    cleanup()
    fetchMock.mockClear()
    renderAt('/admin/billing?page=abc')
    expect(await screen.findByRole('heading', { name: 'No payments yet' })).toBeTruthy()
    expect(listCalls().at(-1)?.get('skip')).toBe('0')
  })

  it('renders the final row columns from a non-empty response', async () => {
    handler = () => json({ items: [paid, failed], total: 2, skip: 0, take: 20 })
    renderAt('/admin/billing')
    const cell = await screen.findByText('Acme Fashion')
    const row = within(cell.closest('tr')!)

    expect(row.getByText('18 Nov 2026')).toBeTruthy() // Dhaka date (UTC is still 17 Nov)
    expect(row.getByText('02:30')).toBeTruthy()
    expect(row.getByText('Growth')).toBeTruthy()
    expect(row.getByText(`৳${new Intl.NumberFormat('en-BD').format(1499)}`)).toBeTruthy()
    expect(row.getByText('bKash')).toBeTruthy()
    expect(row.getByText('SHC-20261118-7f3a9c')).toBeTruthy()
    const pill = row.getByTestId('transaction-status')
    expect(pill.textContent).toBe('Paid')
    expect(pill.className).toContain('rounded-full')

    const other = within(screen.getByText('Bazaar BD').closest('tr')!)
    expect(other.getByText('1 Oct 2026')).toBeTruthy()
    expect(other.getByText('Visa')).toBeTruthy()
    expect(other.getByTestId('transaction-status').textContent).toBe('Failed')

    expect(screen.queryByText('No payments yet')).toBeNull()
    expect(screen.getByText('1–2 of 2 payments')).toBeTruthy()
  })

  it('pages through transactions with ?page=', async () => {
    handler = (url) =>
      json({ items: [paid], total: 41, skip: Number(url.searchParams.get('skip')), take: 20 })
    const { router } = renderAt('/admin/billing')
    expect(await screen.findByText('1–1 of 41 payments')).toBeTruthy()
    expect(screen.getByText('1 / 3')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ page: 2 }))
    await waitFor(() => expect(listCalls().at(-1)?.get('skip')).toBe('20'))
    expect(await screen.findByText('2 / 3')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    await waitFor(() => expect(router.state.location.search).toEqual({}))
  })

  it('shows the error state and recovers with Try again', async () => {
    let fail = true
    handler = () =>
      fail
        ? json({ statusCode: 500, error: 'Internal Server Error', message: 'Database unavailable' }, 500)
        : json(empty)
    renderAt('/admin/billing')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText("Couldn't load transactions")).toBeTruthy()
    expect(within(alert).getByText('Database unavailable')).toBeTruthy()

    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'No payments yet' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
