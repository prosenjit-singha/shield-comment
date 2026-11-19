import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, count, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  dailyCommentStats,
  plans,
  subscriptions,
  tickets,
  UNRESOLVED_TICKET_STATUSES,
  workspaces,
} from '../db/schema/index.js';
import { isLiveAt } from '../wallet/live-subscription.queries.js';
import {
  type DashboardRangeQuery,
  type Granularity,
  resolveDashboardRange,
} from './dashboard-range.js';
import { buildDashboardStats } from './dashboard-stats.js';
import type { DashboardStatsResponse } from './dto/dashboard-stats.dto.js';

/** `to_char` formats per granularity (constants, inlined as raw SQL so GROUP BY matches). */
const BUCKET_FORMAT: Record<Granularity, string> = {
  day: 'YYYY-MM-DD',
  month: 'YYYY-MM',
};

/**
 * Plan tiers (M2-T12b; PW-T6b): ACTIVE workspaces per **live-subscription** plan at `now` (each
 * workspace of a pooled account counts; a trial counts as its plan, Starter). Workspaces without a
 * live plan (no billing account, ended, never) are not counted. Same live rule as
 * `findLiveSubscription`.
 */
export function planTiersQuery(db: Database, now: Date) {
  return db
    .select({
      name: plans.name,
      sortOrder: plans.sortOrder,
      clients: count(),
    })
    .from(workspaces)
    .innerJoin(
      subscriptions,
      and(
        eq(subscriptions.billingAccountId, workspaces.billingAccountId),
        isLiveAt(now),
      ),
    )
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(workspaces.status, 'ACTIVE'))
    .groupBy(plans.id)
    .orderBy(asc(plans.sortOrder), asc(plans.name));
}

/**
 * Platform-wide dashboard numbers for super admins (M2-T5; comments M5-T13). Cross-tenant by
 * design: only reachable through `SuperAdminGuard`.
 */
@Injectable()
export class AdminDashboardService {
  /** Overridable clock (tests). */
  now: () => Date = () => new Date();

  constructor(@InjectDrizzle() private readonly db: Database) {}

  async stats(query: DashboardRangeQuery): Promise<DashboardStatsResponse> {
    const now = this.now();
    const range = resolveDashboardRange(query, now);
    const format = sql.raw(`'${BUCKET_FORMAT[range.granularity]}'`);
    const bucket = sql<string>`to_char(${workspaces.createdAt} at time zone 'Asia/Dhaka', ${format})`;
    // `daily_comment_stats.day` is already a Dhaka date.
    const s = dailyCommentStats;
    const statsBucket = sql<string>`to_char(${s.day}, ${format})`;

    const [perBucket, [before], [active], [open], tiers, comments] =
      await Promise.all([
        this.db
          .select({ bucket, newClients: count() })
          .from(workspaces)
          .where(
            and(
              gte(workspaces.createdAt, range.start),
              lt(workspaces.createdAt, range.end),
            ),
          )
          .groupBy(bucket),
        this.db
          .select({ n: count() })
          .from(workspaces)
          .where(lt(workspaces.createdAt, range.start)),
        this.db
          .select({ n: count() })
          .from(workspaces)
          .where(eq(workspaces.status, 'ACTIVE')),
        this.db
          .select({ n: count() })
          .from(tickets)
          .where(inArray(tickets.status, [...UNRESOLVED_TICKET_STATUSES])),
        planTiersQuery(this.db, now),
        // Comments (M5-T13, D14): every workspace's daily counters in the range's Dhaka days.
        this.db
          .select({
            bucket: statsBucket,
            classified:
              sql<number>`coalesce(sum(${s.classifiedCount}), 0)`.mapWith(
                Number,
              ),
            hidden: sql<number>`coalesce(sum(${s.hiddenCount}), 0)`.mapWith(
              Number,
            ),
            deleted: sql<number>`coalesce(sum(${s.deletedCount}), 0)`.mapWith(
              Number,
            ),
          })
          .from(s)
          .where(sql`${s.day} between ${range.from} and ${range.to}`)
          .groupBy(statsBucket),
      ]);

    return buildDashboardStats(range, {
      activeClients: active?.n ?? 0,
      clientsBefore: before?.n ?? 0,
      openTickets: open?.n ?? 0,
      planTiers: tiers,
      newClients: Object.fromEntries(
        perBucket.map((r) => [r.bucket, r.newClients]),
      ),
      comments: Object.fromEntries(
        comments.map(({ bucket: key, ...counts }) => [key, counts]),
      ),
    });
  }
}
