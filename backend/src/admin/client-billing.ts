import type {
  SubscriptionInterval,
  SubscriptionStatus,
} from '../db/schema/index.js';
import { summaryStatus } from '../billing/billing-summary.js';
import type { AccountSummarySubscription } from '../billing/billing-summary.queries.js';
import type { LiveSubscription } from '../wallet/live-subscription.queries.js';
import type { WalletBalance } from '../wallet/wallet.service.js';

/** The workspace's **live** plan (PW-T6b; M2-T12b read `workspaces.plan_id`). */
export interface ClientPlan {
  id: string;
  slug: string;
  name: string;
}

/**
 * The account's subscription as the clients list shows it (PW-T6b, same status rule as the
 * client billing summary): live TRIALING / ACTIVE, or the latest one's EXPIRED / CANCELED (a live
 * status past its term reads EXPIRED). `null` = never subscribed or no billing account.
 */
export interface ClientSubscription {
  status: SubscriptionStatus;
  interval: SubscriptionInterval;
  /** Set for a trial (kept after it ended). */
  trialEndsAt: Date | null;
  /** End of the current (or ended) term. */
  termEndsAt: Date;
}

/**
 * Monthly comments of the account's wallet this period (pooled per account, PW-D1/D11): `limit` =
 * included + added, `resetsAt` = the stored reset (trial: its end). No live plan →
 * `{ used: 0, limit: 0, resetsAt: null }`.
 */
export interface ClientComments {
  used: number;
  limit: number;
  resetsAt: Date | null;
}

/** The billing fields of one clients-list item. */
export interface ClientBilling {
  plan: ClientPlan | null;
  subscription: ClientSubscription | null;
  /** `null` when the wallet read failed (the list still answers). */
  comments: ClientComments | null;
}

export interface ClientBillingInput {
  live: Pick<LiveSubscription, 'status'> | null;
  /** The live subscription, else the account's latest one; `null` = none / no account. */
  subscription: AccountSummarySubscription | null;
  /** `undefined` = the wallet read failed; `null` = no live plan. */
  balance:
    | Pick<WalletBalance, 'included' | 'added' | 'used' | 'resetsAt'>
    | null
    | undefined;
}

/** Pure mapping of a client's plan, subscription and comment usage (PW-T6b, plan §3.7). */
export function toClientBilling(input: ClientBillingInput): ClientBilling {
  const { live, subscription, balance } = input;
  const status = summaryStatus(live, subscription);
  const sub =
    status === 'NONE' || !subscription
      ? null
      : {
          status,
          interval: subscription.interval,
          trialEndsAt: subscription.trialEndsAt,
          termEndsAt: subscription.currentTermEnd,
        };
  let comments: ClientComments | null = null;
  if (balance !== undefined) {
    comments =
      live && balance
        ? {
            used: balance.used,
            limit: balance.included + balance.added,
            resetsAt: balance.resetsAt,
          }
        : { used: 0, limit: 0, resetsAt: null };
  }
  return {
    plan: live && subscription ? { ...subscription.plan } : null,
    subscription: sub,
    comments,
  };
}
