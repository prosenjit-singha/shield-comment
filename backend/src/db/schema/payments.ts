import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import {
  billingAccounts,
  type SubscriptionInterval,
  SUBSCRIPTION_INTERVALS,
  subscriptions,
} from './billing.js';
import {
  allOrNoneSql,
  inListSql,
  lengthSql,
  nonNegativeSql,
  patternSql,
} from './check-sql.js';
import { id, timestamps, timestamptz } from './columns.js';
import { plans } from './plans.js';
import type {
  ActivationPrice,
  AppliedPromotion,
} from './subscription-audit.js';
import { workspaces } from './workspaces.js';

/**
 * SSLCommerz payments (M8-T2; Module 8 readings 2/3/8/9, user decisions 2026-11-21 D8/D10, see
 * docs/progress/TASKS.md section "Module 8").
 *
 * - `payment_transactions`: one row per checkout attempt of a billing account. A PAID row **is the
 *   invoice** (D8: `invoice_number` `SC-YYYY-NNNNN`, VAT-inclusive). REFUNDED rows were PAID first
 *   (D9) and keep their payment facts. ৳0 checkouts (promotions / upgrade credit) never reach
 *   SSLCommerz: `gateway = PROMOTION`, no `val_id` (reading 8).
 * - `payment_events`: a small log of every SSLCommerz callback (IPN / success / fail / cancel) with
 *   our outcome code, for A4's failed-IPN list. No FK on `tran_id`: unknown ones are logged too
 *   (reading 3). Never card data or the raw body.
 * - FKs `restrict` (convention; the initiating user is `set null`, like the wallet ledger): e2e
 *   `cleanup()` / `deleteBillingChildren` delete these rows before subscriptions and accounts.
 */

