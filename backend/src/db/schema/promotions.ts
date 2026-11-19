import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { billingAccounts, subscriptions } from './billing.js';
import { allOrNoneSql, inListSql, lengthSql, patternSql } from './check-sql.js';
import { id, timestamps, timestamptz } from './columns.js';
import {
  PLAN_PRICE_MAX_BDT,
  PLAN_TRIAL_COMMENT_LIMIT_MAX,
  PLAN_TRIAL_DAYS_MAX,
  PLAN_TRIAL_DAYS_MIN,
  plans,
} from './plans.js';

/**
 * Promotions (PR-T1; user decisions 2026-11-20 PR-D1…D5, D12, see docs/progress/TASKS.md section
 * "Promotions (PR)" and docs/plans/2026-11-20-promotions.md §5.2). Schema only: the rules (live,
 * redeem, prices) come with `PromotionService` (PR-T2).
 *
 * - `promotions`: one offer of kind TRIAL / DISCOUNT / COUPON. Per-kind check constraints let each
 *   kind fill only its own columns. Targets: `all_plans`, else `promotion_plans` rows (an
 *   `all_plans` promotion has no rows: enforced by the service, PR-T4). Live = not stopped,
 *   `ends_at` null or future, cap (`max_redemptions`) not reached.
 * - `promotion_redemptions`: a claim, **once per client (billing) account per promotion** (PR-D3,
 *   unique) and **one trial per account ever** (reading 1, partial unique on the kind snapshot).
 *   It snapshots the money terms (reading 8 locks them after the first claim) and counts
 *   `months_used` across terms (reading 9). Subscriptions point back to it.
 * - FKs `restrict` (convention). Migration 0027 seeds a "Launch offer" DISCOUNT per plan with an
 *   offer and the "Starter N-day trial" (`created_by` null): part of every DB's baseline, the
 *   e2e `cleanup()` keeps them.
 */

export const PROMOTION_KINDS = ['TRIAL', 'DISCOUNT', 'COUPON'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

/** FLAT = ৳ off; PERCENT = % off (PR-D4). */
export const DISCOUNT_TYPES = ['FLAT', 'PERCENT'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

/** TOTAL = off the bill (first bill only); PER_MONTH = off each month's price (PR-D4). */
export const DISCOUNT_SCOPES = ['TOTAL', 'PER_MONTH'] as const;
export type DiscountScope = (typeof DISCOUNT_SCOPES)[number];

export const PROMOTION_NAME_MAX = 60;
/** Coupon codes: stored uppercase, 3–32 chars of `A-Z 0-9 -`. */
export const COUPON_CODE_PATTERN = '^[A-Z0-9-]{3,32}$';
export const DISCOUNT_PERCENT_MAX = 100;

/**
 * Per-kind column rules, shared by `promotions` and the redemption snapshot. TRIAL fills
 * `trial_days` (+ optional `trial_comment_limit`, null = the plan's monthly comments) and no
 * discount column; DISCOUNT/COUPON fill type + value + scope (+ optional `duration_months`, null =
 * forever) and no trial column. Value: FLAT 1 … price max, PERCENT 1–100.
 */
function termChecks(table: string) {
  return [
    check(`${table}_kind_check`, sql.raw(inListSql('kind', PROMOTION_KINDS))),
    check(
      `${table}_trial_fields_check`,
      sql.raw(
        `(kind = 'TRIAL') = (trial_days is not null) and (kind = 'TRIAL' or trial_comment_limit is null)`,
      ),
    ),
    check(
      `${table}_discount_fields_check`,
      sql.raw(
        `(kind <> 'TRIAL') = (discount_type is not null) and (${allOrNoneSql(['discount_type', 'discount_value', 'discount_scope'])}) and (discount_type is not null or duration_months is null)`,
      ),
    ),
    check(
      `${table}_trial_days_check`,
      sql.raw(
        `trial_days is null or trial_days between ${PLAN_TRIAL_DAYS_MIN} and ${PLAN_TRIAL_DAYS_MAX}`,
      ),
    ),
    check(
      `${table}_trial_comment_limit_check`,
      sql.raw(
        `trial_comment_limit is null or trial_comment_limit between 0 and ${PLAN_TRIAL_COMMENT_LIMIT_MAX}`,
      ),
    ),
    check(
      `${table}_discount_type_check`,
      sql.raw(inListSql('discount_type', DISCOUNT_TYPES, true)),
    ),
    check(
      `${table}_discount_scope_check`,
      sql.raw(inListSql('discount_scope', DISCOUNT_SCOPES, true)),
    ),
    check(
      `${table}_discount_value_check`,
      sql.raw(
        `discount_value is null or (discount_type = 'FLAT' and discount_value between 1 and ${PLAN_PRICE_MAX_BDT}) or (discount_type = 'PERCENT' and discount_value between 1 and ${DISCOUNT_PERCENT_MAX})`,
      ),
    ),
    check(
      `${table}_duration_months_check`,
      sql`duration_months is null or duration_months >= 1`,
    ),
  ];
}

/** The term columns (on the promotion and snapshotted on each redemption). */
const termColumns = () => ({
  kind: text().$type<PromotionKind>().notNull(),
  /** TRIAL only: 1–90 days (admin presets 3 / 7 / 14 / 30). */
  trialDays: integer(),
  /** TRIAL only: comment grant of the trial; `null` = the plan's monthly comments. */
  trialCommentLimit: integer(),
  /** DISCOUNT / COUPON only. */
  discountType: text().$type<DiscountType>(),
  /** FLAT: whole ৳ off (≥ 1); PERCENT: 1–100. */
  discountValue: integer(),
  discountScope: text().$type<DiscountScope>(),
  /** Months the discount runs; `null` = forever (ignored for TOTAL). */
  durationMonths: integer(),
});

export const promotions = pgTable(
  'promotions',
  {
    id: id(),
    /** Shown to the admin and on bills (PR-D12). */
    name: text().notNull(),
    /** COUPON only (required there): typed at checkout, never shown on cards (PR-D11). */
    code: text().unique(),
    /** Targets every plan; when false the targets are `promotion_plans` rows. */
    allPlans: boolean().notNull().default(false),
    /** End of validity (end of a Dhaka day, set by the API); `null` = until stopped. */
    endsAt: timestamptz(),
    /** "First N clients" cap; `null` = no cap. */
    maxRedemptions: integer(),
    /** Admin Stop (PR-D2): blocks new claims only (PR-D15). Set together with `stopped_by`. */
    stoppedAt: timestamptz(),
    stoppedBy: uuid().references(() => users.id, { onDelete: 'restrict' }),
    ...termColumns(),
    /** Super admin who created it; `null` = seeded by a migration (0027). */
    createdBy: uuid().references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index().on(t.createdBy),
    index().on(t.stoppedBy),
    check(
      'promotions_name_length',
      sql.raw(lengthSql('name', 1, PROMOTION_NAME_MAX)),
    ),
    check(
      'promotions_code_check',
      sql.raw(
        `(kind = 'COUPON') = (code is not null) and (${patternSql('code', COUPON_CODE_PATTERN, true)})`,
      ),
    ),
    check(
      'promotions_max_redemptions_check',
      sql`max_redemptions is null or max_redemptions >= 1`,
    ),
    check(
      'promotions_stopped_check',
      sql.raw(allOrNoneSql(['stopped_at', 'stopped_by'])),
    ),
    ...termChecks('promotions'),
  ],
);

/** Target plans of a promotion that is not `all_plans`. */
export const promotionPlans = pgTable(
  'promotion_plans',
  {
    promotionId: uuid()
      .notNull()
      .references(() => promotions.id, { onDelete: 'restrict' }),
    planId: uuid()
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.promotionId, t.planId] }),
    index().on(t.planId),
  ],
);

