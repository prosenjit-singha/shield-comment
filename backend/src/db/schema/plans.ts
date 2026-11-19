import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';

/**
 * Subscription plans (M2-T11, user decision 2026-11-18). Built in Module 2 so the A7 Settings
 * screen can edit prices and limits; Module 8 adds subscriptions/payments on top. A workspace
 * gets its plan from its billing account's live subscription (PW-T3…T6b; `workspaces.plan_id`
 * was dropped by migration 0025); the relations live in billing.ts so this file has no imports
 * from other schema files.
 *
 * The four tiers (free/starter/growth/pro) are seeded by migration `0007_seed_plans` with
 * `ON CONFLICT (slug) DO NOTHING`, so admin edits are never overwritten. `0008_plan_launch_offers`
 * (M2-T15) adds the launch offers (Starter ~~৳999~~ ৳499, Growth ~~৳2,499~~ ৳1,499, Pro ~~৳5,999~~
 * ৳3,999) only to plans still at their seed values. Every admin edit is logged in `plan_audit_logs`.
 */

/** Numeric limits per plan (`feature_config.limits`). Rows 1–3 of the landing pricing matrix + workspaces. */
export const PLAN_LIMIT_KEYS = [
  /** Connected Facebook + Instagram pages. */
  'connectedPages',
  /**
   * Comments per month (PW-D1): each comment counts 1, at any D8 context level. Replaced the
   * M5-T11 AI credits (`monthlyAiCredits`); migration 0022 copied the numbers back.
   */
  'monthlyComments',
  /** Team / moderator seats (workspace members). */
  'teamSeats',
  /** Workspaces a client (billing) account may own (PW-D10; seed 1 / 3 / 10). */
  'workspaces',
] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];

/** Upper bound per limit (validation; 0 = feature unavailable). */
export const PLAN_LIMIT_MAX: Record<PlanLimitKey, number> = {
  connectedPages: 1_000,
  monthlyComments: 10_000_000,
  teamSeats: 1_000,
  workspaces: 1_000,
};

/**
 * Old limit key names, read as a fallback by `normalizeFeatureConfig` when the new key is missing
 * (PW-T1b: `monthlyAiCredits` → `monthlyComments`; M5-T11 had renamed it the other way). Old
 * `plan_audit_logs` rows keep the old dotted field name (`LEGACY_PLAN_AUDIT_FIELDS`).
 */
export const LEGACY_PLAN_LIMIT_KEYS: Readonly<
  Partial<Record<PlanLimitKey, string>>
> = {
  monthlyComments: 'monthlyAiCredits',
};

/** The only plan with a sign-up trial (PW-D8); the trial columns are accepted on it alone. */
export const TRIAL_PLAN_SLUG = 'starter';

/** Boolean feature flags (`feature_config.features`). Rows 4–10 of the landing pricing matrix. */
export const PLAN_FEATURE_KEYS = [
  /** Bangla / Banglish / English AI filter. */
  'banglaAiFilter',
  /** Auto-hide scam and poaching links. */
  'autoHideScams',
  /** Custom keyword + BD phone number blocklist. */
  'customBlocklist',
  /** Brand-voice auto-reply templates. */
  'autoReplyTemplates',
  /** WhatsApp and Telegram alerts. */
  'messengerAlerts',
  /** White-label CSV/PDF agency reports. */
  'whiteLabelReports',
  /** Priority support and API/webhook access. */
  'prioritySupportApi',
] as const;
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number];

/** Typed shape of `plans.feature_config` (jsonb). Every key is always present. */
export interface PlanFeatureConfig {
  limits: Record<PlanLimitKey, number>;
  features: Record<PlanFeatureKey, boolean>;
}

/** Prices are whole taka per month. */
export const PLAN_PRICE_MAX_BDT = 1_000_000;
export const PLAN_OFFER_BADGE_MAX = 40;
export const PLAN_NAME_MAX = 40;

/** Trial length bounds in days (PW-D8; the admin UI offers 3 / 7 / 14 / 30). */
export const PLAN_TRIAL_DAYS_MIN = 1;
export const PLAN_TRIAL_DAYS_MAX = 90;
/** Upper bound of `trial_comment_limit` (PW-D12) = the monthly comment limit max. */
export const PLAN_TRIAL_COMMENT_LIMIT_MAX = PLAN_LIMIT_MAX.monthlyComments;

export const plans = pgTable(
  'plans',
  {
    id: id(),
    /** Stable key used by code (`free`, `starter`, `growth`, `pro`). */
    slug: text().notNull().unique(),
    name: text().notNull().unique(),
    /** Display order (ascending) in the admin editor and the pricing table. */
    sortOrder: integer().notNull().default(0),
    /** Inactive plans stay assigned to existing workspaces but are not offered to new ones. */
    isActive: boolean().notNull().default(true),
    /** Monthly list price in whole BDT (৳). */
    originalPriceBdt: integer().notNull(),
    /** Promo price in whole BDT, ≤ original; `null` = no offer (customers pay the original). */
    offerPriceBdt: integer(),
    /** Short promo label shown on the pricing card, e.g. "50% Launch Offer". */
    offerBadge: text(),
    /**
     * Per-month price in whole BDT when billed yearly (PW-D5; charged × 12), ≤ the monthly price
     * (`offer_price_bdt ?? original_price_bdt`). `null` = no yearly option.
     */
    yearlyMonthlyPriceBdt: integer(),
    /** Trial length in days (PW-D8; Starter only, enforced by the API; seed 7). `null` = no trial. */
    trialDays: integer(),
    /**
     * Comment grant of a trial (PW-D12; Starter only, beside `trial_days`; seed 300). `null` = the
     * plan's monthly comment limit.
     */
    trialCommentLimit: integer(),
    featureConfig: jsonb().$type<PlanFeatureConfig>().notNull(),
    ...timestamps,
  },
  () => [
    check('plans_slug_format', sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check(
      'plans_name_length',
      sql.raw(`char_length(name) between 1 and ${PLAN_NAME_MAX}`),
    ),
    check('plans_original_price_check', sql`original_price_bdt >= 0`),
    check(
      'plans_offer_price_check',
      sql`offer_price_bdt is null or (offer_price_bdt >= 0 and offer_price_bdt <= original_price_bdt)`,
    ),
    check(
      'plans_offer_badge_length',
      sql.raw(
        `offer_badge is null or char_length(offer_badge) between 1 and ${PLAN_OFFER_BADGE_MAX}`,
      ),
    ),
    check(
      'plans_yearly_monthly_price_check',
      sql`yearly_monthly_price_bdt is null or (yearly_monthly_price_bdt >= 0 and yearly_monthly_price_bdt <= coalesce(offer_price_bdt, original_price_bdt))`,
    ),
    check(
      'plans_trial_days_check',
      sql.raw(
        `trial_days is null or trial_days between ${PLAN_TRIAL_DAYS_MIN} and ${PLAN_TRIAL_DAYS_MAX}`,
      ),
    ),
    check(
      'plans_trial_comment_limit_check',
      sql.raw(
        `trial_comment_limit is null or trial_comment_limit between 0 and ${PLAN_TRIAL_COMMENT_LIMIT_MAX}`,
      ),
    ),
    check(
      'plans_feature_config_object',
      sql`jsonb_typeof(feature_config) = 'object'`,
    ),
  ],
);
