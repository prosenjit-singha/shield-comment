import { queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/**
 * Workspace billing summary (PW-T6 backend, plan §3.7):
 * `GET /api/workspaces/:workspaceId/billing/summary` (any member, `private, no-store`) →
 * `BillingSummary`. Mirrors `backend/src/billing/dto/billing-summary.dto.ts` (dates arrive as ISO
 * strings). Every count is pooled across the workspace's billing account. Drives the `_app` plan
 * status banner (PW-T8) and C10 `/billing` (M8-T10, same query).
 */

/**
 * - `TRIALING` / `ACTIVE`: a live plan (moderation runs).
 * - `EXPIRED` / `CANCELED`: the latest subscription ended, nothing is live: moderation paused (PW-D9).
 * - `NONE`: never subscribed, or the workspace has no billing account (also paused).
 */
export type BillingSummaryStatus = 'TRIALING' | 'ACTIVE' | 'EXPIRED' | 'CANCELED' | 'NONE'
export type SubscriptionInterval = 'month' | 'year'

export interface BillingUsage {
  used: number
  /** The live plan's limit; 0 without a live plan. */
  limit: number
}

export interface BillingSummary {
  /** The live plan, else the ended latest subscription's plan; `null` with `NONE`. */
  plan: { slug: string; name: string } | null
  interval: SubscriptionInterval | null
  status: BillingSummaryStatus
  /** Set for a trial (kept after it ended); `null` for a paid term or `NONE`. */
  trialEndsAt: string | null
  /** End of the current (or ended) term; for a trial = `trialEndsAt`. */
  termEndsAt: string | null
  /** This period's comment wallet; no live plan → `{ used: 0, limit: 0, resetsAt: null }`. */
  comments: BillingUsage & { resetsAt: string | null }
  workspaces: BillingUsage
  pages: BillingUsage
  /** PR-T3: `POST …/billing/trial` can succeed (billing account, no live plan, never had a trial). */
  trialEligible: boolean
  /** M8-T6 (D4): the live paid term's renewal (`dueAt` = term end; `canRenew` = 7-day window, nothing scheduled); `null` otherwise. */
  renewal: { dueAt: string; canRenew: boolean } | null
  /** M8-T6: the newest PENDING payment younger than 60 min. */
  pendingPayment: { tranId: string; amountBdt: number; createdAt: string } | null
  /** M8-D7b: the paid next term on another plan / interval, from the current term end. */
  scheduled: { planId: string; planName: string; interval: SubscriptionInterval; startsAt: string } | null
  /** M8-T6b / M8-D15: tokenized auto-renew; the toggle shows only when `available`. */
  autoRenew: AutoRenewView
}

/** `PUT` / `DELETE …/billing/auto-renew` answer (= summary `autoRenew`). */
export interface AutoRenewView {
  available: boolean
  enabled: boolean
  /** A card / wallet token from a validated payment is saved. */
  tokenSaved: boolean
}

const summaryPath = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/billing/summary`

export const billingSummaryQueryKey = (workspaceId: string) => ['workspace', workspaceId, 'billing', 'summary'] as const

export function billingSummaryQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: billingSummaryQueryKey(workspaceId),
    queryFn: () => apiFetch<BillingSummary>(summaryPath(workspaceId)),
  })
}

/** What the `_app` banner shows; `null` = no banner (a paid plan with comments left). */
export type PlanBannerState =
  /** `daysLeft` ≥ 1; `endsToday` = the trial's last Bangladesh day is today ("Trial ends today"). */
  | { kind: 'trial'; daysLeft: number; endsToday: boolean }
  /** PW-D9: no live plan → moderation paused until a plan is chosen. */
  | { kind: 'paused' }
  /** A live plan whose comment wallet is used up (`SKIPPED comment_limit_reached` until `resetsAt`). */
  | { kind: 'limit_reached'; trial: boolean; resetsAt: string | null }

/** Bangladesh has been UTC+6 all year since 2009 (no DST). */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const dhakaDayNumber = (time: number) => Math.floor((time + DHAKA_OFFSET_MS) / DAY_MS)

/**
 * Whole Bangladesh calendar days from `now` to `endIso` (the day the trial ends, as the admin's
 * "Trial ends 26 Nov" shows it): a trial ending later today = 0, tomorrow = 1. `null` = bad date.
 */
export function dhakaDaysUntil(endIso: string, now: number): number | null {
  const end = Date.parse(endIso)
  if (Number.isNaN(end)) return null
  return dhakaDayNumber(end) - dhakaDayNumber(now)
}

/**
 * The banner for a summary at `now` (PW-T8, plan §3.7, PW-D9):
 * - comments used up on a live plan (`used >= limit > 0`) → `limit_reached` (moderation already stops);
 * - `TRIALING` → `trial` with the Bangladesh days left, never below 1 (`endsToday` on the last day);
 *   no readable end date → `null`;
 * - `ACTIVE` → `null`;
 * - `EXPIRED` / `CANCELED` / `NONE` → `paused`.
 */
export function planBanner(summary: BillingSummary, now: number = Date.now()): PlanBannerState | null {
  const live = summary.status === 'TRIALING' || summary.status === 'ACTIVE'
  if (!live) return { kind: 'paused' }
  const { used, limit, resetsAt } = summary.comments
  if (limit > 0 && used >= limit) return { kind: 'limit_reached', trial: summary.status === 'TRIALING', resetsAt }
  if (summary.status === 'ACTIVE') return null
  const end = summary.trialEndsAt ?? summary.termEndsAt
  const days = end ? dhakaDaysUntil(end, now) : null
  if (days === null) return null
  return { kind: 'trial', daysLeft: Math.max(1, days), endsToday: days < 1 }
}
