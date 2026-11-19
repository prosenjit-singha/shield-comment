import { relations, sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import {
  type SubscriptionInterval,
  type SubscriptionStatus,
  billingAccounts,
  SUBSCRIPTION_INTERVALS,
  SUBSCRIPTION_STATUSES,
  subscriptions,
} from './billing.js';
import { allOrNoneSql, inListSql, lengthSql } from './check-sql.js';
import { id, timestamptz } from './columns.js';
import { plans } from './plans.js';
import { workspaces } from './workspaces.js';

/** Max length of the reason a super admin gives for a manual plan activation (PW-T9). */
export const SUBSCRIPTION_AUDIT_REASON_MAX = 500;
/** Longest user agent kept (longer ones are truncated before the insert, like `plan_audit_logs`). */
export const SUBSCRIPTION_AUDIT_USER_AGENT_MAX = 512;

/** A promotion on a manual activation's bill (PR-D12; PR-T3b). */
export interface AppliedPromotion {
  promotionId: string;
  redemptionId: string;
  name: string;
  /** COUPON only. */
  code: string | null;
  /** "৳500 off" / "10% off for 3 months" (+ Bangla). */
  label: string;
  labelBn: string;
  /** Whole ৳ it takes off this term's bill. */
  amountBdt: number;
  /** "k of N" months this term covers (N-month PER_MONTH discounts only). */
  months: { from: number; to: number; of: number } | null;
}

/** The price of a manual activation's term (PR-T3b): list, charged, and what came off. */
export interface ActivationPrice {
  listChargedBdt: number;
  chargedBdt: number;
  perMonthBdt: number;
  /** The automatic discount (claimed or newly claimed, PR-D6 / reading 9). */
  discount: AppliedPromotion | null;
  /** The admin's coupon, on top (PR-D16). */
  coupon: AppliedPromotion | null;
}

/**
 * One row per manual plan activation by a super admin (`POST
 * /api/admin/clients/:workspaceId/subscription`, PW-T9; user decision 2026-11-19 PW-D16). Written
 * in the same transaction as the subscription change, after the billing account's `FOR UPDATE`
 * lock. `before_*` = the account's live subscription that was ended (all null when it had none);
 * `after_*` = the new `ACTIVE` one. Rows are never updated (no `updatedAt`). FKs are `restrict`
 * like the other audit tables: audit rows must outlive deletes (e2e `cleanup()` /
 * `deleteBillingChildren` delete them before subscriptions).
 */
export const subscriptionAuditLogs = pgTable(
  'subscription_audit_logs',
  {
    id: id(),
    /** Super admin who activated the plan. */
    adminId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    billingAccountId: uuid()
      .notNull()
      .references(() => billingAccounts.id, { onDelete: 'restrict' }),
    /** The workspace the admin acted from (the plan belongs to its billing account). */
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    beforeSubscriptionId: uuid().references(() => subscriptions.id, {
      onDelete: 'restrict',
    }),
    beforePlanId: uuid().references(() => plans.id, { onDelete: 'restrict' }),
    beforeInterval: text().$type<SubscriptionInterval>(),
    /** The ended subscription's status **before** it was ended (`TRIALING` / `ACTIVE`). */
    beforeStatus: text().$type<SubscriptionStatus>(),
    afterSubscriptionId: uuid()
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'restrict' }),
    afterPlanId: uuid()
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    afterInterval: text().$type<SubscriptionInterval>().notNull(),
    afterStatus: text().$type<SubscriptionStatus>().notNull(),
    /** Required, trimmed, 1–500 characters. */
    reason: text().notNull(),
    /** The term's price and promotions (PR-T3b); `null` on rows written before 0028. */
    price: jsonb().$type<ActivationPrice>(),
    /** Admin's IP (first `X-Forwarded-For` entry, like `plan_audit_logs`). */
    ipAddress: text(),
    userAgent: text(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index('subscription_audit_logs_billing_account_id_created_at_index').on(
      t.billingAccountId,
      t.createdAt.desc(),
    ),
    index().on(t.adminId),
    index().on(t.workspaceId),
    index().on(t.afterSubscriptionId),
    index()
      .on(t.beforeSubscriptionId)
      .where(sql`${t.beforeSubscriptionId} is not null`),
    check(
      'subscription_audit_logs_before_check',
      sql.raw(
        allOrNoneSql([
          'before_subscription_id',
          'before_plan_id',
          'before_interval',
          'before_status',
        ]),
      ),
    ),
    check(
      'subscription_audit_logs_interval_check',
      sql.raw(
        `${inListSql('after_interval', SUBSCRIPTION_INTERVALS)} and (${inListSql('before_interval', SUBSCRIPTION_INTERVALS, true)})`,
      ),
    ),
    check(
      'subscription_audit_logs_status_check',
      sql.raw(
        `${inListSql('after_status', SUBSCRIPTION_STATUSES)} and (${inListSql('before_status', SUBSCRIPTION_STATUSES, true)})`,
      ),
    ),
    check(
      'subscription_audit_logs_price_check',
      sql`price is null or jsonb_typeof(price) = 'object'`,
    ),
    check(
      'subscription_audit_logs_reason_length',
      sql.raw(lengthSql('reason', 1, SUBSCRIPTION_AUDIT_REASON_MAX)),
    ),
    check(
      'subscription_audit_logs_ip_address_length',
      sql.raw(lengthSql('ip_address', 1, 45, true)),
    ),
    check(
      'subscription_audit_logs_user_agent_length',
      sql.raw(
        lengthSql('user_agent', 1, SUBSCRIPTION_AUDIT_USER_AGENT_MAX, true),
      ),
    ),
  ],
);

export const subscriptionAuditLogsRelations = relations(
  subscriptionAuditLogs,
  ({ one }) => ({
    admin: one(users, {
      fields: [subscriptionAuditLogs.adminId],
      references: [users.id],
    }),
    billingAccount: one(billingAccounts, {
      fields: [subscriptionAuditLogs.billingAccountId],
      references: [billingAccounts.id],
    }),
    workspace: one(workspaces, {
      fields: [subscriptionAuditLogs.workspaceId],
      references: [workspaces.id],
    }),
  }),
);
