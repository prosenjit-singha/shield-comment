import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, timestamptz } from './columns.js';
import { workspaces } from './workspaces.js';

/**
 * Meta (Facebook/Instagram) connection + connected Pages (Module 3, M3-T2; user decisions
 * 2026-11-18 D2/D4/D7/D8, see docs/progress/TASKS.md).
 *
 * - D7: one `meta_connections` row per workspace (re-connect updates it in place); a Page (and its
 *   linked IG Business account) belongs to at most one workspace (globally unique ids), so every
 *   webhook event routes to exactly one workspace. Pages missing on re-connect are kept with
 *   `is_active = false` and their token cleared; disconnect comes in a later module.
 * - D8: Graph error 190 sets `status = 'NEEDS_REAUTH'` (UI shows Reconnect); Deauthorize sets
 *   `REVOKED` and clears the user + Page tokens (M4-T6, Module 4 D6).
 * - D4: Facebook Login for Business, FB + IG (IG via the Page's `instagram_business_account`),
 *   long-lived user token → non-expiring Page tokens.
 * - D2: tokens are `TokenCipherService` ciphertexts (`v1:<keyId>:<iv>:<tag>:<ct>`), AAD =
 *   `tokenCipherContext('meta_user_token', workspaceId, facebookUserId)` /
 *   `tokenCipherContext('meta_page_token', workspaceId, pageId)`. Never store plaintext tokens.
 *
 * FKs are `restrict` (convention): delete pages and the connection before the workspace.
 */

export const META_CONNECTION_STATUSES = [
  'ACTIVE',
  'NEEDS_REAUTH',
  'REVOKED',
] as const;
export type MetaConnectionStatus = (typeof META_CONNECTION_STATUSES)[number];

/** Meta object ids (app-scoped user id, Page id, IG user id) are numeric strings. */
const numericId = (column: string, nullable = false) =>
  sql.raw(
    `${nullable ? `${column} is null or ` : ''}${column} ~ '^[0-9]{1,32}$'`,
  );

/** Rejects plaintext tokens: only versioned `TokenCipherService` output fits. */
const cipherText = (column: string, nullable = false) =>
  sql.raw(`${nullable ? `${column} is null or ` : ''}${column} ~ '^v[0-9]+:'`);

export const metaConnections = pgTable(
  'meta_connections',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** App-scoped Facebook user id of whoever connected (the AAD subject of the user token). */
    facebookUserId: text().notNull(),
    /**
     * Long-lived (≈60-day) user access token, encrypted. `null` only once Deauthorize revoked the
     * connection (D6 "tokens cleared", M4-T6); a re-connect writes a new one.
     */
    encryptedUserAccessToken: text(),
    /** When the user token expires; `null` = Meta reported no expiry. */
    tokenExpiresAt: timestamptz(),
    /** Permissions the user actually granted (Meta lets them untick some). */
    grantedScopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text().$type<MetaConnectionStatus>().notNull().default('ACTIVE'),
    statusChangedAt: timestamptz().notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    // One connection per workspace; the unique index also serves workspace lookups.
    unique('meta_connections_workspace_id_unique').on(t.workspaceId),
    index().on(t.facebookUserId),
    check(
      'meta_connections_status_check',
      sql.raw(
        `status in (${META_CONNECTION_STATUSES.map((s) => `'${s}'`).join(', ')})`,
      ),
    ),
    check(
      'meta_connections_facebook_user_id_format',
      numericId('facebook_user_id'),
    ),
    check(
      'meta_connections_user_token_format',
      cipherText('encrypted_user_access_token', true),
    ),
    // Only a REVOKED connection (Deauthorize, M4-T6) may be without a user token.
    check(
      'meta_connections_token_unless_revoked',
      sql`${t.encryptedUserAccessToken} is not null or ${t.status} = 'REVOKED'`,
    ),
  ],
);

export const socialPages = pgTable(
  'social_pages',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** Facebook Page id (globally unique: one workspace per Page). */
    pageId: text().notNull(),
    pageName: text().notNull(),
    /** Linked Instagram Business account id (`instagram_business_account.id`), if any. */
    igBusinessId: text(),
    igUsername: text(),
    /** Page access token, encrypted; `null` once the Page is gone from `/me/accounts`. */
    encryptedPageAccessToken: text(),
    /** Moderation on/off. The initial value on sync is set by M3-T5 (D10). */
    isActive: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('social_pages_page_id_unique').on(t.pageId),
    unique('social_pages_ig_business_id_unique').on(t.igBusinessId),
    index().on(t.workspaceId),
    check('social_pages_page_id_format', numericId('page_id')),
    check(
      'social_pages_ig_business_id_format',
      numericId('ig_business_id', true),
    ),
    check(
      'social_pages_ig_username_needs_ig_id',
      sql`${t.igUsername} is null or ${t.igBusinessId} is not null`,
    ),
    check(
      'social_pages_page_token_format',
      cipherText('encrypted_page_access_token', true),
    ),
    // A page can't moderate without a token.
    check(
      'social_pages_active_needs_token',
      sql`not ${t.isActive} or ${t.encryptedPageAccessToken} is not null`,
    ),
  ],
);

export const metaConnectionsRelations = relations(
  metaConnections,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [metaConnections.workspaceId],
      references: [workspaces.id],
    }),
  }),
);

export const socialPagesRelations = relations(socialPages, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [socialPages.workspaceId],
    references: [workspaces.id],
  }),
}));
