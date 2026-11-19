import type { SubscriptionInterval } from '../db/schema/index.js';

/** The plan columns `planPrice` reads (a `plans` row or any API shape that carries them). */
export interface PlanPriceSource {
  /** Monthly list price (the struck price), whole BDT. */
  originalPriceBdt: number;
  /** Monthly offer price; `null` = the original is the monthly price. */
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
  /** The struck list price per month (`original_price_bdt`); strike it when > `perMonthBdt`. */
  listPerMonthBdt: number;
  /** Offer badge (e.g. "50% Launch Offer") shown next to both intervals (PW-D6); `null` = none. */
  badge: string | null;
}

/**
 * One price rule for every screen (PW-D5, PW-D6; plan §3.2). Pure.
 *
 * - `month`: per month = the offer price or, without one, the original; charged = per month.
 * - `year`: per month = `yearlyMonthlyPriceBdt`; charged = per month × 12 (৳449 → ৳5,388).
 *   Returns `null` when the plan has no yearly price (no yearly option).
 */
export function planPrice(
  plan: PlanPriceSource,
  interval: SubscriptionInterval,
): PlanPrice | null {
  const perMonthBdt =
    interval === 'month'
      ? (plan.offerPriceBdt ?? plan.originalPriceBdt)
      : plan.yearlyMonthlyPriceBdt;
  if (perMonthBdt === null) return null;
  return {
    perMonthBdt,
    chargedBdt: interval === 'month' ? perMonthBdt : perMonthBdt * 12,
    listPerMonthBdt: plan.originalPriceBdt,
    badge: plan.offerBadge,
  };
}
