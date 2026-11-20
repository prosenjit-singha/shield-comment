import type {
  PaymentKind,
  PaymentPrice,
  PaymentPromotion,
  SubscriptionInterval,
  SubscriptionStatus,
} from '../db/schema/index.js';
import type { PlanPrice, PriceSaving } from '../plans/plan-price.js';
import {
  type DiscountMonths,
  monthsOf,
} from '../promotions/discount-months.js';
import { monthlyReset, resetIndex } from '../wallet/wallet-period.js';

/**
 * Paid-term rules (M8-T3; user decisions 2026-11-21 D4, D6, D7; Module 8 readings 6, 7, 10). Pure:
 * no I/O, `now` is passed in. Terms follow `wallet-period.ts` (Asia/Dhaka calendar, month-end
 * clamp, time of day kept).
 *
 * - **NEW** (no live paid term, or trial → paid, D6): a new term from the payment; the trial ends.
 * - **RENEWAL** (D4): a live ACTIVE term on the same plan + interval **moves its end** (same row,
 *   `current_term_start` = the wallet anchor stays, so the billing day does not drift); after the
 *   term ended, a new term from the payment.
 * - **UPGRADE** (D7): a new term from the payment; the unused days of the current paid term come
 *   off the new price (`upgradeCredit`). Downgrade and year → month only when renewing after the
 *   term ended (`paymentKind`).
 */

const DAY_MS = 86_400_000;

/** D4: "Renew" opens 7 days before the term ends. */
export const RENEWAL_WINDOW_DAYS = 7;

/** Why `paymentKind` refuses a checkout (body `code`). */
export const PAID_TERM_ERROR_CODES = {
  /** 409: same plan + interval, but the term ends more than 7 days from now (D4). */
  renewalNotOpen: 'RENEWAL_NOT_OPEN',
  /** 409: downgrade / year → month while a paid term runs (D7: only at renewal). */
  changeAtRenewal: 'PLAN_CHANGE_AT_RENEWAL',
} as const;
export type PaidTermErrorCode =
  (typeof PAID_TERM_ERROR_CODES)[keyof typeof PAID_TERM_ERROR_CODES];

export const termMonths = (interval: SubscriptionInterval) =>
  interval === 'year' ? 12 : 1;

/** The account's live-status subscription row (as locked / read). */
export interface CurrentTerm {
  status: SubscriptionStatus;
  planId: string;
  interval: SubscriptionInterval;
  currentTermStart: Date;
  currentTermEnd: Date;
}

/** A paid term `[start, end)`; `extend` = the live row keeps running and only its end moves. */
export interface PaidTerm {
  extend: boolean;
  start: Date;
  end: Date;
}

const isLive = (t: CurrentTerm, now: Date) =>
  (t.status === 'ACTIVE' || t.status === 'TRIALING') &&
  now.getTime() < t.currentTermEnd.getTime();

/**
 * The term a payment of `kind` buys. A RENEWAL of the live ACTIVE row on the same plan + interval
 * extends it from its current end (D4: an early payment loses nothing); anything else is a new
 * term from `start` (NEW, UPGRADE, a renewal after the end, or a late payment on a changed plan).
 */
export function paidTerm(
  kind: PaymentKind,
  current: CurrentTerm | null,
  target: { planId: string; interval: SubscriptionInterval },
  start: Date,
  now: Date,
): PaidTerm {
  const months = termMonths(target.interval);
  if (
    kind === 'RENEWAL' &&
    current?.status === 'ACTIVE' &&
    isLive(current, now) &&
    current.planId === target.planId &&
    current.interval === target.interval
  ) {
    return {
      extend: true,
      start: current.currentTermEnd,
      end: extendedEnd(current, months),
    };
  }
  return { extend: false, start, end: monthlyReset(start, months) };
}

/**
 * The end after adding `months` to a term, counted from the row's anchor (`current_term_start`)
 * so a 31st keeps returning (31 Jan → 28 Feb → 31 Mar). An end that is not on the anchor's
 * billing day (never written today) just adds the months to the end.
 */
export function extendedEnd(
  term: Pick<CurrentTerm, 'currentTermStart' | 'currentTermEnd'>,
  months: number,
): Date {
  const { currentTermStart: anchor, currentTermEnd: end } = term;
  const k = resetIndex(anchor, end);
  return monthlyReset(anchor, k).getTime() === end.getTime()
    ? monthlyReset(anchor, k + months)
    : monthlyReset(end, months);
}

/**
 * D7 credit: the unused whole days of the current paid term × what it charged ÷ the term's days,
 * rounded down, never more than the new term's `chargedBdt` (so the amount floors at ৳0). The
 * term's days are those of one term ending at `current_term_end` (an early-renewed row: the last
 * term; its unused days are all valued at that term's rate). 0 for a trial or an ended term.
 */
