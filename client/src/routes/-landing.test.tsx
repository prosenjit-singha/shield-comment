import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '@/lib/language'
import { landingHeaders, loadLanding } from '@/lib/landing'
import { createQueryClient } from '@/lib/query-client'
import { Route as BnRoute } from '@/routes/bn'
import { Route as IndexRoute } from '@/routes/index'
import { createLanguageStore, LanguageStoreContext } from '@/stores/language-store'
import { stubAppGlobals } from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'
import { plansResponse } from '@/test/plans-fixtures'

// app-routes pulls in the session server fn.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))
// The server-render plans fetch needs the Start compiler; the browser path (jsdom) never calls it.
vi.mock('@/server/plans', () => ({
  getServerPlans: vi.fn(() => {
    throw new Error('server plans fetch must not run in the browser')
  }),
}))
vi.mock('@/lib/request-context', () => ({ getSiteOrigin: () => 'http://app.test' }))

const PLANS = '/api/plans'

/** The real `/` + `/bn` file routes under a bare root (the generated tree pulls in Start server fns). */
function renderLanding(language: Language) {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet })
  const stub = (path: string, text: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => <p>{text}</p> })
  const routeTree = rootRoute.addChildren([
    IndexRoute.update({ id: '/', path: '/', getParentRoute: () => rootRoute } as never),
    BnRoute.update({ id: '/bn', path: '/bn', getParentRoute: () => rootRoute } as never),
    stub('/register', 'Register stub'),
    stub('/login', 'Login stub'),
  ])
  const queryClient = createQueryClient()
  const path = language === 'bn' ? '/bn' : '/'
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), context: { queryClient } })
  render(
    <LanguageStoreContext value={createLanguageStore(language)}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LanguageStoreContext>,
  )
  return { router }
}

const copy = {
  en: {
    h1: 'Stop losing Facebook & Instagram ad sales to scam comments',
    sections: ['Platforms and payments', 'Bad comments cost you real orders', 'See what clean comments are worth', 'Live in three steps', 'Simple pricing in Taka', 'Questions, answered', 'Protect your next ad before the scammers find it'],
    login: 'Log in',
    start: 'Get started',
    starterRows: ['1 Facebook & Instagram Page', '2,500 comments scanned a month', '1 team seat', '1 workspace', 'Bangla, Banglish & English AI filter', 'Priority support & API webhooks'],
    trial: 'Start free 7-day trial',
    trialNote: '300 comments included. No payment needed.',
    discount: '50% off',
    save: 'Save up to 10%',
    growthMonthly: '৳1,249',
    growthYearlyAlt: 'or ৳2,249/month billed yearly (৳26,988)',
    growthMonthlyAlt: 'or ৳1,249/month billed monthly',
    chooseGrowth: 'Choose Growth',
    choosePro: 'Choose Pro',
    yearly: 'Bill yearly',
    seePlans: 'See plans',
    spend: '৳50,000',
    sales: '৳12,000',
    salesAfter: '৳24,000',
    faq: 'How do I pay?',
  },
  bn: {
    h1: 'স্ক্যাম কমেন্টে ফেসবুক ও ইনস্টাগ্রাম অ্যাডের সেল হারানো বন্ধ করুন',
    sections: ['প্ল্যাটফর্ম ও পেমেন্ট', 'খারাপ কমেন্টে আসল অর্ডার হারান', 'পরিষ্কার কমেন্টের মূল্য দেখুন', 'তিন ধাপে চালু', 'টাকায় সহজ মূল্য', 'আপনার প্রশ্নের উত্তর', 'স্ক্যামাররা খুঁজে পাওয়ার আগেই পরের অ্যাড সুরক্ষিত করুন'],
    login: 'লগ ইন',
    start: 'শুরু করুন',
    starterRows: ['১টি ফেসবুক ও ইনস্টাগ্রাম পেজ', 'মাসে ২,৫০০টি কমেন্ট যাচাই', '১টি টিম সিট', '১টি ওয়ার্কস্পেস', 'বাংলা, বাংলিশ ও ইংরেজি এআই ফিল্টার', 'অগ্রাধিকার সাপোর্ট ও API ওয়েবহুক'],
    trial: '৭ দিনের ফ্রি ট্রায়াল শুরু করুন',
    trialNote: '৩০০টি কমেন্ট সহ। কোনো পেমেন্ট লাগবে না।',
    discount: '৫০% ছাড়',
    save: '১০% পর্যন্ত সাশ্রয়',
    growthMonthly: '৳১,২৪৯',
    growthYearlyAlt: 'অথবা বার্ষিক বিলে ৳২,২৪৯/মাস (৳২৬,৯৮৮)',
    growthMonthlyAlt: 'অথবা মাসিক বিলে ৳১,২৪৯/মাস',
    chooseGrowth: 'Growth বেছে নিন',
    choosePro: 'Pro বেছে নিন',
    yearly: 'বার্ষিক বিল',
    seePlans: 'প্ল্যান দেখুন',
    spend: '৳৫০,০০০',
    sales: '৳১২,০০০',
    salesAfter: '৳২৪,০০০',
    faq: 'কীভাবে পেমেন্ট করব?',
  },
} as const

