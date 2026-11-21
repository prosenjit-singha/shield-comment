import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import type { AutoRenewView, SubscriptionInterval } from '@/lib/billing-summary'

/**
 * C10 `/billing` calls (M8-T4 / T5 / T6b backend; D2 owner pays, owner + admin read payments,
 * impersonated 403 `IMPERSONATION_READ_ONLY`). Mirrors `backend/src/billing/checkout.service.ts`,
 * `dto/checkout.dto.ts` and `db/schema/payments.ts` (`PaymentPrice`).
 */

export interface PricePromotion {
  name: string
  /** COUPON only. */
  code: string | null
  label: string
  labelBn: string
  amountBdt: number
  months: { from: number; to: number; of: number } | null
}

export interface PaymentPrice {
  listChargedBdt: number
  chargedBdt: number
  perMonthBdt: number
  discount: PricePromotion | null
  coupon: PricePromotion | null
  /** D7: unused part of the current paid term taken off an upgrade. */
  creditBdt: number
}

/** `POST …/billing/coupon` 200. */
export interface CouponPreview {
  price: PaymentPrice
  /** What the checkout would charge. */
  amountBdt: number
}

/** `POST …/billing/checkout` 201: off to SSLCommerz, or ৳0 after promotions = already paid. */
export type CheckoutResult = { tranId: string; gatewayUrl: string } | { tranId: string; paid: true }

export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'REFUNDED'

export interface PaymentStatusView {
  tranId: string
  status: PaymentStatus
  amountBdt: number
  kind: 'NEW' | 'RENEWAL' | 'UPGRADE'
  planId: string
  interval: SubscriptionInterval
  paidAt: string | null
  invoiceNumber: string | null
}

export interface CheckoutInput {
  planId: string
  interval: SubscriptionInterval
  couponCode?: string
}

