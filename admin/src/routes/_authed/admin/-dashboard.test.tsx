import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addDays, type DashboardStatsResponse } from '@/lib/admin-dashboard'
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

/** 12:00 in Dhaka on 18 Nov 2026. */
const NOW = new Date('2026-11-18T06:00:00.000Z')
const TODAY = '2026-11-18'

function days(from: string, count: number) {
  return Array.from({ length: count }, (_, i) => addDays(from, i))
}

/** What the API returns today: no clients, every placeholder 0 / []. */
function zeroFixture(): DashboardStatsResponse {
  const buckets = days('2026-10-20', 30)
  return {
    range: '30d',
    granularity: 'day',
    timezone: 'Asia/Dhaka',
    from: '2026-10-20',
    to: TODAY,
    kpis: { activeClients: 0, mrrBdt: 0, commentsScanned: 0, openTickets: 0 },
    series: {
      growth: buckets.map((bucket) => ({ bucket, newClients: 0, totalClients: 0, mrrBdt: 0 })),
      comments: buckets.map((bucket) => ({ bucket, scanned: 0, blocked: 0 })),
      planTiers: [],
      gateways: [],
    },
  }
}

/** Real client growth over 7 days; the other placeholders still 0 / []. */
function growthFixture(): DashboardStatsResponse {
  const buckets = days('2026-11-12', 7)
  const added = [0, 1, 0, 2, 0, 0, 1]
  let total = 9
  return {
    range: '7d',
    granularity: 'day',
    timezone: 'Asia/Dhaka',
    from: '2026-11-12',
    to: TODAY,
    kpis: { activeClients: 12, mrrBdt: 0, commentsScanned: 0, openTickets: 0 },
    series: {
      growth: buckets.map((bucket, i) => {
        total += added[i]!
        return { bucket, newClients: added[i]!, totalClients: total, mrrBdt: 0 }
      }),
      comments: buckets.map((bucket) => ({ bucket, scanned: 0, blocked: 0 })),
      planTiers: [],
      gateways: [],
    },
  }
}

/** Every series filled, as after M2-T7 / M2-T11 / Module 8. */
function fullFixture(): DashboardStatsResponse {
  const base = growthFixture()
  return {
    ...base,
    range: '12m',
    granularity: 'month',
    from: '2025-12-01',
    kpis: { activeClients: 12, mrrBdt: 1_234_567, commentsScanned: 48_210, openTickets: 3 },
    series: {
      growth: [
        { bucket: '2026-10', newClients: 4, totalClients: 9, mrrBdt: 900_000 },
        { bucket: '2026-11', newClients: 3, totalClients: 12, mrrBdt: 1_234_567 },
      ],
      comments: [
        { bucket: '2026-10', scanned: 20_000, blocked: 1_200 },
        { bucket: '2026-11', scanned: 28_210, blocked: 1_900 },
      ],
      planTiers: [
        { tier: 'Starter', clients: 6 },
        { tier: 'Growth', clients: 4 },
        { tier: 'Agency', clients: 2 },
      ],
      gateways: [
        { gateway: 'bKash', amountBdt: 600_000, transactions: 40 },
        { gateway: 'Nagad', amountBdt: 300_000, transactions: 22 },
      ],
    },
  }
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
let respond: (url: URL) => Response

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function apiError(status: number, message: string) {
  return json({ statusCode: status, error: 'Error', message, path: '/api', timestamp: '' }, status)
}

/** Query strings sent to GET /api/admin/dashboard/stats, oldest first. */
function statsCalls() {
  return fetchMock.mock.calls
    .map(([input]) => new URL(input, 'http://admin.localhost'))
    .filter((url) => url.pathname === '/api/admin/dashboard/stats')
    .map((url) => Object.fromEntries(url.searchParams))
}
const lastStatsCall = () => statsCalls().at(-1)

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
  return { router }
}

async function renderDashboard(path = '/admin/dashboard') {
  const result = renderAt(path)
  await screen.findByTestId('resolved-range')
  return result
}

