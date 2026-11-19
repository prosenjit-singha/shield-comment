import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  PLAN_LIMIT_MAX,
  PLAN_OFFER_BADGE_MAX,
  PLAN_PRICE_MAX_BDT,
  PLAN_TRIAL_COMMENT_LIMIT_MAX,
  PLAN_TRIAL_DAYS_MAX,
  PLAN_TRIAL_DAYS_MIN,
  type PlanFeatureConfig,
} from '../../db/schema/index.js';

/**
 * A7 plan settings API (M2-T11). The admin app mirrors these types in `admin/src/lib/`.
 *
 * - `GET /api/admin/settings/plans` → `AdminPlansResponse` (**active** plans only, ordered by
 *   `sortOrder`, then name; the deactivated `free` row is left out, PW-D7).
 * - `PATCH /api/admin/settings/plans/:planId` (one plan per request; partial body, see
 *   `UpdatePlanDto`) → `AdminPlanUpdateResponse`. 400 invalid body / nothing to update /
 *   offer > original / yearly per-month > monthly price / trial field on a non-Starter plan (all
 *   checked on the merged stored + sent values); 404 unknown or malformed id.
 *
 * `featureConfig` keys (seed defaults Free (inactive) | Starter | Growth | Pro):
 * - `limits.connectedPages` (0–1,000): 1 | 1 | 5 | 25
 * - `limits.monthlyComments` (0–10,000,000): 500 | 2,500 | 15,000 | 75,000 (comments per month,
 *   PW-D1. The M5-T11 name `monthlyAiCredits` → 400 as an unknown key)
 * - `limits.teamSeats` (0–1,000): 1 | 1 | 3 | 10
 * - `limits.workspaces` (0–1,000): 1 | 1 | 3 | 10 (PW-D10)
 * - `features.banglaAiFilter`, `features.autoHideScams`: all plans
 * - `features.customBlocklist`, `features.autoReplyTemplates`, `features.messengerAlerts`: Growth, Pro
 * - `features.whiteLabelReports`, `features.prioritySupportApi`: Pro only
 */

/** `GET /api/admin/settings/plans` takes no parameters: any query param → 400. */
export class ListPlansQueryDto {}

export interface AdminPlan {
  id: string;
  slug: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  /** Monthly list price, whole BDT (৳). */
  originalPriceBdt: number;
  /** Promo price, whole BDT, ≤ `originalPriceBdt`; `null` = no offer. */
  offerPriceBdt: number | null;
  /** e.g. "50% Launch Offer" (trimmed, 1–40 chars); `null` = none. */
  offerBadge: string | null;
  /** Per-month price when billed yearly (charged × 12), ≤ the monthly price; `null` = no yearly option. Seed 449 / 1,349 / 3,599. */
  yearlyMonthlyPriceBdt: number | null;
  /** Trial length in days, 1–90 (Starter only; seed 7). `null` = no trial. */
  trialDays: number | null;
  /** Comments granted to a trial, 0–10,000,000 (Starter only; seed 300). `null` = Starter's `monthlyComments`. */
  trialCommentLimit: number | null;
  /** Always complete: every limit and feature key is present. */
  featureConfig: PlanFeatureConfig;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPlansResponse {
  items: AdminPlan[];
}

export interface AdminPlanUpdateResponse {
  plan: AdminPlan;
}

/** Present-but-`null` fails the validators that follow (only "absent" skips them). */
const unlessAbsent = <T extends object>(key: keyof T) =>
  ValidateIf((o: T) => o[key] !== undefined);

export class PlanLimitsPatchDto {
  @unlessAbsent<PlanLimitsPatchDto>('connectedPages')
  @IsInt()
  @Min(0)
  @Max(PLAN_LIMIT_MAX.connectedPages)
  connectedPages?: number;

  @unlessAbsent<PlanLimitsPatchDto>('monthlyComments')
  @IsInt()
  @Min(0)
  @Max(PLAN_LIMIT_MAX.monthlyComments)
  monthlyComments?: number;

