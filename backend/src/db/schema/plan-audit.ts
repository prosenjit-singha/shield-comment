import { relations, sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { id, timestamptz } from './columns.js';
import {
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  type PlanFeatureKey,
  type PlanLimitKey,
  plans,
} from './plans.js';

/**
 * What happened to the plan. Only `UPDATE` (`PATCH /api/admin/settings/plans/:planId`) exists today;
 * add values here (and to the check constraint via a migration) if plans become creatable/deletable.
 */
export const PLAN_AUDIT_ACTIONS = ['UPDATE'] as const;
export type PlanAuditAction = (typeof PLAN_AUDIT_ACTIONS)[number];

/**
 * Audited plan fields, in display order. Feature config leaves are dotted paths so one change row
 * names exactly one value (`featureConfig.limits.teamSeats`, `featureConfig.features.customBlocklist`).
 */
export const PLAN_AUDIT_FIELDS = [
  'originalPriceBdt',
  'offerPriceBdt',
  'offerBadge',
  ...PLAN_LIMIT_KEYS.map((key) => `featureConfig.limits.${key}` as const),
  ...PLAN_FEATURE_KEYS.map((key) => `featureConfig.features.${key}` as const),
] as const;
export type PlanAuditField =
  | 'originalPriceBdt'
  | 'offerPriceBdt'
  | 'offerBadge'
  | `featureConfig.limits.${PlanLimitKey}`
  | `featureConfig.features.${PlanFeatureKey}`;

/** One changed field. Prices/limits are numbers, the badge a string, flags booleans; `null` = cleared. */
export interface PlanAuditChange {
  field: PlanAuditField;
  before: number | string | boolean | null;
  after: number | string | boolean | null;
}

/** Longest user agent kept (longer ones are truncated before the insert). */
export const PLAN_AUDIT_USER_AGENT_MAX = 512;

/**
 * One row per real plan edit made by a super admin (M2-T15, user decision 2026-11-18: "a
 * professional audit trail for every plan edit"). Written in the same transaction as the update,
 * after the plan row's `FOR UPDATE` lock; a PATCH that changes nothing writes no row. `changes`
 * holds only the fields that changed (`PlanAuditChange[]`, before → after). Rows are never updated
 * (no `updatedAt`). FKs are `restrict` like the other audit tables: audit rows must outlive deletes.
 */
export const planAuditLogs = pgTable(
  'plan_audit_logs',
  {
    id: id(),
    planId: uuid()
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    /** Super admin who made the change. */
    adminId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    action: text().$type<PlanAuditAction>().notNull(),
    /** Non-empty array of `{ field, before, after }`. */
    changes: jsonb().$type<PlanAuditChange[]>().notNull(),
    /** Admin's IP (first `X-Forwarded-For` entry, like `impersonation_audit_logs`). */
    ipAddress: text(),
    userAgent: text(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index('plan_audit_logs_plan_id_created_at_index').on(
      t.planId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('plan_audit_logs_created_at_index').on(
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index().on(t.adminId),
    check(
      'plan_audit_logs_action_check',
      sql.raw(
        `action in (${PLAN_AUDIT_ACTIONS.map((a) => `'${a}'`).join(', ')})`,
      ),
    ),
    check(
      'plan_audit_logs_changes_check',
      sql`jsonb_typeof(${t.changes}) = 'array' and jsonb_array_length(${t.changes}) > 0`,
    ),
    check(
      'plan_audit_logs_ip_address_length',
      sql`ip_address is null or char_length(ip_address) between 1 and 45`,
    ),
    check(
      'plan_audit_logs_user_agent_length',
      sql.raw(
        `user_agent is null or char_length(user_agent) between 1 and ${PLAN_AUDIT_USER_AGENT_MAX}`,
      ),
    ),
  ],
);

export const planAuditLogsRelations = relations(planAuditLogs, ({ one }) => ({
  plan: one(plans, {
    fields: [planAuditLogs.planId],
    references: [plans.id],
  }),
  admin: one(users, {
    fields: [planAuditLogs.adminId],
    references: [users.id],
  }),
}));
