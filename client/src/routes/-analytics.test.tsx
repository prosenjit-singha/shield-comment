import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '@/lib/language'
import {
  analytics,
  ANALYTICS,
  ANALYTICS_COMMENTS_CSV,
  ANALYTICS_DAILY_CSV,
  ANALYTICS_PAGES,
  analyticsApi,
  type AnalyticsApiOptions,
  IMPERSONATED,
  renderAppRoute,
  SESSION,
  stubAppGlobals,
  summaryApi,
} from '@/test/app-routes'
import { fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// C9 `/analytics` (M6-T12; D11 a, D12 b, D13 a): real `_app` + route files (harness `src/test/app-routes.tsx`).

const [SHOP_ONE, SHOP_TWO] = ANALYTICS_PAGES as [(typeof ANALYTICS_PAGES)[number], (typeof ANALYTICS_PAGES)[number]]

const copy = {
  en: {
    heading: 'Analytics',
    from: 'From',
    to: 'To',
    apply: 'Apply',
    page: 'Page',
    allPages: 'All Pages',
    summaryDays: '18 Nov 2026 – 20 Nov 2026 · by day',
    summaryMonths: '1 Dec 2025 – 20 Nov 2026 · by month',
    everyMonth: 'Every month of the range, Dhaka time.',
    reset: 'Back to the last 30 days',
    noScans: 'No comments scanned in this range',
    noFlags: 'Nothing flagged in this range',
    scanned: '63',
    autoHidden: '9',
    received: '1,200',
    loadFailed: 'Couldn’t load analytics',
    retry: 'Try again',
    server: 'The server is unavailable right now. Try again shortly.',
    network: 'Can’t reach the server. Check your connection and try again.',
    range: 'Pick a range of up to 12 months that ends today or earlier.',
    pageGone: 'This Page isn’t in this workspace any more. Pick another Page.',
    download: 'Download',
    pro: 'Per-comment downloads are part of the Pro plan. Upgrade to Pro to download them. See plans',
    plans: 'See plans',
    commentsTooLong: 'The per-comment file covers up to 92 days. Pick a shorter range.',
  },
  bn: {
    heading: 'অ্যানালিটিক্স',
    from: 'শুরু',
    to: 'শেষ',
    apply: 'প্রয়োগ করুন',
    page: 'পেজ',
    allPages: 'সব পেজ',
    summaryDays: '১৮ নভে, ২০২৬ – ২০ নভে, ২০২৬ · দিন অনুযায়ী',
    summaryMonths: '১ ডিসে, ২০২৫ – ২০ নভে, ২০২৬ · মাস অনুযায়ী',
    everyMonth: 'বেছে নেওয়া সময়ের প্রতি মাস, ঢাকা সময়।',
    reset: 'শেষ ৩০ দিনে ফিরুন',
    noScans: 'এই সময়ে কোনো কমেন্ট স্ক্যান হয়নি',
    noFlags: 'এই সময়ে কিছু চিহ্নিত হয়নি',
    scanned: '৬৩',
    autoHidden: '৯',
    received: '১,২০০',
    loadFailed: 'অ্যানালিটিক্স লোড করা যায়নি',
    retry: 'আবার চেষ্টা করুন',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।',
    network: 'সার্ভারে সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
    range: 'আজ বা তার আগে শেষ হওয়া সর্বোচ্চ ১২ মাসের একটি সময়সীমা বেছে নিন।',
    pageGone: 'এই পেজটি আর এই ওয়ার্কস্পেসে নেই। অন্য একটি পেজ বেছে নিন।',
    download: 'ডাউনলোড',
    pro: 'প্রতিটি কমেন্টের ফাইল প্রো প্ল্যানে পাওয়া যায়। ডাউনলোড করতে প্রো প্ল্যানে আপগ্রেড করুন। প্ল্যান দেখুন',
    plans: 'প্ল্যান দেখুন',
    commentsTooLong: 'প্রতিটি কমেন্টের ফাইলে সর্বোচ্চ ৯২ দিন থাকে। ছোট সময়সীমা বেছে নিন।',
  },
} as const

type Respond = Parameters<typeof analyticsApi>[0]

function setup(respond?: Respond, options: AnalyticsApiOptions = {}, session: unknown = SESSION) {
  mockApi({
    '/api/auth/get-session': () => json(200, session),
    ...summaryApi(),
    ...analyticsApi(respond, options),
  })
}

async function openAnalytics(language: Language, path = '/analytics') {
  const rendered = renderAppRoute(path, language)
  await screen.findByRole('heading', { name: copy[language].heading, level: 1 })
  return rendered
}

/** Query strings sent to `path`, in order. */
const queries = (path: string) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(input instanceof Request ? input.url : String(input), 'http://localhost'))
    .filter((url) => url.pathname === path)
    .map((url) => url.search)

const csvLink = (kind: 'daily' | 'comments') => within(screen.getByTestId(`csv-${kind}`))

