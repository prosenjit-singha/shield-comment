import {
  bucketKeys,
  DASHBOARD_TIMEZONE,
  type ResolvedRange,
} from './dashboard-range.js';
import type {
  DashboardStatsResponse,
  PlanTierSlice,
} from './dto/dashboard-stats.dto.js';

/** ACTIVE workspaces per plan, as counted by the database (M2-T12b). */
export interface PlanTierCount {
  name: string;
  sortOrder: number;
  clients: number;
}

/** What the database answered for one dashboard request. */
export interface DashboardSources {
  activeClients: number;
  /** Workspaces created before the range's first bucket. */
  clientsBefore: number;
  /** Unresolved tickets now (OPEN + IN_PROGRESS). */
  openTickets: number;
  /** New workspaces per bucket key; missing keys = 0. */
  newClients: Readonly<Record<string, number>>;
  /** ACTIVE workspaces per plan right now (workspaces without a plan are not included). */
  planTiers: readonly PlanTierCount[];
}

/**
 * Donut slices: plans with at least one client, by `sortOrder` (then name), `tier` = plan name.
 * `[]` when no workspace has a plan.
 */
export function planTierSlices(
  counts: readonly PlanTierCount[],
): PlanTierSlice[] {
  return counts
    .filter((c) => c.clients > 0)
    .toSorted(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    )
    .map(({ name, clients }) => ({ tier: name, clients }));
}

/**
 * Zero-fills every bucket of the range and builds the response. Data sources that don't exist yet
 * (MRR, comments, gateways) are zeros or empty lists, never `null`.
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
      openTickets: sources.openTickets,
    },
    series: {
      growth,
      comments: keys.map((bucket) => ({ bucket, scanned: 0, blocked: 0 })),
      planTiers: planTierSlices(sources.planTiers),
      gateways: [],
    },
  };
}
