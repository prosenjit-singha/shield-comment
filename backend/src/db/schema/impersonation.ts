import { relations } from 'drizzle-orm';
import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { id, timestamps, timestamptz } from './columns.js';
import { workspaces } from './workspaces.js';

/**
 * One row per 1-click impersonation token (M1-T3, src/impersonation/). Only the SHA-256 hash of
 * the token is stored; `usedAt` is set atomically when `/api/auth/impersonate-exchange` burns it.
 * FKs are `restrict`: audit rows must outlive deletes, so an admin or workspace with impersonation
 * history can't be deleted until its audit rows are dealt with.
 */
export const impersonationAuditLogs = pgTable(
  'impersonation_audit_logs',
  {
    id: id(),
    /** Super admin who asked for the token. */
    adminId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    targetWorkspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** sha256(token), hex. */
    tokenHash: text().notNull(),
    expiresAt: timestamptz().notNull(),
    /** Set once, by the exchange. `null` = never redeemed. */
    usedAt: timestamptz(),
    /** Admin's IP when the token was issued. */
    ipAddress: text(),
    ...timestamps,
  },
  (t) => [
    unique('impersonation_audit_logs_token_hash_unique').on(t.tokenHash),
    index().on(t.adminId),
    index().on(t.targetWorkspaceId),
  ],
);

export const impersonationAuditLogsRelations = relations(
  impersonationAuditLogs,
  ({ one }) => ({
    admin: one(users, {
      fields: [impersonationAuditLogs.adminId],
      references: [users.id],
    }),
    targetWorkspace: one(workspaces, {
      fields: [impersonationAuditLogs.targetWorkspaceId],
      references: [workspaces.id],
    }),
  }),
);
