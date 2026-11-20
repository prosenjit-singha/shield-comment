import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dashboardSummaryQueryKey, type DashboardSummary } from '@/lib/dashboard-summary'
import type { Language } from '@/lib/language'
import { DASHBOARD, dashboardApi, dashboardSummary, IMPERSONATED, renderAppRoute, SESSION, stubAppGlobals, summaryApi } from '@/test/app-routes'
import { fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// C4 `/dashboard` + the `_app` navigation (M6-T8): real `_app` + route files (harness `src/test/app-routes.tsx`).

const copy = {
  en: {
    heading: 'Dashboard',
    scanned: 'Comments scanned',
    autoHidden: 'Auto-hidden',
    needsReview: 'Needs review',
    scams: 'Scams blocked',
    activity: 'Comments scanned vs. auto-hidden',
    flagged: 'Blocked categories',
    intents: 'Comment intent breakdown',
    emptyActivity: 'No comments scanned in this range',
    emptyFlagged: 'Nothing flagged in this range',
    emptyIntents: 'No comments yet',
    scam: 'Scam / phishing',
    safe: 'Safe inquiry',
    loadFailed: 'Couldn’t load your dashboard',
    server: 'The server is unavailable right now. Try again shortly.',
    retry: 'Try again',
    range: 'Date range',
    d7: '7 days',
    d30: '30 days',
    d90: '90 days',
    nav: ['Dashboard', 'Comments', 'Pages', 'Rules', 'Playground', 'Analytics', 'Plans'],
    total: '1,500',
  },
  bn: {
    heading: 'ড্যাশবোর্ড',
    scanned: 'স্ক্যান করা কমেন্ট',
    autoHidden: 'অটো-হাইড',
    needsReview: 'রিভিউ দরকার',
    scams: 'স্ক্যাম ঠেকানো হয়েছে',
    activity: 'স্ক্যান করা বনাম অটো-হাইড কমেন্ট',
    flagged: 'ব্লক করা ক্যাটাগরি',
    intents: 'কমেন্টের ধরন বিশ্লেষণ',
    emptyActivity: 'এই সময়ে কোনো কমেন্ট স্ক্যান হয়নি',
    emptyFlagged: 'এই সময়ে কিছু চিহ্নিত হয়নি',
    emptyIntents: 'এখনো কোনো কমেন্ট নেই',
    scam: 'স্ক্যাম / ফিশিং',
    safe: 'সাধারণ জিজ্ঞাসা',
    loadFailed: 'আপনার ড্যাশবোর্ড লোড করা যায়নি',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।',
    retry: 'আবার চেষ্টা করুন',
    range: 'সময়সীমা',
    d7: '৭ দিন',
    d30: '৩০ দিন',
    d90: '৯০ দিন',
    nav: ['ড্যাশবোর্ড', 'কমেন্ট', 'পেজ', 'নিয়ম', 'প্লেগ্রাউন্ড', 'অ্যানালিটিক্স', 'প্ল্যান'],
    total: '১,৫০০',
  },
} as const

/** A summary with real numbers: 1,500 classified comments, 120 scams. */
function fullSummary(range: DashboardSummary['range'] = '30d'): DashboardSummary {
  const summary = dashboardSummary(range, (i) => ({ scanned: 10 + i, autoHidden: i % 3 }))
  summary.kpis = { scanned: 1234, autoHidden: 56, needsReview: 7, scamsBlocked: 120 }
  summary.intents = [
    { category: 'SAFE_INQUIRY', count: 1200 },
    { category: 'COMPETITOR_POACH', count: 60 },
    { category: 'SCAM_PHISHING', count: 120 },
    { category: 'SPAM_IRRELEVANT', count: 90 },
    { category: 'ABUSIVE_TOXIC', count: 30 },
  ]
  summary.flagged = summary.intents.slice(1)
  return summary
}

/** Every `range=` the page asked for, in order. */
const requestedRanges = () =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname === DASHBOARD)
    .map((url) => url.searchParams.get('range'))

