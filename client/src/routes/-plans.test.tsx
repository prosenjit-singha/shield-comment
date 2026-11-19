import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BillingSummary } from '@/lib/billing-summary'
import type { PublicPlan, PublicPlansResponse } from '@/lib/plans'
import {
  billingSummary,
  IMPERSONATED,
  PAGES,
  pagesApi,
  renderAppRoute,
  SESSION,
  stubAppGlobals,
  SUMMARY,
} from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

const PLANS = '/api/plans'
const TRIAL = '/api/workspaces/w1/billing/trial'
const NUMBER = '8801712345678'

const features = (on: number): PublicPlan['features'] => ({
  banglaAiFilter: true,
  autoHideScams: true,
  customBlocklist: on > 2,
  autoReplyTemplates: on > 3,
  messengerAlerts: on > 4,
  whiteLabelReports: on > 5,
  prioritySupportApi: on > 6,
})

const STARTER: PublicPlan = {
  id: 'plan-starter',
  slug: 'starter',
  name: 'Starter',
  badge: null,
  description: { en: 'For one shop page', bn: 'একটি দোকানের পেজের জন্য' },
  highlighted: false,
  monthly: {
    listPerMonthBdt: 999,
    listChargedBdt: 999,
    perMonthBdt: 499,
    chargedBdt: 499,
    saving: { promotionId: 'pr1', label: '৳500 off', labelBn: '৳৫০০ ছাড়', amountBdt: 500 },
  },
  yearly: {
    listPerMonthBdt: 949,
    listChargedBdt: 11388,
    perMonthBdt: 449,
    chargedBdt: 5388,
    saving: { promotionId: 'pr1', label: '৳500 off', labelBn: '৳৫০০ ছাড়', amountBdt: 6000 },
  },
  limits: { connectedPages: 1, monthlyComments: 2500, teamSeats: 1, workspaces: 1 },
  features: features(2),
  trial: { promotionId: 'pt1', days: 7, commentLimit: 300, endsAt: null },
}

const GROWTH: PublicPlan = {
  id: 'plan-growth',
  slug: 'growth',
  name: 'Growth',
  badge: { en: 'Popular', bn: 'জনপ্রিয়' },
  description: { en: 'For growing brands', bn: 'বাড়তে থাকা ব্র্যান্ডের জন্য' },
  highlighted: true,
  monthly: {
    listPerMonthBdt: 2499,
    listChargedBdt: 2499,
    perMonthBdt: 1249,
    chargedBdt: 1249,
    saving: { promotionId: 'pr2', label: '50% off', labelBn: '৫০% ছাড়', amountBdt: 1250 },
  },
  yearly: { listPerMonthBdt: 2249, listChargedBdt: 26988, perMonthBdt: 2249, chargedBdt: 26988, saving: null },
  limits: { connectedPages: 5, monthlyComments: 15000, teamSeats: 3, workspaces: 3 },
  features: features(5),
  trial: null,
}

const PRO: PublicPlan = {
  id: 'plan-pro',
  slug: 'pro',
  name: 'Pro',
  badge: null,
  description: null,
  highlighted: false,
  monthly: { listPerMonthBdt: 5999, listChargedBdt: 5999, perMonthBdt: 5999, chargedBdt: 5999, saving: null },
  yearly: null,
  limits: { connectedPages: 25, monthlyComments: 75000, teamSeats: 10, workspaces: 10 },
  features: features(7),
  trial: null,
}

const plansResponse = (overrides: Partial<PublicPlansResponse> = {}): PublicPlansResponse => ({
  items: [STARTER, GROWTH, PRO],
  yearlySaveUpToPercent: 10,
  contactWhatsapp: NUMBER,
  ...overrides,
})

const NO_PLAN = billingSummary({
  plan: null,
  interval: null,
  status: 'NONE',
  termEndsAt: null,
  comments: { used: 0, limit: 0, resetsAt: null },
  workspaces: { used: 1, limit: 0 },
  pages: { used: 0, limit: 0 },
  trialEligible: true,
})

interface ApiOptions {
  plans?: () => Response
  summary?: BillingSummary
  trial?: (body: unknown) => Response
  session?: unknown
}

