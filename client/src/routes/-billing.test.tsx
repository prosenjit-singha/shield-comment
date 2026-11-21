import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CouponPreview, PaymentStatusView } from '@/lib/billing'
import type { BillingSummary } from '@/lib/billing-summary'
import { formatDhakaDate } from '@/lib/data-deletion'
import type { PublicPlan, PublicPlansResponse } from '@/lib/plans'
import type { Team } from '@/lib/team'
import { billingSummary, IMPERSONATED, member, renderAppRoute, SESSION, stubAppGlobals, SUMMARY, summaryApi, team, teamApi } from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

const PLANS = '/api/plans'
const COUPON = '/api/workspaces/w1/billing/coupon'
const CHECKOUT = '/api/workspaces/w1/billing/checkout'
const AUTO_RENEW = '/api/workspaces/w1/billing/auto-renew'
const TRAN = 'SCabcdefgh12345678'
const PAYMENT = `/api/workspaces/w1/billing/payments/${TRAN}`
const GATEWAY = 'https://sandbox.sslcommerz.com/EasyCheckOut/abc'

const features: PublicPlan['features'] = {
  banglaAiFilter: true,
  autoHideScams: true,
  customBlocklist: false,
  autoReplyTemplates: false,
  messengerAlerts: false,
  whiteLabelReports: false,
  prioritySupportApi: false,
}

const STARTER: PublicPlan = {
  id: 'plan-starter',
  slug: 'starter',
  name: 'Starter',
  badge: null,
  description: null,
  highlighted: false,
  monthly: { listPerMonthBdt: 999, listChargedBdt: 999, perMonthBdt: 999, chargedBdt: 999, saving: null },
  yearly: { listPerMonthBdt: 949, listChargedBdt: 11388, perMonthBdt: 949, chargedBdt: 11388, saving: null },
  limits: { connectedPages: 1, monthlyComments: 2500, teamSeats: 1, workspaces: 1 },
  features,
  trial: null,
}

const GROWTH: PublicPlan = {
  ...STARTER,
  id: 'plan-growth',
  slug: 'growth',
  name: 'Growth',
  highlighted: true,
  monthly: { listPerMonthBdt: 2499, listChargedBdt: 2499, perMonthBdt: 2499, chargedBdt: 2499, saving: null },
  yearly: null,
  limits: { connectedPages: 5, monthlyComments: 15000, teamSeats: 3, workspaces: 3 },
}

const PLANS_RESPONSE: PublicPlansResponse = { items: [STARTER, GROWTH], yearlySaveUpToPercent: 5, contactWhatsapp: null }

const PREVIEW: CouponPreview = {
  price: {
    listChargedBdt: 2499,
    chargedBdt: 1999,
    perMonthBdt: 1999,
    discount: null,
    coupon: { name: 'Eid', code: 'EID500', label: '৳500 off', labelBn: '৳৫০০ ছাড়', amountBdt: 500, months: null },
    creditBdt: 300,
  },
  amountBdt: 1699,
}

const paymentStatus = (status: PaymentStatusView['status']): PaymentStatusView => ({
  tranId: TRAN,
  status,
  amountBdt: 999,
  kind: 'NEW',
  planId: 'plan-starter',
  interval: 'month',
  paidAt: status === 'PAID' ? '2026-11-21T08:00:00.000Z' : null,
  invoiceNumber: status === 'PAID' ? 'SC-2026-00001' : null,
})

const DUE = '2026-12-15T18:00:00.000Z'
const NO_PLAN: Partial<BillingSummary> = {
  plan: null,
  interval: null,
  status: 'NONE',
  termEndsAt: null,
  renewal: null,
  comments: { used: 0, limit: 0, resetsAt: null },
}

type Body = Record<string, unknown>

interface ApiOptions {
  summary?: BillingSummary
  session?: unknown
  team?: Team
  coupon?: (body: Body) => Response
  checkout?: (body: Body) => Response
  autoRenew?: (method: string, body: Body | null) => Response
  payment?: () => Response
}

