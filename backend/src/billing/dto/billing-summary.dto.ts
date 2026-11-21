import type {
  SubscriptionInterval,
  SubscriptionStatus,
} from '../../db/schema/index.js';

/**
 * `status` of the client billing summary (PW-T6):
 * - `TRIALING` / `ACTIVE`: a live plan (moderation runs).
 * - `EXPIRED` / `CANCELED`: the account's latest subscription ended and nothing is live: moderation
 *   is paused (PW-D9, "Choose a plan"). A TRIALING/ACTIVE row whose term is over but which the
 *   expiry job hasn't flipped yet reads `EXPIRED`.
 * - `NONE`: no subscription ever, or the workspace has no billing account (also paused).
 */
export type BillingSummaryStatus = SubscriptionStatus | 'NONE';

export interface BillingUsage {
  used: number;
  /** The live plan's limit; 0 without a live plan. */
  limit: number;
}

/**
 * `GET /api/workspaces/:workspaceId/billing/summary` (PW-T6, plan §3.7; any member). Every count
 * is pooled across the workspace's billing account (PW-D11). Drives the client app banner (PW-T8):
 * "Trial ends in N days" (`TRIALING` + `trialEndsAt`) or "Moderation paused: choose a plan"
 * (`EXPIRED` / `CANCELED` / `NONE`).
 */
export interface BillingSummary {
  /** The live plan, else the plan of the ended latest subscription; `null` with `NONE`. */
  plan: { slug: string; name: string } | null;
  interval: SubscriptionInterval | null;
  status: BillingSummaryStatus;
  /** Set for a trial (kept after it ended); `null` for a paid term or `NONE`. */
  trialEndsAt: Date | null;
  /** End of the current (or ended) term; for a trial = `trialEndsAt`. */
  termEndsAt: Date | null;
  /**
   * The account's comment wallet this period: `limit` = included + added. No live plan →
   * `{ used: 0, limit: 0, resetsAt: null }`. `resetsAt` = the stored reset time (trial: its end).
   */
  comments: BillingUsage & { resetsAt: Date | null };
  /** Workspaces linked to the account (this one alone without an account) vs `limits.workspaces`. */
  workspaces: BillingUsage;
  /** Pages switched on across the account's workspaces vs `limits.connectedPages`. */
  pages: BillingUsage;
  /**
   * PR-T3: `POST …/billing/trial` can succeed for this account: it has a billing account, no live
   * plan and never had a trial (no TRIAL redemption, no subscription with `trialEndsAt`: sign-up
   * trials before PR-T3 count). The client shows "Start free N-day trial" on a plan card only when
   * this is `true` **and** that plan's `GET /api/plans` `trial` is not `null`; the button's
   * `planId` is the card's plan id. Same for every member (only the owner may start it).
   */
  trialEligible: boolean;
  /**
   * M8-T6 (D4): the live paid (ACTIVE) term's renewal; `null` for a trial or no live plan.
   * `dueAt` = the term end; `canRenew` = inside the 7-day window and no scheduled change.
   */
  renewal: { dueAt: Date; canRenew: boolean } | null;
  /** M8-T6: the account's newest PENDING payment younger than 60 min (reading 9), or `null`. */
  pendingPayment: { tranId: string; amountBdt: number; createdAt: Date } | null;
  /** M8-D7b: the paid next term on another plan / interval, starting at the term end, or `null`. */
  scheduled: {
    planId: string;
    planName: string;
    interval: SubscriptionInterval;
    startsAt: Date;
  } | null;
}
