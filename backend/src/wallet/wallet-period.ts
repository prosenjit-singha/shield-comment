/**
 * Wallet period math (PW-T2; user decision 2026-11-19 PW-D4): the wallet resets monthly **on the
 * billing date**, i.e. the anchor's Asia/Dhaka day-of-month and time of day, clamped to the
 * month's last day (anchor on the 31st → Feb 28/29 → Mar 31). Asia/Dhaka is a fixed UTC+6 (no
 * DST), so the math is plain UTC arithmetic on a +6 h shifted clock. Pure: no I/O, no `now`.
 */

/** Asia/Dhaka = UTC+6 all year. */
export const DHAKA_OFFSET_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;

/** A wallet period `[start, end)` and the anchor that sets its reset day + time. */
export interface WalletPeriod {
  anchor: Date;
  start: Date;
  end: Date;
}

function assertInstant(instant: Date, name: string): void {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new RangeError(`Invalid wallet ${name}`);
  }
}

/** Days in a (0-based) month of a year, leap years included. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The Dhaka wall clock of an instant: year, 0-based month, day, ms since Dhaka midnight. */
function dhakaWall(instant: Date) {
  const shifted = instant.getTime() + DHAKA_OFFSET_MS;
  const wall = new Date(shifted);
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth(),
    day: wall.getUTCDate(),
    timeMs: ((shifted % DAY_MS) + DAY_MS) % DAY_MS,
  };
}

/**
 * The `k`-th monthly reset of `anchor` (`k = 0` is the anchor itself; negative `k` = before it):
 * the anchor's Dhaka day + time in the month `k` months later, the day clamped to that month's end.
 */
export function monthlyReset(anchor: Date, k: number): Date {
  assertInstant(anchor, 'anchor');
  if (!Number.isInteger(k)) throw new RangeError('Invalid reset index');
  const a = dhakaWall(anchor);
  const total = a.month + k;
  const year = a.year + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = Math.min(a.day, daysInMonth(year, month));
  return new Date(Date.UTC(year, month, day) + a.timeMs - DHAKA_OFFSET_MS);
}

/** Index of the last reset of `anchor` at or before `at` (negative when `at` is before the anchor). */
export function resetIndex(anchor: Date, at: Date): number {
  const a = dhakaWall(anchor);
  const w = dhakaWall(at);
  const k = (w.year - a.year) * 12 + (w.month - a.month);
  return monthlyReset(anchor, k).getTime() > at.getTime() ? k - 1 : k;
}

/**
 * The first reset instant **strictly after** `after` on `anchor`'s Dhaka day-of-month + time of
 * day (month-end clamped). `after` exactly on a reset → the following month's reset.
 */
export function nextReset(anchor: Date, after: Date): Date {
  assertInstant(anchor, 'anchor');
  assertInstant(after, 'instant');
  return monthlyReset(anchor, resetIndex(anchor, after) + 1);
}

/**
 * The monthly period of `anchor` that contains `now`, cut at `termEnd`:
 * `start` = the last reset ≤ `now` (the anchor itself before its first month is over; `now`
 * before the anchor → the first period), `end = min(nextReset, termEnd)` (PW-D4: yearly terms
 * reset monthly until the term ends). Throws `RangeError` when `now` is not before `termEnd`.
 */
export function walletPeriodAt(
  anchor: Date,
  now: Date,
  termEnd: Date,
): WalletPeriod {
  assertInstant(anchor, 'anchor');
  assertInstant(now, 'instant');
  assertInstant(termEnd, 'term end');
  if (now.getTime() >= termEnd.getTime()) {
    throw new RangeError('The wallet term has ended');
  }
  const k = Math.max(0, resetIndex(anchor, now));
  const start = monthlyReset(anchor, k);
  const reset = monthlyReset(anchor, k + 1);
  const end = reset.getTime() < termEnd.getTime() ? reset : termEnd;
  return { anchor, start, end };
}

/** Largest amount one `consume` / `refund` may move (a sanity bound; moderation moves 1). */
export const MAX_WALLET_AMOUNT = 1_000;

/**
 * Validates a wallet amount: a positive integer ≤ `MAX_WALLET_AMOUNT`. Throws `RangeError` (a
 * programming error, never a user input) before any SQL runs.
 */
export function assertWalletAmount(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_WALLET_AMOUNT) {
    throw new RangeError(
      `Wallet amount must be an integer between 1 and ${MAX_WALLET_AMOUNT}`,
    );
  }
}

/** Throws `RangeError` for an invalid `Date` (used for the service's `now` / `at` arguments). */
export function assertWalletInstant(instant: Date): void {
  assertInstant(instant, 'instant');
}