  @unlessAbsent<PlanLimitsPatchDto>('teamSeats')
  @IsInt()
  @Min(0)
  @Max(PLAN_LIMIT_MAX.teamSeats)
  teamSeats?: number;

  @unlessAbsent<PlanLimitsPatchDto>('workspaces')
  @IsInt()
  @Min(0)
  @Max(PLAN_LIMIT_MAX.workspaces)
  workspaces?: number;
}

export class PlanFeaturesPatchDto {
  @unlessAbsent<PlanFeaturesPatchDto>('banglaAiFilter')
  @IsBoolean()
  banglaAiFilter?: boolean;

  @unlessAbsent<PlanFeaturesPatchDto>('autoHideScams')
  @IsBoolean()
  autoHideScams?: boolean;

  @unlessAbsent<PlanFeaturesPatchDto>('customBlocklist')
  @IsBoolean()
  customBlocklist?: boolean;

  @unlessAbsent<PlanFeaturesPatchDto>('autoReplyTemplates')
  @IsBoolean()
  autoReplyTemplates?: boolean;

  @unlessAbsent<PlanFeaturesPatchDto>('messengerAlerts')
  @IsBoolean()
  messengerAlerts?: boolean;

  @unlessAbsent<PlanFeaturesPatchDto>('whiteLabelReports')
  @IsBoolean()
  whiteLabelReports?: boolean;

  @unlessAbsent<PlanFeaturesPatchDto>('prioritySupportApi')
  @IsBoolean()
  prioritySupportApi?: boolean;
}

/** Partial `featureConfig`: only the keys sent are changed (merged onto the stored config). */
export class PlanFeatureConfigPatchDto {
  @unlessAbsent<PlanFeatureConfigPatchDto>('limits')
  @IsObject()
  @ValidateNested()
  @Type(() => PlanLimitsPatchDto)
  limits?: PlanLimitsPatchDto;

  @unlessAbsent<PlanFeatureConfigPatchDto>('features')
  @IsObject()
  @ValidateNested()
  @Type(() => PlanFeaturesPatchDto)
  features?: PlanFeaturesPatchDto;
}

/**
 * `PATCH /api/admin/settings/plans/:planId` body. Every field is optional, at least one must
 * be sent. Unknown fields (also `slug`, `name`, `sortOrder`, `isActive`) → 400.
 * Strings are never coerced to numbers/booleans.
 */
export class UpdatePlanDto {
  /** Whole BDT, 0–1,000,000. `null` is rejected. */
  @unlessAbsent<UpdatePlanDto>('originalPriceBdt')
  @IsInt()
  @Min(0)
  @Max(PLAN_PRICE_MAX_BDT)
  originalPriceBdt?: number;

  /** Whole BDT, 0–1,000,000 and ≤ the (new or stored) original price. `null` removes the offer. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PLAN_PRICE_MAX_BDT)
  offerPriceBdt?: number | null;

  /** Trimmed, ≤ 40 chars. `null` or a blank string removes the badge. */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  })
  @IsOptional()
  @IsString()
  @MaxLength(PLAN_OFFER_BADGE_MAX)
  offerBadge?: string | null;

  /** Whole BDT, 0–1,000,000 and ≤ the (new or stored) monthly price. `null` removes the yearly option. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PLAN_PRICE_MAX_BDT)
  yearlyMonthlyPriceBdt?: number | null;

  /** Whole days, 1–90; Starter only. `null` = no trial. */
  @IsOptional()
  @IsInt()
  @Min(PLAN_TRIAL_DAYS_MIN)
  @Max(PLAN_TRIAL_DAYS_MAX)
  trialDays?: number | null;

  /** 0–10,000,000; Starter only. `null` = the plan's `monthlyComments`. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PLAN_TRIAL_COMMENT_LIMIT_MAX)
  trialCommentLimit?: number | null;

  @unlessAbsent<UpdatePlanDto>('featureConfig')
  @IsObject()
  @ValidateNested()
  @Type(() => PlanFeatureConfigPatchDto)
  featureConfig?: PlanFeatureConfigPatchDto;
}
