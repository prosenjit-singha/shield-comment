import type { SubscriptionInterval } from '../db/schema/index.js';

/** The plan columns `planPrice` reads (a `plans` row or any API shape that carries them). */
export interface PlanPriceSource {
  /** Monthly list price (the struck price), whole BDT. */
  monthlyPriceBdt: number;
  /** Monthly offer price; `null` = the list price is the monthly price. */
  offerPriceBdt: number | null;
  offerBadge: string | null;
  /** Per-month price when billed yearly; `null` = no yearly option. */
  yearlyMonthlyPriceBdt: number | null;
}

/** What a pricing card or checkout shows for one plan and interval (whole BDT). */
export interface PlanPrice {
  /** The figure the card shows: the price per month for this interval. */
  perMonthBdt: number;
  /** What one term costs: monthly = `perMonthBdt`, yearly = `perMonthBdt × 12`. */
  chargedBdt: number;
  /** The struck list price per month (`monthly_price_bdt`); strike it when > `perMonthBdt`. */
  listPerMonthBdt: number;
  /** Offer badge (e.g. "50% Launch Offer") shown next to both intervals (PW-D6); `null` = none. */
  badge: string | null;
}

/**
 * One price rule for every screen (PW-D5, PW-D6; plan §3.2). Pure.
 *
 * - `month`: per month = the offer price or, without one, the list price; charged = per month.
 * - `year`: per month = `yearlyMonthlyPriceBdt` − the offer saving (`monthly − offer`, floor ৳0);
 *   charged = per month × 12 (৳949 − ৳500 = ৳449 → ৳5,388). Since 0027 (PR-T1) the yearly column
 *   is a list price and the offer is the seeded "Launch offer" (FLAT, each month), so this keeps
 *   the shown prices. Returns `null` when the plan has no yearly price (no yearly option).
 */
export function planPrice(
  plan: PlanPriceSource,
  interval: SubscriptionInterval,
): PlanPrice | null {
  // ponytail: the legacy offer column stands in for the launch-offer promotion until PR-T2's
  // discount-aware `planPrice` reads `promotions` (the offer columns go in PR-T7).
  const offerSaving =
    plan.offerPriceBdt === null ? 0 : plan.monthlyPriceBdt - plan.offerPriceBdt;
  const perMonthBdt =
    interval === 'month'
      ? (plan.offerPriceBdt ?? plan.monthlyPriceBdt)
      : plan.yearlyMonthlyPriceBdt === null
        ? null
        : Math.max(0, plan.yearlyMonthlyPriceBdt - offerSaving);
  if (perMonthBdt === null) return null;
  return {
    perMonthBdt,
    chargedBdt: interval === 'month' ? perMonthBdt : perMonthBdt * 12,
    listPerMonthBdt: plan.monthlyPriceBdt,
    badge: plan.offerBadge,
  };
}
