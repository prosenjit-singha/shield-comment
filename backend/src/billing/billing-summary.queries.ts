import { and, desc, eq } from 'drizzle-orm';
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
