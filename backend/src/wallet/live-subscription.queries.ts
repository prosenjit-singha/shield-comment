import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import type { Database } from '../db/database.js';
import {
  LIVE_SUBSCRIPTION_STATUSES,
  type PlanFeatureConfig,
  plans,
  promotionRedemptions,
  type SubscriptionInterval,
  subscriptions,
  workspaces,
} from '../db/schema/index.js';
import {
  monthlyReset,
  type WalletPeriod,
  walletPeriodAt,
} from './wallet-period.js';

/** The read-only Drizzle methods the live-subscription queries need (db or a transaction). */
export type LiveSubscriptionExecutor = Pick<Database, 'select'>;

/** A workspace's live plan: its account, the TRIALING / ACTIVE subscription and the plan row. */
export interface LiveSubscription {
  workspaceId: string;
  billingAccountId: string;
  subscriptionId: string;
  status: (typeof LIVE_SUBSCRIPTION_STATUSES)[number];
  interval: SubscriptionInterval;
  startedAt: Date;
  trialEndsAt: Date | null;
  currentTermStart: Date;
  currentTermEnd: Date;
  plan: {
    id: string;
    slug: string;
    /** Normalised (`normalizeFeatureConfig`): every limit key present. */
    featureConfig: PlanFeatureConfig;
    /**
     * A trial's comment limit: the redemption snapshot of a promotion trial (PR-T3); `null` = the
     * plan's monthly comments. Pre-PR-T3 sign-up trials have no redemption: their limit lives in
     * the trial's wallet period (`wallet_balances.included`, written at trial start; PR-T7).
     */
    trialCommentLimit: number | null;
  };
}

/** A live subscription seen from its billing account (no workspace): what a wallet period needs. */
export type AccountLiveSubscription = Omit<LiveSubscription, 'workspaceId'>;

/** End of a scheduled term (M8-D7b) starting at `start`: one month or year later (Dhaka, month-end clamp). */
export const scheduledTermEnd = (start: Date, interval: SubscriptionInterval) =>
  monthlyReset(start, interval === 'year' ? 12 : 1);

/**
 * The shortest scheduled term (28 days): bounds how long a row whose scheduled switch didn't run
 * stays live (the switch job runs every 15 min, so in practice minutes).
 */
const MIN_SCHEDULED_TERM = sql`interval '28 days'`;

/** The columns of a live subscription + its plan (shared by the workspace and account queries). */
const liveColumns = {
  billingAccountId: subscriptions.billingAccountId,
  subscriptionId: subscriptions.id,
  status: subscriptions.status,
  interval: subscriptions.interval,
  startedAt: subscriptions.startedAt,
  trialEndsAt: subscriptions.trialEndsAt,
  currentTermStart: subscriptions.currentTermStart,
  currentTermEnd: subscriptions.currentTermEnd,
  planId: plans.id,
  planSlug: plans.slug,
  featureConfig: plans.featureConfig,
  trialCommentLimit: promotionRedemptions.trialCommentLimit,
  scheduledInterval: subscriptions.scheduledInterval,
};

/**
 * The plan in force at `now`: the scheduled plan once the term with a scheduled change is over
 * (M8-D7b, before the switch job has written it), else the row's plan.
 */
const planInForce = (now: Date): SQL =>
  sql`case when ${subscriptions.currentTermEnd} <= ${now} then ${subscriptions.scheduledPlanId} else ${subscriptions.planId} end`;

/** The promotion a subscription redeemed (its trial snapshot), if any. */
const redemptionJoin = eq(
  promotionRedemptions.id,
  subscriptions.promotionRedemptionId,
);

/**
 * A subscription row that is live at `now`: TRIALING / ACTIVE and `now < current_term_end`, or
 * (M8-T6, no gap) a row with a scheduled change (M8-D7b) whose term ended but whose switch has not
 * run yet: its scheduled term is live from the old end on. Also used as a SQL condition by the
 * admin reads (PW-T6b: client plan filter, dashboard plan tiers).
 */
export function isLiveAt(now: Date) {
  return and(
    inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
    or(
      gt(subscriptions.currentTermEnd, now),
      and(
        isNotNull(subscriptions.scheduledPlanId),
        sql`${subscriptions.currentTermEnd} + ${MIN_SCHEDULED_TERM} > ${now}`,
      ),
    ),
  );
}

/**
 * Shared live-subscription query (PW-T2; reused by PW-T3…T6). Workspace → `billing_account_id`
 * → the subscription with status in `LIVE_SUBSCRIPTION_STATUSES` and `now < current_term_end`
 * (a late expiry job never extends a plan) → plan. Scoped by the workspace ids; the join keeps
 * the subscription on the workspace's own account.
 */
