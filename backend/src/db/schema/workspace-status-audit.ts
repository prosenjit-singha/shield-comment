import { relations, sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { id, timestamptz } from './columns.js';
import { workspaces, workspaceStatus } from './workspaces.js';

/** Max length of the reason a super admin gives for a status change (M2-T3). */
export const WORKSPACE_STATUS_REASON_MAX = 500;

/**
 * One row per real workspace status change made by a super admin (`PATCH
 * /api/admin/clients/:id/status`, M2-T3). Written in the same transaction as the status update; an
 * idempotent no-op writes nothing. Rows are never updated (no `updatedAt`). FKs are `restrict`
 * like `impersonation_audit_logs`: audit rows must outlive deletes.
 */
export const workspaceStatusAuditLogs = pgTable(
  'workspace_status_audit_logs',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** Super admin who changed the status. */
    adminId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    oldStatus: workspaceStatus().notNull(),
    newStatus: workspaceStatus().notNull(),
    /** Required, trimmed, 1–500 characters. */
    reason: text().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index().on(t.workspaceId),
    index().on(t.adminId),
    check(
      'workspace_status_audit_logs_status_changed',
      sql`${t.oldStatus} <> ${t.newStatus}`,
    ),
    check(
      'workspace_status_audit_logs_reason_length',
      sql.raw(
        `char_length(reason) between 1 and ${WORKSPACE_STATUS_REASON_MAX}`,
      ),
    ),
  ],
);

export const workspaceStatusAuditLogsRelations = relations(
  workspaceStatusAuditLogs,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceStatusAuditLogs.workspaceId],
      references: [workspaces.id],
    }),
    admin: one(users, {
      fields: [workspaceStatusAuditLogs.adminId],
      references: [users.id],
    }),
  }),
);
