import type { SubscriptionInterval, SubscriptionStatus } from '@/lib/admin-clients'
import { type AdminPlan, formatPlanPrice, yearlyChargeBdt } from '@/lib/admin-plans'
import { apiFetch } from '@/lib/api'

/**
 * Admin "Activate plan" (PW-T9, PW-D16): `POST /api/admin/clients/:workspaceId/subscription`.
 * The start date is an Asia/Dhaka calendar day from 31 days ago to today; the term runs from
 * 00:00 Dhaka that day for 1 month / 1 year (day clamped to the month end, like the backend).
 */

export const ACTIVATION_MAX_DAYS_BACK = 31

export interface ActivatePlanBody {
  planId: string
  interval: SubscriptionInterval
  /** `YYYY-MM-DD`, Asia/Dhaka. */
  startDate: string
  reason: string
  /** Optional coupon (PR-T3b): trimmed, any case; left out when empty. A bad one → 400 `COUPON_*`. */
  couponCode?: string
}

/** A promotion on the activated term (backend `AppliedPromotion`). */
export interface AppliedPromotion {
  promotionId: string
  redemptionId: string
  name: string
  /** COUPON only. */
  code: string | null
  /** "৳500 off" / "10% off for 3 months". */
  label: string
  labelBn: string
  /** Whole ৳ off this term's bill. */
  amountBdt: number
  months: { from: number; to: number; of: number } | null
}

/** The term's price (backend `ActivationPrice`): list, charged, and what came off (PR-D12). */
export interface ActivationPrice {
  listChargedBdt: number
  chargedBdt: number
  perMonthBdt: number
  /** The automatic discount (claimed before or claimed now). */
  discount: AppliedPromotion | null
  /** The admin's coupon, on top of the discount (PR-D16). */
  coupon: AppliedPromotion | null
}

export interface ActivatePlanResponse {
  subscription: {
    status: SubscriptionStatus
    interval: SubscriptionInterval
    trialEndsAt: string | null
    termEndsAt: string
    plan: { id: string; slug: string; name: string }
  }
  comments: { used: number; limit: number; resetsAt: string | null }
  price: ActivationPrice
}

export function activateClientPlan({ workspaceId, body }: { workspaceId: string; body: ActivatePlanBody }) {
  return apiFetch<ActivatePlanResponse>(`/admin/clients/${encodeURIComponent(workspaceId)}/subscription`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

const DHAKA_OFFSET_MS = 6 * 3_600_000
const DAY_MS = 86_400_000
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The Asia/Dhaka calendar day of an instant, `YYYY-MM-DD` (Bangladesh has no DST). */
export function dhakaToday(now: Date): string {
  return new Date(now.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10)
}

/** UTC-midnight `Date` of a real `YYYY-MM-DD`, or `null` (no 2026-02-30). */
function parseDay(value: string): Date | null {
  const m = DATE_ONLY.exec(value)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null
}

/** `YYYY-MM-DD` `days` days after `day` (negative = before). */
export function addDays(day: string, days: number): string {
  const date = parseDay(day)
  if (!date) throw new RangeError(`Invalid day: ${day}`)
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

/** The date input's `min` / `max`: today − 31 days … today (Dhaka). */
export function startDateBounds(now: Date): { min: string; max: string } {
  const max = dhakaToday(now)
  return { min: addDays(max, -ACTIVATION_MAX_DAYS_BACK), max }
}

/**
 * The term end of a manual activation: 00:00 Dhaka of `startDate` + 1 month / 12 months, the day
 * clamped to the month's last day (31 Jan → 28/29 Feb). ISO instant, or `null` for a bad date.
 */
export function activationTermEnd(startDate: string, interval: SubscriptionInterval): string | null {
  const start = parseDay(startDate)
  if (!start) return null
  const months = interval === 'year' ? 12 : 1
  const total = start.getUTCMonth() + months
  const year = start.getUTCFullYear() + Math.floor(total / 12)
  const month = total % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const day = Math.min(start.getUTCDate(), lastDay)
  return new Date(Date.UTC(year, month, day) - DHAKA_OFFSET_MS).toISOString()
}

/**
 * Start date → error text, or `null` when valid: a real day from 31 days ago to today (Dhaka),
 * and the term must not be over already (a monthly term started a month ago).
 */
export function startDateError(startDate: string, interval: SubscriptionInterval, now: Date): string | null {
  if (!parseDay(startDate)) return 'Pick a start date.'
  const { min, max } = startDateBounds(now)
  if (startDate > max) return 'The start date can’t be in the future.'
  if (startDate < min) return `The start date can be at most ${ACTIVATION_MAX_DAYS_BACK} days ago.`
  const end = activationTermEnd(startDate, interval)
  if (end && Date.parse(end) <= now.getTime()) return 'This term would already be over. Pick a later start date.'
  return null
}

/** `true` when the plan can be billed yearly (it has a yearly per-month price). */
export function hasYearlyPrice(plan: Pick<AdminPlan, 'yearlyMonthlyPriceBdt'>): boolean {
  return plan.yearlyMonthlyPriceBdt !== null
}

/**
 * List price before promotions: monthly `৳999/month`; yearly `৳949/month · billed ৳11,388 yearly`.
 * `null` = yearly without a yearly price. No preview endpoint exists (PR-T3b): the discount and
 * coupon show in the 201 `price` after activating.
 */
export function activationPricePreview(
  plan: Pick<AdminPlan, 'monthlyPriceBdt' | 'yearlyMonthlyPriceBdt'>,
  interval: SubscriptionInterval,
): string | null {
  if (interval === 'month') return `${formatPlanPrice(plan.monthlyPriceBdt)}/month`
  if (plan.yearlyMonthlyPriceBdt === null) return null
  return `${formatPlanPrice(plan.yearlyMonthlyPriceBdt)}/month · billed ${formatPlanPrice(yearlyChargeBdt(plan.yearlyMonthlyPriceBdt))} yearly`
}

/** Readable text for the backend's machine `code`s (else its own message). */
export const activationErrorMessages: Record<string, string> = {
  NO_BILLING_ACCOUNT: 'This client has no billing account (no owner), so there is nothing to activate.',
  PLAN_NOT_AVAILABLE: 'This plan is no longer available. Pick another one.',
  YEARLY_PRICE_MISSING: 'This plan has no yearly price. Choose Monthly or set a yearly price in Settings.',
  START_DATE_OUT_OF_RANGE: `The start date must be between ${ACTIVATION_MAX_DAYS_BACK} days ago and today.`,
  TERM_ALREADY_ENDED: 'This term would already be over. Pick a later start date.',
}

/** The backend's `COUPON_ERROR_CODES` (400) → the coupon field's error. */
export const couponErrorMessages: Record<string, string> = {
  COUPON_NOT_FOUND: 'No coupon with this code.',
  COUPON_EXPIRED: 'This coupon has ended or was stopped.',
  COUPON_NOT_FOR_PLAN: 'This coupon is not for this plan or billing period.',
  COUPON_ALREADY_USED: 'This client has already used this coupon.',
  COUPON_USED_UP: 'This coupon has no uses left.',
}
