import { relations, sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, timestamptz } from './columns.js';
import { socialPages } from './meta.js';
import { workspaces } from './workspaces.js';

/**
 * Webhook ingestion storage (Module 4, M4-T2; user decisions 2026-11-18 D2/D4/D6/D7, see
 * docs/progress/TASKS.md).
 *
 * - `webhook_events`: one row per processed webhook change, `event_id` =
 *   `<platform>:<commentId>:<verb>` (same format as the BullMQ job id, `commentJobId()`; verb
 *   `edited` is `edited-<16 hex edit hash>`, M4-T4), so duplicate deliveries/retries hit the
 *   unique key (`ON CONFLICT DO NOTHING`) while every different edit gets its own row.
 * - `comments`: one row per Meta comment (`comment_id` unique). `status` is only `PENDING` until
 *   Module 5. Only `raw_payload` is cleared after 30 days (D4); text/author/status stay.
 *   D7: disconnect deletes the `social_pages` row, the comment stays with `social_page_id = null`
 *   (`on delete set null`) and is stamped with the connection's `facebook_user_id` (M4-T9), so
 *   D6 Data Deletion still finds it. D6 must delete the Pages' comments **before** the Pages.
 * - `daily_comment_stats`: lifetime analytics per workspace + Meta Page id + platform + Dhaka day,
 *   never purged, no personal data. Keyed by the Meta Page id (text, no FK) so the counts survive
 *   disconnect/Data Deletion and continue when the same Page is connected again.
 *
 * Workspace FKs are `restrict` (convention): delete these rows before the workspace.
 */

export const COMMENT_PLATFORMS = ['FACEBOOK', 'INSTAGRAM'] as const;
export type CommentPlatform = (typeof COMMENT_PLATFORMS)[number];

