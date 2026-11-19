import {
  DISCOUNT_PERCENT_MAX,
  type DiscountScope,
  type DiscountType,
  PLAN_PRICE_MAX_BDT,
  type PromotionKind,
} from '../db/schema/index.js';
import { dhakaMidnight } from './manual-activation.js';

/**
 * Pure rules of the admin promotions API (PR-T4; user decisions 2026-11-20 PR-D2, reading 8;
 * plan doc §5.2). No I/O, no clock: `now` is passed in.
 */

/** Precedence when several apply: Stopped > Ended > Used up > Live. */
export const PROMOTION_STATUSES = [
  'LIVE',
  'ENDED',
  'STOPPED',
  'USED_UP',
] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/** `code` of the 4xx answers of `/api/admin/promotions`. */
export const ADMIN_PROMOTION_ERROR_CODES = {
  /** 400: the fields don't fit the kind (or the targets are missing / contradictory). */
  invalidTerms: 'PROMOTION_INVALID_TERMS',
  /** 400: a target plan is unknown or inactive. */
  planNotAvailable: 'PLAN_NOT_AVAILABLE',
  /** 400: `endsOn` is before today (Dhaka). */
  endsInPast: 'PROMOTION_ENDS_IN_PAST',
  /** 409: another promotion has this coupon code. */
  codeTaken: 'PROMOTION_CODE_TAKEN',
  /** 409: a money term changed after the first redemption (reading 8); `details.fields`. */
  termsLocked: 'PROMOTION_TERMS_LOCKED',
} as const;

/** Money terms, locked after the first redemption (reading 8). */
export const LOCKED_TERM_FIELDS = [
  'trialDays',
  'trialCommentLimit',
  'discountType',
  'discountValue',
  'discountScope',
  'durationMonths',
] as const;
export type LockedTermField = (typeof LOCKED_TERM_FIELDS)[number];

export interface PromotionTerms {
  kind: PromotionKind;
  code: string | null;
  allPlans: boolean;
  planIds: readonly string[];
  trialDays: number | null;
  trialCommentLimit: number | null;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountScope: DiscountScope | null;
  durationMonths: number | null;
}

const DAY_MS = 86_400_000;

/** Last millisecond of a Dhaka calendar day: the stored `ends_at` of an end date (plan doc §5.2). */
export function endOfDhakaDay(date: string): Date {
  return new Date(dhakaMidnight(date).getTime() + DAY_MS - 1);
}

export function promotionStatus(
  p: {
    stoppedAt: Date | null;
    endsAt: Date | null;
    maxRedemptions: number | null;
  },
  redemptionCount: number,
  now: Date,
): PromotionStatus {
  if (p.stoppedAt) return 'STOPPED';
  if (p.endsAt && p.endsAt <= now) return 'ENDED';
  if (p.maxRedemptions !== null && redemptionCount >= p.maxRedemptions)
    return 'USED_UP';
  return 'LIVE';
}

/** Locked fields the patch would change (sent and different from the stored value). */
export function lockedChanges(
  current: Pick<PromotionTerms, LockedTermField>,
  patch: Partial<Record<LockedTermField, unknown>>,
): LockedTermField[] {
  return LOCKED_TERM_FIELDS.filter(
    (field) => patch[field] !== undefined && patch[field] !== current[field],
  );
}

/**
 * Per-kind rules on the merged values, as the DB checks (`promotions_*_check`) put them: TRIAL
 * fills `trialDays` and no discount field; DISCOUNT / COUPON fill type + value + scope and no
 * trial field (FLAT ৳1 … 1,000,000, PERCENT 1–100); `code` on COUPON only (required there);
 * targets = `allPlans` or at least one plan, not both. `null` = valid.
 */
export function promotionTermsError(t: PromotionTerms): string | null {
  if ((t.kind === 'COUPON') !== (t.code !== null))
    return t.kind === 'COUPON'
      ? 'code is required for a COUPON'
      : 'code is only allowed on a COUPON';
  if (t.kind === 'TRIAL') {
    if (t.trialDays === null) return 'trialDays is required for a TRIAL';
    if (
      t.discountType !== null ||
      t.discountValue !== null ||
      t.discountScope !== null ||
      t.durationMonths !== null
    )
      return 'discount fields are not allowed on a TRIAL';
  } else {
    if (
      t.discountType === null ||
      t.discountValue === null ||
      t.discountScope === null
    )
      return `discountType, discountValue and discountScope are required for a ${t.kind}`;
    if (t.trialDays !== null || t.trialCommentLimit !== null)
      return `trial fields are not allowed on a ${t.kind}`;
    const max =
      t.discountType === 'PERCENT' ? DISCOUNT_PERCENT_MAX : PLAN_PRICE_MAX_BDT;
    if (t.discountValue < 1 || t.discountValue > max)
      return `discountValue must be between 1 and ${max} for ${t.discountType}`;
  }
  if (t.allPlans && t.planIds.length > 0)
    return 'send planIds or allPlans, not both';
  if (!t.allPlans && t.planIds.length === 0)
    return 'planIds must name at least one plan (or set allPlans)';
  return null;
}