export const PAYMENT_KINDS = ['NEW', 'RENEWAL', 'UPGRADE'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** Same values as the M2-T9 `AdminTransaction.status` (`TRANSACTION_STATUSES`). */
export const PAYMENT_STATUSES = [
  'PENDING',
  'PAID',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Statuses that hold a settled payment (and so an invoice): PAID, or PAID then refunded (D9). */
export const SETTLED_PAYMENT_STATUSES = [
  'PAID',
  'REFUNDED',
] as const satisfies readonly PaymentStatus[];

/** `SSLCOMMERZ` = hosted checkout; `PROMOTION` = ৳0 after promotions, activated without it. */
export const PAYMENT_GATEWAYS = ['SSLCOMMERZ', 'PROMOTION'] as const;
export type PaymentGateway = (typeof PAYMENT_GATEWAYS)[number];

export const PAYMENT_EVENT_SOURCES = [
  'IPN',
  'SUCCESS',
  'FAIL',
  'CANCEL',
] as const;
export type PaymentEventSource = (typeof PAYMENT_EVENT_SOURCES)[number];

/** Our `tran_id`: SSLCommerz allows up to 30 characters. */
export const TRAN_ID_PATTERN = '^[A-Za-z0-9_-]{8,30}$';
/** D8: `SC-<Dhaka year of paid_at>-<sequence, zero-padded to 5+ digits>`. */
export const INVOICE_NUMBER_PATTERN = '^SC-[0-9]{4}-[0-9]{5,}$';
/** Event outcome: a machine code such as `PAID`, `ALREADY_PAID`, `AMOUNT_MISMATCH`. */
export const PAYMENT_EVENT_OUTCOME_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$';

/**
 * Invoice numbers (D8). One global sequence, not one per year: `nextval` never blocks or
 * deadlocks concurrent IPNs and needs no counter table; the year in the number is only a label.
 * A rolled-back transaction leaves a gap (allowed: no VAT/BIN rules apply, D8).
 * Use: `'SC-' || to_char(paid_at at time zone 'Asia/Dhaka', 'YYYY') || '-' ||
 * lpad(n::text, greatest(5, length(n::text)), '0')` with `n = nextval('payment_invoice_number_seq')`.
 */
export const paymentInvoiceNumberSeq = pgSequence('payment_invoice_number_seq');

/** A promotion on a checkout's bill; the claim (`redemptionId`) is made only when it is paid (reading 6). */
export type PaymentPromotion = Omit<AppliedPromotion, 'redemptionId'> & {
  redemptionId: string | null;
};

/** Price snapshot taken at checkout (reading 6; PR-D12 "k of N" in the promotions' `months`). */
export interface PaymentPrice extends Omit<
  ActivationPrice,
  'discount' | 'coupon'
> {
  discount: PaymentPromotion | null;
  coupon: PaymentPromotion | null;
  /** D7: the unused part of the current paid term taken off an UPGRADE; 0 otherwise. */
  creditBdt: number;
}

export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: id(),
    billingAccountId: uuid()
      .notNull()
      .references(() => billingAccounts.id, { onDelete: 'restrict' }),
    /** The workspace the checkout started from (A4 shows its name). */
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** The user who started it; `null` once that user is deleted. */
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    planId: uuid()
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    /** SQL name `interval` (a keyword: quoted in the check SQL). */
    interval: text().$type<SubscriptionInterval>().notNull(),
    kind: text().$type<PaymentKind>().notNull(),
    tranId: text().notNull().unique(),
    /** Whole ৳ charged (`price.chargedBdt − price.creditBdt`). */
    amountBdt: integer().notNull(),
    status: text().$type<PaymentStatus>().notNull().default('PENDING'),
    gateway: text().$type<PaymentGateway>().notNull(),
    /** From the Order Validation API (SSLCommerz rows). */
    valId: text(),
    bankTranId: text(),
    /** SSLCommerz `card_type`, e.g. `BKASH-BKash` (→ A4 label, `gatewayLabel()`). */
    cardType: text(),
    /** SSLCommerz `risk_level` (D10: 1 = activated but flagged on A4). */
    riskLevel: integer(),
    paidAt: timestamptz(),
    /** The term the payment activated or extended (set when PAID). */
    subscriptionId: uuid().references(() => subscriptions.id, {
      onDelete: 'restrict',
    }),
    price: jsonb().$type<PaymentPrice>().notNull(),
    /**
     * The term this payment bought `[start, end)` (M8-T7 invoice), set when PAID. A snapshot:
     * renewals move the linked subscription's term, so the row can't be read back from it.
     */
    termStart: timestamptz(),
    termEnd: timestamptz(),
    /** D8, set only when PAID (kept when REFUNDED). */
    invoiceNumber: text().unique(),
    ...timestamps,
  },
  (t) => [
    index('payment_transactions_billing_account_id_created_at_index').on(
      t.billingAccountId,
      t.createdAt.desc(),
    ),
    index().on(t.status, t.createdAt),
    // A4 list, newest first.
    index('payment_transactions_created_at_index').on(t.createdAt.desc()),
    index().on(t.workspaceId),
    index().on(t.planId),
    index()
      .on(t.userId)
      .where(sql`${t.userId} is not null`),
    index()
      .on(t.subscriptionId)
      .where(sql`${t.subscriptionId} is not null`),
    check(
      'payment_transactions_interval_check',
      sql.raw(inListSql('"interval"', SUBSCRIPTION_INTERVALS)),
    ),
    check(
      'payment_transactions_kind_check',
      sql.raw(inListSql('kind', PAYMENT_KINDS)),
    ),
    check(
      'payment_transactions_status_check',
      sql.raw(inListSql('status', PAYMENT_STATUSES)),
    ),
    check(
      'payment_transactions_gateway_check',
      sql.raw(inListSql('gateway', PAYMENT_GATEWAYS)),
    ),
    check(
      'payment_transactions_tran_id_check',
      sql.raw(patternSql('tran_id', TRAN_ID_PATTERN)),
    ),
    check(
      'payment_transactions_invoice_number_check',
      sql.raw(patternSql('invoice_number', INVOICE_NUMBER_PATTERN, true)),
    ),
    check(
      'payment_transactions_amounts_check',
      sql.raw(
        `${nonNegativeSql(['amount_bdt'])} and (risk_level is null or ${nonNegativeSql(['risk_level'])})`,
      ),
    ),
    check(
      'payment_transactions_promotion_check',
      sql`gateway <> 'PROMOTION' or (amount_bdt = 0 and val_id is null)`,
    ),
    check(
      'payment_transactions_price_check',
      sql`jsonb_typeof(price) = 'object'`,
    ),
    // Settled (PAID / REFUNDED) ⇔ paid_at + invoice number + subscription + term, all or none
    // (+ val_id unless PROMOTION).
    check(
      'payment_transactions_settled_check',
      sql.raw(
        `((${inListSql('status', SETTLED_PAYMENT_STATUSES)}) = (paid_at is not null)) and (${allOrNoneSql(['paid_at', 'invoice_number', 'subscription_id', 'term_start', 'term_end'])}) and (paid_at is null or gateway = 'PROMOTION' or val_id is not null) and (term_end is null or term_end > term_start)`,
      ),
    ),
  ],
);

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: id(),
    /** As received (≤ 64 chars); `null` when the callback had none. May match no transaction. */
    tranId: text(),
    source: text().$type<PaymentEventSource>().notNull(),
    outcome: text().notNull(),
    receivedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index().on(t.tranId),
    // A4: recent callbacks per source (failed IPNs = source IPN, outcome not PAID).
    index().on(t.source, t.receivedAt.desc()),
    check(
      'payment_events_source_check',
      sql.raw(inListSql('source', PAYMENT_EVENT_SOURCES)),
    ),
    check(
      'payment_events_outcome_check',
      sql.raw(patternSql('outcome', PAYMENT_EVENT_OUTCOME_PATTERN)),
    ),
    check(
      'payment_events_tran_id_check',
      sql.raw(lengthSql('tran_id', 1, 64, true)),
    ),
  ],
);

export const paymentTransactionsRelations = relations(
  paymentTransactions,
  ({ one }) => ({
    billingAccount: one(billingAccounts, {
      fields: [paymentTransactions.billingAccountId],
      references: [billingAccounts.id],
    }),
    workspace: one(workspaces, {
      fields: [paymentTransactions.workspaceId],
      references: [workspaces.id],
    }),
    plan: one(plans, {
      fields: [paymentTransactions.planId],
      references: [plans.id],
    }),
    subscription: one(subscriptions, {
      fields: [paymentTransactions.subscriptionId],
      references: [subscriptions.id],
    }),
  }),
);