function liveSubscriptionQuery(
  db: LiveSubscriptionExecutor,
  workspaceIds: readonly string[],
  now: Date,
) {
  return db
    .select({ workspaceId: workspaces.id, ...liveColumns })
    .from(workspaces)
    .innerJoin(
      subscriptions,
      and(
        eq(subscriptions.billingAccountId, workspaces.billingAccountId),
        isLiveAt(now),
      ),
    )
    .innerJoin(plans, eq(plans.id, planInForce(now)))
    .leftJoin(promotionRedemptions, redemptionJoin)
    .where(inArray(workspaces.id, [...workspaceIds]));
}

type LiveRow = Awaited<ReturnType<typeof liveSubscriptionQuery>>[number];

/**
 * Maps a live row. A row past its end is one with a scheduled change (`isLiveAt`): it reads as the
 * scheduled term `[old end, old end + interval)` on the scheduled plan (joined by `planInForce`),
 * exactly what the switch writes (`SubscriptionService.switchScheduled`), so readers see no gap.
 */
function toAccountLiveSubscription(
  row: Omit<LiveRow, 'workspaceId'>,
  now: Date,
): AccountLiveSubscription {
  if (row.scheduledInterval && row.currentTermEnd.getTime() <= now.getTime()) {
    const start = row.currentTermEnd;
    return {
      billingAccountId: row.billingAccountId,
      subscriptionId: row.subscriptionId,
      status: 'ACTIVE',
      interval: row.scheduledInterval,
      startedAt: start,
      trialEndsAt: null,
      currentTermStart: start,
      currentTermEnd: scheduledTermEnd(start, row.scheduledInterval),
      plan: {
        id: row.planId,
        slug: row.planSlug,
        featureConfig: normalizeFeatureConfig(row.featureConfig),
        trialCommentLimit: null,
      },
    };
  }
  return {
    billingAccountId: row.billingAccountId,
    subscriptionId: row.subscriptionId,
    status: row.status === 'TRIALING' ? 'TRIALING' : 'ACTIVE',
    interval: row.interval,
    startedAt: row.startedAt,
    trialEndsAt: row.trialEndsAt,
    currentTermStart: row.currentTermStart,
    currentTermEnd: row.currentTermEnd,
    plan: {
      id: row.planId,
      slug: row.planSlug,
      featureConfig: normalizeFeatureConfig(row.featureConfig),
      trialCommentLimit: row.trialCommentLimit,
    },
  };
}

function toLiveSubscription(row: LiveRow, now: Date): LiveSubscription {
  return {
    workspaceId: row.workspaceId,
    ...toAccountLiveSubscription(row, now),
  };
}

/**
 * The workspace's live plan at `now`, or `null` (unknown workspace, no billing account, no live
 * subscription, or its term is over). One query.
 */
export async function findLiveSubscription(
  db: LiveSubscriptionExecutor,
  workspaceId: string,
  now: Date = new Date(),
): Promise<LiveSubscription | null> {
  const [row] = await liveSubscriptionQuery(db, [workspaceId], now).limit(1);
  return row ? toLiveSubscription(row, now) : null;
}

/**
 * `findLiveSubscription` for many workspaces in one query: a map holding only the workspaces with
 * a live plan.
 */
export async function findLiveSubscriptions(
  db: LiveSubscriptionExecutor,
  workspaceIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, LiveSubscription>> {
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) return new Map();
  const rows = await liveSubscriptionQuery(db, ids, now);
  return new Map(
    rows.map((row) => [row.workspaceId, toLiveSubscription(row, now)]),
  );
}

/**
 * The billing account's live plan at `now`, or `null` (PW-T5: workspace creation and seat limits
 * are checked per account, before a workspace exists). One query, scoped by the account id.
 */
export async function findAccountLiveSubscription(
  db: LiveSubscriptionExecutor,
  billingAccountId: string,
  now: Date = new Date(),
): Promise<AccountLiveSubscription | null> {
  const [row] = await db
    .select(liveColumns)
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, planInForce(now)))
    .leftJoin(promotionRedemptions, redemptionJoin)
    .where(
      and(eq(subscriptions.billingAccountId, billingAccountId), isLiveAt(now)),
    )
    .limit(1);
  return row ? toAccountLiveSubscription(row, now) : null;
}

/**
 * The wallet period of a live subscription at `now` (PW-D4 + the confirmed PW-PLAN reading):
 * - a trial is **one** period `[started_at, trial_ends_at)` anchored at `started_at`;
 * - a paid term is anchored at `current_term_start` and resets monthly (yearly terms too), each
 *   period cut at `current_term_end`.
 */
export function subscriptionPeriod(
  live: Pick<
    LiveSubscription,
    'status' | 'startedAt' | 'currentTermStart' | 'currentTermEnd'
  >,
  now: Date,
): WalletPeriod {
  if (live.status === 'TRIALING') {
    return {
      anchor: live.startedAt,
      start: live.startedAt,
      end: live.currentTermEnd,
    };
  }
  return walletPeriodAt(live.currentTermStart, now, live.currentTermEnd);
}
