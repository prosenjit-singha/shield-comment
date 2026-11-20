import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiAnalysis, AiCreditTopup, AiSpendSummary } from '@/lib/admin-ai'
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

// AI blocks (M5-T15e): handlers by `METHOD /path`; anything else fails the test in afterEach.
type AiHandler = (url: URL, init?: RequestInit) => Response | Promise<Response>
let ai: Record<string, AiHandler>
let unexpected: string[]

function summaryFixture(over: Partial<AiSpendSummary> = {}): AiSpendSummary {
  return {
    asOf: NOW.toISOString(),
    timezone: 'Asia/Dhaka',
    creditAddedUsd: 0,
    estimatedSpendUsd: 0,
    estimatedRemainingUsd: 0,
    unpricedCalls: 0,
    commentsAnalyzed: { total: 0, today: 0, last7Days: 0 },
    tokens: { input: 0, output: 0 },
    spendByModel: [],
    spendByDecision: (['NONE', 'HIDE', 'DELETE'] as const).map((decision) => ({
      decision,
      comments: 0,
      costUsd: 0,
      unpricedComments: 0,
    })),
    ...over,
  }
}

function analysis(over: Partial<AiAnalysis> = {}): AiAnalysis {
  return {
    id: 'c1',
    classifiedAt: '2026-11-18T05:30:00.000Z',
    workspace: { id: 'w1', name: 'Dhaka Fashion' },
    page: { id: 'p1', pageId: '1001', name: 'Dhaka Fashion Page' },
    platform: 'FACEBOOK',
    message: 'দাম কত?',
    category: 'SAFE_INQUIRY',
    confidence: 0.97,
    decision: 'NONE',
    actionState: null,
    status: 'VISIBLE',
    statusReason: null,
    provider: 'neon',
    model: 'gpt-oss-20b',
    inputTokens: 412,
    outputTokens: 96,
    latencyMs: 850,
    estimatedCostUsd: 0.000123,
    ...over,
  }
}