/** `_app` shell + `/billing`; every other request (and an unset handler) fails the test. */
function billingApi(options: ApiOptions = {}) {
  let summary = options.summary ?? billingSummary()
  const post = (path: string, handler: ((body: Body) => Response) | undefined) => (init?: RequestInit) => {
    if (init?.method !== 'POST' || !handler) throw new Error(`Unexpected call ${path}`)
    return handler(JSON.parse(String(init.body)) as Body)
  }
  mockApi({
    '/api/auth/get-session': () => json(200, options.session ?? SESSION),
    ...summaryApi(() => json(200, summary)),
    ...teamApi(options.team ?? team()),
    [PLANS]: () => json(200, PLANS_RESPONSE),
    [COUPON]: post(COUPON, options.coupon),
    [CHECKOUT]: post(CHECKOUT, (body) => {
      if (!options.checkout) throw new Error('Unexpected checkout')
      const response = options.checkout(body)
      if (response.ok) summary = billingSummary({ status: 'ACTIVE' })
      return response
    }),
    [AUTO_RENEW]: (init) => {
      if (!options.autoRenew) throw new Error('Unexpected auto-renew call')
      const method = (init?.method ?? 'GET').toUpperCase()
      return options.autoRenew(method, typeof init?.body === 'string' ? (JSON.parse(init.body) as Body) : null)
    },
    [PAYMENT]: () => {
      if (!options.payment) throw new Error('Unexpected payment status call')
      return options.payment()
    },
  })
}

