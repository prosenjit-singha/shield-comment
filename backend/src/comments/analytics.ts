import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import {
  bucketKeys,
  daysSpanned,
  DHAKA_OFFSET_MS,
  resolveDashboardRange,
  type ResolvedRange,
} from '../admin/dashboard-range.js';
import type { Database } from '../db/database.js';
import { snakeCase } from '../db/schema/check-sql.js';
import {
  type CommentPlatform,
  type CommentStatus,
  comments,
  DAILY_COMMENT_COUNTERS,
  type DailyCommentCounter,
  dailyCommentStats,
  moderationActions,
  socialPages,
} from '../db/schema/index.js';
import { MODERATION_POLICY_ERROR_CODES } from '../moderation/dto/moderation-policy.dto.js';
import {
  type CommentLanguage,
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_KEYS,
  type ModerationActionSource,
  type ModerationActionState,
  type ModerationActionType,
  type ModerationCategory,
} from '../moderation/moderation.constants.js';
import { findLiveSubscription } from '../wallet/live-subscription.queries.js';
import { type CsvCell, toCsv } from './csv.js';
import type {
  AnalyticsCounts,
  AnalyticsQueryDto,
  AnalyticsResponse,
} from './dto/analytics.dto.js';

/**
 * Workspace analytics + CSV exports (M6-T6; D11 a, D12 b answered 2026-11-20). Counters come from
 * `daily_comment_stats` (AUTO outcomes only, reading 6); the per-comment CSV reads `comments` +
 * the latest `moderation_actions` row. Every query is scoped by `workspace_id`.
 */

/** D11: analytics cover at most 12 calendar months (daily ≤ 92 days, else monthly). */
export const ANALYTICS_MAX_MONTHS = 12;
/** D12: daily aggregates CSV ≤ 366 days, every plan. */
export const DAILY_CSV_MAX_DAYS = 366;
/** D12: per-comment CSV ≤ 92 days, Pro only (`whiteLabelReports`). */
export const COMMENTS_CSV_MAX_DAYS = 92;

export type CounterCounts = Partial<Record<DailyCommentCounter, number>>;

export interface AnalyticsPage {
  id: string;
  name: string;
  /** Meta Page id = `daily_comment_stats.page_id` (FB and its linked IG account). */
  metaPageId: string;
}

/** Validated query → range for the analytics endpoint (400 on cross-field errors). */
export function analyticsRange(
  query: AnalyticsQueryDto,
  now: Date,
): ResolvedRange {
  return resolveDashboardRange(
    { from: query.from, to: query.to },
    now,
    ANALYTICS_MAX_MONTHS,
  );
}

/** Validated query → range for a CSV export of at most `maxDays` days (400 otherwise). */
export function csvRange(
  query: AnalyticsQueryDto,
  now: Date,
  maxDays: number,
): ResolvedRange {
  const range = resolveDashboardRange({ from: query.from, to: query.to }, now);
  if (daysSpanned(range.from, range.to) > maxDays) {
    throw new BadRequestException(
      `This export may cover at most ${maxDays} days`,
    );
  }
  return range;
}

const zeroCounts = () =>
  Object.fromEntries(DAILY_COMMENT_COUNTERS.map((k) => [k, 0])) as Record<
    DailyCommentCounter,
    number
  >;

const withDerived = (
  c: Record<DailyCommentCounter, number>,
): AnalyticsCounts => ({
  ...c,
  scanned: c.classified + c.ruleMatched,
  autoHidden: c.hidden + c.deleted,
});

/** Pure: per-day counters → zero-filled day/month buckets, totals and category counts. */
export function buildAnalytics(
  range: ResolvedRange,
  perDay: Readonly<Record<string, CounterCounts>>,
  page: { id: string; name: string } | null,
): AnalyticsResponse {
  const buckets = new Map(bucketKeys(range).map((k) => [k, zeroCounts()]));
  const totals = zeroCounts();
  for (const [day, counts] of Object.entries(perDay)) {
    if (day < range.from || day > range.to) continue;
    const bucket = buckets.get(
      range.granularity === 'day' ? day : day.slice(0, 7),
    );
    if (!bucket) continue;
    for (const k of DAILY_COMMENT_COUNTERS) {
      bucket[k] += counts[k] ?? 0;
      totals[k] += counts[k] ?? 0;
    }
  }
  const intents = MODERATION_CATEGORIES.map((category) => ({
    category,
    count: totals[MODERATION_CATEGORY_KEYS[category]],
  }));
  return {
    from: range.from,
    to: range.to,
    granularity: range.granularity,
    page,
    totals: withDerived(totals),
    series: [...buckets].map(([bucket, c]) => ({
      bucket,
      ...withDerived(c),
    })),
    intents,
    flagged: intents.filter((i) => i.category !== 'SAFE_INQUIRY'),
  };
}

