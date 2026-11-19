import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  COUPON_CODE_PATTERN,
  DISCOUNT_SCOPES,
  DISCOUNT_TYPES,
  type DiscountScope,
  type DiscountType,
  PLAN_PRICE_MAX_BDT,
  PLAN_TRIAL_COMMENT_LIMIT_MAX,
  PLAN_TRIAL_DAYS_MAX,
  PLAN_TRIAL_DAYS_MIN,
  PROMOTION_KINDS,
  PROMOTION_NAME_MAX,
  type PromotionKind,
} from '../../db/schema/index.js';
import {
  PROMOTION_STATUSES,
  type PromotionStatus,
} from '../promotion-rules.js';
import { IsDateOnly } from './activate-client-plan.dto.js';

/**
 * Admin promotions API (PR-T4; user decisions 2026-11-20 PR-D1, D2, reading 8; plan doc §5.2,
 * §5.7). SuperAdminGuard. The admin app mirrors these types in `admin/src/lib/`.
 *
 * - `GET /api/admin/promotions?kind=&status=` → `{ items: AdminPromotion[] }`, newest first.
 * - `POST /api/admin/promotions` (`CreatePromotionDto`) → 201 `{ promotion }`.
 * - `PATCH /api/admin/promotions/:id` (`UpdatePromotionDto`) → `{ promotion }`.
 * - `POST /api/admin/promotions/:id/stop` → `{ promotion }` (idempotent: a stopped one is
 *   returned unchanged, keeping its first `stoppedAt`).
 * - `GET /api/admin/promotions/:id/redemptions` → `{ items: AdminPromotionRedemption[] }`.
 *
 * 400 `{ code }`: `PROMOTION_INVALID_TERMS` (fields don't fit the kind / targets),
 * `PLAN_NOT_AVAILABLE` (unknown or inactive target), `PROMOTION_ENDS_IN_PAST`; 409 `{ code }`:
 * `PROMOTION_CODE_TAKEN`, `PROMOTION_TERMS_LOCKED` (`details.fields`); 404 unknown promotion.
 */

/** Longest "first N clients" cap and "first N months" (sanity bounds; the DB only needs ≥ 1). */
export const PROMOTION_MAX_REDEMPTIONS_MAX = 1_000_000;
export const PROMOTION_DURATION_MONTHS_MAX = 120;
/** Most target plans in one request. */
export const PROMOTION_PLAN_IDS_MAX = 50;

export interface AdminPromotionPlan {
  id: string;
  slug: string;
  name: string;
}

export interface AdminPromotion {
  id: string;
  kind: PromotionKind;
  name: string;
  /** COUPON only (uppercase). */
  code: string | null;
  allPlans: boolean;
  /** Target plans (`[]` when `allPlans`), in `sortOrder`. */
  plans: AdminPromotionPlan[];
  /** Last millisecond of the end date (Dhaka); `null` = until stopped. */
  endsAt: string | null;
  /** The end date as picked (`YYYY-MM-DD`, Dhaka); `null` = until stopped. */
  endsOn: string | null;
  /** "First N clients"; `null` = no cap. */
  maxRedemptions: number | null;
  redemptionCount: number;
  status: PromotionStatus;
  /** Money terms are read-only (first redemption made, reading 8). */
  termsLocked: boolean;
  stoppedAt: string | null;
  trialDays: number | null;
  trialCommentLimit: number | null;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountScope: DiscountScope | null;
  durationMonths: number | null;
  /** `false` = seeded by a migration (0027). */
  createdByAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPromotionsResponse {
  items: AdminPromotion[];
}

export interface AdminPromotionResponse {
  promotion: AdminPromotion;
}

export interface AdminPromotionRedemption {
  id: string;
  redeemedAt: string;
  billingAccountId: string;
  /** The client account's owner. */
  client: { id: string; name: string; email: string };
  /** The account's first workspace (`null` when it has none left). */
  workspace: { id: string; name: string } | null;
  /** The plan of the subscription it was claimed with; `null` = none linked. */
  plan: AdminPromotionPlan | null;
  /** Saving on the first term, whole ৳ (0 for a trial). */
  discountBdtFirstTerm: number;
  monthsUsed: number;
}

export interface AdminPromotionRedemptionsResponse {
  items: AdminPromotionRedemption[];
}

export class ListPromotionsQueryDto {
  @IsOptional()
  @IsIn(PROMOTION_KINDS)
  kind?: PromotionKind;

