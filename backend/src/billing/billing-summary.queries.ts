import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  plans,
  type SubscriptionInterval,
  type SubscriptionStatus,
  subscriptions,
} from '../db/schema/index.js';

/** The subscription a billing summary describes, with its plan's slug + name (PW-T6). */
export interface SummarySubscription {
  id: string;
  status: SubscriptionStatus;
  interval: SubscriptionInterval;
  trialEndsAt: Date | null;
  currentTermEnd: Date;
  plan: { slug: string; name: string };
}

/**
 * The account's subscription to describe: the live one (`liveSubscriptionId`) when there is one,
 * else the most recently created (`created_at`, then id), or `undefined` when the account never
 * had one. Always scoped by the account id. One query.
 */
export async function findSummarySubscription(
  db: Pick<Database, 'select'>,
  billingAccountId: string,
  liveSubscriptionId: string | null,
): Promise<SummarySubscription | undefined> {
  const [row] = await db
    .select({
      id: subscriptions.id,
      status: subscriptions.status,
      interval: subscriptions.interval,
      trialEndsAt: subscriptions.trialEndsAt,
      currentTermEnd: subscriptions.currentTermEnd,
      planSlug: plans.slug,
      planName: plans.name,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.billingAccountId, billingAccountId),
        liveSubscriptionId === null
          ? undefined
          : eq(subscriptions.id, liveSubscriptionId),
      ),
    )
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(1);
  if (!row) return undefined;
  const { planSlug, planName, ...rest } = row;
  return { ...rest, plan: { slug: planSlug, name: planName } };
}

/** A described subscription of one billing account, with the plan id too (PW-T6b admin list). */
export interface AccountSummarySubscription extends Omit<
  SummarySubscription,
  'plan'
> {
  billingAccountId: string;
  plan: { id: string; slug: string; name: string };
}

/**
 * `findSummarySubscription` for many accounts in one query (PW-T6b: admin clients list, no N+1).
 * Per account: the live subscription when its id is in `liveSubscriptionIds`, else the most
 * recently created one (`created_at`, then id). Accounts that never had a subscription are not in
 * the map. Scoped by the given account ids.
 */
export async function findSummarySubscriptions(
  db: Pick<Database, 'selectDistinctOn'>,
  billingAccountIds: readonly string[],
  liveSubscriptionIds: readonly string[],
): Promise<Map<string, AccountSummarySubscription>> {
  const accounts = [...new Set(billingAccountIds)];
  if (accounts.length === 0) return new Map();
  // Live first (only when there is one: Postgres rejects a constant ORDER BY key).
  const liveFirst = liveSubscriptionIds.length
    ? [desc(sql`${inArray(subscriptions.id, [...liveSubscriptionIds])}`)]
    : [];
  const rows = await db
    .selectDistinctOn([subscriptions.billingAccountId], {
      billingAccountId: subscriptions.billingAccountId,
      id: subscriptions.id,
      status: subscriptions.status,
      interval: subscriptions.interval,
      trialEndsAt: subscriptions.trialEndsAt,
      currentTermEnd: subscriptions.currentTermEnd,
      planId: plans.id,
      planSlug: plans.slug,
      planName: plans.name,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(inArray(subscriptions.billingAccountId, accounts))
    .orderBy(
      subscriptions.billingAccountId,
      ...liveFirst,
      desc(subscriptions.createdAt),
      desc(subscriptions.id),
    );
  return new Map(
    rows.map(({ planId, planSlug, planName, ...rest }) => [
      rest.billingAccountId,
      { ...rest, plan: { id: planId, slug: planSlug, name: planName } },
    ]),
  );
}
