import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { workspaces } from '../db/schema/index.js';
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
 * Platform-wide dashboard numbers for super admins (M2-T5). Cross-tenant by design: only
 * reachable through `SuperAdminGuard`.
 */
@Injectable()
export class AdminDashboardService {
  /** Overridable clock (tests). */
  now: () => Date = () => new Date();

  constructor(@InjectDrizzle() private readonly db: Database) {}

  async stats(query: DashboardRangeQuery): Promise<DashboardStatsResponse> {
    const range = resolveDashboardRange(query, this.now());
    const bucket = sql<string>`to_char(${workspaces.createdAt} at time zone 'Asia/Dhaka', ${sql.raw(`'${BUCKET_FORMAT[range.granularity]}'`)})`;

    const [perBucket, [before], [active]] = await Promise.all([
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
    ]);

    return buildDashboardStats(range, {
      activeClients: active?.n ?? 0,
      clientsBefore: before?.n ?? 0,
      newClients: Object.fromEntries(
        perBucket.map((r) => [r.bucket, r.newClients]),
      ),
    });
  }
}