  @IsOptional()
  @IsIn(PROMOTION_STATUSES)
  status?: PromotionStatus;
}

/** Present-but-`null` fails the validators that follow (only "absent" skips them). */
const unlessAbsent = <T extends object>(key: keyof T) =>
  ValidateIf((o: T) => o[key] !== undefined);

const trim = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value,
);

/** Fields shared by create and patch. `null` clears a nullable one. */
class PromotionFieldsDto {
  /** COUPON only: trimmed + uppercased, 3–32 chars of `A-Z 0-9 -`. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @IsString()
  @Matches(new RegExp(COUPON_CODE_PATTERN), {
    message: 'code must be 3–32 characters of A-Z, 0-9 and -',
  })
  code?: string | null;

  /** Targets every plan (then `planIds` must be empty). */
  @unlessAbsent<PromotionFieldsDto>('allPlans')
  @IsBoolean()
  allPlans?: boolean;

  /** Active plans; replaces the stored targets when sent. */
  @unlessAbsent<PromotionFieldsDto>('planIds')
  @IsArray()
  @ArrayMaxSize(PROMOTION_PLAN_IDS_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  planIds?: string[];

  /** Dhaka calendar date, today or later, stored as the end of that day; `null` = until stopped. */
  @IsOptional()
  @IsDateOnly()
  endsOn?: string | null;

  /** "First N clients"; `null` = no cap. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PROMOTION_MAX_REDEMPTIONS_MAX)
  maxRedemptions?: number | null;

  /** TRIAL: 1–90 days. */
  @IsOptional()
  @IsInt()
  @Min(PLAN_TRIAL_DAYS_MIN)
  @Max(PLAN_TRIAL_DAYS_MAX)
  trialDays?: number | null;

  /** TRIAL: comments granted; `null` = the plan's monthly comments. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PLAN_TRIAL_COMMENT_LIMIT_MAX)
  trialCommentLimit?: number | null;

  @IsOptional()
  @IsIn(DISCOUNT_TYPES)
  discountType?: DiscountType | null;

  /** FLAT: whole ৳ (1–1,000,000); PERCENT: 1–100 (checked with the type). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PLAN_PRICE_MAX_BDT)
  discountValue?: number | null;

  @IsOptional()
  @IsIn(DISCOUNT_SCOPES)
  discountScope?: DiscountScope | null;

  /** Months the discount runs; `null` = forever (ignored for TOTAL). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PROMOTION_DURATION_MONTHS_MAX)
  durationMonths?: number | null;
}

/** `POST /api/admin/promotions` body. Unknown fields → 400. */
export class CreatePromotionDto extends PromotionFieldsDto {
  @IsIn(PROMOTION_KINDS)
  kind!: PromotionKind;

  /** Trimmed, 1–60 chars (shown to the admin and on bills). */
  @trim
  @IsString()
  @MinLength(1)
  @MaxLength(PROMOTION_NAME_MAX)
  name!: string;
}

/**
 * `PATCH /api/admin/promotions/:id` body: any subset (at least one field). `kind` can't change.
 * After the first redemption the money terms (`LOCKED_TERM_FIELDS`) are locked: sending a
 * different value → 409 `PROMOTION_TERMS_LOCKED`; name, code, end date, cap and targets stay
 * editable (reading 8).
 */
export class UpdatePromotionDto extends PromotionFieldsDto {
  @unlessAbsent<UpdatePromotionDto>('name')
  @trim
  @IsString()
  @MinLength(1)
  @MaxLength(PROMOTION_NAME_MAX)
  name?: string;
}
