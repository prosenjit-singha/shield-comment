import { relations, sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { id, timestamps, timestamptz } from './columns.js';
import { plans } from './plans.js';

/**
 * Better Auth `organization` plugin tables, renamed: organization → `workspaces`,
 * member → `workspace_members`, invitation → `workspace_invitations` (see src/auth/better-auth.ts).
 * The plugin's `organizationId` field is mapped to `workspaceId`, so tenant queries read
 * `eq(x.workspaceId, …)` / `workspace_id` everywhere. TS keys must match the plugin field names.
 */

export const workspaceStatus = pgEnum('workspace_status', ['ACTIVE', 'SUSPENDED']);

/** Workspace member roles (custom access control in src/auth/permissions.ts). */
export const WORKSPACE_ROLES = ['owner', 'admin', 'moderator'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const roleCheck = (column: string) =>
  sql.raw(`${column} in (${WORKSPACE_ROLES.map((r) => `'${r}'`).join(', ')})`);

export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    name: text().notNull(),
    slug: text().notNull().unique(),
    logo: text(),
    /** Free-form JSON string (Better Auth stores organization metadata as text). */
    metadata: text(),
    /** Extra field (`additionalFields.status`). SUSPENDED workspaces are locked by `WorkspaceAccessGuard` (M1-T1). */
    status: workspaceStatus().notNull().default('ACTIVE'),
    /**
     * Current plan (M2-T11). `null` = no plan yet (every workspace until Module 8 assigns one).
     * Not a Better Auth field: the organization plugin never reads or writes it.
     */
    planId: uuid().references(() => plans.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [index().on(t.planId)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text().notNull().default('moderator'),
    ...timestamps,
  },
  (t) => [
    unique('workspace_members_workspace_id_user_id_unique').on(t.workspaceId, t.userId),
    index().on(t.userId),
    check('workspace_members_role_check', roleCheck('role')),
  ],
);

export const workspaceInvitations = pgTable(
  'workspace_invitations',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Lower-cased by Better Auth. */
    email: text().notNull(),
    role: text().notNull(),
    /** `pending` | `accepted` | `rejected` | `canceled` (Better Auth values). */
    status: text().notNull().default('pending'),
    inviterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz().notNull(),
    ...timestamps,
  },
  (t) => [
    index().on(t.workspaceId),
    index().on(t.email),
    check('workspace_invitations_role_check', roleCheck('role')),
  ],
);

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  plan: one(plans, { fields: [workspaces.planId], references: [plans.id] }),
  members: many(workspaceMembers),
  invitations: many(workspaceInvitations),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, { fields: [workspaceMembers.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
}));

export const workspaceInvitationsRelations = relations(workspaceInvitations, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceInvitations.workspaceId],
    references: [workspaces.id],
  }),
  inviter: one(users, { fields: [workspaceInvitations.inviterId], references: [users.id] }),
}));

export const plansRelations = relations(plans, ({ many }) => ({
  workspaces: many(workspaces),
}));
