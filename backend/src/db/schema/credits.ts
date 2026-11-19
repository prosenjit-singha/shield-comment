import { relations, sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';
import { workspaces } from './workspaces.js';

/** Credit month key: the Asia/Dhaka calendar month `YYYY-MM` (`dhakaMonthKey()`). */
export const CREDIT_MONTH_PATTERN = '^[0-9]{4}-(0[1-9]|1[0-2])$';

/**
 * AI credits used per workspace per Asia/Dhaka calendar month (Module 5, M5-T11; user decisions
 * 2026-11-19 D15 + D7, see docs/progress/TASKS.md). The monthly allowance is the workspace plan's
 * `feature_config.limits.monthlyAiCredits` (no plan = the Free plan); a new month starts a new
 * row at 0 (no rollover). `CreditService.reserve()` raises `used` with one guarded upsert, so it
 * never passes the plan limit, and `release()` gives credits back (never below 0).
 *
 * - Workspace FK `restrict` (convention). Only counts, no personal data: Meta Data Deletion and
 *   disconnect keep these rows; e2e `cleanup()` deletes them before the workspaces.
 * - `used` is not checked against the limit in SQL: an admin may lower a plan's limit below what
 *   a workspace already used this month (then further reserves simply fail).
 */
export const monthlyCreditUsage = pgTable(
  'monthly_credit_usage',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** Asia/Dhaka calendar month, `YYYY-MM`. */
    month: text().notNull(),
    /** Credits reserved this month (reserve − release), ≥ 0. */
    used: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    // Upsert key; also serves the per-workspace lookup (leading `workspace_id`).
    unique('monthly_credit_usage_workspace_month_unique').on(
      t.workspaceId,
      t.month,
    ),
    check(
      'monthly_credit_usage_month_format',
      sql.raw(`month ~ '${CREDIT_MONTH_PATTERN}'`),
    ),
    check('monthly_credit_usage_used_check', sql`used >= 0`),
  ],
);

export const monthlyCreditUsageRelations = relations(
  monthlyCreditUsage,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [monthlyCreditUsage.workspaceId],
      references: [workspaces.id],
    }),
  }),
);