const copy = {
  en: {
    title: 'Billing',
    statuses: { TRIALING: 'Trial', ACTIVE: 'Active', EXPIRED: 'Expired', CANCELED: 'Canceled', NONE: 'No plan' },
    monthly: 'Monthly',
    paidUntil: (d: string) => `Paid until ${d}`,
    trialEnds: (d: string) => `Trial ends ${d}`,
    ended: (d: string) => `Ended ${d}`,
    noPlanYet: 'You haven’t picked a plan yet.',
    usage: '120 / 2,500',
    noAllowance: 'No allowance without an active plan',
    renewalClosed: (d: string) => `Renewal opens 7 days before ${d}.`,
    renew: 'Renew',
    noGrace: 'If the term ends unpaid, moderation pauses at once. Nothing is deleted.',
    trialToPaid: 'Paying now ends the trial: your paid term starts today with the plan’s full limits.',
    paused: 'Moderation is paused. Choose a plan and pay to turn it back on. Nothing was deleted.',
    scheduled: (d: string) => `Switches to Growth (Monthly) on ${d}. Already paid.`,
    pending: `A payment of ৳999 is in progress (transaction ${TRAN}). If you closed the payment page, it’s cancelled after 60 minutes.`,
    choose: (name: string) => `Choose ${name}`,
    selected: 'Selected',
    current: 'Your current plan',
    couponLabel: 'Coupon code',
    apply: 'Apply',
    pay: 'Pay with bKash / Nagad / card',
    checkoutPlan: 'Growth · Monthly · ৳2,499',
    renewPlan: 'Starter · Yearly · ৳11,388',
    lines: { list: '৳2,499', coupon: '− ৳500', credit: '− ৳300', total: '৳1,699' },
    couponErrors: {
      COUPON_NOT_FOUND: 'This coupon code doesn’t exist.',
      COUPON_EXPIRED: 'This coupon has expired.',
      COUPON_NOT_FOR_PLAN: 'This coupon isn’t valid for this plan.',
      COUPON_ALREADY_USED: 'Your account has already used this coupon.',
      COUPON_USED_UP: 'This coupon has been fully claimed.',
    },
    checkoutErrors: [
      [409, 'RENEWAL_NOT_OPEN', 'Renewal opens 7 days before your current term ends.'],
      [409, 'PLAN_CHANGE_AT_RENEWAL', 'A smaller plan or monthly billing can only be picked in the 7 days before your renewal.'],
      [409, 'PLAN_CHANGE_SCHEDULED', 'Your next term is already paid. Nothing more to pay now.'],
      [400, 'AMOUNT_TOO_LOW', 'Online payments start at ৳10.'],
      [503, 'PAYMENTS_NOT_CONFIGURED', 'Online payments aren’t available yet. Please contact support.'],
      [502, 'PAYMENT_GATEWAY_ERROR', 'The payment gateway didn’t respond. Try again in a few minutes.'],
    ],
    returns: {
      success: 'Payment received. Your plan is active.',
      failed: 'The payment didn’t go through, so nothing changed. You can try again.',
      cancelled: 'You cancelled the payment. Nothing was charged.',
      confirming: 'Confirming your payment…',
      slow: 'Still confirming your payment.',
    },
    dismiss: 'Dismiss',
    ownerOnly: 'Only the workspace owner can pay or change the plan.',
    impersonated: 'Billing is read-only',
    autoRenew: 'Auto-renew',
    autoRenewCopy: 'We charge it in the 24 hours before your term ends, with one retry.',
    removeCard: 'Remove saved card',
    cardSaved: 'A card or wallet is saved.',
    autoRenewUnavailable: 'Auto-renew isn’t available right now.',
  },
  bn: {
    title: 'বিলিং',
    statuses: { TRIALING: 'ট্রায়াল', ACTIVE: 'চালু', EXPIRED: 'মেয়াদ শেষ', CANCELED: 'বাতিল', NONE: 'কোনো প্ল্যান নেই' },
    monthly: 'মাসিক',
    paidUntil: (d: string) => `${d} পর্যন্ত পেমেন্ট করা আছে`,
    trialEnds: (d: string) => `ট্রায়াল শেষ হবে ${d}`,
    ended: (d: string) => `${d} তারিখে শেষ হয়েছে`,
    noPlanYet: 'আপনি এখনো কোনো প্ল্যান বেছে নেননি।',
    usage: '১২০ / ২,৫০০',
    noAllowance: 'চালু প্ল্যান ছাড়া কোনো কমেন্ট নেই',
    renewalClosed: (d: string) => `${d} এর ৭ দিন আগে থেকে রিনিউ করা যাবে।`,
    renew: 'রিনিউ করুন',
    noGrace: 'পেমেন্ট ছাড়া মেয়াদ শেষ হলে সাথে সাথে মডারেশন বন্ধ হবে। কিছুই মুছে যাবে না।',
    trialToPaid: 'এখন পেমেন্ট করলে ট্রায়াল শেষ হবে: পেইড মেয়াদ আজ থেকেই প্ল্যানের পুরো লিমিট নিয়ে শুরু হবে।',
    paused: 'মডারেশন বন্ধ আছে। আবার চালু করতে একটি প্ল্যান বেছে পেমেন্ট করুন। কিছুই মুছে যায়নি।',
    scheduled: (d: string) => `${d} তারিখে Growth (মাসিক) প্ল্যানে বদলে যাবে। পেমেন্ট হয়ে গেছে।`,
    pending: `৳৯৯৯ এর একটি পেমেন্ট চলছে (ট্রানজেকশন ${TRAN})। পেমেন্ট পেজ বন্ধ করে থাকলে ৬০ মিনিট পরে এটি বাতিল হয়ে যাবে।`,
    choose: (name: string) => `${name} বেছে নিন`,
    selected: 'বাছাই করা হয়েছে',
    current: 'আপনার বর্তমান প্ল্যান',
    couponLabel: 'কুপন কোড',
    apply: 'প্রয়োগ করুন',
    pay: 'বিকাশ / নগদ / কার্ডে পেমেন্ট করুন',
    checkoutPlan: 'Growth · মাসিক · ৳২,৪৯৯',
    renewPlan: 'Starter · বার্ষিক · ৳১১,৩৮৮',
    lines: { list: '৳২,৪৯৯', coupon: '− ৳৫০০', credit: '− ৳৩০০', total: '৳১,৬৯৯' },
    couponErrors: {
      COUPON_NOT_FOUND: 'এই কুপন কোডটি নেই।',
      COUPON_EXPIRED: 'এই কুপনের মেয়াদ শেষ।',
      COUPON_NOT_FOR_PLAN: 'এই কুপনটি এই প্ল্যানের জন্য নয়।',
      COUPON_ALREADY_USED: 'আপনার অ্যাকাউন্টে এই কুপন আগেই ব্যবহার করা হয়েছে।',
      COUPON_USED_UP: 'এই কুপনের সব সুযোগ শেষ হয়ে গেছে।',
    },
    checkoutErrors: [
      [409, 'RENEWAL_NOT_OPEN', 'বর্তমান মেয়াদ শেষ হওয়ার ৭ দিন আগে থেকে রিনিউ করা যাবে।'],
      [409, 'PLAN_CHANGE_AT_RENEWAL', 'ছোট প্ল্যান বা মাসিক বিল শুধু রিনিউয়ের আগের ৭ দিনে বেছে নেওয়া যায়।'],
      [409, 'PLAN_CHANGE_SCHEDULED', 'আপনার পরের মেয়াদের পেমেন্ট হয়ে গেছে। এখন আর কিছু দিতে হবে না।'],
      [400, 'AMOUNT_TOO_LOW', 'অনলাইন পেমেন্ট কমপক্ষে ৳১০ হতে হবে।'],
      [503, 'PAYMENTS_NOT_CONFIGURED', 'অনলাইন পেমেন্ট এখনো চালু হয়নি। সাপোর্টে যোগাযোগ করুন।'],
      [502, 'PAYMENT_GATEWAY_ERROR', 'পেমেন্ট গেটওয়ে সাড়া দেয়নি। কয়েক মিনিট পরে আবার চেষ্টা করুন।'],
    ],
    returns: {
      success: 'পেমেন্ট পাওয়া গেছে। আপনার প্ল্যান চালু হয়েছে।',
      failed: 'পেমেন্ট সম্পন্ন হয়নি, তাই কিছুই বদলায়নি। আবার চেষ্টা করতে পারেন।',
      cancelled: 'আপনি পেমেন্ট বাতিল করেছেন। কোনো টাকা কাটা হয়নি।',
      confirming: 'আপনার পেমেন্ট নিশ্চিত করা হচ্ছে…',
      slow: 'পেমেন্ট এখনো নিশ্চিত করা হচ্ছে।',
    },
    dismiss: 'বন্ধ করুন',
    ownerOnly: 'শুধু ওয়ার্কস্পেসের মালিক পেমেন্ট বা প্ল্যান পরিবর্তন করতে পারেন।',
    impersonated: 'বিলিং শুধু দেখা যাবে',
    autoRenew: 'অটো-রিনিউ',
    autoRenewCopy: 'মেয়াদ শেষ হওয়ার আগের ২৪ ঘণ্টায় আমরা চার্জ করব, একবার আবার চেষ্টা সহ।',
    removeCard: 'সেভ করা কার্ড মুছুন',
    cardSaved: 'একটি কার্ড বা ওয়ালেট সেভ করা আছে।',
    autoRenewUnavailable: 'অটো-রিনিউ এখন চালু নেই।',
  },
} as const