export function upgradeCredit(
  current: CurrentTerm & { chargedBdt: number | null },
  newChargedBdt: number,
  now: Date,
): number {
  if (
    current.status !== 'ACTIVE' ||
    current.chargedBdt === null ||
    !isLive(current, now)
  )
    return 0;
  const end = current.currentTermEnd.getTime();
  const start = Math.max(
    current.currentTermStart.getTime(),
    monthlyReset(
      current.currentTermEnd,
      -termMonths(current.interval),
    ).getTime(),
  );
  const termDays = Math.round((end - start) / DAY_MS);
  if (termDays <= 0) return 0;
  const unusedDays = Math.floor((end - now.getTime()) / DAY_MS);
  return Math.min(
    newChargedBdt,
    Math.floor((current.chargedBdt * unusedDays) / termDays),
  );
}

/** The plan facts `paymentKind` compares (D7: "higher" = higher monthly list price). */
export interface KindTarget {
  planId: string;
  interval: SubscriptionInterval;
  monthlyPriceBdt: number;
}

/**
 * What a checkout is (D4, D6, D7), or why it is refused:
 * - no live term → NEW (RENEWAL when the account had a paid term before); a trial → NEW (D6);
 * - live ACTIVE, same plan + interval → RENEWAL from 7 days before the end, else `RENEWAL_NOT_OPEN`;
 * - live ACTIVE, a higher monthly list price or month → year (never year → month) → UPGRADE;
 * - any other change while the term runs → `PLAN_CHANGE_AT_RENEWAL` (pick it once the term ended).
 */
export function paymentKind(
  current: (CurrentTerm & { monthlyPriceBdt: number }) | null,
  target: KindTarget,
  hadPaidTerm: boolean,
  now: Date,
): { kind: PaymentKind } | { error: PaidTermErrorCode } {
  if (!current || !isLive(current, now))
    return { kind: hadPaidTerm ? 'RENEWAL' : 'NEW' };
  if (current.status === 'TRIALING') return { kind: 'NEW' };
  if (
    current.planId === target.planId &&
    current.interval === target.interval
  ) {
    const opens =
      current.currentTermEnd.getTime() - RENEWAL_WINDOW_DAYS * DAY_MS;
    return now.getTime() >= opens
      ? { kind: 'RENEWAL' }
      : { error: PAID_TERM_ERROR_CODES.renewalNotOpen };
  }
  const yearToMonth =
    current.interval === 'year' && target.interval === 'month';
  const monthToYear =
    current.interval === 'month' && target.interval === 'year';
  const higher = target.monthlyPriceBdt > current.monthlyPriceBdt;
  const same = target.monthlyPriceBdt === current.monthlyPriceBdt;
  if (!yearToMonth && (higher || (same && monthToYear)))
    return { kind: 'UPGRADE' };
  return { error: PAID_TERM_ERROR_CODES.changeAtRenewal };
}

/** A promotion on a term's bill before it is claimed: its terms as claimed so far. */
export interface TermClaim {
  terms: DiscountMonths;
  /** `months_used` before this term. */
  monthsUsed: number;
  /** Claimed earlier (advance `months_used`); `null` = redeem it on activation. */
  redemptionId: string | null;
}

/**
 * The price snapshot of a term (checkout, reading 6; manual activation): `planPrice`'s numbers +
 * the applied promotions with their names and "k of N" (PR-D12). `creditBdt` = 0 (the caller sets
 * the D7 credit).
 */
export function toPaymentPrice(
  price: PlanPrice,
  interval: SubscriptionInterval,
  claims: { discount: TermClaim | null; coupon: TermClaim | null },
  names: ReadonlyMap<string, { name: string; code: string | null }>,
): PaymentPrice {
  const months = termMonths(interval);
  const applied = (
    c: TermClaim | null,
    saving: PriceSaving | null | undefined,
  ): PaymentPromotion | null =>
    c && saving
      ? {
          promotionId: saving.promotionId,
          redemptionId: c.redemptionId,
          name: names.get(saving.promotionId)!.name,
          code: names.get(saving.promotionId)!.code,
          label: saving.label,
          labelBn: saving.labelBn,
          amountBdt: saving.amountBdt,
          months: monthsOf(c.terms, c.monthsUsed, months),
        }
      : null;
  return {
    listChargedBdt: price.listChargedBdt,
    chargedBdt: price.chargedBdt,
    perMonthBdt: price.perMonthBdt,
    discount: applied(claims.discount, price.saving),
    coupon: applied(claims.coupon, price.coupon),
    creditBdt: 0,
  };
}

/** Whole ৳ the payment charges (`chargedBdt − creditBdt`, floor ৳0). */
export const paymentAmount = (price: PaymentPrice) =>
  Math.max(0, price.chargedBdt - price.creditBdt);

/**
 * Months a promotion on this bill uses up (what `months_used` advances by): its "k of N" span,
 * or the whole term (forever / TOTAL; same as `monthsThisTerm`).
 */
export const promotionMonths = (
  p: Pick<PaymentPromotion, 'months'>,
  interval: SubscriptionInterval,
) => (p.months ? p.months.to - p.months.from + 1 : termMonths(interval));
