import { and, eq, gt, inArray, sql } from 'drizzle-orm';
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
import { type WalletPeriod, walletPeriodAt } from './wallet-period.js';

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
     * A trial's comment limit (`null` = the plan's monthly comments): the redemption snapshot of
     * a promotion trial (PR-T3), else the plan column (sign-up trials before PR-T3).
     */
    trialCommentLimit: number | null;
  };
}

/** A live subscription seen from its billing account (no workspace): what a wallet period needs. */
export type AccountLiveSubscription = Omit<LiveSubscription, 'workspaceId'>;

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
  // ponytail: the plan-column fallback is for pre-PR-T3 sign-up trials; PR-T7 drops it.
  trialCommentLimit: sql<
    number | null
  >`case when ${promotionRedemptions.id} is null then ${plans.trialCommentLimit} else ${promotionRedemptions.trialCommentLimit} end`,
};

/** The promotion a subscription redeemed (its trial snapshot), if any. */
const redemptionJoin = eq(
  promotionRedemptions.id,
  subscriptions.promotionRedemptionId,
);

/**
 * A subscription row that is live at `now`: TRIALING / ACTIVE and `now < current_term_end`. Also
 * used as a SQL condition by the admin reads (PW-T6b: client plan filter, dashboard plan tiers).
 */
export function isLiveAt(now: Date) {
  return and(
    inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
    gt(subscriptions.currentTermEnd, now),
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
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .leftJoin(promotionRedemptions, redemptionJoin)
    .where(inArray(workspaces.id, [...workspaceIds]));
}

type LiveRow = Awaited<ReturnType<typeof liveSubscriptionQuery>>[number];

function toAccountLiveSubscription(
  row: Omit<LiveRow, 'workspaceId'>,
): AccountLiveSubscription {
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

function toLiveSubscription(row: LiveRow): LiveSubscription {
  return { workspaceId: row.workspaceId, ...toAccountLiveSubscription(row) };
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
  return row ? toLiveSubscription(row) : null;
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
  return new Map(rows.map((row) => [row.workspaceId, toLiveSubscription(row)]));
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
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .leftJoin(promotionRedemptions, redemptionJoin)
    .where(
      and(eq(subscriptions.billingAccountId, billingAccountId), isLiveAt(now)),
    )
    .limit(1);
  return row ? toAccountLiveSubscription(row) : null;
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
