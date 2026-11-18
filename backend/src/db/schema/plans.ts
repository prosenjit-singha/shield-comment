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
 * points at its plan through the nullable `workspaces.plan_id` (`null` = no plan yet); the
 * relations live in workspaces.ts so this file has no imports from other schema files.
 *
 * The four tiers (free/starter/growth/pro) are seeded by migration `0007_seed_plans` with
 * `ON CONFLICT (slug) DO NOTHING`, so admin edits are never overwritten.
 */

/** Numeric limits per plan (`feature_config.limits`). Rows 1–3 of the landing pricing matrix. */
export const PLAN_LIMIT_KEYS = [
  /** Connected Facebook + Instagram pages. */
  'connectedPages',
  /** Comments scanned per calendar month (Module 8 `QuotaGuard`). */
  'monthlyComments',
  /** Team / moderator seats (workspace members). */
  'teamSeats',
] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];

/** Upper bound per limit (validation; 0 = feature unavailable). */
export const PLAN_LIMIT_MAX: Record<PlanLimitKey, number> = {
  connectedPages: 1_000,
  monthlyComments: 10_000_000,
  teamSeats: 1_000,
};

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
      'plans_feature_config_object',
      sql`jsonb_typeof(feature_config) = 'object'`,
    ),
  ],
);
