import type {
  ActivationPrice,
  SubscriptionInterval,
  SubscriptionStatus,
} from '../db/schema/index.js';
import { DHAKA_OFFSET_MS, monthlyReset } from '../wallet/wallet-period.js';

/**
 * Pure rules of the admin manual plan activation (PW-T9; user decision 2026-11-19 PW-D16 + the
 * confirmed PW-PLAN reading): start date from 31 days ago to today (Asia/Dhaka, no future
 * dates), term = start date 00:00 Dhaka + 1 month / 1 year with the month-end clamp of
 * `nextReset`. No I/O, no clock: `now` is passed in.
 */

/** How many days back the start date may go (today − 31 … today, Dhaka). */
export const MANUAL_ACTIVATION_MAX_DAYS_BACK = 31;

/** `code` of the 4xx answers of `POST /api/admin/clients/:workspaceId/subscription`. */
export const MANUAL_ACTIVATION_ERROR_CODES = {
  /** 409: the workspace has no billing account (member-less workspace): nothing to activate on. */
  noBillingAccount: 'NO_BILLING_ACCOUNT',
  /** 400: the plan id is unknown or the plan is inactive (e.g. the retired `free` row). */
  planNotAvailable: 'PLAN_NOT_AVAILABLE',
  /** 400: `interval: 'year'` on a plan without a yearly price (no yearly option, PW-D5). */
  yearlyPriceMissing: 'YEARLY_PRICE_MISSING',
  /** 400: the start date is in the future or more than 31 days back (Dhaka calendar days). */
  startDateOutOfRange: 'START_DATE_OUT_OF_RANGE',
  /** 400: the whole term already lies in the past (e.g. a monthly term started 31 days ago). */
  termAlreadyEnded: 'TERM_ALREADY_ENDED',
} as const;

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` that is a real calendar date (no 2026-02-30, no 2026-13-01). Used by the DTO; the
 * range check is `startDateError()` (it needs the clock).
 */
export function isRealDateOnly(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_ONLY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/** 00:00 Asia/Dhaka of a `YYYY-MM-DD` date (a fixed UTC+6: the day before at 18:00 UTC). */
export function dhakaMidnight(date: string): Date {
  if (!isRealDateOnly(date)) throw new RangeError('Invalid date (YYYY-MM-DD)');
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - DHAKA_OFFSET_MS);
}

/** The Asia/Dhaka calendar date of an instant, `YYYY-MM-DD`. */
export function dhakaDate(instant: Date): string {
  return new Date(instant.getTime() + DHAKA_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * `null` when `date` is a real `YYYY-MM-DD` from `MANUAL_ACTIVATION_MAX_DAYS_BACK` Dhaka days
 * before `now`'s Dhaka date up to that date itself; else why not (for the 400 message).
 */
export function startDateError(date: string, now: Date): string | null {
  if (!isRealDateOnly(date)) return 'startDate must be a date (YYYY-MM-DD)';
  const today = dhakaMidnight(dhakaDate(now)).getTime();
  const start = dhakaMidnight(date).getTime();
  if (start > today) return 'startDate must not be in the future';
  if (today - start > MANUAL_ACTIVATION_MAX_DAYS_BACK * DAY_MS) {
    return `startDate must be at most ${MANUAL_ACTIVATION_MAX_DAYS_BACK} days ago`;
  }
  return null;
}

/** The paid term `[start, end)` of a manual activation. */
export interface ManualTerm {
  start: Date;
  end: Date;
}

/**
 * Term of a manual activation starting on `date` (Dhaka): 00:00 Dhaka that day + 1 month (`month`)
 * or 12 months (`year`), the day clamped to the month end like `nextReset` (31 Jan + 1 month →
 * 28/29 Feb 00:00 Dhaka; 29 Feb + 1 year → 28 Feb).
 */
export function manualTerm(
  date: string,
  interval: SubscriptionInterval,
): ManualTerm {
  const start = dhakaMidnight(date);
  return { start, end: monthlyReset(start, interval === 'year' ? 12 : 1) };
}

/** The account's live subscription as the activation found it (locked), before it is ended. */
export interface EndedSubscription {
  id: string;
  planId: string;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
  currentTermEnd: Date;
}

/**
 * What the old live row becomes: `CANCELED` + `canceled_at` (PW-D16), or `EXPIRED` when its term
 * was already over and only the expiry job hadn't caught up (it ended on its own).
 */
export function endedStatus(
  old: Pick<EndedSubscription, 'currentTermEnd'>,
  now: Date,
): { status: 'CANCELED'; canceledAt: Date } | { status: 'EXPIRED' } {
  return now.getTime() < old.currentTermEnd.getTime()
    ? { status: 'CANCELED', canceledAt: now }
    : { status: 'EXPIRED' };
}

/** The `subscription_audit_logs` row of one activation (without `id` / `created_at`). */
export interface ActivationAuditInput {
  adminId: string;
  billingAccountId: string;
  workspaceId: string;
  before: EndedSubscription | null;
  after: {
    id: string;
    planId: string;
    interval: SubscriptionInterval;
    status: SubscriptionStatus;
  };
  reason: string;
  /** The term's price + promotions (PR-T3b). */
  price: ActivationPrice;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Pure mapping to the audit row's columns (`before_*` all null without a live subscription). */
export function toActivationAudit(input: ActivationAuditInput) {
  const { before, after } = input;
  return {
    adminId: input.adminId,
    billingAccountId: input.billingAccountId,
    workspaceId: input.workspaceId,
    beforeSubscriptionId: before?.id ?? null,
    beforePlanId: before?.planId ?? null,
    beforeInterval: before?.interval ?? null,
    beforeStatus: before?.status ?? null,
    afterSubscriptionId: after.id,
    afterPlanId: after.planId,
    afterInterval: after.interval,
    afterStatus: after.status,
    reason: input.reason,
    price: input.price,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  };
}
