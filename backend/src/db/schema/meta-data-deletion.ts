import { sql } from 'drizzle-orm';
import { check, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps, timestamptz } from './columns.js';

/**
 * Meta Data Deletion requests (Module 4 D6, M4-T6). Meta calls `POST /api/meta/data-deletion` when
 * a user asks to delete their data; we store one row with a random confirmation code (shown by
 * Meta and on the client `/data-deletion?code=` page) and a queued job deletes the user's
 * connections, Pages and comments, then marks the row `COMPLETED`.
 *
 * No personal data beyond the app-scoped Facebook user id, and no workspace FK: the request must
 * outlive the rows it deletes. At most one `PENDING` request per user (partial unique index): a
 * repeat request while one is open reuses it.
 */

export const META_DATA_DELETION_STATUSES = ['PENDING', 'COMPLETED'] as const;
export type MetaDataDeletionStatus =
  (typeof META_DATA_DELETION_STATUSES)[number];

/** 16 random bytes, base64url (22 chars). */
export const DATA_DELETION_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export const metaDataDeletionRequests = pgTable(
  'meta_data_deletion_requests',
  {
    id: id(),
    confirmationCode: text().notNull(),
    /** App-scoped Facebook user id from the `signed_request` (`meta_connections.facebook_user_id`). */
    facebookUserId: text().notNull(),
    status: text().$type<MetaDataDeletionStatus>().notNull().default('PENDING'),
    /** Set when the deletion job finished. */
    completedAt: timestamptz(),
    ...timestamps,
  },
  (t) => [
    unique('meta_data_deletion_requests_confirmation_code_unique').on(
      t.confirmationCode,
    ),
    // One open request per user; also the lookup index for "reuse the open request".
    uniqueIndex('meta_data_deletion_requests_one_pending_unique')
      .on(t.facebookUserId)
      .where(sql`${t.status} = 'PENDING'`),
    check(
      'meta_data_deletion_requests_status_check',
      sql.raw(
        `status in (${META_DATA_DELETION_STATUSES.map((s) => `'${s}'`).join(', ')})`,
      ),
    ),
    check(
      'meta_data_deletion_requests_code_format',
      sql`${t.confirmationCode} ~ '^[A-Za-z0-9_-]{22}$'`,
    ),
    check(
      'meta_data_deletion_requests_facebook_user_id_format',
      sql`${t.facebookUserId} ~ '^[0-9]{1,32}$'`,
    ),
    check(
      'meta_data_deletion_requests_completed_at_check',
      sql`(${t.status} = 'COMPLETED') = (${t.completedAt} is not null)`,
    ),
  ],
);
