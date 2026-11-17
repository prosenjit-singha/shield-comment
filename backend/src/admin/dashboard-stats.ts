import {
  bucketKeys,
  DASHBOARD_TIMEZONE,
  type ResolvedRange,
} from './dashboard-range.js';
import type { DashboardStatsResponse } from './dto/dashboard-stats.dto.js';

/** What the database answered for one dashboard request. */
export interface DashboardSources {
  activeClients: number;
  /** Workspaces created before the range's first bucket. */
  clientsBefore: number;
  /** New workspaces per bucket key; missing keys = 0. */
  newClients: Readonly<Record<string, number>>;
}

/**
 * Zero-fills every bucket of the range and builds the response. Data sources that don't exist yet
 * (MRR, comments, tickets, plan tiers, gateways) are zeros or empty lists, never `null`.
 */
export function buildDashboardStats(
  range: ResolvedRange,
  sources: DashboardSources,
): DashboardStatsResponse {
  const keys = bucketKeys(range);
  let total = sources.clientsBefore;
  const growth = keys.map((bucket) => {
    const newClients = sources.newClients[bucket] ?? 0;
    total += newClients;
    return { bucket, newClients, totalClients: total, mrrBdt: 0 };
  });
  return {
    range: range.range,
    granularity: range.granularity,
    timezone: DASHBOARD_TIMEZONE,
    from: range.from,
    to: range.to,
    kpis: {
      activeClients: sources.activeClients,
      mrrBdt: 0,
      commentsScanned: 0,
      openTickets: 0,
    },
    series: {
      growth,
      comments: keys.map((bucket) => ({ bucket, scanned: 0, blocked: 0 })),
      planTiers: [],
      gateways: [],
    },
  };
}
