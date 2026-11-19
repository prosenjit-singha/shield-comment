import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiUsageReport, AiUsageStats, AiUsageWindow, SystemHealthResponse } from '@/lib/admin-system'
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

const HEALTH = '/api/admin/system/health'

const zeroStats: AiUsageStats = {
  calls: 0,
  failedCalls: 0,
  failuresByKind: {},
  inputTokens: 0,
  outputTokens: 0,
  avgLatencyMs: null,
  maxLatencyMs: null,
  estimatedCostUsd: null,
  estimatedCostBdt: null,
}

function emptyWindow(from: string, to: string): AiUsageWindow {
  return { from, to, totals: { ...zeroStats, unpricedModels: 0 }, models: [] }
}

const noAiCalls: AiUsageReport = {
  timezone: 'Asia/Dhaka',
  usdToBdtRate: 122,
  today: emptyWindow('2026-11-18', '2026-11-18'),
  last7Days: emptyWindow('2026-11-12', '2026-11-18'),
}

/** Today: one priced OpenAI model + one unpriced Neon model; the week adds more. */
const aiUsage: AiUsageReport = {
  ...noAiCalls,
  today: {
    from: '2026-11-18',
    to: '2026-11-18',
    totals: {
      calls: 1250,
      failedCalls: 5,
      failuresByKind: { rate_limited: 3, timeout: 2 },
      inputTokens: 412_000,
      outputTokens: 18_450,
      avgLatencyMs: 842,
      maxLatencyMs: 4210,
      estimatedCostUsd: 0.072861,
      estimatedCostBdt: 8.89,
      unpricedModels: 1,
    },
    models: [
      {
        provider: 'neon',
        model: 'gpt-oss-20b',
        calls: 50,
        failedCalls: 2,
        failuresByKind: { timeout: 2 },
        inputTokens: 12_000,
        outputTokens: 450,
        avgLatencyMs: 1200,
        maxLatencyMs: 4210,
        estimatedCostUsd: null,
        estimatedCostBdt: null,
        priceUsdPer1M: null,
      },
      {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        calls: 1200,
        failedCalls: 3,
        failuresByKind: { rate_limited: 3 },
        inputTokens: 400_000,
        outputTokens: 18_000,
        avgLatencyMs: 827,
        maxLatencyMs: 3900,
        estimatedCostUsd: 0.072861,
        estimatedCostBdt: 8.89,
        priceUsdPer1M: { input: 0.4, output: 1.6 },
      },
    ],
  },
  last7Days: {
    from: '2026-11-12',
    to: '2026-11-18',
    totals: {
      calls: 9800,
      failedCalls: 0,
      failuresByKind: {},
      inputTokens: 3_250_000,
      outputTokens: 140_000,
      avgLatencyMs: 790,
      maxLatencyMs: 5120,
      estimatedCostUsd: 1.524,
      estimatedCostBdt: 185.93,
      unpricedModels: 0,
    },
    models: [
      {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        calls: 9800,
        failedCalls: 0,
        failuresByKind: {},
        inputTokens: 3_250_000,
        outputTokens: 140_000,
        avgLatencyMs: 790,
        maxLatencyMs: 5120,
        estimatedCostUsd: 1.524,
        estimatedCostBdt: 185.93,
        priceUsdPer1M: { input: 0.4, output: 1.6 },
      },
    ],
  },
}

const healthy: SystemHealthResponse = {
  status: 'ok',
  checkedAt: '2026-11-18T08:05:09.000Z', // 14:05:09 in Dhaka
  database: { status: 'up', latencyMs: 3.214 },
  redis: { status: 'up', latencyMs: 0.4231 },
  process: {
    uptimeSeconds: 7500,
    startedAt: '2026-11-18T06:00:09.000Z',
    version: '0.0.1',
    nodeVersion: 'v24.11.0',
    environment: 'production',
    memory: { rssBytes: 86.4 * 1024 * 1024, heapUsedBytes: 30 * 1024 * 1024, heapTotalBytes: 60 * 1024 * 1024 },
  },
  queues: [],
  migrations: {
    known: true,
    applied: 6,
    shipped: 6,
    pending: 0,
    latest: { tag: '0005_support_tickets', hash: '006488c46d5007d366790a7fa67206a5f6e27df81e086fa096856a2e5e6fef1b', createdAt: '2026-11-18T00:00:00.000Z' },
  },
  ai: aiUsage,
}

