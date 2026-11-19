import { LIVE_SUBSCRIPTION_STATUSES } from '../db/schema/index.js';
import type { LiveSubscription } from '../wallet/live-subscription.queries.js';
import type { WalletBalance } from '../wallet/wallet.service.js';
import type { SummarySubscription } from './billing-summary.queries.js';
import type {
  BillingSummary,
  BillingSummaryStatus,
} from './dto/billing-summary.dto.js';

/** What `toBillingSummary` maps (read by `BillingSummaryService`). */
export interface BillingSummaryInput {
  /** The workspace's live plan at `now`, or `null` (PW-D9: moderation paused). */
  live: Pick<LiveSubscription, 'status' | 'plan'> | null;
  /** The live subscription, else the account's latest one; `null` = none / no account. */
  subscription: SummarySubscription | null;
  /** `WalletService.balance(ws, 'monthlyComments')`; `null` without a live plan. */
  balance: Pick<
    WalletBalance,
    'included' | 'added' | 'used' | 'resetsAt'
  > | null;
  /** Workspaces linked to the account (1 = this one when it has no account). */
  workspaceCount: number;
  /** Pages on across the account (`countPooledActivePages`). */
  activePages: number;
  /** The account may start a trial (`BillingSummary.trialEligible`). */
  trialEligible: boolean;
}

const isLiveStatus = (status: string): boolean =>
  (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);

/**
 * The summary status rule (PW-T6; reused by the admin clients list, PW-T6b): the live status;
 * without a live plan the described subscription's ended status (a live status whose term is
 * over reads `EXPIRED`), or `NONE` when there is no subscription.
 */
export function summaryStatus(
  live: Pick<LiveSubscription, 'status'> | null,
  subscription: Pick<SummarySubscription, 'status'> | null,
): BillingSummaryStatus {
  if (live) return live.status;
  if (!subscription) return 'NONE';
  return isLiveStatus(subscription.status) ? 'EXPIRED' : subscription.status;
}

/**
 * Pure response mapping of the client billing summary (PW-T6, plan §3.7). Status: the live one;
 * without a live plan the latest subscription's ended status (a live status whose term is over
 * reads `EXPIRED`), or `NONE`. Limits come from the live plan only (0 without one).
 */
export function toBillingSummary(input: BillingSummaryInput): BillingSummary {
  const { live, subscription, balance } = input;
  const status = summaryStatus(live, subscription);
  const comments =
    live && balance
      ? {
          used: balance.used,
          limit: balance.included + balance.added,
          resetsAt: balance.resetsAt,
        }
      : { used: 0, limit: 0, resetsAt: null };
  return {
    plan: subscription ? { ...subscription.plan } : null,
    interval: subscription?.interval ?? null,
    status,
    trialEndsAt: subscription?.trialEndsAt ?? null,
    termEndsAt: subscription?.currentTermEnd ?? null,
    comments,
    workspaces: {
      used: input.workspaceCount,
      limit: live?.plan.featureConfig.limits.workspaces ?? 0,
    },
    // Same rule as `connectedPagesLimit` (social-pages.service.ts; not imported here so billing
    // doesn't load the Meta service graph).
    pages: {
      used: input.activePages,
      limit: live?.plan.featureConfig.limits.connectedPages ?? 0,
    },
    trialEligible: input.trialEligible,
  };
}
