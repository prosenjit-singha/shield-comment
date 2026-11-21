import type {
  SubscriptionInterval,
  SubscriptionStatus,
} from '../db/schema/index.js';
import {
  addDays,
  bucketKeys,
  DASHBOARD_TIMEZONE,
  dhakaMidnight,
  type Granularity,
  type ResolvedRange,
} from './dashboard-range.js';
import type {
  CommentsPoint,
  DashboardStatsResponse,
  GatewaySlice,
  PlanTierSlice,
} from './dto/dashboard-stats.dto.js';

/** A paid subscription row as MRR reads it (M8-T8, reading 13): trials (no price) never count. */
export interface MrrSubscription {
  status: SubscriptionStatus;
  interval: SubscriptionInterval;
  chargedBdt: number;
  currentTermStart: Date;
  currentTermEnd: Date;
  canceledAt: Date | null;
  /** M8-D7b scheduled next term (`scheduled_interval` + `scheduled_price.chargedBdt`), if any. */
  scheduledInterval: SubscriptionInterval | null;
  scheduledChargedBdt: number | null;
}

/** Same bound as `isLiveAt`: a scheduled term reads as live up to 28 days past the old end. */
const SCHEDULED_GRACE_MS = 28 * 86_400_000;

/** Per-month value of a term: monthly = charged, yearly = charged ÷ 12 (reading 13). */
export const perMonthBdt = (
  interval: SubscriptionInterval,
  chargedBdt: number,
) => (interval === 'year' ? chargedBdt / 12 : chargedBdt);

/**
 * MRR at `t` (≤ `now`) in whole ৳ (reading 13): the per-month value of every paid term in force
 * at `t` (`[current_term_start, canceled_at ?? current_term_end)`; a row no longer ACTIVE ended by
 * `now` at the latest), plus a still-ACTIVE row's scheduled term once its old term ended (M8-D7b,
 * before the switch job runs). At `t = now` this is exactly the live ACTIVE rows (`isLiveAt`).
 * Summed, then rounded. ponytail: past buckets use each row's current price snapshot (a renewal that changed the
 * price rewrites history); store price history if the chart must be exact.
 */
export function mrrAt(
  subs: readonly MrrSubscription[],
  t: Date,
  now: Date = t,
): number {
  const at = t.getTime();
  let sum = 0;
  for (const s of subs) {
    const end = Math.min(
      (s.canceledAt ?? s.currentTermEnd).getTime(),
      s.status === 'ACTIVE' ? Infinity : now.getTime(),
    );
    if (s.currentTermStart.getTime() <= at && at < end) {
      sum += perMonthBdt(s.interval, s.chargedBdt);
    } else if (
      s.status === 'ACTIVE' &&
      s.scheduledInterval &&
      s.scheduledChargedBdt !== null &&
      s.currentTermEnd.getTime() <= at &&
      at < s.currentTermEnd.getTime() + SCHEDULED_GRACE_MS
    ) {
      sum += perMonthBdt(s.scheduledInterval, s.scheduledChargedBdt);
    }
  }
  return Math.round(sum);
}

/** First instant after a bucket (Dhaka midnight of the next day / month). */
export function bucketEnd(key: string, granularity: Granularity): Date {
  if (granularity === 'day') return dhakaMidnight(addDays(key, 1));
  const [y, m] = key.split('-').map(Number) as [number, number];
  return dhakaMidnight(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10));
}

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
  /** M8-T8: paid subscriptions that may be in force in the range, and the request time. */
  mrr?: { subscriptions: readonly MrrSubscription[]; now: Date };
  /** M8-T8: PAID volume per gateway label in the range. */
  gateways?: readonly GatewaySlice[];
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
 * Zero-fills every bucket of the range and builds the response. Missing sources are zeros or
 * empty lists, never `null`. `commentsScanned` = the range's `scanned` total. MRR (M8-T8): the KPI
 * = `mrrAt(now)`; each growth point = MRR at the end of its bucket (`now` for the current one).
 */
export function buildDashboardStats(
  range: ResolvedRange,
  sources: DashboardSources,
): DashboardStatsResponse {
  const keys = bucketKeys(range);
  const mrr = (t: Date) =>
    sources.mrr ? mrrAt(sources.mrr.subscriptions, t, sources.mrr.now) : 0;
  const nowMs = sources.mrr?.now.getTime() ?? 0;
  let total = sources.clientsBefore;
  const growth = keys.map((bucket) => {
    const newClients = sources.newClients[bucket] ?? 0;
    total += newClients;
    const last = bucketEnd(bucket, range.granularity).getTime() - 1;
    const mrrBdt = mrr(new Date(Math.min(last, nowMs)));
    return { bucket, newClients, totalClients: total, mrrBdt };
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
      mrrBdt: sources.mrr ? mrr(sources.mrr.now) : 0,
      commentsScanned: comments.reduce((sum, p) => sum + p.scanned, 0),
      openTickets: sources.openTickets,
    },
    series: {
      growth,
      comments,
      planTiers: planTierSlices(sources.planTiers),
      gateways: [...(sources.gateways ?? [])],
    },
  };
}
