import { relations } from 'drizzle-orm';
import { boolean, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, timestamptz } from './columns.js';

/**
 * Better Auth core tables (user / session / account / verification), in our conventions:
 * plural snake_case tables (`usePlural: true` in the Drizzle adapter), UUIDv7 ids, timestamptz(3).
 * Field names (TS keys) must stay exactly as Better Auth expects; SQL columns become snake_case.
 * The `organization` and `admin` plugins add their columns/tables in SW-T4.
 */

export const users = pgTable('users', {
  id: id(),
  name: text().notNull(),
  /** Always lower-cased: Better Auth normalises it on sign-up and sign-in. */
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  ...timestamps,
});

/**
 * Postgres is the source of truth for sessions (list / revoke). Redis `secondaryStorage`
 * is added in SW-T4. `token` is the value inside the signed session cookie.
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
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));