const card = (name: string) => screen.getByRole('listitem', { name })
const notice = (kind: string) => document.querySelector<HTMLElement>(`[data-kind="${kind}"]`)
const error = (status: number, code: string) => json(status, { statusCode: status, message: code, code })
const MODERATOR = team({ members: [member({ role: 'moderator' })] })
const ADMIN = team({ members: [member({ role: 'admin' })] })

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/billing (%s)', (language) => {
  const t = copy[language]
  const day = (iso: string) => formatDhakaDate(iso, language)
  const summaryCard = async () => screen.findByTestId('billing-summary')

  it('shows an active paid plan: status, interval, term end from renewal.dueAt, comments bar, renewal closed, D5 note', async () => {
    billingApi({ summary: billingSummary({ termEndsAt: '2026-12-01T00:00:00.000Z', renewal: { dueAt: DUE, canRenew: false } }) })
    renderAppRoute('/billing', language)

    expect(await screen.findByRole('heading', { level: 1, name: t.title })).toBeTruthy()
    const summary = await summaryCard()
    expect(within(summary).getByRole('heading', { level: 2 }).textContent).toBe('Starter')
    expect(within(summary).getByTestId('billing-status').textContent).toBe(t.statuses.ACTIVE)
    expect(within(summary).getByText(t.monthly)).toBeTruthy()
    expect(within(summary).getByTestId('billing-term').textContent).toBe(t.paidUntil(day(DUE)))
    expect(within(summary).getByText(t.usage)).toBeTruthy()
    expect(within(summary).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('5')
    expect(within(summary).getByTestId('renewal-closed').textContent).toBe(t.renewalClosed(day(DUE)))
    expect(within(summary).queryByRole('button', { name: t.renew })).toBeNull()
    expect(within(summary).getByText(t.noGrace)).toBeTruthy()
    expect(within(await screen.findByRole('listitem', { name: 'Starter' })).getByText(t.current)).toBeTruthy()
    // Auto-renew is off by default (flag off): no card.
    expect(screen.queryByTestId('auto-renew')).toBeNull()
  })

  it('shows every other summary status', async () => {
    const cases: [BillingSummary, string, string, string][] = [
      [
        billingSummary({ status: 'TRIALING', interval: null, trialEndsAt: DUE, termEndsAt: DUE, renewal: null }),
        t.statuses.TRIALING,
        t.trialEnds(day(DUE)),
        t.trialToPaid,
      ],
      [billingSummary({ status: 'EXPIRED', renewal: null, comments: { used: 0, limit: 0, resetsAt: null } }), t.statuses.EXPIRED, t.ended(day(DUE)), t.paused],
      [billingSummary({ status: 'CANCELED', renewal: null, comments: { used: 0, limit: 0, resetsAt: null } }), t.statuses.CANCELED, t.ended(day(DUE)), t.paused],
      [billingSummary(NO_PLAN), t.statuses.NONE, t.noPlanYet, t.paused],
    ]
    for (const [summary, status, term, note] of cases) {
      billingApi({ summary })
      renderAppRoute('/billing', language)
      const box = await summaryCard()
      expect(within(box).getByTestId('billing-status').textContent).toBe(status)
      expect(within(box).getByTestId('billing-term').textContent).toBe(term)
      expect(within(box).getByText(note)).toBeTruthy()
      if (summary.comments.limit === 0) expect(within(box).getByText(t.noAllowance)).toBeTruthy()
      cleanup()
    }
  })

  it('renew window: Renew picks the current plan + interval and pays it', async () => {
    const location = { assign: vi.fn() }
    billingApi({
      summary: billingSummary({ interval: 'year', renewal: { dueAt: DUE, canRenew: true } }),
      checkout: () => json(201, { tranId: TRAN, gatewayUrl: GATEWAY }),
    })
    renderAppRoute('/billing', language)
    await screen.findAllByTestId('plan-card')

    const renewal = await waitFor(() => notice('renewal-open')!)
    fireEvent.click(within(renewal).getByRole('button', { name: t.renew }))

    expect(within(card('Starter')).getByRole('button', { name: t.selected }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('checkout-plan').textContent).toBe(t.renewPlan)
    vi.stubGlobal('location', location)
    fireEvent.click(screen.getByRole('button', { name: t.pay }))

    await waitFor(() => expect(location.assign).toHaveBeenCalledWith(GATEWAY))
    expect(callsTo(CHECKOUT)).toEqual([{ path: CHECKOUT, method: 'POST', body: { planId: 'plan-starter', interval: 'year' } }])
  })

  it('shows the scheduled change and the pending payment, and hides Renew while a change is scheduled', async () => {
    billingApi({
      summary: billingSummary({
        renewal: { dueAt: DUE, canRenew: false },
        scheduled: { planId: 'plan-growth', planName: 'Growth', interval: 'month', startsAt: DUE },
        pendingPayment: { tranId: TRAN, amountBdt: 999, createdAt: '2026-11-21T08:00:00.000Z' },
      }),
    })
    renderAppRoute('/billing', language)
    await summaryCard()

    expect(notice('scheduled')!.textContent).toBe(t.scheduled(day(DUE)))
    expect(notice('pending-payment')!.textContent).toBe(t.pending)
    expect(screen.queryByTestId('renewal-closed')).toBeNull()
    expect(notice('renewal-open')).toBeNull()
  })

  it('previews a coupon (price lines) and sends it with the checkout, then goes to SSLCommerz', async () => {
    const location = { assign: vi.fn() }
    billingApi({ coupon: () => json(200, PREVIEW), checkout: () => json(201, { tranId: TRAN, gatewayUrl: GATEWAY }) })
    renderAppRoute('/billing', language)

    fireEvent.click(await within(await screen.findByRole('listitem', { name: 'Growth' })).findByRole('button', { name: t.choose('Growth') }))
    expect(screen.getByTestId('checkout-plan').textContent).toBe(t.checkoutPlan)
    fireEvent.change(screen.getByLabelText(t.couponLabel), { target: { value: ' EID500 ' } })
    fireEvent.click(screen.getByRole('button', { name: t.apply }))

    const lines = await screen.findByTestId('price-lines')
    const line = (key: string) => lines.querySelector(`[data-line="${key}"] dd`)!.textContent
    expect(line('list')).toBe(t.lines.list)
    expect(line('coupon')).toBe(t.lines.coupon)
    expect(line('credit')).toBe(t.lines.credit)
    expect(line('total')).toBe(t.lines.total)
    expect(lines.querySelector('[data-line="discount"]')).toBeNull()
    expect(callsTo(COUPON)).toEqual([{ path: COUPON, method: 'POST', body: { planId: 'plan-growth', interval: 'month', code: 'EID500' } }])

    vi.stubGlobal('location', location)
    fireEvent.click(screen.getByRole('button', { name: t.pay }))
    await waitFor(() => expect(location.assign).toHaveBeenCalledWith(GATEWAY))
    expect(callsTo(CHECKOUT)[0]!.body).toEqual({ planId: 'plan-growth', interval: 'month', couponCode: 'EID500' })
  })

  it('explains every coupon error', async () => {
    let code = ''
    billingApi({ coupon: () => error(400, code) })
    renderAppRoute('/billing', language)
    fireEvent.click(await within(await screen.findByRole('listitem', { name: 'Starter' })).findByRole('button', { name: t.choose('Starter') }))

    for (const [next, message] of Object.entries(t.couponErrors)) {
      code = next
      fireEvent.change(screen.getByLabelText(t.couponLabel), { target: { value: next } })
      fireEvent.click(screen.getByRole('button', { name: t.apply }))
      await waitFor(() => expect(within(screen.getByTestId('checkout')).getByRole('alert').textContent).toBe(message))
    }
    expect(screen.queryByTestId('price-lines')).toBeNull()
  })

  it('explains every checkout error code', async () => {
    let next: readonly [number, string, string] = t.checkoutErrors[0]
    billingApi({ checkout: () => error(next[0], next[1]) })
    renderAppRoute('/billing', language)
    fireEvent.click(await within(await screen.findByRole('listitem', { name: 'Starter' })).findByRole('button', { name: t.choose('Starter') }))

    for (const item of t.checkoutErrors) {
      next = item
      fireEvent.click(screen.getByRole('button', { name: t.pay }))
      await waitFor(() => expect(notice('checkout-error')?.textContent).toBe(item[2]))
    }
    expect(callsTo(CHECKOUT)).toHaveLength(t.checkoutErrors.length)
  })

  it('৳0 checkout: no gateway, success state with the tran id and a fresh summary', async () => {
    const location = { assign: vi.fn() }
    billingApi({ summary: billingSummary(NO_PLAN), checkout: () => json(201, { tranId: TRAN, paid: true }) })
    const { history } = renderAppRoute('/billing', language)
    fireEvent.click(await within(await screen.findByRole('listitem', { name: 'Starter' })).findByRole('button', { name: t.choose('Starter') }))
    vi.stubGlobal('location', location)
    fireEvent.click(screen.getByRole('button', { name: t.pay }))

    await waitFor(() => expect(notice('payment:success')).not.toBeNull())
    expect(notice('payment:success')!.textContent).toContain(t.returns.success)
    expect(notice('payment:success')!.textContent).toContain(TRAN)
    expect(history.location.search).toContain('payment=success')
    expect(location.assign).not.toHaveBeenCalled()
    await waitFor(() => expect(within(screen.getByTestId('billing-summary')).getByTestId('billing-status').textContent).toBe(t.statuses.ACTIVE))
  })

  it.each(['success', 'failed', 'cancelled'] as const)('return ?payment=%s shows its message without polling; Dismiss clears it', async (payment) => {
    billingApi()
    const { history } = renderAppRoute(`/billing?payment=${payment}&tranId=${TRAN}`, language)

    await waitFor(() => expect(notice(`payment:${payment}`)).not.toBeNull())
    expect(notice(`payment:${payment}`)!.textContent).toContain(t.returns[payment])
    expect(notice(`payment:${payment}`)!.textContent).toContain(TRAN)
    fireEvent.click(within(notice(`payment:${payment}`)!).getByRole('button', { name: t.dismiss }))
    await waitFor(() => expect(history.location.search).toBe(''))
    expect(callsTo(PAYMENT)).toHaveLength(0)
  })

  it('drops a malformed return (unknown payment value, bad tran id)', async () => {
    billingApi()
    renderAppRoute('/billing?payment=weird&tranId=x', language)
    await summaryCard()
    expect(document.querySelector('[data-kind^="payment:"]')).toBeNull()
  })

  it('return ?payment=pending polls the payment until PAID', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let status: PaymentStatusView['status'] = 'PENDING'
    billingApi({ payment: () => json(200, paymentStatus(status)) })
    renderAppRoute(`/billing?payment=pending&tranId=${TRAN}`, language)

    await waitFor(() => expect(notice('payment:confirming')).not.toBeNull())
    expect(notice('payment:confirming')!.textContent).toContain(t.returns.confirming)
    await waitFor(() => expect(callsTo(PAYMENT)).toHaveLength(1))
    const summaries = callsTo(SUMMARY).length
    status = 'PAID'
    await act(() => vi.advanceTimersByTimeAsync(3000))

    await waitFor(() => expect(notice('payment:success')).not.toBeNull())
    expect(callsTo(PAYMENT)).toHaveLength(2)
    await waitFor(() => expect(callsTo(SUMMARY).length).toBeGreaterThan(summaries))
  })

  it('return ?payment=pending shows a failure when the payment fails, and stops after 20 tries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let status: PaymentStatusView['status'] = 'FAILED'
    billingApi({ payment: () => json(200, paymentStatus(status)) })
    renderAppRoute(`/billing?payment=pending&tranId=${TRAN}`, language)
    await waitFor(() => expect(notice('payment:failed')).not.toBeNull())
    cleanup()

    status = 'PENDING'
    billingApi({ payment: () => json(200, paymentStatus(status)) })
    renderAppRoute(`/billing?payment=pending&tranId=${TRAN}`, language)
    await waitFor(() => expect(callsTo(PAYMENT).length).toBeGreaterThan(1))
    for (let i = 0; i < 25; i++) await act(() => vi.advanceTimersByTimeAsync(3000))

    await waitFor(() => expect(notice('payment:slow')).not.toBeNull())
    expect(notice('payment:slow')!.textContent).toContain(t.returns.slow)
    const fetched = callsTo(PAYMENT).length
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(callsTo(PAYMENT).length).toBe(fetched)
  })

  it.each([
    ['moderator', MODERATOR],
    ['admin', ADMIN],
  ] as const)('a %s reads everything without pay buttons', async (_role, members) => {
    billingApi({ team: members, summary: billingSummary({ renewal: { dueAt: DUE, canRenew: true }, autoRenew: { available: true, enabled: true, tokenSaved: true } }) })
    renderAppRoute('/billing', language)

    await waitFor(() => expect(notice('owner-only')!.textContent).toBe(t.ownerOnly))
    await screen.findAllByTestId('plan-card')
    expect(screen.queryByRole('button', { name: t.choose('Starter') })).toBeNull()
    expect(screen.queryByTestId('checkout')).toBeNull()
    expect(within(notice('renewal-open')!).queryByRole('button', { name: t.renew })).toBeNull()
    expect(screen.getByRole('switch', { name: t.autoRenew }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: t.removeCard })).toBeNull()
  })

  it('an impersonated session (the owner) is read-only', async () => {
    billingApi({ session: IMPERSONATED, summary: billingSummary({ renewal: { dueAt: DUE, canRenew: true }, autoRenew: { available: true, enabled: false, tokenSaved: true } }) })
    renderAppRoute('/billing', language)

    await waitFor(() => expect(notice('impersonation-read-only')!.textContent).toContain(t.impersonated))
    await screen.findAllByTestId('plan-card')
    await waitFor(() => expect(callsTo('/api/workspaces/w1/team')).toHaveLength(1))
    expect(screen.queryByRole('button', { name: t.choose('Starter') })).toBeNull()
    expect(within(notice('renewal-open')!).queryByRole('button', { name: t.renew })).toBeNull()
    expect(screen.getByRole('switch', { name: t.autoRenew }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: t.removeCard })).toBeNull()
  })

  it('auto-renew: turns on and off (PUT), removes the saved card (DELETE)', async () => {
    let state = { available: true, enabled: false, tokenSaved: true }
    billingApi({
      summary: billingSummary({ autoRenew: state }),
      autoRenew: (method, body) => {
        state = method === 'PUT' ? { ...state, enabled: body?.enabled === true } : { ...state, enabled: false, tokenSaved: false }
        return json(200, state)
      },
    })
    renderAppRoute('/billing', language)

    const box = await screen.findByTestId('auto-renew')
    expect(within(box).getByText(t.autoRenewCopy, { exact: false })).toBeTruthy()
    expect(within(box).getByText(t.cardSaved)).toBeTruthy()
    const toggle = await waitFor(() => {
      const element = within(box).getByRole('switch', { name: t.autoRenew })
      expect(element.hasAttribute('disabled')).toBe(false)
      return element
    })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))

    fireEvent.click(within(box).getByRole('button', { name: t.removeCard }))
    await waitFor(() => expect(within(box).queryByText(t.cardSaved)).toBeNull())
    expect(callsTo(AUTO_RENEW)).toEqual([
      { path: AUTO_RENEW, method: 'PUT', body: { enabled: true } },
      { path: AUTO_RENEW, method: 'PUT', body: { enabled: false } },
      { path: AUTO_RENEW, method: 'DELETE', body: undefined },
    ])
  })

  it('auto-renew 409 AUTO_RENEW_UNAVAILABLE: message and a fresh summary', async () => {
    billingApi({ summary: billingSummary({ autoRenew: { available: true, enabled: false, tokenSaved: false } }), autoRenew: () => error(409, 'AUTO_RENEW_UNAVAILABLE') })
    renderAppRoute('/billing', language)

    const box = await screen.findByTestId('auto-renew')
    const toggle = await waitFor(() => {
      const element = within(box).getByRole('switch', { name: t.autoRenew })
      expect(element.hasAttribute('disabled')).toBe(false)
      return element
    })
    const summaries = callsTo(SUMMARY).length
    fireEvent.click(toggle)
    await waitFor(() => expect(notice('auto-renew-error')!.textContent).toBe(t.autoRenewUnavailable))
    await waitFor(() => expect(callsTo(SUMMARY).length).toBeGreaterThan(summaries))
    expect(within(box).queryByRole('button', { name: t.removeCard })).toBeNull()
  })
})