/** Filled days: day i has 10·(i+1) AI checks, 1 rule match, 2 hidden, 1 deleted, 3 scams, 400 received. */
const filled = () =>
  analytics({}, undefined, (i) => ({ classified: 10 * (i + 1), received: 400, ruleMatched: 1, hidden: 2, deleted: 1, scamPhishing: 3 }))

let saved: string[]

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
  saved = []
  // jsdom has no blob URLs; the download helper's hidden link click is recorded instead of followed.
  URL.createObjectURL = vi.fn(() => 'blob:csv')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download)
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/analytics (%s)', (language: Language) => {
  const t = copy[language]

  it('renders the history charts and totals for the default range (no query sent)', async () => {
    setup(() => json(200, filled()))
    await openAnalytics(language)

    expect((await screen.findByTestId('range-summary')).textContent).toBe(t.summaryDays)
    expect(screen.getByTestId('activity-chart')).toBeTruthy()
    expect(screen.getByTestId('flagged-history-chart')).toBeTruthy()
    expect(screen.getByTestId('intents-chart')).toBeTruthy()
    expect(screen.queryByText(t.noScans)).toBeNull()
    expect(screen.queryByText(t.noFlags)).toBeNull()
    expect(screen.getByTestId('total-scanned').textContent).toBe(t.scanned)
    expect(screen.getByTestId('total-autoHidden').textContent).toBe(t.autoHidden)
    expect(screen.getByTestId('total-received').textContent).toBe(t.received)
    expect(queries(ANALYTICS)).toEqual([''])
    // The date inputs show the API's range.
    expect((screen.getByLabelText(t.from) as HTMLInputElement).value).toBe('2026-11-18')
    expect((screen.getByLabelText(t.to) as HTMLInputElement).value).toBe('2026-11-20')
  })

  it('labels monthly buckets when the API answers by month', async () => {
    const months = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']
    setup(() => json(200, analytics({ from: '2025-12-01', to: '2026-11-20' }, months, () => ({ classified: 5 }))))
    await openAnalytics(language, '/analytics?from=2025-12-01&to=2026-11-20')

    expect((await screen.findByTestId('range-summary')).textContent).toBe(t.summaryMonths)
    expect(screen.getAllByText(t.everyMonth)).toHaveLength(2)
    expect(queries(ANALYTICS)).toEqual(['?from=2025-12-01&to=2026-11-20'])
  })

  it('shows the empty state when nothing happened in the range', async () => {
    setup()
    await openAnalytics(language)

    expect(await screen.findByText(t.noScans)).toBeTruthy()
    expect(screen.getAllByText(t.noFlags).length).toBeGreaterThan(0)
    expect(screen.getByTestId('total-received').textContent).toBe(language === 'en' ? '0' : '০')
  })

  it('applies a range and a Page through the URL, the query and the CSV links', async () => {
    setup((url) => json(200, analytics({ from: url.searchParams.get('from') ?? '2026-11-18', to: url.searchParams.get('to') ?? '2026-11-20' })))
    const { history } = await openAnalytics(language)
    await screen.findByTestId('range-summary')

    fireEvent.change(screen.getByLabelText(t.from), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText(t.to), { target: { value: '2026-08-31' } })
    fireEvent.click(screen.getByRole('button', { name: t.apply }))
    await waitFor(() => expect(history.location.search).toContain('from=2026-08-01'))
    expect(history.location.search).toContain('to=2026-08-31')
    await waitFor(() => expect(queries(ANALYTICS)).toEqual(['', '?from=2026-08-01&to=2026-08-31']))

    const select = screen.getByLabelText(t.page) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual([t.allPages, 'Rahim Fashion · @rahimfashion', 'Shop Two'])
    fireEvent.change(select, { target: { value: SHOP_TWO.id } })
    await waitFor(() => expect(history.location.search).toContain(`pageId=${SHOP_TWO.id}`))
    await waitFor(() => expect(queries(ANALYTICS).at(-1)).toBe(`?from=2026-08-01&to=2026-08-31&pageId=${SHOP_TWO.id}`))

    const filters = `?from=2026-08-01&to=2026-08-31&pageId=${SHOP_TWO.id}`
    expect(csvLink('daily').getByRole('link', { name: t.download }).getAttribute('href')).toBe(`${ANALYTICS_DAILY_CSV}${filters}`)
    expect(csvLink('comments').getByRole('link', { name: t.download }).getAttribute('href')).toBe(`${ANALYTICS_COMMENTS_CSV}${filters}`)

    // Back to the default range keeps the Page.
    fireEvent.click(screen.getByRole('button', { name: t.reset }))
    await waitFor(() => expect(history.location.search).toBe(`?pageId=${SHOP_TWO.id}`))
  })

  it('refuses a range the API would reject without changing the URL', async () => {
    setup()
    const { history } = await openAnalytics(language)
    await screen.findByTestId('range-summary')

    fireEvent.change(screen.getByLabelText(t.from), { target: { value: '2026-09-10' } })
    fireEvent.change(screen.getByLabelText(t.to), { target: { value: '2026-09-01' } })
    fireEvent.click(screen.getByRole('button', { name: t.apply }))
    expect((await screen.findByRole('alert')).textContent).toBe(t.range)
    fireEvent.change(screen.getByLabelText(t.from), { target: { value: '2025-01-01' } })
    fireEvent.change(screen.getByLabelText(t.to), { target: { value: '2026-01-31' } })
    fireEvent.click(screen.getByRole('button', { name: t.apply }))
    expect(screen.getByRole('alert').textContent).toBe(t.range)
    expect(history.location.search).toBe('')
    expect(queries(ANALYTICS)).toEqual([''])
  })

  it('drops search values the API would refuse', async () => {
    setup()
    for (const search of [
      '?from=2026-02-30&to=2026-03-01&pageId=p1',
      '?from=2026-09-10&to=2026-09-01',
      '?from=2025-01-01&to=2026-01-31',
      '?from=2019-12-31&to=2020-01-31',
      '?from=2026-09-01',
    ]) {
      cleanup()
      fetchMock.mockClear()
      await openAnalytics(language, `/analytics${search}`)
      await screen.findByTestId('range-summary')
      expect(queries(ANALYTICS)).toEqual([''])
    }
  })

  it('shows a load error with retry, then the charts', async () => {
    let calls = 0
    setup(() => (++calls === 1 ? json(503, { message: 'down' }) : json(200, filled())))
    await openAnalytics(language)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: t.loadFailed })).toBeTruthy()
    expect(alert.textContent).toContain(t.server)
    fireEvent.click(within(alert).getByRole('button', { name: t.retry }))
    expect(await screen.findByTestId('activity-chart')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['400', () => json(400, { message: 'The range may cover at most 12 months' }), 'range'],
    ['404 (gone Page)', () => json(404, { message: 'Page not found' }), 'pageGone'],
    ['network', () => Promise.reject(new TypeError('offline')), 'network'],
  ] as const)('explains a %s load failure', async (_name, respond, key) => {
    setup(respond)
    await openAnalytics(language, `/analytics?pageId=${SHOP_ONE.id}`)
    expect((await screen.findByRole('alert')).textContent).toContain(t[key])
  })

  it('downloads the daily CSV under the server’s file name', async () => {
    setup()
    await openAnalytics(language, `/analytics?pageId=${SHOP_ONE.id}`)
    await screen.findByTestId('range-summary')

    fireEvent.click(csvLink('daily').getByRole('link', { name: t.download }))
    await waitFor(() => expect(saved).toEqual(['shieldcomment-daily-2026-11-18-to-2026-11-20.csv']))
    expect(queries(ANALYTICS_DAILY_CSV)).toEqual([`?pageId=${SHOP_ONE.id}`])
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('explains the Pro plan with a Plans link when the per-comment CSV answers 409', async () => {
    setup(undefined, {
      onCsv: (kind) =>
        kind === 'comments'
          ? json(409, { message: 'Pro only', code: 'PLAN_FEATURE_UNAVAILABLE', details: { feature: 'whiteLabelReports' } })
          : json(500, {}),
    })
    await openAnalytics(language)
    await screen.findByTestId('range-summary')
    expect(csvLink('comments').getByText('Pro')).toBeTruthy()

    fireEvent.click(csvLink('comments').getByRole('link', { name: t.download }))
    const alert = await csvLink('comments').findByRole('alert')
    expect(alert.textContent).toBe(t.pro)
    expect(within(alert).getByRole('link', { name: t.plans }).getAttribute('href')).toBe('/plans')
    expect(saved).toEqual([])
  })

  it('hints instead of linking when the range is over the per-comment 92-day cap', async () => {
    setup(() => json(200, analytics({ from: '2026-06-01', to: '2026-09-30', granularity: 'month' }, ['2026-06', '2026-07', '2026-08', '2026-09'])))
    await openAnalytics(language, '/analytics?from=2026-06-01&to=2026-09-30')
    await screen.findByTestId('range-summary')

    expect(csvLink('comments').queryByRole('link', { name: t.download })?.getAttribute('aria-disabled')).toBe('true')
    expect(csvLink('comments').getByText(t.commentsTooLong)).toBeTruthy()
    expect(csvLink('daily').getByRole('link', { name: t.download }).getAttribute('href')).toBe(`${ANALYTICS_DAILY_CSV}?from=2026-06-01&to=2026-09-30`)
  })

  it('works while impersonating (every member and the admin may view)', async () => {
    setup(() => json(200, filled()), {}, IMPERSONATED)
    await openAnalytics(language)
    expect(await screen.findByTestId('analytics-totals')).toBeTruthy()
  })
})