const billingPath = (workspaceId: string, rest: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/billing/${rest}`

export const previewCoupon = (workspaceId: string, input: CheckoutInput & { code: string }) =>
  apiFetch<CouponPreview>(billingPath(workspaceId, 'coupon'), {
    method: 'POST',
    body: { planId: input.planId, interval: input.interval, code: input.code },
  })

export const startCheckout = (workspaceId: string, input: CheckoutInput) =>
  apiFetch<CheckoutResult>(billingPath(workspaceId, 'checkout'), { method: 'POST', body: input })

export const setAutoRenew = (workspaceId: string, enabled: boolean) =>
  apiFetch<AutoRenewView>(billingPath(workspaceId, 'auto-renew'), { method: 'PUT', body: { enabled } })

export const removeSavedCard = (workspaceId: string) =>
  apiFetch<AutoRenewView>(billingPath(workspaceId, 'auto-renew'), { method: 'DELETE' })

/** The return page polls every 3 s, at most 20 times (~1 min), while the payment is PENDING. */
export const PAYMENT_POLL_MS = 3000
export const PAYMENT_POLL_MAX = 20

export function paymentStatusQueryOptions(workspaceId: string, tranId: string) {
  return queryOptions({
    queryKey: ['workspace', workspaceId, 'billing', 'payment', tranId] as const,
    queryFn: () => apiFetch<PaymentStatusView>(billingPath(workspaceId, `payments/${encodeURIComponent(tranId)}`)),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.status === 'PENDING' && query.state.dataUpdateCount < PAYMENT_POLL_MAX ? PAYMENT_POLL_MS : false,
  })
}

/** SSLCommerz sends the browser off the page; a function so tests can stub `location`. */
export function goToGateway(url: string): void {
  window.location.assign(url)
}

/** M8-T5 return: `?payment=success|failed|cancelled|pending&tranId=`. */
export const PAYMENT_RETURNS = ['success', 'failed', 'cancelled', 'pending'] as const
export type PaymentReturn = (typeof PAYMENT_RETURNS)[number]

export interface BillingSearch {
  payment?: PaymentReturn
  tranId?: string
}

const TRAN_ID_PATTERN = /^[A-Za-z0-9_-]{8,30}$/

/** Every key is returned (`undefined` when invalid): the router merges raw params under this. */
export function validateBillingSearch(search: Record<string, unknown>): BillingSearch {
  const { payment, tranId } = search
  return {
    payment: PAYMENT_RETURNS.find((value) => value === payment),
    tranId: typeof tranId === 'string' && TRAN_ID_PATTERN.test(tranId) ? tranId : undefined,
  }
}

/**
 * Why a coupon preview or checkout failed (M8-T4 codes + `COUPON_*`), en + bn. A 403 is an
 * impersonated session or a non-owner (D2).
 */
export function checkoutErrorMessage(error: ApiError, content: ContentFn, impersonated: boolean): string {
  if (error.isNetwork) return content('Can’t reach the server. Check your connection and try again.', 'সার্ভারে সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।')
  if (error.status === 403)
    return impersonated
      ? content('Payments aren’t allowed while impersonating. The owner has to pay.', 'ইমপারসোনেশনের সময় পেমেন্ট করা যায় না। মালিককে নিজে পেমেন্ট করতে হবে।')
      : content('Only the workspace owner can pay.', 'শুধু ওয়ার্কস্পেসের মালিক পেমেন্ট করতে পারেন।')
  if (error.status === 429) return content('Too many attempts. Wait a few minutes and try again.', 'অনেকবার চেষ্টা করা হয়েছে। কয়েক মিনিট পরে আবার চেষ্টা করুন।')
  switch (error.code) {
    case 'COUPON_NOT_FOUND':
      return content('This coupon code doesn’t exist.', 'এই কুপন কোডটি নেই।')
    case 'COUPON_EXPIRED':
      return content('This coupon has expired.', 'এই কুপনের মেয়াদ শেষ।')
    case 'COUPON_NOT_FOR_PLAN':
      return content('This coupon isn’t valid for this plan.', 'এই কুপনটি এই প্ল্যানের জন্য নয়।')
    case 'COUPON_ALREADY_USED':
      return content('Your account has already used this coupon.', 'আপনার অ্যাকাউন্টে এই কুপন আগেই ব্যবহার করা হয়েছে।')
    case 'COUPON_USED_UP':
      return content('This coupon has been fully claimed.', 'এই কুপনের সব সুযোগ শেষ হয়ে গেছে।')
    case 'RENEWAL_NOT_OPEN':
      return content('Renewal opens 7 days before your current term ends.', 'বর্তমান মেয়াদ শেষ হওয়ার ৭ দিন আগে থেকে রিনিউ করা যাবে।')
    case 'PLAN_CHANGE_AT_RENEWAL':
      return content(
        'A smaller plan or monthly billing can only be picked in the 7 days before your renewal.',
        'ছোট প্ল্যান বা মাসিক বিল শুধু রিনিউয়ের আগের ৭ দিনে বেছে নেওয়া যায়।',
      )
    case 'PLAN_CHANGE_SCHEDULED':
      return content('Your next term is already paid. Nothing more to pay now.', 'আপনার পরের মেয়াদের পেমেন্ট হয়ে গেছে। এখন আর কিছু দিতে হবে না।')
    case 'AMOUNT_TOO_LOW':
      return content('Online payments start at ৳10.', 'অনলাইন পেমেন্ট কমপক্ষে ৳১০ হতে হবে।')
    case 'PAYMENTS_NOT_CONFIGURED':
      return content('Online payments aren’t available yet. Please contact support.', 'অনলাইন পেমেন্ট এখনো চালু হয়নি। সাপোর্টে যোগাযোগ করুন।')
    case 'PAYMENT_GATEWAY_ERROR':
      return content('The payment gateway didn’t respond. Try again in a few minutes.', 'পেমেন্ট গেটওয়ে সাড়া দেয়নি। কয়েক মিনিট পরে আবার চেষ্টা করুন।')
    case 'NO_BILLING_ACCOUNT':
      return content('This workspace isn’t linked to a billing account. Contact support.', 'এই ওয়ার্কস্পেসটি কোনো বিলিং অ্যাকাউন্টের সাথে যুক্ত নয়। সাপোর্টে যোগাযোগ করুন।')
    case 'PLAN_NOT_AVAILABLE':
      return content('This plan is no longer available.', 'এই প্ল্যানটি এখন আর পাওয়া যাচ্ছে না।')
    case 'YEARLY_PRICE_MISSING':
      return content('This plan has no yearly option.', 'এই প্ল্যানে বার্ষিক বিল নেই।')
    default:
      return content('Something went wrong. Please try again.', 'কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।')
  }
}

/** `PUT` / `DELETE …/billing/auto-renew` failures (409 `AUTO_RENEW_UNAVAILABLE` while the flag is off). */
export function autoRenewErrorMessage(error: ApiError, content: ContentFn): string {
  if (error.code === 'AUTO_RENEW_UNAVAILABLE') return content('Auto-renew isn’t available right now.', 'অটো-রিনিউ এখন চালু নেই।')
  if (error.isNetwork) return content('Can’t reach the server. Check your connection and try again.', 'সার্ভারে সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।')
  return content('Couldn’t save auto-renew. Please try again.', 'অটো-রিনিউ সেভ করা যায়নি। আবার চেষ্টা করুন।')
}