const href = (name: string) => screen.getByRole('link', { name }).getAttribute('href')
const card = (name: string) => {
  const found = screen.getAllByTestId('plan-card').find((item) => within(item).queryByRole('heading', { name }))
  if (!found) throw new Error(`no card ${name}`)
  return found
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals() // the Animate UI switch reads matchMedia
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('landing (%s)', (language) => {
  const t = copy[language]

  it('renders the H1 and every section heading, plans fetched once', async () => {
    mockApi({ [PLANS]: () => json(200, plansResponse()) })
    renderLanding(language)

    expect(await screen.findByRole('heading', { level: 1, name: t.h1 })).toBeTruthy()
    for (const title of t.sections) expect(screen.getByRole('heading', { level: 2, name: title })).toBeTruthy()
    expect(await screen.findAllByTestId('plan-card')).toHaveLength(3)
    expect(screen.getAllByRole('heading', { level: 3, name: /Starter|Growth|Pro/ })).toHaveLength(3)
    expect(within(screen.getByTestId('payment-methods')).getByText('bKash')).toBeTruthy()
    for (const method of ['Nagad', 'Visa', 'Mastercard']) expect(within(screen.getByTestId('payment-methods')).getByText(method)).toBeTruthy()
    expect(document.querySelectorAll('details')).toHaveLength(6)
    expect(screen.getByText(t.faq)).toBeTruthy()
    expect(callsTo(PLANS)).toHaveLength(1)
  })

  it('navbar: EN | বাং links, Log in, Get started', async () => {
    mockApi({ [PLANS]: () => json(200, plansResponse()) })
    renderLanding(language)
    await screen.findByRole('heading', { level: 1 })

    expect(href('EN')).toBe('/')
    expect(href('বাং')).toBe('/bn')
    expect(screen.getByRole('link', { name: language === 'en' ? 'EN' : 'বাং' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: language === 'en' ? 'বাং' : 'EN' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getAllByRole('link', { name: t.login })[0]?.getAttribute('href')).toBe('/login')
    for (const link of screen.getAllByRole('link', { name: new RegExp(`^${t.start}`) })) expect(link.getAttribute('href')).toBe('/register')
  })

  it('pricing: 11 rows per card, highlighted card, trial + discount text, both prices without JS', async () => {
    mockApi({ [PLANS]: () => json(200, plansResponse()) })
    renderLanding(language)
    await screen.findAllByTestId('plan-card')

    for (const item of screen.getAllByTestId('plan-card')) expect(within(item).getAllByRole('listitem')).toHaveLength(11)
    for (const row of t.starterRows) expect(within(card('Starter')).getByText(row)).toBeTruthy()
    expect(card('Growth').getAttribute('data-highlighted')).toBe('true')
    expect(card('Starter').getAttribute('data-highlighted')).toBeNull()
    expect(screen.getByText(t.save)).toBeTruthy()
    expect(within(card('Growth')).getByText(t.discount)).toBeTruthy()
    expect(within(card('Growth')).getByText(t.growthMonthly)).toBeTruthy()
    expect(within(card('Growth')).getByTestId('other-interval-price').textContent).toBe(t.growthYearlyAlt)
    expect(within(card('Pro')).queryByTestId('other-interval-price')).toBeNull() // no yearly price
    expect(within(card('Starter')).getByRole('link', { name: t.trial }).getAttribute('href')).toBe('/register')
    expect(within(card('Starter')).getByText(t.trialNote)).toBeTruthy()
    // D11 hrefs, no-JS default month; the highlighted plan gets the primary button.
    expect(href(t.chooseGrowth)).toBe('/register?plan=growth&interval=month')
    expect(href(t.choosePro)).toBe('/register?plan=pro&interval=month')
    expect(screen.getByRole('link', { name: t.chooseGrowth }).getAttribute('data-variant')).toBe('default')
    expect(screen.getByRole('link', { name: t.choosePro }).getAttribute('data-variant')).toBe('outline')
  })

  it('interval switch changes the prices and the Choose hrefs', async () => {
    mockApi({ [PLANS]: () => json(200, plansResponse()) })
    renderLanding(language)
    await screen.findAllByTestId('plan-card')

    fireEvent.click(screen.getByRole('switch', { name: t.yearly }))
    await waitFor(() => expect(href(t.chooseGrowth)).toBe('/register?plan=growth&interval=year'))
    expect(href(t.choosePro)).toBe('/register?plan=pro&interval=month') // monthly only
    expect(within(card('Growth')).getByTestId('other-interval-price').textContent).toBe(t.growthMonthlyAlt)
    expect(within(card('Starter')).getByRole('link', { name: t.trial }).getAttribute('href')).toBe('/register')
    expect(callsTo(PLANS)).toHaveLength(1)
  })

  it.each([
    ['500', () => json(500, { statusCode: 500, message: 'Internal server error' })],
    ['network', (): Response => {
      throw new TypeError('Failed to fetch')
    }],
  ] as const)('plans API %s: the page renders with a See plans link', async (_name, failure) => {
    mockApi({ [PLANS]: failure })
    renderLanding(language)

    expect(await screen.findByRole('heading', { level: 1, name: t.h1 })).toBeTruthy()
    const fallback = await screen.findByTestId('pricing-fallback')
    expect(within(fallback).getByRole('link', { name: t.seePlans }).getAttribute('href')).toBe('/register')
    expect(screen.queryAllByTestId('plan-card')).toHaveLength(0)
    expect(screen.getByRole('heading', { level: 2, name: t.sections[4] })).toBeTruthy()
  })

  it('ROAS calculator updates the protected sales', async () => {
    mockApi({ [PLANS]: () => json(200, plansResponse()) })
    renderLanding(language)
    await screen.findByRole('heading', { level: 1 })

    expect(screen.getByTestId('ad-spend').textContent).toBe(t.spend)
    expect(screen.getByTestId('protected-sales').textContent).toBe(t.sales)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '100000' } })
    expect(screen.getByTestId('protected-sales').textContent).toBe(t.salesAfter)
  })
})

describe('landing loader', () => {
  it('reports a failed plans fetch so the HTML is not cached', async () => {
    mockApi({ [PLANS]: () => json(503, { statusCode: 503, message: 'down' }) })
    const data = await loadLanding(createQueryClient())
    expect(data).toEqual({ origin: 'http://app.test', plansLoaded: false })
    expect(landingHeaders(data)).toEqual({ 'Cache-Control': 'no-store' })
    expect(callsTo(PLANS)).toHaveLength(1) // no retry
  })

  it('caches the plans for the page on success, default headers', async () => {
    mockApi({ [PLANS]: () => json(200, plansResponse()) })
    const queryClient = createQueryClient()
    const data = await loadLanding(queryClient)
    expect(data.plansLoaded).toBe(true)
    expect(landingHeaders(data)).toBeUndefined()
    expect(queryClient.getQueryData(['plans'])).toEqual(plansResponse())
  })
})
