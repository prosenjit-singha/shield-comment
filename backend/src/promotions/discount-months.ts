import type { DiscountScope } from '../db/schema/index.js';

/** The month terms of a discount (a promotion or a redemption snapshot). */
export interface DiscountMonths {
  discountScope: DiscountScope;
  /** PER_MONTH: months it runs, `null` = forever. Ignored for TOTAL. */
  durationMonths: number | null;
}

/** "k of N" months of a multi-month discount one bill covers (PR-D12): months `from`…`to` of `of`. */
export interface MonthsOf {
  from: number;
  to: number;
  of: number;
}

/**
 * Months a claimed discount still has after `monthsUsed` (reading 9): `null` = no limit (PER_MONTH
 * forever, or a TOTAL not used yet), `0` = spent. TOTAL only ever cuts its first bill (reading 2).
 */
export function monthsLeft(
  d: DiscountMonths,
  monthsUsed: number,
): number | null {
  if (d.discountScope === 'TOTAL') return monthsUsed > 0 ? 0 : null;
  return d.durationMonths === null
    ? null
    : Math.max(0, d.durationMonths - monthsUsed);
}

/**
 * Months one term of `termMonths` (1 or 12) uses up, i.e. what `months_used` advances by:
 * PER_MONTH min(term, left) (forever: the whole term); TOTAL the whole term (spent after it).
 */
export function monthsThisTerm(
  d: DiscountMonths,
  monthsUsed: number,
  termMonths: number,
): number {
  const left = monthsLeft(d, monthsUsed);
  return left === null ? termMonths : Math.min(termMonths, left);
}

/** "k of N" for a PER_MONTH discount of N months; `null` for forever and TOTAL. */
export function monthsOf(
  d: DiscountMonths,
  monthsUsed: number,
  termMonths: number,
): MonthsOf | null {
  if (d.discountScope !== 'PER_MONTH' || d.durationMonths === null) return null;
  return {
    from: monthsUsed + 1,
    to: monthsUsed + monthsThisTerm(d, monthsUsed, termMonths),
    of: d.durationMonths,
  };
}