function topup(over: Partial<AiCreditTopup> = {}): AiCreditTopup {
  return {
    id: 't1',
    amountUsd: 25,
    toppedUpOn: '2026-11-15',
    note: 'Card 4242',
    createdAt: '2026-11-15T04:00:00.000Z',
    createdBy: { id: 'u1', name: 'Root Admin' },
    ...over,
  }
}

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
  unexpected = []
  ai = {
    'GET /api/admin/ai/summary': () => json(summaryFixture()),
    'GET /api/admin/ai/analyses': () => json({ items: [] }),
    'GET /api/admin/ai/credit-topups': () => json({ items: [] }),
  }
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const url = new URL(input, 'http://admin.localhost')
    if (url.pathname === '/api/admin/dashboard/stats') return respond(url)
    const key = `${init?.method ?? 'GET'} ${url.pathname}`
    const handler = ai[key]
    if (handler) return handler(url, init)
    unexpected.push(key)
    throw new Error(`unexpected fetch ${key}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  expect(unexpected).toEqual([])
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
    // All-zero comments keep the empty state.
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

  it('renders real daily comment counts (M5-T13) in the comments chart and the KPI', async () => {
    const scanned = [0, 120, 340, 0, 95, 410, 260]
    const blocked = [0, 8, 21, 0, 4, 37, 12]
    respond = () => {
      const stats = growthFixture()
      stats.kpis.commentsScanned = scanned.reduce((a, b) => a + b, 0)
      stats.series.comments = stats.series.comments.map((p, i) => ({ ...p, scanned: scanned[i]!, blocked: blocked[i]! }))
      return json(stats)
    }
    await renderDashboard('/admin/dashboard?range=7d')
    expect(kpiValue('commentsScanned')).toBe('1,225')
    expect(kpi('Comments scanned').getByText('In this range')).toBeTruthy()
    const chart = screen.getByTestId('comments-chart')
    expect(screen.queryByText('No comments scanned yet')).toBeNull()
    expect(chart.firstElementChild?.className ?? '').not.toContain('opacity-40')
    expect(chart.firstElementChild?.getAttribute('aria-hidden')).toBeNull()
    // Same slot and legend as the empty state: no layout change.
    const card = screen.getByRole('region', { name: 'Comments scanned vs. spam blocked' })
    expect(within(card).getByText('Scanned')).toBeTruthy()
    expect(within(card).getByText('Blocked')).toBeTruthy()
  })

  it('keeps the comments empty state and caption for an all-zero range', async () => {
    await renderDashboard()
    expect(kpiValue('commentsScanned')).toBe('0')
    expect(kpi('Comments scanned').getByText('None scanned in this range')).toBeTruthy()
    const chart = screen.getByTestId('comments-chart')
    expect(within(chart).getByText('No comments scanned yet')).toBeTruthy()
    expect(chart.firstElementChild?.className).toContain('opacity-40')
  })

  it('renders real plan tiers (M2-T12b) in API order while the other placeholders stay empty', async () => {
    respond = () => {
      const stats = zeroFixture()
      stats.kpis.activeClients = 10
      stats.series.planTiers = [
        { tier: 'Free', clients: 5 },
        { tier: 'Starter', clients: 3 },
        { tier: 'Growth', clients: 2 },
      ]
      return json(stats)
    }
    await renderDashboard()
    const tiers = within(screen.getByRole('region', { name: 'Plan tiers' }))
    expect(tiers.getByText('Active clients per plan right now.')).toBeTruthy()
    expect(tiers.queryByText('No plans yet')).toBeNull()
    expect(tiers.getByText('10')).toBeTruthy() // total in the hole
    expect(tiers.getByText('clients')).toBeTruthy()
    expect(tiers.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Free550%',
      'Starter330%',
      'Growth220%',
    ])
    // Plans don't fill the other placeholders.
    expect(screen.getByText('No comments scanned yet')).toBeTruthy()
    expect(screen.getByText('No payments yet')).toBeTruthy()
    expect(kpi('Monthly recurring revenue').getByText('No paid plans yet')).toBeTruthy()
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

  it.each([
    ['/admin/dashboard?range=bogus', '30d', {}, 'Last 30 days'],
    ['/admin/dashboard?range=30d&from=2026-11-01', '30d', {}, 'Last 30 days'],
    ['/admin/dashboard?range=7d&from=nope&to=2026-11-18', '7d', { range: '7d' }, 'Last 7 days'],
  ])('drops malformed params from %s instead of sending them', async (path, range, search, selected) => {
    const { router } = await renderDashboard(path)
    expect(statsCalls()).toEqual([{ range }])
    expect(router.state.location.search).toEqual(search)
    expect(tab(selected).getAttribute('aria-selected')).toBe('true')
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

describe('/admin/dashboard AI spend (M5-T15e)', () => {
  const aiSection = () => within(screen.getByRole('region', { name: 'AI spend' }))
  const card = (label: string) => within(screen.getByRole('region', { name: label }))
  const aiCalls = (method: string, path: string) =>
    fetchMock.mock.calls.filter(
      ([input, init]) => new URL(input, 'http://admin.localhost').pathname === path && (init?.method ?? 'GET') === method,
    )

  it('shows the spend cards, a negative remaining and the estimate note', async () => {
    ai['GET /api/admin/ai/summary'] = () =>
      json(
        summaryFixture({
          creditAddedUsd: 10,
          estimatedSpendUsd: 12.345678,
          estimatedRemainingUsd: -2.345678,
          unpricedCalls: 3,
          commentsAnalyzed: { total: 1234, today: 12, last7Days: 80 },
          tokens: { input: 1_500_000, output: 120_000 },
        }),
      )
    await renderDashboard()
    await screen.findByText('$12.35')
    expect(card('Credit added').getByText('$10.00')).toBeTruthy()
    expect(card('Estimated spend').getByText('1.5M in / 120k out tokens')).toBeTruthy()
    const remaining = card('Estimated remaining').getByText('-$2.35')
    expect(remaining.className).toContain('text-destructive')
    expect(card('Estimated remaining').getByText(/Spend is above the credit added/)).toBeTruthy()
    expect(card('Comments analyzed').getByText('12')).toBeTruthy()
    expect(card('Comments analyzed').getByText('today · 80 in 7 days · 1,234 total')).toBeTruthy()
    expect(
      aiSection().getByText(
        'Estimate from our token counts; exact balance: Neon Console → Billing. 3 calls on models without a price are not counted.',
      ),
    ).toBeTruthy()
  })

  it('leaves the unpriced line out when every call is priced', async () => {
    await renderDashboard()
    const note = await screen.findByText(/Estimate from our token counts/)
    expect(note.textContent).toBe('Estimate from our token counts; exact balance: Neon Console → Billing.')
    expect(card('Estimated remaining').getByText('Credit added − estimated spend')).toBeTruthy()
  })

  it('lists the recent analyses with pills, n/a cost and plain-text comments', async () => {
    const long = `<b>bold</b> ${'বিকাশে টাকা পাঠান '.repeat(8)}`
    ai['GET /api/admin/ai/analyses'] = (url) => {
      expect(url.searchParams.get('limit')).toBe('20')
      return json({
        items: [
          analysis(),
          analysis({
            id: 'c2',
            message: long,
            category: 'SCAM_PHISHING',
            confidence: 0.91,
            decision: 'HIDE',
            actionState: 'FAILED',
            status: 'FAILED',
            statusReason: 'token_invalid',
            page: null,
            model: 'mystery-model',
            inputTokens: null,
            outputTokens: null,
            latencyMs: null,
            estimatedCostUsd: null,
          }),
          analysis({ id: 'c3', decision: 'DELETE', category: 'ABUSIVE_TOXIC', status: 'DELETED', message: null }),
        ],
      })
    }
    await renderDashboard()
    const rows = await screen.findAllByTestId('analysis-row')
    expect(rows).toHaveLength(3)

    const first = within(rows[0]!)
    expect(first.getByText('18 Nov 2026, 11:30')).toBeTruthy()
    expect(first.getByText('Dhaka Fashion')).toBeTruthy()
    expect(first.getByText('Dhaka Fashion Page')).toBeTruthy()
    expect(first.getByText('দাম কত?')).toBeTruthy()
    expect(first.getByText('Allowed').className).toContain('rounded-full')
    expect(first.getByText('Safe inquiry')).toBeTruthy()
    expect(first.getByText('97%')).toBeTruthy()
    expect(first.getByText('0.4k in / 96 out')).toBeTruthy()
    expect(first.getByText('$0.000123')).toBeTruthy()
    expect(first.getByText('850 ms')).toBeTruthy()

    const second = within(rows[1]!)
    expect(second.getByText('Hidden')).toBeTruthy()
    expect(second.getByText('Action failed · Failed: token invalid')).toBeTruthy()
    expect(second.getByText('Disconnected Page')).toBeTruthy()
    expect(second.getAllByText('n/a')).toHaveLength(2) // tokens + cost
    // Untrusted text: never parsed as HTML, truncated with the full text on hover + expand.
    const text = second.getByTestId('comment-text')
    expect(rows[1]!.querySelector('b')).toBeNull()
    expect(text.textContent!.startsWith('<b>bold</b>')).toBe(true)
    expect(text.textContent!.endsWith('…')).toBe(true)
    expect(text.getAttribute('title')).toBe(long)
    fireEvent.click(second.getByRole('button', { name: 'Show full comment' }))
    expect(text.textContent).toBe(long)
    expect(second.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true')

    const third = within(rows[2]!)
    expect(third.getByText('Deleted').className).toContain('text-destructive')
    expect(third.getByText('No text')).toBeTruthy()
  })

  it('shows the empty states', async () => {
    await renderDashboard()
    expect(await screen.findByText('No comments analyzed yet.')).toBeTruthy()
    expect(await screen.findByText(/No top-ups yet/)).toBeTruthy()
  })

  it('keeps the rest of the dashboard when every AI endpoint fails', async () => {
    for (const key of Object.keys(ai)) ai[key] = () => apiError(500, 'Internal server error')
    await renderDashboard()
    expect(await screen.findByText('Couldn’t load AI spend')).toBeTruthy()
    expect(await screen.findByText('Couldn’t load the analyses')).toBeTruthy()
    expect(await screen.findByText('Couldn’t load the top-ups')).toBeTruthy()
    expect(kpiValue('activeClients')).toBe('0')
    expect(screen.getByTestId('growth-chart')).toBeTruthy()
    expect(screen.queryByText('Couldn’t load the dashboard')).toBeNull()

    ai['GET /api/admin/ai/summary'] = () => json(summaryFixture({ creditAddedUsd: 5 }))
    const alert = screen.getByText('Couldn’t load AI spend').closest<HTMLElement>('[role=alert]')!
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(within(await screen.findByRole('region', { name: 'Credit added' })).getByText('$5.00')).toBeTruthy()
  })

  it('keeps the AI blocks when the stats fail', async () => {
    respond = () => apiError(500, 'Internal server error')
    ai['GET /api/admin/ai/credit-topups'] = () => json({ items: [topup()] })
    renderAt('/admin/dashboard')
    expect(await screen.findByText('Couldn’t load the dashboard')).toBeTruthy()
    expect(await screen.findByTestId('topup-row')).toBeTruthy()
  })

  it('adds a top-up, then refetches the list and the summary', async () => {
    let topups: AiCreditTopup[] = []
    ai['GET /api/admin/ai/credit-topups'] = () => json({ items: topups })
    ai['POST /api/admin/ai/credit-topups'] = (_url, init) => {
      const body = JSON.parse(init!.body as string) as { amountUsd: number; toppedUpOn: string; note?: string }
      topups = [topup({ id: 't9', ...body, note: body.note ?? null })]
      return json({ topup: topups[0] }, 201)
    }
    await renderDashboard()
    await screen.findByText(/No top-ups yet/)
    const summaryBefore = aiCalls('GET', '/api/admin/ai/summary').length

    fireEvent.click(screen.getByRole('button', { name: 'Add top-up' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect((dialog.getByLabelText('Top-up date') as HTMLInputElement).value).toBe(TODAY)
    expect((dialog.getByLabelText('Top-up date') as HTMLInputElement).max).toBe(TODAY)
    fireEvent.change(dialog.getByLabelText('Amount (USD)'), { target: { value: '12.50' } })
    fireEvent.change(dialog.getByLabelText('Top-up date'), { target: { value: '2026-11-16' } })
    fireEvent.change(dialog.getByLabelText('Note (optional)'), { target: { value: '  Card 4242  ' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add top-up' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const init = aiCalls('POST', '/api/admin/ai/credit-topups')[0]?.[1]
    expect(JSON.parse(init!.body as string)).toEqual({ amountUsd: 12.5, toppedUpOn: '2026-11-16', note: 'Card 4242' })
    const row = within(await screen.findByTestId('topup-row'))
    expect(row.getByText('16 Nov 2026')).toBeTruthy()
    expect(row.getByText('$12.50')).toBeTruthy()
    expect(row.getByText('Card 4242')).toBeTruthy()
    expect(row.getByText('Root Admin')).toBeTruthy()
    await waitFor(() => expect(aiCalls('GET', '/api/admin/ai/summary').length).toBeGreaterThan(summaryBefore))
  })

  it('blocks invalid top-ups client-side', async () => {
    await renderDashboard()
    fireEvent.click(await screen.findByRole('button', { name: 'Add top-up' }))
    const dialog = within(await screen.findByRole('dialog'))
    const submit = () => fireEvent.click(dialog.getByRole('button', { name: 'Add top-up' }))

    submit()
    expect(dialog.getByText('Enter the amount in USD.')).toBeTruthy()
    fireEvent.change(dialog.getByLabelText('Amount (USD)'), { target: { value: '0' } })
    expect(dialog.getByText('The amount must be more than $0.')).toBeTruthy()
    fireEvent.change(dialog.getByLabelText('Amount (USD)'), { target: { value: '1.234' } })
    expect(dialog.getByText(/at most 2 decimals/)).toBeTruthy()
    fireEvent.change(dialog.getByLabelText('Amount (USD)'), { target: { value: '5' } })
    fireEvent.change(dialog.getByLabelText('Top-up date'), { target: { value: '2026-11-19' } })
    expect(dialog.getByText(/can’t be in the future/)).toBeTruthy()
    fireEvent.change(dialog.getByLabelText('Top-up date'), { target: { value: TODAY } })
    fireEvent.change(dialog.getByLabelText('Note (optional)'), { target: { value: 'x'.repeat(201) } })
    expect(dialog.getByText('The note can be at most 200 characters.')).toBeTruthy()
    expect(dialog.getByText('201/200')).toBeTruthy()
    submit()
    expect(aiCalls('POST', '/api/admin/ai/credit-topups')).toHaveLength(0)
  })

  it('shows the API 400 messages in the dialog', async () => {
    let answer = () => json({ statusCode: 400, message: 'Top-up date is in the future', code: 'TOPUP_DATE_IN_FUTURE' }, 400)
    ai['POST /api/admin/ai/credit-topups'] = () => answer()
    await renderDashboard()
    fireEvent.click(await screen.findByRole('button', { name: 'Add top-up' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('Amount (USD)'), { target: { value: '5' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add top-up' }))
    expect(await dialog.findByText('The top-up date can’t be after today (Bangladesh time).')).toBeTruthy()

    answer = () => apiError(400, 'amountUsd must not be greater than 1000000')
    fireEvent.click(dialog.getByRole('button', { name: 'Add top-up' }))
    expect(await dialog.findByText('amountUsd must not be greater than 1000000')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('deletes a top-up after confirming', async () => {
    let topups = [topup(), topup({ id: 't2', amountUsd: 50, toppedUpOn: '2026-11-01', note: null })]
    ai['GET /api/admin/ai/credit-topups'] = () => json({ items: topups })
    ai['DELETE /api/admin/ai/credit-topups/t2'] = () => {
      topups = topups.filter((t) => t.id !== 't2')
      return new Response(null, { status: 204 })
    }
    await renderDashboard()
    expect(await screen.findAllByTestId('topup-row')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Delete the $50.00 top-up of 1 Nov 2026' }))
    let dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(aiCalls('DELETE', '/api/admin/ai/credit-topups/t2')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Delete the $50.00 top-up of 1 Nov 2026' }))
    dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/\$50\.00 on 1 Nov 2026 comes off the credit added/)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Delete top-up' }))
    await waitFor(() => expect(screen.getAllByTestId('topup-row')).toHaveLength(1))
    expect(aiCalls('DELETE', '/api/admin/ai/credit-topups/t2')).toHaveLength(1)
  })
})