const degraded: SystemHealthResponse = {
  ...healthy,
  status: 'degraded',
  database: { status: 'down', latencyMs: null },
  redis: { status: 'up', latencyMs: 1204.4 },
  migrations: { known: false, applied: 0, shipped: 0, pending: 0, latest: null },
  queues: [
    { name: 'comment-moderation', waiting: 1250, active: 3, failed: 2 },
    { name: 'meta-webhooks', waiting: 0, active: 0, failed: 0 },
  ],
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
let handler: () => Response | Promise<Response>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function healthCalls() {
  return fetchMock.mock.calls.filter(([input]) => new URL(input, 'http://admin.localhost').pathname === HEALTH)
}

function renderSystem() {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ['/admin/system'] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

let visibility: DocumentVisibilityState = 'visible'
function setVisibility(state: DocumentVisibilityState) {
  visibility = state
  // Browsers fire it on the document and it bubbles to window, where TanStack Query listens.
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
}

beforeEach(() => {
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  auth.getSession.mockReset().mockResolvedValue(superAdmin)
  handler = () => json(healthy)
  fetchMock.mockReset().mockImplementation(async (input, init = {}) => {
    const url = new URL(input, 'http://admin.localhost')
    if ((init.method ?? 'GET') !== 'GET' || url.pathname !== HEALTH || url.search !== '') {
      throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url.pathname}${url.search}`)
    }
    return handler()
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function panel(name: string) {
  return screen.getByRole('region', { name })
}

describe('/admin/system', () => {
  it('renders DB/Redis up with ms, process info, latest migration and the last-checked time', async () => {
    renderSystem()
    expect(await screen.findByTestId('database-latency')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'System' })).toBeTruthy()

    expect(screen.getByTestId('database-status').textContent).toBe('Up')
    expect(screen.getByTestId('database-latency').textContent).toBe('3.21 ms')
    expect(screen.getByTestId('redis-status').textContent).toBe('Up')
    expect(screen.getByTestId('redis-latency').textContent).toBe('0.42 ms')
    expect(screen.getByTestId('database-status').className).toContain('rounded-full')

    const proc = panel('API process')
    expect(within(proc).getByTestId('process-uptime').textContent).toBe('2h 5m')
    expect(within(proc).getByTestId('process-version').textContent).toBe('v0.0.1')
    expect(within(proc).getByText('v24.11.0')).toBeTruthy()
    expect(within(proc).getByText('production')).toBeTruthy()
    expect(within(proc).getByTestId('process-rss').textContent).toBe('86.4 MB')
    expect(within(proc).getByText('30.0 MB / 60.0 MB')).toBeTruthy()

    const mig = panel('Migrations')
    expect(within(mig).getByTestId('migration-latest').textContent).toBe('0005_support_tickets')
    expect(within(mig).getByTestId('migration-count').textContent).toBe('6 of 6')
    expect(within(mig).getByTestId('migration-status').textContent).toBe('Up to date')
    expect(within(mig).getByText('006488c46d5007d3')).toBeTruthy()

    expect(screen.getByTestId('last-checked').textContent).toBe('14:05:09')
    expect(healthCalls()).toHaveLength(1)
  })

  it('shows the empty-queue state when no queues exist', async () => {
    renderSystem()
    const queues = await screen.findByRole('region', { name: 'Queues' })
    expect(await within(queues).findByRole('heading', { name: 'No queues yet' })).toBeTruthy()
    expect(within(queues).queryAllByTestId('queue-row')).toHaveLength(0)
    expect(within(queues).queryByRole('table')).toBeNull()
  })

  it('renders a down database, slow Redis, unknown migrations and queue rows', async () => {
    handler = () => json(degraded)
    renderSystem()
    expect(await screen.findByText('No response')).toBeTruthy()
    expect(screen.getByTestId('database-status').textContent).toBe('Down')
    expect(screen.getByTestId('database-status').dataset.tone).toBe('bad')
    expect(screen.getByTestId('database-latency').textContent).toBe('No response')
    expect(screen.getByTestId('redis-latency').textContent).toBe('1,204 ms')

    const mig = panel('Migrations')
    expect(within(mig).getByTestId('migration-status').textContent).toBe('Unknown')
    expect(within(mig).getByText(/can't be read while the database is down/)).toBeTruthy()

    const rows = within(panel('Queues')).getAllByTestId('queue-row')
    expect(rows.map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ['comment-moderation', '1,250', '3', '2'],
      ['meta-webhooks', '0', '0', '0'],
    ])
    expect(within(panel('Queues')).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Queue',
      'Waiting',
      'Active',
      'Failed',
    ])
  })

  it('shows pending migrations', async () => {
    handler = () => json({ ...healthy, migrations: { ...healthy.migrations, applied: 5, pending: 1 } })
    renderSystem()
    expect((await screen.findByTestId('migration-status')).textContent).toBe('1 pending')
    expect(screen.getByTestId('migration-count').textContent).toBe('5 of 6')
  })

  it('shows the error state and recovers with Try again', async () => {
    handler = () => json({ statusCode: 500, message: 'Internal server error' }, 500)
    renderSystem()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText("Couldn't load system health")).toBeTruthy()
    expect(within(alert).getByText('Internal server error')).toBeTruthy()

    handler = () => json(healthy)
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('database-latency')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(healthCalls()).toHaveLength(2)
  })

  it('refreshes on demand with the Refresh button', async () => {
    renderSystem()
    await screen.findByTestId('database-latency')
    handler = () => json({ ...healthy, checkedAt: '2026-11-18T08:06:00.000Z' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByTestId('last-checked').textContent).toBe('14:06:00'))
    expect(healthCalls()).toHaveLength(2)
  })

  it('polls every 30 s while visible and pauses while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderSystem()
    await screen.findByTestId('database-latency')
    expect(healthCalls()).toHaveLength(1)

    // Nothing before the interval elapses.
    await act(() => vi.advanceTimersByTimeAsync(29_000))
    expect(healthCalls()).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(1_500))
    await waitFor(() => expect(healthCalls()).toHaveLength(2))

    await act(() => vi.advanceTimersByTimeAsync(30_500))
    await waitFor(() => expect(healthCalls()).toHaveLength(3))

    // Hidden: interval ticks are skipped.
    act(() => setVisibility('hidden'))
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000))
    expect(healthCalls()).toHaveLength(3)

    // Visible again: one catch-up refresh (data is stale), then the 30 s cadence resumes.
    act(() => setVisibility('visible'))
    await waitFor(() => expect(healthCalls()).toHaveLength(4))
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(healthCalls()).toHaveLength(4)
    await act(() => vi.advanceTimersByTimeAsync(21_000))
    await waitFor(() => expect(healthCalls()).toHaveLength(5))
  })
})

describe('/admin/system AI moderation card', () => {
  const selectWindow = (name: string) =>
    fireEvent.mouseDown(within(panel('AI moderation')).getByRole('tab', { name }), { button: 0 })

  it('shows today\'s totals, failures by kind, BDT and per-model rows with n/a for unknown prices', async () => {
    renderSystem()
    const card = await screen.findByRole('region', { name: 'AI moderation' })
    const ai = within(card)
    await ai.findByTestId('ai-calls')
    expect(ai.getByRole('tab', { name: 'Today' }).getAttribute('aria-selected')).toBe('true')
    expect(ai.getByTestId('ai-window-range').textContent).toBe('18 Nov 2026 · Dhaka time')
    expect(ai.getByTestId('ai-calls').textContent).toBe('1,250')
    expect(ai.getByTestId('ai-failed').textContent).toBe('5')
    expect(ai.getByTestId('ai-failed').className).toContain('text-destructive')
    // PW-T7: no credits figure or column any more.
    expect(ai.queryByTestId('ai-credits')).toBeNull()
    expect(card.textContent).not.toMatch(/credit/i)
    expect(ai.getByTestId('ai-tokens').textContent).toBe('412K / 18,450')
    expect(ai.getByTestId('ai-tokens').getAttribute('title')).toBe('412,000 / 18,450')
    expect(ai.getByTestId('ai-cost').textContent).toBe('$0.0729 · ৳8.89')
    expect(ai.getByTestId('ai-latency').textContent).toBe('842 ms / 4.2 s')

    // Most frequent first, as rounded pills.
    expect(ai.getAllByTestId('ai-failure').map((li) => li.textContent)).toEqual(['Rate limited · 3', 'Timeout · 2'])
    expect(ai.getAllByTestId('ai-failure')[0]!.firstElementChild!.className).toContain('rounded-full')

    expect(ai.getByTestId('ai-unpriced').textContent).toContain('leaves out 1 model without a list price')

    const rows = ai.getAllByTestId('ai-model-row')
    expect(rows.map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ['Neon AI gatewaygpt-oss-20b', '50', '2', '12,000 / 450', '1.2 s / 4.2 s', 'n/a', 'n/a'],
      ['OpenAIgpt-4.1-mini', '1,200', '3', '400K / 18,000', '827 ms / 3.9 s', '$0.0729৳8.89', '$0.40 / $1.60'],
    ])
    expect(ai.getByText(/taka at ৳122 per US\$/)).toBeTruthy()
  })

  it('switches to the last 7 days', async () => {
    renderSystem()
    await screen.findByTestId('ai-calls')
    selectWindow('Last 7 days')
    const ai = within(panel('AI moderation'))
    await waitFor(() => expect(ai.getByTestId('ai-calls').textContent).toBe('9,800'))
    expect(ai.getByTestId('ai-window-range').textContent).toBe('12 Nov – 18 Nov 2026 · Dhaka time')
    expect(ai.getByTestId('ai-tokens').textContent).toBe('3.3M / 140K')
    expect(ai.getByTestId('ai-cost').textContent).toBe('$1.52 · ৳185.93')
    expect(ai.getByTestId('ai-failed').className).not.toContain('text-destructive')
    expect(ai.getByText('No failed calls.')).toBeTruthy()
    expect(ai.queryByTestId('ai-unpriced')).toBeNull()
    expect(ai.getAllByTestId('ai-model-row')).toHaveLength(1)
  })

  it('shows "No AI calls yet" for an empty window', async () => {
    handler = () => json({ ...healthy, ai: noAiCalls })
    renderSystem()
    const card = await screen.findByRole('region', { name: 'AI moderation' })
    expect(await within(card).findByRole('heading', { name: 'No AI calls yet' })).toBeTruthy()
    expect(within(card).queryByRole('table')).toBeNull()
    selectWindow('Last 7 days')
    expect(within(card).getByTestId('ai-window-range').textContent).toBe('12 Nov – 18 Nov 2026 · Dhaka time')
    expect(within(card).getByRole('heading', { name: 'No AI calls yet' })).toBeTruthy()
  })

  it('shows "AI usage unavailable" when ai is null and leaves the rest of the page alone', async () => {
    handler = () => json({ ...healthy, ai: null })
    renderSystem()
    const card = await screen.findByRole('region', { name: 'AI moderation' })
    expect(await within(card).findByRole('heading', { name: 'AI usage unavailable' })).toBeTruthy()
    expect(within(card).queryByRole('tab')).toBeNull()
    expect(screen.getByTestId('database-latency').textContent).toBe('3.21 ms')
    expect(screen.getByTestId('migration-latest').textContent).toBe('0005_support_tickets')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('treats a response without ai (older backend) as unavailable', async () => {
    const { ai: _ai, ...withoutAi } = healthy
    handler = () => json(withoutAi)
    renderSystem()
    const card = await screen.findByRole('region', { name: 'AI moderation' })
    expect(await within(card).findByRole('heading', { name: 'AI usage unavailable' })).toBeTruthy()
  })
})
