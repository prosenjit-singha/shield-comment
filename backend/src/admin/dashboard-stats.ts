import {
  bucketKeys,
  DASHBOARD_TIMEZONE,
  type ResolvedRange,
} from './dashboard-range.js';
import type {
  CommentsPoint,
  DashboardStatsResponse,
  PlanTierSlice,
} from './dto/dashboard-stats.dto.js';

/** Platform-wide `daily_comment_stats` sums of one bucket (M5-T13, D14). */
export interface CommentCounts {
  classified: number;
  hidden: number;
  deleted: number;
}

/**
 * D14 mapping (M5-T13): `scanned` = AI classifications (`classified`, re-checked edits included),
 * `blocked` = successful AI hides + deletes (`hidden` + `deleted`). Later unhides are not
 * subtracted: the chart counts blocking actions taken in the bucket.
 */
export function commentsPoint(
  bucket: string,
  counts: CommentCounts | undefined,
): CommentsPoint {
  return {
    bucket,
    scanned: counts?.classified ?? 0,
    blocked: (counts?.hidden ?? 0) + (counts?.deleted ?? 0),
  };
}

/** ACTIVE workspaces per live-subscription plan, as counted by the database (M2-T12b, PW-T6b). */
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
  /** ACTIVE workspaces per live plan right now (workspaces without a live plan are not included). */
  planTiers: readonly PlanTierCount[];
  /** `daily_comment_stats` sums per bucket key, all workspaces (M5-T13); missing keys = 0. */
  comments?: Readonly<Record<string, CommentCounts>>;
}

/**
 * Donut slices: plans with at least one client, by `sortOrder` (then name), `tier` = plan name.
 * `[]` when no workspace has a live plan.
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
 * (MRR, gateways) are zeros or empty lists, never `null`. `commentsScanned` = the range's
 * `scanned` total.
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
  const comments = keys.map((bucket) =>
    commentsPoint(bucket, sources.comments?.[bucket]),
  );
  return {
    range: range.range,
    granularity: range.granularity,
    timezone: DASHBOARD_TIMEZONE,
    from: range.from,
    to: range.to,
    kpis: {
      activeClients: sources.activeClients,
      mrrBdt: 0,
      commentsScanned: comments.reduce((sum, p) => sum + p.scanned, 0),
      openTickets: sources.openTickets,
    },
    series: {
      growth,
      comments,
      planTiers: planTierSlices(sources.planTiers),
      gateways: [],
    },
  };
}
