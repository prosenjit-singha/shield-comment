import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { billingAccounts } from './billing.js';
import {
  inListSql,
  lengthSql,
  nonNegativeSql,
  patternSql,
} from './check-sql.js';
import { id, timestamps, timestamptz } from './columns.js';

/**
 * The client wallet (PW-T1; user decisions 2026-11-19 PW-D3/D4/D14, see docs/progress/TASKS.md
 * section PW and docs/plans/2026-11-19-plans-subscriptions-wallet.md §3.4).
 *
 * - `wallets`: one per billing account. `cycle_anchor_at` (trial or term start) sets the monthly
 *   reset day + time (Asia/Dhaka, month-end clamp); `current_period_end` is **the stored reset
 *   time** shown to the client.
 * - `wallet_balances`: one row per wallet × meter × period. `included` is the plan grant taken at
 *   period start (a later plan edit applies from the next reset, PW-D14), `added` is reserved for
 *   future top-ups / extra limit (always 0 now), `used` is raised by one guarded update.
 *   Available = `included + added − used`; `used` is not checked against it in SQL (an adjustment
 *   may lower a grant below what was already used).
 * - `wallet_entries`: append-only ledger of grants and adjustments (not hot-path usage). No
 *   `updated_at`. The acting user is `set null` (a ledger row never blocks deleting a user).
 * - Meters are camelCase keys (`monthlyComments` now; auto-reply, lead capture later): a new meter
 *   needs no schema change. FKs `restrict`: delete entries → balances → wallets → accounts.
 */

/** Meter key format (camelCase, ≤ 64 chars), e.g. `monthlyComments`. */
export const WALLET_METER_PATTERN = '^[a-z][A-Za-z0-9]{0,63}$';

/** Ledger kinds. Only `PLAN_GRANT` is written now; `TOP_UP` is reserved (PW-D3). */
export const WALLET_ENTRY_KINDS = [
  'PLAN_GRANT',
  'ADJUSTMENT',
  'TOP_UP',
  'EXPIRE',
] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

export const WALLET_ENTRY_NOTE_MAX = 500;
export const WALLET_ENTRY_REFERENCE_MAX = 200;

export const wallets = pgTable(
  'wallets',
  {
    id: id(),
    billingAccountId: uuid()
      .notNull()
      .references(() => billingAccounts.id, { onDelete: 'restrict' }),
    /** The instant the current term or trial started: sets the reset day and time. */
    cycleAnchorAt: timestamptz().notNull(),
    currentPeriodStart: timestamptz().notNull(),
    /** The stored reset time (PW-D4). */
    currentPeriodEnd: timestamptz().notNull(),
    ...timestamps,
  },
  (t) => [
    unique('wallets_billing_account_id_unique').on(t.billingAccountId),
    check(
      'wallets_period_check',
      sql`current_period_end > current_period_start`,
    ),
  ],
);

export const walletBalances = pgTable(
  'wallet_balances',
  {
    id: id(),
    walletId: uuid()
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    meter: text().notNull(),
    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),
    /** Granted from the plan (or the trial limit) at period start. */
    included: integer().notNull(),
    /** Future top-ups / extra limit for this period; always 0 now. */
    added: integer().notNull().default(0),
    used: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    // Lookup key (leading `wallet_id` also serves the FK lookups).
    unique('wallet_balances_wallet_meter_period_unique').on(
      t.walletId,
      t.meter,
      t.periodStart,
    ),
    check(
      'wallet_balances_meter_format',
      sql.raw(patternSql('meter', WALLET_METER_PATTERN)),
    ),
    check('wallet_balances_period_check', sql`period_end > period_start`),
    check(
      'wallet_balances_amounts_check',
      sql.raw(nonNegativeSql(['included', 'added', 'used'])),
    ),
  ],
);

export const walletEntries = pgTable(
  'wallet_entries',
  {
    id: id(),
    walletId: uuid()
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    meter: text().notNull(),
    /** The balance period this entry belongs to (`wallet_balances.period_start`). */
    periodStart: timestamptz().notNull(),
    kind: text().$type<WalletEntryKind>().notNull(),
    /** Signed amount: grants and top-ups > / ≥ 0, expiries ≤ 0, adjustments ≠ 0. */
    amount: integer().notNull(),
    /** External reference (subscription id, payment id, …). */
    reference: text(),
    /** The admin who made a manual entry; `null` for system entries or once the user is deleted. */
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    note: text(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    // Ledger per wallet (+ the FK `restrict` lookups).
    index().on(t.walletId, t.createdAt),
    // FK `on delete set null` lookups (deleting a user).
    index('wallet_entries_actor_user_id_index')
      .on(t.actorUserId)
      .where(sql`${t.actorUserId} is not null`),
    check(
      'wallet_entries_meter_format',
      sql.raw(patternSql('meter', WALLET_METER_PATTERN)),
    ),
    check(
      'wallet_entries_kind_check',
      sql.raw(inListSql('kind', WALLET_ENTRY_KINDS)),
    ),
    check(
      'wallet_entries_amount_check',
      sql.raw(
        `(kind <> 'PLAN_GRANT' or amount >= 0) and (kind <> 'TOP_UP' or amount > 0) and (kind <> 'EXPIRE' or amount <= 0) and (kind <> 'ADJUSTMENT' or amount <> 0)`,
      ),
    ),
    check(
      'wallet_entries_reference_length',
      sql.raw(lengthSql('reference', 1, WALLET_ENTRY_REFERENCE_MAX, true)),
    ),
    check(
      'wallet_entries_note_length',
      sql.raw(lengthSql('note', 1, WALLET_ENTRY_NOTE_MAX, true)),
    ),
  ],
);

export const walletsRelations = relations(wallets, ({ one, many }) => ({
  billingAccount: one(billingAccounts, {
    fields: [wallets.billingAccountId],
    references: [billingAccounts.id],
  }),
  balances: many(walletBalances),
  entries: many(walletEntries),
}));

export const walletBalancesRelations = relations(walletBalances, ({ one }) => ({
  wallet: one(wallets, {
    fields: [walletBalances.walletId],
    references: [wallets.id],
  }),
}));

export const walletEntriesRelations = relations(walletEntries, ({ one }) => ({
  wallet: one(wallets, {
    fields: [walletEntries.walletId],
    references: [wallets.id],
  }),
  actor: one(users, {
    fields: [walletEntries.actorUserId],
    references: [users.id],
  }),
}));

/** Reverse side of `wallets.billingAccount` (merged with `billingAccountsRelations` in billing.ts). */
export const billingAccountWalletRelations = relations(
  billingAccounts,
  ({ one }) => ({
    wallet: one(wallets),
  }),
);