/** `_app` shell + `/plans` (+ `/onboarding` after a trial); every other request fails the test. */
function plansApi({ plans = () => json(200, plansResponse()), summary = NO_PLAN, trial, session = SESSION }: ApiOptions = {}) {
  let current = summary
  mockApi({
    '/api/auth/get-session': () => json(200, session),
    ...pagesApi([]),
    [PLANS]: plans,
    [SUMMARY]: (init) => {
      if ((init?.method ?? 'GET') !== 'GET') throw new Error('Unexpected summary method')
      return json(200, current)
    },
    [TRIAL]: (init) => {
      if (init?.method !== 'POST' || !trial) throw new Error('Unexpected trial call')
      const body: unknown = JSON.parse(String(init.body))
      const response = trial(body)
      if (response.ok) current = billingSummary({ status: 'TRIALING', plan: { slug: 'starter', name: 'Starter' }, trialEligible: false })
      return response
    },
  })
}

const copy = {
  en: {
    title: 'Choose the plan for your business',
    monthly: 'Monthly',
    yearly: 'Yearly',
    saveUpTo: 'Save up to 10%',
    switchLabel: 'Bill yearly',
    perMonth: '/month',
    contact: 'Contact us',
    trial: 'Start free 7-day trial',
    trialNote: '300 comments included. No payment needed.',
    starterPrice: '৳499',
    starterList: '৳999',
    starterYearly: '৳449',
    starterYearlyList: '৳949',
    billedYearly: 'Billed ৳5,388 yearly',
    monthlyOnly: 'Monthly billing only',
    starterSaving: '৳500 off',
    growthSaving: '50% off',
    badge: 'Popular',
    description: 'For growing brands',
    pages: '1 Facebook & Instagram Page',
    comments: '2,500 comments scanned a month',
    whatsMonthly: "Hi! I'd like the Growth plan (Monthly).",
    whatsYearly: "Hi! I'd like the Growth plan (Yearly).",
    trialUsed: 'Your account has already used its free trial.',
    trialImpersonated: 'A trial can’t be started while impersonating. The owner has to start it.',
    loadFailed: 'Couldn’t load the plans.',
    retry: 'Try again',
  },
  bn: {
    title: 'আপনার ব্যবসার জন্য প্ল্যান বেছে নিন',
    monthly: 'মাসিক',
    yearly: 'বার্ষিক',
    saveUpTo: '১০% পর্যন্ত সাশ্রয়',
    switchLabel: 'বার্ষিক বিল',
    perMonth: '/মাস',
    contact: 'যোগাযোগ করুন',
    trial: '৭ দিনের ফ্রি ট্রায়াল শুরু করুন',
    trialNote: '৩০০টি কমেন্ট সহ। কোনো পেমেন্ট লাগবে না।',
    starterPrice: '৳৪৯৯',
    starterList: '৳৯৯৯',
    starterYearly: '৳৪৪৯',
    starterYearlyList: '৳৯৪৯',
    billedYearly: 'বছরে ৳৫,৩৮৮ বিল',
    monthlyOnly: 'শুধু মাসিক বিল',
    starterSaving: '৳৫০০ ছাড়',
    growthSaving: '৫০% ছাড়',
    badge: 'জনপ্রিয়',
    description: 'বাড়তে থাকা ব্র্যান্ডের জন্য',
    pages: '১টি ফেসবুক ও ইনস্টাগ্রাম পেজ',
    comments: 'মাসে ২,৫০০টি কমেন্ট যাচাই',
    whatsMonthly: 'হ্যালো! আমি Growth প্ল্যানটি (মাসিক) নিতে চাই।',
    whatsYearly: 'হ্যালো! আমি Growth প্ল্যানটি (বার্ষিক) নিতে চাই।',
    trialUsed: 'আপনার অ্যাকাউন্টে ফ্রি ট্রায়াল আগেই ব্যবহার করা হয়েছে।',
    trialImpersonated: 'ইমপারসোনেশনের সময় ট্রায়াল শুরু করা যায় না। মালিককে নিজে শুরু করতে হবে।',
    loadFailed: 'প্ল্যানগুলো লোড করা যায়নি।',
    retry: 'আবার চেষ্টা করুন',
  },
} as const

