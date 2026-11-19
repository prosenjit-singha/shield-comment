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
  PLAN_BADGE_MAX,
  PLAN_DESCRIPTION_MAX,
  PLAN_LIMIT_MAX,
  PLAN_PRICE_MAX_BDT,
  type PlanFeatureConfig,
} from '../../db/schema/index.js';

/**
 * A7 plan settings API (M2-T11). The admin app mirrors these types in `admin/src/lib/`.
 *
 * - `GET /api/admin/settings/plans` → `AdminPlansResponse` (**active** plans only, ordered by
 *   `sortOrder`, then name; the deactivated `free` row is left out, PW-D7).
 * - `PATCH /api/admin/settings/plans/:planId` (one plan per request; partial body, see
 *   `UpdatePlanDto`) → `AdminPlanUpdateResponse`. 400 invalid body / nothing to update / yearly
 *   per-month > monthly price (checked on the merged stored + sent values); 404 unknown or
 *   malformed id. `isHighlighted: true` clears the flag on the other plans in the same
 *   transaction (one audit row per changed plan, PR-D9).
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
  /** Monthly list price, whole BDT (৳) (API name `originalPriceBdt` before PR-T4). */
  monthlyPriceBdt: number;
  /** Per-month list price when billed yearly (charged × 12), ≤ the monthly price; `null` = no yearly option. Seed 949 / 2,349 / 5,599. */
  yearlyMonthlyPriceBdt: number | null;
  /** Card badge, e.g. "Popular" (1–24 chars, PR-D8/D17); `null` = none. bn falls back to en on the client. */
  badgeEn: string | null;
  badgeBn: string | null;
  /** Short card description (1–160 chars); `null` = none. */
  descriptionEn: string | null;
  descriptionBn: string | null;
  /** The one highlighted plan (PR-D9). */
  isHighlighted: boolean;
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

/** Trims a string; blank → `null` (clears). Other values pass through to the validators. */
const trimToNull = Transform(({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
});

/**
 * `PATCH /api/admin/settings/plans/:planId` body. Every field is optional, at least one must
 * be sent. Unknown fields (also `slug`, `name`, `sortOrder`, `isActive` and the legacy
 * `originalPriceBdt` / offer / trial fields) → 400. Strings are never coerced to numbers/booleans.
 */
export class UpdatePlanDto {
  /** Whole BDT, 0–1,000,000. `null` is rejected. */
  @unlessAbsent<UpdatePlanDto>('monthlyPriceBdt')
  @IsInt()
  @Min(0)
  @Max(PLAN_PRICE_MAX_BDT)
  monthlyPriceBdt?: number;

  /** Whole BDT, 0–1,000,000 and ≤ the (new or stored) monthly price. `null` removes the yearly option. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PLAN_PRICE_MAX_BDT)
  yearlyMonthlyPriceBdt?: number | null;

  /** Trimmed, 1–24 chars. `null` or a blank string clears it. */
  @trimToNull
  @IsOptional()
  @IsString()
  @MaxLength(PLAN_BADGE_MAX)
  badgeEn?: string | null;

  @trimToNull
  @IsOptional()
  @IsString()
  @MaxLength(PLAN_BADGE_MAX)
  badgeBn?: string | null;

  /** Trimmed, 1–160 chars. `null` or a blank string clears it. */
  @trimToNull
  @IsOptional()
  @IsString()
  @MaxLength(PLAN_DESCRIPTION_MAX)
  descriptionEn?: string | null;

  @trimToNull
  @IsOptional()
  @IsString()
  @MaxLength(PLAN_DESCRIPTION_MAX)
  descriptionBn?: string | null;

  /** `true` makes this the one highlighted plan (clears the others); `null` is rejected. */
  @unlessAbsent<UpdatePlanDto>('isHighlighted')
  @IsBoolean()
  isHighlighted?: boolean;

  @unlessAbsent<UpdatePlanDto>('featureConfig')
  @IsObject()
  @ValidateNested()
  @Type(() => PlanFeatureConfigPatchDto)
  featureConfig?: PlanFeatureConfigPatchDto;
}
