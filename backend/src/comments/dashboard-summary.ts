import { and, count, eq, sql, type SQL } from 'drizzle-orm';
import {
  bucketKeys,
  resolveDashboardRange,
  type ResolvedRange,
} from '../admin/dashboard-range.js';
import type { Database } from '../db/database.js';
import { comments, dailyCommentStats } from '../db/schema/index.js';
import {
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_KEYS,
} from '../moderation/moderation.constants.js';
import type {
  DashboardSummaryResponse,
  SummaryRange,
} from './dto/dashboard-summary.dto.js';

/**
 * Workspace dashboard summary (M6-T5, Module 6 D10 a). `daily_comment_stats` summed over the
 * workspace's Pages/platforms per Dhaka day (AUTO outcomes only, reading 6) + the live
 * `NEEDS_REVIEW` count. Every query is scoped by `workspace_id`.
 */

export const SUMMARY_COUNTERS = [
  'classified',
  'ruleMatched',
  'hidden',
  'deleted',
  ...Object.values(MODERATION_CATEGORY_KEYS),
] as const;
export type SummaryCounter = (typeof SUMMARY_COUNTERS)[number];
export type SummaryCounts = Partial<Record<SummaryCounter, number>>;

/** Pure: zero-fills every Dhaka day of `range` and derives KPIs, intents and flagged. */
export function buildDashboardSummary(
  range: ResolvedRange & { range: SummaryRange },
  perDay: Readonly<Record<string, SummaryCounts>>,
  needsReview: number,
): DashboardSummaryResponse {
  const total: Record<SummaryCounter, number> = Object.fromEntries(
    SUMMARY_COUNTERS.map((k) => [k, 0]),
  ) as Record<SummaryCounter, number>;
  const daily = bucketKeys(range).map((day) => {
    const c = perDay[day] ?? {};
    for (const k of SUMMARY_COUNTERS) total[k] += c[k] ?? 0;
    return {
      day,
      scanned: (c.classified ?? 0) + (c.ruleMatched ?? 0),
      autoHidden: (c.hidden ?? 0) + (c.deleted ?? 0),
    };
  });
  const intents = MODERATION_CATEGORIES.map((category) => ({
    category,
    count: total[MODERATION_CATEGORY_KEYS[category]],
  }));
  return {
    range: range.range,
    kpis: {
      scanned: total.classified + total.ruleMatched,
      autoHidden: total.hidden + total.deleted,
      needsReview,
      scamsBlocked: total.scamPhishing,
    },
    daily,
    intents,
    flagged: intents.filter((i) => i.category !== 'SAFE_INQUIRY'),
  };
}

export async function workspaceDashboardSummary(
  db: Database,
  workspaceId: string,
  preset: SummaryRange,
  now: Date,
): Promise<DashboardSummaryResponse> {
  const range = {
    ...resolveDashboardRange({ range: preset }, now),
    range: preset,
  };
  const s = dailyCommentStats;
  const sums = Object.fromEntries(
    SUMMARY_COUNTERS.map((k) => [
      k,
      sql<number>`coalesce(sum(${s[`${k}Count`]}), 0)`.mapWith(Number),
    ]),
  ) as Record<SummaryCounter, SQL<number>>;

  const [rows, [review]] = await Promise.all([
    db
      .select({ day: s.day, ...sums })
      .from(s)
      .where(
        and(
          eq(s.workspaceId, workspaceId),
          sql`${s.day} between ${range.from} and ${range.to}`,
        ),
      )
      .groupBy(s.day),
    db
      .select({ n: count() })
      .from(comments)
      .where(
        and(
          eq(comments.workspaceId, workspaceId),
          eq(comments.status, 'NEEDS_REVIEW'),
        ),
      ),
  ]);
  return buildDashboardSummary(
    range,
    Object.fromEntries(rows.map(({ day, ...counts }) => [day, counts])),
    review?.n ?? 0,
  );
}