const card = (name: string) => screen.getByRole('listitem', { name })
const waUrl = (text: string) => `https://wa.me/${NUMBER}?text=${encodeURIComponent(text)}`

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/plans (%s)', (language) => {
  const t = copy[language]

  it('shows the cards in API order with prices, struck list price, plain saving text, limits and features', async () => {
    plansApi({ summary: { ...NO_PLAN, trialEligible: false } })
    renderAppRoute('/plans', language)

    expect(await screen.findByRole('heading', { level: 1, name: t.title })).toBeTruthy()
    const cards = await screen.findAllByTestId('plan-card')
    expect(cards.map((item) => within(item).getByRole('heading', { level: 2 }).textContent)).toEqual(['Starter', 'Growth', 'Pro'])

    const starter = card('Starter')
    expect(within(starter).getByText(t.starterPrice)).toBeTruthy()
    expect(within(starter).getByText(t.perMonth)).toBeTruthy()
    expect(within(starter).getByTestId('list-price').tagName).toBe('S')
    expect(within(starter).getByTestId('list-price').textContent).toBe(t.starterList)
    const saving = within(starter).getByText(t.starterSaving)
    expect(saving.tagName).toBe('P') // PR-D7: plain text, not a badge
    expect(saving.closest('[data-slot="badge"]')).toBeNull()
    expect(within(starter).getByText(t.pages)).toBeTruthy()
    expect(within(starter).getByText(t.comments)).toBeTruthy()

    const growth = card('Growth')
    expect(within(growth).getByText(t.badge).dataset.slot).toBe('badge')
    expect(within(growth).getByText(t.description)).toBeTruthy()
    expect(within(growth).getByText(t.growthSaving)).toBeTruthy()

    // No discount → no struck price, no saving line.
    expect(within(card('Pro')).queryByTestId('list-price')).toBeNull()
  })

  it('gives the highlighted plan the strong card and the primary button, the others outline', async () => {
    plansApi({ summary: { ...NO_PLAN, trialEligible: false } })
    renderAppRoute('/plans', language)
    await screen.findAllByTestId('plan-card')

    const growth = card('Growth')
    expect(growth.dataset.highlighted).toBe('true')
    expect(growth.querySelector('[data-slot="card"]')!.className).toContain('ring-primary')
    expect(within(growth).getByRole('link', { name: t.contact }).dataset.variant).toBe('default')
    expect(card('Starter').dataset.highlighted).toBeUndefined()
    expect(within(card('Starter')).getByRole('link', { name: t.contact }).dataset.variant).toBe('outline')
    expect(within(card('Pro')).getByRole('link', { name: t.contact }).dataset.variant).toBe('outline')
  })

  it('switches Monthly/Yearly: "Save up to", yearly prices, billed yearly, WhatsApp text names the interval', async () => {
    plansApi({ summary: { ...NO_PLAN, trialEligible: false } })
    renderAppRoute('/plans', language)
    await screen.findAllByTestId('plan-card')

    expect(screen.getByText(t.monthly)).toBeTruthy()
    expect(screen.getByText(t.yearly)).toBeTruthy()
    expect(screen.getByTestId('save-up-to').textContent).toBe(t.saveUpTo)
    const contact = within(card('Growth')).getByRole('link', { name: t.contact })
    expect(contact.getAttribute('href')).toBe(waUrl(t.whatsMonthly))
    expect(contact.getAttribute('target')).toBe('_blank')
    expect(contact.getAttribute('rel')).toContain('noopener')

    const toggle = screen.getByRole('switch', { name: t.switchLabel })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    await waitFor(() => expect(within(card('Starter')).getByText(t.starterYearly)).toBeTruthy())
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(within(card('Starter')).getByTestId('list-price').textContent).toBe(t.starterYearlyList)
    expect(within(card('Starter')).getByText(t.billedYearly)).toBeTruthy()
    // Growth's yearly has no discount: no struck price; Pro has no yearly option.
    expect(within(card('Growth')).queryByTestId('list-price')).toBeNull()
    expect(within(card('Pro')).getByText(t.monthlyOnly)).toBeTruthy()
    expect(within(card('Growth')).getByRole('link', { name: t.contact }).getAttribute('href')).toBe(waUrl(t.whatsYearly))
  })

  it('hides "Save up to" at 0% and every "Contact us" without a WhatsApp number', async () => {
    plansApi({ plans: () => json(200, plansResponse({ yearlySaveUpToPercent: 0, contactWhatsapp: null })), summary: { ...NO_PLAN, trialEligible: false } })
    renderAppRoute('/plans', language)
    await screen.findAllByTestId('plan-card')

    expect(screen.queryByTestId('save-up-to')).toBeNull()
    expect(screen.getByRole('switch', { name: t.switchLabel })).toBeTruthy()
    expect(screen.queryByRole('link', { name: t.contact })).toBeNull()
  })

  it('shows the trial button only while the account is trial-eligible', async () => {
    plansApi()
    renderAppRoute('/plans', language)
    await screen.findAllByTestId('plan-card')

    const starter = card('Starter')
    const button = await within(starter).findByRole('button', { name: t.trial })
    expect(button.dataset.variant).toBe('outline') // Starter isn't the highlighted plan
    expect(within(starter).getByText(t.trialNote)).toBeTruthy()
    expect(within(starter).queryByRole('link', { name: t.contact })).toBeNull()
    expect(within(card('Growth')).getByRole('link', { name: t.contact })).toBeTruthy()
    cleanup()

    plansApi({ summary: { ...NO_PLAN, trialEligible: false } })
    renderAppRoute('/plans', language)
    await screen.findAllByTestId('plan-card')
    expect(screen.queryByRole('button', { name: t.trial })).toBeNull()
    expect(within(card('Starter')).getByRole('link', { name: t.contact })).toBeTruthy()
  })

  it('starts the trial: POST { planId }, summary updated, then /onboarding', async () => {
    plansApi({ trial: () => json(201, billingSummary({ status: 'TRIALING', trialEligible: false })) })
    const { history, queryClient } = renderAppRoute('/plans', language)

    fireEvent.click(await within(await screen.findByRole('listitem', { name: 'Starter' })).findByRole('button', { name: t.trial }))

    await waitFor(() => expect(history.location.pathname).toBe('/onboarding'))
    expect(callsTo(TRIAL)).toEqual([{ path: TRIAL, method: 'POST', body: { planId: 'plan-starter' } }])
    expect(queryClient.getQueryData(['workspace', 'w1', 'billing', 'summary'])).toMatchObject({ status: 'TRIALING' })
    await waitFor(() => expect(callsTo(PAGES).length).toBeGreaterThan(0))
  })

  it('explains a failed trial (409 TRIAL_ALREADY_USED) and refreshes the cards', async () => {
    plansApi({ trial: () => json(409, { statusCode: 409, message: 'used', code: 'TRIAL_ALREADY_USED' }) })
    const { history } = renderAppRoute('/plans', language)

    fireEvent.click(await within(await screen.findByRole('listitem', { name: 'Starter' })).findByRole('button', { name: t.trial }))

    expect((await screen.findByRole('alert')).textContent).toContain(t.trialUsed)
    expect(history.location.pathname).toBe('/plans')
    await waitFor(() => expect(callsTo(PLANS).length).toBe(2))
  })

  it('explains a 403 for an impersonated session', async () => {
    plansApi({ session: IMPERSONATED, trial: () => json(403, { statusCode: 403, message: 'Forbidden' }) })
    renderAppRoute('/plans', language)

    fireEvent.click(await within(await screen.findByRole('listitem', { name: 'Starter' })).findByRole('button', { name: t.trial }))

    // The impersonation banner is a status; the trial error is the only alert.
    expect((await screen.findByRole('alert')).textContent).toContain(t.trialImpersonated)
  })

  it('offers a retry when the plans fail to load', async () => {
    let fail = true
    plansApi({ plans: () => (fail ? json(503, { statusCode: 503, message: 'down' }) : json(200, plansResponse())) })
    renderAppRoute('/plans', language)

    expect((await screen.findByRole('alert')).textContent).toContain(t.loadFailed)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: t.retry }))
    expect(await screen.findAllByTestId('plan-card')).toHaveLength(3)
  })
})