const region = (name: string) => within(screen.getByRole('region', { name }))
const kpi = (key: string) => screen.getByTestId(`kpi-${key}`).textContent

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/dashboard (%s)', (language: Language) => {
  const t = copy[language]

  it('renders the KPIs and the Line, Bar and Donut charts with data', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...summaryApi(), ...dashboardApi((range) => json(200, fullSummary(range))) })
    renderAppRoute('/dashboard', language)

    expect(await screen.findByRole('heading', { name: t.heading, level: 1 })).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('activity-chart')).toBeTruthy())
    expect(requestedRanges()).toEqual(['30d'])
    for (const label of [t.scanned, t.autoHidden, t.needsReview, t.scams]) expect(screen.getByRole('region', { name: label })).toBeTruthy()
    expect(kpi('scanned')).toBe(language === 'en' ? '1,234' : '১,২৩৪')
    expect(kpi('autoHidden')).toBe(language === 'en' ? '56' : '৫৬')
    expect(kpi('needsReview')).toBe(language === 'en' ? '7' : '৭')
    expect(kpi('scamsBlocked')).toBe(language === 'en' ? '120' : '১২০')

    expect(screen.getByRole('region', { name: t.activity })).toBeTruthy()
    expect(screen.getByTestId('flagged-chart')).toBeTruthy()
    const intents = region(t.intents)
    expect(intents.getByText(t.total)).toBeTruthy()
    expect(intents.getByText(t.scam)).toBeTruthy()
    expect(intents.getByText(t.safe)).toBeTruthy()
    expect(intents.getByText(language === 'en' ? '80%' : '৮০%')).toBeTruthy()
    for (const empty of [t.emptyActivity, t.emptyFlagged, t.emptyIntents]) expect(screen.queryByText(empty)).toBeNull()
    expect(screen.queryByTestId('chart-skeleton')).toBeNull()
    expect(screen.getByRole('button', { name: t.d30 }).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps every chart slot and shows the empty states for an all-zero range', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...summaryApi(), ...dashboardApi() })
    renderAppRoute('/dashboard', language)

    expect(await screen.findByText(t.emptyActivity)).toBeTruthy()
    expect(screen.getByText(t.emptyFlagged)).toBeTruthy()
    expect(screen.getByText(t.emptyIntents)).toBeTruthy()
    expect(screen.getByTestId('activity-chart').firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByTestId('flagged-chart')).toBeTruthy()
    expect(screen.getByTestId('intents-chart')).toBeTruthy()
    expect(kpi('scanned')).toBe(language === 'en' ? '0' : '০')
  })

  it('shows skeletons while loading', async () => {
    let release: () => void = () => {}
    const pending = new Promise<void>((resolve) => (release = resolve))
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      ...summaryApi(),
      ...dashboardApi(async () => {
        await pending
        return json(200, dashboardSummary())
      }),
    })
    renderAppRoute('/dashboard', language)

    expect(await screen.findAllByTestId('chart-skeleton')).toHaveLength(3)
    expect(screen.getAllByTestId('kpi-skeleton')).toHaveLength(4)
    release()
    await waitFor(() => expect(screen.queryByTestId('chart-skeleton')).toBeNull())
    expect(screen.queryByTestId('kpi-skeleton')).toBeNull()
  })

  it('shows an error with a retry that loads the charts', async () => {
    let fail = true
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      ...summaryApi(),
      ...dashboardApi((range) => (fail ? json(503, { message: 'down' }) : json(200, fullSummary(range)))),
    })
    renderAppRoute('/dashboard', language)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(t.loadFailed)).toBeTruthy()
    expect(within(alert).getByText(t.server)).toBeTruthy()
    expect(screen.queryByTestId('activity-chart')).toBeNull()
    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: t.retry }))
    expect(await screen.findByTestId('activity-chart')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(requestedRanges()).toEqual(['30d', '30d'])
  })

  it('refetches with the new range and keeps it in the URL (the default stays out)', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...summaryApi(), ...dashboardApi((range) => json(200, fullSummary(range))) })
    const { history, queryClient } = renderAppRoute('/dashboard', language)
    await screen.findByTestId('activity-chart')

    fireEvent.click(within(screen.getByRole('group', { name: t.range })).getByRole('button', { name: t.d7 }))
    await waitFor(() => expect(requestedRanges()).toEqual(['30d', '7d']))
    expect(new URLSearchParams(history.location.search).get('range')).toBe('7d')
    await waitFor(() => expect(screen.getByRole('button', { name: t.d7 }).getAttribute('aria-pressed')).toBe('true'))
    expect(queryClient.getQueryData(dashboardSummaryQueryKey('w1', '7d'))).toMatchObject({ range: '7d' })

    fireEvent.click(screen.getByRole('button', { name: t.d90 }))
    await waitFor(() => expect(requestedRanges()).toEqual(['30d', '7d', '90d']))
    expect(new URLSearchParams(history.location.search).get('range')).toBe('90d')

    // Back to the default: no `range` in the URL, and the cached 30d answer is reused.
    fireEvent.click(screen.getByRole('button', { name: t.d30 }))
    await waitFor(() => expect(screen.getByRole('button', { name: t.d30 }).getAttribute('aria-pressed')).toBe('true'))
    expect(history.location.search).toBe('')
  })

  it('opens a range from the URL and ignores an unknown one', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...summaryApi(), ...dashboardApi() })
    renderAppRoute('/dashboard?range=90d', language)
    await screen.findByTestId('activity-chart')
    expect(requestedRanges()).toEqual(['90d'])
    expect(screen.getByRole('button', { name: t.d90 }).getAttribute('aria-pressed')).toBe('true')
    cleanup()

    fetchMock.mockClear()
    renderAppRoute('/dashboard?range=12m', language)
    await screen.findByTestId('activity-chart')
    expect(requestedRanges()).toEqual(['30d'])
  })

  describe('navigation (D16 c)', () => {
    const navLinks = (testId: string) => within(screen.getByTestId(testId)).getAllByRole('link')

    it('lists the same items in the desktop sidebar and the mobile bottom bar, with the active one marked', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...summaryApi(), ...dashboardApi() })
      renderAppRoute('/dashboard?range=7d', language)
      await screen.findByTestId('activity-chart')

      const sidebar = screen.getByTestId('app-sidebar')
      const bottomBar = screen.getByTestId('app-bottom-bar')
      // CSS picks one per breakpoint: the sidebar from md up, the bottom bar below.
      expect(sidebar.className).toMatch(/(^| )hidden( |$)/)
      expect(sidebar.className).toContain('md:flex')
      expect(bottomBar.className).toContain('md:hidden')
      expect(bottomBar.className).toContain('fixed')

      for (const testId of ['app-sidebar', 'app-bottom-bar']) {
        const links = navLinks(testId)
        expect(links.map((link) => link.textContent)).toEqual([...t.nav])
        expect(links.map((link) => link.getAttribute('href'))).toEqual(['/dashboard', '/comments', '/pages', '/rules', '/playground', '/analytics', '/plans'])
        // Active even with a range in the URL.
        expect(links.map((link) => link.getAttribute('aria-current'))).toEqual(['page', null, null, null, null, null, null])
      }
    })

    it('moves the active item when navigating, also while impersonating', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, IMPERSONATED),
        ...summaryApi(),
        ...dashboardApi(),
        // The plans page itself is not under test here.
        '/api/plans': () => json(503, { message: 'down' }),
      })
      const { history } = renderAppRoute('/dashboard', language)
      await screen.findByTestId('activity-chart')

      fireEvent.click(navLinks('app-bottom-bar')[6]!)
      await waitFor(() => expect(history.location.pathname).toBe('/plans'))
      for (const testId of ['app-sidebar', 'app-bottom-bar']) {
        await waitFor(() => expect(navLinks(testId).map((link) => link.getAttribute('aria-current'))).toEqual([null, null, null, null, null, null, 'page']))
      }
    })
  })
})