export interface DailyCsvRow extends CounterCounts {
  day: string;
  pageId: string;
  pageName: string | null;
  platform: CommentPlatform;
}

export const DAILY_CSV_HEADER = [
  'day',
  'page_id',
  'page_name',
  'platform',
  ...DAILY_COMMENT_COUNTERS.map(snakeCase),
] as const;

/** Pure: one CSV row per day × Page × platform, every counter (D12; no comment text). */
export function dailyStatsCsv(rows: readonly DailyCsvRow[]): string {
  return toCsv(
    DAILY_CSV_HEADER,
    rows.map((r) => [
      r.day,
      r.pageId,
      r.pageName,
      r.platform,
      ...DAILY_COMMENT_COUNTERS.map((k) => r[k] ?? 0),
    ]),
  );
}

export interface CommentCsvRow {
  createdAt: Date;
  pageId: string | null;
  pageName: string | null;
  platform: CommentPlatform;
  message: string | null;
  status: CommentStatus;
  category: ModerationCategory | null;
  confidence: number | null;
  language: CommentLanguage | null;
  lastAction: ModerationActionType | null;
  lastActionBy: ModerationActionSource | null;
  lastActionState: ModerationActionState | null;
}

export const COMMENTS_CSV_HEADER = [
  'time_dhaka',
  'page_id',
  'page_name',
  'platform',
  'text',
  'status',
  'category',
  'confidence',
  'language',
  'last_action',
  'last_action_by',
  'last_action_state',
] as const;

