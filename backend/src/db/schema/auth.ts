import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, timestamptz } from './columns.js';
import { workspaceMembers, workspaces } from './workspaces.js';

/**
 * Better Auth core tables (user / session / account / verification), in our conventions:
 * plural snake_case tables (`usePlural: true` in the Drizzle adapter), UUIDv7 ids, timestamptz(3).
 * Field names (TS keys) must stay exactly as Better Auth expects; SQL columns become snake_case.
 * `admin` plugin: `users.role/banned/banReason/banExpires`, `sessions.impersonatedBy`.
 * `organization` plugin: `sessions.activeOrganizationId` (the current workspace) + ./workspaces.ts.
 */

/** Platform roles (`admin` plugin, `adminRoles: ['super_admin']`). */
export const USER_ROLES = ['super_admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = pgTable(
  'users',
  {
    id: id(),
    name: text().notNull(),
    /** Always lower-cased: Better Auth normalises it on sign-up and sign-in. */
    email: text().notNull().unique(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    role: text().notNull().default('user'),
    banned: boolean().notNull().default(false),
    banReason: text(),
    banExpires: timestamptz(),
    ...timestamps,
  },
  () => [
    check(
      'users_role_check',
      sql.raw(`role in (${USER_ROLES.map((r) => `'${r}'`).join(', ')})`),
    ),
  ],
);

/**
 * Postgres is the source of truth for sessions (list / revoke); Redis `secondaryStorage` is a
 * read-through cache (`storeSessionInDatabase: true`). `token` is the value inside the signed cookie.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text().notNull().unique(),
    expiresAt: timestamptz().notNull(),
    ipAddress: text(),
    userAgent: text(),
    /** Current workspace (`organization` plugin). Set at sign-up / sign-in by src/auth/first-workspace.ts. */
    activeOrganizationId: uuid().references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    /** Super admin who started this session (`admin` plugin / M1-T3 impersonation). */
    impersonatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index().on(t.userId)],
);

/** One row per login method. Email + password uses `providerId = 'credential'` and keeps the hash in `password`. */
export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamptz(),
    refreshTokenExpiresAt: timestamptz(),
    scope: text(),
    password: text(),
    ...timestamps,
  },
  (t) => [index().on(t.userId)],
);

/** Short-lived tokens (email verification, password reset). */
export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamptz().notNull(),
    ...timestamps,
  },
  (t) => [index().on(t.identifier)],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  memberships: many(workspaceMembers),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  activeWorkspace: one(workspaces, {
    fields: [sessions.activeOrganizationId],
    references: [workspaces.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));
