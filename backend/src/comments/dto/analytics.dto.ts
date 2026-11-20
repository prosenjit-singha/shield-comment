import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { DATE_KEY, type Granularity } from '../../admin/dashboard-range.js';
import type { DailyCommentCounter } from '../../db/schema/index.js';
import type { CategoryCount } from './dashboard-summary.dto.js';

/**
 * `GET /api/workspaces/:workspaceId/analytics` (+ `/export.csv`, `/comments.csv`) query (M6-T6,
 * D11 a / D12 b). `from` + `to` = inclusive Asia/Dhaka days (both or neither; neither = the last
 * 30 days), `from ≤ to ≤ today`. Caps: analytics ≤ 12 calendar months (daily ≤ 92 days, else
 * monthly), daily CSV ≤ 366 days, per-comment CSV ≤ 92 days (cross-field rules → 400 in
 * `analytics.ts`). `pageId` = our `social_pages.id` of this workspace (unknown/foreign → 404).
 */
export class AnalyticsQueryDto {
  @IsOptional()
  @IsString()
  @Matches(DATE_KEY, { message: 'from must be a date (YYYY-MM-DD)' })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_KEY, { message: 'to must be a date (YYYY-MM-DD)' })
  to?: string;

  @IsOptional()
  @IsUUID()
  pageId?: string;
}

/** Every `daily_comment_stats` counter + the M6-T5 derived ones. */
export type AnalyticsCounts = Record<DailyCommentCounter, number> & {
  /** classified + ruleMatched. */
  scanned: number;
  /** AUTO hidden + deleted. */
  autoHidden: number;
};

export interface AnalyticsBucket extends AnalyticsCounts {
  /** `YYYY-MM-DD` (day) or `YYYY-MM` (month), Asia/Dhaka. */
  bucket: string;
}

export interface AnalyticsResponse {
  from: string;
  to: string;
  granularity: Granularity;
  /** The filtered Page, `null` = every Page of the workspace. */
  page: { id: string; name: string } | null;
  totals: AnalyticsCounts;
  /** Every bucket of the range, oldest first, zero-filled. */
  series: AnalyticsBucket[];
  /** All five categories, `MODERATION_CATEGORIES` order. */
  intents: CategoryCount[];
  /** The four non-SAFE categories. */
  flagged: CategoryCount[];
}