const kpi = (label: string) => within(screen.getByRole('region', { name: label }))
const kpiValue = (key: string) => screen.getByTestId(`kpi-${key}`).querySelector('.sr-only')?.textContent
const tab = (name: string) => screen.getByRole('tab', { name })
const selectTab = (name: string) => fireEvent.mouseDown(tab(name), { button: 0 })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  auth.getSession.mockReset().mockResolvedValue(superAdmin)
  respond = () => json(zeroFixture())
  fetchMock.mockReset().mockImplementation(async (input) => {
    const url = new URL(input, 'http://admin.localhost')
    if (url.pathname !== '/api/admin/dashboard/stats') throw new Error(`unexpected fetch ${url.pathname}`)
    return respond(url)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('/admin/dashboard rendering', () => {
  it('renders the zero-filled response with intentional placeholders and empty states', async () => {
    await renderDashboard()
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeTruthy()
    expect(lastStatsCall()).toEqual({ range: '30d' })
    expect(screen.getByTestId('resolved-range').textContent).toBe('20 Oct – 18 Nov 2026 · Dhaka time')
    expect(screen.getByText('Daily')).toBeTruthy()

    // KPI cards: CountingNumber's accessible value + honest captions.
    expect(kpiValue('activeClients')).toBe('0')
    expect(kpiValue('mrrBdt')).toBe('0')
    expect(kpiValue('commentsScanned')).toBe('0')
    expect(kpiValue('openTickets')).toBe('0')
    expect(kpi('Monthly recurring revenue').getByText('৳')).toBeTruthy()
    expect(kpi('Monthly recurring revenue').getByText('No paid plans yet')).toBeTruthy()
    expect(kpi('Active clients').getByText('No new clients in this range')).toBeTruthy()
    expect(kpi('Open tickets').getByText('Support inbox is clear')).toBeTruthy()

    // Every chart keeps its slot and shows its empty state.
    expect(screen.getByText('No clients in this range yet')).toBeTruthy()
    expect(screen.getByText('No comments scanned yet')).toBeTruthy()
    expect(screen.getByText('No plans yet')).toBeTruthy()
    expect(screen.getByText('No payments yet')).toBeTruthy()
    expect(screen.getByTestId('growth-chart')).toBeTruthy()
    expect(screen.getByTestId('comments-chart')).toBeTruthy()
    expect(screen.queryByTestId('chart-skeleton')).toBeNull()
  })

  it('renders real client growth', async () => {
    respond = () => json(growthFixture())
    await renderDashboard('/admin/dashboard?range=7d')
    expect(lastStatsCall()).toEqual({ range: '7d' })
    expect(screen.getByTestId('resolved-range').textContent).toBe('12 Nov – 18 Nov 2026 · Dhaka time')
    expect(kpiValue('activeClients')).toBe('12')
    expect(kpi('Active clients').getByText('+4 new in this range')).toBeTruthy()
    expect(screen.queryByText('No clients in this range yet')).toBeNull()
    // Still placeholders until their data exists.
    expect(screen.getByText('No comments scanned yet')).toBeTruthy()
    expect(screen.getByText('No plans yet')).toBeTruthy()
    expect(screen.getByText('No payments yet')).toBeTruthy()
    expect(tab('Last 7 days').getAttribute('aria-selected')).toBe('true')
  })

  it('swaps real plan tiers, gateways, comments and MRR into the same slots', async () => {
    respond = () => json(fullFixture())
    await renderDashboard('/admin/dashboard?range=12m')
    expect(screen.getByText('Monthly')).toBeTruthy()
    expect(screen.getByTestId('resolved-range').textContent).toBe('1 Dec 2025 – 18 Nov 2026 · Dhaka time')
    expect(kpiValue('mrrBdt')).toBe('1,234,567')
    expect(kpiValue('commentsScanned')).toBe('48,210')
    expect(kpiValue('openTickets')).toBe('3')
    expect(kpi('Monthly recurring revenue').getByText('Current MRR in taka')).toBeTruthy()
    for (const empty of ['No comments scanned yet', 'No plans yet', 'No payments yet', 'No paid plans yet']) {
      expect(screen.queryByText(empty)).toBeNull()
    }
    const tiers = within(screen.getByRole('region', { name: 'Plan tiers' }))
    expect(tiers.getByText('Starter')).toBeTruthy()
    expect(tiers.getByText('50%')).toBeTruthy()
    expect(screen.getByTestId('gateways-chart')).toBeTruthy()
  })

  it('shows skeletons while the first response is loading', async () => {
    let release: (r: Response) => void = () => {}
    respond = () => new Promise<Response>((resolve) => (release = resolve)) as unknown as Response
    renderAt('/admin/dashboard')
    expect(await screen.findAllByTestId('chart-skeleton')).toHaveLength(4)
    release(json(zeroFixture()))
    await screen.findByTestId('resolved-range')
    expect(screen.queryByTestId('chart-skeleton')).toBeNull()
  })
})

describe('/admin/dashboard range picker', () => {
  it('maps presets to the URL (default left out) and the API params', async () => {
    const { router } = await renderDashboard()
    expect(tab('Last 30 days').getAttribute('aria-selected')).toBe('true')

    selectTab('Last 90 days')
    await waitFor(() => expect(router.state.location.search).toEqual({ range: '90d' }))
    await waitFor(() => expect(lastStatsCall()).toEqual({ range: '90d' }))

    selectTab('Last 12 months')
    await waitFor(() => expect(router.state.location.search).toEqual({ range: '12m' }))
    await waitFor(() => expect(lastStatsCall()).toEqual({ range: '12m' }))

    selectTab('Last 30 days')
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    expect(tab('Last 30 days').getAttribute('aria-selected')).toBe('true')
  })

  it('applies a custom from/to range', async () => {
    const { router } = await renderDashboard()
    selectTab('Custom')
    const form = within(screen.getByRole('form', { name: 'Custom date range' }))
    const from = form.getByLabelText('From') as HTMLInputElement
    const to = form.getByLabelText('To') as HTMLInputElement
    // Drafts start at the range on screen (last 30 Dhaka days); the max is today in Dhaka.
    expect(from.value).toBe('2026-10-20')
    expect(to.value).toBe(TODAY)
    expect(to.max).toBe(TODAY)
    const calls = statsCalls().length

    fireEvent.change(from, { target: { value: '2026-11-01' } })
    fireEvent.change(to, { target: { value: '2026-11-15' } })
    expect(statsCalls()).toHaveLength(calls) // nothing sent before Apply
    fireEvent.click(form.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(router.state.location.search).toEqual({ from: '2026-11-01', to: '2026-11-15' }),
    )
    await waitFor(() => expect(lastStatsCall()).toEqual({ from: '2026-11-01', to: '2026-11-15' }))
    expect(tab('Custom').getAttribute('aria-selected')).toBe('true')
  })

  it('seeds the custom drafts from the range on screen', async () => {
    respond = () => json({ ...zeroFixture(), range: '90d', from: '2026-08-21' })
    await renderDashboard('/admin/dashboard?range=90d')
    selectTab('Custom')
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-08-21')
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe(TODAY)
  })

  it('loads a custom range straight from the URL', async () => {
    await renderDashboard('/admin/dashboard?from=2026-11-01&to=2026-11-18')
    expect(lastStatsCall()).toEqual({ from: '2026-11-01', to: '2026-11-18' })
    expect(tab('Custom').getAttribute('aria-selected')).toBe('true')
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-11-01')
  })

  it('blocks an invalid custom range client-side', async () => {
    const { router } = await renderDashboard()
    selectTab('Custom')
    const form = within(screen.getByRole('form', { name: 'Custom date range' }))
    const apply = form.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    const calls = statsCalls().length

    fireEvent.change(form.getByLabelText('From'), { target: { value: '2026-11-18' } })
    fireEvent.change(form.getByLabelText('To'), { target: { value: '2026-11-01' } })
    expect(form.getByRole('alert').textContent).toMatch(/start date must be on or before/)
    expect(apply.disabled).toBe(true)
    fireEvent.submit(apply.closest('form')!)

    fireEvent.change(form.getByLabelText('From'), { target: { value: '2024-01-01' } })
    fireEvent.change(form.getByLabelText('To'), { target: { value: TODAY } })
    expect(form.getByRole('alert').textContent).toMatch(/at most 24 months/)
    expect(apply.disabled).toBe(true)
    fireEvent.submit(apply.closest('form')!)

    fireEvent.change(form.getByLabelText('From'), { target: { value: '2026-11-01' } })
    fireEvent.change(form.getByLabelText('To'), { target: { value: '2026-11-19' } })
    expect(form.getByRole('alert').textContent).toMatch(/future/)

    expect(router.state.location.search).toEqual({})
    expect(statsCalls()).toHaveLength(calls)
  })
})

describe('/admin/dashboard errors', () => {
  it('shows a 400 with the server message and resets to the default range', async () => {
    respond = (url) =>
      url.searchParams.has('from') ? apiError(400, 'to must not be after today (Asia/Dhaka)') : json(zeroFixture())
    const { router } = renderAt('/admin/dashboard?from=2026-11-01&to=2026-12-01')
    const heading = await screen.findByText('This date range can’t be shown')
    const alert = heading.closest<HTMLElement>('[role=alert]')!
    // The custom form (open, as the URL range is custom) flags the same problem.
    expect(within(screen.getByRole('form', { name: 'Custom date range' })).getByRole('alert').textContent).toMatch(
      /future/,
    )
    expect(within(alert).getByText('to must not be after today (Asia/Dhaka)')).toBeTruthy()

    fireEvent.click(within(alert).getByRole('button', { name: 'Show last 30 days' }))
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    await screen.findByTestId('resolved-range')
    expect(lastStatsCall()).toEqual({ range: '30d' })
  })

  it('shows a 500 with Retry, then recovers', async () => {
    let fail = true
    respond = () => (fail ? apiError(500, 'Internal server error') : json(growthFixture()))
    renderAt('/admin/dashboard')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Couldn’t load the dashboard')).toBeTruthy()
    expect(within(alert).queryByRole('button', { name: 'Show last 30 days' })).toBeNull()

    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByTestId('resolved-range')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(kpiValue('activeClients')).toBe('12')
  })
})