export const promotionRedemptions = pgTable(
  'promotion_redemptions',
  {
    id: id(),
    promotionId: uuid()
      .notNull()
      .references(() => promotions.id, { onDelete: 'restrict' }),
    billingAccountId: uuid()
      .notNull()
      .references(() => billingAccounts.id, { onDelete: 'restrict' }),
    /** The subscription the claim was made with; `null` until one exists. */
    subscriptionId: uuid().references(() => subscriptions.id, {
      onDelete: 'restrict',
    }),
    redeemedAt: timestamptz().notNull().defaultNow(),
    /** Snapshot of the promotion's terms at the claim (reading 8). */
    ...termColumns(),
    /** Months of the discount already used, across terms (reading 9). */
    monthsUsed: integer().notNull().default(0),
    /** Saving on the first term in whole ৳ (PR-D12); 0 for a trial. */
    discountBdtFirstTerm: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    unique('promotion_redemptions_promotion_account_unique').on(
      t.promotionId,
      t.billingAccountId,
    ),
    uniqueIndex('promotion_redemptions_one_trial_per_account')
      .on(t.billingAccountId)
      .where(sql`kind = 'TRIAL'`),
    index().on(t.billingAccountId),
    index().on(t.subscriptionId),
    check(
      'promotion_redemptions_counters_check',
      sql`months_used >= 0 and discount_bdt_first_term >= 0`,
    ),
    ...termChecks('promotion_redemptions'),
  ],
);

export const promotionsRelations = relations(promotions, ({ one, many }) => ({
  targets: many(promotionPlans),
  redemptions: many(promotionRedemptions),
  creator: one(users, {
    fields: [promotions.createdBy],
    references: [users.id],
    relationName: 'promotion_creator',
  }),
  stopper: one(users, {
    fields: [promotions.stoppedBy],
    references: [users.id],
    relationName: 'promotion_stopper',
  }),
}));

export const promotionPlansRelations = relations(promotionPlans, ({ one }) => ({
  promotion: one(promotions, {
    fields: [promotionPlans.promotionId],
    references: [promotions.id],
  }),
  plan: one(plans, {
    fields: [promotionPlans.planId],
    references: [plans.id],
  }),
}));

export const promotionRedemptionsRelations = relations(
  promotionRedemptions,
  ({ one }) => ({
    promotion: one(promotions, {
      fields: [promotionRedemptions.promotionId],
      references: [promotions.id],
    }),
    billingAccount: one(billingAccounts, {
      fields: [promotionRedemptions.billingAccountId],
      references: [billingAccounts.id],
    }),
    subscription: one(subscriptions, {
      fields: [promotionRedemptions.subscriptionId],
      references: [subscriptions.id],
    }),
  }),
);

/** Support WhatsApp number (PR-D18): BD mobile, digits only with the 880 country code (for `wa.me`). */
export const SUPPORT_WHATSAPP_PATTERN = '^8801[3-9][0-9]{8}$';

/**
 * Platform settings shown to clients (PR-T1, PR-D18). At most one row (`id = 1`), created by the
 * first admin save (PR-T4); no row or a `null` number = "Contact us" is hidden. Not tenant data.
 */
export const platformSettings = pgTable(
  'platform_settings',
  {
    id: integer().primaryKey().default(1),
    supportWhatsappNumber: text(),
    /** Super admin who saved last; `set null` so deleting a user never blocks on settings. */
    updatedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    check('platform_settings_singleton', sql`${t.id} = 1`),
    check(
      'platform_settings_support_whatsapp_number_check',
      sql.raw(
        patternSql('support_whatsapp_number', SUPPORT_WHATSAPP_PATTERN, true),
      ),
    ),
  ],
);
