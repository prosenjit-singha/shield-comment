import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { allOrNoneSql, inListSql, nonNegativeSql } from './check-sql.js';
import { id, timestamps, timestamptz } from './columns.js';
import { plans } from './plans.js';
import { promotionRedemptions } from './promotions.js';
import type { ActivationPrice } from './subscription-audit.js';

/**
 * Billing accounts and subscriptions (PW-T1; user decisions 2026-11-19 PW-D3/D5/D8, see
 * docs/progress/TASKS.md section PW and docs/plans/2026-11-19-plans-subscriptions-wallet.md §3.1/§3.3).
 *
 * - `billing_accounts`: the paying "client", one per owner user. Workspaces point at it through
 *   `workspaces.billing_account_id` (nullable: a member-less workspace has no account = no live
 *   plan); its plan limits are pooled across those workspaces (PW-D11). The account ↔ workspaces
 *   relation lives in workspaces.ts and the account ↔ wallet one in wallet.ts (no import cycles).
 * - `subscriptions`: the account's plan history. At most one live (`TRIALING` / `ACTIVE`) row per
 *   account (partial unique index); readers also treat `now ≥ current_term_end` as expired. Prices
 *   are snapshots taken when the term starts (null for a trial, PW-D14).
 * - FKs `restrict` (convention): e2e `cleanup()` deletes subscriptions before accounts, workspaces
 *   before accounts and accounts before users.
 */

/** `month` = billed monthly; `year` = billed yearly at the plan's per-month yearly price × 12 (PW-D5). */
export const SUBSCRIPTION_INTERVALS = ['month', 'year'] as const;
export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number];

/** `TRIALING` / `ACTIVE` are live; `EXPIRED` / `CANCELED` are history (kept forever). */
export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'EXPIRED',
  'CANCELED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** The statuses that may hold the plan (at most one such row per account). */
export const LIVE_SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
] as const satisfies readonly SubscriptionStatus[];

export const billingAccounts = pgTable(
  'billing_accounts',
  {
    id: id(),
    /** The user who owns (and later pays for) the account; one account per user. */
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [unique('billing_accounts_owner_user_id_unique').on(t.ownerUserId)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    billingAccountId: uuid()
      .notNull()
      .references(() => billingAccounts.id, { onDelete: 'restrict' }),
    planId: uuid()
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    /** SQL name `interval` (a keyword: quoted in the check SQL). */
    interval: text().$type<SubscriptionInterval>().notNull(),
    status: text().$type<SubscriptionStatus>().notNull(),
    /** When this subscription began (trial start or first paid term). */
    startedAt: timestamptz().notNull(),
    /** Trial end snapshot (`trial_days` at trial start), never recomputed; kept after expiry. */
    trialEndsAt: timestamptz(),
    /** The current term `[start, end)`; for a trial, the end is `trial_ends_at`. */
    currentTermStart: timestamptz().notNull(),
    currentTermEnd: timestamptz().notNull(),
    /** Per-month price snapshot in whole BDT (`planPrice(plan, interval).perMonthBdt`); null for a trial. */
    pricePerMonthBdt: integer(),
    /** Amount charged per term in whole BDT (yearly = per month × 12); null for a trial. */
    chargedBdt: integer(),
    /** Set exactly when `status = CANCELED`. */
    canceledAt: timestamptz(),
    /** The automatic discount (or trial) this term applies (PR-D12; set from PR-T3/PR-T3b). */
    promotionRedemptionId: uuid().references(
      (): AnyPgColumn => promotionRedemptions.id,
      { onDelete: 'restrict' },
    ),
    /** The coupon on top of it (PR-D16). */
    couponRedemptionId: uuid().references(
      (): AnyPgColumn => promotionRedemptions.id,
      { onDelete: 'restrict' },
    ),
    /**
     * A paid next term on another plan / interval (M8-D7b: a downgrade or year → month paid in the
     * 7-day renewal window). It starts at `current_term_end` (no gap); the M8-T6 renewal job
     * switches to it. Its promotions are already claimed (`scheduled_price` redemption ids).
     */
    scheduledPlanId: uuid().references(() => plans.id, {
      onDelete: 'restrict',
    }),
    scheduledInterval: text().$type<SubscriptionInterval>(),
    scheduledPrice: jsonb().$type<ActivationPrice>(),
    ...timestamps,
  },
  (t) => [
    index().on(t.promotionRedemptionId),
    index()
      .on(t.scheduledPlanId)
      .where(sql`${t.scheduledPlanId} is not null`),
    index().on(t.couponRedemptionId),
    // History per account (+ the FK `restrict` lookups when deleting an account).
    index().on(t.billingAccountId, t.createdAt),
    index().on(t.planId),
    // At most one live subscription per account.
    uniqueIndex('subscriptions_one_live_per_account')
      .on(t.billingAccountId)
      .where(sql.raw(inListSql('status', LIVE_SUBSCRIPTION_STATUSES))),
    // The expiry scheduler: live rows whose term has ended.
    index('subscriptions_live_term_end_index')
      .on(t.currentTermEnd)
      .where(sql.raw(inListSql('status', LIVE_SUBSCRIPTION_STATUSES))),
    check(
      'subscriptions_interval_check',
      sql.raw(inListSql('"interval"', SUBSCRIPTION_INTERVALS)),
    ),
    check(
      'subscriptions_status_check',
      sql.raw(inListSql('status', SUBSCRIPTION_STATUSES)),
    ),
    check(
      'subscriptions_term_check',
      sql`current_term_end > current_term_start`,
    ),
    check(
      'subscriptions_trial_ends_at_check',
      sql`trial_ends_at is null or trial_ends_at > started_at`,
    ),
    check(
      'subscriptions_prices_check',
      sql.raw(
        `(${allOrNoneSql(['price_per_month_bdt', 'charged_bdt'])}) and (price_per_month_bdt is null or ${nonNegativeSql(['price_per_month_bdt', 'charged_bdt'])})`,
      ),
    ),
    check(
      'subscriptions_trialing_check',
      sql`status <> 'TRIALING' or (trial_ends_at is not null and current_term_end = trial_ends_at and price_per_month_bdt is null)`,
    ),
    check(
      'subscriptions_active_check',
      sql`status <> 'ACTIVE' or price_per_month_bdt is not null`,
    ),
    check(
      'subscriptions_scheduled_check',
      sql.raw(
        `(${allOrNoneSql(['scheduled_plan_id', 'scheduled_interval', 'scheduled_price'])}) and (${inListSql('scheduled_interval', SUBSCRIPTION_INTERVALS, true)})`,
      ),
    ),
    check(
      'subscriptions_canceled_at_check',
      sql`(status = 'CANCELED') = (canceled_at is not null)`,
    ),
  ],
);

export const billingAccountsRelations = relations(
  billingAccounts,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [billingAccounts.ownerUserId],
      references: [users.id],
    }),
    subscriptions: many(subscriptions),
  }),
);

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  billingAccount: one(billingAccounts, {
    fields: [subscriptions.billingAccountId],
    references: [billingAccounts.id],
  }),
  plan: one(plans, {
    fields: [subscriptions.planId],
    references: [plans.id],
  }),
}));

/** Reverse side of `subscriptions.plan` (the only `plans` relations since PW-T6b). */
export const planSubscriptionsRelations = relations(plans, ({ many }) => ({
  subscriptions: many(subscriptions),
}));
