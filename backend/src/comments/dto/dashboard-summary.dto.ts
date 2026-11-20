import { IsIn, IsOptional } from 'class-validator';
import type { ModerationCategory } from '../../moderation/moderation.constants.js';

/** D10 (Module 6, 2026-11-20): Dhaka-day presets only, default `30d`. */
export const SUMMARY_RANGES = ['7d', '30d', '90d'] as const;
export type SummaryRange = (typeof SUMMARY_RANGES)[number];
export const DEFAULT_SUMMARY_RANGE: SummaryRange = '30d';

/**
 * `GET /api/workspaces/:workspaceId/dashboard/summary` (M6-T5). Anything but a preset (other
 * values, `from`/`to`) → 400 (whitelist + `forbidNonWhitelisted`).
 */
export class DashboardSummaryQueryDto {
  @IsOptional()
  @IsIn(SUMMARY_RANGES)
  range?: SummaryRange;
}

export interface SummaryDay {
  /** Asia/Dhaka day, `YYYY-MM-DD`. */
  day: string;
  /** AI classifications + static rule matches. */
  scanned: number;
  /** Successful AUTO hides + deletes. */
  autoHidden: number;
}

export interface CategoryCount {
  category: ModerationCategory;
  count: number;
}

export interface DashboardSummaryResponse {
  range: SummaryRange;
  kpis: {
    /** Range total of `daily[].scanned`. */
    scanned: number;
    /** Range total of `daily[].autoHidden`. */
    autoHidden: number;
    /** `NEEDS_REVIEW` comments right now (live, not range-bound). */
    needsReview: number;
    /** `SCAM_PHISHING` classifications in the range. */
    scamsBlocked: number;
  };
  /** Every Dhaka day of the range, oldest first, zero-filled. */
  daily: SummaryDay[];
  /** All five categories (Donut), `MODERATION_CATEGORIES` order. */
  intents: CategoryCount[];
  /** The four non-SAFE categories (Bar). */
  flagged: CategoryCount[];
}