/** `YYYY-MM-DD HH:mm:ss` in Asia/Dhaka (Excel reads it as a date-time). */
export function dhakaDateTime(instant: Date): string {
  return new Date(instant.getTime() + DHAKA_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

/** Pure: one CSV row per comment (D12 b; no author ids, no raw payload). */
export function commentsCsv(rows: readonly CommentCsvRow[]): string {
  return toCsv(
    COMMENTS_CSV_HEADER,
    rows.map((r): CsvCell[] => [
      dhakaDateTime(r.createdAt),
      r.pageId,
      r.pageName,
      r.platform,
      r.message,
      r.status,
      r.category,
      r.confidence,
      r.language,
      r.lastAction,
      r.lastActionBy,
      r.lastActionState,
    ]),
  );
}

/** `social_pages.id` of this workspace → the Page, else 404. */
export async function findAnalyticsPage(
  db: Pick<Database, 'select'>,
  workspaceId: string,
  pageId: string,
): Promise<AnalyticsPage> {
  const [page] = await db
    .select({
      id: socialPages.id,
      name: socialPages.pageName,
      metaPageId: socialPages.pageId,
    })
    .from(socialPages)
    .where(
      and(eq(socialPages.id, pageId), eq(socialPages.workspaceId, workspaceId)),
    );
  if (!page) throw new NotFoundException('Page not found');
  return page;
}

const s = dailyCommentStats;
const counterSql = (wrap: (column: SQL) => SQL) =>
  Object.fromEntries(
    DAILY_COMMENT_COUNTERS.map((k) => [
      k,
      sql<number>`${wrap(sql`${s[`${k}Count`]}`)}`.mapWith(Number),
    ]),
  ) as Record<DailyCommentCounter, SQL<number>>;

function statsWhere(
  workspaceId: string,
  range: ResolvedRange,
  page: AnalyticsPage | null,
) {
  return and(
    eq(s.workspaceId, workspaceId),
    sql`${s.day} between ${range.from} and ${range.to}`,
    page ? eq(s.pageId, page.metaPageId) : undefined,
  );
}

export async function workspaceAnalytics(
  db: Database,
  workspaceId: string,
  query: AnalyticsQueryDto,
  now: Date,
): Promise<AnalyticsResponse> {
  const range = analyticsRange(query, now);
  const page = query.pageId
    ? await findAnalyticsPage(db, workspaceId, query.pageId)
    : null;
  const rows = await db
    .select({
      day: s.day,
      ...counterSql((c) => sql`coalesce(sum(${c}), 0)`),
    })
    .from(s)
    .where(statsWhere(workspaceId, range, page))
    .groupBy(s.day);
  return buildAnalytics(
    range,
    Object.fromEntries(rows.map(({ day, ...counts }) => [day, counts])),
    page && { id: page.id, name: page.name },
  );
}

export interface CsvExport {
  filename: string;
  csv: string;
}

export async function dailyStatsExport(
  db: Database,
  workspaceId: string,
  query: AnalyticsQueryDto,
  now: Date,
): Promise<CsvExport> {
  const range = csvRange(query, now, DAILY_CSV_MAX_DAYS);
  const page = query.pageId
    ? await findAnalyticsPage(db, workspaceId, query.pageId)
    : null;
  const rows = await db
    .select({
      day: s.day,
      pageId: s.pageId,
      pageName: socialPages.pageName,
      platform: s.platform,
      ...counterSql((c) => c),
    })
    .from(s)
    .leftJoin(
      socialPages,
      and(
        eq(socialPages.pageId, s.pageId),
        eq(socialPages.workspaceId, workspaceId),
      ),
    )
    .where(statsWhere(workspaceId, range, page))
    .orderBy(s.day, s.pageId, s.platform);
  return {
    filename: `shieldcomment-daily-stats-${range.from}-to-${range.to}.csv`,
    csv: dailyStatsCsv(rows),
  };
}

/** 409 `PLAN_FEATURE_UNAVAILABLE` unless the live plan has `whiteLabelReports` (Pro, D12 b). */
export async function assertCommentsExportAllowed(
  db: Pick<Database, 'select'>,
  workspaceId: string,
  now: Date,
): Promise<void> {
  const live = await findLiveSubscription(db, workspaceId, now);
  if (live?.plan.featureConfig.features.whiteLabelReports) return;
  throw new ConflictException({
    message:
      'Per-comment exports are included in the Pro plan. Upgrade to Pro to download them.',
    error: 'Conflict',
    code: MODERATION_POLICY_ERROR_CODES.planFeatureUnavailable,
    details: { feature: 'whiteLabelReports' },
  });
}

export async function commentsExport(
  db: Database,
  workspaceId: string,
  query: AnalyticsQueryDto,
  now: Date,
): Promise<CsvExport> {
  const range = csvRange(query, now, COMMENTS_CSV_MAX_DAYS);
  await assertCommentsExportAllowed(db, workspaceId, now);
  const page = query.pageId
    ? await findAnalyticsPage(db, workspaceId, query.pageId)
    : null;
  const a = moderationActions;
  const last = db
    .select({ action: a.action, source: a.source, state: a.state })
    .from(a)
    .where(and(eq(a.workspaceId, workspaceId), eq(a.commentId, comments.id)))
    .orderBy(desc(a.createdAt), desc(a.id))
    .limit(1)
    .as('last_action');
  // ponytail: whole export built in memory (≤ 92 days of one workspace); stream with a cursor
  // if a workspace ever exports hundreds of thousands of comments.
  const rows = await db
    .select({
      createdAt: comments.createdAt,
      pageId: socialPages.pageId,
      pageName: socialPages.pageName,
      platform: comments.platform,
      message: comments.message,
      status: comments.status,
      category: comments.category,
      confidence: comments.confidence,
      language: comments.language,
      lastAction: last.action,
      lastActionBy: last.source,
      lastActionState: last.state,
    })
    .from(comments)
    .leftJoin(
      socialPages,
      and(
        eq(socialPages.id, comments.socialPageId),
        eq(socialPages.workspaceId, workspaceId),
      ),
    )
    .leftJoinLateral(last, sql`true`)
    .where(
      and(
        eq(comments.workspaceId, workspaceId),
        gte(comments.createdAt, range.start),
        lt(comments.createdAt, range.end),
        page ? eq(comments.socialPageId, page.id) : undefined,
      ),
    )
    .orderBy(comments.createdAt, comments.id);
  return {
    filename: `shieldcomment-comments-${range.from}-to-${range.to}.csv`,
    csv: commentsCsv(rows),
  };
}