/** Module 5 adds moderation outcomes. */
export const COMMENT_STATUSES = ['PENDING'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

/** Webhook verbs we store (D2). */
export const COMMENT_VERBS = ['add', 'edited', 'remove'] as const;
export type CommentVerb = (typeof COMMENT_VERBS)[number];

const quoted = (values: readonly string[]) =>
  values.map((v) => `'${v}'`).join(', ');

/** Numeric Meta id (Page id, user id, IG id). */
const numericId = (column: string, nullable = false) =>
  sql.raw(
    `${nullable ? `${column} is null or ` : ''}${column} ~ '^[0-9]{1,32}$'`,
  );

/**
 * Meta object id of a post/comment: numeric, or numeric parts joined by `_` (FB `feed` ids look
 * like `<pageId>_<postId>` / `<postId>_<commentId>`; IG ids are plain numbers).
 */
const META_OBJECT_ID = '^[0-9]{1,32}(_[0-9]{1,32}){0,2}$';
const objectId = (column: string) => sql.raw(`${column} ~ '${META_OBJECT_ID}'`);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    /** `<platform>:<commentId>:<verb>` (D4); `edited` = `edited-<hash>` (`commentJobId()`). */
    eventId: text().notNull(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** sha256 hex of the change payload (JSON). */
    payloadHash: text().notNull(),
    /** Set by the worker once the change is applied; `null` = recorded, not applied yet. */
    processedAt: timestamptz(),
    ...timestamps,
  },
  (t) => [
    unique('webhook_events_event_id_unique').on(t.eventId),
    index().on(t.workspaceId, t.createdAt.desc()),
    check(
      'webhook_events_event_id_format',
      sql.raw(
        `event_id ~ '^(${COMMENT_PLATFORMS.join('|')}):[0-9_]+:(add|remove|edited-[0-9a-f]{16})$'`,
      ),
    ),
    check(
      'webhook_events_payload_hash_format',
      sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: id(),
    /** Meta comment id (globally unique: one workspace per Page, so one row per comment). */
    commentId: text().notNull(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** The connected Page (FB) or the Page linked to the IG account; `null` after disconnect (D7). */
    socialPageId: uuid().references(() => socialPages.id, {
      onDelete: 'set null',
    }),
    platform: text().$type<CommentPlatform>().notNull(),
    /** FB post id / IG media id. */
    postId: text().notNull(),
    /** `null` when Meta leaves out `from` (privacy rules). */
    authorId: text(),
    authorName: text(),
    /** `null` for sticker/photo-only comments. Verb `edited` replaces it. */
    message: text(),
    /** The webhook change as received; cleared after 30 days (D4). */
    rawPayload: jsonb().$type<Record<string, unknown>>(),
    status: text().$type<CommentStatus>().notNull().default('PENDING'),
    /**
     * App-scoped Facebook user id of the connection whose disconnect orphaned this comment
     * (M4-T9; decision 2026-11-19 "Keep FB user id on comments"): `null` while the Page is
     * connected. A later Data Deletion request of that user still finds and deletes it.
     */
    facebookUserId: text(),
    /** Last `edited` verb applied. */
    editedAt: timestamptz(),
    /** Verb `remove`: the comment was deleted on Meta (never hidden later, D2). */
    deletedAt: timestamptz(),
    ...timestamps,
  },
  (t) => [
    unique('comments_comment_id_unique').on(t.commentId),
    // Workspace comment lists (newest first).
    index().on(t.workspaceId, t.createdAt.desc()),
    // FK `on delete set null` lookups (disconnect).
    index().on(t.socialPageId),
    // Data Deletion routing read for comments orphaned by a disconnect (M4-T9).
    index('comments_facebook_user_id_index')
      .on(t.facebookUserId)
      .where(sql`${t.facebookUserId} is not null`),
    // Daily raw_payload purge (D4): only rows that still carry a payload.
    index('comments_raw_payload_purge_index')
      .on(t.createdAt)
      .where(sql`${t.rawPayload} is not null`),
    check(
      'comments_platform_check',
      sql.raw(`platform in (${quoted(COMMENT_PLATFORMS)})`),
    ),
    check(
      'comments_status_check',
      sql.raw(`status in (${quoted(COMMENT_STATUSES)})`),
    ),
    check('comments_comment_id_format', objectId('comment_id')),
    check('comments_post_id_format', objectId('post_id')),
    check('comments_author_id_format', numericId('author_id', true)),
    check(
      'comments_facebook_user_id_format',
      numericId('facebook_user_id', true),
    ),
  ],
);

export const dailyCommentStats = pgTable(
  'daily_comment_stats',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** Meta Page id (not the `social_pages` row: aggregates outlive disconnect, D4/D7). */
    pageId: text().notNull(),
    platform: text().$type<CommentPlatform>().notNull(),
    /** Asia/Dhaka calendar day (`YYYY-MM-DD`). */
    day: date({ mode: 'string' }).notNull(),
    receivedCount: integer().notNull().default(0),
    editedCount: integer().notNull().default(0),
    removedCount: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    // Upsert key; leads with workspace_id, so it also serves workspace range reads.
    unique('daily_comment_stats_key_unique').on(
      t.workspaceId,
      t.pageId,
      t.platform,
      t.day,
    ),
    check('daily_comment_stats_page_id_format', numericId('page_id')),
    check(
      'daily_comment_stats_platform_check',
      sql.raw(`platform in (${quoted(COMMENT_PLATFORMS)})`),
    ),
    check(
      'daily_comment_stats_counts_check',
      sql`${t.receivedCount} >= 0 and ${t.editedCount} >= 0 and ${t.removedCount} >= 0`,
    ),
  ],
);

export const webhookEventsRelations = relations(webhookEvents, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [webhookEvents.workspaceId],
    references: [workspaces.id],
  }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [comments.workspaceId],
    references: [workspaces.id],
  }),
  socialPage: one(socialPages, {
    fields: [comments.socialPageId],
    references: [socialPages.id],
  }),
}));

export const dailyCommentStatsRelations = relations(
  dailyCommentStats,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [dailyCommentStats.workspaceId],
      references: [workspaces.id],
    }),
  }),
);
