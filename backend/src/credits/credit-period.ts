import { dhakaBucketKey } from '../admin/dashboard-range.js';

/**
 * Asia/Dhaka calendar month (`YYYY-MM`) of an instant: the `monthly_credit_usage.month` key and
 * the `period` of `CreditService.usage()` (D15: credits reset at 00:00 Asia/Dhaka on the 1st, so
 * `…-31T17:59:59.999Z` is still the old month and `…-31T18:00:00Z` the new one). Pure.
 */
export function dhakaMonthKey(instant: Date = new Date()): string {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError('Invalid credit instant');
  }
  return dhakaBucketKey(instant, 'month');
}

/** Largest cost one call may reserve (a sanity bound: D8 costs are 1 or 2). */
export const MAX_CREDIT_COST = 1_000;

/**
 * Validates a credit amount for `reserve()` / `release()`: a positive integer ≤ `MAX_CREDIT_COST`.
 * Throws `RangeError` (a programming error, never a user input) before any SQL runs.
 */
export function assertCreditCost(cost: number): void {
  if (!Number.isInteger(cost) || cost < 1 || cost > MAX_CREDIT_COST) {
    throw new RangeError(
      `Credit cost must be an integer between 1 and ${MAX_CREDIT_COST}`,
    );
  }
}
