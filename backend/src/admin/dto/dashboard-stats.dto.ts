import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import {
  DASHBOARD_RANGES,
  DATE_KEY,
  type DashboardPreset,
  type DashboardRangeName,
  type Granularity,
} from '../dashboard-range.js';

/**
 * `GET /api/admin/dashboard/stats` query (M2-T5): either `range` (`7d` | `30d` | `90d` | `12m`,
 * default `30d`) or a custom `from` + `to` (inclusive Asia/Dhaka dates, `YYYY-MM-DD`). Formats are
 * checked here; cross-field rules (both or neither, `from ≤ to ≤ today`, ≤ 24 months) in
 * `resolveDashboardRange`. No numeric fields, so no `@Type(() => Number)` is needed.
 */
export class DashboardStatsQueryDto {
  @IsOptional()
  @IsIn(DASHBOARD_RANGES)
  range?: DashboardPreset;

  @IsOptional()
  @IsString()
  @Matches(DATE_KEY, { message: 'from must be a date (YYYY-MM-DD)' })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_KEY, { message: 'to must be a date (YYYY-MM-DD)' })
  to?: string;
}

/** Point-in-time KPIs. Placeholders are `0` until their data source exists (never `null`). */
export interface DashboardKpis {
  /** Workspaces whose status is `ACTIVE` right now. */
  activeClients: number;
  /** Current MRR in BDT. Placeholder `0` until payments (Module 8). */
  mrrBdt: number;
  /** AI classifications inside the range, all workspaces (sum of `series.comments[].scanned`). */
  commentsScanned: number;
  /** Unresolved support tickets right now (OPEN + IN_PROGRESS), not limited to the range. */
  openTickets: number;
}

/** Line chart: MRR (left axis) + client growth (right axis), one point per bucket. */
export interface GrowthPoint {
  /** `YYYY-MM-DD` (day) or `YYYY-MM` (month), Asia/Dhaka. */
  bucket: string;
  /** Workspaces created in this bucket (any current status). */
  newClients: number;
  /** Workspaces created before the end of this bucket (running total, existing rows only). */
  totalClients: number;
  /** MRR in BDT at the end of this bucket. Placeholder `0`. */
  mrrBdt: number;
}

/**
 * Grouped bar chart: comments scanned vs blocked per bucket, all workspaces, from
 * `daily_comment_stats` (M5-T13, D14).
 */
export interface CommentsPoint {
  bucket: string;
  /** `classified` count: AI classifications (re-checked edits included). */
  scanned: number;
  /** `hidden` + `deleted` counts: successful AI hide/delete actions. */
  blocked: number;
}

/**
 * Donut: ACTIVE clients per plan right now (M2-T12b). Only plans with ≥ 1 client, by plan
 * `sortOrder`; workspaces without a plan are not counted, so `[]` until Module 8 assigns plans.
 */
export interface PlanTierSlice {
  /** Plan name. */
  tier: string;
  clients: number;
}

/** Bar chart: payment volume per gateway inside the range. Empty until Module 8 (SSLCommerz). */
export interface GatewaySlice {
  gateway: string;
  amountBdt: number;
  transactions: number;
}

/** `GET /api/admin/dashboard/stats` response. The admin app (M2-T6) mirrors this shape. */
export interface DashboardStatsResponse {
  range: DashboardRangeName;
  granularity: Granularity;
  timezone: 'Asia/Dhaka';
  /** First Dhaka day of the range, inclusive. */
  from: string;
  /** Last Dhaka day of the range, inclusive. */
  to: string;
  kpis: DashboardKpis;
  series: {
    /** Every bucket of the range, oldest first, empty ones included. */
    growth: GrowthPoint[];
    /** Same buckets as `growth`. */
    comments: CommentsPoint[];
    planTiers: PlanTierSlice[];
    gateways: GatewaySlice[];
  };
}
